package fr.sladoire.maritime.cascade;

import java.util.Map;
import java.util.logging.Logger;

import org.geoserver.ows.AbstractDispatcherCallback;
import org.geoserver.ows.Request;

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
        // Défense en profondeur : clear le ThreadLocal au début de CHAQUE
        // request GS, même si la précédente a fait clear() proprement.
        // Tomcat ré-utilise les threads du pool, un leak résiduel d'une
        // request qui aurait by-passé finished() (ex: exception qui short-
        // circuite le Dispatcher) ne contaminera pas la suivante.
        CascadeTimeContext.clear();
        try {
            if (!"WMS".equalsIgnoreCase(request.getService())) {
                return request;
            }
            if (!"GetMap".equalsIgnoreCase(request.getRequest())) {
                return request;
            }
            Map<String, Object> kvp = request.getRawKvp();
            if (kvp == null) {
                return request;
            }
            Object time = kvp.get("TIME");
            if (time == null) {
                // try lowercase / mixed (KVP map is case-insensitive in GS,
                // but rawKvp may be case-sensitive depending on GS version)
                time = kvp.get("time");
            }
            if (time instanceof String s && !s.isEmpty()) {
                CascadeTimeContext.set(s);
                LOG.fine(() -> "CascadeTimeDispatcherCallback: stash TIME=" + s);
            }
        } catch (Throwable t) {
            // jamais bloquer la request sur une erreur de stash
            LOG.warning("CascadeTimeDispatcherCallback init failed (non-fatal): " + t);
        }
        return request;
    }

    @Override
    public void finished(Request request) {
        CascadeTimeContext.clear();
    }
}
