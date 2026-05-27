package fr.sladoire.maritime.cascade;

import java.util.logging.Level;
import java.util.logging.Logger;

import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.WMSStoreInfo;
import org.geoserver.catalog.event.CatalogAddEvent;
import org.geoserver.catalog.event.CatalogListener;
import org.geoserver.catalog.event.CatalogModifyEvent;
import org.geoserver.catalog.event.CatalogPostModifyEvent;
import org.geoserver.catalog.event.CatalogRemoveEvent;
import org.geoserver.platform.GeoServerExtensions;
import org.geotools.http.HTTPClient;
import org.geotools.ows.wms.WebMapServer;
import org.springframework.context.ApplicationListener;
import org.springframework.context.event.ContextRefreshedEvent;

/**
 * Wrap le {@link HTTPClient} de chaque {@link WebMapServer} cached pour
 * un {@link WMSStoreInfo} avec un {@link CascadeTimeForwardingHTTPClient},
 * afin que les appels upstream cascade GetMap reçoivent le param TIME.
 *
 * <p>Boot timing : utilise {@link ContextRefreshedEvent} (et non
 * {@code @PostConstruct}) pour que tous les beans GS (Catalog + ResourcePool
 * + Hazelcast) soient déjà ready. Cf marathon G64b — un init synchrone
 * pendant la phase critique de bean init fait dépasser le budget startup
 * probe.
 *
 * <p>Hook un {@link CatalogListener} pour intercepter les nouveaux/modifiés
 * WMSStoreInfo créés à chaud (ex: REST POST /workspaces/x/wmsstores).
 */
public class CascadeTimeForwardInitializer
        implements ApplicationListener<ContextRefreshedEvent> {

    private static final Logger LOG =
        Logger.getLogger(CascadeTimeForwardInitializer.class.getName());

    private volatile boolean initialized = false;
    private Catalog catalog;

    @Override
    public void onApplicationEvent(ContextRefreshedEvent event) {
        if (initialized) {
            return;
        }
        initialized = true;
        try {
            this.catalog = (Catalog) GeoServerExtensions.bean("catalog");
            if (catalog == null) {
                LOG.warning("CascadeTimeForwardInitializer: catalog bean not found, skip");
                return;
            }

            // G65m (2026-05-27) — fix structurel : remplacer ResourcePool.wmsCache
            // par une WrappingWmsCache qui auto-wrap chaque put(). Garantit que
            // toute future recréation de WebMapServer (Hazelcast event, GC,
            // store modify, etc.) re-wrap automatiquement.
            try {
                org.geoserver.catalog.ResourcePool pool = catalog.getResourcePool();
                java.lang.reflect.Field f =
                    org.geoserver.catalog.ResourcePool.class.getDeclaredField("wmsCache");
                f.setAccessible(true);
                @SuppressWarnings("unchecked")
                java.util.Map<String, org.geotools.ows.wms.WebMapServer> current =
                    (java.util.Map<String, org.geotools.ows.wms.WebMapServer>) f.get(pool);
                if (!(current instanceof WmsCacheWrappingPostProcessor.WrappingWmsCache)) {
                    WmsCacheWrappingPostProcessor.WrappingWmsCache replacement =
                        new WmsCacheWrappingPostProcessor.WrappingWmsCache(current);
                    f.set(pool, replacement);
                    LOG.warning("[G65 WMSCACHE-REPLACE] wmsCache replaced "
                        + "(was=" + (current != null ? current.getClass().getSimpleName() + ":" + current.size() : "null")
                        + " → WrappingWmsCache:" + replacement.size() + ")");
                }
            } catch (Throwable t) {
                LOG.log(Level.SEVERE, "[G65 WMSCACHE-REPLACE] failed", t);
            }

            // Wrap les WMSStoreInfo déjà chargés (pour cover le cas où ils
            // étaient en cache AVANT notre replace — déjà copiés mais double
            // sécurité ne coûte rien).
            int wrapped = 0;
            for (WMSStoreInfo store : catalog.getStores(WMSStoreInfo.class)) {
                if (wrapStoreClient(store)) {
                    wrapped++;
                }
            }
            LOG.info("CascadeTimeForwardInitializer: wrapped HTTPClient on "
                + wrapped + " WMSStoreInfo(s)");

            // Hook pour les WMSStoreInfo futurs (REST POST/PUT à chaud)
            catalog.addListener(new CatalogHook());
            LOG.info("CascadeTimeForwardInitializer: catalog listener installed");

        } catch (Throwable t) {
            // Ne JAMAIS bloquer le boot GS
            LOG.log(Level.SEVERE,
                "CascadeTimeForwardInitializer: init failed (non-fatal)", t);
        }
    }

    /**
     * Récupère le WebMapServer cached (créé à la demande par ResourcePool si
     * absent), inspecte son HTTPClient, et le remplace par notre wrapper s'il
     * ne l'est pas déjà.
     *
     * @return true si wrap effectué (false si déjà wrappé ou erreur)
     */
    private boolean wrapStoreClient(WMSStoreInfo store) {
        try {
            // getWebMapServer(null) côté GS = ResourcePool.getWebMapServer(store)
            // qui consulte le cache et build si absent.
            WebMapServer wms = store.getWebMapServer(null);
            if (wms == null) {
                LOG.warning("CascadeTimeForwardInitializer: WebMapServer null for "
                    + store.getName());
                return false;
            }
            HTTPClient current = wms.getHTTPClient();
            if (current instanceof CascadeTimeForwardingHTTPClient) {
                LOG.fine(() -> "CascadeTimeForwardInitializer: " + store.getName()
                    + " already wrapped, skip");
                return false;
            }
            CascadeTimeForwardingHTTPClient wrapped =
                new CascadeTimeForwardingHTTPClient(current);
            wms.setHttpClient(wrapped);
            LOG.info("CascadeTimeForwardInitializer: wrapped " + store.getName()
                + " (delegate=" + current.getClass().getSimpleName() + ")");
            return true;
        } catch (Throwable t) {
            LOG.log(Level.WARNING,
                "CascadeTimeForwardInitializer: wrap failed for " + store.getName(), t);
            return false;
        }
    }

    /**
     * CatalogListener qui wrap les WMSStoreInfo créés/modifiés post-boot.
     * Implémente l'interface complète (AbstractCatalogListener n'existe pas
     * dans gs-main).
     */
    private class CatalogHook implements CatalogListener {

        @Override
        public void handleAddEvent(CatalogAddEvent event) {
            if (event.getSource() instanceof WMSStoreInfo store) {
                wrapStoreClient(store);
            }
        }

        @Override
        public void handlePostModifyEvent(CatalogPostModifyEvent event) {
            if (event.getSource() instanceof WMSStoreInfo store) {
                // Une modification peut avoir invalidé le WebMapServer cache
                // (ex: changement URL) → re-wrap
                wrapStoreClient(store);
            }
        }

        @Override public void handleRemoveEvent(CatalogRemoveEvent event) {}
        @Override public void handleModifyEvent(CatalogModifyEvent event) {}
        @Override public void reloaded() {
            // catalog rechargé → tous les WebMapServer rebuild from cache
            LOG.info("CascadeTimeForwardInitializer: catalog reloaded, re-wrapping all");
            for (WMSStoreInfo store : catalog.getStores(WMSStoreInfo.class)) {
                wrapStoreClient(store);
            }
        }
    }
}
