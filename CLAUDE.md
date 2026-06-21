# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity
- Project: Crisis Reporter — UNDP Crisis Mapping Challenge
- Platform: InnoCentive
- Prize: $50,000
- Deadline: June 23, 2026
- Builder: Solo developer using Claude Code as primary development tool
- Repository: https://github.com/ai711/crisis-reporter

## What This System Is
Crisis Reporter is an end-to-end crisis damage reporting system. Community reporters submit damage reports (photos, location, damage classification) from any device with any connectivity level. UNDP staff review all reports through a secure web dashboard.

## Folder Structure
```
crisis-reporter/
├── backend/       FastAPI, PostgreSQL models, Redis, ARQ worker
├── web/           React + Vite — reporter web app and PWA (Tier B + C)
├── dashboard/     React + Vite — UNDP dashboard (separate app)
├── mobile/        React Native + Expo — Android app (Tier A)
├── shared/        Shared TypeScript types and API contracts
├── data/          Building footprint processing scripts
├── docs/          Technical Architecture Document and specs
├── CLAUDE.md      This file
├── .env.example   All environment variables with placeholders
└── .gitignore     Never commit .env files
```

## Development Commands

### Backend
```bash
cd backend

# Activate venv (Windows)
.\venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run dev server (port 8000)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Run ARQ worker (separate terminal)
arq app.worker.WorkerSettings

# Generate a Fernet key (run once, store in .env)
python -c "from app.services.encryption import generate_fernet_key; print(generate_fernet_key())"
```

Schema migrations are **not Alembic-managed** — they run as raw SQL in `_MIGRATIONS` list in `backend/app/main.py` at every startup (all statements use `IF NOT EXISTS` guards, so they are idempotent). To add a migration, append to the `_MIGRATIONS` list. Do not create separate Alembic revision files for new columns.

### CRITICAL — Migration Rule (read before every model edit)

`Base.metadata.create_all` only creates **tables that do not yet exist**. It never adds columns to existing tables. This means:

> **Every column added to an existing SQLAlchemy model MUST have a corresponding `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statement appended to `_MIGRATIONS` in the same commit.**

Existing tables (at-risk — were created at the initial Railway deployment):
`reports`, `reporters`, `flag_events`, `photos`, `crises`, `dashboard_users`, `roles`

New tables added after the initial deployment are safe — `create_all` builds them in full from the model. Examples: `properties`, `property_comments`, `report_projects`, `project_users`, `notifications`, `reporter_activity_log`, `translation_audit_log`, etc.

**Checklist — run mentally before committing any change to `backend/app/models/`:**

1. Is the table in the at-risk list above?
   - No → `create_all` handles it, no migration needed.
   - Yes → continue.
2. Is this a new column (didn't exist in the model before this commit)?
   - Yes → append to `_MIGRATIONS`:
     ```python
     "ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <col> <TYPE> <DEFAULT?>",
     ```
3. Does the column have `nullable=False` without a `server_default`?
   - Yes → add a `DEFAULT` to the migration SQL (or existing rows will NULL-violate on the next `NOT NULL` check).
4. Does the column have `unique=True` or an `Index()` in `__table_args__`?
   - Yes → also append a `CREATE UNIQUE INDEX IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statement.
5. Does the column use a renamed DB column via `mapped_column("db_col_name", ...)`?
   - Yes → the migration must use the **DB column name** (the string argument), not the Python attribute name. Example: `flag_metadata = mapped_column("metadata", JSON)` → migrate as `ADD COLUMN IF NOT EXISTS metadata JSONB`.

**Migration template:**
```python
# <Model>.<attribute> — one-line reason why this was added
"ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <db_col> <PGTYPE>",
# Optional index:
"CREATE INDEX IF NOT EXISTS ix_<table>_<col> ON <table>(<db_col>)",
```

**Renaming a column** — add both `ALTER TABLE ... RENAME COLUMN ... TO ...` and a comment explaining the rename. Do not add `ADD COLUMN` + `DROP COLUMN` — data loss.

**Changing a column type** — use `ALTER TABLE ... ALTER COLUMN ... TYPE ... USING ...`. Never drop-and-recreate.

### Diagnosing "stuck grey reports"

Grey reports that never transition are always caused by `auto_flag_report` crashing. To diagnose without reading logs:

1. Call `POST /api/settings/retry-stuck-reports` (superadmin JWT required, use `/api/docs`).
2. The response body contains per-report `status` and full `error` traceback.
3. The error will name the missing column exactly — add the migration, push, redeploy, retry.

The stuck-report monitor (`_stuck_report_loop`) also runs immediately on every startup and re-queues stuck reports automatically.

API docs available at `http://localhost:8000/api/docs` when the dev server is running.

### Web/PWA (reporter app)
```bash
cd web
npm install
npm run dev        # Vite dev server — http://localhost:5173
npm run build      # TypeScript check + Vite build
npm run lint       # ESLint
npm run preview    # Preview production build
```

### Dashboard (UNDP staff app)
```bash
cd dashboard
npm install
npm run dev        # Vite dev server — http://localhost:5174
npm run build      # TypeScript check + Vite build
npm run lint       # ESLint
```

