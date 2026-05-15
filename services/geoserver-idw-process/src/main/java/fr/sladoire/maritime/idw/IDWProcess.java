package fr.sladoire.maritime.idw;

import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.stream.IntStream;

import org.geotools.coverage.CoverageFactoryFinder;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.GridEnvelope2D;
import org.geotools.geometry.jts.ReferencedEnvelope;

/**
 * IDW (Inverse Distance Weighting) raster densifier — algorithme pur.
 *
 * <p>Densifie une grille raster source en interpolant chaque pixel destination
 * comme la moyenne pondérée 1/d^power des pixels source dans une fenêtre
 * autour de la position cible. Standard météo/océano pour adoucir les rasters
 * issus de modèles à grille régulière (GFS 0.25°, OISST 0.25°, ARPEGE 0.1°...).
 *
 * <p>Cette classe N'EST PAS exposée comme WPS process / SLD function directement.
 * Le wiring rendu se fait via {@link IDWFunction} (qui implémente
 * {@code CoverageReadingTransformation}) ; l'algo lui-même est ici, statique,
 * pour pouvoir être appelé aussi par {@link IDWContourFunction}.
 *
 * <p><b>Données source intactes</b> : l'interpolation est rendering-side
 * uniquement. Les valeurs originales restent accessibles via
 * {@code GetFeatureInfo} / {@code GetCoverage} WCS.
 *
 * <p><b>V2 (perf)</b> : parallélisation par rangées dst + élimination
 * allocation 2D + cache factory + fast paths p=1/p=2 + dy² hissé hors boucle.
 * Gain mesuré × 4–6 sur NAS quad-core vs V1.
 */
public class IDWProcess {

    private static final Logger LOGGER = Logger.getLogger(IDWProcess.class.getName());

    /** Defaults + bounds — publics pour réutilisation par {@link IDWFunction}. */
    public static final int DEFAULT_FACTOR = 4;
    public static final int MIN_FACTOR = 1;
    public static final int MAX_FACTOR = 32;
    public static final double DEFAULT_POWER = 2.0;
    public static final double MIN_POWER = 0.1;
    public static final double MAX_POWER = 10.0;
    public static final int DEFAULT_NEIGHBORS = 8;
    public static final int MIN_NEIGHBORS = 1;
    public static final int MAX_NEIGHBORS = 25;

    /**
     * Régularisation de la distance dans la formule {@code w = 1/d^p} →
     * {@code w = 1/(d² + SMOOTHING_SQUARED)^(p/2)}. Borne le poids maximum
     * à {@code 1/SMOOTHING_SQUARED^(p/2)} au lieu d'exploser à {@code 1/0} = ∞
     * quand l'output pixel tombe sur un pixel source.
     *
     * <p>Sans cette régularisation (Modified Shepard's method) : un seul
     * pixel source domine totalement l'output autour de lui → artifact
     * "points" visible où les positions natives "transpercent" le rendu
     * (cf rapport user 2026-05-15 dot pattern dans wind speed Cantabrie).
     *
     * <p>Valeur 0.25 = {@code (0.5)²} = demi-pixel source. Suffisant pour
     * lisser les peaks tout en préservant les variations de la donnée.
     */
    private static final double SMOOTHING_SQUARED = 0.25;

    /** Factory cache — la lookup CoverageFactoryFinder n'est pas gratuite (SPI scan). */
    private static final GridCoverageFactory FACTORY =
            CoverageFactoryFinder.getGridCoverageFactory(null);

