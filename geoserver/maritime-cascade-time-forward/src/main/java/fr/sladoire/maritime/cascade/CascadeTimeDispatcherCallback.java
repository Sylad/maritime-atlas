package fr.sladoire.maritime.cascade;

import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.WMSStoreInfo;
import org.geoserver.ows.AbstractDispatcherCallback;
import org.geoserver.ows.Request;
import org.geoserver.platform.GeoServerExtensions;
import org.geoserver.platform.Operation;
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
                LOG.warning("[G65 STASH] operationDispatched: stash TIME=" + s);
            } else {
                LOG.warning("[G65 STASH-MISS] kvp keys=" + kvp.keySet() + " time=" + time);
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
                            + " storeId=" + store.getId()
                            + " storeHash=" + System.identityHashCode(store)
                            + " wms=" + System.identityHashCode(wms)
                            + " httpClient=" + hc.getClass().getSimpleName()
                            + " wrapped=" + wrapped);
                        if (!wrapped) {
                            wms.setHttpClient(new CascadeTimeForwardingHTTPClient(hc));
                            LOG.warning("[G65 REWRAP] store=" + store.getName() + " re-wrapped");
                        }
                    }
                }
            } catch (Throwable t) {
                LOG.log(Level.WARNING, "[G65 DIAG] failed", t);
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
