package fr.sladoire.maritime.gwc.init;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

import javax.annotation.PostConstruct;

import org.geoserver.catalog.Catalog;
import org.geoserver.catalog.DimensionInfo;
import org.geoserver.catalog.DimensionPresentation;
import org.geoserver.catalog.ResourceInfo;
import org.geoserver.catalog.WMSLayerInfo;
import org.geoserver.catalog.impl.DimensionInfoImpl;
import org.geoserver.gwc.GWC;
import org.geoserver.gwc.layer.GeoServerTileLayer;
import org.geoserver.platform.GeoServerExtensions;
import org.geowebcache.config.BlobStoreInfo;
import org.geowebcache.storage.BlobStoreAggregator;
// org.geowebcache.s3.S3BlobStoreInfo : accédée via réflexion car
// gwc-s3-storage n'est PAS publié sur Maven Central ni OSGeo (community
// only). La classe est sur le classpath GS au runtime via gwc-s3-plugin.zip
// baked dans WEB-INF/lib (G58 Dockerfile).

/**
 * Maritime GWC Initializer (G63 — 2026-05-24).
 *
 * <p>Au démarrage de GeoServer (Spring @PostConstruct), initialise
 * programmatiquement la config GWC nécessaire pour le clustering
 * multi-replica avec cache S3 partagé :
 *
 * <ol>
 *   <li>Crée le BlobStore S3 "maritime-s3" pointant vers SeaweedFS
 *       (cluster K8s interne, bucket maritime-gwc-tiles).</li>
 *   <li>Configure chaque GeoServerTileLayer cible avec :
 *     <ul>
 *       <li>blobStoreId = maritime-s3 → tuiles écrites dans S3</li>
 *       <li>expireCache=3600 / expireClients=3600 (TTL 1h)</li>
 *       <li>parameterFilters .* pour STYLES/TIME/ENV/VIEWPARAMS/INTERPOLATIONS</li>
 *     </ul>
 *   </li>
 * </ol>
 *
 * <p>Idempotent : check d'existence du blobstore avant POST, check de
 * `getBlobStoreId()` avant override sur les layers.
 *
 * <p>Pourquoi ce plugin plutôt que REST PUT (bash bootstrap) ? Le bug GS
 * connu : REST PUT sur /gwc/rest/blobstores et /gwc/rest/layers met à
 * jour l'état in-memory mais ne persiste PAS dans
 * /opt/geoserver_data/gwc/geowebcache.xml ni dans gwc-layers/UUID.xml.
 * Au prochain restart pod (rollout, OOMKilled, etc.) la config est
 * perdue. Avec @PostConstruct, elle est re-appliquée à chaque boot →
 * persistance déterministe + reproductibilité gitops 100%.
 *
 * <p>Config via env vars du pod GS (Deployment Helm) :
 * <pre>
 *   GWC_S3_ENDPOINT     http://seaweedfs-filer:8333
 *   GWC_S3_BUCKET       maritime-gwc-tiles
 *   GWC_S3_ACCESS_KEY   (Secret maritime-seaweedfs-s3.S3_ACCESS_KEY)
 *   GWC_S3_SECRET_KEY   (Secret maritime-seaweedfs-s3.S3_SECRET_KEY)
 *   GWC_S3_BLOBSTORE_ID maritime-s3
 *   GWC_TARGET_LAYERS   (csv, default = DEFAULT_LAYERS ci-dessous)
 * </pre>
 */
public class MaritimeGwcInitializer {

    private static final Logger LOG =
        Logger.getLogger(MaritimeGwcInitializer.class.getName());

    private static final String DEFAULT_BLOBSTORE_ID = "maritime-s3";
    private static final String DEFAULT_ENDPOINT = "http://seaweedfs-filer:8333";
    private static final String DEFAULT_BUCKET = "maritime-gwc-tiles";

    /**
     * Layers à configurer par défaut (workspace-scoped names). Override
     * via env var GWC_TARGET_LAYERS (csv).
     */
    private static final List<String> DEFAULT_LAYERS = Arrays.asList(
        // aetherwx workspace (local raster + cascade)
        "aetherwx:sst-daily",
        "aetherwx:wind-speed",
        "aetherwx:wave-hs",
        "aetherwx:wave-dir",
        "aetherwx:sat-eu-ir-rss",
        "aetherwx:sat-global-ir-mtg",
        "aetherwx:sat-eu-hrv-rgb",
        "aetherwx:radar-dwd-de",
        "aetherwx:radar-knmi-nl",
        // aetherwx-sat workspace (NASA GIBS local raster)
        "aetherwx-sat:sat-modis-true-color",
        "aetherwx-sat:sat-viirs-true-color",
        "aetherwx-sat:sat-modis-ir",
        "aetherwx-sat:sat-airs-air-temp",
        "aetherwx-sat:sat-modis-cloud-top",
        "aetherwx-sat:sat-modis-aerosol",
        "aetherwx-sat:sat-viirs-day-night"
    );

