# Roadmap migration K8s — préprod + prod publique

**Statut** : Plan validé 2026-05-13 — pas encore démarré
**Driver** : Site doit rester accessible pendant la recherche d'emploi
**Bonus** : Stack vendable sur CV (K8s + GitOps + operators)

---

## Pourquoi

L'incident du 2026-05-13 (coupure secteur → 6h+ de Btrfs scrub → cascade
crashloop GeoServer/frontend) montre que **le NAS Synology est un SPoF**
pour la visibilité publique. Pour une recherche d'emploi, on ne peut pas
se permettre qu'un recruteur clique et tombe sur un 502.

**Diagnostic technique** révélé pendant l'incident : Postgres, GeoServer,
RabbitMQ, ais-decoder et 10 autres services partagent **le même volume
Btrfs unique** sur le NAS. Quand l'ais-decoder pompe 430 msg/s avec
WAL flush concurrent, la file d'attente disque déborde et **les autres
services en pâtissent en cascade** — GeoServer ne peut pas se connecter
à Postgres parce que PG est lui-même bloqué sur `LWLock WALWrite`. Sur
K8s avec CloudNativePG, chaque DB obtient son **PVC SSD dédié** avec son
propre IOPS budget, et l'isolation namespace + resource limits cappent
l'I/O d'un service downstream avant qu'il ne sature ses voisins.

K8s plutôt que Swarm parce que :

- 2026 : K8s = lingua franca chez 95% des boîtes (EKS, GKE, AKS, OpenShift,
  Rancher, k3s, Kapsule). Swarm = niche.
- Sylvain le subit déjà au taff → courbe d'apprentissage gérable.
- Permet d'empiler des skills "cloud-native" vendables (Helm, ArgoCD,
  operators, KEDA, cert-manager, observability).

---

## Architecture cible — local-first, cloud en phase 2

Décision 2026-05-13 (post-incident) : **commencer par un cluster k3s local
sur Big-Blue (poste de dev WSL2)**. Le cluster Scaleway managé devient une
phase 2 quand tout sera stable en local.

Rationale :
- **Coût initial = €0**. On valide toute l'archi avant de payer.
- **Iteration boucle = secondes** (kubectl apply local) vs minutes (cloud).
- **Workflow vendable** : la combo "k3s local + cloud K8s + GitOps" est
  exactement ce qu'utilisent les équipes Platform Engineering en boîte.
- **Hardware** : Big-Blue = i9-14900KF, 31 GiB RAM, ext4 natif WSL2 → bien
  plus capable que le NAS Synology pour cette charge.

```
                 ┌────────────────────────────────────────────────┐
                 │          Cloudflare (DNS + CDN + WAF)          │
                 │     ↳ frontends statiques Astro (eywa,         │
                 │       evatosorus) — gratis, déjà en place      │
                 │     ↳ phase 2 : frontends dynamiques publiés   │
                 │       via tunnel (cloudflared) vers cluster    │
                 └────────────────────┬───────────────────────────┘
                                      │
                  Phase 1 (local) : *.dev.local via /etc/hosts
                  Phase 2 (cloud) : DNS public → IP LB Scaleway
                                      │
       ┌──────────────────────────────▼──────────────────────────────┐
       │  Phase 1 — k3s sur Big-Blue WSL2 (preprod/dev en local)     │
       │   ┌────────────────────────────────────────────────────┐   │
       │   │  namespace: preprod                                │   │
       │   │   ├─ maritime stack (replicas=1, mini-data ~50 MB) │   │
       │   │   ├─ finance / warhammer / ol                      │   │
       │   │   └─ infra : cnpg, rmq operator, cert-manager,     │   │
       │   │      ingress-nginx, keda, argocd, kube-prometheus  │   │
       │   └────────────────────────────────────────────────────┘   │
       │  Cluster sur ext4 natif WSL2 ; archives sur /mnt/e          │
       └─────────────────────────────────────────────────────────────┘

       ┌─────────────────────────────────────────────────────────────┐
       │  Phase 2 — Scaleway Kapsule (prod publique, plus tard)      │
       │   namespace: prod (replicas≥1, live data, exposé internet)  │
       │   Coût : ~€47/mo                                            │
       └─────────────────────────────────────────────────────────────┘

       ┌─────────────────────────────────────────────────────────────┐
       │      NAS Synology (rôle réduit : edge data collector)        │
       │   ├─ ais-ingester (client aisstream.io)                      │
       │   ├─ buoy/lightning/sst fetchers (cron data acquisition)     │
       │   └─ Storage froid backups long-terme                        │
       │   → push vers RabbitMQ cluster (local ou cloud) via TLS      │
       └─────────────────────────────────────────────────────────────┘
```