### Mobile (Android)
```bash
cd mobile
npm install
npx expo start         # Start Expo dev server
npx expo run:android   # Run on connected Android device/emulator
```

## Git Workflow — Rules

### CRITICAL — Never amend a pushed commit
`git commit --amend` rewrites the current HEAD commit in place. If that commit has already been pushed to `origin/main`, the rewritten commit gets a new SHA and local history diverges from remote. This requires a force-push (destructive) or a rebase to reconcile.

**Rule:** use `--amend` only on commits that have NOT been pushed yet.

**If you need to fix something already pushed:** create a new commit on top instead.
```bash
# Wrong — rewrites pushed history:
git commit --amend

# Right — adds a fixup on top:
git add <file>
git commit -m "fix: correct <whatever>"
git push origin main
```

**If divergence already happened** (push rejected with "non-fast-forward"):
```bash
git fetch origin
git rebase origin/main   # replays your local-only commits on top of remote HEAD
git push origin main
```

### EAS Build — eas.json schema rules
- `env` belongs **inside each build profile** (`build.development.env`, etc.), not at the top level of `eas.json`. A top-level `env` key is not valid and will fail schema validation with `eas.json is not valid`.
- `cli.appVersionSource` must be `"local"` — required by EAS CLI and consistent with `runtimeVersion.policy: "appVersion"` in `app.json`.
- All three profiles (`development`, `preview`, `production`) must have a `channel` set for `expo-updates` to work.

## Architecture — Backend

### Request Flow
1. Reporter submits report → `POST /api/reports` (`backend/app/routers/reports.py`)
2. Report saved with `flag_status="grey"`
3. `auto_flag_report()` runs as a **FastAPI BackgroundTask** (not ARQ) — `backend/app/services/auto_flagging.py`
4. Auto-flagging transitions flag to green/orange/red, writes a `FlagEvent`, then publishes to Redis pub/sub channel `dashboard:{crisis_id}`
5. Dashboard SSE endpoint (`backend/app/routers/dashboard_sse.py`) streams the event to connected clients

### Key Entry Points
- `backend/app/main.py` — FastAPI app, lifespan hooks, migration runner, background loops, all router registration
- `backend/app/config.py` — All settings via `pydantic-settings`; reads from `.env` automatically
- `backend/app/database.py` — Async engine (`asyncpg`), `AsyncSessionLocal`, `Base`, `get_db` dependency

### Models (backend/app/models/)
| File | Table | Notes |
|------|-------|-------|
| `report.py` | `reports` | Core report; `flag_status` drives all export/review logic |
| `reporter.py` | `reporters` | Both anonymous (device-only) and verified (email+pw); PII fields are Fernet-encrypted with a separate SHA-256 hash column for indexed lookups |
| `crisis.py` | `crises` | Named project/event; serial ID format `PR-XXXX`; `status` ∈ active/closed/archived |
| `dashboard_user.py` | `dashboard_users` | UNDP staff; `role` ∈ superadmin/admin/custom-role-name |
| `role.py` | `roles` | Custom permission roles; `permissions` JSONB maps section keys → `{view, edit}` |
| `flag_event.py` | `flag_events` | Immutable audit trail every time a flag changes |
| `photo.py` | `photos` | One report → many photos; `storage_path` is the key passed to StorageService |
| `language_package.py` | `languages`, `string_keys`, `translations` | Full translation governance system |
| `report_project.py` | `report_projects` | Many-to-many join: reports ↔ crises |
| `project_user.py` | `project_users` | Dashboard user access per crisis/project |
| `question_package.py` | `question_packages`, `questions`, `question_options` | Versioned question packages; draft/publish workflow; active package is fetched by reporter apps on startup |
| `app_setting.py` | `app_settings` | Key/value store for runtime-configurable system settings |
| `report_edit.py` | `report_edits` | Audit trail for dashboard edits to submitted reports |
| `health_incident.py` | `health_incidents` | (reserved for future use) |
| `safety_progress.py` | `safety_progress` | Per-reporter progress through safety tips module |

### Services (backend/app/services/)
- `encryption.py` — `encrypt_field(str)→bytes`, `decrypt_field(bytes)→str`, `hash_field(str)→str` (SHA-256). All PII stored as `*_encrypted` + `*_hash` column pairs.
- `storage.py` — `StorageService` ABC with `LocalFileSystemStorage` and `CloudflareR2Storage`. Factory `get_storage_service()` reads `STORAGE_BACKEND` env var. A singleton `storage_service` is created at import time.
- `auto_flagging.py` — Runs as a BackgroundTask immediately after each report submission. Thresholds are a module-level dict (`_thresholds`) updated at runtime via `PATCH /api/flag-rules`. Full 9-rule evaluation order documented in the Auto-Flagging Order section below. On Green/Orange outcome, calls `get_or_create_property` to link the report to its property record and sets `report.property_id`.
- `dependencies.py` — FastAPI dependency injectors: `get_current_dashboard_user`, `get_current_reporter`, `get_optional_reporter`, `require_admin`, `require_superadmin`, `require_section_access(section_key, require_edit)`.
- `auth.py` — JWT encode/decode. Tokens carry a `ctx` claim (`"dashboard"` or `"reporter"`) to prevent cross-context token reuse.

