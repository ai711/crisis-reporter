from datetime import date, datetime
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, cast, Date, and_, text
from pydantic import BaseModel

from app.database import get_db
from app.models.report import Report
from app.models.crisis import Crisis
from app.models.flag_event import FlagEvent
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])

VERIFIED_FLAGS = ("green", "orange")

INFRA_LABELS: dict[str, str] = {
    "residential": "Residential Infrastructure",
    "commercial": "Commercial Infrastructure",
    "government": "Government Building",
    "utility": "Utility Infrastructure",
    "transport_communication": "Transport and Communication Infrastructure",
    "transport": "Transport and Communication Infrastructure",
    "community": "Community Infrastructure",
    "public_spaces": "Public Spaces and Recreation Infrastructure",
    "other": "Other",
}

CRISIS_TYPE_LABELS: dict[str, str] = {
    "earthquake": "Earthquake",
    "flood": "Flood",
    "tsunami": "Tsunami",
    "hurricane_cyclone": "Hurricane or Cyclone",
    "hurricane": "Hurricane or Cyclone",
    "cyclone": "Hurricane or Cyclone",
    "wildfire": "Wildfire",
    "fire": "Wildfire",
    "explosion": "Explosion",
    "chemical_incident": "Chemical Incident",
    "conflict": "Conflict",
    "civil_unrest": "Civil Unrest",
}

FLAG_REASON_LABELS: dict[str, str] = {
    "ip_country_mismatch": "IP Country Mismatch",
    "same_ip_multiple_devices": "Same IP — Multiple Devices",
    "duplicate_image": "Duplicate Image Hash",
    "coordinated_gps_duplicate": "Coordinated GPS Duplicate",
    "high_submission_rate": "High Submission Rate",
    "no_photos": "No Photos Attached",
    "no_location": "No Location Data",
    "blocked_device": "Blocked Device",
    "blocked_ip": "Blocked IP Address",
    "duplicate_submission": "Duplicate Submission",
}


# ── Schemas ───────────────────────────────────────────────────────────────────

class SummaryResponse(BaseModel):
    total_reports: int
    total_properties: int
    completely_damaged: int
    partially_damaged: int
    minimal_damage: int


class TimePoint(BaseModel):
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


class CrisisTypeBreakdownItem(BaseModel):
    crisis_type: str
    count: int


class FlagQualityItem(BaseModel):
    flag_type: str
    total_raised: int
    cleared_count: int
    cleared_percentage: float
    discard_reason_count: int
    discard_reason_percentage: float
    inconclusive_count: int
    inconclusive_percentage: float


class FlagQualityResponse(BaseModel):
    total_reviewed: int
    items: list[FlagQualityItem]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_csv(val: Optional[str]) -> list[str]:
    if not val:
        return []
    return [v.strip() for v in val.split(",") if v.strip()]


def _needs_crisis_join(country: Optional[str]) -> bool:
    return bool(_parse_csv(country))


def _country_conditions(country: Optional[str]) -> list:
    countries = _parse_csv(country)
    if not countries:
        return []
    if len(countries) == 1:
        return [Crisis.country_code == countries[0]]
    return [Crisis.country_code.in_(countries)]


def _base_conditions(
    country: Optional[str],
    date_from: Optional[date],
    date_to: Optional[date],
    crisis_type: Optional[str],
) -> list:
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

    ctypes = _parse_csv(crisis_type)
    if len(ctypes) == 1:
        conditions.append(Report.disaster_type == ctypes[0])
    elif len(ctypes) > 1:
        conditions.append(Report.disaster_type.in_(ctypes))

    return conditions


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
    country_conds = _country_conditions(country)
    needs_join = _needs_crisis_join(country)

    def _count_q(extra_cond=None):
        conds = list(conditions)
        if extra_cond is not None:
            conds.append(extra_cond)
        q = select(func.count(Report.id)).where(and_(*conds))
        if needs_join:
            q = q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))
        return q

    total_q = _count_q()
    props_q = (
        select(func.count(func.distinct(Report.building_id)))
        .where(and_(*conditions, Report.building_id.isnot(None)))
    )
    if needs_join:
        props_q = props_q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))

    total = (await db.execute(total_q)).scalar() or 0
    total_props = (await db.execute(props_q)).scalar() or 0
    complete = (await db.execute(_count_q(Report.damage_level == "complete"))).scalar() or 0
    partial = (await db.execute(_count_q(Report.damage_level == "partial"))).scalar() or 0
    minimal = (await db.execute(_count_q(Report.damage_level == "minimal"))).scalar() or 0

    return SummaryResponse(
        total_reports=total,
        total_properties=total_props,
        completely_damaged=complete,
        partially_damaged=partial,
        minimal_damage=minimal,
    )


