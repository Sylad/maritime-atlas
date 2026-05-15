package fr.sladoire.maritime.idw;

import java.util.logging.Level;
import java.util.logging.Logger;

import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridGeometry2D;
import org.geotools.data.simple.SimpleFeatureCollection;
import org.geotools.process.factory.DescribeParameter;
import org.geotools.process.factory.DescribeProcess;
import org.geotools.process.factory.DescribeResult;
import org.geotools.process.raster.ContourProcess;

/**
 * IDW + Contour combined — densifie un raster source puis génère des isolignes
 * sur la grille densifiée, en un seul appel WPS.
 *
 * <p><b>Pourquoi ce process combiné ?</b><br>
 * Le chaining SLD natif {@code <Function name="ras:Contour"><Function name="idw:IDW">...}
 * ne marche pas dans GeoServer 2.28 : GeoServer n'auto-injecte le coverage source
 * QUE sur la transformation externe. Le inner IDW reçoit {@code data=null} →
 * "Parameter data is missing but has min multiplicity > 0".
 *
 * <p>Solution : un seul process qui internalise IDW + Contour. Pas de chaining
 * SLD, pas de bug, pas de double validation. Performance équivalente (les 2
 * étapes auraient été séquentielles de toute façon).
 *
 * <p><b>Usage SLD :</b>
 * <pre>{@code
 *   <Transformation>
 *     <ogc:Function name="idw:IDWContour">
 *       <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>factor</ogc:Literal><ogc:Literal>4</ogc:Literal>
 *       </ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>interval</ogc:Literal><ogc:Literal>2.0</ogc:Literal>
 *       </ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>smooth</ogc:Literal><ogc:Literal>true</ogc:Literal>
 *       </ogc:Function>
 *     </ogc:Function>
 *   </Transformation>
 * }</pre>
 *
 * <p>Les contours retournés sont des {@code LineString} avec un attribut
 * {@code value} (Double) pour le seuil de l'isoligne.
 *
 * @see IDWProcess
 * @see ContourProcess
 */
@DescribeProcess(title = "IDW + Contour",
                 description = "Densify a raster via IDW and extract contour lines in a single process.")
public class IDWContourProcess {

    private static final Logger LOGGER = Logger.getLogger(IDWContourProcess.class.getName());

    /** Réutilise une seule instance d'IDWProcess (stateless, thread-safe). */
    private static final IDWProcess IDW = new IDWProcess();

    @DescribeResult(name = "result", description = "Contour line features (value attribute = isoline level)")
    public SimpleFeatureCollection execute(
            // min=0 : contourne le bug GeoTools post-2.26.2 (cf IDWProcess JavaDoc).
            @DescribeParameter(name = "data",
                               description = "Source raster coverage (auto-injected in SLD)",
                               min = 0)
            GridCoverage2D coverage,
            @DescribeParameter(name = "factor",
                               description = "IDW resolution multiplier 1-16 (default 4)",
                               min = 0, defaultValue = "4")
            Integer factor,
            @DescribeParameter(name = "power",
                               description = "IDW distance exponent 0.1-10 (default 2)",
                               min = 0, defaultValue = "2.0")
            Double power,
            @DescribeParameter(name = "neighbors",
                               description = "IDW source neighbors per dest pixel 1-25 (default 8)",
                               min = 0, defaultValue = "8")
            Integer neighbors,
            @DescribeParameter(name = "interval",
                               description = "Contour interval between isolines (required)",
                               min = 0)
            Double interval,
            @DescribeParameter(name = "simplify",
                               description = "Simplify contour lines (default true)",
                               min = 0, defaultValue = "true")
            Boolean simplify,
            @DescribeParameter(name = "smooth",
                               description = "Apply Bezier smoothing to contours (default true)",
                               min = 0, defaultValue = "true")
            Boolean smooth) {

        if (coverage == null) {
            throw new IllegalArgumentException("'data' parameter is required");
        }
        if (interval == null) {
            throw new IllegalArgumentException("'interval' parameter is required");
        }

        final long t0 = LOGGER.isLoggable(Level.FINE) ? System.nanoTime() : 0L;

        // Step 1 : densification IDW. Si factor=1, IDWProcess retourne le coverage tel quel.
        final GridCoverage2D dense = IDW.execute(coverage, factor, power, neighbors);

        // Step 2 : extraction des contours sur la grille densifiée.
        // Args ContourProcess.process : (coverage, band, levels[], interval,
        //                                simplify, smooth, roi, listener)
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
                    factor == null ? 4 : factor, interval, contours.size(), ms));
        }

        return contours;
    }

    /**
     * Hook RenderingProcess — borne la lecture source à target/N (CAP 1024)
     * pour le même motif que {@link IDWProcess#invertGridGeometry(Query, GridGeometry)} :
     * sans borne, retourner {@code target} ou {@code null} force le reader à
     * lire à la résolution d'affichage entière, puis IDW × factor explose en
     * mémoire et ContourProcess hérite d'une grille gigantesque (lignes
     * lentes, contours à priori plus "fins" mais avec un coût RAM/CPU rédhibitoire).
     *
     * <p>Avec borne : reader → native, IDW × factor → grille raisonnable,
     * Contour produit des lignes fluides (Bezier smoothing déjà actif via
     * {@code smooth=true}).
     */
    public GridGeometry invertGridGeometry(Query targetQuery, GridGeometry targetGridGeometry) {
        // cf {@link IDWProcess#invertGridGeometry(Query, GridGeometry)} : null plante GS,
        // target permet au moins de passer ; le reader décidera de la résolution servie.
        return targetGridGeometry;
    }
}
