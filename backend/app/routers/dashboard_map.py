from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, cast, String
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.report import Report
from app.models.report_project import ReportProject
from app.models.crisis import Crisis
from app.models.property import Property
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
    property_id: Optional[str] = None


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
    project_serial_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get one pin per property for a crisis.

    Groups all qualifying Green/Orange reports by building_id (or lat/lng pair
    when building_id is null). Returns the most recent report's damage_level as
    the pin colour and the total qualifying report count for the property.
    Uses PostgreSQL window functions — no application-level deduplication.
    """

    allowed_flags = ["green", "orange"]
    if flag_status and flag_status in ["green", "orange", "red", "grey"]:
        allowed_flags = [flag_status]

    # Resolve project scope: when project_serial_id is provided, restrict pins to
    # properties that have qualifying reports linked to that project.
    project_report_ids: set | None = None
    if project_serial_id:
        proj_res = await db.execute(
            select(Crisis).where(Crisis.serial_id == project_serial_id)
        )
        proj = proj_res.scalar_one_or_none()
        if proj:
            rp_res = await db.execute(
                select(ReportProject.report_id)
                .where(ReportProject.crisis_id == proj.id)
            )
            project_report_ids = {row[0] for row in rp_res.all()}

    # Property grouping key: building_id if set, otherwise "lat_lng" string
    property_key = func.coalesce(
        Report.building_id,
        func.concat(
            cast(Report.gps_latitude, String),
            "_",
            cast(Report.gps_longitude, String),
        ),
    )

    base_conditions = [
        Report.crisis_id == crisis_id,
        Report.flag_status.in_(allowed_flags),
        Report.gps_latitude.isnot(None),
        Report.gps_longitude.isnot(None),
    ]
    if project_report_ids is not None:
        base_conditions.append(Report.id.in_(project_report_ids))

    # Subquery: rank reports within each property group (most recent first)
    # and count total qualifying reports per group via window functions.
    subq = (
        select(
            Report.building_id,
            Report.gps_latitude,
            Report.gps_longitude,
            Report.damage_level,
            Report.flag_status,
            func.row_number()
            .over(
                partition_by=property_key,
                order_by=Report.submitted_at.desc(),
            )
            .label("rn"),
            func.count()
            .over(partition_by=property_key)
            .label("report_count"),
        )
        .where(*base_conditions)
        .subquery()
    )

    # Keep only the most-recent row per property group
    result = await db.execute(select(subq).where(subq.c.rn == 1))
    rows = result.all()

    # Batch-look up property_id for each non-null building_id
    building_ids = [row.building_id for row in rows if row.building_id]
    prop_map: dict[str, str] = {}
    if building_ids:
        prop_result = await db.execute(
            select(Property.building_id, Property.id).where(
                Property.building_id.in_(building_ids)
            )
        )
        prop_map = {r.building_id: r.id for r in prop_result.all()}

    pins = [
        MapPin(
            building_id=row.building_id,
            latitude=row.gps_latitude,
            longitude=row.gps_longitude,
            damage_level=row.damage_level,
            report_count=row.report_count,
            flag_status=row.flag_status,
            property_id=prop_map.get(row.building_id) if row.building_id else None,
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
    """Get report counts by flag status for a crisis."""

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
