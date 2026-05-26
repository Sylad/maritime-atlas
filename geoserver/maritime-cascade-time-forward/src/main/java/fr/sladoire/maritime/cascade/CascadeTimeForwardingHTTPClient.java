package fr.sladoire.maritime.cascade;

import java.io.IOException;
import java.io.InputStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

import org.geotools.http.HTTPClient;
import org.geotools.http.HTTPResponse;

/**
 * Wrapper transparent autour d'un {@link HTTPClient} GeoTools (le client
 * effectif fourni par GeoServer, soit {@code MultithreadedHttpClient} si
 * connection pooling activé, soit {@code SimpleHttpClient} sinon).
 *
 * <p>Intercepte UNIQUEMENT {@link #get(URL)} et {@link #get(URL, Map)}, et
 * UNIQUEMENT pour les URLs qui ressemblent à un GetMap WMS upstream
 * (query string contient {@code service=WMS} et {@code request=GetMap},
 * insensible à la casse). Tous les autres appels — POST, GetCapabilities,
 * autres protocoles — sont passés-through inchangés.
 *
 * <p>Si {@link CascadeTimeContext#get()} retourne un timestamp ISO 8601
 * non-null, l'URL est ré-écrite pour ajouter/remplacer le param
 * {@code TIME=...} dans le query string. Toutes les autres options
 * (BBOX/WIDTH/HEIGHT/LAYERS/STYLES/...) sont préservées telles quelles.
 *
 * <p>Tous les setters/getters de l'API HTTPClient sont délégués au client
 * wrappé (le wrap est totalement transparent du point de vue config GS).
 */
public class CascadeTimeForwardingHTTPClient implements HTTPClient {

    private static final Logger LOG =
        Logger.getLogger(CascadeTimeForwardingHTTPClient.class.getName());

    private final HTTPClient delegate;

    public CascadeTimeForwardingHTTPClient(HTTPClient delegate) {
        if (delegate == null) {
            throw new IllegalArgumentException("delegate HTTPClient cannot be null");
        }
        this.delegate = delegate;
    }

    /** Le client wrappé — exposé pour debug uniquement. */
    public HTTPClient unwrap() {
        return delegate;
    }

    @Override
    public HTTPResponse get(URL url) throws IOException {
        return delegate.get(maybeInjectTime(url));
    }

    @Override
    public HTTPResponse get(URL url, Map<String, String> headers) throws IOException {
        return delegate.get(maybeInjectTime(url), headers);
    }

    @Override
    public HTTPResponse post(URL url, InputStream postContent, String postContentType)
            throws IOException {
        // POST = jamais cascade WMS GetMap (GeoTools utilise GET pour cascade)
        return delegate.post(url, postContent, postContentType);
    }

    @Override
    public HTTPResponse post(URL url, InputStream postContent, String postContentType,
                              Map<String, String> headers) throws IOException {
        return delegate.post(url, postContent, postContentType, headers);
    }

    // ── URL rewriting ──────────────────────────────────────────────────

    private URL maybeInjectTime(URL url) {
        String currentTime = CascadeTimeContext.get();
        if (currentTime == null || currentTime.isEmpty()) {
            return url;
        }
        if (url == null) {
            return null;
        }
        String query = url.getQuery();
        if (query == null || query.isEmpty()) {
            return url;
        }
        // Check that c'est bien WMS GetMap (sinon on ne touche pas)
        Map<String, String> params = parseQuery(query);
        String service = caseInsensitiveGet(params, "service");
        String request = caseInsensitiveGet(params, "request");
        if (!"WMS".equalsIgnoreCase(service) || !"GetMap".equalsIgnoreCase(request)) {
            return url;
        }
        // Remplace ou ajoute TIME
        removeKeyCaseInsensitive(params, "time");
        params.put("TIME", currentTime);
        try {
            String newQuery = buildQuery(params);
            URL rewritten = new URL(url.getProtocol(), url.getHost(), url.getPort(),
                url.getPath() + "?" + newQuery);
            // G65c (2026-05-26) — log INFO temporairement (au lieu de FINE)
            // pour debug "3 TIMEs identiques en sortie" malgré 4 distincts
            // upstream direct. Une fois validé, repassera en FINE.
            LOG.info("CascadeTimeForwardingHTTPClient: injected TIME="
                + currentTime + " into " + url.getHost() + url.getPath());
            return rewritten;
        } catch (MalformedURLException e) {
            LOG.warning("CascadeTimeForwardingHTTPClient: URL rewrite failed for "
                + url + " : " + e.getMessage());
            return url;
        }
    }

    private static Map<String, String> parseQuery(String query) {
        // LinkedHashMap pour préserver l'ordre des params dans l'URL ré-écrite
        // (debug-friendly et compatible si certains serveurs sont order-sensitive)
        Map<String, String> map = new LinkedHashMap<>();
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = eq < 0 ? pair : pair.substring(0, eq);
            String v = eq < 0 ? "" : pair.substring(eq + 1);
            try {
                map.put(URLDecoder.decode(k, StandardCharsets.UTF_8),
                        URLDecoder.decode(v, StandardCharsets.UTF_8));
            } catch (Exception e) {
                map.put(k, v); // tolérant
            }
        }
        return map;
    }

    private static String buildQuery(Map<String, String> params) {
        List<String> pairs = new ArrayList<>(params.size());
        for (Map.Entry<String, String> e : params.entrySet()) {
            pairs.add(URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8)
                + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8));
        }
        return String.join("&", pairs);
    }

    private static String caseInsensitiveGet(Map<String, String> m, String key) {
        for (Map.Entry<String, String> e : m.entrySet()) {
            if (key.equalsIgnoreCase(e.getKey())) {
                return e.getValue();
            }
        }
        return null;
    }

    private static void removeKeyCaseInsensitive(Map<String, String> m, String key) {
        m.entrySet().removeIf(e -> key.equalsIgnoreCase(e.getKey()));
    }

    // ── Passthrough HTTPClient API ─────────────────────────────────────

    @Override public String getUser() { return delegate.getUser(); }
    @Override public void setUser(String user) { delegate.setUser(user); }
    @Override public String getPassword() { return delegate.getPassword(); }
    @Override public void setPassword(String password) { delegate.setPassword(password); }
    @Override public Map<String, String> getExtraParams() {
        return delegate.getExtraParams();
    }
    @Override public void setExtraParams(Map<String, String> extraParams) {
        delegate.setExtraParams(extraParams);
    }
    @Override public int getConnectTimeout() { return delegate.getConnectTimeout(); }
    @Override public void setConnectTimeout(int connectTimeout) {
        delegate.setConnectTimeout(connectTimeout);
    }
    @Override public int getReadTimeout() { return delegate.getReadTimeout(); }
    @Override public void setReadTimeout(int readTimeout) {
        delegate.setReadTimeout(readTimeout);
    }
    @Override public void setTryGzip(boolean tryGZIP) { delegate.setTryGzip(tryGZIP); }
    @Override public boolean isTryGzip() { return delegate.isTryGzip(); }
}
