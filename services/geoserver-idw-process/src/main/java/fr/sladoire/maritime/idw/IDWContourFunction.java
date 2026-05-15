package fr.sladoire.maritime.idw;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.io.IOException;
import java.util.Map;
import java.util.logging.Logger;

import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.io.CoverageReadingTransformation;
import org.geotools.data.simple.SimpleFeatureCollection;
import org.geotools.filter.FunctionImpl;
import org.geotools.filter.capability.FunctionNameImpl;

/**
 * SLD {@code idw:IDWContour} — densifie un raster source via IDW à sa résolution
 * native (cf {@link IDWFunction}) puis extrait des isolignes sur la grille
 * densifiée. Bezier smoothing actif par défaut.
 *
 * <p>SLD :
 * <pre>{@code
 *   <Transformation>
 *     <ogc:Function name="idw:IDWContour">
 *       <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>factor</ogc:Literal><ogc:Literal>12</ogc:Literal>
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
 */
public class IDWContourFunction extends FunctionImpl implements CoverageReadingTransformation {

    private static final Logger LOGGER = Logger.getLogger(IDWContourFunction.class.getName());

    public static final FunctionName NAME = new FunctionNameImpl(
            "idwContour",
            parameter("result", SimpleFeatureCollection.class),
            parameter("data", Object.class, 0, 1),
            parameter("factor", Map.class, 0, 1),
            parameter("power", Map.class, 0, 1),
            parameter("neighbors", Map.class, 0, 1),
            parameter("interval", Map.class, 0, 1),
            parameter("simplify", Map.class, 0, 1),
            parameter("smooth", Map.class, 0, 1));

    /** Pour réutiliser parseArgs / readNative — non-statique, mais sans state. */
    private final IDWFunction idw = new IDWFunction();

    public IDWContourFunction() {
        this.functionName = NAME;
    }

    @Override
    public Object evaluate(Object object) {
        if (!(object instanceof CoverageReadingTransformation.ReaderAndParams rap)) {
            throw new IllegalArgumentException(
                    "idwContour expected ReaderAndParams but got " + object);
        }

        Map<String, Object> args = parseArgs(object);

        final int factor = clampInt(args.get("factor"), IDWProcess.DEFAULT_FACTOR,
                IDWProcess.MIN_FACTOR, IDWProcess.MAX_FACTOR);
        final double power = clampDouble(args.get("power"), IDWProcess.DEFAULT_POWER,
                IDWProcess.MIN_POWER, IDWProcess.MAX_POWER);
        final int neighbors = clampInt(args.get("neighbors"), IDWProcess.DEFAULT_NEIGHBORS,
                IDWProcess.MIN_NEIGHBORS, IDWProcess.MAX_NEIGHBORS);
        final Double interval = doubleObj(args.get("interval"));
        final Boolean simplify = boolObj(args.get("simplify"), Boolean.TRUE);
        final Boolean smooth = boolObj(args.get("smooth"), Boolean.TRUE);

        if (interval == null) {
            throw new IllegalArgumentException("idwContour requires 'interval' parameter");
        }

        try {
            GridCoverage2D nativeCoverage = IDWFunction.readNative(
                    rap.getReader(), rap.getReadParameters());
            if (nativeCoverage == null) return null;
            return IDWContourProcess.applyIDWContour(
                    nativeCoverage, factor, power, neighbors, interval, simplify, smooth);
        } catch (IOException e) {
            throw new RuntimeException("idwContour failed to read coverage at native resolution", e);
        }
    }

    /** Réutilise la logique de parsing de {@link IDWFunction}. */
    private Map<String, Object> parseArgs(Object context) {
        // IDWFunction.parseArgs walks getParameters() of the bound Function ; we
        // need to walk OUR getParameters(), so reimplement here trivially.
        java.util.Map<String, Object> out = new java.util.HashMap<>();
        for (var expr : getParameters()) {
            Object value = expr.evaluate(context);
            if (value instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    out.put(String.valueOf(e.getKey()), e.getValue());
                }
            }
        }
        return out;
    }

    private static int clampInt(Object o, int def, int min, int max) {
        int v = def;
        if (o instanceof Number n) v = n.intValue();
        else if (o != null) {
            try { v = Integer.parseInt(o.toString().trim()); } catch (Exception ignore) {}
        }
        return Math.max(min, Math.min(max, v));
    }

    private static double clampDouble(Object o, double def, double min, double max) {
        double v = def;
        if (o instanceof Number n) v = n.doubleValue();
        else if (o != null) {
            try { v = Double.parseDouble(o.toString().trim()); } catch (Exception ignore) {}
        }
        return Math.max(min, Math.min(max, v));
    }

    private static Double doubleObj(Object o) {
        if (o == null) return null;
        if (o instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(o.toString().trim()); } catch (Exception e) { return null; }
    }

    private static Boolean boolObj(Object o, Boolean def) {
        if (o == null) return def;
        if (o instanceof Boolean b) return b;
        String s = o.toString().trim().toLowerCase();
        if ("true".equals(s) || "1".equals(s) || "yes".equals(s)) return Boolean.TRUE;
        if ("false".equals(s) || "0".equals(s) || "no".equals(s)) return Boolean.FALSE;
        return def;
    }

    @Override
    public Query invertQuery(Query targetQuery, GridGeometry gridGeometry) {
        return targetQuery;
    }

    @Override
    public GridGeometry invertGridGeometry(Query targetQuery, GridGeometry targetGridGeometry) {
        return targetGridGeometry;
    }
}
