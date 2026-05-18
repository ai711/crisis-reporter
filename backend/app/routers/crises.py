"""Public crises endpoint.

Used by:
- Reporter app header dropdown: GET /api/crises
- Reporter app country list:    GET /api/crises/active
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


class PublicCrisisItem(BaseModel):
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


def _serialize(c: Crisis) -> PublicCrisisItem:
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


@router.get("", response_model=list[PublicCrisisItem])
async def list_crises_public(
    db: AsyncSession = Depends(get_db),
):
    """Public — Active and Closed projects for the header dropdown."""
    result = await db.execute(
        select(Crisis)
        .where(Crisis.status.in_(["active", "closed"]))
        .order_by(Crisis.created_at.desc())
    )
    return [_serialize(c) for c in result.scalars().all()]


@router.get("/active", response_model=list[PublicCrisisItem])
async def list_active_crises_public(
    db: AsyncSession = Depends(get_db),
):
    """Public — Active projects only. Used by reporter app country check."""
    result = await db.execute(
        select(Crisis)
        .where(Crisis.status == "active")
        .order_by(Crisis.created_at.desc())
    )
    return [_serialize(c) for c in result.scalars().all()]