**Note clé** : le NAS ne disparaît pas. Il devient un **edge collector**
qui pousse les données vers RabbitMQ dans le cluster via TLS sortant.
Pattern reconnu (IoT edge / hybrid cloud) → également vendable sur CV.

---

## Disk budget + tiered storage Big-Blue

Big-Blue a 3 zones de stockage utilisables, avec des perfs très différentes :

| Zone | Capacité libre | Filesystem | Fsync latency | Usage |
|---|---|---|---|---|
| `/` (rootfs WSL2) | 936 GB | ext4 natif | ~0.5 ms | **Cluster + PVC hot** |
| `/mnt/e` | 5.2 TB | 9P proxy WSL→Windows | 5-50 ms (10-100× pire) | **Archives + backups froids** |
| `/mnt/d` | 2.0 TB | 9P | idem | Réserve |
| `/mnt/f` | 867 GB | 9P | idem | Réserve |

**Règle absolue** : **jamais de PVC stateful sur `/mnt/*`** — sinon on
retombe dans le même piège fsync qu'avec Btrfs sur le NAS.

### Budget cap `/` ≤ ~180 GB

| Poste | Estimation |
|---|---|
| k3s + containerd image cache | ~10 GB |
| Containers running (PG, RMQ, GS, maritime stack) | ~5 GB |
| Postgres data live (~30j hot, hypertable chunks récentes) | ~30-50 GB |
| RabbitMQ + queues | ~2 GB |
| GeoServer data + coverages chaudes | ~10 GB |
| Observability (Prom retention 7j, Grafana, Loki) | ~20 GB |
| App volumes (finance, war, ol uploads) | ~5 GB |
| Buffer croissance | ~80 GB |
| **Total cap** | **~180 GB** |

### Garde-fous

- **2 StorageClass** :
  - `local-path-hot` → provisioner sur `/var/lib/rancher/k3s/storage` (= `/`)
  - `local-path-cold` → provisioner sur `/mnt/e/k3s-cold` (pour backups +
    hypertables > 30j via Timescale `move_chunk` / tablespace)
- **Tous les `PersistentVolumeClaim` ont `spec.resources.requests.storage`
  bornés**. Pas d'illimité.
- **Prometheus alert** : `node_filesystem_avail_bytes / size < 20%` →
  notif Telegram ou Discord webhook.
- **CronJob nightly** : purge `containerd` images dead (`crictl rmi --prune`)
  + retention logs Loki + vacuum PG.
- **CNPG backups** : pgBackRest target `/mnt/e/cnpg-backups` (séquentiel,
  pas critique fsync).

### Stratégie hypertables Timescale (long terme)

Quand `pg-data` dépasse ~50 GB sur `/`, activer la stratégie de tiering :
- Chunks récents (≤30j) sur `local-path-hot` (PVC sur `/`)
- Chunks > 30j déplacés vers un tablespace sur `local-path-cold` (PVC
  sur `/mnt/e`) via `SELECT move_chunk(...)`
- Permet de stocker plusieurs TB d'historique AIS sans saturer `/`.

---

## Provider cloud (phase 2) — Scaleway Kapsule

