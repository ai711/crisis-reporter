# Crisis Reporter — CLAUDE.md
# Claude Code Project Memory File
# Read this file completely before writing any code in this project.

## Project Identity
- Project: Crisis Reporter — UNDP Crisis Mapping Challenge
- Platform: InnoCentive
- Prize: $50,000
- Deadline: June 23, 2026
- Builder: Solo developer using Claude Code as primary development tool
- Repository: https://github.com/ai711/crisis-reporter

## What This System Is
Crisis Reporter is an end-to-end crisis damage reporting system. Community 
reporters submit damage reports (photos, location, damage classification) 
from any device with any connectivity level. UNDP staff review all reports 
through a secure web dashboard.

## Folder Structure
crisis-reporter/
├── backend/       FastAPI, PostgreSQL models, Redis, ARQ worker
├── web/           React + Vite — reporter web app and PWA (Tier B + C)
├── dashboard/     React + Vite — UNDP dashboard (separate app)
├── mobile/        React Native + Expo — Android app (Tier A)
├── shared/        Shared TypeScript types and API contracts
├── data/          Building footprint processing scripts
├── docs/          Technical Architecture Document and specs
├── CLAUDE.md      This file — read before every session
├── .env.example   All environment variables with placeholders
└── .gitignore     Never commit .env files

## Development Order — Follow This Sequence
1. Backend: FastAPI, PostgreSQL schema, PostGIS, Redis, auth, core report API
2. Backend: ARQ worker, photo processing, auto-flagging, StorageService
3. Web/PWA: Reporter app — full submission flow, 6 languages, MapLibre, offline queue
4. Dashboard: Main map, report review, flag management, SSE updates
5. Dashboard: Complete — reporter profiles, analytics, export, settings
6. Android app: React Native, Expo managed workflow, MapLibre, EAS Build APK
7. Integration testing, Cloudflare R2 switch, Railway deployment

## Locked Technical Decisions — Never Re-Open These

### Backend
- Language: Python 3.14
- Framework: FastAPI (async-native)
- ASGI server: Uvicorn with Gunicorn in production
- ORM: SQLAlchemy 2.0 async
- Database driver: asyncpg

### Database
- Primary: PostgreSQL 16 + PostGIS 3
- Job queue + pub/sub: Redis 7
- NEVER use offset pagination — cursor-based pagination ONLY throughout
- All list endpoints anchor on record ID or timestamp cursor

### Authentication
- Method: JWT throughout (PyJWT + passlib bcrypt)
- Dashboard staff: email + password, JWT, Admin and Analyst roles
- Reporter verified: email + password, JWT, Reporter role
- Reporter anonymous: device UUID only, no JWT
- Access token TTL: 15 minutes
- Refresh token TTL: 7 days

### CRITICAL — Silent JWT Refresh
Token refresh MUST happen silently in the background at the HTTP client 
layer. It must NEVER interrupt an active form flow or report submission. 
This applies to both the PWA and the Android app. Implement as an HTTP 
interceptor — not at the UI layer. This is a must-not-miss requirement.

### Photo Storage
- Development: Local filesystem at backend/uploads/photos/
- Pre-submission production: Cloudflare R2 (S3-compatible via boto3)
- Switch is controlled by environment variable: STORAGE_BACKEND=local or r2
- StorageService abstraction class MUST be implemented from day one
- Three methods only: save(file, path), get_url(path), delete(path)
- Switching from local to R2 must require zero code changes

### Photo Compression Thresholds
- Under 1.5 MB: no compression, send as-is
- 1.5 MB to 8 MB: compress to ~1 MB
- Above 8 MB: compress to ~1.5 MB
- Record compression metadata with every report

### Frontend — Web and PWA
- Framework: React 18 + Vite 5
- Language: TypeScript 5 throughout
- Data fetching: TanStack Query 5
- Internationalisation: react-i18next
- Map: MapLibre GL JS
- PWA layer: vite-plugin-pwa
- Offline queue: IndexedDB (report queue + photo Blobs)
- localStorage: session ID, reporter ID, T&C acceptance, language, PWA flag
- Web and PWA are ONE shared codebase — not two separate apps

### Frontend — Dashboard
- Framework: React 18 + Vite 5 (SEPARATE app from web/PWA)
- Data fetching: TanStack Query 5
- Real-time: SSE (Server-Sent Events) primary connection
- Fallback: TanStack Query refetch interval at 20 seconds when SSE drops
- Map: MapLibre GL JS
- Desktop only — 1440px minimum viewport

