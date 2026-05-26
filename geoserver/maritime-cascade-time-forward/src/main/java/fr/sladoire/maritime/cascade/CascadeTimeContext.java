package fr.sladoire.maritime.cascade;

/**
 * ThreadLocal holder pour le param TIME de la requête WMS GetMap en cours.
 *
 * <p>Pont entre {@link CascadeTimeDispatcherCallback} (qui extract TIME du
 * KVP au début de chaque request HTTP côté GS) et
 * {@link CascadeTimeForwardingHTTPClient} (qui réinjecte TIME dans l'URL
 * upstream quand GeoTools `WebMapServer.issueRequest()` fait son GET).
 *
 * <p>OK d'utiliser ThreadLocal ici car GeoServer traite chaque GetMap dans
 * un seul thread Tomcat — le `issueRequest()` upstream s'exécute dans le
 * même thread que le `Dispatcher.handleRequest()`. Pas d'async dans le
 * pipeline cascade WMS.
 */
public final class CascadeTimeContext {

    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private CascadeTimeContext() {}

    public static void set(String iso8601Time) {
        if (iso8601Time != null && !iso8601Time.isEmpty()) {
            CURRENT.set(iso8601Time);
        }
    }

    public static String get() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
    }
}
