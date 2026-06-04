"""Public crises endpoints.

Two separate response shapes:

GET /api/crises           — Full PublicCrisisItem used by the dashboard
                            (Header dropdown, ExportPage, CrisisManagementPage,
                            MainMapPage).  Includes name, serial_id, dates, etc.

GET /api/crises/active    — Minimal ReporterCrisisRef used exclusively by
                            reporter-facing apps (web PWA, Android, map screen).
                            Returns only the fields reporters actually need:
                            the crisis UUID for submission and map coordinates.
                            Project names, serial IDs, status labels, and admin
                            timestamps are deliberately omitted so they never
                            appear in a reporter's browser DevTools.
"""

from datetime import datetime
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.crisis import Crisis

router = APIRouter(prefix="/api/crises", tags=["Crises (Public)"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class PublicCrisisItem(BaseModel):
    """Full crisis representation — used by the dashboard (header, exports, etc.)."""
    id: str
    serial_id: Optional[str]
    name: str
    country_code: Optional[str]
    countries: Optional[list[str]]
    start_date: Optional[str]
    end_date: Optional[str]
    status: str
    map_center_lat: Optional[float]
    map_center_lng: Optional[float]
    map_default_radius_miles: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ReporterCrisisRef(BaseModel):
    """Minimal crisis reference returned to reporter-facing apps.

    Includes only what reporters need: crisis UUID (for submission), map
    coordinates (for centering), and geographic scope (for validation).
    Project names, serial IDs, operational dates, status labels, and admin
    timestamps are deliberately excluded — those are dashboard-only data.
    """
    id: str
    map_center_lat: Optional[float] = None
    map_center_lng: Optional[float] = None
    map_default_radius_miles: int = 50
    country_code: Optional[str] = None
    countries: Optional[list[str]] = None

    class Config:
        from_attributes = True


# ── Serialisers ────────────────────────────────────────────────────────────────

def _full(c: Crisis) -> PublicCrisisItem:
    return PublicCrisisItem(
        id=str(c.id),
        serial_id=c.serial_id,
        name=c.name,
        country_code=c.country_code,
        countries=c.countries or [],
        start_date=c.start_date.isoformat() if c.start_date else None,
        end_date=c.end_date.isoformat() if c.end_date else None,
        status=c.status,
        map_center_lat=c.map_center_lat,
        map_center_lng=c.map_center_lng,
        map_default_radius_miles=c.map_default_radius_miles,
        is_active=c.is_active,
        created_at=c.created_at,
        updated_at=c.updated_at,
    )


def _slim(c: Crisis) -> ReporterCrisisRef:
    return ReporterCrisisRef(
        id=str(c.id),
        map_center_lat=c.map_center_lat,
        map_center_lng=c.map_center_lng,
        map_default_radius_miles=c.map_default_radius_miles,
        country_code=c.country_code,
        countries=c.countries or [],
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[PublicCrisisItem])
async def list_crises_public(
    db: AsyncSession = Depends(get_db),
):
    """Full crisis list — active and closed.

    Used by the dashboard (Header dropdown, ExportPage filter, CrisisManagementPage,
    MainMapPage selector).  Returns the full PublicCrisisItem shape including name,
    serial_id, dates, and status.
    """
    result = await db.execute(
        select(Crisis)
        .where(Crisis.status.in_(["active", "closed"]))
        .order_by(Crisis.created_at.desc())
    )
    return [_full(c) for c in result.scalars().all()]


@router.get("/active", response_model=list[ReporterCrisisRef])
async def list_active_crises_public(
    db: AsyncSession = Depends(get_db),
):
    """Active crises — reporter apps only.

    Returns the minimal ReporterCrisisRef shape: crisis UUID, map coordinates,
    radius, and geographic scope.  No project names, serial IDs, status labels,
    or timestamps — those must not appear in a reporter's browser DevTools.
    """
    result = await db.execute(
        select(Crisis)
        .where(Crisis.status == "active")
        .order_by(Crisis.created_at.desc())
    )
    return [_slim(c) for c in result.scalars().all()]
