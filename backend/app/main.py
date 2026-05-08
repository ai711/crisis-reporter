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
    crises,
    reports,
    photos,
    dashboard_reports,
    dashboard_reporters,
    dashboard_map,
    analytics,
    exports,
    question_packages,
    flag_rules,
    language_packages,
)
from app.routers.question_packages import seed_initial_package
from app.routers.language_packages import seed_string_keys


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Path(settings.LOCAL_UPLOAD_PATH).mkdir(parents=True, exist_ok=True)
    # Seed v1.0.0 question package if none exists
    await seed_initial_package()
    # Seed string keys for all 8 questions if table is empty
    await seed_string_keys()
    yield
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
app.include_router(crises.router)
app.include_router(reports.router)
app.include_router(photos.router)
app.include_router(dashboard_reports.router)
app.include_router(dashboard_reporters.router)
app.include_router(dashboard_map.router)
app.include_router(analytics.router)
app.include_router(exports.router)
app.include_router(question_packages.router)
app.include_router(flag_rules.router)
app.include_router(language_packages.packages_router)
app.include_router(language_packages.keys_router)
app.include_router(language_packages.translations_router)


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }