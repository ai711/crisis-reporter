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

### Services (backend/app/services/)
- `encryption.py` — `encrypt_field(str)→bytes`, `decrypt_field(bytes)→str`, `hash_field(str)→str` (SHA-256). All PII stored as `*_encrypted` + `*_hash` column pairs.
- `storage.py` — `StorageService` ABC with `LocalFileSystemStorage` and `CloudflareR2Storage`. Factory `get_storage_service()` reads `STORAGE_BACKEND` env var. A singleton `storage_service` is created at import time.
- `auto_flagging.py` — Runs as a BackgroundTask immediately after each report submission. Thresholds are a module-level dict (`_thresholds`) updated at runtime via `PATCH /api/flag-rules`. Full 9-rule evaluation order documented in the Auto-Flagging Order section below. On Green/Orange outcome, calls `get_or_create_property` to link the report to its property record and sets `report.property_id`.
- `dependencies.py` — FastAPI dependency injectors: `get_current_dashboard_user`, `get_current_reporter`, `get_optional_reporter`, `require_admin`, `require_superadmin`, `require_section_access(section_key, require_edit)`.
- `auth.py` — JWT encode/decode. Tokens carry a `ctx` claim (`"dashboard"` or `"reporter"`) to prevent cross-context token reuse.

### Routers (backend/app/routers/)
All routers are prefixed with `/api`. Key ones:
- `reports.py` — `POST /api/reports` (submit), `GET /api/reports/{id}`
- `reporter_auth.py` — Anonymous register, verified register/login, token refresh
- `dashboard_auth.py` — Staff login/logout, token refresh, password change
- `dashboard_sse.py` — `GET /api/dashboard/stream` SSE endpoint; uses Redis pub/sub per `crisis_id`
- `exports.py` — Export jobs (CSV, GeoJSON, Shapefile, GeoPackage, RAPIDA); signed download URLs
- `flag_rules.py` — `PATCH /api/flag-rules` to update auto-flagging thresholds at runtime
- `language_packages.py` — Translation management (4 sub-routers: languages, packages, keys, translations)
- `review_queue.py` — Redis-backed soft-lock system (15-min claim window per reviewer)

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
- `web/src/services/api.ts` — Axios instance with silent JWT refresh interceptor. Token stored in `localStorage` under keys `cr_access_token`, `cr_refresh_token`, `cr_reporter_id`. **Token refresh is at the HTTP layer, never the UI layer.**
- `web/src/utils/offlineQueue.ts` — IndexedDB store `crisis_reporter/report_queue`. Reports written here when offline; synced when online. Each entry has a `local_id` that is echoed to the backend to prevent duplicates on retry.
- `web/src/App.tsx` — Route guard checks `cr_country`, `cr_language` (onboarding), `cr_tc_accepted` (T&C). Incomplete onboarding redirects to `/onboarding` with `?next=` for post-completion redirect.
- `web/src/i18n.ts` — i18next config. Language packs are fetched from the API and cached. `loadLanguagePackageFromCache()` is called on every route change to prevent drift back to English.

### localStorage Keys
`cr_access_token`, `cr_refresh_token`, `cr_reporter_id`, `cr_country`, `cr_language`, `cr_tc_accepted`, `cr_tc_version`

### VITE_API_URL
Set this env var to point to the backend. Defaults to `http://127.0.0.1:8000`.

## Architecture — Dashboard (UNDP staff app)

### Key Files
- `dashboard/src/services/api.ts` — Axios instance; same silent-refresh pattern as web.
- `dashboard/src/hooks/useSSE.ts` — Connects to `GET /api/dashboard/stream?crisis_id=…&token=…`. Auto-reconnects after 5s on error. Token passed as query param because `EventSource` doesn't support custom headers.
- `dashboard/src/stores/authStore.ts` — Zustand store; persists user profile including `role_permissions` (JSONB from `roles` table).
- `dashboard/src/App.tsx` — `ProtectedRoute` checks `isAuthenticated()` + optional `requiredRole` or `requiredSection`. Section keys: `main_map_view`, `reports_page`, `location_page`, `review_queue`, `analytics_and_statistics`, `reporter_profiles`, `export`, `projects`, `manage_users`, `manage_roles`, `app_configuration`.