### Routers (backend/app/routers/)
All routers are prefixed with `/api`. Key ones:
- `reports.py` — `POST /api/reports` (submit), `GET /api/reports/{id}`
- `reporter_auth.py` — Anonymous register, verified register/login, token refresh; sets/clears HttpOnly cookies on login/logout
- `dashboard_auth.py` — Staff login/logout, token refresh, password change; sets/clears HttpOnly cookies on login/logout; login rate-limiting via Redis
- `dashboard_sse.py` — `GET /api/dashboard/stream` SSE endpoint; uses Redis pub/sub per `crisis_id`; authenticates via HttpOnly cookie (`withCredentials`)
- `exports.py` — Export jobs (CSV, GeoJSON, Shapefile, GeoPackage, RAPIDA); signed download URLs
- `flag_rules.py` — `PATCH /api/flag-rules` to update auto-flagging thresholds at runtime
- `language_packages.py` — Translation management (4 sub-routers: languages, packages, keys, translations)
- `review_queue.py` — Redis-backed soft-lock system (15-min claim window per reviewer)
- `content.py` — `/api/content` — CMS for T&C, onboarding slides, reporting guidelines, first aid, FAQ, safety tips, disaster types, crisis types, error/system messages; all content types feed the translation pipeline
- `question_packages.py` — `/api/question-packages` — versioned question packages; draft → publish workflow; `GET /api/question-packages/active` is public (reporter apps call on startup)

### Background Loops (started in lifespan)
Four `asyncio.create_task` loops run perpetually:
- `_stuck_report_loop` — promotes stuck grey reports
- `_auto_block_confirmation_loop` — auto-confirms unreviewed reporter blocks after configurable window
- `_pause_expiry_loop` — clears expired submission pauses every 15 min
- `_remove_expired_deprecated_languages_loop` — daily hard-delete of deprecated languages

### Startup Seeding
Every startup (idempotent): `seed_initial_package()`, `seed_string_keys()`, `seed_countries()`, `seed_first_admin()`, `_seed_default_roles()`, `_seed_notification_types()`. Default admin: `admin@crisisreporter.org` / `Admin2026` (reset on every startup).

## Architecture — Web/PWA (reporter app)

### Key Files
- `web/src/services/api.ts` — Axios instance with `withCredentials: true`. JWT tokens are stored as **HttpOnly cookies** (XSS-safe); `localStorage` only stores `cr_reporter_id` as a session presence indicator. **Token refresh is at the HTTP layer, never the UI layer.**
- `web/src/utils/offlineQueue.ts` — IndexedDB store `crisis_reporter/report_queue`. Reports written here when offline; synced when online. Each entry has a `local_id` that is echoed to the backend to prevent duplicates on retry.
- `web/src/services/auth.ts` — `flushPendingAnonRegistration()` retries a failed offline anonymous registration. Runs on startup and on every `online` event so queued reports always have a real `reporter_id` before they sync.
- `web/src/App.tsx` — Route guard checks `cr_country`, `cr_language` (onboarding), `cr_tc_accepted` (T&C). Incomplete onboarding redirects to `/onboarding` with `?next=` for post-completion redirect. Arabic sets `document.documentElement.dir="rtl"` automatically; all other UN languages use `ltr`.
- `web/src/i18n.ts` — i18next config. Language packs are fetched from the API and cached. `loadLanguagePackageFromCache()` is called on every route change to prevent drift back to English.

### localStorage Keys
`cr_reporter_id` (session presence indicator only — tokens are in HttpOnly cookies), `cr_country`, `cr_language`, `cr_tc_accepted`, `cr_tc_version`

### VITE_API_URL
Set this env var to point to the backend. Defaults to `http://127.0.0.1:8000`.

## Architecture — Dashboard (UNDP staff app)

### Key Files
- `dashboard/src/services/api.ts` — Axios instance with `withCredentials: true`. Same HttpOnly cookie auth as web; `tokenStorage` is kept as a thin interface for `isAuthenticated()` calls but stores no raw tokens.
- `dashboard/src/hooks/useSSE.ts` — Connects to `GET /api/dashboard/stream?crisis_id=…` with `withCredentials: true` (HttpOnly cookie authenticates the EventSource). Auto-reconnects after 5s on error.
- `dashboard/src/stores/authStore.ts` — Zustand store; persists user profile including `role_permissions` (JSONB from `roles` table).
- `dashboard/src/App.tsx` — `ProtectedRoute` checks `isAuthenticated()` + optional `requiredRole` or `requiredSection`. Section keys: `main_map_view`, `reports_page`, `location_page`, `review_queue`, `analytics_and_statistics`, `reporter_profiles`, `export`, `projects`, `manage_users`, `manage_roles`, `app_configuration`, `content_management`.

### Dashboard Route Map
`/map` → MainMapPage, `/reports` → ReportsPage, `/locations` → LocationsPage (properties), `/review-queue` → ReviewQueuePage, `/analytics` → AnalyticsPage, `/reporters` → ReportersPage, `/export` → ExportPage, `/projects` → ProjectsPage, `/users` → UserManagementPage, `/roles` → ManageRolesPage, `/settings` → SystemSettingsPage, `/content` → ContentManagementPage

### Edit Report Feature

