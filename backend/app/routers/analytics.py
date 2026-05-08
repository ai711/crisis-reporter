from datetime import date, datetime
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, cast, Date, and_
from pydantic import BaseModel

from app.database import get_db
from app.models.report import Report
from app.models.crisis import Crisis
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])

VERIFIED_FLAGS = ("green", "orange")


# ── Schemas ───────────────────────────────────────────────────────────────────

class SummaryResponse(BaseModel):
    total_reports: int
    total_properties: int
    completely_damaged: int
    partially_damaged: int
    minimal_damage: int


class DailyCount(BaseModel):
    date: str
    count: int


class DamageDistribution(BaseModel):
    completely_damaged: int
    partially_damaged: int
    minimal_damage: int
    completely_damaged_pct: float
    partially_damaged_pct: float
    minimal_damage_pct: float


class InfrastructureBreakdownItem(BaseModel):
    infrastructure_type: str
    count: int


class CountryBreakdownItem(BaseModel):
    country: str
    count: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def _base_conditions(
    country: Optional[str],
    date_from: Optional[date],
    date_to: Optional[date],
    crisis_type: Optional[str],
) -> list:
    """Build the WHERE conditions shared by all analytics queries."""
    conditions: list = [Report.flag_status.in_(VERIFIED_FLAGS)]

    if date_from:
        conditions.append(
            Report.created_at >= datetime(date_from.year, date_from.month, date_from.day)
        )
    if date_to:
        conditions.append(
            Report.created_at
            < datetime(date_to.year, date_to.month, date_to.day + 1)
        )
    if crisis_type:
        conditions.append(Report.disaster_type == crisis_type)
    return conditions


def _needs_crisis_join(country: Optional[str]) -> bool:
    return bool(country)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/summary", response_model=SummaryResponse)
async def get_summary(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)

    base = select(Report)
    if _needs_crisis_join(country):
        base = base.join(Crisis, Report.crisis_id == Crisis.id)
        conditions.append(Crisis.country_code == country)

    def _count_q(extra_cond=None):
        q = select(func.count(Report.id)).where(and_(*conditions))
        if _needs_crisis_join(country):
            q = q.join(Crisis, Report.crisis_id == Crisis.id)
        if extra_cond is not None:
            q = q.where(extra_cond)
        return q

    total_q = select(func.count(Report.id)).where(and_(*conditions))
    if _needs_crisis_join(country):
        total_q = total_q.join(Crisis, Report.crisis_id == Crisis.id)

    props_q = (
        select(func.count(func.distinct(Report.building_id)))
        .where(and_(*conditions, Report.building_id.isnot(None)))
    )
    if _needs_crisis_join(country):
        props_q = props_q.join(Crisis, Report.crisis_id == Crisis.id)

    complete_q = select(func.count(Report.id)).where(
        and_(*conditions, Report.damage_level == "complete")
    )
    partial_q = select(func.count(Report.id)).where(
        and_(*conditions, Report.damage_level == "partial")
    )
    minimal_q = select(func.count(Report.id)).where(
        and_(*conditions, Report.damage_level == "minimal")
    )

    if _needs_crisis_join(country):
        complete_q = complete_q.join(Crisis, Report.crisis_id == Crisis.id)
        partial_q = partial_q.join(Crisis, Report.crisis_id == Crisis.id)
        minimal_q = minimal_q.join(Crisis, Report.crisis_id == Crisis.id)

    total = (await db.execute(total_q)).scalar() or 0
    total_props = (await db.execute(props_q)).scalar() or 0
    complete = (await db.execute(complete_q)).scalar() or 0
    partial = (await db.execute(partial_q)).scalar() or 0
    minimal = (await db.execute(minimal_q)).scalar() or 0

    return SummaryResponse(
        total_reports=total,
        total_properties=total_props,
        completely_damaged=complete,
        partially_damaged=partial,
        minimal_damage=minimal,
    )


@router.get("/reports-over-time", response_model=list[DailyCount])
async def get_reports_over_time(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)

    day_col = cast(Report.created_at, Date).label("day")
    q = (
        select(day_col, func.count(Report.id).label("cnt"))
        .where(and_(*conditions))
        .group_by(day_col)
        .order_by(day_col)
    )
    if _needs_crisis_join(country):
        q = q.join(Crisis, Report.crisis_id == Crisis.id)
        conditions.append(Crisis.country_code == country)
        q = (
            select(day_col, func.count(Report.id).label("cnt"))
            .join(Crisis, Report.crisis_id == Crisis.id)
            .where(and_(*conditions))
            .group_by(day_col)
            .order_by(day_col)
        )

    rows = (await db.execute(q)).all()
    return [DailyCount(date=str(row.day), count=row.cnt) for row in rows]


@router.get("/damage-distribution", response_model=DamageDistribution)
async def get_damage_distribution(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)

    def _make_q(damage_level: str):
        q = select(func.count(Report.id)).where(
            and_(*conditions, Report.damage_level == damage_level)
        )
        if _needs_crisis_join(country):
            q = q.join(Crisis, Report.crisis_id == Crisis.id)
        return q

    total_q = select(func.count(Report.id)).where(and_(*conditions))
    if _needs_crisis_join(country):
        total_q = total_q.join(Crisis, Report.crisis_id == Crisis.id)
        if country:
            conditions.append(Crisis.country_code == country)
            total_q = select(func.count(Report.id)).where(and_(*conditions))
            total_q = total_q.join(Crisis, Report.crisis_id == Crisis.id)

    total = (await db.execute(total_q)).scalar() or 0
    complete = (await db.execute(_make_q("complete"))).scalar() or 0
    partial = (await db.execute(_make_q("partial"))).scalar() or 0
    minimal = (await db.execute(_make_q("minimal"))).scalar() or 0

    def pct(n: int) -> float:
        return round(n / total * 100, 1) if total else 0.0

    return DamageDistribution(
        completely_damaged=complete,
        partially_damaged=partial,
        minimal_damage=minimal,
        completely_damaged_pct=pct(complete),
        partially_damaged_pct=pct(partial),
        minimal_damage_pct=pct(minimal),
    )


@router.get("/infrastructure-breakdown", response_model=list[InfrastructureBreakdownItem])
async def get_infrastructure_breakdown(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)
    if country:
        conditions.append(Crisis.country_code == country)

    q = (
        select(Report.infrastructure_type, func.count(Report.id).label("cnt"))
        .where(and_(*conditions))
        .group_by(Report.infrastructure_type)
        .order_by(func.count(Report.id).desc())
    )
    if _needs_crisis_join(country):
        q = q.join(Crisis, Report.crisis_id == Crisis.id)

    rows = (await db.execute(q)).all()
    return [
        InfrastructureBreakdownItem(infrastructure_type=row.infrastructure_type, count=row.cnt)
        for row in rows
    ]


@router.get("/country-breakdown", response_model=list[CountryBreakdownItem])
async def get_country_breakdown(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(None, date_from, date_to, crisis_type)

    q = (
        select(Crisis.country_code, func.count(Report.id).label("cnt"))
        .join(Crisis, Report.crisis_id == Crisis.id)
        .where(and_(*conditions))
        .group_by(Crisis.country_code)
        .order_by(func.count(Report.id).desc())
    )

    rows = (await db.execute(q)).all()
    return [
        CountryBreakdownItem(country=row.country_code, count=row.cnt)
        for row in rows
    ]
