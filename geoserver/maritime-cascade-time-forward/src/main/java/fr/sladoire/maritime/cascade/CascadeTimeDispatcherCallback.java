package fr.sladoire.maritime.cascade;

import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.WMSStoreInfo;
import org.geoserver.ows.AbstractDispatcherCallback;
import org.geoserver.ows.Request;
import org.geoserver.platform.GeoServerExtensions;
import org.geotools.http.HTTPClient;
import org.geotools.ows.wms.WebMapServer;

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
        // G65g (2026-05-26) — log UNCONDITIONAL au tout début pour prouver
        // que le callback est bien invoqué par le Dispatcher (pas filtré
        // par service/request). Si on voit jamais [G65 INIT], c'est que
        // le bean n'est pas dans la liste callbacks du Dispatcher.
        LOG.warning("[G65 INIT] DispatcherCallback.init called service="
            + request.getService() + " request=" + request.getRequest()
            + " path=" + (request.getHttpRequest() != null
                ? request.getHttpRequest().getRequestURI() : "<null>"));

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
                LOG.warning("[G65 STASH] CascadeTimeDispatcherCallback: stash TIME=" + s);
            }

            // G65f (2026-05-26) — DIAGNOSTIC : inspecte le HTTPClient courant
            // de chaque WMSStoreInfo pour vérifier que notre wrap est toujours
            // en place au moment de la request. Si on voit "SimpleHttpClient"
            // au lieu de "CascadeTimeForwardingHTTPClient", c'est que GS a
            // recréé un WebMapServer entre le boot et la request → cache
            // invalidé → notre wrap perdu → re-wrap nécessaire.
            try {
                Catalog catalog = (Catalog) GeoServerExtensions.bean("catalog");
                if (catalog != null) {
                    for (WMSStoreInfo store : catalog.getStores(WMSStoreInfo.class)) {
                        WebMapServer wms = store.getWebMapServer(null);
                        HTTPClient hc = wms.getHTTPClient();
                        boolean wrapped = (hc instanceof CascadeTimeForwardingHTTPClient);
                        LOG.warning("[G65 DIAG] store=" + store.getName()
                            + " wms=" + System.identityHashCode(wms)
                            + " httpClient=" + hc.getClass().getSimpleName()
                            + " wrapped=" + wrapped);
                        if (!wrapped) {
                            // Re-wrap immédiatement
                            wms.setHttpClient(new CascadeTimeForwardingHTTPClient(hc));
                            LOG.warning("[G65 REWRAP] store=" + store.getName() + " re-wrapped");
                        }
                    }
                }
            } catch (Throwable t) {
                LOG.log(Level.WARNING, "[G65 DIAG] failed", t);
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