**File:** `dashboard/src/pages/ReportDetailPage.tsx` — Edit Report modal + display logic  
**Endpoint:** `PATCH /api/reports/{report_id}` — `backend/app/routers/reports.py` — `EditReportRequest`  
**Audit trail:** every successful edit writes a `ReportEdit` row (`backend/app/models/report_edit.py`), readable at `GET /api/reports/{id}/edits`

#### Editable fields (all optional — backend only records changed values)

| Field | Type | Backend Literal validation |
|-------|------|---------------------------|
| `damage_level` | single-select | `minimal` \| `partial` \| `complete` |
| `disaster_type` | single-select | 9 values matching Q4 option_values |
| `infrastructure_types` | multi-select (array) | none — free list |
| `infrastructure_name` | text | none |
| `debris_blocking` | single-select | `yes` \| `no` |
| `electricity_condition` | single-select | `no_damage` \| `minor` \| `moderate` \| `severe` \| `destroyed` \| `unknown` |
| `health_services_condition` | single-select | `functional` \| `partial` \| `disrupted` \| `not_functioning` \| `unknown` |
| `pressing_needs` | multi-select (array) | none — free list |
| `location_lat` + `location_lng` | coordinate pair | must be provided together; sets `location_source = "manual"` |
| `edit_reason` | text | required |

Empty string values are filtered from the payload on the frontend — selecting `— Not recorded —` in a dropdown is a no-op (field not sent, backend ignores it).

**Known limitation:** text fields (`infrastructure_name`) cannot be cleared to null via the edit modal — an empty string is filtered out. Set to a placeholder value (e.g., "N/A") if clearing is needed.

#### CRITICAL — Display priority rule (Q6/Q7/Q8)

PWA submissions store Q6 (electricity), Q7 (health), Q8 (pressing needs) in the `question_answers` JSONB array with human-readable `option_text` values. The top-level columns (`report.electricity_condition`, `report.health_services_condition`, `report.pressing_needs`) are also stored at submission time for Android, but may be null for older PWA reports.

**The rule:** top-level DB columns ALWAYS take priority over `question_answers` in both the display logic and the edit modal pre-population. Reasons:
1. Admin edits update only the top-level columns — if `question_answers` were given priority, edits would be invisible immediately after save.
2. Android reports (no `question_answers`) must render correctly using the top-level columns.
3. Raw option_values (`"no_damage"`, `"food_water"`) are formatted via label maps (`ELECTRICITY_LABELS`, `HEALTH_LABELS`, `PRESSING_NEEDS_LABELS`) defined at the top of `ReportDetailPage.tsx`.

**Correct display pattern:**
```tsx
// electricity — top-level column wins, formatted; falls back to Q6 text
const electricityValue = report.electricity_condition
  ? (ELECTRICITY_LABELS[report.electricity_condition] ?? report.electricity_condition)
  : (q6?.option_text ?? q6?.option_value ?? null);
```

**Do NOT regress this to:** `q6?.option_text ?? q6?.option_value ?? report.electricity_condition` — that was the original bug.

Same rule applies to `debris_blocking` in the Damage Assessment Matrix: use `report.debris_blocking` as authoritative and only fall back to `q5?.option_value` when the column is null.

#### GPS coordinate workflow for text-only reports (no location)

Reports with no GPS and no building tap are auto-flagged Red by Rule 4 (`no_location`). The correct admin workflow is:

1. Report arrives Red.
2. Admin discards it: Red → Discarded.
3. Admin opens Edit Report modal — a "Add Building Coordinates" section appears (only shown when `report.location_lat == null`).
4. Admin looks up the building in Google Maps, enters lat/lng.
5. Backend sets `location_lat`, `location_lng`, `location_source = "manual"`.
6. Admin reinstates: Discarded → Orange.
7. `get_or_create_property` fires on reinstate and creates the property record using the now-set coordinates.

The coordinate section in the modal is gated on `report.location_lat == null` — it does not appear for reports that already have coordinates (building centroid, pin drop, or device GPS).

## Architecture — Mobile (Android)

Built with Expo SDK 56 / React Native 0.81. Managed workflow — no `android/` edits. Map via `@maplibre/maplibre-react-native`. Offline queue uses `expo-file-system`. Push notifications via `expo-notifications` (FCM). Build APK with `eas build --platform android`.

**Offline queue reliability:** `syncQueue` uses exponential backoff between retries (2, 4, 8, 16, 30 min) so a temporarily unreachable server doesn't burn all retries rapidly. When `FileSystem.copyAsync` fails for a queued photo, `copy_failed` is flagged on that `QueuedPhoto` entry and the confirmation screen shows an amber warning prompting the user to sync while the app is open. Notification taps deep-link to the specific queued report via `local_id`.

**Bearer-header auth:** Android uses `Authorization: Bearer <token>` with tokens in `SecureStore`. The backend refresh endpoint accepts both cookie (web) and request-body token (mobile) so mobile auth is unaffected by the HttpOnly cookie migration.

## Locked Technical Decisions — Never Re-Open These

### Database
- NEVER use offset pagination — cursor-based pagination ONLY throughout
- All list endpoints anchor on record ID or timestamp cursor

