package fr.sladoire.maritime.idw;

import java.util.logging.Level;
import java.util.logging.Logger;

import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.data.simple.SimpleFeatureCollection;
import org.geotools.process.raster.ContourProcess;

/**
 * IDW + Contour — algorithme combiné, statique.
 *
 * <p>Densifie un raster via IDW puis extrait des isolignes sur la grille
 * densifiée. Le wiring SLD est fait par {@link IDWContourFunction}
 * (CoverageReadingTransformation) ; cette classe contient juste la logique.
 *
 * <p>Le chaining SLD natif {@code ras:Contour(idw:IDW(...))} ne marche pas
 * dans GeoServer 2.28 — d'où le besoin d'avoir IDW + Contour dans un seul
 * appel transformation.
 *
 * @see IDWProcess#applyIDW(GridCoverage2D, Integer, Double, Integer)
 * @see ContourProcess#process
 */
public class IDWContourProcess {

    private static final Logger LOGGER = Logger.getLogger(IDWContourProcess.class.getName());

    /**
     * Apply IDW densification then extract contours.
     *
     * @param coverage  source raster
     * @param factor    IDW resolution multiplier
     * @param power     IDW distance exponent
     * @param neighbors IDW source neighbors per dest pixel
     * @param interval  contour interval (between isolines)
     * @param simplify  Douglas-Peucker simplification (default true)
     * @param smooth    Bezier smoothing (default true)
     * @return feature collection of LineString contours with "value" attribute
     */
    public static SimpleFeatureCollection applyIDWContour(
            GridCoverage2D coverage,
            Integer factor,
            Double power,
            Integer neighbors,
            Double interval,
            Boolean simplify,
            Boolean smooth) {

        if (coverage == null) {
            throw new IllegalArgumentException("'data' parameter is required");
        }
        if (interval == null) {
            throw new IllegalArgumentException("'interval' parameter is required");
        }

        final long t0 = LOGGER.isLoggable(Level.FINE) ? System.nanoTime() : 0L;

        final GridCoverage2D dense = IDWProcess.applyIDW(coverage, factor, power, neighbors);

        final SimpleFeatureCollection contours = ContourProcess.process(
                dense,
                /* band */ null,
                /* levels */ null,
                interval,
                simplify == null ? Boolean.TRUE : simplify,
                smooth == null ? Boolean.TRUE : smooth,
                /* roi */ null,
                /* listener */ null);

        if (LOGGER.isLoggable(Level.FINE)) {
            final long ms = (System.nanoTime() - t0) / 1_000_000L;
            LOGGER.fine(() -> String.format(
                    "IDWContour: factor=%d interval=%.2f → %d features in %dms",
                    factor == null ? IDWProcess.DEFAULT_FACTOR : factor, interval, contours.size(), ms));
        }

        return contours;
    }
}
