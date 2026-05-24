import asyncio
import logging
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
from sqlalchemy import select, text
from app.config import settings
from app.database import engine, Base, AsyncSessionLocal

logger = logging.getLogger(__name__)

# Import all models so SQLAlchemy registers them
import app.models

# Import routers
from app.routers import (
    dashboard_auth,
    dashboard_users,
    reporter_auth,
    reporters,
    crises,
    reports,
    photos,
    dashboard_reports,
    dashboard_reporters,
    dashboard_map,
    dashboard_properties,
    dashboard_projects,
    analytics,
    exports,
    question_packages,
    flag_rules,
    language_packages,
    push_tokens,
    roles,
    health as health_router,
    app_settings,
    content,
    countries,
    review_queue,
    notifications as notifications_router,
)
from app.routers.question_packages import seed_initial_package
from app.routers.language_packages import seed_string_keys
from app.routers.countries import seed_countries


async def _seed_notification_types() -> None:
    """Ensure the notifications AppSetting has the 4 correct Chapter 13 types.
    Replaces any old notification types from previous chapters."""
    from app.models.app_setting import AppSetting
    correct_keys = {
        "review_queue_threshold", "new_red_flagged_report",
        "reporter_auto_paused", "high_volume_processing_delay",
    }
    correct_types = [
        {
            "key": "review_queue_threshold",
            "label": "Review Queue — Red flagged reports threshold exceeded",
            "description": "Triggers when the number of Red-flagged reports in Review Queue Tab 1 exceeds the configured threshold.",
            "active": True, "subscribers": [], "threshold": 50,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
        {
            "key": "new_red_flagged_report",
            "label": "New Red-flagged report received",
            "description": "Triggers when any new report receives a Red flag from the automatic check system.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "summary", "summary_interval_minutes": 15,
        },
        {
            "key": "reporter_auto_paused",
            "label": "Reporter automatically paused",
            "description": "Triggers when a reporter is automatically paused due to exceeding the submission rate limit.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
        {
            "key": "high_volume_processing_delay",
            "label": "High volume processing delay",
            "description": "Triggers when the system is processing a high volume of reports and map updates may be delayed.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
    ]
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(AppSetting).where(AppSetting.key == "notifications"))
        row = result.scalar_one_or_none()
        if row is None:
            db.add(AppSetting(key="notifications", value={"types": correct_types}))
            await db.commit()
            return
        existing = row.value if isinstance(row.value, dict) else {}
        old_types = {t["key"]: t for t in existing.get("types", [])}
        # Remove old keys not in correct set; preserve subscriber/active state for existing correct keys
        merged = []
        for ct in correct_types:
            if ct["key"] in old_types:
                kept = dict(ct)
                # Preserve user-configured fields
                old = old_types[ct["key"]]
                for field in ("active", "subscribers", "threshold", "delivery_mode", "summary_interval_minutes"):
                    if field in old and old[field] is not None:
                        kept[field] = old[field]
                merged.append(kept)
            else:
                merged.append(ct)
        row.value = {"types": merged}
        await db.commit()
        logger.info("Notification types seeded/updated to Chapter 13 spec")


async def seed_first_admin() -> None:
    """Create an admin user from FIRST_ADMIN_EMAIL / FIRST_ADMIN_PASSWORD env vars
    if no admin users exist yet. Safe to run every startup — no-op once an admin exists."""
    email = getattr(settings, "FIRST_ADMIN_EMAIL", None)
    password = getattr(settings, "FIRST_ADMIN_PASSWORD", None)
    if not email or not password:
        return
    from app.models.dashboard_user import DashboardUser
    from app.routers.dashboard_auth import hash_password
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(DashboardUser).where(DashboardUser.role.in_(["admin", "superadmin"]))
        )
        if result.scalars().first():
            return
        user = DashboardUser(
            email=email.lower().strip(),
            full_name="Administrator",
            password_hash=hash_password(password),
            role="admin",
        )
        db.add(user)
        await db.commit()
        logger.info("Bootstrap admin created: %s", email)


async def _seed_default_roles() -> None:
    """Create the two system default roles if they do not already exist."""
    try:
        from app.models.role import Role
        # Keys must match the SECTIONS keys used in the frontend permissions table
        all_sections = [
            "main_map_view", "reports_page", "location_page", "review_queue",
            "analytics_and_statistics", "reporter_profiles", "export", "projects",
            "manage_users", "manage_roles", "app_configuration",
        ]
        superadmin_permissions = {s: {"view": True, "edit": True} for s in all_sections}
        guest_permissions = {"projects": {"view": True, "edit": False}}

        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Role).where(Role.is_default == True))
            existing_names = {r.name for r in result.scalars().all()}

            if "Superadmin" not in existing_names:
                db.add(Role(
                    name="Superadmin",
                    is_default=True,
                    permissions=superadmin_permissions,
                    description="Full access to all dashboard sections. Cannot be modified.",
                ))
            if "Guest" not in existing_names:
                db.add(Role(
                    name="Guest",
                    is_default=True,
                    permissions=guest_permissions,
                    description="View-only access to explicitly assigned projects. No other sections visible.",
                ))
            await db.commit()
        logger.info("Default roles seeded")
    except Exception as e:
        logger.error("_seed_default_roles failed: %s", e)