### Authentication
- JWT throughout (PyJWT + passlib bcrypt)
- Dashboard staff: email + password, JWT; `ctx="dashboard"` claim
- Reporter verified: email + password, JWT; `ctx="reporter"` claim
- Reporter anonymous: device UUID only, no JWT
- Access token TTL: 60 minutes | Refresh token TTL: 30 days

**Token transport — two modes, one backend:**
- **Web PWA + Dashboard** → HttpOnly cookies (`cr_access_token`, `cr_refresh_token`). Set by the server on login/refresh; cleared on logout. `axios` uses `withCredentials: true`. `localStorage` never holds raw tokens. This is the XSS-safe path.
- **Android (React Native)** → `Authorization: Bearer <token>` header, tokens stored in `SecureStore`. Refresh endpoint accepts both cookie and request-body token, so mobile clients are unaffected by the cookie migration.
- `_extract_token()` in `dependencies.py` reads the cookie first, then falls back to the `Authorization` header — both paths reach the same JWT validation logic.

**Login security (dashboard only):** Redis-backed rate limiting — `LOGIN_RATE_LIMIT_ATTEMPTS` failed attempts within `LOGIN_RATE_LIMIT_WINDOW_MINUTES` triggers a `LOGIN_LOCKOUT_MINUTES` lockout for that IP. Configurable at runtime via System Settings.

**Inactivity timeout:** `INACTIVITY_TIMEOUT_MINUTES` (default 30) — dashboard frontend tracks last activity and forces re-login if exceeded.

### CRITICAL — Silent JWT Refresh
Token refresh MUST happen silently at the HTTP client layer (axios interceptor). It must NEVER interrupt an active form flow or report submission. This applies to both the PWA and the Android app.

### Photo Storage
- `STORAGE_BACKEND=local` → `LocalFileSystemStorage` (dev)
- `STORAGE_BACKEND=r2` → `CloudflareR2Storage` (prod)
- Switching requires zero code changes — only the env var
- `storage_service` singleton in `backend/app/services/storage.py`

### Photo Compression Thresholds (enforced in web/src/utils/photoCompression.ts)
- Under 1.5 MB: send as-is
- 1.5 MB–8 MB: compress to ~1 MB
- Above 8 MB: compress to ~1.5 MB

### Real-Time Updates
- SSE primary: `GET /api/dashboard/stream` (Redis pub/sub per `crisis_id`)
- Fallback: TanStack Query 20-second refetch when SSE drops
- Events: `report_confirmed`, `flag_changed`, `reporter_status_changed`, `review_queue_updated`, `heartbeat`

### Flag System
- `grey` → received, auto-checks in progress; excluded from exports by default; excluded from the Reports list by default (must explicitly filter to see)
- `green` → passed all checks; included in map and exports
- `orange` → manually approved from Red; included in map and exports
- `red` → one or more auto-checks failed; requires human review; excluded from map and exports by default
- `discarded` → manually marked as spam/invalid; permanently excluded from map, exports, and statistics; hidden from Reports list by default (must explicitly select Discarded filter to see); never deleted from the database

### Auto-Flagging Order
Runs in `backend/app/services/auto_flagging.py` as a FastAPI `BackgroundTask` (not ARQ) immediately after every report submission. **All 9 rules run regardless of earlier triggers.** Every rule that fires appends an entry to `triggered_rules`. A single `FlagEvent` is written at the end with the full list in `flag_metadata["triggered_rules"]`. The review queue popup displays all triggered rules with contextual links (matched reporter profiles, duplicate reports). Thresholds are configurable at runtime via `PATCH /api/flag-rules`.

**`triggered_rules` entry structure:**
```json
{"rule_id": "1b", "reason": "blocked_device", "metadata": {"matched_blocked_reporter_id": "...", ...}}
```

1. **Blocked device ID** — Two sub-rules both evaluated:
   - **1a** `reporter_blocked`: reporter's own profile is directly marked `is_blocked=True`
   - **1b** `blocked_device`: reporter's `device_id_hash` matches another manually-blocked profile; also auto-blocks the submitting reporter with a pending confirmation window (side effect always fires)
2. **IP blocked reporter match** `blocked_ip` — submission IP hash (`report.ip_address_hash`) matches a blocked reporter's `ip_address_hash`; fully active
3. **No photo** `no_photos` — report has zero photos (with a 20-second grace window for slow uploads on non-queued reports)
4. **No location** `no_location` — report has neither GPS coordinates nor a text address
5. **Coordinated GPS duplicate** `coordinated_gps_duplicate` — **DISABLED by default** (`gps_duplicate_enabled: false` in `_thresholds`). When enabled: a *different* reporter submitted from within ~100 m (configurable via `duplicate_radius_degrees`) in the last 24 h. Disabled because legitimate reporters often report the same damaged building. Enable via `PATCH /api/flag-rules {"gps_duplicate_enabled": true}` if needed.
6. **Rapid submission** `high_submission_rate` → also applies 24 h device pause — same reporter submitted ≥ 14 other reports (configurable via `rapid_submission_count`, triggers on the 15th) in the last 1 h (configurable via `rapid_submission_window_hours`); pause side effect fires unconditionally when Rule 6 triggers
7. **IP country mismatch** `ip_country_mismatch` — submission IP geolocates to a different country than the reporter's selected country; uses Redis-cached geolocation (24h TTL per IP hash) to stay within ip-api.com's 45 req/min free-tier limit; logs `WARNING` when throttled/unavailable so ops can monitor; VPN usage produces false positives. Set `IPAPI_KEY` env var to unlock 15,000 req/min if WARNING logs appear under sustained load.
8. **Same IP, multiple device IDs** `same_ip_multiple_devices` — ≥ `SAME_IP_DEVICE_THRESHOLD` distinct reporter IDs from the same IP hash in the last 24 h; metadata includes `other_reporters` list with `{id, display_id}` so reviewers can click through to each profile
9. **Duplicate image** `duplicate_image` — a photo on this report has the same SHA-256 hash as a photo on a previous report; metadata includes `matching_report_id` and `matching_report_serial_number` for reviewer cross-reference
10. **All pass** → Green — report appears on the map immediately and is included in all exports