### Frontend — Android App
- Framework: React Native 0.74 + Expo SDK 51
- Workflow: Expo managed workflow with config plugins (NOT bare workflow)
- Build: Expo EAS Build — generates downloadable APK file
- Map: @maplibre/maplibre-react-native via config plugin
- Push: Expo Push Notifications (FCM wrapper)
- MUST produce a downloadable APK via EAS Build before submission

### Real-Time Dashboard Updates
- Primary: Server-Sent Events (SSE) — FastAPI streaming endpoint
- Engine: Redis pub/sub — events published on report confirm or flag change
- Fallback: TanStack Query refetch at 20-second interval when SSE drops
- LIVE indicator: green dot when connected, amber when connection lost
- Events: report_confirmed, flag_changed, reporter_status_changed, review_queue_updated

### Background Jobs
- Durable jobs (ARQ): photo processing, auto-flagging, export generation, push notifications
- Lightweight jobs (FastAPI BackgroundTasks): SSE event broadcasting
- ARQ worker runs as separate process — same codebase, different start command

### Flag System
- Grey: received, auto-checks in progress — excluded from exports by default
- Green: verified, passed all checks — included in exports
- Orange: passed with notes, minor anomaly — included in exports
- Red: requires human review — excluded from exports by default
- Auto-flagging runs as ARQ job on every incoming report

### Auto-Flagging Rules (in order)
1. Blocked device ID match → Red flag
2. Blocked IP address match → Red flag
3. Duplicate: same device + same building + within 24 hours → Orange flag
4. All checks pass → Green flag
5. Default on receipt (before ARQ processes) → Grey flag

### Multilingual
- UI: react-i18next, JSON translation files bundled at build time
- 6 UN languages: Arabic (ar), Chinese (zh), English (en), French (fr), Russian (ru), Spanish (es)
- Content translation: LibreTranslate on Hugging Face Spaces — on-demand only
- Trigger: Translate button on dashboard — NOT automatic

### Export
- 5 report types: Field Operations, Full Data, GIS (Shapefile), GeoPackage, RAPIDA Summary
- Generation: ARQ background job — never blocks dashboard UI
- RAPIDA mandatory fields: geocoordinates (decimal degrees), timestamp, 
  damage_classification (minimal/partial/complete), infrastructure_type
- Default inclusion: Green and Orange flags only
- Grey and Red excluded by default — dashboard user can override

### Map Infrastructure
- Engine: MapLibre GL (web) + @maplibre/maplibre-react-native (Android)
- Tiles: Maptiler (free tier for prototype)
- Building footprints: OSM (priority) + Microsoft Building Footprints (gap fill)
- Footprint database: PostGIS
- Tile generation: Tippecanoe (zoom levels 10-18)
- Tile server: TileServer GL

### Security
- TLS: Railway provisioned automatically — zero configuration
- Sensitive field encryption: Python cryptography library — Fernet symmetric
- Encrypted fields: reporter email, reporter name, device ID, IP address
- Encryption key: FERNET_KEY environment variable — never in codebase
- Rate limiting: slowapi on report submission endpoint
- Input validation: Pydantic on all request models

### Hosting
- Development: local (FastAPI + PostgreSQL + Redis via Docker)
- Pre-submission live: Railway (managed PostgreSQL + Redis)
- Photo storage pre-submission: Cloudflare R2

## Documented Prototype Exceptions
These are acknowledged in the submission — do not try to build them:

1. iOS native app: NOT built — Xcode requires macOS, dev machine is Windows
2. iOS PWA push notifications: DEFERRED — requires Apple Developer account
3. SMS Tier 3 fallback: REMOVED from scope — future consideration only
4. Full scale stress testing: NOT feasible on free tier infrastructure

## Environment Variables (never commit values — use .env.example for keys)
DATABASE_URL, REDIS_URL, JWT_SECRET_KEY, FERNET_KEY, STORAGE_BACKEND,
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
MAPTILER_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, EXPO_PUSH_TOKEN,
LIBRETRANSLATE_URL

## Database Rules
- Cursor-based pagination ONLY — never offset pagination
- All spatial queries via PostGIS
- Mandatory indexes: see Technical Architecture Document Chapter 2

## Key Libraries — Backend
fastapi, uvicorn, sqlalchemy[asyncio], asyncpg, redis, arq, pyjwt,
passlib[bcrypt], cryptography, slowapi, geopandas, fiona, Pillow,
pywebpush, boto3, httpx

## Key Libraries — Frontend
react, vite, typescript, @tanstack/react-query, react-i18next,
maplibre-gl, vite-plugin-pwa, react-router-dom