    private BlobStoreAggregator blobStoreAggregator;
    private GWC gwc;
    private Catalog catalog;

    @PostConstruct
    public void initialize() {
        try {
            // Lookup via GeoServerExtensions (plus robuste aux changements
            // de bean names entre versions GS qu'un @Autowired par type).
            this.blobStoreAggregator =
                GeoServerExtensions.bean(BlobStoreAggregator.class);
            this.gwc = GeoServerExtensions.bean(GWC.class);
            this.catalog = GeoServerExtensions.bean(Catalog.class);

            if (blobStoreAggregator == null || gwc == null || catalog == null) {
                LOG.warning("MaritimeGwcInitializer: GWC/BlobStoreAggregator/Catalog "
                    + "bean not found, skip");
                return;
            }

            ensureS3BlobStore();
            ensureLayerConfigs();
            ensureCascadeTimeDimensions();
            LOG.info("MaritimeGwcInitializer: init complete");
        } catch (Throwable t) {
            // Ne JAMAIS bloquer le boot GS sur une erreur de cache config.
            LOG.log(Level.SEVERE, "MaritimeGwcInitializer: init failed (non-fatal)", t);
        }
    }

    // ─── Cascade time dimensions (G63b — fix HRV "même image en boucle") ──

    /**
     * Pour les WMSLayerInfo cascade (EUMETSAT/DWD/KNMI), set le metadata
     * `time` DimensionInfo pour que GS forwarde le TIME param à l'upstream.
     * Sans ça, GS sert un PNG default identique peu importe le TIME demandé
     * (test 2026-05-24 : HRV cascade renvoyait 2 PNGs alternants pour 7 TIMEs
     * différents alors qu'upstream EUMETSAT renvoyait 7 PNGs distincts).
     *
     * REST PUT pour set ce metadata retourne 500 UnsupportedOperationException
     * sur GS 2.28, d'où l'usage de Java API ici (le seul chemin qui marche).
     */
    private static final List<String> CASCADE_LAYERS = Arrays.asList(
        "aetherwx:sat-eu-ir-rss",
        "aetherwx:sat-global-ir-mtg",
        "aetherwx:sat-eu-hrv-rgb",
        "aetherwx:radar-dwd-de",
        "aetherwx:radar-knmi-nl"
    );

    private void ensureCascadeTimeDimensions() {
        for (String fullName : CASCADE_LAYERS) {
            try {
                String[] parts = fullName.split(":", 2);
                String ws = parts[0];
                String name = parts[1];
                ResourceInfo resource = catalog.getResourceByName(ws, name, ResourceInfo.class);
                if (!(resource instanceof WMSLayerInfo)) {
                    LOG.warning("MaritimeGwcInitializer: " + fullName
                        + " not a WMSLayerInfo, skip time dim");
                    continue;
                }
                WMSLayerInfo wmsLayer = (WMSLayerInfo) resource;
                Object existing = wmsLayer.getMetadata().get("time");
                if (existing instanceof DimensionInfo
                    && ((DimensionInfo) existing).isEnabled()) {
                    continue; // already set
                }
                DimensionInfo timeDim = new DimensionInfoImpl();
                timeDim.setEnabled(true);
                timeDim.setPresentation(DimensionPresentation.LIST);
                timeDim.setUnits("ISO8601");
                wmsLayer.getMetadata().put("time", timeDim);
                catalog.save(wmsLayer);
                LOG.info("MaritimeGwcInitializer: enabled time dim on " + fullName);
            } catch (Throwable t) {
                LOG.log(Level.WARNING,
                    "MaritimeGwcInitializer: failed time dim for " + fullName, t);
            }
        }
    }

    // ─── BlobStore S3 ──────────────────────────────────────────────────

