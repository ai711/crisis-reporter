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
                for reporter in reporters:
                    reporter.auto_block_confirmed = True
                    reporter.auto_block_confirmed_at = now
                    reporter.auto_block_confirmed_by = "system"
                    reporter.pending_auto_block_confirmation = False
                    logger.info(
                        "Auto-block automatically confirmed for reporter %s after %d-hour window",
                        reporter.id, settings.AUTO_BLOCK_CONFIRMATION_HOURS,
                    )
                await db.commit()
        except Exception as e:
            logger.error("Auto-block confirmation loop error: %s", e)


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
    yield
    task_stuck.cancel()
    task_autoblock.cancel()
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
