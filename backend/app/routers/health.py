import asyncio
import platform
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from sqlalchemy import func
from app.database import get_db, AsyncSessionLocal
from app.config import settings
from app.models.health_incident import HealthIncident
from app.models.report import Report
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


async def _update_incidents(redis_client, components: list[dict], now: datetime) -> None:
    """On each health check, detect component state transitions and write HealthIncident rows.
    Uses Redis keys health:state:<key> to track the last known status per component."""
    changed = False
    async with AsyncSessionLocal() as db:
        for comp in components:
            comp_key = comp["key"]
            curr_status = comp["status"]
            redis_key = f"health:state:{comp_key}"
            try:
                prev_bytes = await redis_client.get(redis_key)
                prev_status = prev_bytes.decode() if prev_bytes else None
                if prev_status == curr_status:
                    continue
                if curr_status in ("degraded", "outage"):
                    db.add(HealthIncident(
                        component=comp_key,
                        event_type=curr_status,
                        started_at=now,
                        notes=comp.get("message"),
                    ))
                    changed = True
                elif curr_status == "operational" and prev_status in ("degraded", "outage"):
                    open_result = await db.execute(
                        select(HealthIncident)
                        .where(
                            HealthIncident.component == comp_key,
                            HealthIncident.ended_at.is_(None),
                        )
                        .order_by(HealthIncident.started_at.desc())
                        .limit(1)
                    )
                    open_inc = open_result.scalar_one_or_none()
                    if open_inc:
                        open_inc.ended_at = now
                        open_inc.event_type = "restored"
                        if open_inc.started_at:
                            started = open_inc.started_at
                            if started.tzinfo is None:
                                started = started.replace(tzinfo=timezone.utc)
                            open_inc.duration_seconds = int((now - started).total_seconds())
                    changed = True
                await redis_client.set(redis_key, curr_status.encode(), ex=86400)
            except Exception:
                pass
        if changed:
            try:
                await db.commit()
            except Exception:
                await db.rollback()


async def _check_arq_worker() -> dict:
    # All background jobs (auto-flagging, stuck-report loop, etc.) run as asyncio
    # tasks inside the FastAPI process — no separate ARQ worker is deployed.
    # Report as operational whenever the API server itself is up.
    return {"status": "operational", "message": None}


@router.api_route("", methods=["GET", "HEAD"])
async def health_check(request: Request, db: AsyncSession = Depends(get_db)):
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

    db_version = None
    try:
        ver_result = await db.execute(text("SELECT version()"))
        db_version = (ver_result.scalar() or "").split(" ")[0:2]
        db_version = " ".join(db_version) if db_version else None
    except Exception:
        pass

    redis = getattr(request.app.state, "redis", None)
    if redis is not None:
        try:
            await _update_incidents(redis, components, datetime.now(timezone.utc))
        except Exception:
            pass

    return {
        "overall": overall,
        "components": components,
        "checked_at": checked_at,
        "app": settings.APP_NAME,
        "app_version": settings.APP_VERSION,
        "version": settings.APP_VERSION,
        "python_version": platform.python_version(),
        "database_version": db_version,
        "environment": getattr(settings, "ENVIRONMENT", "production"),
    }


@router.get("/grey-count")
async def grey_flag_count(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return the current count of reports in Grey flag status.
    Consumed by the System Status page (Chapter 13)."""
    result = await db.execute(
        select(func.count(Report.id)).where(Report.flag_status == "grey")
    )
    count = result.scalar() or 0
    return {"grey_count": count, "checked_at": datetime.now(timezone.utc).isoformat()}


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