| Critère | Scaleway Kapsule | OVH MKS | DigitalOcean | Hetzner |
|---|---|---|---|---|
| Control plane | **Gratuit** | Gratuit | $12/mo | Pas de managé |
| 4 vCPU / 8 GB worker | ~€18-22/mo | ~€25/mo | ~€48/mo | ~€10/mo (mais self-hosted k3s) |
| Région EU FR | ✅ Paris/Amsterdam | ✅ GRA/RBX/SBG | NL/DE | DE/FI |
| Container Registry inclus | ✅ Gratuit jusqu'à 75 GB | Payant | $5/mo | Hub Docker |
| Object Storage S3 | ✅ €0.012/GB/mo | €0.01/GB/mo | $5/250GB | €4.99/TB |
| LB public | ~€8/mo | ~€11/mo | $12/mo | €5/mo |
| Maturité 2026 | Stable, kubectl natif | Stable | Stable | Récent |

**Choix** : Scaleway Kapsule. Combo le moins cher EU avec un control plane
managé GRATUIT, container registry inclus, et un panel simple. Budget total
**~€40-60/mois** all-in (2 nodes + LB + storage).

Alternative budget : OVH MKS (~€30-45/mo, mais panel moins sympa).

---

## Skills vendables empilés

Liste à ressortir dans le CV / LinkedIn une fois la migration faite :

- **Kubernetes** : kubectl, manifests, RBAC, NetworkPolicy, Pod Disruption Budget
- **Helm** : charts persos, templating, hooks `pre-install`/`post-upgrade`
- **ArgoCD** : GitOps, app-of-apps pattern, sync waves, automated rollback
- **CloudNativePG** (operator PostgreSQL) : HA, streaming replication, backups S3
- **RabbitMQ Cluster Operator** : 3-node quorum, federation
- **KEDA** (Kubernetes Event-driven Autoscaling) : scale par queue depth RMQ
  — remplace notre autoscaler maison Swarm
- **cert-manager** + Let's Encrypt DNS-01 via Cloudflare API
- **ingress-nginx** + sticky sessions (pour GeoServer cluster)
- **sealed-secrets** (Bitnami) : secrets chiffrés en clair dans Git
- **Prometheus + Grafana + Loki** : observability stack complète
- **Scaleway Kapsule** : managed K8s cloud-native
- **GitHub Actions** : CI build image → push registry Scaleway → bump manifest GitOps
- **Hybrid edge** : NAS edge collector + cloud cluster ingestion (pattern IoT)

---

## Phases — 7 sprints (~weekends)

### Sprint 0 — Bootstrap cluster local Big-Blue (1 weekend)

Provision + plomberie d'un cluster k3s sur Big-Blue WSL2, sans aucune app encore.

- [ ] Install **k3s** single-node via `curl -sfL https://get.k3s.io | sh -`
      (option : `--disable traefik` si on veut ingress-nginx pour iso prod)
- [ ] kubeconfig copié dans `~/.kube/config` + `kubectl` testé
- [ ] Création namespaces `preprod` + `argocd` + `infra`
- [ ] Création **StorageClass `local-path-hot`** (sur `/`) + **`local-path-cold`**
      (sur `/mnt/e/k3s-cold`) avec rancher local-path-provisioner customisé
- [ ] Install **ingress-nginx** via Helm + port-forward 80/443 vers WSL2
- [ ] Install **cert-manager** + ClusterIssuer self-signed (local) ou
      `mkcert` CA installé dans Big-Blue pour `*.dev.local`
- [ ] Install **ArgoCD** + accès UI via Ingress local
- [ ] Install **sealed-secrets** controller
- [ ] `/etc/hosts` : `127.0.0.1 ol.dev.local maritime.dev.local finance.dev.local
      warhammer.dev.local argocd.dev.local`
- [ ] Création repo Git séparé `developpeur-gitops` (les manifests générés)
- [ ] **Prometheus alert disk usage** sur node WSL2

**Livrables** : `kubectl get pods -A` montre tous les controllers verts, UI
ArgoCD accessible sur `https://argocd.dev.local`, première app de test (whoami)
déployable via Helm chart.

**Phase 2 (plus tard, quand stable)** : Bootstrap Scaleway Kapsule en namespace
`prod`, sync ArgoCD app-of-apps cross-cluster, DNS public Cloudflare.

### Sprint 1 — ol-companion (1 weekend)

L'app la plus simple — full GitOps loop validée sur un cas trivial.

- [ ] Helm chart `ol-companion` (Deployment backend + frontend + ConfigMap +
      Secret sealed + Ingress + Service)
