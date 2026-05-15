package fr.sladoire.maritime.idw;

import static org.geotools.filter.capability.FunctionNameImpl.parameter;

import java.awt.geom.AffineTransform;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.geotools.api.coverage.grid.GridGeometry;
import org.geotools.api.data.Query;
import org.geotools.api.filter.capability.FunctionName;
import org.geotools.api.filter.expression.Expression;
import org.geotools.api.parameter.GeneralParameterValue;
import org.geotools.api.parameter.ParameterValue;
import org.geotools.api.referencing.crs.CoordinateReferenceSystem;
import org.geotools.api.referencing.datum.PixelInCell;
import org.geotools.coverage.grid.GridCoverage2D;
import org.geotools.coverage.grid.GridEnvelope2D;
import org.geotools.coverage.grid.GridGeometry2D;
import org.geotools.coverage.grid.io.AbstractGridFormat;
import org.geotools.coverage.grid.io.CoverageReadingTransformation;
import org.geotools.coverage.grid.io.GridCoverage2DReader;
import org.geotools.filter.FunctionImpl;
import org.geotools.filter.capability.FunctionNameImpl;
import org.geotools.geometry.jts.ReferencedEnvelope;
import org.geotools.referencing.CRS;

/**
 * SLD {@code idw:IDW} rendering function — densifies a raster source via Inverse
 * Distance Weighting, then returns the result for the rest of the rendering chain
 * to consume (raster symbolizer, contour FeatureTypeStyle, etc.).
 *
 * <p><b>Why a {@link CoverageReadingTransformation} and not a regular WPS process</b> ?
 * Investigation 2026-05-15 (cf maritime_atlas docs) showed that the standard
 * GeoTools rendering pipeline:
 * <ol>
 *   <li>Reads the source coverage at TARGET resolution (display 256×256 / 512×512 / etc)
 *       — not at the source's native resolution.</li>
 *   <li>Performs NN upsampling when target res &gt; native (i.e. always for
 *       coarse meteo rasters at 0.25°/pixel).</li>
 *   <li>Then calls the WPS transformation with this fake-upsampled coverage,
 *       making IDW interpolate already-interpolated data — defeats the point.</li>
 * </ol>
 *
 * <p>By implementing {@code CoverageReadingTransformation}, GeoServer skips its
 * own read and hands us the {@code ReaderAndParams} directly (cf
 * {@code RenderingTransformationHelper.applyRenderingTransformation}, line 173).
 * We then read at NATIVE resolution clipped to the target envelope, apply IDW,
 * and return the densified coverage. Single interpolation stage, no waste.
 *
 * <p>SLD usage (unchanged from the previous WPS-style version) :
 * <pre>{@code
 *   <Transformation>
 *     <ogc:Function name="idw:IDW">
 *       <ogc:Function name="parameter"><ogc:Literal>data</ogc:Literal></ogc:Function>
 *       <ogc:Function name="parameter">
 *         <ogc:Literal>factor</ogc:Literal><ogc:Literal>12</ogc:Literal>
 *       </ogc:Function>
 *     </ogc:Function>
 *   </Transformation>
 * }</pre>
 */
public class IDWFunction extends FunctionImpl implements CoverageReadingTransformation {

    private static final Logger LOGGER = Logger.getLogger(IDWFunction.class.getName());

    public static final FunctionName NAME = new FunctionNameImpl(
            "idwInterpolate",
            parameter("result", GridCoverage2D.class),
            parameter("data", Object.class, 0, 1),
            parameter("factor", Map.class, 0, 1),
            parameter("power", Map.class, 0, 1),
            parameter("neighbors", Map.class, 0, 1));

    /** Source request cap : prevents OOM if a coverage has unusually high native
     *  resolution over a large bbox (e.g. ARPEGE 0.1° fullscreen). Past this,
     *  we accept some decimation in exchange for bounded memory. */
    private static final int SOURCE_CAP = 1024;

    public IDWFunction() {
        this.functionName = NAME;
    }

    @Override
    public Object evaluate(Object object) {
        if (!(object instanceof CoverageReadingTransformation.ReaderAndParams rap)) {
            throw new IllegalArgumentException(
                    "idwInterpolate is a CoverageReadingTransformation, expected ReaderAndParams but got " + object);
        }

        Map<String, Object> args = parseArgs(object);
        final int factor = clamp(intArg(args.get("factor"), IDWProcess.DEFAULT_FACTOR),
                IDWProcess.MIN_FACTOR, IDWProcess.MAX_FACTOR);
        final double power = clamp(doubleArg(args.get("power"), IDWProcess.DEFAULT_POWER),
                IDWProcess.MIN_POWER, IDWProcess.MAX_POWER);
        final int neighbors = clamp(intArg(args.get("neighbors"), IDWProcess.DEFAULT_NEIGHBORS),
                IDWProcess.MIN_NEIGHBORS, IDWProcess.MAX_NEIGHBORS);

        try {
            GridCoverage2D nativeCoverage = readNative(rap.getReader(), rap.getReadParameters());
            if (nativeCoverage == null) return null;
            return IDWProcess.applyIDW(nativeCoverage, factor, power, neighbors);
        } catch (IOException e) {
            throw new RuntimeException("idwInterpolate failed to read coverage at native resolution", e);
        }
    }

