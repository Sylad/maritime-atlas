package fr.sladoire.maritime.cascade;

import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.geoserver.catalog.ResourcePool;
import org.geotools.http.HTTPClient;
import org.geotools.ows.wms.WebMapServer;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanPostProcessor;

/**
 * G65k (2026-05-27) — fix structurel cascade TIME forward.
 *
 * <p>Root cause identifiée (G65j) :
 * <pre>
 * [G65 DIAG] storeId=&lt;UUID stable&gt; wms=&lt;hashcode change chaque request&gt;
 *           httpClient=SimpleHttpClient wrapped=false
 * </pre>
 *
 * <p>Le {@code ResourcePool.wmsCache} (un {@code SoftValueHashMap}) retourne
 * un fresh {@link WebMapServer} à chaque appel parce que la cache est
 * invalidée entre requests (probablement Hazelcast cluster sync ou GC sur
 * soft refs). Notre wrap appliqué à un instance précédente est perdu.
 *
 * <p>Fix : remplacer la map {@code wmsCache} par {@link WrappingWmsCache}
 * qui, sur chaque {@code put()}, auto-wrap le {@link HTTPClient} du
 * {@link WebMapServer} avec un {@link CascadeTimeForwardingHTTPClient}.
 * Ainsi quelle que soit la fréquence de recréation, chaque WebMapServer
 * cached est garanti wrappé.
 *
 * <p>{@link BeanPostProcessor#postProcessAfterInitialization} fire après
 * Spring init du bean {@code resourcePool} → on remplace le champ
 * {@code wmsCache} via réflexion.
 */
public class WmsCacheWrappingPostProcessor implements BeanPostProcessor {

    private static final Logger LOG =
        Logger.getLogger(WmsCacheWrappingPostProcessor.class.getName());

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName)
            throws BeansException {
        if (!(bean instanceof ResourcePool pool)) {
            return bean;
        }
        try {
            Field f = ResourcePool.class.getDeclaredField("wmsCache");
            f.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, WebMapServer> current = (Map<String, WebMapServer>) f.get(pool);
            if (current instanceof WrappingWmsCache) {
                LOG.info("WmsCacheWrappingPostProcessor: already wrapped, skip");
                return bean;
            }
            WrappingWmsCache replacement = new WrappingWmsCache(current);
            f.set(pool, replacement);
            LOG.warning("WmsCacheWrappingPostProcessor: replaced wmsCache on bean '"
                + beanName + "' (existing=" + (current != null ? current.size() : 0)
                + " entries copied into wrapping map)");
        } catch (NoSuchFieldException e) {
            LOG.log(Level.WARNING,
                "WmsCacheWrappingPostProcessor: ResourcePool.wmsCache field missing "
                    + "(GS API change?), skip", e);
        } catch (Throwable t) {
            LOG.log(Level.SEVERE,
                "WmsCacheWrappingPostProcessor: failed (non-fatal)", t);
        }
        return bean;
    }

    /**
     * Map décorée qui wrap automatiquement le HTTPClient de chaque
     * {@link WebMapServer} mis en cache. Pas de soft refs (volontaire :
     * on est sur 3-4 stores, hold hard refs sans risque mémoire).
     */
    static class WrappingWmsCache extends HashMap<String, WebMapServer> {
        private static final Logger CLOG =
            Logger.getLogger(WrappingWmsCache.class.getName());

        WrappingWmsCache(Map<String, WebMapServer> existing) {
            super();
            if (existing != null) {
                for (Map.Entry<String, WebMapServer> e : existing.entrySet()) {
                    super.put(e.getKey(), wrapIfNeeded(e.getValue()));
                }
            }
        }

        @Override
        public WebMapServer put(String key, WebMapServer value) {
            WebMapServer wrapped = wrapIfNeeded(value);
            return super.put(key, wrapped);
        }

        private static WebMapServer wrapIfNeeded(WebMapServer wms) {
            if (wms == null) return null;
            HTTPClient current = wms.getHTTPClient();
            if (current instanceof CascadeTimeForwardingHTTPClient) {
                return wms;
            }
            CascadeTimeForwardingHTTPClient w =
                new CascadeTimeForwardingHTTPClient(current);
            wms.setHttpClient(w);
            CLOG.warning("[G65 CACHE-WRAP] " + wms + " httpClient wrapped (was "
                + current.getClass().getSimpleName() + ")");
            return wms;
        }
    }
}
