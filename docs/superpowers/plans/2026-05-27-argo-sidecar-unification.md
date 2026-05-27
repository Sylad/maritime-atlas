# Argo Sidecar Unification — Approche C (Argo multi-namespace, ephemeral pods)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrer 5 sidecars Python (sst-fetcher, weather-fetcher, weather-fetcher-arpege, weather-fetcher-arome, buoy-fetcher) du pattern "Deployment 24/7 + apscheduler interne" vers le pattern **Argo-natif** "CronWorkflow → ephemeral pod direct" — pas de long-running container, pas d'HTTP intermédiaire, le workflow porte tout (schedule + image + command + env + volumes).

**Pourquoi C plutôt que A (HTTP /fetch glofas-style)** : C est le plus dans l'esprit Argo — le workflow est la source unique de vérité, les pods n'existent que pendant le run (économie ressources cluster), tout déclaratif K8s-natif. Cf [le tableau de comparaison A/B/C dans la session 2026-05-27].

**Trade-off** : C demande un chantier infra Argo (extend controller managedNamespaces à `maritime`) — sensible. Mais une fois fait, c'est durable et idiomatique.

**Tech Stack** : Argo Workflows v3.x, K8s Deployments → suppression, CronWorkflows en `ns maritime`, Helm charts.

**Spec reference** : pattern Argo native — cf docs Argo Workflows officielle https://argo-workflows.readthedocs.io/en/latest/walk-through/scheduling-workflows-with-cron-workflows/.

---

## Scope

| Sidecar | Cron actuel | Argo cron proposé | Coverage / DB cible |
|---|---|---|---|
| `sst-fetcher` | 06:00 UTC daily | `0 6 * * *` | `/coverage/sst-daily` |
| `weather-fetcher` (GFS) | 04:15 / 10:15 / 16:15 / 22:15 UTC | `15 4,10,16,22 * * *` | `/coverage/wind-speed`, `/coverage/wave-hs`, `/coverage/wave-dir` |
| `weather-fetcher-arpege` | 03:30 / 09:30 / 15:30 / 21:30 UTC | `30 3,9,15,21 * * *` | `/coverage/wind-arpege` |
| `weather-fetcher-arome` | 02:30 / 08:30 / 14:30 / 20:30 UTC | `30 2,8,14,20 * * *` | `/coverage/wind-arome` |
| `buoy-fetcher` | every 1440min (daily) | `0 5 * * *` | DB seed `buoys` |

**Hors scope** : `ais-ingester`, `lightning-fetcher` (WebSocket persistents) ; `grib-parser` (HTTP stateless) ; `ais-decoder`, `alerts-engine` (consumers RMQ) ; `glofas-fetcher` (déjà déployé en pattern A 2026-05-27, voir Annexe pour migration future vers C).

**Pré-requis acquis (déjà fait 2026-05-27)** : flag `--once` ajouté aux 5 sidecars (commits ac3b99b chain). Sans ce flag, le `python3 src/main.py` continuait son apscheduler interne — avec `--once`, le main() run une fois puis exit 0. Parfait pour Argo.

## File Structure

### Phase 1 — Argo controller multi-namespace

**Modif** :
- Modify: `developpeur-gitops/apps/argo-workflows.yaml` (Argo Helm install) ou `developpeur-gitops/charts/argo-workflows-config/` (selon où la config controller vit) — ajouter `maritime` aux managed namespaces.

**Diagnostic à faire avant** :
```bash
kubectl --context mini-blue -n argo get cm argo-workflows-workflow-controller-configmap -o yaml | grep -A 5 "namespaces\|namespace"
kubectl --context mini-blue -n argo get deploy argo-workflows-workflow-controller -o yaml | grep -A 5 "args\|namespaced"
```

Identifier le mode :
- Mode A : `--namespaced` (default, watch own ns only)
- Mode B : `--managed-namespace=<ns>` (cluster install, watch listed ns)
- Mode C : pas de flag = cluster-wide (watch all ns)

Selon le mode, soit on retire `--namespaced`, soit on étend `--managed-namespace`, soit on bascule en cluster install. **À investiguer en Task 1**.

### Phase 2 — Per sidecar (CronWorkflow + désactivation Deployment)