**Property creation** — when a report reaches Green or Orange (either automatically or via manual approval), `get_or_create_property` runs in a separate session to create or update the property record and set `report.property_id`. This links the report to its Location Page.

### Auto-Flagging — High-Volume Architecture Notes

These improvements were applied after a code review (June 2026). Document is kept here so future work picks up from where we left off.

**Implemented (already in codebase):**
- **Shared Redis pool** — `auto_flagging.py` and `dashboard_sse.py` both receive the single `app.state.redis` pool via `init_redis()` called from main.py lifespan. No second pool is created. `publish_event` uses the shared pool directly (previously opened and closed a TCP connection on every flag-change event).
- **Rule 9 JOIN** — duplicate-image detection now uses 2 DB queries regardless of photo count (one for own hashes, one JOIN for match + serial number). Previously used 1 + N + 1 queries.
- **ip-api.com key** — `IPAPI_KEY` env var supported. When set it is appended to the geolocation URL, unlocking 15,000 req/min. Activate only if `WARNING` logs show Rule 7 being skipped under sustained load (unlikely at <1,000 reports/day given the 24h Redis cache).
- **Rule 3 fix** — queued reports with zero photos now correctly trigger the no_photos rule (the `was_queued` guard previously wrapped the entire rule block, not just the sleep).
- **Rule 1b fix** — auto-block side effect skips if reporter is already `pending_auto_block_confirmation` to prevent timer reset abuse.
- **Rule 7 narrowed except** — `base64.b64decode` / `decrypt_field` run outside the try block; only the external `_geolocate_ip_cached` network call is wrapped.

**Deferred — ARQ queue migration (do when volume exceeds ~1,000 reports/day):**

The current architecture uses FastAPI `BackgroundTask` for auto-flagging. If the server restarts mid-flight, in-progress tasks are lost and reports stay grey until the stuck-report monitor re-queues them (~5–10 min delay). The stuck-report monitor catches every case — this is resilience delay, not data loss.

When migrating to ARQ (already wired into the project at `backend/app/worker.py`):
1. Register `auto_flag_report` as an ARQ job function in `WorkerSettings` in `worker.py`.
2. In `backend/app/routers/reports.py`, replace `background_tasks.add_task(auto_flag_report, ...)` with `await request.app.state.arq_pool.enqueue_job("auto_flag_report", report_id, _defer_by=10)`.
3. In `monitor_stuck_grey_reports()` in `auto_flagging.py`, replace `asyncio.create_task(auto_flag_report(...))` with an ARQ enqueue call.
4. Ensure the Railway ARQ worker service is active and shares the same `REDIS_URL` as the web service.
5. Test: submit a report, kill the web server immediately, verify ARQ worker picks it up and flags it correctly.

The `_defer_by=10` in ARQ replaces the `asyncio.sleep(10)` in the current BackgroundTask — ARQ delays job execution by 10 seconds server-side so the report is committed before the job runs.

### Multilingual
- 6 UN languages: ar, zh, en, fr, ru, es (all `is_protected=TRUE`, cannot be deleted)
- Content translation: on-demand only via Translate button; LibreTranslate (primary) or Google Translate

### CRITICAL — i18n Coverage Rule
Every `t('key')` call added to any `.tsx`/`.ts` file in `web/src` or `mobile/src` MUST have a corresponding entry in `_SEED_KEYS` in `backend/app/routers/language_packages.py`. Adding the key to `en.json` alone is **not sufficient** — `en.json` is an English-only fallback; `_SEED_KEYS` is what makes a string translatable for Arabic, Chinese, French, Russian, and Spanish speakers.

**Two-system architecture (understand before editing):**
- **System A (pipeline):** `_SEED_KEYS` → DB (`string_keys` + `translations` tables) → auto-translate → publish → apps download at runtime. Supports all 6 UN languages.
- **System B (static fallback):** `web/src/locales/en.json` and `mobile/src/locales/en.json`. English only. Used as i18next fallback when the pipeline key is missing.

**Rule:** if a string must be localized (i.e. shown to reporters), it belongs in `_SEED_KEYS`. `en.json` entries without a matching `_SEED_KEYS` entry are silently English-only for non-English users.

**What the CI script is:** `scripts/check_i18n_coverage.py` is a local quality-gate script that scans every `t('key')` call in the entire frontend codebase (web + mobile) and cross-checks them against `_SEED_KEYS` and `en.json`. Run it before committing any i18n change. "CI" stands for Continuous Integration — on a build server this would run automatically on every pull request; for now it is a manual pre-commit check.

