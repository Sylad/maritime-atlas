package fr.sladoire.maritime.idw;

import java.awt.image.DataBuffer;
import java.awt.image.WritableRaster;
import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.geometry.Bounds;
import org.geotools.api.parameter.GeneralParameterValue;
import org.geotools.api.parameter.ParameterValue;
import org.geotools.coverage.CoverageFactoryFinder;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridCoverageFactory;
import org.geotools.coverage.grid.GridEnvelope2D;
import org.geotools.coverage.grid.GridGeometry2D;
import org.geotools.coverage.processing.AbstractOperation;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.process.factory.DescribeParameter;
import org.geotools.process.factory.DescribeProcess;
import org.geotools.process.factory.DescribeResult;
import org.geotools.process.gs.GSProcess;

/**
 * IDW (Inverse Distance Weighting) raster densifier — chainable WPS process.
 *
 * Densifie une grille raster source en interpolant chaque pixel destination
 * comme la moyenne pondérée des N plus proches voisins source, pondérée
 * par 1/d^power. Standard météo/océano pour adoucir les rasters issus
 * de modèles à grille régulière (GFS 0.25°, OISST 0.25°, ARPEGE 0.1°...).
 *
 * Paramètres :
 *   data       : GridCoverage2D source (obligatoire).
 *   factor     : multiplicateur de résolution (default 4 → ×4 lon, ×4 lat).
 *                Plus grand = plus lisse, plus lent. 2-8 raisonnable.
 *   power      : exposant de la distance (default 2.0). Plus élevé =
 *                interp plus locale (proche du nearest), plus faible =
 *                plus lissé. 1.5-3.0 typique en météo.
 *   neighbors  : nombre de voisins source utilisés par pixel destination
 *                (default 8). Plus grand = plus lisse mais plus lent.
 *
 * Usage SLD :
 *   <Transformation>
 *     <ogc:Function name="ras:IDW">
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
 *
 * NB : on N'ÉCRIT PAS le GridCoverage2D source — l'interpolation est
 * runtime-only, à chaque request WMS. Les data originales restent
 * accessibles intactes via GetFeatureInfo / GetCoverage WCS.
 */
@DescribeProcess(title = "IDW Raster Densifier",
                 description = "Inverse Distance Weighting interpolation for raster densification.")
public class IDWProcess implements GSProcess {

    @DescribeResult(name = "result", description = "Densified raster coverage")
    public GridCoverage2D execute(
            @DescribeParameter(name = "data",
                               description = "Source raster coverage")
            GridCoverage2D coverage,
            @DescribeParameter(name = "factor",
                               description = "Resolution multiplier (default 4)",
                               min = 0, defaultValue = "4")
            Integer factor,
            @DescribeParameter(name = "power",
                               description = "Distance exponent (default 2.0)",
                               min = 0, defaultValue = "2.0")
            Double power,
            @DescribeParameter(name = "neighbors",
                               description = "Source neighbors per dest pixel (default 8)",
                               min = 0, defaultValue = "8")
            Integer neighbors) {

        if (coverage == null) {
            throw new IllegalArgumentException("data parameter is required");
        }
        int f = (factor == null || factor < 1) ? 4 : factor;
        double p = (power == null || power <= 0) ? 2.0 : power;
        int nb = (neighbors == null || neighbors < 1) ? 8 : neighbors;

        GridGeometry2D gg = coverage.getGridGeometry();
        GridEnvelope2D srcRange = gg.getGridRange2D();
        int srcW = srcRange.width;
        int srcH = srcRange.height;

        if (srcW < 2 || srcH < 2) {
            return coverage;  // nothing to interpolate
        }

        int dstW = srcW * f;
        int dstH = srcH * f;

        // Read source raster into a float[][]
        float[][] src = new float[srcH][srcW];
        coverage.getRenderedImage().getData().getSamples(0, 0, srcW, srcH, 0, src[0]);
        // Note: getSamples flattens row-major. Re-shape :
        float[] flat = new float[srcW * srcH];
        coverage.getRenderedImage().getData().getSamples(0, 0, srcW, srcH, 0, flat);
        for (int y = 0; y < srcH; y++) {
            for (int x = 0; x < srcW; x++) {
                src[y][x] = flat[y * srcW + x];
            }
        }

        // Compute destination grid via IDW
        float[] dst = new float[dstW * dstH];
        for (int dy = 0; dy < dstH; dy++) {
            for (int dx = 0; dx < dstW; dx++) {
                // Map dst pixel center to src pixel coords (fractional)
                double sx = (dx + 0.5) / f - 0.5;
                double sy = (dy + 0.5) / f - 0.5;
                int sx0 = (int) Math.floor(sx);
                int sy0 = (int) Math.floor(sy);

                // Collect nb nearest neighbors in a (nb//2)+1 radius window
                int rad = Math.max(1, (int) Math.ceil(Math.sqrt(nb) / 2.0));
                double sumW = 0;
                double sumWV = 0;
                int kept = 0;
                for (int oy = -rad; oy <= rad; oy++) {
                    for (int ox = -rad; ox <= rad; ox++) {
                        int xi = sx0 + ox;
                        int yi = sy0 + oy;
                        if (xi < 0 || xi >= srcW || yi < 0 || yi >= srcH) continue;
                        double d2 = (xi - sx) * (xi - sx) + (yi - sy) * (yi - sy);
                        if (d2 < 1e-12) {
                            // exact hit on src pixel
                            sumWV = src[yi][xi];
                            sumW = 1;
                            kept = 1;
                            // break loops by setting weights heavy
                            oy = rad + 1; ox = rad + 1; break;
                        }
                        double w = 1.0 / Math.pow(d2, p / 2.0);
                        sumW += w;
                        sumWV += w * src[yi][xi];
                        kept++;
                    }
                }
                dst[dy * dstW + dx] = (kept > 0 && sumW > 0) ? (float) (sumWV / sumW) : Float.NaN;
            }
        }

        // Build output GridCoverage2D with new GridGeometry (same envelope, denser grid)
        Bounds env = gg.getEnvelope2D();
        GridCoverageFactory factory = CoverageFactoryFinder.getGridCoverageFactory(null);

        float[][] dst2d = new float[dstH][dstW];
        for (int y = 0; y < dstH; y++) {
            System.arraycopy(dst, y * dstW, dst2d[y], 0, dstW);
        }
        return factory.create(coverage.getName().toString() + "-idw",
                              dst2d,
                              new ReferencedEnvelope(env));
    }
}
