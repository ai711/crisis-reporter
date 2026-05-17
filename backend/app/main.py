import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
from app.config import settings
from app.database import engine, Base

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
)
from app.routers.question_packages import seed_initial_package
from app.routers.language_packages import seed_string_keys
from app.routers.countries import seed_countries


async def _stuck_report_loop() -> None:
    """Run stuck-grey-report monitor every 5 minutes."""
    from app.services.auto_flagging import monitor_stuck_grey_reports
    while True:
        await asyncio.sleep(300)  # 5 minutes
        await monitor_stuck_grey_reports()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Path(settings.LOCAL_UPLOAD_PATH).mkdir(parents=True, exist_ok=True)
    await seed_initial_package()
    await seed_string_keys()
    await seed_countries()
    # Start stuck-report background monitor
    task = asyncio.create_task(_stuck_report_loop())
    yield
    task.cancel()
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