@router.get("/reports-over-time", response_model=list[TimePoint])
async def get_reports_over_time(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    granularity: str = Query("daily"),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)
    country_conds = _country_conditions(country)
    needs_join = _needs_crisis_join(country)

    if granularity == "weekly":
        day_col = func.date_trunc("week", Report.created_at).label("day")
    else:
        day_col = cast(Report.created_at, Date).label("day")

    q = (
        select(day_col, func.count(Report.id).label("cnt"))
        .where(and_(*conditions))
        .group_by(day_col)
        .order_by(day_col)
    )
    if needs_join:
        q = q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))

    rows = (await db.execute(q)).all()
    return [TimePoint(date=str(row.day)[:10], count=row.cnt) for row in rows]


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
    country_conds = _country_conditions(country)
    needs_join = _needs_crisis_join(country)

    def _make_q(damage_level: str):
        q = select(func.count(Report.id)).where(
            and_(*conditions, Report.damage_level == damage_level)
        )
        if needs_join:
            q = q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))
        return q

    total_q = select(func.count(Report.id)).where(and_(*conditions))
    if needs_join:
        total_q = total_q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))

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
    sql_params: dict = {"flags": list(VERIFIED_FLAGS)}
    where_parts = ["r.flag_status = ANY(:flags)"]

    if date_from:
        where_parts.append("r.created_at >= :date_from_dt")
        sql_params["date_from_dt"] = datetime(date_from.year, date_from.month, date_from.day)
    if date_to:
        where_parts.append("r.created_at < :date_to_dt")
        sql_params["date_to_dt"] = datetime(date_to.year, date_to.month, date_to.day + 1)

    ctypes = _parse_csv(crisis_type)
    if ctypes:
        where_parts.append("r.disaster_type = ANY(:ctypes)")
        sql_params["ctypes"] = ctypes

    countries = _parse_csv(country)
    join_clause = ""
    if countries:
        join_clause = "JOIN crises cr ON r.crisis_id = cr.id"
        where_parts.append("cr.country_code = ANY(:countries)")
        sql_params["countries"] = countries

    where_clause = " AND ".join(where_parts)

    sql = text(f"""
        SELECT
            it AS infra_type,
            COUNT(DISTINCT r.id) AS cnt
        FROM reports r
        {join_clause}
        CROSS JOIN LATERAL unnest(
            COALESCE(r.infrastructure_types, ARRAY[r.infrastructure_type])
        ) AS it
        WHERE {where_clause}
        GROUP BY it
        ORDER BY cnt DESC
    """)

    rows = (await db.execute(sql, sql_params)).all()

    mapped: dict[str, int] = {}
    for row in rows:
        raw = (row.infra_type or "").lower().strip()
        label = INFRA_LABELS.get(raw, raw.replace("_", " ").title() if raw else "Other")
        mapped[label] = mapped.get(label, 0) + row.cnt

    return [
        InfrastructureBreakdownItem(infrastructure_type=lbl, count=cnt)
        for lbl, cnt in sorted(mapped.items(), key=lambda x: -x[1])
    ]


