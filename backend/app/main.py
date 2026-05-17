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