### Dashboard Route Map
`/map` → MainMapPage, `/reports` → ReportsPage, `/locations` → LocationsPage (properties), `/review-queue` → ReviewQueuePage, `/analytics` → AnalyticsPage, `/reporters` → ReportersPage, `/export` → ExportPage, `/projects` → ProjectsPage, `/users` → UserManagementPage, `/roles` → ManageRolesPage, `/settings` → SystemSettingsPage

## Architecture — Mobile (Android)

Built with Expo SDK 56 / React Native 0.81. Managed workflow — no `android/` edits. Map via `@maplibre/maplibre-react-native`. Offline queue uses `expo-file-system`. Push notifications via `expo-notifications` (FCM). Build APK with `eas build --platform android`.

## Locked Technical Decisions — Never Re-Open These

### Database
- NEVER use offset pagination — cursor-based pagination ONLY throughout
- All list endpoints anchor on record ID or timestamp cursor

### Authentication
- JWT throughout (PyJWT + passlib bcrypt)
- Dashboard staff: email + password, JWT; `ctx="dashboard"` claim
- Reporter verified: email + password, JWT; `ctx="reporter"` claim
- Reporter anonymous: device UUID only, no JWT
- Access token TTL: 15 minutes | Refresh token TTL: 7 days

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
Runs in `backend/app/services/auto_flagging.py` as a FastAPI `BackgroundTask` (not ARQ) immediately after every report submission. Rules are evaluated in order; the first match that sets the flag to Red stops further evaluation. Thresholds are configurable at runtime via `PATCH /api/flag-rules`.

1. **Blocked device ID** → Red — reporter's `device_id_hash` matches a manually-blocked reporter profile; also auto-blocks the submitting reporter with a pending confirmation window
2. **IP blocked reporter match** → Red — ⚠️ **DISABLED**: requires `ip_address_hash` column on `Reporter` model which does not yet exist; TODO tracked in repo issues
3. **No photo** → Red — report has zero photos attached (with a 20-second grace window for slow uploads on non-queued reports)
4. **No location** → Red — report has neither GPS coordinates nor a text address
5. **Coordinated GPS duplicate** → Red — a *different* reporter submitted from within ~100 m (configurable via `duplicate_radius_degrees`) in the last 24 h (configurable via `duplicate_window_hours`)
6. **Rapid submission** → Red + 24 h device pause — same reporter submitted ≥ 5 reports (configurable via `rapid_submission_count`) in the last 1 h (configurable via `rapid_submission_window_hours`); also applies a 24-hour submission pause to that reporter profile
7. **IP country mismatch** → Red — submission IP geolocates to a different country than the reporter's selected country; only runs when `ip_address_encrypted` is set; stores `submission_ip`, `geolocated_country`, `reporter_selected_country` in flag metadata for reviewer context; VPN usage may produce false positives
8. **Same IP, multiple device IDs** → Red — ≥ `SAME_IP_DEVICE_THRESHOLD` distinct reporter IDs submitted from the same IP hash in the last 24 h; stores `other_reporter_ids` list in flag metadata so reviewers can assess coordinated spam vs. legitimate shared network
9. **Duplicate image** → Red — a photo attached to this report has the same SHA-256 hash as a photo on a previous report; stores `matching_report_id` and `matching_report_serial_number` in flag metadata for reviewer comparison
10. **All pass** → Green — report appears on the map immediately and is included in all exports

**Property creation** — when a report reaches Green or Orange (either automatically or via manual approval), `get_or_create_property` runs in a separate session to create or update the property record and set `report.property_id`. This links the report to its Location Page.

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

**Three checks performed:**

| Check | Severity | Meaning | Action |
|-------|----------|---------|--------|
| **CHECK B** | 🔴 Always blocking | Key used in code, absent from both `en.json` AND `_SEED_KEYS`. Even English sees a broken/empty string. | Add key to both `en.json` and `_SEED_KEYS`. |
| **CHECK A** | 🟡 Warning (`--strict` makes it fail) | Key in `en.json` (English fine) but absent from `_SEED_KEYS`. Non-English users always see English — silent bug. | Add key to `_SEED_KEYS`. |
| **CHECK C** | ℹ️ Info only, never blocks | Key in `_SEED_KEYS` but no literal `t()` call found. May be a dead key OR a dynamic/template-literal key the grep can't see. | Review — if truly dead, retire it; if dynamic, add prefix to `DYNAMIC_PREFIXES`. |

