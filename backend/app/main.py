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
)
from app.routers.question_packages import seed_initial_package
from app.routers.language_packages import seed_string_keys
from app.routers.countries import seed_countries


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


async def _stuck_report_loop() -> None:
    """Run stuck-grey-report monitor on configurable interval."""
    from app.services.auto_flagging import monitor_stuck_grey_reports
    while True:
        await asyncio.sleep(settings.STUCK_REPORT_THRESHOLD_MINUTES * 60)
        await monitor_stuck_grey_reports()


async def _auto_block_confirmation_loop() -> None:
    """Auto-confirm auto-blocks whose 72-hour window has expired with no action."""
    from app.models.reporter import Reporter
    interval = settings.AUTO_BLOCK_CHECK_INTERVAL_MINUTES * 60
    while True:
        await asyncio.sleep(interval)
        try:
            async with AsyncSessionLocal() as db:
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
                                f"{settings.AUTO_BLOCK_CONFIRMATION_HOURS}-hour review window "
                                f"with no action taken."
                            ),
                        )
                    except Exception as e:
                        logger.warning("Activity log write failed in auto_block_confirmation_loop: %s", e)
                    logger.info(
                        "Auto-block automatically confirmed for reporter %s after %d-hour window",
                        reporter.id, settings.AUTO_BLOCK_CONFIRMATION_HOURS,
                    )
                await db.commit()
        except Exception as e:
            logger.error("Auto-block confirmation loop error: %s", e)


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
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS ip_address_hash VARCHAR(64)",
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
    yield
    task_stuck.cancel()
    task_autoblock.cancel()
    task_pause_expiry.cancel()
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
