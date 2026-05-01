from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.report import Report
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/dashboard/map", tags=["Dashboard Map"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class MapPin(BaseModel):
    building_id: Optional[str]
    latitude: float
    longitude: float
    damage_level: str
    report_count: int
    flag_status: str


class MapPinsResponse(BaseModel):
    pins: list[MapPin]
    total: int


class DashboardStats(BaseModel):
    total_reports: int
    green_count: int
    orange_count: int
    red_count: int
    grey_count: int
    review_queue_count: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/pins", response_model=MapPinsResponse)
async def get_map_pins(
    crisis_id: str = Query(...),
    flag_status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get all map pins for a crisis.
    Each pin represents one building with its highest damage level.
    Only Green and Orange flagged reports appear by default.
    One pin per building — never duplicate pins."""

    # Default to green and orange only
    allowed_flags = ["green", "orange"]
    if flag_status and flag_status in ["grey", "green", "orange", "red"]:
        allowed_flags = [flag_status]

    # Get one representative report per building
    # Priority: most recent, highest damage level
    result = await db.execute(
        select(
            Report.building_id,
            Report.gps_latitude,
            Report.gps_longitude,
            Report.damage_level,
            Report.flag_status,
            func.count(Report.id).label("report_count"),
        )
        .where(
            Report.crisis_id == crisis_id,
            Report.flag_status.in_(allowed_flags),
            Report.gps_latitude.isnot(None),
            Report.gps_longitude.isnot(None),
        )
        .group_by(
            Report.building_id,
            Report.gps_latitude,
            Report.gps_longitude,
            Report.damage_level,
            Report.flag_status,
        )
        .order_by(Report.gps_latitude)
    )

    rows = result.all()

    pins = [
        MapPin(
            building_id=row.building_id,
            latitude=row.gps_latitude,
            longitude=row.gps_longitude,
            damage_level=row.damage_level,
            report_count=row.report_count,
            flag_status=row.flag_status,
        )
        for row in rows
    ]

    return MapPinsResponse(pins=pins, total=len(pins))


@router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(
    crisis_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get report counts by flag status for a crisis.
    Used for dashboard counters and analytics."""

    result = await db.execute(
        select(Report.flag_status, func.count(Report.id))
        .where(Report.crisis_id == crisis_id)
        .group_by(Report.flag_status)
    )
    rows = result.all()

    counts = {row[0]: row[1] for row in rows}

    return DashboardStats(
        total_reports=sum(counts.values()),
        green_count=counts.get("green", 0),
        orange_count=counts.get("orange", 0),
        red_count=counts.get("red", 0),
        grey_count=counts.get("grey", 0),
        review_queue_count=counts.get("red", 0),
    )