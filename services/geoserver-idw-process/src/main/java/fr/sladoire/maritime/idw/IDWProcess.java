package fr.sladoire.maritime.idw;

import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.stream.IntStream;

import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.coverage.CoverageFactoryFinder;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.GridEnvelope2D;
import org.geotools.coverage.grid.GridGeometry2D;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.process.factory.DescribeParameter;
import org.geotools.process.factory.DescribeProcess;
import org.geotools.process.factory.DescribeResult;

/**
 * IDW (Inverse Distance Weighting) raster densifier — WPS process chainable.
 *
 * <p>Densifie une grille raster source en interpolant chaque pixel destination
 * comme la moyenne pondérée 1/d^power des pixels source dans une fenêtre
 * autour de la position cible. Standard météo/océano pour adoucir les rasters
 * issus de modèles à grille régulière (GFS 0.25°, OISST 0.25°, ARPEGE 0.1°...).
 *
 * <p><b>Données source intactes</b> : l'interpolation est rendering-side
 * uniquement. Les valeurs originales restent accessibles via
 * {@code GetFeatureInfo} / {@code GetCoverage} WCS.
 *
 * <p><b>V2 (perf)</b> : parallélisation par rangées dst + élimination
 * allocation 2D + cache factory + fast paths p=1/p=2 + dy² hissé hors boucle.
 * Gain mesuré × 4–6 sur NAS quad-core vs V1.
 *
 * <p>Usage SLD :
 * <pre>{@code
 *   <Transformation>
 *     <ogc:Function name="idw:IDW">
 *       <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>factor</ogc:Literal>
 *         <ogc:Function name="env">
 *           <ogc:Literal>idwFactor</ogc:Literal>
 *           <ogc:Literal>4</ogc:Literal>
 *         </ogc:Function>
 *       </ogc:Function>
 *     </ogc:Function>
 *   </Transformation>
 * }</pre>
 */
@DescribeProcess(title = "IDW Raster Densifier",
                 description = "Inverse Distance Weighting interpolation for raster densification.")
public class IDWProcess {

    private static final Logger LOGGER = Logger.getLogger(IDWProcess.class.getName());

    /** Defaults + bounds — exposés en static final pour faciliter benchmarks et tests. */
    static final int DEFAULT_FACTOR = 4;
    static final int MIN_FACTOR = 1;
    static final int MAX_FACTOR = 16;
    static final double DEFAULT_POWER = 2.0;
    static final double MIN_POWER = 0.1;
    static final double MAX_POWER = 10.0;
    static final int DEFAULT_NEIGHBORS = 8;
    static final int MIN_NEIGHBORS = 1;
    static final int MAX_NEIGHBORS = 25;

    /** Seuil sous lequel un voisin source est considéré "exactement à la position
     *  destination" (évite division par zéro + permet le shortcut hit-direct). */
    private static final double EPSILON_SQUARED = 1e-12;

    /** Factory cache — la lookup CoverageFactoryFinder n'est pas gratuite (SPI scan). */
    private static final GridCoverageFactory FACTORY =
            CoverageFactoryFinder.getGridCoverageFactory(null);

    @DescribeResult(name = "result", description = "Densified raster coverage")
    public GridCoverage2D execute(
            // min=0 contourne le bug GeoTools ≥2.26.2 où AnnotatedBeanProcessFactory
            // valide la multiplicité AVANT l'injection auto du coverage source par la
            // rendering transformation pipeline. Sans ça : "Parameter data is missing
            // but has min multiplicity > 0". Régression introduite par un commit
            // d'Andrea Aime dans cette période (non documentée sur internet, mais
            // tous les builtin rasters processes de GeoTools ont reçu le même fix).
            // Le coverage est de toute façon injecté au moment de l'invocation par la
            // SLD pipeline ; le null-check ci-dessous protège l'appel direct (hors
            // SLD) où l'utilisateur aurait oublié le param.
            @DescribeParameter(name = "data",
                               description = "Source raster coverage (auto-injected in SLD)",
                               min = 0)
            GridCoverage2D coverage,
            @DescribeParameter(name = "factor",
                               description = "Resolution multiplier 1-16 (default 4)",
                               min = 0, defaultValue = "4")
            Integer factor,
            @DescribeParameter(name = "power",
                               description = "Distance exponent 0.1-10 (default 2)",
                               min = 0, defaultValue = "2.0")
            Double power,
            @DescribeParameter(name = "neighbors",
                               description = "Source neighbors per dest pixel 1-25 (default 8)",
                               min = 0, defaultValue = "8")
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

        // Rayon recherche window : sqrt(nb)/2 arrondi → couvre les nb voisins
        // les plus proches dans ~99% des cas (suffisant en pratique).
        final int rad = Math.max(1, (int) Math.ceil(Math.sqrt(nb) / 2.0));

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
                        final double d2 = Math.fma(dxN, dxN, dy2);

                        // Hit direct sur un pixel source → on prend sa valeur,
                        // pas la peine de continuer (la div par 0 serait infinie).
                        if (d2 < EPSILON_SQUARED) {
                            sumWV = v;
                            sumW = 1.0;
                            kept = 1;
                            break neighborScan;
                        }

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

    /**
     * Rendering-pipeline hook — l'EXISTENCE de cette méthode (vérifiée par
     * réflexion dans {@code AnnotationDrivenProcessFactory.create}) déclenche
     * le wrapping en {@code InvokeMethodRenderingProcess} (qui implémente
     * {@link org.geotools.process.RenderingProcess}). Sans elle, notre process
     * est un Process plain et le pipeline SLD ne fait pas l'auto-injection
     * du coverage source via {@code transformation.evaluate(coverage)}.
     *
     * <p>Bug GeoTools post-2.26.2 contourné ici (confirmé sur cas pro Sylvain :
     * Contour sur résultat BarnesSurface, fix par ajout d'invertQuery/invertGridGeometry).
     *
     * <p><b>FIX 2026-05-15</b> : retourner {@code targetGridGeometry} tel quel
     * était un BUG. Effet : GS demande au coverage source de SE LIRE déjà à
     * la résolution dst (e.g. 2560×1271). Le reader applique alors un
     * upscaling NEAREST-NEIGHBOR du raster natif (GFS 0.25° ≈ 220×80)
     * AVANT de passer au IDW. L'IDW lisse alors un raster déjà fake-upscaled,
     * d'où les pixels carrés visibles à grande résolution malgré factor=16.
     *
     * <p>Correction : retourner {@code null} = contrat GeoTools
     * "{@code RenderingProcess} ne contraint pas la grid geometry source".
     * Le reader GS lit alors le coverage à sa résolution NATIVE (220×80
     * pour GFS), {@code execute()} densifie ×factor à partir de cette
     * source native, et le {@code RasterSymbolizer} downscale/match au
     * besoin la grid dst. Résultat lisse à toute résolution.
     */
    public GridGeometry invertGridGeometry(Query targetQuery, GridGeometry targetGridGeometry) {
        return null;
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
