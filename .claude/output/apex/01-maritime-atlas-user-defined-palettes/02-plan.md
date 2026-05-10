# Step 02: Plan

**Task:** Système d'auth (email+password) + écran de configuration de palettes SLD utilisateur (max 5/user) avec override defaultStyle WMS via param {{task_description}}styles=user_xyz_palette
**Started:** 2026-05-10T20:48:44Z

---

## Planning Progress

_Implementation plan will be written here..._

## Implementation Plan: User-Defined Palettes

### Overview
Add a new NestJS 11 service `services/api` (Postgres + Drizzle + JWT) for user accounts and palette CRUD. Mirror each user-saved palette as a workspace-scoped GeoServer style (`user_<id>_<slug>`). Frontend gets login/register pages, a palette editor at `/palettes`, and per-toggle dropdowns in the legend that inject `&STYLES=maritime:user_<id>_<slug>` into the WMS layers via OL `updateParams`.

### Prerequisites
- Postgres `maritime` DB already up (port 15432, timescaledb-ha)
- GeoServer REST endpoint already accepting style POST/PUT
- Node 22 in build images

---

### File Changes

#### Commit 1 — Backend `services/api` (NEW)

##### `services/api/package.json` (NEW)
- NestJS 11 deps: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/config`, `@nestjs/jwt`, `@nestjs/passport`
- Postgres + ORM: `drizzle-orm`, `postgres` (driver), `drizzle-kit` (dev)
- Auth: `bcryptjs`, `passport`, `passport-jwt`, `class-validator`, `class-transformer`
- Test: `jest`, `@nestjs/testing`, `supertest`
- Scripts: `start`, `start:dev`, `build`, `test`, `db:generate`, `db:migrate`

##### `services/api/Dockerfile` (NEW)
- Multi-stage Node 22-alpine builder → runtime (mirror finance/warhammer/ol pattern)

##### `services/api/tsconfig.json` (NEW)
- ES2022 target, strict mode, decorators on, NodeNext modules

##### `services/api/src/main.ts` (NEW)
- NestFactory.create → ConfigService → setGlobalPrefix('api') → enableCors(corsOrigin) → listen(3010, '0.0.0.0')
- Validation pipe global (whitelist: true, transform: true)

##### `services/api/src/app.module.ts` (NEW)
- ConfigModule.forRoot({ isGlobal: true, load: [configuration] })
- Imports: DbModule, AuthModule, PalettesModule, PreferencesModule, GeoServerModule

##### `services/api/src/config/configuration.ts` (NEW)
- Pattern from finance-tracker: PORT=3010, DATABASE_URL, JWT_SECRET, GEOSERVER_URL/USER/PASS, NODE_ENV
- Fail-closed: if NODE_ENV=production and JWT_SECRET empty → boot fails

##### `services/api/src/db/schema.ts` (NEW)
- Drizzle schema for 3 tables:
  - `users(id serial PK, email text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz default now())`
  - `palettes(id serial PK, user_id int FK users, name text NOT NULL, slug text NOT NULL, layer_kind text NOT NULL, stops jsonb NOT NULL, opacity real default 0.7, created_at, updated_at, UNIQUE(user_id, slug))`
  - `user_layer_preferences(user_id int FK PK, layer_kind text PK, palette_id int FK)`
- `layer_kind` ENUM constraint: `('sst','wind','waves','wave-dir')`

##### `services/api/src/db/db.module.ts` + `db.service.ts` (NEW)
- Drizzle client provider, injects `postgres` driver with ConfigService.DATABASE_URL
- Exposes `db: PostgresJsDatabase<typeof schema>` for injection

##### `services/api/drizzle/0000_init.sql` (NEW)
- Generated migration for the 3 tables
- Run on first boot via `db:migrate` script (init container) OR auto-run in main.ts before listen

##### `services/api/src/auth/auth.module.ts` + `auth.service.ts` + `auth.controller.ts` (NEW)
- Module: imports JwtModule.registerAsync({ secret: ConfigService.jwtSecret, signOptions: { expiresIn: '24h' }})
- Service: register(email, password) — hash with bcrypt + insert + return JWT; login(email, password) — compare + return JWT
- Controller: POST /api/auth/register, POST /api/auth/login (DTO with email + password validation)

##### `services/api/src/auth/jwt-auth.guard.ts` (NEW)
- Custom guard (no Passport for simplicity): extract Bearer token, jwtService.verify, attach req.user
- Throws UnauthorizedException on missing/invalid token

##### `services/api/src/auth/jwt-auth.guard.spec.ts` (NEW) — TEST 1, 2
- Test: missing Authorization header → 401
- Test: invalid token → 401
- Test: valid token → req.user populated, returns true

##### `services/api/src/auth/auth.service.spec.ts` (NEW) — TEST 3, 4, 5, 6
- Test: register new email → hashed password stored, JWT returned
- Test: register duplicate email → ConflictException
- Test: login good credentials → JWT returned
- Test: login bad password → UnauthorizedException

##### `services/api/src/palettes/palettes.module.ts` + `palettes.service.ts` + `palettes.controller.ts` (NEW)
- Service: CRUD operations + enforce `≤5 palettes per user`. On create/update, calls GeoServerService.upsertStyle(); on delete, calls GeoServerService.deleteStyle().
- Controller: GET /api/palettes (current user), POST /api/palettes (DTO: name, layer_kind, stops, opacity), PUT /api/palettes/:id, DELETE /api/palettes/:id
- @UseGuards(JwtAuthGuard) on all routes

##### `services/api/src/palettes/palettes.service.spec.ts` (NEW) — TEST 7, 8, 9, 10
- Test: create 5 palettes succeeds, 6th throws BadRequestException
- Test: update palette → GeoServerService.upsertStyle called with new stops
- Test: delete palette → DB row removed + GeoServerService.deleteStyle called
- Test: cross-user isolation — userA cannot read/update userB's palette

##### `services/api/src/preferences/preferences.module.ts` + `preferences.service.ts` + `preferences.controller.ts` (NEW)
- Controller: GET /api/me (returns user + palettes + preferences), PUT /api/me/preferences (body: { layer_kind, palette_id | null })
- Service: upsert into user_layer_preferences

##### `services/api/src/preferences/preferences.service.spec.ts` (NEW) — TEST 11
- Test: PUT preference for layer → upserts row, returns mapping; null palette_id clears preference

##### `services/api/src/geoserver/geoserver.module.ts` + `geoserver.service.ts` (NEW)
- HTTP client for GeoServer REST. Methods:
  - `upsertStyle(styleName: string, sldXml: string)` — POST /styles + PUT body, idempotent
  - `deleteStyle(styleName: string)` — DELETE /styles/:name?recurse=true&purge=all
- `buildSldFromPalette(palette)` — generates the SLD XML from the palette's stops + layer_kind. Uses RasterSymbolizer ColorMap pattern (mirror existing static SLDs in `geoserver/styles/`).

##### `services/api/src/geoserver/geoserver.service.spec.ts` (NEW) — TEST 12 (bonus)
- Test: buildSldFromPalette generates valid SLD XML for a 3-stop palette

#### `docker-compose.yml` (MODIFY)
- Add `api` service: build ./services/api, port 3010, env_file .env, env DATABASE_URL/JWT_SECRET/GEOSERVER_URL/USER/PASS, depends_on: postgres healthy + geoserver healthy

#### `frontend/nginx.conf` (MODIFY)
- Add `location /api/ { proxy_pass http://api:3010/api/; ... }`

#### `db/init/03-api-schema.sql` (NEW, optional)
- Or rely on Drizzle migrations applied at api startup via `db:migrate` script.
- Decision: Drizzle migrations run inside the container at boot to keep schema in code.

---

#### Commit 2 — Frontend Angular

##### `frontend/src/app/services/auth.service.ts` (NEW)
- `register(email, password)`, `login(email, password)`, `logout()`
- Signals: `currentUser = signal<{id, email} | null>(null)`, `isAuthenticated = computed(() => !!currentUser())`
- Persists token in localStorage; reads at boot

##### `frontend/src/app/interceptors/auth.interceptor.ts` (NEW)
- Functional interceptor: if token exists, set `Authorization: Bearer <token>` on /api/* requests

##### `frontend/src/app/services/palettes.service.ts` (NEW)
- CRUD wrappers + `getMe()` + `setPreference(layerKind, paletteId)`. Exposes `myPalettes = signal<Palette[]>([])`, `myPreferences = signal<Record<string, number | null>>({})`.

##### `frontend/src/app/app.config.ts` (MODIFY)
- Wire `withInterceptors([authInterceptor])` in provideHttpClient

##### `frontend/src/app/app.routes.ts` (MODIFY)
- Add: /auth/login (LoginComponent), /auth/register (RegisterComponent), /palettes (PalettesPageComponent — guard via `canActivate: [authGuard]`)

##### `frontend/src/app/auth/auth.guard.ts` (NEW)
- functional CanActivate that redirects to /auth/login if not authenticated

##### `frontend/src/app/pages/auth/login.component.ts` + `register.component.ts` (NEW)
- Standalone signal-driven form (FormControl Reactive forms is overkill — use plain signals + 2 inputs)
- Theme-consistent (use --bg, --accent, --border tokens)

##### `frontend/src/app/pages/palettes/palettes-page.component.ts` (NEW)
- Lists user's palettes (max 5)
- "+ Nouvelle palette" button → opens PaletteEditorComponent in modal/inline mode
- Each palette card has Edit/Delete buttons

##### `frontend/src/app/components/palette-editor/palette-editor.component.ts` (NEW)
- Visual gradient bar with draggable stops (HTML/SVG)
- Color picker for selected stop (use native `<input type="color">` for simplicity)
- Range slider for opacity per stop
- Layer kind selector (sst/wind/waves/wave-dir)
- Live preview gradient
- Save/Cancel buttons

##### `frontend/src/app/pages/map/map.component.ts` (MODIFY)
- Inject AuthService + PalettesService
- In `initMap()` and on signals change: read user preferences. For each layer (SST/wind/waves), if preference exists, set `STYLES=maritime:user_<id>_<slug>` in the TileWMS source params. Otherwise no STYLES (keeps default).
- Add a small palette-dropdown next to each toggle in the legend (only if authenticated, and palettes exist for that layer kind)
- Effect that watches `palettes()` + `preferences()` + applies via `windSource.updateParams({ STYLES: ... })` etc.
- Top-right corner: small login/logout indicator + link to /palettes

---

### Testing Strategy

**Backend (Jest, services/api/) — 12 specs total:**
- jwt-auth.guard.spec.ts × 3
- auth.service.spec.ts × 4
- palettes.service.spec.ts × 4
- preferences.service.spec.ts × 1
- geoserver.service.spec.ts × 1 (buildSld)

**Frontend** (deferred to a follow-up — Angular project doesn't yet have specs file infrastructure; out of scope for sprint 5)

**Manual e2e validation via Playwright:**
- Register → login → create palette → see it applied on map → delete → reverts to default

---

### Acceptance Criteria Mapping

- [ ] AC1 (auth) → `auth.service.ts` + `auth.controller.ts` + tests
- [ ] AC2 (palette CRUD ≤5) → `palettes.service.ts` + tests
- [ ] AC3 (GeoServer style mirror) → `geoserver.service.ts` upsert/delete called from PalettesService
- [ ] AC4 (preferences) → `preferences.service.ts` + endpoint
- [ ] AC5 (frontend login/register/palettes pages) → 4 new components + routing
- [ ] AC6 (TileWMS STYLES injection) → map.component.ts effect that watches preferences + updates params
- [ ] AC7 (≥10 specs) → 12 Jest specs above
- [ ] AC8 (deploy clean) → docker-compose + nginx.conf updated, smoke tested via /api/me after login

---

### Risks & Considerations

- **Drizzle migration timing** : if api starts before postgres is ready or migration fails, container will crashloop. Mitigation: depends_on healthy + retry loop in main.ts with 5s backoff (mirror sst-fetcher pattern).
- **GeoServer style cleanup** : if api creates a style but DB transaction rollbacks, orphan style in GeoServer. Mitigation: best-effort try/catch in PalettesService.create — if GeoServer call fails, delete the DB row.
- **Frontend fallback for unauthenticated** : if user not logged in, palette dropdowns hidden; layers use defaultStyle. Already covered by the `currentUser()` signal.
- **JWT in localStorage** : XSS risk. Acceptable for self-hosted dev tool / demo; not production-grade. Document in README.
- **Slug collision** : two palettes with same name → DB has UNIQUE(user_id, slug); slug derived from name kebab-case. If collision, append `-2`, `-3` etc. (handle in PalettesService).

---

### Commit Plan
- **Commit 1**: feat(api): NestJS 11 service for auth + palettes + preferences (backend complete + 12 Jest specs + docker-compose wiring)
- **Commit 2**: feat(frontend): login/register/palette-editor + WMS STYLES override per user

---

## Step Complete
**Status:** ✓ Complete
**Files planned:** ~28 (24 new + 4 modify)
**Tests planned:** 12 Jest specs
**Next:** step-03-execute.md
**Timestamp:** 2026-05-10T20:50:00Z