**Four checks performed:**

| Check | Severity | Meaning | Action |
|-------|----------|---------|--------|
| **CHECK B** | 🔴 Always blocking | Key used in code, absent from both `en.json` AND `_SEED_KEYS`. Even English sees a broken/empty string. | Add key to both `en.json` and `_SEED_KEYS`. |
| **CHECK A** | 🟡 Warning (`--strict` makes it fail) | Key in `en.json` (English fine) but absent from `_SEED_KEYS`. Non-English users always see English — silent bug. | Add key to `_SEED_KEYS`. |
| **CHECK C** | ℹ️ Info only, never blocks | Key in `_SEED_KEYS` but no literal `t()` call found. May be a dead key OR a dynamic/template-literal key the grep can't see. | Review — if truly dead, retire it; if dynamic, add prefix to `DYNAMIC_PREFIXES`. |
| **CHECK D** | 🟡 Warning (non-blocking) | Key used on one platform and in `_SEED_KEYS`, but absent from the OTHER platform's `en.json`. Offline static fallback fails on that platform. | Add the key to the missing platform's `en.json`. Suppress with `--no-platform-gap`. |

**CI enforcement:**
```bash
# Run from repo root — checks all literal t() calls
python scripts/check_i18n_coverage.py

# Strict mode — also fails on pipeline-gap keys (in en.json but not _SEED_KEYS)
python scripts/check_i18n_coverage.py --strict

# Suppress the dead-key info list (CHECK C) to reduce noise
python scripts/check_i18n_coverage.py --no-dead

# Suppress cross-platform locale gap warnings (CHECK D)
python scripts/check_i18n_coverage.py --no-platform-gap
```
Exit codes: 0 = pass, 1 = pipeline gap (strict only), 2 = English broken, 3 = both.

**How the script detects `t()` calls:** it uses a Python file walker (no external tools — works on Windows) with the pattern `(?<![A-Za-z0-9_$])t\(['"]key['"]` — this correctly catches both `t('key')` and `t('key', { defaultValue: '...' })` forms while excluding false matches like `.get('window')` or `.createElement('canvas')`.

**Dynamic keys — what `DYNAMIC_PREFIXES` is for:** some keys are built at runtime via template literals, e.g. `` t(`Q${n}_LABEL`) `` or `` t(`disaster_types.${v}`) ``. The script can never find these via static grep. They are listed in `DYNAMIC_PREFIXES` inside the script so CHECK B/C skip them rather than reporting them as broken or dead. If you add a new template-literal key pattern, add its prefix to `DYNAMIC_PREFIXES`.

Current dynamic prefixes: `SAFETY_DISASTER_`, `SAFETY_TIP_`, `disaster_types.`, `crisis_types.`, `faq.q`, `faq_m.q`, `map.damage_`, `my_reports.damage_`, `Q1–Q8 _OPT_/*_LABEL`, `Q8_KEY_MAP`, `whatCanIReport.types` (returnObjects call), `stepper.step_` (dict lookup in SubmissionStepper), `menu.` (variable key access in SideMenu).

**Checklist — run mentally before committing any frontend i18n change:**
1. Added a new `t('some.key')` call? → Add `("some.key", "category", "English text")` to `_SEED_KEYS`.
2. Added the key to `en.json`? → Also add to `_SEED_KEYS` (both are required).
3. Removed a `t()` call? → Mark the `StringKey` as retired (set `is_active=False`), do not delete from `en.json` until all language packages are republished.
4. Dynamic key (template literal)? → Add its prefix to `DYNAMIC_PREFIXES` in `scripts/check_i18n_coverage.py` so the CI script knows it's live.
5. After any of the above → run `python scripts/check_i18n_coverage.py` and confirm exit code 0 before committing.

### Export (backend/app/routers/exports.py)
- 5 formats: Field Operations (CSV), Full Data (CSV), GIS (Shapefile), GeoPackage, RAPIDA Summary (CSV)
- RAPIDA field mapping: `damage_level→damage_classification`, `gps_latitude/longitude→latitude/longitude`, `created_at→timestamp`, `infrastructure_types→infrastructure_type`
- Download URLs are HMAC-signed and expire in `EXPORT_DOWNLOAD_EXPIRY_MINUTES` minutes

### Security
- Sensitive PII: Fernet-encrypted at application level. Always stored as `*_encrypted` (bytes) + `*_hash` (SHA-256 hex) column pair — query on hash, decrypt to read.
- Encrypted fields: reporter email, reporter name, device ID, IP address

### CRITICAL — API Response Data Boundary

Every API response must contain **only the fields the calling client actually needs**. This was audited and enforced in June 2026 — do not regress it.

**The rule in one sentence:** if a field is not rendered or used by the client that calls the endpoint, it must not be in that endpoint's response schema.

#### What belongs where