async def _stuck_report_loop() -> None:
    """Run stuck-grey-report monitor on configurable interval, reading threshold from AppSetting."""
    from app.services.auto_flagging import monitor_stuck_grey_reports
    from app.models.app_setting import AppSetting
    while True:
        interval = settings.STUCK_REPORT_THRESHOLD_MINUTES
        try:
            async with AsyncSessionLocal() as db:
                from sqlalchemy import select as _select
                row = await db.execute(_select(AppSetting).where(AppSetting.key == "thresholds"))
                rec = row.scalar_one_or_none()
                if rec and isinstance(rec.value, dict):
                    interval = rec.value.get("stuck_report_threshold_minutes", interval)
        except Exception:
            pass
        await asyncio.sleep(interval * 60)
        await monitor_stuck_grey_reports()


async def _auto_block_confirmation_loop() -> None:
    """Auto-confirm auto-blocks whose review window has expired with no action.
    Reads auto_block_confirmation_hours from AppSetting, falling back to config."""
    from app.models.reporter import Reporter
    from app.models.app_setting import AppSetting
    interval = settings.AUTO_BLOCK_CHECK_INTERVAL_MINUTES * 60
    while True:
        await asyncio.sleep(interval)
        try:
            async with AsyncSessionLocal() as db:
                # Read configurable window from AppSetting
                confirmation_hours = settings.AUTO_BLOCK_CONFIRMATION_HOURS
                try:
                    row = await db.execute(
                        select(AppSetting).where(AppSetting.key == "thresholds")
                    )
                    rec = row.scalar_one_or_none()
                    if rec and isinstance(rec.value, dict):
                        confirmation_hours = rec.value.get("auto_block_confirmation_hours", confirmation_hours)
                except Exception:
                    pass

                now = datetime.now(timezone.utc)
                expired = await db.execute(
                    select(Reporter).where(
                        Reporter.pending_auto_block_confirmation == True,
                        Reporter.auto_block_confirmed == False,
                        Reporter.auto_block_expires_at <= now,
                    )
                )
                reporters = expired.scalars().all()
                from app.services.reporter_activity_service import write_activity_log
                for reporter in reporters:
                    reporter.auto_block_confirmed = True
                    reporter.auto_block_confirmed_at = now
                    reporter.auto_block_confirmed_by = "system"
                    reporter.pending_auto_block_confirmation = False
                    try:
                        await write_activity_log(
                            db,
                            reporter_id=reporter.id,
                            action="auto_block_expired",
                            source="System",
                            previous_value="blocked",
                            new_value="blocked",
                            comment=(
                                f"Auto-block automatically confirmed after "
                                f"{confirmation_hours}-hour review window "
                                f"with no action taken."
                            ),
                        )
                    except Exception as e:
                        logger.warning("Activity log write failed in auto_block_confirmation_loop: %s", e)
                    logger.info(
                        "Auto-block automatically confirmed for reporter %s after %d-hour window",
                        reporter.id, confirmation_hours,
                    )
                await db.commit()
        except Exception as e:
            logger.error("Auto-block confirmation loop error: %s", e)


async def _remove_expired_deprecated_languages_loop() -> None:
    """Daily: hard-remove languages past their removal_scheduled_at date."""
    from app.tasks import remove_expired_deprecated_languages
    while True:
        await asyncio.sleep(24 * 60 * 60)
        try:
            await remove_expired_deprecated_languages()
        except Exception as e:
            logger.error("remove_expired_deprecated_languages loop error: %s", e)


