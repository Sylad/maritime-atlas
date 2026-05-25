package fr.sladoire.maritime.gwc.init;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.geoserver.catalog.Catalog;
import org.geoserver.gwc.GWC;
import org.geoserver.gwc.layer.GeoServerTileLayer;
import org.geoserver.platform.GeoServerExtensions;
import org.geowebcache.config.BlobStoreInfo;
import org.geowebcache.storage.BlobStoreAggregator;
import org.springframework.context.ApplicationListener;
import org.springframework.context.event.ContextRefreshedEvent;
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
public class MaritimeGwcInitializer
        implements ApplicationListener<ContextRefreshedEvent> {

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

    /** Garde anti-double exécution : ContextRefreshedEvent peut fire 2x
     *  (root context puis child context). On ne veut init qu'une fois. */
    private volatile boolean initialized = false;

    /**
     * G64b (2026-05-25) — refactored from @PostConstruct to
     * ApplicationListener<ContextRefreshedEvent>.
     *
     * Raison : @PostConstruct fire durant la phase critique de bean init,
     * avant que JDBCResourceStore/Hazelcast soient complètement up. Nos
     * 16 gwc.save() + 5 catalog.save() bloquaient sur publish Hazelcast
     * (cluster not initialized yet) → boot path stretched > 11min startup
     * probe budget → pod killed.
     *
     * ContextRefreshedEvent fire APRÈS que tout le Spring root context
     * soit ready (incluant Hazelcast cluster joined + JDBCResourceStore
     * ready). Init devient non-bloquante pour le boot path critique.
     *
     * Cascade time dimensions setup REMOVED (G63b experiment) : confirmé
     * inopérant car bug fondamental = GeoTools WMSCoverageReader/WMSLayer
     * ne forward PAS le param TIME upstream (0 occurrence de "time" dans
     * tout le source gt-wms). Le vrai fix sera G65 (custom HTTPClient SPI
     * factory + DispatcherCallback ThreadLocal).
     */
    @Override
    public void onApplicationEvent(ContextRefreshedEvent event) {
        if (initialized) {
            return; // déjà run sur le root context
        }
        initialized = true;
        try {
            // Lookup via GeoServerExtensions (plus robuste aux changements
            // de bean names entre versions GS qu'un @Autowired par type).
            //
            // Pour Catalog : lookup par NOM ("catalog") car GS expose
            // PLUSIEURS beans Catalog (catalog primaire, rawCatalog,
            // secureCatalog, advertisedCatalog, etc.) → MultipleBeansException
            // si lookup par type. Le bean "catalog" est l'instance primaire
            // qui propage les events au cluster Hazelcast.
            this.blobStoreAggregator =
                GeoServerExtensions.bean(BlobStoreAggregator.class);
            this.gwc = GeoServerExtensions.bean(GWC.class);
            this.catalog = (Catalog) GeoServerExtensions.bean("catalog");

            if (blobStoreAggregator == null || gwc == null || catalog == null) {
                LOG.warning("MaritimeGwcInitializer: GWC/BlobStoreAggregator/Catalog "
                    + "bean not found, skip");
                return;
            }

            ensureS3BlobStore();
            ensureLayerConfigs();
            LOG.info("MaritimeGwcInitializer: init complete (post-boot async)");
        } catch (Throwable t) {
            // Ne JAMAIS bloquer le boot GS sur une erreur de cache config.
            LOG.log(Level.SEVERE, "MaritimeGwcInitializer: init failed (non-fatal)", t);
        }
    }

    // G63b ensureCascadeTimeDimensions() REMOVED (2026-05-25).
    //
    // Le set metadata.time sur WMSLayerInfo cascade n'a AUCUN effet sur le
    // forward de TIME upstream. Cause racine confirmée par lecture de
    // gt-wms 34.x : `WMSCoverageReader.java` (538 lignes) + `WMSLayer.java`
    // (215 lignes) ont 0 occurrence de "time" / "TIME" (case-insensitive).
    // `WMSCoverageReader.read(GeneralParameterValue...)` ne lit QUE
    // `READ_GRIDGEOMETRY2D` et `BACKGROUND_COLOR` parmi les params, et
    // `initMapRequest()` ne forward que `Layer.getVendorParameters()` via
    // `setVendorSpecificParameter` — TIME n'est ni un vendor param ni
    // pris en compte par le code path cascade par design.
    //
    // Le vrai fix → G65 plugin séparé `maritime-cascade-time-forward` :
    // custom GeoTools HTTPClientFactory (SPI registered in META-INF/
    // services/org.geotools.http.HTTPClientFactory) qui intercepte les
    // URLs GetMap upstream + ré-écrit en injectant TIME depuis un
    // ThreadLocal alimenté par un Spring DispatcherCallback côté GS.

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
