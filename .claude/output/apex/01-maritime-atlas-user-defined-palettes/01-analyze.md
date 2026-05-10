# Step 01: Analyze

**Task:** Système d'auth (email+password) + écran de configuration de palettes SLD utilisateur (max 5/user) avec override defaultStyle WMS via param {{task_description}}styles=user_xyz_palette
**Started:** 2026-05-10T20:48:44Z

---

## Context Discovery

_Findings will be appended here as exploration progresses..._

## Synthesis (2026-05-10)

### Frontend (Angular 19 standalone signals)
- `frontend/src/app/app.routes.ts` — single root route → MapComponent. Add `/auth/login`, `/auth/register`, `/palettes` routes (lazy via `loadComponent`).
- `frontend/src/app/app.config.ts:15` — `provideHttpClient(withFetch())` no interceptor → add `withInterceptors([authInterceptor])`.
- `frontend/src/app/services/` — vessels.service.ts + rainviewer.service.ts. Add `auth.service.ts` + `palettes.service.ts`.
- `frontend/src/styles.scss:1-67` — CSS theme tokens (--accent #2dd4bf, --bg #0a0e1a, glassmorphic shadow). Reuse for palette editor.
- `frontend/nginx.conf:18-29` — proxies /geoserver/* → service. Add `/api/*` → api service.
- `frontend/src/app/pages/map/map.component.ts:819-861` — TileWMS sources currently OMIT `STYLES` param. We'll inject the user's chosen style here.

### Backend pattern (extracted from finance-tracker, the most mature)
- `main.ts` : NestFactory.create → ConfigService → setGlobalPrefix('api') → enableCors → listen(0.0.0.0).
- Guard injected via constructor (not APP_GUARD), uses ConfigService.
- ConfigModule.forRoot({ isGlobal: true, load: [configuration] }).
- Failed-closed bootstrap in production (env var unset = boot fails).
- Tests : Jest, *.spec.ts colocated, mock ConfigService inline.

### GeoServer style management
- `geoserver/provision.sh:199-224` — `upload_style()` does 2-step: POST /rest/workspaces/maritime/styles `{name, filename}` + PUT body `vnd.ogc.sld+xml`. Then PUT /rest/layers/maritime:<layer> `{defaultStyle:{name,workspace}}`.
- Decision : reuse this exact pattern for user palettes via NestJS HTTP service. Style names = `user_<userId>_<paletteSlug>` (workspace-scoped). Frontend WMS adds `&STYLES=maritime:user_42_marine` per layer per user.

### Database (Drizzle ORM)
- Use existing Postgres (`maritime` DB on port 15432). Add 3 tables in a new schema or root :
  - `users(id serial PK, email TEXT UNIQUE, password_hash TEXT, created_at TIMESTAMP)`
  - `palettes(id serial PK, user_id FK, name TEXT, layer_kind TEXT, stops JSONB, opacity REAL, created_at, updated_at)` — `layer_kind` ∈ {sst, wind, waves, wave-dir} validates which layer the palette can apply to.
  - `user_layer_preferences(user_id, layer_kind, palette_id FK)` — composite PK `(user_id, layer_kind)`. Maps "which palette this user wants for which layer".
- Drizzle migrations in `services/api/drizzle/`.

### Trade-off resolved : pre-register vs SLD_BODY
Pre-register wins for this use case:
- Frontend stays simple (`&STYLES=user_42_marine` vs ~2KB inline SLD per tile)
- GWC tile cache works correctly (cache key includes STYLES param)
- 5 palettes × 50 users = 250 styles → trivial for GeoServer catalog
- Cleanup on palette delete is one DELETE call to GeoServer REST

### Testing patterns (reused from finance-tracker)
- Jest, mock ConfigService + Drizzle client inline
- ≥10 specs targeted : auth-register, auth-login (success + bad pwd + duplicate email), palettes CRUD (create + list + update + delete + 5-limit), preferences upsert, JwtAuthGuard valid+invalid token.

## Inferred Acceptance Criteria

- AC1: User can register via email+password (bcrypt hashed in DB), login returns JWT 24h.
- AC2: Authenticated user can CRUD their palettes (max 5, layer-scoped); unauthorized callers get 401.
- AC3: When user creates/updates palette, a corresponding GeoServer style `user_<id>_<slug>` is POSTed/PUTed via REST.
- AC4: Authenticated user can set "preferred palette per layer" via PUT /me/preferences.
- AC5: Frontend renders /login, /register, /palettes pages with full CRUD UI (gradient editor + drag stops + color picker + live preview).
- AC6: When authenticated, the map's TileWMS sources for SST/wind/waves include `&STYLES=maritime:user_<id>_<slug>` matching the user's preference. Anonymous users see the default styles unchanged.
- AC7: ≥10 new Jest specs in services/api covering auth flow + palettes CRUD + 5-limit enforcement + JwtAuthGuard.
- AC8: Stack deploys cleanly to NAS (docker-compose up adds maritime-api container, nginx proxies /api/*).