async def _pause_expiry_loop() -> None:
    """Every 15 minutes: clear submission pauses whose expiry time has passed."""
    from app.models.reporter import Reporter
    while True:
        await asyncio.sleep(15 * 60)
        try:
            async with AsyncSessionLocal() as db:
                now = datetime.now(timezone.utc)
                expired = await db.execute(
                    select(Reporter).where(
                        Reporter.is_paused == True,
                        Reporter.pause_expires_at <= now,
                    )
                )
                for reporter in expired.scalars().all():
                    reporter.is_paused = False
                    reporter.pause_expires_at = None
                    reporter.pause_reason = None
                await db.commit()
        except Exception as e:
            logger.error("Pause expiry loop error: %s", e)


_MIGRATIONS = [
    # Crisis model overhaul — Chapter 9
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS serial_number INTEGER",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS serial_id VARCHAR(20)",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS countries TEXT[]",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS start_date DATE",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS end_date DATE",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS created_by_user_id UUID",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_job_id VARCHAR(100)",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_status VARCHAR(20) DEFAULT 'pending'",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_progress INTEGER DEFAULT 0",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_total INTEGER DEFAULT 0",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS map_zoom INTEGER",
    # Seed countries array from existing country_code (idempotent)
    "UPDATE crises SET countries = ARRAY[country_code] WHERE countries IS NULL AND country_code IS NOT NULL",
    # Sync status from is_active for existing rows
    "UPDATE crises SET status = CASE WHEN is_active = TRUE THEN 'active' ELSE 'closed' END WHERE status IS NULL OR status = ''",
    # Sequence for serial numbers
    "CREATE SEQUENCE IF NOT EXISTS crisis_serial_seq START WITH 1 INCREMENT BY 1",
    # Seed serial numbers for existing crises that have none (idempotent DO block)
    """DO $$
DECLARE
  r RECORD;
  n INTEGER;
BEGIN
  FOR r IN SELECT id FROM crises WHERE serial_number IS NULL ORDER BY created_at ASC LOOP
    n := nextval('crisis_serial_seq');
    UPDATE crises SET serial_number = n, serial_id = 'PR-' || LPAD(n::text, 4, '0') WHERE id = r.id;
  END LOOP;
END $$""",
    # Advance sequence past any manually seeded values
    "SELECT setval('crisis_serial_seq', COALESCE((SELECT MAX(serial_number) FROM crises), 0) + 1, false)",
    # Unique constraint on serial_id (safe — each row now has one)
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_crises_serial_id_unique ON crises(serial_id) WHERE serial_id IS NOT NULL",
    # report_projects join table
    """CREATE TABLE IF NOT EXISTS report_projects (
    report_id UUID NOT NULL REFERENCES reports(id),
    crisis_id UUID NOT NULL REFERENCES crises(id),
    linked_at TIMESTAMPTZ DEFAULT NOW(),
    linked_by VARCHAR(20) DEFAULT 'auto',
    PRIMARY KEY (report_id, crisis_id)
)""",
    "CREATE INDEX IF NOT EXISTS idx_report_projects_crisis_id ON report_projects(crisis_id)",
    "CREATE INDEX IF NOT EXISTS idx_report_projects_report_id ON report_projects(report_id)",
    # Seed report_projects from existing crisis_id FK on reports
    """INSERT INTO report_projects (report_id, crisis_id, linked_by)
SELECT id, crisis_id, 'auto'
FROM reports
WHERE crisis_id IS NOT NULL
  AND flag_status IN ('green', 'orange')
ON CONFLICT DO NOTHING""",
    # project_users join table
    """CREATE TABLE IF NOT EXISTS project_users (
    crisis_id UUID NOT NULL REFERENCES crises(id),
    dashboard_user_id UUID NOT NULL REFERENCES dashboard_users(id),
    access_level VARCHAR(20) DEFAULT 'view_and_edit',
    is_creator BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (crisis_id, dashboard_user_id)
)""",
    # Dashboard users: existing chapters
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS contact_number VARCHAR(50)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT",
    # Chapter 10 — user management
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES dashboard_users(id)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS ip_address_hash VARCHAR(64)",
    # Chapter 12 Part 2 — Translation governance
    """CREATE TABLE IF NOT EXISTS languages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(10) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        is_protected BOOLEAN NOT NULL DEFAULT FALSE,
        deprecated_at TIMESTAMPTZ,
        removal_scheduled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_languages_code_unique ON languages(code)",
    # Seed 6 UN languages (idempotent).
    # id AND created_at must be supplied explicitly: create_all builds the table from the
    # Language model, which uses Python-side defaults (default=uuid.uuid4,
    # default=datetime.utcnow).  SQLAlchemy does NOT emit DEFAULT clauses for those in the
    # DDL, so both columns are NOT NULL with no server-side fallback.  Omitting either
    # column causes a NOT NULL violation which poisons the transaction and rolls back every
    # statement that follows.
    """INSERT INTO languages (id, code, name, status, is_protected, created_at)
       VALUES
         (gen_random_uuid(), 'ar', 'Arabic',  'active', TRUE, NOW()),
         (gen_random_uuid(), 'zh', 'Chinese', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'en', 'English', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'fr', 'French',  'active', TRUE, NOW()),
         (gen_random_uuid(), 'ru', 'Russian', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'es', 'Spanish', 'active', TRUE, NOW())
       ON CONFLICT (code) DO NOTHING""",
    # Ensure protected flag is set for UN languages
    "UPDATE languages SET is_protected = TRUE WHERE code IN ('ar', 'zh', 'en', 'fr', 'ru', 'es')",
    # Translation reject fields
    "ALTER TABLE translations ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ",
    "ALTER TABLE translations ADD COLUMN IF NOT EXISTS rejection_reason TEXT",
    # Audit log table
    """CREATE TABLE IF NOT EXISTS translation_audit_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        lang_code VARCHAR(10),
        string_key VARCHAR(255),
        details JSONB,
        performed_by VARCHAR(255),
        dashboard_user_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_event ON translation_audit_log(event_type)",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_lang ON translation_audit_log(lang_code)",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_created ON translation_audit_log(created_at DESC)",
    # Chapter 12 — App Configuration structural fixes
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_core BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE countries ADD COLUMN IF NOT EXISTS dialling_code VARCHAR(10)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS tc_version_accepted VARCHAR(20)",
    # Backfill: mark the 5 seeded questions (package v1.0.0) as core
    """UPDATE questions SET is_core = TRUE
       WHERE package_id = '00000000-0000-0000-0000-000000000001'""",
    # Reporter auto-block fields (Chapter 5 Part 1)
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_blocked_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_expires_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed BOOLEAN DEFAULT FALSE",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed_by VARCHAR(255)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS matched_blocked_reporter_id VARCHAR(255)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pending_auto_block_confirmation BOOLEAN DEFAULT FALSE",
    # Chapter 7 — reporter profile fields
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS profile_status VARCHAR(20) DEFAULT 'active'",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS profile_type VARCHAR(30) DEFAULT 'anonymous_no_reports'",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS app_version VARCHAR(50)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS browser_version VARCHAR(100)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS mcc VARCHAR(10)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pause_expires_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(255)",
    # Sync existing is_blocked=True reporters to profile_status='blocked'
    "UPDATE reporters SET profile_status = 'blocked' WHERE is_blocked = TRUE AND profile_status = 'active'",
    # Sync existing verified reporters to profile_type='named_profile'
    "UPDATE reporters SET profile_type = 'named_profile' WHERE is_verified = TRUE AND profile_type = 'anonymous_no_reports'",
    # Sync anonymous reporters who have reports to profile_type='anonymous_with_reports'
    "UPDATE reporters SET profile_type = 'anonymous_with_reports' WHERE is_verified = FALSE AND report_count > 0 AND profile_type = 'anonymous_no_reports'",
    # Chapter 13 — Security setting defaults (idempotent via ON CONFLICT DO NOTHING on unique key)
    # NOTE: app_settings stores settings as JSONB blobs keyed by group name.
    # We seed individual scalar keys here for migration tracking but the actual
    # settings blob is managed by the app_settings router using upsert.
    # Chapter 11 — Role model extensions
    "ALTER TABLE roles ADD COLUMN IF NOT EXISTS description VARCHAR(500)",
    "ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES dashboard_users(id)",
    # Chapter 13 — Notification bell tables
    """CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        notification_type_key VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        triggered_at TIMESTAMPTZ DEFAULT NOW(),
        is_global BOOLEAN DEFAULT TRUE
    )""",
    """CREATE TABLE IF NOT EXISTS notification_reads (
        notification_id INTEGER REFERENCES notifications(id),
        dashboard_user_id UUID REFERENCES dashboard_users(id),
        read_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (notification_id, dashboard_user_id)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_notifications_triggered_at ON notifications(triggered_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(dashboard_user_id)",
    # Chapter 18 — Password expiry enforcement
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ",
    "UPDATE dashboard_users SET password_changed_at = created_at WHERE password_changed_at IS NULL",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for stmt in _MIGRATIONS:
            try:
                await conn.execute(text(stmt))
            except Exception as e:
                logger.warning("Migration skipped: %s — %s", stmt, e)
    Path(settings.LOCAL_UPLOAD_PATH).mkdir(parents=True, exist_ok=True)
    await seed_initial_package()
    await seed_string_keys()
    await seed_countries()
    await seed_first_admin()
    await _seed_default_roles()
    await _seed_notification_types()
    # Remove the ZZ placeholder country if it exists
    try:
        async with AsyncSessionLocal() as db:
            from app.models.country import Country
            result = await db.execute(
                select(Country).where(Country.code == "ZZ")
            )
            zz_country = result.scalar_one_or_none()
            if zz_country:
                await db.delete(zz_country)
                await db.commit()
                logger.info("Deleted duplicate country with code ZZ")
    except Exception as e:
        logger.error("ZZ country cleanup error: %s", e)
    # Reset / create admin@crisisreporter.org on every startup
    try:
        from app.models.dashboard_user import DashboardUser
        from app.routers.dashboard_auth import hash_password
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(DashboardUser).where(
                    DashboardUser.email == "admin@crisisreporter.org"
                )
            )
            admin = result.scalar_one_or_none()
            if admin:
                admin.password_hash = hash_password("Admin2026")
                await db.commit()
                logger.info("Admin password reset to Admin2026")
                if admin.role != "superadmin":
                    admin.role = "superadmin"
                    await db.commit()
                    print("Updated admin@crisisreporter.org role to superadmin")
            else:
                new_admin = DashboardUser(
                    email="admin@crisisreporter.org",
                    password_hash=hash_password("Admin2026"),
                    full_name="Crisis Reporter Admin",
                    role="superadmin",
                    is_active=True,
                )
                db.add(new_admin)
                await db.commit()
                logger.info("Admin account created: admin@crisisreporter.org")
    except Exception as e:
        logger.error("Admin reset migration error: %s", e)
    # Shared Redis connection on app state (used by soft-lock service and review queue)
    import redis.asyncio as aioredis
    app.state.redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    # Background monitors
    task_stuck = asyncio.create_task(_stuck_report_loop())
    task_autoblock = asyncio.create_task(_auto_block_confirmation_loop())
    task_pause_expiry = asyncio.create_task(_pause_expiry_loop())
    task_lang_cleanup = asyncio.create_task(_remove_expired_deprecated_languages_loop())
    yield
    task_stuck.cancel()
    task_autoblock.cancel()
    task_pause_expiry.cancel()
    task_lang_cleanup.cancel()
    await app.state.redis.aclose()
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if settings.STORAGE_BACKEND == "local":
    uploads_path = Path(settings.LOCAL_UPLOAD_PATH)
    uploads_path.mkdir(parents=True, exist_ok=True)
    app.mount(
        "/api/uploads/photos",
        StaticFiles(directory=str(uploads_path)),
        name="uploads",
    )

# Register routers
app.include_router(dashboard_auth.router)
app.include_router(reporter_auth.router)
app.include_router(reporters.router)
app.include_router(crises.router)
app.include_router(reports.router)
app.include_router(photos.router)
app.include_router(dashboard_reports.router)
app.include_router(dashboard_reporters.router)
app.include_router(dashboard_map.router)
app.include_router(dashboard_properties.router)
app.include_router(analytics.router)
app.include_router(exports.router)
app.include_router(question_packages.router)
app.include_router(flag_rules.router)
app.include_router(language_packages.languages_router)
app.include_router(language_packages.packages_router)
app.include_router(language_packages.keys_router)
app.include_router(language_packages.translations_router)
app.include_router(push_tokens.router)
app.include_router(roles.router)
app.include_router(health_router.router)
app.include_router(app_settings.router)
app.include_router(content.router)
app.include_router(countries.router)
app.include_router(review_queue.router)
app.include_router(dashboard_projects.router, prefix="/api")
app.include_router(dashboard_users.router, prefix="/api")
app.include_router(notifications_router.router)
