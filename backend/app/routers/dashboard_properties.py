"""Dashboard properties router — Chapter 4.

Provides CRUD for Property records: list, detail, confirmed-status,
override, comments, recovery status, flag-for-review, version history.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_

from app.database import get_db
from app.models.crisis import Crisis
from app.models.property import Property
from app.models.property_comment import PropertyComment
from app.models.report import Report
from app.models.report_project import ReportProject
from app.models.reporter import Reporter
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user, require_section_access
from app.services.property_service import update_conflict_warning
from app.config import settings

router = APIRouter(prefix="/api/properties", tags=["Dashboard Properties"])

DAMAGE_LABELS = {
    "complete": "Completely Destroyed",
    "partial": "Partially Damaged",
    "minimal": "Minimal or No Damage",
}

# Maps frontend display keys → backend Report.damage_level codes
_DAMAGE_KEY_TO_CODE: dict[str, str] = {
    "completely_destroyed": "complete",
    "partially_damaged": "partial",
    "minimal_or_no_damage": "minimal",
    # pass-through for callers that already use backend codes
    "complete": "complete",
    "partial": "partial",
    "minimal": "minimal",
}

# Maps backend codes → frontend snake_case keys (used in all API responses)
_CODE_TO_SNAKE: dict[str, str] = {
    "complete": "completely_destroyed",
    "partial": "partially_damaged",
    "minimal": "minimal_or_no_damage",
}

VALID_CONFIRMED = {"complete", "partial", "minimal"}


# ── Response schemas ──────────────────────────────────────────────────────────

class PropertyListItem(BaseModel):
    property_id: str
    building_id: Optional[str]
    display_name: str
    address: Optional[str]
    country: Optional[str]
    latitude: float
    longitude: float
    current_damage_level: Optional[str]
    confirmed_status: Optional[str]
    auto_confirmed: bool
    manual_confirmed_lock: bool
    has_conflict_warning: bool
    total_reports: int
    total_reporters: int
    most_recent_report_at: Optional[datetime]
    is_recovered: bool
    property_status: str  # "Active" or "Recovered"


class PropertyListResponse(BaseModel):
    items: list[PropertyListItem]
    total: int
    cursor: Optional[str]
    has_more: bool


class PropertyStats(BaseModel):
    total: int
    confirmed: int
    with_conflict: int
    recovered: int


class ReporterRow(BaseModel):
    reporter_id: str
    most_recent_damage_level: Optional[str]
    most_recent_submitted_at: Optional[datetime]
    platform: Optional[str]
    flag_status: Optional[str]


class ConflictWarningDetail(BaseModel):
    majority_level: Optional[str]
    majority_count: int
    total_reports: int
    minority_percentage: float


class PropertyDetail(BaseModel):
    property_id: str
    building_id: Optional[str]
    display_name: str
    override_name: Optional[str]
    override_lat: Optional[float]
    override_lng: Optional[float]
    latitude: float
    longitude: float
    address: Optional[str]
    country: Optional[str]
    crisis_id: Optional[str]
    confirmed_status: Optional[str]
    auto_confirmed: bool
    manual_confirmed_lock: bool
    has_conflict_warning: bool
    conflict_warning_details: Optional[ConflictWarningDetail]
    total_reports: int
    total_reporters: int
    most_recent_report_at: Optional[datetime]
    is_recovered: bool
    is_flagged_for_review: bool
    flagged_for_review_note: Optional[str]
    property_status: str
    damage_distribution: dict[str, int]
    reporter_rows: list[ReporterRow]
    created_at: datetime
    updated_at: datetime


class CommentOut(BaseModel):
    id: int
    comment_text: str
    is_system_generated: bool
    system_event_type: Optional[str]
    created_at: datetime
    dashboard_user_name: Optional[str]


# ── Request schemas ───────────────────────────────────────────────────────────

class ConfirmedStatusRequest(BaseModel):
    confirmed_status: Optional[str]  # "complete" | "partial" | "minimal" | null
    comment: str

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("comment must be at least 3 characters")
        return v

    @field_validator("confirmed_status")
    @classmethod
    def valid_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_CONFIRMED:
            raise ValueError(f"confirmed_status must be one of {sorted(VALID_CONFIRMED)} or null")
        return v


class OverrideRequest(BaseModel):
    override_name: Optional[str] = None
    override_lat: Optional[float] = None
    override_lng: Optional[float] = None


class CommentRequest(BaseModel):
    comment_text: str

    @field_validator("comment_text")
    @classmethod
    def max_length(cls, v: str) -> str:
        if len(v) > 2000:
            raise ValueError("comment_text must not exceed 2000 characters")
        return v


class RecoveryRequest(BaseModel):
    is_recovered: bool
    comment: str

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("comment must be at least 3 characters")
        return v


class FlagForReviewRequest(BaseModel):
    note: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_property_or_404(db: AsyncSession, property_id: str) -> Property:
    result = await db.execute(select(Property).where(Property.id == property_id))
    prop = result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Property not found")
    return prop


def _display_name(prop: Property, best_report_name: Optional[str] = None) -> str:
    if prop.override_name:
        return prop.override_name
    if best_report_name:
        return best_report_name
    return f"{prop.latitude:.4f}, {prop.longitude:.4f}"


async def _publish_property_event(prop: Property, event_type: str, db: AsyncSession) -> None:
    try:
        result = await db.execute(
            select(Report.crisis_id).where(
                Report.property_id == prop.id
            ).limit(1)
        )
        row = result.scalar_one_or_none()
        if row:
            from app.routers.dashboard_sse import publish_event
            await publish_event(
                crisis_id=str(row),
                event_type=event_type,
                data={"property_id": prop.id},
            )
    except Exception:
        pass  # SSE publish is non-critical


async def _build_property_list_item(
    prop: Property,
    db: AsyncSession,
    project_id: Optional[str] = None,
) -> PropertyListItem:
    filters = [Report.property_id == prop.id]
    if project_id:
        filters.append(Report.crisis_id == project_id)

    # Only count qualifying (green/orange) reports — matches what is shown in the detail view
    qual_filters = filters + [Report.flag_status.in_(["green", "orange"])]

    # Aggregate stats
    agg = await db.execute(
        select(
            func.count(Report.id),
            func.count(func.distinct(Report.reporter_id)),
            func.max(Report.submitted_at),
        ).where(and_(*qual_filters))
    )
    total_reports, total_reporters, most_recent_at = agg.one()

    # Most recent qualifying report for damage level + country + address
    recent = await db.execute(
        select(Report.damage_level, Report.location_address, Report.building_name)
        .where(and_(*qual_filters))
        .order_by(Report.submitted_at.desc())
        .limit(1)
    )
    recent_row = recent.one_or_none()
    current_damage = recent_row[0] if recent_row else None
    address = recent_row[1] if recent_row else None
    report_name = recent_row[2] if recent_row else None

    # Country from the most recent report's reporter_country field
    country_row = await db.execute(
        select(Report.reporter_country)
        .where(and_(*filters, Report.reporter_country.isnot(None)))
        .order_by(Report.submitted_at.desc())
        .limit(1)
    )
    country = country_row.scalar_one_or_none()

    return PropertyListItem(
        property_id=prop.id,
        building_id=prop.building_id,
        display_name=_display_name(prop, report_name),
        address=address,
        country=country,
        latitude=prop.latitude,
        longitude=prop.longitude,
        current_damage_level=_CODE_TO_SNAKE.get(current_damage) if current_damage else None,
        confirmed_status=_CODE_TO_SNAKE.get(prop.confirmed_status) if prop.confirmed_status else None,
        auto_confirmed=prop.auto_confirmed,
        manual_confirmed_lock=prop.manual_confirmed_lock,
        has_conflict_warning=prop.has_conflict_warning,
        total_reports=total_reports or 0,
        total_reporters=total_reporters or 0,
        most_recent_report_at=most_recent_at,
        is_recovered=prop.is_recovered,
        property_status="Recovered" if prop.is_recovered else "Active",
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/stats", response_model=PropertyStats)
async def get_property_stats(
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(get_current_dashboard_user),
):
    qualifying_sq = (
        select(Report.property_id)
        .where(
            and_(
                Report.property_id.isnot(None),
                Report.flag_status.in_(["green", "orange"]),
            )
        )
        .distinct()
        .scalar_subquery()
    )

    result = await db.execute(
        select(
            func.count(Property.id),
            func.count(Property.id).filter(Property.confirmed_status.isnot(None)),
            func.count(Property.id).filter(Property.has_conflict_warning == True),
            func.count(Property.id).filter(Property.is_recovered == True),
        ).where(Property.id.in_(qualifying_sq))
    )
    row = result.one()
    return PropertyStats(
        total=row[0] or 0,
        confirmed=row[1] or 0,
        with_conflict=row[2] or 0,
        recovered=row[3] or 0,
    )


@router.get("", response_model=PropertyListResponse)
async def list_properties(
    cursor: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    damage_level: Optional[str] = Query(None),
    confirmed_status: Optional[str] = Query(None),  # "set" | "unset"
    conflict_warning: Optional[bool] = Query(None),
    property_status: Optional[str] = Query(None),  # "active" | "recovered"
    country: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    project_serial_id: Optional[str] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    search: Optional[str] = Query(None),
    show_unreviewed: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    filters = []

    if cursor:
        filters.append(Property.id > cursor)

    if confirmed_status == "set":
        filters.append(Property.confirmed_status.isnot(None))
    elif confirmed_status == "unset":
        filters.append(Property.confirmed_status.is_(None))

    if conflict_warning is not None:
        filters.append(Property.has_conflict_warning == conflict_warning)

    if property_status == "active":
        filters.append(Property.is_recovered == False)
    elif property_status == "recovered":
        filters.append(Property.is_recovered == True)

    if search:
        term = f"%{search}%"
        filters.append(
            or_(
                Property.override_name.ilike(term),
                Property.building_id.ilike(term),
                Property.id.ilike(term),
            )
        )

    # Only include properties with at least one qualifying report unless show_unreviewed
    if not show_unreviewed:
        qualifying_sq = (
            select(Report.property_id)
            .where(
                and_(
                    Report.property_id.isnot(None),
                    Report.flag_status.in_(["green", "orange"]),
                )
            )
            .distinct()
            .scalar_subquery()
        )
        filters.append(Property.id.in_(qualifying_sq))

    # Damage level filter — multi-value, maps display keys to backend codes
    if damage_level:
        raw_levels = [l.strip() for l in damage_level.split(",") if l.strip()]
        codes = list({_DAMAGE_KEY_TO_CODE[l] for l in raw_levels if l in _DAMAGE_KEY_TO_CODE})
        if codes:
            damage_sq = (
                select(Report.property_id)
                .where(
                    and_(
                        Report.flag_status.in_(["green", "orange"]),
                        Report.damage_level.in_(codes),
                        Report.property_id.isnot(None),
                    )
                )
                .distinct()
                .scalar_subquery()
            )
            filters.append(Property.id.in_(damage_sq))

    # Country filter via reporter
    if country:
        country_sq = (
            select(Report.property_id)
            .join(Reporter, Report.reporter_id == Reporter.id)
            .where(
                and_(
                    Report.property_id.isnot(None),
                    Reporter.country_code == country,
                )
            )
            .distinct()
            .scalar_subquery()
        )
        filters.append(Property.id.in_(country_sq))

    # Project / crisis filter by UUID
    if project_id:
        proj_sq = (
            select(Report.property_id)
            .where(
                and_(
                    Report.property_id.isnot(None),
                    Report.crisis_id == project_id,
                )
            )
            .distinct()
            .scalar_subquery()
        )
        filters.append(Property.id.in_(proj_sq))

    # Project filter by serial_id — finds properties whose reports are linked to the project
    if project_serial_id:
        crisis_result = await db.execute(
            select(Crisis.id).where(Crisis.serial_id == project_serial_id)
        )
        crisis_uuid = crisis_result.scalar_one_or_none()
        if crisis_uuid:
            serial_proj_sq = (
                select(Report.property_id)
                .join(ReportProject, ReportProject.report_id == Report.id)
                .where(
                    and_(
                        Report.property_id.isnot(None),
                        ReportProject.crisis_id == crisis_uuid,
                    )
                )
                .distinct()
                .scalar_subquery()
            )
            filters.append(Property.id.in_(serial_proj_sq))
        else:
            return PropertyListResponse(items=[], total=0, cursor=None, has_more=False)

    # Date range filter on most recent report
    if date_from or date_to:
        date_filters = [Report.property_id.isnot(None)]
        if date_from:
            date_filters.append(Report.submitted_at >= date_from)
        if date_to:
            date_filters.append(Report.submitted_at <= date_to)
        date_sq = (
            select(Report.property_id)
            .where(and_(*date_filters))
            .distinct()
            .scalar_subquery()
        )
        filters.append(Property.id.in_(date_sq))

    # Count total (before limit)
    total_result = await db.execute(
        select(func.count(Property.id)).where(and_(*filters) if filters else True)
    )
    total = total_result.scalar() or 0

    # Fetch page
    result = await db.execute(
        select(Property)
        .where(and_(*filters) if filters else True)
        .order_by(Property.id)
        .limit(limit + 1)
    )
    props = list(result.scalars().all())
    has_more = len(props) > limit
    if has_more:
        props = props[:limit]

    items = []
    for prop in props:
        items.append(await _build_property_list_item(prop, db, project_id))

    next_cursor = props[-1].id if has_more and props else None

    return PropertyListResponse(
        items=items,
        total=total,
        cursor=next_cursor,
        has_more=has_more,
    )


@router.get("/{property_id}", response_model=PropertyDetail)
async def get_property_detail(
    property_id: str,
    project_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    prop = await _get_property_or_404(db, property_id)

    report_filters = [Report.property_id == prop.id]
    if project_id:
        report_filters.append(Report.crisis_id == project_id)

    # Only count qualifying (green/orange) reports — matches reporter_rows and damage distribution
    qual_filters = report_filters + [Report.flag_status.in_(["green", "orange"])]

    # Aggregate stats
    agg = await db.execute(
        select(
            func.count(Report.id),
            func.count(func.distinct(Report.reporter_id)),
            func.max(Report.submitted_at),
        ).where(and_(*qual_filters))
    )
    total_reports, total_reporters, most_recent_at = agg.one()

    # Most recent qualifying report
    recent = await db.execute(
        select(Report.damage_level, Report.location_address, Report.building_name)
        .where(and_(*qual_filters))
        .order_by(Report.submitted_at.desc())
        .limit(1)
    )
    recent_row = recent.one_or_none()
    current_damage = recent_row[0] if recent_row else None
    address = recent_row[1] if recent_row else None
    report_name = recent_row[2] if recent_row else None

    # Country from the most recent report's reporter_country field
    country_row = await db.execute(
        select(Report.reporter_country)
        .where(and_(*report_filters, Report.reporter_country.isnot(None)))
        .order_by(Report.submitted_at.desc())
        .limit(1)
    )
    country = country_row.scalar_one_or_none()

    # Damage distribution
    dist_result = await db.execute(
        select(Report.damage_level, func.count(Report.id))
        .where(and_(*(qual_filters)))
        .group_by(Report.damage_level)
    )
    damage_distribution: dict[str, int] = {}
    for lvl, cnt in dist_result.all():
        damage_distribution[_CODE_TO_SNAKE.get(lvl, lvl)] = cnt

    # Conflict warning details
    conflict_details = None
    if prop.has_conflict_warning and damage_distribution:
        total_q = sum(damage_distribution.values())
        max_lvl = max(damage_distribution, key=lambda k: damage_distribution[k])
        max_cnt = damage_distribution[max_lvl]
        minority_pct = round(1.0 - max_cnt / total_q, 4) if total_q else 0.0
        conflict_details = ConflictWarningDetail(
            majority_level=max_lvl,
            majority_count=max_cnt,
            total_reports=total_q,
            minority_percentage=minority_pct,
        )

    # Crisis ID — taken from any report linked to this property
    crisis_id_result = await db.execute(
        select(Report.crisis_id).where(Report.property_id == prop.id).limit(1)
    )
    crisis_id_row = crisis_id_result.scalar_one_or_none()
    crisis_id_str = str(crisis_id_row) if crisis_id_row else None

    # Reporter rows — one per unique reporter (most recent qualifying report)
    reporter_sq = (
        select(
            Report.reporter_id,
            Report.damage_level,
            Report.submitted_at,
            Report.platform,
            Report.flag_status,
            func.row_number().over(
                partition_by=Report.reporter_id,
                order_by=Report.submitted_at.desc(),
            ).label("rn"),
        )
        .where(and_(*qual_filters, Report.reporter_id.isnot(None)))
        .subquery()
    )
    reporter_rows_result = await db.execute(
        select(reporter_sq).where(reporter_sq.c.rn == 1)
    )
    reporter_rows = [
        ReporterRow(
            reporter_id=str(r.reporter_id),
            most_recent_damage_level=_CODE_TO_SNAKE.get(r.damage_level),
            most_recent_submitted_at=r.submitted_at,
            platform=r.platform,
            flag_status=r.flag_status,
        )
        for r in reporter_rows_result.all()
    ]

    return PropertyDetail(
        property_id=prop.id,
        building_id=prop.building_id,
        display_name=_display_name(prop, report_name),
        override_name=prop.override_name,
        override_lat=prop.override_lat,
        override_lng=prop.override_lng,
        latitude=prop.latitude,
        longitude=prop.longitude,
        address=address,
        country=country,
        crisis_id=crisis_id_str,
        confirmed_status=_CODE_TO_SNAKE.get(prop.confirmed_status) if prop.confirmed_status else None,
        auto_confirmed=prop.auto_confirmed,
        manual_confirmed_lock=prop.manual_confirmed_lock,
        has_conflict_warning=prop.has_conflict_warning,
        conflict_warning_details=conflict_details,
        total_reports=total_reports or 0,
        total_reporters=total_reporters or 0,
        most_recent_report_at=most_recent_at,
        is_recovered=prop.is_recovered,
        is_flagged_for_review=prop.is_flagged_for_review,
        flagged_for_review_note=prop.flagged_for_review_note,
        property_status="Recovered" if prop.is_recovered else "Active",
        damage_distribution=damage_distribution,
        reporter_rows=reporter_rows,
        created_at=prop.created_at,
        updated_at=prop.updated_at,
    )


@router.patch("/{property_id}/confirmed-status", response_model=PropertyDetail)
async def set_confirmed_status(
    property_id: str,
    body: ConfirmedStatusRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("location_page", require_edit=True)),
):
    prop = await _get_property_or_404(db, property_id)

    old_status = prop.confirmed_status
    new_status = body.confirmed_status  # None means clear

    # Build system comment text
    old_label = DAMAGE_LABELS.get(old_status, old_status) if old_status else "Not Set"
    new_label = DAMAGE_LABELS.get(new_status, new_status) if new_status else "Cleared"

    if old_status is None and new_status is not None:
        event_type = "confirmed_status_set"
        sys_text = (
            f"Confirmed Status set to \"{new_label}\" by {current_user.full_name}. "
            f"Previous: Not set. Comment: {body.comment}"
        )
    elif old_status is not None and new_status is None:
        event_type = "confirmed_status_cleared"
        sys_text = (
            f"Confirmed Status cleared by {current_user.full_name}. "
            f"Previous value: \"{old_label}\". Comment: {body.comment}"
        )
    else:
        event_type = "confirmed_status_changed"
        sys_text = (
            f"Confirmed Status changed from \"{old_label}\" to \"{new_label}\" "
            f"by {current_user.full_name}. Comment: {body.comment}"
        )

    prop.confirmed_status = new_status
    prop.confirmed_by = current_user.id if new_status is not None else None
    prop.confirmed_at = datetime.now(timezone.utc) if new_status is not None else None
    prop.auto_confirmed = False

    if new_status is not None:
        # Manual set → lock out auto-confirm permanently until user clears it
        prop.manual_confirmed_lock = True
        prop.has_conflict_warning = False
    else:
        # Clearing confirmed status → unlock so auto-confirm can resume
        prop.manual_confirmed_lock = False

    db.add(PropertyComment(
        property_id=prop.id,
        dashboard_user_id=current_user.id,
        comment_text=sys_text,
        is_system_generated=True,
        system_event_type=event_type,
    ))

    await db.commit()
    await db.refresh(prop)

    # Recalculate conflict warning only when clearing confirmed status
    if new_status is None:
        await update_conflict_warning(db, prop.id)
        await db.commit()
        await db.refresh(prop)

    await _publish_property_event(prop, "property_updated", db)

    return await get_property_detail(property_id, None, db, current_user)


@router.patch("/{property_id}/override", response_model=PropertyDetail)
async def set_override(
    property_id: str,
    body: OverrideRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("location_page", require_edit=True)),
):
    prop = await _get_property_or_404(db, property_id)

    prop.override_name = body.override_name
    prop.override_lat = body.override_lat
    prop.override_lng = body.override_lng

    await db.commit()
    await db.refresh(prop)
    await _publish_property_event(prop, "property_updated", db)

    return await get_property_detail(property_id, None, db, current_user)


@router.get("/{property_id}/comments", response_model=list[CommentOut])
async def get_comments(
    property_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    await _get_property_or_404(db, property_id)

    result = await db.execute(
        select(PropertyComment, DashboardUser.full_name)
        .outerjoin(DashboardUser, PropertyComment.dashboard_user_id == DashboardUser.id)
        .where(PropertyComment.property_id == property_id)
        .order_by(PropertyComment.created_at.asc())
    )
    rows = result.all()

    return [
        CommentOut(
            id=c.id,
            comment_text=c.comment_text,
            is_system_generated=c.is_system_generated,
            system_event_type=c.system_event_type,
            created_at=c.created_at,
            dashboard_user_name=full_name if not c.is_system_generated else None,
        )
        for c, full_name in rows
    ]


@router.post("/{property_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(
    property_id: str,
    body: CommentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    await _get_property_or_404(db, property_id)

    comment = PropertyComment(
        property_id=property_id,
        dashboard_user_id=current_user.id,
        comment_text=body.comment_text,
        is_system_generated=False,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    try:
        result = await db.execute(
            select(Report.crisis_id).where(Report.property_id == property_id).limit(1)
        )
        row = result.scalar_one_or_none()
        if row:
            from app.routers.dashboard_sse import publish_event
            await publish_event(
                crisis_id=str(row),
                event_type="property_comment_added",
                data={"property_id": property_id, "comment_id": comment.id},
            )
    except Exception:
        pass

    return CommentOut(
        id=comment.id,
        comment_text=comment.comment_text,
        is_system_generated=False,
        system_event_type=None,
        created_at=comment.created_at,
        dashboard_user_name=current_user.full_name,
    )


@router.patch("/{property_id}/recovery-status", response_model=PropertyDetail)
async def set_recovery_status(
    property_id: str,
    body: RecoveryRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    prop = await _get_property_or_404(db, property_id)

    if body.is_recovered:
        event_type = "property_recovered"
        sys_text = (
            f"Property marked as Recovered by {current_user.full_name}. "
            f"Comment: {body.comment}"
        )
        prop.recovered_by = current_user.id
        prop.recovered_at = datetime.now(timezone.utc)
    else:
        event_type = "property_reinstated"
        sys_text = (
            f"Property reinstated as Active by {current_user.full_name}. "
            f"Comment: {body.comment}"
        )

    prop.is_recovered = body.is_recovered

    db.add(PropertyComment(
        property_id=prop.id,
        dashboard_user_id=current_user.id,
        comment_text=sys_text,
        is_system_generated=True,
        system_event_type=event_type,
    ))

    await db.commit()
    await db.refresh(prop)
    await _publish_property_event(prop, "property_updated", db)

    return await get_property_detail(property_id, None, db, current_user)


@router.post("/{property_id}/flag-for-review", response_model=PropertyDetail)
async def flag_for_review(
    property_id: str,
    body: FlagForReviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("location_page", require_edit=True)),
):
    prop = await _get_property_or_404(db, property_id)

    prop.is_flagged_for_review = True
    prop.flagged_for_review_note = body.note

    note_text = f" Note: {body.note}" if body.note else ""
    sys_text = f"Property flagged for review by {current_user.full_name}.{note_text}"

    db.add(PropertyComment(
        property_id=prop.id,
        dashboard_user_id=current_user.id,
        comment_text=sys_text,
        is_system_generated=True,
        system_event_type="flagged_for_review",
    ))

    await db.commit()
    await db.refresh(prop)
    await _publish_property_event(prop, "property_updated", db)

    return await get_property_detail(property_id, None, db, current_user)


@router.get("/{property_id}/reporters/{reporter_id}/versions")
async def get_reporter_versions(
    property_id: str,
    reporter_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    await _get_property_or_404(db, property_id)

    result = await db.execute(
        select(Report)
        .where(
            and_(
                Report.property_id == property_id,
                Report.reporter_id == reporter_id,
            )
        )
        .order_by(Report.submitted_at.desc())
    )
    reports = list(result.scalars().all())

    versions = []
    for i, r in enumerate(reports):
        # Compute change note by comparing to next (older) report
        change_note = None
        if i < len(reports) - 1:
            older = reports[i + 1]
            changes = []
            if r.damage_level != older.damage_level:
                changes.append(
                    f"Damage changed from {DAMAGE_LABELS.get(older.damage_level, older.damage_level)} "
                    f"to {DAMAGE_LABELS.get(r.damage_level, r.damage_level)}"
                )
            if r.flag_status != older.flag_status:
                changes.append(f"Flag changed from {older.flag_status} to {r.flag_status}")
            change_note = "; ".join(changes) if changes else "No changes from previous version"

        versions.append({
            "report_id": str(r.id),
            "serial_number": r.serial_number,
            "submitted_at": r.submitted_at.isoformat(),
            "damage_level": DAMAGE_LABELS.get(r.damage_level, r.damage_level),
            "flag_status": r.flag_status,
            "change_note": change_note,
        })

    return versions