    /**
     * Lit le coverage via le reader donné, en forçant la lecture à la résolution
     * NATIVE clippée à l'envelope target. Stratégie :
     *   1. extract target envelope from {@code params}'s READ_GRIDGEOMETRY2D
     *   2. project envelope to source CRS (if cross-CRS)
     *   3. compute cell count = envelope_size / native_pixel_size
     *   4. override READ_GRIDGEOMETRY2D in params with the new native-res GG
     *   5. reader.read(params) returns native data, no pipeline upsample
     */
    static GridCoverage2D readNative(GridCoverage2DReader reader, GeneralParameterValue[] params)
            throws IOException {

        GridGeometry2D targetGG = extractReadGG(params);
        if (targetGG == null) {
            LOGGER.warning("idw: no READ_GRIDGEOMETRY2D in params — falling back to default read");
            return reader.read(params);
        }

        ReferencedEnvelope targetEnv = ReferencedEnvelope.reference(targetGG.getEnvelope2D());
        CoordinateReferenceSystem sourceCRS = reader.getCoordinateReferenceSystem();

        ReferencedEnvelope envInSource;
        try {
            envInSource = (targetEnv.getCoordinateReferenceSystem() == null
                    || CRS.equalsIgnoreMetadata(targetEnv.getCoordinateReferenceSystem(), sourceCRS))
                    ? targetEnv
                    : targetEnv.transform(sourceCRS, true);
        } catch (Exception e) {
            LOGGER.log(Level.WARNING, "idw: envelope transform failed, using target envelope as-is", e);
            envInSource = targetEnv;
        }

        AffineTransform g2w = (AffineTransform) reader.getOriginalGridToWorld(PixelInCell.CELL_CENTER);
        double pixelX = Math.abs(g2w.getScaleX());
        double pixelY = Math.abs(g2w.getScaleY());
        if (pixelX <= 0 || pixelY <= 0) {
            return reader.read(params);
        }

        int w = Math.max(2, (int) Math.ceil(envInSource.getWidth() / pixelX));
        int h = Math.max(2, (int) Math.ceil(envInSource.getHeight() / pixelY));

        if (w > SOURCE_CAP || h > SOURCE_CAP) {
            double scale = Math.min((double) SOURCE_CAP / w, (double) SOURCE_CAP / h);
            w = Math.max(2, (int) (w * scale));
            h = Math.max(2, (int) (h * scale));
        }

        GridGeometry2D nativeGG = new GridGeometry2D(
                new GridEnvelope2D(0, 0, w, h),
                envInSource);

        final int wF = w, hF = h;
        LOGGER.info(() -> String.format(
                "idw: reading native %dx%d cells over envelope (source CRS=%s)",
                wF, hF, sourceCRS.getName().getCode()));

        GeneralParameterValue[] updatedParams = updateReadGG(params, nativeGG);
        return reader.read(updatedParams);
    }

    static GridGeometry2D extractReadGG(GeneralParameterValue[] params) {
        if (params == null) return null;
        for (GeneralParameterValue gp : params) {
            if (gp instanceof ParameterValue<?> pv
                    && AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().equals(pv.getDescriptor().getName())) {
                Object value = pv.getValue();
                if (value instanceof GridGeometry2D gg) return gg;
            }
        }
        return null;
    }

    static GeneralParameterValue[] updateReadGG(GeneralParameterValue[] params, GridGeometry2D newGG) {
        for (int i = 0; i < params.length; i++) {
            if (params[i] instanceof ParameterValue<?> pv
                    && AbstractGridFormat.READ_GRIDGEOMETRY2D.getName().equals(pv.getDescriptor().getName())) {
                @SuppressWarnings({"unchecked", "rawtypes"})
                ParameterValue typed = (ParameterValue) pv;
                typed.setValue(newGG);
                return params;
            }
        }
        @SuppressWarnings("unchecked")
        ParameterValue<GridGeometry2D> newParam = (ParameterValue<GridGeometry2D>)
                AbstractGridFormat.READ_GRIDGEOMETRY2D.createValue();
        newParam.setValue(newGG);
        GeneralParameterValue[] expanded = Arrays.copyOf(params, params.length + 1);
        expanded[params.length] = newParam;
        return expanded;
    }

    /** Parse les parameter(name, value) du SLD en un Map plat. */
    Map<String, Object> parseArgs(Object context) {
        Map<String, Object> args = new HashMap<>();
        for (Expression expr : getParameters()) {
            Object value = expr.evaluate(context);
            if (value instanceof Map<?, ?> map) {
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    args.put(String.valueOf(e.getKey()), e.getValue());
                }
            }
        }
        return args;
    }

    private static int intArg(Object o, int def) {
        if (o == null) return def;
        if (o instanceof Number n) return n.intValue();
        try { return Integer.parseInt(o.toString().trim()); } catch (Exception e) { return def; }
    }

    private static double doubleArg(Object o, double def) {
        if (o == null) return def;
        if (o instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(o.toString().trim()); } catch (Exception e) { return def; }
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
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
