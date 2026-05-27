package fr.sladoire.maritime.cascade;

import java.util.Map;
import java.util.logging.Logger;

import org.geoserver.ows.AbstractDispatcherCallback;
import org.geoserver.ows.Request;
import org.geoserver.platform.Operation;

/**
 * Stash le param TIME du KVP entrant dans le {@link CascadeTimeContext}
 * ThreadLocal pour que {@link CascadeTimeForwardingHTTPClient} puisse
 * le réinjecter dans les URLs upstream cascade WMS.
 *
 * <p>Aussi clear le ThreadLocal sur finished() pour éviter les fuites
 * entre requêtes (Tomcat pool des threads).
 *
 * <p>Filtre :
 * <ul>
 *   <li>service=WMS uniquement (pas WFS/WCS/WMTS)
 *   <li>request=GetMap (GetCapabilities, GetLegendGraphic etc. n'ont
 *       pas besoin de TIME forward)
 * </ul>
 */
public class CascadeTimeDispatcherCallback extends AbstractDispatcherCallback {

    private static final Logger LOG =
        Logger.getLogger(CascadeTimeDispatcherCallback.class.getName());

    @Override
    public Request init(Request request) {
        // G65i (2026-05-26) — IMPORTANT : à init() time, GS n'a PAS encore
        // parsé le KVP. request.getService() et request.getRequest() sont
        // null. C'est en `serviceDispatched()` puis `operationDispatched()`
        // que ces fields sont remplis.
        //
        // Donc le stash TIME doit se faire dans operationDispatched().
        //
        // init() = juste un clear ThreadLocal défensif (purge état leaké
        // d'une request précédente qui aurait skippé finished()).
        CascadeTimeContext.clear();
        return request;
    }

    @Override
    public Operation operationDispatched(Request request, Operation operation) {
        try {
            if (!"WMS".equalsIgnoreCase(request.getService())) {
                return operation;
            }
            if (!"GetMap".equalsIgnoreCase(request.getRequest())) {
                return operation;
            }
            Map<String, Object> kvp = request.getRawKvp();
            if (kvp == null) {
                return operation;
            }
            Object time = kvp.get("TIME");
            if (time == null) {
                time = kvp.get("time");
            }
            if (time instanceof String s && !s.isEmpty()) {
                CascadeTimeContext.set(s);
                LOG.fine(() -> "CascadeTimeDispatcherCallback: stash TIME=" + s);
            }
        } catch (Throwable t) {
            LOG.warning("[G65 STASH] operationDispatched failed (non-fatal): " + t);
        }
        return operation;
    }

    @Override
    public void finished(Request request) {
        CascadeTimeContext.clear();
    }
}