- [ ] CI GitHub Actions : `docker build` → push registry Scaleway → bump
      `image.tag` dans le repo gitops
- [ ] ArgoCD application `ol-companion-preprod` + `ol-companion-prod` avec
      values overlays
- [ ] DNS `ol.preprod.sylad.dev` + `ol.sylad.dev` + cert-manager
- [ ] Migration des fixtures JSON → ConfigMap (ou PVC RWO si on garde le cache)
- [ ] Cutover : redirect 301 depuis `nas:4202` (ou laisser les 2 cohabiter)
- [ ] Smoke test : Playwright contre `ol.sylad.dev`

**Pattern Helm chart** réutilisé pour les autres NestJS.

### Sprint 2 — finance + warhammer (1 weekend)

Quasi copies du chart ol-companion. Différences :

- Finance : PIN guard + upload PDF (multipart) + PVC `/app/data` RWO
- Warhammer : volume RWO + images RX (lecture seule depuis bucket S3
  Scaleway plutôt que `/volume2/photo/Jeux/Warhammer 40K`)

- [ ] Adapter `templates/` du chart générique pour ces 2 apps
- [ ] Sync images Warhammer NAS → bucket S3 Scaleway (script one-shot rclone)
- [ ] Migration fichiers `data/finance/*.json` → PVC + restore depuis NAS
- [ ] DNS + certs
- [ ] Smoke tests

### Sprint 3 — Maritime services stateless (1 weekend)

Les 8 services maritime qui n'ont pas d'état persistant local :

- api, ais-decoder, alerts-engine, weather-fetcher (×3 GFS/AROME/ARPEGE),
  buoy-fetcher, lightning-fetcher, sst-fetcher, track-builder, grib-parser,
  geoserver-provisioner

- [ ] Helm chart umbrella `maritime-services`
- [ ] Remplacer notre autoscaler dockerode custom par **KEDA** + scaler
      `rabbitmq-queue` (validation : drain ais.decoder reproduit la même
      logique scale 1→3 selon depth)
- [ ] Service `ais-decoder` : 3 replicas, KEDA scale jusqu'à 5 si depth > 1000
- [ ] HorizontalPodAutoscaler standard pour api (CPU > 70%)
- [ ] PVC pour buoy/lightning fetchers caches → S3 Scaleway via `s3fs` ou
      remplacement par appel S3 direct dans le code
- [ ] AIS ingester reste sur le NAS → publish vers `rabbitmq.maritime.svc`
      via TLS sortant + auth basique

### Sprint 4 — Maritime stateful (PG + Rabbit) (1 weekend)

**Pattern dual-DB** : 2 clusters Postgres distincts pour isoler les workloads
incompatibles (leçon de l'incident 2026-05-13 où l'INSERT massif sur
`vessels` saturait le WAL et empêchait GeoServer de lire 175 rows de
catalog).

| Cluster CNPG | Usage | Taille | Replicas | Storage class |
|---|---|---|---|---|
| `pg-catalog` | GeoServer JDBCConfig + sessions Tomcat | ~10 MB | 1 (single-instance suffit) | sbs-default (SSD) |
| `pg-data` | Hypertables Timescale (vessels, positions, lightning, earthquakes, hubeau, observations…) | 5-20 GB | 3 streaming replication | sbs-5k (NVMe IOPS premium) |

Chaque cluster a son propre WAL, ses propres backups, son propre scaling.
L'INSERT massif sur `pg-data` ne touche plus jamais `pg-catalog` → boot
GeoServer immuable même sous charge.

- [ ] **CloudNativePG operator** déployé via Helm
- [ ] Cluster `pg-catalog` : 1 instance, 1 GB PVC, dans namespace `prod`/`preprod`
- [ ] Cluster `pg-data` : 3 instances (prod) / 1 (preprod) avec streaming
      replication, 30 GB PVC NVMe, extension Timescale activée
- [ ] Code maritime : 2 vars d'env distinctes `DATABASE_CATALOG_URL` (GeoServer
      JDBCConfig) + `DATABASE_DATA_URL` (tous les services métier api/decoder/etc.)
- [ ] Migration data PG actuel → 2 cibles :
      - Tables `geoserver.*` (175 rows) → `pg-catalog`
      - Schéma `public.*` (hypertables) → `pg-data` via `timescaledb-backup`
        ou `pg_dump --schema=public` + `restore_timescaledb_data`
- [ ] Backups S3 Scaleway via pgBackRest (CNPG natif), WAL streaming continu
- [ ] **RabbitMQ Cluster Operator** + cluster 3-quorum (prod), 1-instance (preprod)
- [ ] Restore des bindings/exchanges via `RabbitmqResource` manifests ou
      DefinitionsImport ConfigMap
- [ ] **Side bonus restore granulaire** : si `pg-data` corrompue un jour, on
      garde toute la config GeoServer (workspaces, layers, styles SLD) intacte
      dans `pg-catalog` — pas de reconfig à refaire from scratch

**Note** : c'est le sprint le plus risqué. Faire un dry-run préprod complet
avant de toucher la prod.

### Sprint 5 — GeoServer cluster propre (1 weekend, long)

Refonte de l'archi GeoServer demandée depuis longtemps :

- [ ] 1 seul service `geoserver` avec `replicas: 3` (vs `geoserver-1/2/3`)
- [ ] Sessions Tomcat partagées via **JDBCSessionDataStore** (table session
      dans la DB CNPG) OU réplication via **Hazelcast plugin** GeoServer
- [ ] PVC RWX (Scaleway Block ne fait pas RWX → utiliser PVC NFS ou
      ReadWriteOnce + init container qui sync depuis S3)
- [ ] **JDBCConfig** + **JDBCStore** déjà gérés par CNPG schema `geoserver`
- [ ] **GWC standalone** : extraire GeoWebCache du WAR GeoServer dans un
      service séparé `gwc` qui partage le cache via S3
- [ ] StickySession via ingress-nginx annotation `session-affinity: cookie`
- [ ] Healthcheck startupProbe 600s pour boot Tomcat lent + livenessProbe
- [ ] Plugin custom IDW (notre WPS) : build du JAR + image GeoServer
      personnalisée (Dockerfile multi-stage) + push registry

### Sprint 6 — Cutover prod + status page (1 weekend)

- [ ] Pre-prod 100% iso à prod (à part replicas et taille DB)
- [ ] Tests E2E Playwright contre préprod
- [ ] Swap DNS : `maritime.sylad.dev` pointe vers cluster (24h propagation)
- [ ] NAS continue à ingérer AIS et pousse vers le cluster
- [ ] Mise à jour des README/About des 4 apps avec la nouvelle archi
- [ ] **Status page publique** (UptimeRobot gratuit + page Cloudflare statique)
      → linkée depuis le portfolio CV. Permet d'expliquer un incident sans
      perdre la face.

### Sprint 7 — Observability + finitions (1 weekend)

Le sprint "CV-bait" : tout ce qui fait pro à montrer en démo.

- [ ] **kube-prometheus-stack** (Prometheus + Grafana + AlertManager)
- [ ] Dashboard Grafana custom maritime (vessel rate, queue depth,
      decoder throughput, GeoServer p95 latency)
- [ ] **Loki** + Promtail pour logs centralisés
- [ ] AlertManager → Telegram bot (ou Discord webhook) pour alertes
- [ ] **NetworkPolicy** zero-trust namespace-to-namespace
- [ ] **Pod Security Standards** restricted sur namespace prod
- [ ] **README archi** avec diagrammes Mermaid (à mettre dans portfolio CV)
- [ ] **Case study claude-code-codex** sur la migration entière

---

## Coûts mensuels estimés

### Phase 1 — Cluster local Big-Blue
**€0/mois**. RAM/CPU/disk de Big-Blue (i9-14900KF, 31 GiB, 936 GB ext4).
Investissement = 0, on valide toute l'archi avant de payer.

### Phase 2 — Cluster cloud Scaleway Kapsule (quand stable)
| Poste | Coût |
|---|---|
| Control plane Kapsule | €0 |
| 2× nodes DEV1-L (4 vCPU 8 GB) | ~€38 |
| LB public | ~€8 |
| Object Storage (~10 GB) | ~€0.12 |
| Container Registry | €0 |
| Backups CNPG sur Object Storage | ~€1 |
| **Total prod** | **~€47/mois** |