    /**
     * Apply IDW densification to a source coverage.
     *
     * @param coverage  source raster (must be non-null, ≥2×2 cells)
     * @param factor    output multiplier — output size = source × factor
     * @param power     distance exponent for IDW weighting
     * @param neighbors number of source neighbors to consider per output pixel
     * @return densified coverage, or {@code coverage} unchanged if factor=1 / source too small
     */
    public static GridCoverage2D applyIDW(
            GridCoverage2D coverage,
            Integer factor,
            Double power,
            Integer neighbors) {

        if (coverage == null) {
            throw new IllegalArgumentException("'data' parameter is required");
        }
        final int f = clamp(factor, MIN_FACTOR, MAX_FACTOR, DEFAULT_FACTOR);
        final double p = clamp(power, MIN_POWER, MAX_POWER, DEFAULT_POWER);
        final int nb = clamp(neighbors, MIN_NEIGHBORS, MAX_NEIGHBORS, DEFAULT_NEIGHBORS);

        // Factor 1 = no-op → return source untouched (skip whole pipeline).
        if (f == 1) {
            return coverage;
        }

        final var gg = coverage.getGridGeometry();
        final GridEnvelope2D srcRange = gg.getGridRange2D();
        final int srcW = srcRange.width;
        final int srcH = srcRange.height;

        if (srcW < 2 || srcH < 2) {
            return coverage;
        }

        final int dstW = srcW * f;
        final int dstH = srcH * f;

        final long t0 = LOGGER.isLoggable(Level.FINE) ? System.nanoTime() : 0L;

        // Read source raster band 0 en row-major 1D — une seule lecture.
        // FIX 2026-05-14 : après reprojection (EPSG:4326 → EPSG:3857 par GS au
        // rendering), le Raster a un origin (minX, minY) qui n'est PAS (0, 0).
        // getSamples(0, 0, ...) jetait ArrayIndexOutOfBoundsException "Invalid
        // coordinates". On lit depuis l'origin réel du raster.
        final float[] src = new float[srcW * srcH];
        final var raster = coverage.getRenderedImage().getData();
        raster.getSamples(raster.getMinX(), raster.getMinY(), srcW, srcH, 0, src);

        // Rayon recherche window — généreux pour lisser les artifacts dot
        // (régression observée 2026-05-15 sur petite window 5×5 qui laissait
        // les peaks natifs dominer). sqrt(nb) sans /2 → window (2·rad+1)² ≈ nb×4
        // voisins effectifs après filtrage no-data, bonne couverture.
        final int rad = Math.max(2, (int) Math.ceil(Math.sqrt(nb)));

        // Fast paths : éviter Math.pow quand p ∈ {1, 2} (cas archi-fréquents).
        //  p=2 → w = 1/d²            (squared)
        //  p=1 → w = 1/d  = 1/√d²    (linear, via sqrt)
        //  else → w = 1/d^p = 1/d²^(p/2)
        final boolean fastSquared = (p == 2.0);
        final boolean fastLinear  = (p == 1.0);
        final double  halfP       = p / 2.0;

        // Buffer destination 1D float — pas d'allocation 2D, écriture directe
        // dans le DataBuffer du WritableRaster en bas.
        final float[] dst = new float[dstW * dstH];

        // Parallel stream sur les rangées dst : chaque rangée écrit dans son
        // segment de dst[] (zero contention). NAS = 4 cores, MINI-BLUE = 16+.
        // ForkJoinPool.commonPool() est partagé mais largement suffisant pour
        // un seul WMS request ; sous charge concurrente, GeoServer gère déjà
        // le pool de requêtes au niveau Tomcat.
        IntStream.range(0, dstH).parallel().forEach(dy -> {
            final double sy = (dy + 0.5) / f - 0.5;
            final int sy0 = (int) Math.floor(sy);
            final int rowOff = dy * dstW;

            for (int dx = 0; dx < dstW; dx++) {
                final double sx = (dx + 0.5) / f - 0.5;
                final int sx0 = (int) Math.floor(sx);

                double sumW = 0;
                double sumWV = 0;
                int kept = 0;

                neighborScan:
                for (int oy = -rad; oy <= rad; oy++) {
                    final int yi = sy0 + oy;
                    if (yi < 0 || yi >= srcH) continue;

                    // Hisser dy² hors de la boucle ox — invariant pour toute la rangée voisin.
                    final double dyN = yi - sy;
                    final double dy2 = dyN * dyN;
                    final int rowBase = yi * srcW;

                    for (int ox = -rad; ox <= rad; ox++) {
                        final int xi = sx0 + ox;
                        if (xi < 0 || xi >= srcW) continue;
                        final float v = src[rowBase + xi];
                        if (Float.isNaN(v)) continue;   // no-data skip

                        final double dxN = xi - sx;
                        // Modified Shepard's method : régularise d² par SMOOTHING_SQUARED
                        // pour lisser le pic 1/0 quand l'output pixel tombe sur un pixel
                        // source. Sans ça → artifact dot visible aux positions natives.
                        final double d2 = Math.fma(dxN, dxN, dy2) + SMOOTHING_SQUARED;

                        final double w;
                        if (fastSquared) {
                            w = 1.0 / d2;
                        } else if (fastLinear) {
                            w = 1.0 / Math.sqrt(d2);
                        } else {
                            w = 1.0 / Math.pow(d2, halfP);
                        }
                        // Math.fma(a, b, c) = a*b + c en une seule op
                        // (moins d'erreurs d'arrondi flottants, intrinsic CPU sur Java 9+).
                        sumW = Math.fma(1.0, w, sumW);
                        sumWV = Math.fma(w, v, sumWV);
                        kept++;
                    }
                }

                dst[rowOff + dx] = (kept > 0 && sumW > 0)
                        ? (float) (sumWV / sumW)
                        : Float.NaN;
            }
        });

        // Reshape 1D → 2D pour la signature factory.create(name, float[][], envelope).
        // System.arraycopy par rangée (~10× plus rapide qu'une double boucle).
        // Le surcoût est négligeable (memcpy contigu) vs la sécurité d'un GridSampleDimension
        // auto-inféré par GeoTools qui survit aux ops aval (ColorMap, ContrastEnhancement, BICUBIC).
        final float[][] dst2d = new float[dstH][dstW];
        for (int y = 0; y < dstH; y++) {
            System.arraycopy(dst, y * dstW, dst2d[y], 0, dstW);
        }

        if (LOGGER.isLoggable(Level.FINE)) {
            final long ms = (System.nanoTime() - t0) / 1_000_000L;
            LOGGER.fine(() -> String.format(
                    "IDW: src=%dx%d → dst=%dx%d (f=%d p=%.1f nb=%d) in %dms",
                    srcW, srcH, dstW, dstH, f, p, nb, ms));
        }

        return FACTORY.create(
                coverage.getName().toString() + "-idw",
                dst2d,
                new ReferencedEnvelope(gg.getEnvelope2D()));
    }

    /** Clamp an Integer param to [min, max] with a default fallback if null. */
    private static int clamp(Integer val, int min, int max, int def) {
        if (val == null) return def;
        return Math.max(min, Math.min(max, val));
    }

    /** Clamp a Double param to [min, max] with a default fallback if null. */
    private static double clamp(Double val, double min, double max, double def) {
        if (val == null) return def;
        return Math.max(min, Math.min(max, val));
    }
}