Pour chaque sidecar (sst-fetcher servant d'exemple) :

**Modif Helm chart maritime** :
- Create: `developpeur-gitops/charts/maritime/templates/wf-sst-fetcher.yaml` — CronWorkflow en `ns maritime` avec pod spec complet.
- Modify: `developpeur-gitops/charts/maritime/values.yaml` — toggle `sstFetcher.enabled: false` (désactive le Deployment).

**Note importante** : le CronWorkflow et le Deployment NE coexistent PAS — soit l'un soit l'autre. Migration step : déployer CronWorkflow, vérifier qu'il run, puis désactiver Deployment.

### Phase 3 — Cleanup

- Modify: `services/{sst,weather-*,buoy}-fetcher/src/main.py` — retirer les blocs `apscheduler` + `BlockingScheduler` du code (deviennent dead code).
- Modify: `services/*/pyproject.toml` — retirer la dep `apscheduler` (gain ~5MB image).
- Delete: `developpeur-gitops/charts/maritime/templates/sst-fetcher.yaml` (idem 4 autres) — les Deployments ne servent plus.

---

## Order of execution & dependencies

```
Phase 1 (Argo multi-ns)  ──→ Phase 2 (5 CronWorkflows + désactiver Deployments, parallélisable) ──→ Phase 3 (cleanup code, après 24h validation)
```

Phase 1 est un préalable infra **bloquant** : tant que Argo controller ne watch pas `ns maritime`, les CronWorkflows en `maritime` ne fireront pas.

Phase 2 est **5 sidecars indépendants** → parallélisable sub-agent-driven.

Phase 3 est cleanup différé (24h+ pour valider stabilité avant supprimer le rollback path).

---

# Phase 1 — Argo controller multi-namespace setup

## Task 1: Diagnostic + identification du mode Argo actuel

**Files:** lecture seulement (aucun edit dans cette task).

- [ ] **Step 1: Inspecter le workflow controller deployment**

```bash
kubectl --context mini-blue -n argo get deploy argo-workflows-workflow-controller -o yaml | grep -A 30 "spec:\s*containers:"
```

Cherche les `args` du container. Patterns possibles :
- `--namespaced` (default Helm chart) → restreint à `ns argo`
- `--managed-namespace=<ns>` (cluster install, peut être passé plusieurs fois)
- pas de flag → cluster install full

- [ ] **Step 2: Inspecter le ConfigMap controller**

```bash
kubectl --context mini-blue -n argo get cm argo-workflows-workflow-controller-configmap -o yaml
```

Vérifier la présence de `namespaceParallelism`, `workflowNamespaces`, etc.

- [ ] **Step 3: Identifier où la config Helm vit**

```bash
find /home/sylvain_ladoire/projects/developpeur/developpeur-gitops -name "*argo-workflow*" -type f | head -5
cat /home/sylvain_ladoire/projects/developpeur/developpeur-gitops/apps/argo-workflows.yaml
```

L'install Argo passe vraisemblablement par un Argo CD Application qui pointe vers le Helm chart upstream `argoproj/argo-workflows`. Identifier les `values:` overrides.

- [ ] **Step 4: Documenter le mode actuel + le changement nécessaire**

Écrire dans un fichier scratch `/tmp/argo-multi-ns-diagnostic.md` :
- Mode actuel (A/B/C)
- Modif Helm values à appliquer
- Impact sur les workflows existants en `ns argo` (doivent continuer à fonctionner)

## Task 2: Étendre Argo à `ns maritime`

**Files:**
- Modify: `developpeur-gitops/apps/argo-workflows.yaml` OU `developpeur-gitops/charts/argo-workflows-values/` (selon Task 1)

- [ ] **Step 1: Patcher les Helm values Argo**

Selon le mode identifié :
- **Si mode A** (`--namespaced`) : retirer le flag (passe en cluster install) OU patcher pour passer en cluster install controlled :
  ```yaml
  controller:
    workflowNamespaces:
      - argo
      - maritime
  ```
- **Si mode B** (`--managed-namespace=argo`) : ajouter `--managed-namespace=maritime` :
  ```yaml
  controller:
    extraArgs:
      - --managed-namespace=argo
      - --managed-namespace=maritime
  ```
- **Si mode C** (déjà cluster-wide) : rien à faire côté controller, juste créer les workflows en `ns maritime`. ✅

- [ ] **Step 2: Créer Role + RoleBinding pour workflow execution en ns maritime**

Le ServiceAccount `argo-workflow` doit exister en `ns maritime` aussi (sinon les workflows en maritime ne peuvent pas créer leurs pods exécution). Helm chart Argo offre généralement une option `serviceAccount.create` mais par ns.

Créer `developpeur-gitops/charts/maritime/templates/argo-workflow-sa.yaml` :

```yaml
{{- if .Values.argo.workflowSa.enabled }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argo-workflow
  namespace: maritime
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argo-workflow-executor
  namespace: maritime
rules:
  - apiGroups: [""]
    resources: [pods, pods/exec, pods/log]
    verbs: [create, get, list, watch, update, patch, delete]
  - apiGroups: [""]
    resources: [persistentvolumeclaims, secrets, configmaps]
    verbs: [get, list]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [create, get, list, watch, update, patch, delete]
  - apiGroups: [argoproj.io]
    resources: [workflowtaskresults, workflowtasksets, workflows]
    verbs: [create, get, list, watch, update, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argo-workflow-executor
  namespace: maritime
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argo-workflow-executor
subjects:
  - kind: ServiceAccount
    name: argo-workflow
    namespace: maritime
{{- end }}
```

Et ajouter dans `values.yaml` :
```yaml
argo:
  workflowSa:
    enabled: true
```

- [ ] **Step 3: Commit + push + sync ArgoCD**

```bash
cd developpeur-gitops
git add apps/argo-workflows.yaml charts/maritime/templates/argo-workflow-sa.yaml charts/maritime/values.yaml
git commit -m "feat(argo): extend workflow controller to manage ns maritime (Argo C-unification prep)"
git push origin main
```

- [ ] **Step 4: Vérifier que le workflow controller a rollé**

```bash
kubectl --context mini-blue -n argo rollout status deploy/argo-workflows-workflow-controller --timeout=120s
kubectl --context mini-blue -n argo logs deploy/argo-workflows-workflow-controller --tail=20 | grep -i "namespace\|maritime"
```

→ doit montrer "Watching workflows in namespaces: [argo, maritime]" ou similar.

## Task 3: Smoke test Argo multi-ns (dummy workflow en maritime)

**Files:** test temporaire, pas commit.

- [ ] **Step 1: Submit un workflow trivial en ns maritime**

```bash
kubectl --context mini-blue -n maritime apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: test-multi-ns-
  namespace: maritime
spec:
  serviceAccountName: argo-workflow
  entrypoint: hello
  ttlStrategy: { secondsAfterCompletion: 300 }
  templates:
    - name: hello
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["echo 'Hello from ns maritime!'; date"]
EOF
```

- [ ] **Step 2: Watch le workflow run**

```bash
kubectl --context mini-blue -n maritime get workflows -w
```

→ doit passer Pending → Running → Succeeded en quelques secondes.

- [ ] **Step 3: Cleanup**

```bash
kubectl --context mini-blue -n maritime delete workflow -l workflows.argoproj.io/completed
```

**Si Task 3 fail** : revenir à Task 1, mode Argo n'est pas correctement configuré. **Blocker** pour Phase 2.

---

# Phase 2 — CronWorkflows per sidecar

## Task 4: sst-fetcher → CronWorkflow + désactiver Deployment

**Files:**
- Create: `developpeur-gitops/charts/maritime/templates/wf-sst-fetcher.yaml`
- Modify: `developpeur-gitops/charts/maritime/values.yaml` (toggle off Deployment + déclarer CronWorkflow)

- [ ] **Step 1: Écrire le CronWorkflow en ns maritime**

```yaml
# developpeur-gitops/charts/maritime/templates/wf-sst-fetcher.yaml
{{- if .Values.workflows.sstFetcher.enabled }}
# 2026-05-XX — Argo unification : sst-fetcher en pattern C.
# Workflow porte tout : schedule, image, env, secrets, volumes.
# Pod éphémère par run (pas de Deployment long-running).
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: sst-fetcher
  namespace: maritime
spec:
  schedules:
    - "0 6 * * *"   # daily 06:00 UTC (NOAA OISST published ~02:00 UTC)
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  workflowSpec:
    entrypoint: fetch
    serviceAccountName: argo-workflow
    activeDeadlineSeconds: 1800
    ttlStrategy: { secondsAfterCompletion: 86400 }
    templates:
      - name: fetch
        container:
          image: "{{ .Values.workflows.sstFetcher.image }}:{{ .Values.workflows.sstFetcher.tag }}"
          imagePullPolicy: IfNotPresent
          command: [python3]
          args: [src/main.py, --once]
          env:
            - name: GEOSERVER_URL
              value: "http://geoserver:8080/geoserver"
            - name: COVERAGE_DIR
              value: /coverage/sst-daily
            - name: ORCHESTRATOR_API
              value: "http://api:3010"
            - name: ORCHESTRATOR_SOURCE_NAME
              value: "sst-fetcher"
          envFrom:
            - secretRef:
                name: maritime-shared-env
                optional: false
          volumeMounts:
            - name: coverage
              mountPath: /coverage
          resources:
            requests: { cpu: "50m",  memory: "128Mi" }
            limits:   { cpu: "500m", memory: "512Mi" }
        volumes:
          - name: coverage
            persistentVolumeClaim:
              claimName: maritime-coverage
{{- end }}
```

- [ ] **Step 2: Ajouter le bloc workflows.sstFetcher dans values.yaml**

```yaml
workflows:
  sstFetcher:
    enabled: true
    image: ghcr.io/sylad/aetherwx-sst-fetcher
    tag: sha-<latest>   # même tag que le Deployment, contient déjà --once
```

- [ ] **Step 3: Désactiver le Deployment (PAS supprimer encore, juste toggle)**

Dans `values.yaml`, changer :
```yaml
services:
  sstFetcher:
    enabled: false   # ← migré vers CronWorkflow (cf workflows.sstFetcher)
    ...
```

- [ ] **Step 4: Helm dry-run + commit + push**

```bash
helm template charts/maritime/ --show-only templates/wf-sst-fetcher.yaml
git add charts/maritime/templates/wf-sst-fetcher.yaml charts/maritime/values.yaml
git commit -m "feat(maritime): migrate sst-fetcher to Argo CronWorkflow (pattern C)"
git push origin main
```

- [ ] **Step 5: Vérifier le CronWorkflow registered + Deployment supprimé**

ArgoCD sync ~3min puis :
```bash
kubectl --context mini-blue -n maritime get cronworkflow sst-fetcher
kubectl --context mini-blue -n maritime get deploy sst-fetcher 2>&1 | head -3
```

→ CronWorkflow présent avec schedule, Deployment "NotFound".

- [ ] **Step 6: Submit manuel pour valider le pattern complet**

```bash
argo --context mini-blue -n maritime submit --from cronwf/sst-fetcher --watch
```

→ Pod éphémère créé, run la fetch cycle, écrit dans `/coverage/sst-daily/`, exit 0.

- [ ] **Step 7: Verify GeoTIFFs**

```bash
kubectl --context mini-blue -n maritime run -it --rm --restart=Never --image=alpine:3.19 inspect-coverage -- \
  sh -c "apk add --no-cache findutils && find /coverage/sst-daily -mtime -1 -name '*.tif' | head -5" \
  --overrides='{"spec":{"containers":[{"name":"inspect-coverage","image":"alpine:3.19","stdin":true,"tty":true,"volumeMounts":[{"name":"cov","mountPath":"/coverage"}]}],"volumes":[{"name":"cov","persistentVolumeClaim":{"claimName":"maritime-coverage"}}]}}'
```

→ Doit lister au moins 1 GeoTIFF récent.

- [ ] **Step 8: Vérifier que le frontend continue d'afficher SST**

Visit https://aetherwx.sladoire.dev/ → toggle SST → carte doit afficher la couche normalement.

**Si Step 8 fail** : rollback. Toggle `services.sstFetcher.enabled: true` + `workflows.sstFetcher.enabled: false` + push.

## Tasks 5-8: idem pour les 4 autres sidecars

Répéter Task 4 pour chaque. Cron schedules + env vars à adapter (chaque sidecar a des envs spécifiques — copier depuis le Deployment template actuel `charts/maritime/templates/<sidecar>.yaml`).

**Variations envs/volumes** :

- `weather-fetcher` : envs `WIND_DIR=/coverage/wind-speed`, `WAVE_HS_DIR=/coverage/wave-hs`, `WAVE_DIR_DIR=/coverage/wave-dir`, `GEOSERVER_URL`, `ORCHESTRATOR_*`.
- `weather-fetcher-arpege` : envs `WIND_DIR=/coverage/wind-arpege`, `WIND_ARROWS_DIR=/coverage/wind-arpege-arrows`, idem GEOSERVER_URL + ORCHESTRATOR.
- `weather-fetcher-arome` : idem ARPEGE mais `WIND_DIR=/coverage/wind-arome`.
- `buoy-fetcher` : envs `DB_URL` (depuis secret CNPG `pg-data-app`), `EMODNET_LAYER`, `BBOX_*`. PAS de volume coverage (écrit en DB seulement).

Pour chaque sidecar, vérifier le Deployment template existant pour la liste exacte d'envs/secrets/volumes à porter dans le CronWorkflow.

---

# Phase 3 — Cleanup (après 24h validation stable)

## Task 9: Supprimer le code apscheduler des sidecars

**Files:**
- Modify: `services/{sst,weather-*,buoy}-fetcher/src/main.py`
- Modify: `services/{sst,weather-*,buoy}-fetcher/pyproject.toml`

- [ ] **Step 1: Per sidecar, retirer le bloc apscheduler du main()**

Exemple pour `sst-fetcher` :

```python
# AVANT (state post Phase 2, --once branche encore active)
def main() -> None:
    COVERAGE_DIR.mkdir(parents=True, exist_ok=True)
    log.info('sst-fetcher starting')

    if '--once' in sys.argv:
        log.info('Running in --once mode (Argo-triggered)')
        run_fetch_cycle()
        return

    # Run immédiat au boot
    run_fetch_cycle()

    # Boucle cron 06:00 UTC quotidien
    from apscheduler.schedulers.blocking import BlockingScheduler
    sched = BlockingScheduler(timezone='UTC')
    sched.add_job(run_fetch_cycle, 'cron', hour=6, minute=0)
    log.info('Scheduler armed (06:00 UTC daily)')
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)

# APRÈS (Argo seul, --once devient le mode normal)
def main() -> None:
    """Argo-only mode (post-unification 2026-05-XX).

    Le sidecar est invoké par CronWorkflow `sst-fetcher` (cf
    charts/maritime/templates/wf-sst-fetcher.yaml). Plus de scheduler
    interne — le pod run un fetch puis exit.
    """
    COVERAGE_DIR.mkdir(parents=True, exist_ok=True)
    log.info('sst-fetcher Argo-triggered run')
    run_fetch_cycle()
```

- [ ] **Step 2: Retirer apscheduler des dependencies**

Dans `pyproject.toml` de chaque sidecar, retirer la ligne `"apscheduler==X.Y.Z"`.

- [ ] **Step 3: Commit + push + CI rebuild**

```bash
git add services/*/src/main.py services/*/pyproject.toml
git commit -m "chore(fetchers): remove apscheduler, Argo CronWorkflows own scheduling"
git push origin main
```

Wait CI build (~5min × 5 sidecars).

- [ ] **Step 4: Bump tags dans gitops**

Mettre à jour chaque `workflows.<sidecar>.tag` avec le nouveau SHA post-cleanup.

```bash
cd developpeur-gitops
# bump 5 tags
git add charts/maritime/values.yaml
git commit -m "chore(maritime): bump fetcher tags post-apscheduler cleanup"
git push origin main
```

## Task 10: Supprimer les Deployment templates (optionnel, défensif)

**Files:**
- Delete: `developpeur-gitops/charts/maritime/templates/sst-fetcher.yaml`
- Delete: `developpeur-gitops/charts/maritime/templates/weather-fetcher.yaml`
- Delete: `developpeur-gitops/charts/maritime/templates/weather-fetcher-arpege.yaml`
- Delete: `developpeur-gitops/charts/maritime/templates/weather-fetcher-arome.yaml`
- Delete: `developpeur-gitops/charts/maritime/templates/buoy-fetcher.yaml`
- Modify: `developpeur-gitops/charts/maritime/values.yaml` — retirer les blocs `services.*Fetcher` (déjà à `enabled: false`).

- [ ] **Step 1: Décision : delete vs garder `enabled: false`**

Garder `enabled: false` = chemin de rollback rapide (toggle true + tag bump). Delete = code mort en moins, mais rollback nécessite git revert.

**Reco** : garder `enabled: false` pendant 1-2 mois (1 cycle saisonnier sur les data), puis delete.

Si on garde `enabled: false`, **skip cette task** entièrement.

Si on delete :
```bash
cd developpeur-gitops
rm charts/maritime/templates/sst-fetcher.yaml \
   charts/maritime/templates/weather-fetcher.yaml \
   charts/maritime/templates/weather-fetcher-arpege.yaml \
   charts/maritime/templates/weather-fetcher-arome.yaml \
   charts/maritime/templates/buoy-fetcher.yaml
# patcher values.yaml pour retirer services.*Fetcher
git commit -am "chore(maritime): remove old fetcher Deployments (Argo CronWorkflows own them now)"
git push origin main
```

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Multi-namespace Argo config diff entre les chart values actuels et ce qui marche réellement → workflow controller crashe sur Helm sync | Faire Task 1 (diagnostic) bien à fond avant Task 2. Tester en preprod si possible. |
| RBAC argo-workflow SA en ns maritime insuffisant → workflow Pending avec erreurs `Forbidden` | Le Role/RoleBinding de Task 2 Step 2 doit couvrir tous les verbes nécessaires. Si manque, ajouter au fil. |
| Sidecar code suppose un long-running process (pas testé pour run-once) → race conditions au shutdown | Le `--once` flag a été testé conceptuellement ce 2026-05-27. Faire un smoke test manuel (Task 4 Step 6) avant chaque sidecar. |
| GS reindex après nouveau GeoTIFF — fait par le sidecar en fin de run_fetch_cycle → doit marcher en mode ephemeral aussi | Vérifier dans le code de chaque sidecar : `coverage_store_exists()` + `trigger_geoserver_reindex()` sont des HTTPS calls vers GS, indépendants du lifecycle. OK pour ephemeral. |
| Buoy-fetcher écrit en DB (PG) — connection lifecycle | OK : le sidecar ouvre + ferme la connexion par run, idempotent. |
| Workflows déjà en ns argo (les 6 trigger-* HTTP) continuent à fonctionner après extend multi-ns | Vérifier `kubectl -n argo get workflows` post Task 2 Step 4. |
| Premier run Argo workflow nécessite image pull dans ns maritime (1ère fois) → latence | Pre-pull via DaemonSet ou accepter ~30s extra au 1er run. |
| Le `imagePullSecrets: regcred` du Deployment doit être présent aussi pour le pod workflow | Ajouter dans le CronWorkflow `workflowSpec.imagePullSecrets: [name: regcred]`. Vérifier que le secret `regcred` existe en ns maritime. |

## Critères de validation (Definition of Done)

- [ ] Argo controller log `Watching workflows in namespaces: [argo, maritime]` ou équivalent.
- [ ] `kubectl -n maritime get cronworkflow` liste les 5 sidecars.
- [ ] Aucun Deployment fetcher en `ns maritime` (`get deploy | grep -E "sst|weather|buoy"` = vide ou enabled:false).
- [ ] Pour chaque sidecar : au moins 1 workflow `Succeeded` dans les 24h post-déploiement.
- [ ] Les data layers SST / wind / wave / buoys continuent à apparaître sur le frontend (pas de régression UX).
- [ ] `/maritime-anim-test` passe.
- [ ] Aucun import `apscheduler` dans `services/*/src/main.py` (après Task 9).
- [ ] Memory note `argo_sidecar_unification_2026_05_XX.md` créée.
- [ ] README aetherwx : section "Argo Workflows" mentionne les 11 sources cronnées via Argo (6 HTTP-trigger + 5 ephemeral pod).

---

## Annexe — Migration future de glofas-fetcher vers C (optional)

`glofas-fetcher` a été déployé 2026-05-27 en pattern A (HTTP /fetch endpoint). C'est inconsistent avec C si C devient le standard.

Migration future (faible priorité) :
1. Réutiliser le `--once` logic (à ajouter — actuellement seulement `/fetch` HTTP existe)
2. Créer CronWorkflow `glofas-fetcher` en ns maritime
3. Désactiver Deployment + Service glofas-fetcher
4. Supprimer le module FastAPI app du sidecar (run_fetch_cycle direct)

Coût ~2h. À planifier après que les 5 sidecars Phase 1-2-3 soient validés stables.

---

## Récap effort estimé

| Phase | Tasks | Coût (estim) | Parallélisable ? |
|---|---|---|---|
| Phase 1 (Argo multi-ns) | 3 | 1h30 (diagnostic + config + smoke) | ❌ Séquentiel (bloquant Phase 2) |
| Phase 2 (5 CronWorkflows) | 5 | 30min/sidecar = 2h30 | ✅ Sub-agents en parallèle |
| Phase 3 (cleanup code) | 2 | 1h actif + 24h passive | ❌ Après validation |

**Total actif** : ~5h sur 2 jours (½j Phase 1+2, 24h observation, ½j Phase 3).

## Prochaine étape

Démarrer par Phase 1 Task 1 (diagnostic). C'est l'inconnue critique qui détermine la difficulté du reste. Une fois mode Argo identifié, Phase 2 est mécanique (5 sidecars sur le même pattern).

À exécuter via `superpowers:subagent-driven-development`.