**CI enforcement:**
```bash
# Run from repo root — checks all literal t() calls
python scripts/check_i18n_coverage.py

# Strict mode — also fails on pipeline-gap keys (in en.json but not _SEED_KEYS)
python scripts/check_i18n_coverage.py --strict

# Suppress the dead-key info list (CHECK C) to reduce noise
python scripts/check_i18n_coverage.py --no-dead
```
Exit codes: 0 = pass, 1 = pipeline gap (strict only), 2 = English broken, 3 = both.

**How the script detects `t()` calls:** it uses a Python file walker (no external tools — works on Windows) with the pattern `(?<![A-Za-z0-9_$])t\(['"]key['"]` — this correctly catches both `t('key')` and `t('key', { defaultValue: '...' })` forms while excluding false matches like `.get('window')` or `.createElement('canvas')`.

**Dynamic keys — what `DYNAMIC_PREFIXES` is for:** some keys are built at runtime via template literals, e.g. `` t(`Q${n}_LABEL`) `` or `` t(`disaster_types.${v}`) ``. The script can never find these via static grep. They are listed in `DYNAMIC_PREFIXES` inside the script so CHECK B/C skip them rather than reporting them as broken or dead. If you add a new template-literal key pattern, add its prefix to `DYNAMIC_PREFIXES`.

Current dynamic prefixes: `SAFETY_DISASTER_`, `disaster_types.`, `faq.q`, `faq_m.q`, `map.damage_`, `my_reports.damage_`, `Q1–Q8 _OPT_/*_LABEL`, `Q8_KEY_MAP`, `whatCanIReport.types` (returnObjects call).

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
ALLOWED_ORIGINS     JSON array of allowed CORS origins
```

## Hosting
- Dev: local FastAPI + PostgreSQL + Redis (Docker or native)
- Production: Railway (managed PostgreSQL + Redis + TLS auto-provisioned)
- Photos: Cloudflare R2 in production

## Known Data Model Gaps — Pending Future Work

These are confirmed gaps between the Chapter 3 design document and the current implementation. Do not implement without discussion.

1. **`question_answers` — no required/appendix distinction**: The `question_answers` JSON column on `Report` is a flat list of `{question, answer}` pairs. There is no `is_required` or `is_appendix` field on each entry. Chapter 3 specifies that required Q1–Q4 answers and optional appendix answers should be shown in separate UI sections. This split is not currently possible without a data model change — either a schema change to the JSON column or a separate `appendix_answers` column. Skip this until the question model is extended.

2. **Rule 2 (IP blocked reporter match) — disabled**: `auto_flagging.py` has a TODO comment at Rule 2. It requires `Reporter.ip_address_hash` which does not yet exist on the `reporters` table. When this column is added (requires migration), Rule 2 can be re-enabled.

3. **Reporter-level IP address**: The `Reporter` model stores no IP. Submission IP is stored on the `Report` record (`ip_address_encrypted`, base64 Fernet-encoded). Displayed in the dashboard report detail view via decryption at read time. If per-reporter IP history is ever needed, a separate encrypted column must be added to `reporters`.

4. **Photo EXIF fields**: `Photo` model stores `exif_timestamp`, `exif_latitude`, `exif_longitude`, `exif_device_make`, `exif_device_model`. These are extracted from photo EXIF at upload time. `exif_timestamp` is exposed in the dashboard report detail API (`PhotoSummary.exif_timestamp`). The others are stored but not currently surfaced in any API response.

## Documented Prototype Exceptions
1. iOS native app: NOT built — Xcode requires macOS
2. iOS PWA push notifications: DEFERRED — requires Apple Developer account
3. SMS Tier 3 fallback: REMOVED from scope
4. Full-scale stress testing: NOT feasible on free tier
