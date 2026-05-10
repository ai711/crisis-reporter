import asyncio
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from app.database import get_db
from app.config import settings
from app.models.health_incident import HealthIncident
from app.services.dependencies import get_current_dashboard_user
from app.models.dashboard_user import DashboardUser

router = APIRouter(prefix="/api/health", tags=["Health"])

COMPONENTS = ["api_server", "database", "redis", "file_storage", "arq_worker"]
COMPONENT_LABELS = {
    "api_server": "API Server",
    "database": "Database (PostgreSQL)",
    "redis": "Redis Cache",
    "file_storage": "File Storage",
    "arq_worker": "Background Jobs (ARQ Worker)",
}


async def _check_database(db: AsyncSession) -> dict:
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "operational", "message": None}
    except Exception as e:
        return {"status": "outage", "message": str(e)[:120]}


async def _check_redis() -> dict:
    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(settings.REDIS_URL, socket_connect_timeout=3)
        await client.ping()
        await client.aclose()
        return {"status": "operational", "message": None}
    except Exception as e:
        return {"status": "outage", "message": str(e)[:120]}


async def _check_file_storage() -> dict:
    try:
        test_path = Path(settings.LOCAL_UPLOAD_PATH) / "_health_check.tmp"
        test_path.parent.mkdir(parents=True, exist_ok=True)
        test_path.write_text("ok")
        content = test_path.read_text()
        test_path.unlink()
        if content != "ok":
            return {"status": "degraded", "message": "Read-back mismatch"}
        return {"status": "operational", "message": None}
    except Exception as e:
        return {"status": "outage", "message": str(e)[:120]}


async def _check_arq_worker() -> dict:
    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(settings.REDIS_URL, socket_connect_timeout=3)
        keys = await client.keys("arq:worker:*")
        await client.aclose()
        if keys:
            return {"status": "operational", "message": None}
        return {"status": "degraded", "message": "No active workers detected"}
    except Exception as e:
        return {"status": "outage", "message": str(e)[:120]}


@router.get("")
async def health_check(db: AsyncSession = Depends(get_db)):
    """Comprehensive health check — returns live status for all system components."""
    checked_at = datetime.now(timezone.utc).isoformat()

    db_result, redis_result, storage_result, arq_result = await asyncio.gather(
        _check_database(db),
        _check_redis(),
        _check_file_storage(),
        _check_arq_worker(),
    )

    components = [
        {
            "key": "api_server",
            "label": COMPONENT_LABELS["api_server"],
            "status": "operational",
            "message": None,
            "checked_at": checked_at,
        },
        {
            "key": "database",
            "label": COMPONENT_LABELS["database"],
            **db_result,
            "checked_at": checked_at,
        },
        {
            "key": "redis",
            "label": COMPONENT_LABELS["redis"],
            **redis_result,
            "checked_at": checked_at,
        },
        {
            "key": "file_storage",
            "label": COMPONENT_LABELS["file_storage"],
            **storage_result,
            "checked_at": checked_at,
        },
        {
            "key": "arq_worker",
            "label": COMPONENT_LABELS["arq_worker"],
            **arq_result,
            "checked_at": checked_at,
        },
    ]

    overall = "operational"
    if any(c["status"] == "outage" for c in components):
        overall = "outage"
    elif any(c["status"] == "degraded" for c in components):
        overall = "degraded"

    return {
        "overall": overall,
        "components": components,
        "checked_at": checked_at,
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }


@router.get("/incidents")
async def get_health_incidents(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return last 90 days of recorded status transitions."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)
    result = await db.execute(
        select(HealthIncident)
        .where(HealthIncident.created_at >= cutoff)
        .order_by(HealthIncident.started_at.desc())
    )
    incidents = result.scalars().all()

    return {
        "incidents": [
            {
                "id": str(i.id),
                "component": COMPONENT_LABELS.get(i.component, i.component),
                "event_type": i.event_type,
                "started_at": i.started_at.isoformat() if i.started_at else None,
                "ended_at": i.ended_at.isoformat() if i.ended_at else None,
                "duration_seconds": i.duration_seconds,
                "notes": i.notes,
            }
            for i in incidents
        ]
    }