Avec un 3ème node si besoin pour absorber les pics : ~€65/mois.
Budget annuel phase 2 : **€560-780/an** = investissement carrière clair.

---

## Risques + mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Migration PG perd des données | Critique | Dry-run sur préprod, backup NAS conservé 30j |
| GeoServer cluster sessions cassées | Élevé | Sticky session ingress + fallback single-replica |
| KEDA mal calibré → over-scale | Coût | maxReplicaCount=5, cooldown 5min |
| Coût explose (over-provisioning) | Moyen | Resource requests/limits stricts + HPA bornés |
| NAS pousse trop vite, AMQP throttle | Bas | Rate-limiting publisher + backpressure pattern |
| Re-création de la même contention I/O cluster | Moyen | PVC dédié par stateful workload + `resources.limits` strictes + storage class SSD (Scaleway Block Storage NVMe ou ext4 natif WSL2), pas un volume Btrfs partagé |
| Saturation `/` WSL2 sur Big-Blue (cluster local) | Élevé | Disk budget ≤180 GB, 2 StorageClass (hot `/`, cold `/mnt/e`), Prom alert disk<20%, hypertables tiering Timescale |
| Dépendance Scaleway (vendor lock-in) | Moyen | Manifests vanilla K8s, exportables vers OVH/Hetzner |
| 7 weekends c'est long, perte de momentum | Moyen | Sprint 1 (ol-companion) livre déjà un truc à montrer |

---

## MVP fast-path — si on veut un truc visible en 48h

Si la pression recherche d'emploi devient forte, on peut faire un MVP en
sautant des étapes :

1. Sprint 0 (cluster) + Sprint 1 (ol-companion) = **1 weekend**
2. → `ol.sylad.dev` UP en cluster K8s, démontrable, vendable
3. Le reste suit dans l'ordre

Le portfolio peut linker `ol.sylad.dev` (Cloud-native, K8s, GitOps,
ArgoCD) en disant "le reste suit la même archi, migration progressive
en cours". C'est un message **plus vendeur** qu'un site dans le NAS
qui marche.

---

## Décisions à prendre avant Sprint 0

- [ ] **Nom de domaine** : `sylad.dev` ? `ladoire.dev` ? `sylvainladoire.dev` ?
- [ ] **Région cluster** : fr-par-2 (Paris) ou pl-waw-1 (Pologne, ~25% moins cher) ?
- [ ] **Tier Scaleway** : DEV1-L (€18/mo, 4vCPU 8GB) ou POP2-2C-8G (€19/mo,
      2vCPU 8GB mais I/O meilleur) ?
- [ ] **Pre-prod data** : seed indépendant ou snapshot daily de la prod ?
- [ ] **Domaine séparé pour preprod** : `*.preprod.sylad.dev` ou `*.staging.sylad.dev` ?

---

## Pas dans ce périmètre

- Migration des sites statiques Astro (eywa, evatosorus) — déjà sur Cloudflare Pages, rien à faire.
- Migration du site `claude-code-codex` — déjà sur Cloudflare Pages.
- Mini-Blue WSL2 cluster cross-node — abandonné (cf memory
  `infrastructure_compute_distribue_dead_ends_2026_05_13`). Reste utile en dev local.

---

## Refs

- [Scaleway Kapsule docs](https://www.scaleway.com/en/docs/managed-kubernetes/)
- [CloudNativePG](https://cloudnative-pg.io/)
- [KEDA RabbitMQ scaler](https://keda.sh/docs/latest/scalers/rabbitmq-queue/)
- [ArgoCD getting started](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [cert-manager + Cloudflare DNS-01](https://cert-manager.io/docs/configuration/acme/dns01/cloudflare/)
- Incident 2026-05-13 (post-coupure secteur) : `infrastructure_compute_distribue_dead_ends`, `compose_to_swarm_migration_recipe`, `swarm_queue_autoscaler_pattern` — leçons réutilisables pour la migration K8s.