| Data | Reporter app / Android | Dashboard |
|---|---|---|
| Crisis UUID (`id`) | ✅ needed for submission | ✅ |
| Crisis name, `serial_id` (PR-XXXX) | ❌ never shown | ✅ |
| Crisis dates, status, timestamps | ❌ never shown | ✅ |
| `flag_status` (green/orange/red/grey) | ❌ internal review concept | ✅ |
| `was_queued`, `platform`, `language_code` | ❌ internal pipeline detail | ✅ |
| `crisis_id`, `reporter_id` FK references | ❌ not needed in detail view | ✅ |
| Map coordinates, radius, countries | ✅ map centering / validation | ✅ |
| Report damage, location, photos, Q1-Q8 | ✅ reporter's own data | ✅ |

#### Implemented split (reference)

- `GET /api/crises/active` → `ReporterCrisisRef` (id + map coords + geography only).
  `GET /api/crises` → `PublicCrisisItem` (full record, used by dashboard Header/Export/etc.).
- `ReporterReportItem` (`GET /api/reports/my`) and `ReportResponse` (`GET /api/reports/{id}`) — no `flag_status`, `was_queued`, `platform`, `language_code`, `crisis_id`, `reporter_id`.
- `ReportSubmitResponse` (`POST /api/reports`) — no `flag_status`.

#### Checklist — apply whenever adding a field to any response schema

1. **Which clients call this endpoint?** List them (reporter web, Android, dashboard, mobile).
2. **Does each client render or use this field?** If no client uses it, do not add it.
3. **Is this field an internal/admin concept?** `flag_status`, serial IDs, internal FKs, pipeline flags → dashboard only.
4. **Are there two audiences sharing one endpoint?** Split into two schemas (slim reporter schema + full dashboard schema) rather than returning the union.
5. **After adding:** open browser DevTools → Network tab and verify the response contains no unexpected fields.

#### Dashboard equivalent rule

The dashboard fetches data that reporters must never see, but it should equally avoid loading data it does not use. Before adding a field to a dashboard API call, confirm the page actually renders it. Unused fields in dashboard responses waste bandwidth and make responses harder to audit.

## Environment Variables
```
DATABASE_URL        postgresql+asyncpg://...
REDIS_URL           redis://...
JWT_SECRET_KEY
FERNET_KEY          Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
STORAGE_BACKEND     local | r2
LOCAL_UPLOAD_PATH   uploads/photos
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL
MAPTILER_API_KEY
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
EXPO_PUSH_TOKEN
LIBRETRANSLATE_URL
GOOGLE_TRANSLATE_API_KEY
TRANSLATION_PRIMARY google | libretranslate
FIRST_ADMIN_EMAIL, FIRST_ADMIN_PASSWORD
EXPORT_URL_SIGN_SECRET
IPAPI_KEY           Optional — unlocks 15k req/min on ip-api.com (Rule 7)
ALLOWED_ORIGINS     JSON array of allowed CORS origins

# Auth cookies
COOKIE_SECURE       true in prod (Railway HTTPS); false in local dev (plain HTTP)
COOKIE_SAMESITE     none in prod (cross-origin Railway domains); lax in local dev

# Login rate limiting (dashboard)
LOGIN_RATE_LIMIT_ATTEMPTS        default 5
LOGIN_RATE_LIMIT_WINDOW_MINUTES  default 10
LOGIN_LOCKOUT_MINUTES            default 15

# Session / inactivity (dashboard)
INACTIVITY_TIMEOUT_MINUTES       default 30

# Property grouping
CONFLICT_WARNING_THRESHOLD       default 0.25 (minority share ≥ 25% triggers warning)
GPS_GROUPING_RADIUS_DEGREES      default 0.001 (~100 m at equator)

# Reporting radius
REPORTING_RADIUS_DEFAULT_MILES   default 50
```

## Hosting
- Dev: local FastAPI + PostgreSQL + Redis (Docker or native)
- Production: Railway (managed PostgreSQL + Redis + TLS auto-provisioned)
- Photos: Cloudflare R2 in production

## Known Data Model Gaps — Pending Future Work

These are confirmed gaps between the Chapter 3 design document and the current implementation. Do not implement without discussion.

1. **`question_answers` — no required/appendix distinction**: The `question_answers` JSON column on `Report` is a flat list of `{question, answer}` pairs. There is no `is_required` or `is_appendix` field on each entry. Chapter 3 specifies that required Q1–Q4 answers and optional appendix answers should be shown in separate UI sections. This split is not currently possible without a data model change — either a schema change to the JSON column or a separate `appendix_answers` column. Skip this until the question model is extended.

2. **Reporter-level IP history**: `Reporter` now has `ip_address_hash` (the most recent submission IP hash, used by Rule 2 and Rule 8). Full per-reporter IP *history* (multiple IPs over time) is still not stored — there is no IP log table. If IP history is ever needed, a separate `reporter_ip_log` table must be designed.

3. **Photo EXIF fields**: `Photo` model stores `exif_timestamp`, `exif_latitude`, `exif_longitude`, `exif_device_make`, `exif_device_model`. These are extracted from photo EXIF at upload time. `exif_timestamp` is exposed in the dashboard report detail API (`PhotoSummary.exif_timestamp`). The others are stored but not currently surfaced in any API response.

## Documented Prototype Exceptions
1. iOS native app: NOT built — Xcode requires macOS
2. iOS PWA push notifications: DEFERRED — requires Apple Developer account
3. SMS Tier 3 fallback: REMOVED from scope
4. Full-scale stress testing: NOT feasible on free tier