@router.get("/country-breakdown", response_model=list[CountryBreakdownItem])
async def get_country_breakdown(
    country: Optional[str] = Query(None),
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

    countries = _parse_csv(country)
    if countries:
        q = q.where(Crisis.country_code.in_(countries))

    rows = (await db.execute(q)).all()
    return [CountryBreakdownItem(country=row.country_code, count=row.cnt) for row in rows]


@router.get("/crisis-type-breakdown", response_model=list[CrisisTypeBreakdownItem])
async def get_crisis_type_breakdown(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = _base_conditions(country, date_from, date_to, crisis_type)
    country_conds = _country_conditions(country)
    needs_join = _needs_crisis_join(country)

    q = (
        select(Report.disaster_type, func.count(Report.id).label("cnt"))
        .where(and_(*conditions, Report.disaster_type.isnot(None)))
        .group_by(Report.disaster_type)
        .order_by(func.count(Report.id).desc())
    )
    if needs_join:
        q = q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))

    rows = (await db.execute(q)).all()

    mapped: dict[str, int] = {}
    for row in rows:
        raw = (row.disaster_type or "").lower().strip()
        label = CRISIS_TYPE_LABELS.get(raw, raw.replace("_", " ").title())
        mapped[label] = mapped.get(label, 0) + row.cnt

    return [
        CrisisTypeBreakdownItem(crisis_type=lbl, count=cnt)
        for lbl, cnt in sorted(mapped.items(), key=lambda x: -x[1])
    ]


@router.get("/flag-quality", response_model=FlagQualityResponse)
async def get_flag_quality(
    country: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    crisis_type: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    flag_conditions: list = [
        FlagEvent.changed_by == "manual",
        FlagEvent.flag_metadata.isnot(None),
    ]

    if date_from:
        flag_conditions.append(
            FlagEvent.created_at >= datetime(date_from.year, date_from.month, date_from.day)
        )
    if date_to:
        flag_conditions.append(
            FlagEvent.created_at < datetime(date_to.year, date_to.month, date_to.day + 1)
        )

    report_conditions: list = []
    ctypes = _parse_csv(crisis_type)
    if len(ctypes) == 1:
        report_conditions.append(Report.disaster_type == ctypes[0])
    elif len(ctypes) > 1:
        report_conditions.append(Report.disaster_type.in_(ctypes))

    country_conds = _country_conditions(country)
    needs_join = _needs_crisis_join(country)

    q = (
        select(FlagEvent.report_id, FlagEvent.flag_metadata)
        .join(Report, FlagEvent.report_id == Report.id)
        .where(and_(*flag_conditions, *report_conditions))
    )
    if needs_join:
        q = q.join(Crisis, Report.crisis_id == Crisis.id).where(and_(*country_conds))

    flag_rows = (await db.execute(q)).all()

    reviewed_ids: set = set()
    for row in flag_rows:
        reviewed_ids.add(str(row.report_id))
    total_reviewed = len(reviewed_ids)

    totals: dict[str, int] = {}
    cleared: dict[str, int] = {}
    discard_reason: dict[str, int] = {}
    inconclusive: dict[str, int] = {}

    for row in flag_rows:
        meta = row.flag_metadata
        if not meta or not isinstance(meta, dict):
            continue
        decision = meta.get("decision", "")
        assessments = meta.get("flag_assessments", [])
        if not isinstance(assessments, list):
            continue
        for assessment in assessments:
            raw_reason = assessment.get("reason", "")
            label = FLAG_REASON_LABELS.get(
                raw_reason,
                raw_reason.replace("_", " ").title() if raw_reason else "Unknown",
            )
            dismissed = bool(assessment.get("dismissed", False))
            totals[label] = totals.get(label, 0) + 1
            if dismissed:
                cleared[label] = cleared.get(label, 0) + 1
            elif decision == "discard":
                discard_reason[label] = discard_reason.get(label, 0) + 1
            else:
                inconclusive[label] = inconclusive.get(label, 0) + 1

    items: list[FlagQualityItem] = []
    for label, total in sorted(totals.items(), key=lambda x: -x[1]):
        cl = cleared.get(label, 0)
        dr = discard_reason.get(label, 0)
        inc = inconclusive.get(label, 0)
        items.append(
            FlagQualityItem(
                flag_type=label,
                total_raised=total,
                cleared_count=cl,
                cleared_percentage=round(cl / total * 100, 1) if total else 0.0,
                discard_reason_count=dr,
                discard_reason_percentage=round(dr / total * 100, 1) if total else 0.0,
                inconclusive_count=inc,
                inconclusive_percentage=round(inc / total * 100, 1) if total else 0.0,
            )
        )

    return FlagQualityResponse(total_reviewed=total_reviewed, items=items)
