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

K8s plutôt que Swarm parce que :

- 2026 : K8s = lingua franca chez 95% des boîtes (EKS, GKE, AKS, OpenShift,
  Rancher, k3s, Kapsule). Swarm = niche.
- Sylvain le subit déjà au taff → courbe d'apprentissage gérable.
- Permet d'empiler des skills "cloud-native" vendables (Helm, ArgoCD,
  operators, KEDA, cert-manager, observability).

---

## Architecture cible

```
                 ┌────────────────────────────────────────────────┐
                 │          Cloudflare (DNS + CDN + WAF)          │
                 │     ↳ frontends statiques Astro (eywa,         │
                 │       evatosorus) — gratis, déjà en place      │
                 │     ↳ frontends dynamiques (finance, war, ol,  │
                 │       maritime) → Cloudflare Pages avec build  │
                 │       de demo data figées (fallback)           │
                 └────────────────────┬───────────────────────────┘
                                      │
                              DNS A/AAAA → IP LB cluster
                                      │
       ┌──────────────────────────────▼──────────────────────────────┐
       │   Scaleway Kapsule cluster (région fr-par-2 ou pl-waw-1)    │
       │   ┌────────────────────────────────────────────────────┐   │
       │   │  namespace: prod                                   │   │
       │   │   ├─ maritime (api, ais-decoder ×N, geoserver ×N,  │   │
       │   │   │  weather-fetchers, alerts, frontend nginx)     │   │
       │   │   ├─ finance / warhammer / ol (NestJS + frontend)  │   │
       │   │   └─ infrastructure (cnpg, rabbitmq-operator,      │   │
       │   │      cert-manager, ingress-nginx, keda)            │   │
       │   ├────────────────────────────────────────────────────┤   │
       │   │  namespace: preprod                                │   │
       │   │   └─ idem prod mais resource limits ÷3 + 1 replica │   │
       │   └────────────────────────────────────────────────────┘   │
       │   Cluster-wide : ArgoCD + Prometheus + Grafana + Loki      │
       └──────────────────────────────▲──────────────────────────────┘
                                      │
                          AIS feed (TLS sortant)
                                      │
       ┌──────────────────────────────┴──────────────────────────────┐
       │       NAS Synology (rôle : edge collector + dev local)      │
       │   ├─ ais-ingester (radio receiver / aisstream.io client)    │
       │   ├─ buoy-fetcher, lightning-fetcher (cron data acquisition)│
       │   ├─ Mini-Blue WSL2 + k3s (dev local — optionnel)           │
       │   └─ Storage froid : backups PG + snapshots                 │
       └─────────────────────────────────────────────────────────────┘
```

**Note clé** : le NAS ne disparaît pas. Il devient un **edge collector**
qui pousse les données vers RabbitMQ dans le cluster via TLS sortant.
Pattern reconnu (IoT edge / hybrid cloud) → également vendable sur CV.

---

## Provider — Scaleway Kapsule

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

### Sprint 0 — Bootstrap cluster (1 weekend)

Provision + plomberie cluster sans aucune app encore.

- [ ] Création compte Scaleway + facturation
- [ ] Provision cluster Kapsule (2 nodes DEV1-L) en fr-par-2
- [ ] `kubectl` config + accès via kubeconfig
- [ ] Création namespaces `prod` + `preprod` + `argocd` + `infra`
- [ ] Install `ingress-nginx` via Helm + IP publique Scaleway LB
- [ ] Install `cert-manager` + ClusterIssuer Let's Encrypt DNS-01 (Cloudflare)
- [ ] Install `argocd` + accès UI via Ingress + TLS
- [ ] Install `sealed-secrets` controller
- [ ] Création registry Scaleway + GitHub Actions auth secret
- [ ] Création repo Git séparé `developpeur-gitops` (les manifests générés)
- [ ] DNS Cloudflare : `*.sylad.dev` (ou domaine choisi) pointé vers LB

**Livrables** : `kubectl get pods -A` montre tous les controllers verts, UI
ArgoCD accessible, première app de test (whoami) déployable via Helm chart.

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

- [ ] **CloudNativePG operator** + cluster PG 1-instance (préprod) /
      3-instances avec replica streaming (prod)
- [ ] Migration data PG : `pg_dump` NAS → import dans le cluster CNPG
- [ ] Hypertables Timescale : activer extension dans le manifest CNPG
- [ ] Backups S3 Scaleway (pgBackRest natif CNPG, WAL streaming)
- [ ] **RabbitMQ Cluster Operator** + cluster 3-quorum (prod), 1-instance (preprod)
- [ ] Restore des bindings/exchanges via `RabbitmqResource` manifests ou
      DefinitionsImport ConfigMap

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

| Poste | Coût |
|---|---|
| Control plane Kapsule | €0 |
| 2× nodes DEV1-L (4 vCPU 8 GB) | ~€38 |
| LB public | ~€8 |
| Object Storage (~10 GB) | ~€0.12 |
| Container Registry | €0 |
| Backups CNPG sur Object Storage | ~€1 |
| **Total** | **~€47/mois** |

Avec un 3ème node si besoin pour absorber les pics : ~€65/mois.
Budget annuel : **€560-780/an** = un investissement carrière clair.

---

## Risques + mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Migration PG perd des données | Critique | Dry-run sur préprod, backup NAS conservé 30j |
| GeoServer cluster sessions cassées | Élevé | Sticky session ingress + fallback single-replica |
| KEDA mal calibré → over-scale | Coût | maxReplicaCount=5, cooldown 5min |
| Coût explose (over-provisioning) | Moyen | Resource requests/limits stricts + HPA bornés |
| NAS pousse trop vite, AMQP throttle | Bas | Rate-limiting publisher + backpressure pattern |
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