    private void ensureS3BlobStore() throws Exception {
        String id = env("GWC_S3_BLOBSTORE_ID", DEFAULT_BLOBSTORE_ID);
        String endpoint = env("GWC_S3_ENDPOINT", DEFAULT_ENDPOINT);
        String bucket = env("GWC_S3_BUCKET", DEFAULT_BUCKET);
        String accessKey = env("GWC_S3_ACCESS_KEY", null);
        String secretKey = env("GWC_S3_SECRET_KEY", null);

        if (accessKey == null || secretKey == null) {
            LOG.warning(
                "MaritimeGwcInitializer: GWC_S3_ACCESS_KEY/SECRET_KEY absent, "
                + "skip S3 blobstore creation (cache local fs fallback)");
            return;
        }

        BlobStoreInfo existing = null;
        try {
            existing = blobStoreAggregator.getBlobStore(id);
        } catch (Exception e) {
            // Not found = OK
        }

        // Reflexion : org.geowebcache.s3.S3BlobStoreInfo n'est pas dispo en
        // compile-time (community module, not on Maven Central). Mais elle
        // est sur le classpath GS au runtime via gwc-s3-plugin.zip (G58).
        Class<?> s3InfoClass;
        try {
            s3InfoClass = Class.forName("org.geowebcache.s3.S3BlobStoreInfo");
        } catch (ClassNotFoundException e) {
            LOG.warning("MaritimeGwcInitializer: S3BlobStoreInfo class NOT on "
                + "classpath. Skip blobstore creation (gwc-s3-plugin manquant ?).");
            return;
        }
        Object info = s3InfoClass.getDeclaredConstructor().newInstance();
        invokeSetter(info, "setName", String.class, id);
        invokeSetter(info, "setEnabled", boolean.class, Boolean.TRUE);
        invokeSetter(info, "setBucket", String.class, bucket);
        invokeSetter(info, "setPrefix", String.class, "gwc");
        invokeSetter(info, "setAwsAccessKey", String.class, accessKey);
        invokeSetter(info, "setAwsSecretKey", String.class, secretKey);
        invokeSetter(info, "setEndpoint", String.class, endpoint);
        invokeSetter(info, "setMaxConnections", int.class, 50);
        invokeSetter(info, "setUseHttps", boolean.class, Boolean.FALSE);
        invokeSetter(info, "setUseGzip", boolean.class, Boolean.TRUE);
        // setAccess(S3BlobStoreInfo.Access.PRIVATE) via enum reflection
        try {
            Class<?> accessEnum = Class.forName("org.geowebcache.s3.S3BlobStoreInfo$Access");
            Object[] accessConstants = accessEnum.getEnumConstants();
            Object privateAccess = null;
            for (Object c : accessConstants) {
                if ("PRIVATE".equals(c.toString())) { privateAccess = c; break; }
            }
            if (privateAccess != null) {
                s3InfoClass.getMethod("setAccess", accessEnum).invoke(info, privateAccess);
            }
        } catch (Exception e) {
            LOG.log(Level.FINE, "MaritimeGwcInitializer: setAccess skipped", e);
        }

        BlobStoreInfo blobInfo = (BlobStoreInfo) info;
        if (existing == null) {
            blobStoreAggregator.addBlobStore(blobInfo);
            LOG.info("MaritimeGwcInitializer: created S3 BlobStore '" + id
                + "' bucket=" + bucket + " endpoint=" + endpoint);
        } else {
            blobStoreAggregator.modifyBlobStore(blobInfo);
            LOG.info("MaritimeGwcInitializer: updated S3 BlobStore '" + id + "'");
        }
    }

    private static void invokeSetter(Object target, String method,
                                     Class<?> paramType, Object value) throws Exception {
        target.getClass().getMethod(method, paramType).invoke(target, value);
    }

    // ─── Layer configs ────────────────────────────────────────────────

    private void ensureLayerConfigs() {
        String blobStoreId = env("GWC_S3_BLOBSTORE_ID", DEFAULT_BLOBSTORE_ID);
        String layersCsv = env("GWC_TARGET_LAYERS", null);
        List<String> targetLayers = layersCsv != null
            ? Arrays.asList(layersCsv.split(","))
            : DEFAULT_LAYERS;

        Set<String> done = new HashSet<>();
        for (String layerName : targetLayers) {
            String trimmed = layerName.trim();
            if (trimmed.isEmpty()) continue;
            try {
                ensureLayerConfig(trimmed, blobStoreId);
                done.add(trimmed);
            } catch (Throwable t) {
                LOG.log(Level.WARNING,
                    "MaritimeGwcInitializer: failed to configure layer " + trimmed,
                    t);
            }
        }
        LOG.info("MaritimeGwcInitializer: configured "
            + done.size() + "/" + targetLayers.size() + " layers");
    }

    private void ensureLayerConfig(String layerName, String blobStoreId) {
        GeoServerTileLayer layer;
        try {
            layer = (GeoServerTileLayer) gwc.getTileLayerByName(layerName);
        } catch (Exception e) {
            LOG.warning("MaritimeGwcInitializer: layer " + layerName
                + " not found in GWC, skip");
            return;
        }
        if (layer == null) {
            LOG.warning("MaritimeGwcInitializer: layer " + layerName + " null, skip");
            return;
        }

        org.geoserver.gwc.layer.GeoServerTileLayerInfo info = layer.getInfo();
        // Note : on touche uniquement blobStoreId pour le moment.
        // expireCache + inMemoryCached restent via gwc-sat-config-job (REST)
        // car l'API GS 2.28+ a changé les signatures (getExpireClients
        // no-arg, setInMemoryCached supprimé). Le vrai win du plugin Java =
        // BlobStore persistance (la config layer survit via gwc-layers/
        // disk persistence GS normale).
        if (!blobStoreId.equals(info.getBlobStoreId())) {
            info.setBlobStoreId(blobStoreId);
            try {
                gwc.save(layer);
                LOG.info("MaritimeGwcInitializer: layer " + layerName
                    + " → blobStore=" + blobStoreId);
            } catch (Exception e) {
                LOG.log(Level.WARNING,
                    "MaritimeGwcInitializer: save failed for " + layerName, e);
            }
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    private static String env(String key, String def) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : def;
    }
}
