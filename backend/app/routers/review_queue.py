"""Review Queue router — Chapter 5.

Endpoints:
  GET  /api/review-queue/counts                        — four tab counts, single round-trip
  GET  /api/review-queue/tab1                          — Red-flagged reports (oldest first)
  GET  /api/review-queue/tab2                          — Properties needing review
  GET  /api/review-queue/tab3                          — Stuck Grey reports (> threshold)
  GET  /api/review-queue/tab4                          — Auto-blocked profiles awaiting confirmation
  POST /api/review-queue/tab1/{report_id}/review       — Acquire soft lock on a report
  POST /api/review-queue/tab3/{report_id}/force-resolution  — Force Grey → Green or Red
  POST /api/review-queue/tab2/{property_id}/dismiss    — Dismiss property from review queue
  POST /api/review-queue/tab4/{reporter_id}/confirm    — Confirm auto-block
  POST /api/review-queue/tab4/{reporter_id}/reverse    — Reverse auto-block
  POST /api/review-queue/release-lock                  — Release soft lock
"""

import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.flag_event import FlagEvent
from app.models.property import Property
from app.models.property_comment import PropertyComment
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user, get_redis, require_section_access
from app.services.soft_lock_service import acquire_soft_lock, get_soft_lock, release_soft_lock
from app.config import settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/review-queue", tags=["Review Queue"])


# ── Request schemas ───────────────────────────────────────────────────────────

class ForceResolutionRequest(BaseModel):
    target_status: str
    reason: str

    @field_validator("target_status")
    @classmethod
    def valid_target(cls, v: str) -> str:
        if v not in ("green", "red"):
            raise ValueError("target_status must be 'green' or 'red'")
        return v

    @field_validator("reason")
    @classmethod
    def reason_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("reason must be at least 3 characters")
        return v.strip()


class DismissRequest(BaseModel):
    comment: str

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("comment must be at least 3 characters")
        return v.strip()


class ConfirmBlockRequest(BaseModel):
    comment: str

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("comment must be at least 3 characters")
        return v.strip()


class ReleaseLockRequest(BaseModel):
    item_type: str
    item_id: str


class ReviewDecisionRequest(BaseModel):
    decision: str
    flag_assessments: list[dict]
    comment: str

    @field_validator("decision")
    @classmethod
    def valid_decision(cls, v: str) -> str:
        if v not in ("approve", "discard"):
            raise ValueError("decision must be 'approve' or 'discard'")
        return v

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("comment must be at least 3 characters")
        return v.strip()


# ── Safe soft-lock helper ─────────────────────────────────────────────────────

async def _get_lock_safe(redis, item_type: str, item_id: str) -> Optional[dict]:
    """Returns soft lock data or None — never raises even if Redis is down."""
    try:
        return await get_soft_lock(redis, item_type, item_id)
    except Exception:
        return None


# ── Counts endpoint ───────────────────────────────────────────────────────────

@router.get("/counts")
async def get_review_queue_counts(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Single lightweight aggregation returning all four tab counts."""
    now = datetime.now(timezone.utc)
    stuck_cutoff = now - timedelta(minutes=settings.STUCK_REPORT_THRESHOLD_MINUTES)

    tab1_res = await db.execute(
        select(func.count(Report.id)).where(Report.flag_status == "red")
    )
    tab1_count = tab1_res.scalar() or 0

    # Check review_queue_threshold notification — insert if threshold exceeded and
    # no notification was triggered in the last hour.
    try:
        from app.models.app_setting import AppSetting
        from sqlalchemy import text as _text
        threshold = 50
        notif_row = await db.execute(select(AppSetting).where(AppSetting.key == "notifications"))
        notif_rec = notif_row.scalar_one_or_none()
        if notif_rec and isinstance(notif_rec.value, dict):
            for t in notif_rec.value.get("types", []):
                if t.get("key") == "review_queue_threshold" and t.get("active", True):
                    v = t.get("threshold")
                    threshold = v if v is not None else 50
        if tab1_count >= threshold:
            cutoff = now - timedelta(hours=1)
            recent = await db.execute(
                _text(
                    "SELECT id FROM notifications WHERE notification_type_key = 'review_queue_threshold'"
                    " AND triggered_at >= :cutoff LIMIT 1"
                ),
                {"cutoff": cutoff},
            )
            if not recent.scalar_one_or_none():
                await db.execute(
                    _text(
                        "INSERT INTO notifications (notification_type_key, message, triggered_at, is_global)"
                        " VALUES ('review_queue_threshold',"
                        " :msg, NOW(), TRUE)"
                    ),
                    {"msg": f"Review Queue Alert — {tab1_count} Red-flagged reports are pending review."},
                )
                await db.commit()
    except Exception as _e:
        log.warning("review_queue threshold notification check failed: %s", _e)

    tab2_res = await db.execute(
        select(func.count(Property.id)).where(
            or_(Property.has_conflict_warning == True, Property.is_flagged_for_review == True)
        )
    )
    tab2_count = tab2_res.scalar() or 0

    tab3_res = await db.execute(
        select(func.count(Report.id)).where(
            and_(Report.flag_status == "grey", Report.created_at <= stuck_cutoff)
        )
    )
    tab3_count = tab3_res.scalar() or 0

    tab4_res = await db.execute(
        select(func.count(Reporter.id)).where(
            Reporter.pending_auto_block_confirmation == True
        )
    )
    tab4_count = tab4_res.scalar() or 0

    return {
        "tab1_count": tab1_count,
        "tab2_count": tab2_count,
        "tab3_count": tab3_count,
        "tab4_count": tab4_count,
    }


# ── Tab 1: Red-flagged reports ────────────────────────────────────────────────

@router.get("/tab1")
async def get_tab1(
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=25, ge=1, le=100),
    flag_reason: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Red-flagged reports sorted oldest flagged first."""
    now = datetime.now(timezone.utc)

    # Correlated subquery: timestamp of the most recent "→red" flag event per report
    flagged_at_col = (
        select(func.max(FlagEvent.created_at))
        .where(and_(FlagEvent.report_id == Report.id, FlagEvent.flag_to == "red"))
        .correlate(Report)
        .scalar_subquery()
    )

    # Country from reporter (correlated)
    country_col = (
        select(Reporter.country_code)
        .where(Reporter.id == Report.reporter_id)
        .correlate(Report)
        .scalar_subquery()
    )

    # Reporter display_id (correlated)
    display_id_col = (
        select(Reporter.display_id)
        .where(Reporter.id == Report.reporter_id)
        .correlate(Report)
        .scalar_subquery()
    )

    conditions = [Report.flag_status == "red"]

    if country:
        country_sq = (
            select(Reporter.id)
            .where(Reporter.country_code == country)
            .scalar_subquery()
        )
        conditions.append(Report.reporter_id.in_(country_sq))

    if date_from:
        try:
            dt = datetime.fromisoformat(date_from.replace("Z", "+00:00"))
            conditions.append(flagged_at_col >= dt)
        except ValueError:
            pass

    if date_to:
        try:
            dt = datetime.fromisoformat(date_to.replace("Z", "+00:00"))
            conditions.append(flagged_at_col <= dt)
        except ValueError:
            pass

    if crisis_type:
        conditions.append(Report.disaster_type == crisis_type)

    if search:
        search_stripped = search.lstrip("#").strip()
        # Try serial number first (e.g. user types "42" or "#42")
        if search_stripped.isdigit():
            conditions.append(Report.serial_number == int(search_stripped))
        else:
            try:
                search_uuid = uuid.UUID(search_stripped)
                conditions.append(
                    or_(Report.id == search_uuid, Report.reporter_id == search_uuid)
                )
            except ValueError:
                pass

    # Cursor: "iso_timestamp_uuid"
    if cursor:
        try:
            parts = cursor.split("_", 1)
            cursor_dt = datetime.fromisoformat(parts[0])
            cursor_id = parts[1]
            conditions.append(
                or_(
                    flagged_at_col > cursor_dt,
                    and_(flagged_at_col == cursor_dt, Report.id > cursor_id),
                )
            )
        except Exception:
            pass

    query = (
        select(
            Report,
            flagged_at_col.label("flagged_at"),
            country_col.label("country"),
            display_id_col.label("reporter_display_id"),
        )
        .where(and_(*conditions))
        .order_by(flagged_at_col.asc().nulls_last(), Report.id.asc())
        .limit(limit + 1)
    )

    result = await db.execute(query)
    rows = result.all()

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    # Batch-fetch flag events — extract triggered_rules (new format) or
    # raw reason text (legacy format) for each report.
    if rows:
        report_ids = [str(r[0].id) for r in rows]
        events_result = await db.execute(
            select(
                FlagEvent.report_id,
                FlagEvent.reason,
                FlagEvent.flag_metadata,
                FlagEvent.changed_by,
            )
            .where(
                and_(
                    FlagEvent.report_id.in_([uuid.UUID(rid) for rid in report_ids]),
                    FlagEvent.flag_to == "red",
                )
            )
            .order_by(FlagEvent.created_at.desc())
        )
        flag_reasons_map: dict[str, list[str]] = {}
        triggered_rules_map: dict[str, list[dict]] = {}

        for report_id_val, reason, metadata, changed_by in events_result.all():
            key = str(report_id_val)
            # New format: auto-flag event with triggered_rules list in metadata
            if (
                changed_by == "auto"
                and metadata
                and "triggered_rules" in metadata
                and key not in triggered_rules_map
            ):
                rules: list[dict] = metadata["triggered_rules"]
                triggered_rules_map[key] = rules
                flag_reasons_map[key] = [r.get("reason", "") for r in rules if r.get("reason")]
            elif reason and key not in triggered_rules_map:
                # Legacy event without triggered_rules structure
                flag_reasons_map.setdefault(key, []).append(reason)
    else:
        flag_reasons_map = {}
        triggered_rules_map = {}

    # Also filter by flag_reason if provided (post-fetch since it's in metadata)
    items = []
    for report, flagged_at, country_code, reporter_display_id in rows:
        rid = str(report.id)
        reasons = flag_reasons_map.get(rid, [])

        if flag_reason and not any(flag_reason.lower() in r.lower() for r in reasons):
            continue

        time_in_queue = int((now - flagged_at).total_seconds()) if flagged_at else 0
        lock_data = await _get_lock_safe(redis, "report", rid)

        infra_types = report.infrastructure_types or ([report.infrastructure_type] if report.infrastructure_type else [])

        items.append({
            "report_id": rid,
            "serial_number": report.serial_number,
            "flagged_at": flagged_at.isoformat() if flagged_at else None,
            "country": country_code,
            "damage_level": report.damage_level,
            "infrastructure_types": infra_types,
            "crisis_type": report.disaster_type,
            "flag_reasons": reasons,
            "triggered_rules": triggered_rules_map.get(rid, []),
            "reporter_id": str(report.reporter_id) if report.reporter_id else None,
            "reporter_display_id": reporter_display_id,
            "time_in_queue": max(0, time_in_queue),
            "soft_lock": lock_data,
        })

    # Total count for tab1
    count_conditions = [Report.flag_status == "red"]
    if country:
        country_sq = (
            select(Reporter.id)
            .where(Reporter.country_code == country)
            .scalar_subquery()
        )
        count_conditions.append(Report.reporter_id.in_(country_sq))
    if crisis_type:
        count_conditions.append(Report.disaster_type == crisis_type)

    total_res = await db.execute(
        select(func.count(Report.id)).where(and_(*count_conditions))
    )
    total = total_res.scalar() or 0

    next_cursor = None
    if has_more and rows:
        last_report, last_flagged_at, _, _ = rows[-1]
        if last_flagged_at:
            next_cursor = f"{last_flagged_at.isoformat()}_{str(last_report.id)}"

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── Tab 2: Properties needing review ─────────────────────────────────────────

@router.get("/tab2")
async def get_tab2(
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=25, ge=1, le=100),
    review_reason: Optional[str] = Query(None),  # "conflict_warning" | "manually_flagged"
    country: Optional[str] = Query(None),
    damage_level: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Properties with active conflict warnings or manually flagged for review."""
    now = datetime.now(timezone.utc)

    conditions = [
        or_(Property.has_conflict_warning == True, Property.is_flagged_for_review == True)
    ]

    if review_reason == "conflict_warning":
        conditions = [Property.has_conflict_warning == True]
    elif review_reason == "manually_flagged":
        conditions = [Property.is_flagged_for_review == True]

    if cursor:
        conditions.append(Property.updated_at > datetime.fromisoformat(cursor))

    if date_from:
        try:
            conditions.append(Property.updated_at >= datetime.fromisoformat(date_from.replace("Z", "+00:00")))
        except ValueError:
            pass

    if date_to:
        try:
            conditions.append(Property.updated_at <= datetime.fromisoformat(date_to.replace("Z", "+00:00")))
        except ValueError:
            pass

    if search:
        term = f"%{search}%"
        conditions.append(
            or_(
                Property.id.ilike(term),
                Property.override_name.ilike(term),
                Property.building_id.ilike(term),
            )
        )

    # Country and damage_level require joins with Report/Reporter
    if country:
        country_sq = (
            select(Report.property_id)
            .join(Reporter, Report.reporter_id == Reporter.id)
            .where(and_(Report.property_id.isnot(None), Reporter.country_code == country))
            .distinct()
            .scalar_subquery()
        )
        conditions.append(Property.id.in_(country_sq))

    if damage_level:
        dl_sq = (
            select(Report.property_id)
            .where(
                and_(
                    Report.property_id.isnot(None),
                    Report.flag_status.in_(["green", "orange"]),
                    Report.damage_level == damage_level,
                )
            )
            .distinct()
            .scalar_subquery()
        )
        conditions.append(Property.id.in_(dl_sq))

    total_res = await db.execute(
        select(func.count(Property.id)).where(and_(*conditions))
    )
    total = total_res.scalar() or 0

    result = await db.execute(
        select(Property)
        .where(and_(*conditions))
        .order_by(Property.updated_at.asc())
        .limit(limit + 1)
    )
    props = list(result.scalars().all())
    has_more = len(props) > limit
    if has_more:
        props = props[:limit]

    # Fetch current_damage_level and country for each property
    prop_ids = [p.id for p in props]
    country_map: dict[str, Optional[str]] = {}
    damage_map: dict[str, Optional[str]] = {}

    if prop_ids:
        # Country: most recent report's reporter country
        country_rows = await db.execute(
            select(Report.property_id, Reporter.country_code)
            .join(Reporter, Report.reporter_id == Reporter.id)
            .where(
                and_(
                    Report.property_id.in_(prop_ids),
                    Report.reporter_id.isnot(None),
                )
            )
            .order_by(Report.submitted_at.desc())
        )
        for prop_id, cc in country_rows.all():
            if prop_id not in country_map:
                country_map[prop_id] = cc

        # Damage: most recent green/orange report
        dmg_rows = await db.execute(
            select(Report.property_id, Report.damage_level)
            .where(
                and_(
                    Report.property_id.in_(prop_ids),
                    Report.flag_status.in_(["green", "orange"]),
                )
            )
            .order_by(Report.submitted_at.desc())
        )
        for prop_id, dl in dmg_rows.all():
            if prop_id not in damage_map:
                damage_map[prop_id] = dl

    items = []
    for prop in props:
        if prop.has_conflict_warning and prop.is_flagged_for_review:
            review_reason_label = "Both"
        elif prop.has_conflict_warning:
            review_reason_label = "Conflict Warning"
        else:
            review_reason_label = "Manually Flagged"

        time_in_queue = int((now - prop.updated_at).total_seconds())
        lock_data = await _get_lock_safe(redis, "property", prop.id)

        items.append({
            "property_id": prop.id,
            "display_name": prop.override_name or f"{prop.latitude:.4f}, {prop.longitude:.4f}",
            "country": country_map.get(prop.id),
            "current_damage_level": damage_map.get(prop.id),
            "has_conflict_warning": prop.has_conflict_warning,
            "is_flagged_for_review": prop.is_flagged_for_review,
            "flagged_for_review_note": prop.flagged_for_review_note,
            "review_reason": review_reason_label,
            "time_in_queue": max(0, time_in_queue),
            "soft_lock": lock_data,
        })

    next_cursor = props[-1].updated_at.isoformat() if has_more and props else None

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── Tab 3: Stuck reports ──────────────────────────────────────────────────────

@router.get("/tab3")
async def get_tab3(
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=25, ge=1, le=100),
    country: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
    min_stuck_minutes: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Grey-flagged reports stuck longer than STUCK_REPORT_THRESHOLD_MINUTES."""
    now = datetime.now(timezone.utc)
    stuck_cutoff = now - timedelta(minutes=settings.STUCK_REPORT_THRESHOLD_MINUTES)

    conditions = [
        Report.flag_status == "grey",
        Report.created_at <= stuck_cutoff,
    ]

    if min_stuck_minutes:
        extra_cutoff = now - timedelta(minutes=min_stuck_minutes)
        conditions.append(Report.created_at <= extra_cutoff)

    if platform:
        conditions.append(Report.platform == platform)

    if search:
        search_stripped = search.lstrip("#").strip()
        # Try serial number first (e.g. user types "42" or "#42")
        if search_stripped.isdigit():
            conditions.append(Report.serial_number == int(search_stripped))
        else:
            try:
                search_uuid = uuid.UUID(search_stripped)
                conditions.append(
                    or_(Report.id == search_uuid, Report.reporter_id == search_uuid)
                )
            except ValueError:
                pass

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            conditions.append(Report.created_at < cursor_dt)
        except ValueError:
            pass

    # Country filter via reporter
    if country:
        country_sq = (
            select(Reporter.id)
            .where(Reporter.country_code == country)
            .scalar_subquery()
        )
        conditions.append(Report.reporter_id.in_(country_sq))

    # Country correlated subquery for display
    country_col = (
        select(Reporter.country_code)
        .where(Reporter.id == Report.reporter_id)
        .correlate(Report)
        .scalar_subquery()
    )
    display_id_col = (
        select(Reporter.display_id)
        .where(Reporter.id == Report.reporter_id)
        .correlate(Report)
        .scalar_subquery()
    )

    total_res = await db.execute(
        select(func.count(Report.id)).where(and_(*conditions))
    )
    total = total_res.scalar() or 0

    query = (
        select(Report, country_col.label("country"), display_id_col.label("reporter_display_id"))
        .where(and_(*conditions))
        .order_by(Report.created_at.asc())
        .limit(limit + 1)
    )
    result = await db.execute(query)
    rows = result.all()

    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]

    threshold_seconds = settings.STUCK_REPORT_THRESHOLD_MINUTES * 60

    items = []
    for report, country_code, reporter_display_id in rows:
        total_stuck = int((now - report.created_at).total_seconds())
        time_stuck_seconds = max(0, total_stuck - threshold_seconds)
        lock_data = await _get_lock_safe(redis, "stuck_report", str(report.id))

        items.append({
            "report_id": str(report.id),
            "serial_number": report.serial_number,
            "received_at": report.created_at.isoformat(),
            "country": country_code,
            "damage_level": report.damage_level,
            "platform": report.platform,
            "reporter_id": str(report.reporter_id) if report.reporter_id else None,
            "reporter_display_id": reporter_display_id,
            "time_stuck_seconds": time_stuck_seconds,
            "soft_lock": lock_data,
        })

    next_cursor = rows[-1][0].created_at.isoformat() if has_more and rows else None

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── Tab 4: Auto-blocked profiles ──────────────────────────────────────────────

@router.get("/tab4")
async def get_tab4(
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=25, ge=1, le=100),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Auto-blocked profiles awaiting 72-hour confirmation window."""
    now = datetime.now(timezone.utc)

    conditions = [Reporter.pending_auto_block_confirmation == True]

    if search:
        try:
            search_uuid = uuid.UUID(search)
            conditions.append(Reporter.id == search_uuid)
        except ValueError:
            conditions.append(Reporter.device_id_hash.ilike(f"%{search}%"))

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            conditions.append(Reporter.auto_block_expires_at > cursor_dt)
        except ValueError:
            pass

    total_res = await db.execute(
        select(func.count(Reporter.id)).where(and_(*conditions))
    )
    total = total_res.scalar() or 0

    result = await db.execute(
        select(Reporter)
        .where(and_(*conditions))
        .order_by(Reporter.auto_block_expires_at.asc().nulls_last())
        .limit(limit + 1)
    )
    reporters = list(result.scalars().all())

    has_more = len(reporters) > limit
    if has_more:
        reporters = reporters[:limit]

    items = []
    for reporter in reporters:
        time_remaining = 0
        if reporter.auto_block_expires_at:
            time_remaining = max(0, int((reporter.auto_block_expires_at - now).total_seconds()))

        # Show a truncated hash — actual device ID is encrypted
        device_id_display = reporter.device_id_hash[:16] if reporter.device_id_hash else None

        lock_data = await _get_lock_safe(redis, "auto_block", str(reporter.id))

        items.append({
            "reporter_id": str(reporter.id),
            "auto_blocked_at": reporter.auto_blocked_at.isoformat() if reporter.auto_blocked_at else None,
            "device_id": device_id_display,
            "matched_blocked_reporter_id": reporter.matched_blocked_reporter_id,
            "time_remaining_seconds": time_remaining,
            "soft_lock": lock_data,
        })

    next_cursor = (
        reporters[-1].auto_block_expires_at.isoformat()
        if has_more and reporters and reporters[-1].auto_block_expires_at
        else None
    )

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── Tab 1: Acquire soft lock on a report ──────────────────────────────────────

@router.post("/tab1/{report_id}/review")
async def acquire_report_lock(
    report_id: str,
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Acquire a soft lock on a report before reviewing it."""
    acquired = await acquire_soft_lock(
        redis,
        "report",
        report_id,
        current_user.full_name,
        str(current_user.id),
    )
    if not acquired:
        existing = await get_soft_lock(redis, "report", report_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "locked": False,
                "locked_by": existing.get("reviewer_name") if existing else "Another reviewer",
                "locked_at": existing.get("locked_at") if existing else None,
            },
        )
    lock_data = await get_soft_lock(redis, "report", report_id)
    return {"locked": True, "lock_data": lock_data}


# ── Tab 3: Force resolution ───────────────────────────────────────────────────

@router.post("/tab3/{report_id}/force-resolution")
async def force_resolution(
    report_id: str,
    body: ForceResolutionRequest,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Force a stuck Grey report to Green or Red."""
    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    if report.flag_status != "grey":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Force resolution only applies to Grey reports. Current status: {report.flag_status}",
        )

    # Soft lock check
    existing_lock = await _get_lock_safe(redis, "stuck_report", report_id)
    if existing_lock and existing_lock.get("reviewer_id") != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Item is currently being reviewed by another user",
                "locked_by": existing_lock.get("reviewer_name"),
                "locked_at": existing_lock.get("locked_at"),
            },
        )

    # Acquire lock for this action
    await acquire_soft_lock(
        redis, "stuck_report", report_id, current_user.full_name, str(current_user.id)
    )

    previous_flag = report.flag_status
    report.flag_status = body.target_status
    report.updated_at = datetime.now(timezone.utc)

    full_reason = f"Force resolution — processing failure: {body.reason}"

    flag_event = FlagEvent(
        report_id=report.id,
        dashboard_user_id=current_user.id,
        flag_from=previous_flag,
        flag_to=body.target_status,
        changed_by="manual",
        reason=full_reason,
        is_emergency_override=False,
    )
    db.add(flag_event)
    await db.commit()

    # Property creation + project linking for Green/Orange targets
    if body.target_status in ("green", "orange"):
        try:
            from app.services.property_service import (
                get_or_create_property,
                auto_confirm_property,
                update_conflict_warning,
            )
            from app.services.auto_flagging import _link_report_to_projects
            from app.database import AsyncSessionLocal
            async with AsyncSessionLocal() as prop_db:
                prop_report = await prop_db.get(Report, report.id)
                if prop_report:
                    prop = await get_or_create_property(prop_db, prop_report)
                    prop_report.property_id = prop.id
                    await prop_db.flush()
                    await auto_confirm_property(prop_db, prop.id)
                    await update_conflict_warning(prop_db, prop.id)
                    await _link_report_to_projects(prop_db, prop_report)
                    await prop_db.commit()
        except Exception:
            log.exception("force_resolution: property/project linking failed for report %s", report_id)

    # Release lock
    try:
        await release_soft_lock(redis, "stuck_report", report_id, str(current_user.id))
    except Exception:
        pass

    # Publish SSE
    try:
        from app.routers.dashboard_sse import publish_event
        await publish_event(
            crisis_id=str(report.crisis_id),
            event_type="flag_changed",
            data={
                "report_id": report_id,
                "flag_from": previous_flag,
                "flag_to": body.target_status,
            },
        )
    except Exception:
        pass

    return {
        "report_id": report_id,
        "flag_from": previous_flag,
        "flag_to": body.target_status,
        "reason": full_reason,
    }


# ── Tab 2: Dismiss property from review queue ─────────────────────────────────

@router.post("/tab2/{property_id}/dismiss")
async def dismiss_property(
    property_id: str,
    body: DismissRequest,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Dismiss a property from the review queue. Does NOT clear conflict warning."""
    result = await db.execute(select(Property).where(Property.id == property_id))
    prop = result.scalar_one_or_none()
    if not prop:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Property not found")

    # Only clear the manual flag, never the conflict warning
    prop.is_flagged_for_review = False
    prop.flagged_for_review_note = None
    prop.updated_at = datetime.now(timezone.utc)

    sys_text = (
        f"Dismissed from review queue by {current_user.full_name}. "
        f"Comment: {body.comment}"
    )
    db.add(PropertyComment(
        property_id=prop.id,
        dashboard_user_id=current_user.id,
        comment_text=sys_text,
        is_system_generated=True,
        system_event_type="dismissed_from_review_queue",
    ))
    await db.commit()

    try:
        await release_soft_lock(redis, "property", property_id, str(current_user.id))
    except Exception:
        pass

    return {
        "property_id": property_id,
        "is_flagged_for_review": False,
        "has_conflict_warning": prop.has_conflict_warning,
        "message": "Property dismissed from review queue",
    }


# ── Tab 4: Confirm auto-block ─────────────────────────────────────────────────

@router.post("/tab4/{reporter_id}/confirm")
async def confirm_auto_block(
    reporter_id: str,
    body: ConfirmBlockRequest,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Confirm a pending auto-block — reporter remains blocked permanently."""
    result = await db.execute(select(Reporter).where(Reporter.id == reporter_id))
    reporter = result.scalar_one_or_none()
    if not reporter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reporter not found")

    if not reporter.pending_auto_block_confirmation:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reporter is not pending auto-block confirmation",
        )

    # Soft lock check
    existing_lock = await _get_lock_safe(redis, "auto_block", reporter_id)
    if existing_lock and existing_lock.get("reviewer_id") != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Item is currently being reviewed by another user",
                "locked_by": existing_lock.get("reviewer_name"),
            },
        )

    now = datetime.now(timezone.utc)
    reporter.auto_block_confirmed = True
    reporter.auto_block_confirmed_at = now
    reporter.auto_block_confirmed_by = current_user.full_name
    reporter.pending_auto_block_confirmation = False
    reporter.block_reason = (
        f"Auto-block confirmed by {current_user.full_name}. Comment: {body.comment}"
    )
    reporter.updated_at = now
    try:
        from app.services.reporter_activity_service import write_activity_log
        await write_activity_log(
            db,
            reporter_id=reporter.id,
            action="auto_block_confirmed",
            source=current_user.full_name,
            previous_value="blocked",
            new_value="blocked",
            dashboard_user_id=str(current_user.id),
            comment=body.comment,
        )
    except Exception:
        log.exception("confirm_auto_block: activity log write failed for %s", reporter_id)
    await db.commit()

    try:
        await release_soft_lock(redis, "auto_block", reporter_id, str(current_user.id))
    except Exception:
        pass

    log.info(
        "confirm_auto_block: reporter %s auto-block confirmed by %s",
        reporter_id, current_user.full_name,
    )
    return {
        "reporter_id": reporter_id,
        "auto_block_confirmed": True,
        "auto_block_confirmed_by": current_user.full_name,
        "message": "Auto-block confirmed",
    }


# ── Tab 4: Reverse auto-block ─────────────────────────────────────────────────

@router.post("/tab4/{reporter_id}/reverse")
async def reverse_auto_block(
    reporter_id: str,
    body: ConfirmBlockRequest,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Reverse a pending auto-block — reporter is unblocked. Reports discarded during the
    block period are NOT automatically reinstated."""
    result = await db.execute(select(Reporter).where(Reporter.id == reporter_id))
    reporter = result.scalar_one_or_none()
    if not reporter:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reporter not found")

    if not reporter.pending_auto_block_confirmation:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reporter is not pending auto-block confirmation",
        )

    # Soft lock check
    existing_lock = await _get_lock_safe(redis, "auto_block", reporter_id)
    if existing_lock and existing_lock.get("reviewer_id") != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Item is currently being reviewed by another user",
                "locked_by": existing_lock.get("reviewer_name"),
            },
        )

    now = datetime.now(timezone.utc)
    reporter.is_blocked = False
    reporter.profile_status = "active"
    reporter.auto_block_confirmed = False
    reporter.pending_auto_block_confirmation = False
    reporter.block_reason = None
    reporter.blocked_at = None
    reporter.updated_at = now
    try:
        from app.services.reporter_activity_service import write_activity_log
        await write_activity_log(
            db,
            reporter_id=reporter.id,
            action="auto_block_reversed",
            source=current_user.full_name,
            previous_value="blocked",
            new_value="active",
            dashboard_user_id=str(current_user.id),
            comment=body.comment,
        )
    except Exception:
        log.exception("reverse_auto_block: activity log write failed for %s", reporter_id)

    await db.commit()

    try:
        await release_soft_lock(redis, "auto_block", reporter_id, str(current_user.id))
    except Exception:
        pass

    log.info(
        "reverse_auto_block: reporter %s auto-block reversed by %s. Comment: %s",
        reporter_id, current_user.full_name, body.comment,
    )
    return {
        "reporter_id": reporter_id,
        "is_blocked": False,
        "message": "Auto-block reversed. Reports discarded during block period are not reinstated.",
    }


# ── Tab 1: Submit review decision ────────────────────────────────────────────

@router.post("/tab1/{report_id}/submit")
async def submit_review_decision(
    report_id: str,
    body: ReviewDecisionRequest,
    db: AsyncSession = Depends(get_db),
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(require_section_access("review_queue", require_edit=True)),
):
    """Submit a review decision on a Red-flagged report.

    approve → Red becomes Orange (passed with notes).
    discard → Red becomes Discarded.
    Requires the current user to hold the soft lock on the report.
    """
    result = await db.execute(select(Report).where(Report.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    if report.flag_status != "red":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Submit only applies to Red reports. Current status: {report.flag_status}",
        )

    # Require current user to hold the soft lock
    existing_lock = await _get_lock_safe(redis, "report", report_id)
    if not existing_lock or existing_lock.get("reviewer_id") != str(current_user.id):
        locked_by = existing_lock.get("reviewer_name") if existing_lock else None
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "You do not hold the review lock on this report. Re-open from the review queue.",
                "locked_by": locked_by,
            },
        )

    target_status = "orange" if body.decision == "approve" else "discarded"
    previous_flag = report.flag_status
    now = datetime.now(timezone.utc)

    report.flag_status = target_status
    report.updated_at = now

    flag_event = FlagEvent(
        report_id=report.id,
        dashboard_user_id=current_user.id,
        flag_from=previous_flag,
        flag_to=target_status,
        changed_by="manual",
        reason=f"Review queue decision: {body.decision}",
        is_emergency_override=False,
    )
    flag_event.flag_metadata = {
        "decision": body.decision,
        "flag_assessments": body.flag_assessments,
        "reviewer_comment": body.comment,
    }
    db.add(flag_event)
    await db.commit()

    # Release lock
    try:
        await release_soft_lock(redis, "report", report_id, str(current_user.id))
    except Exception:
        pass

    # Property creation + project linking for approved (Orange) reports
    if target_status == "orange":
        try:
            from app.services.property_service import (
                get_or_create_property,
                auto_confirm_property,
                update_conflict_warning,
            )
            from app.services.auto_flagging import _link_report_to_projects
            from app.database import AsyncSessionLocal
            async with AsyncSessionLocal() as prop_db:
                prop_report = await prop_db.get(Report, report.id)
                if prop_report:
                    prop = await get_or_create_property(prop_db, prop_report)
                    prop_report.property_id = prop.id
                    await prop_db.flush()
                    await auto_confirm_property(prop_db, prop.id)
                    await update_conflict_warning(prop_db, prop.id)
                    await _link_report_to_projects(prop_db, prop_report)
                    await prop_db.commit()
        except Exception:
            log.exception("submit_review_decision: property/project linking failed for %s", report_id)

    # Publish SSE events
    try:
        from app.routers.dashboard_sse import publish_event
        await publish_event(
            crisis_id=str(report.crisis_id),
            event_type="flag_changed",
            data={
                "report_id": report_id,
                "flag_from": previous_flag,
                "flag_to": target_status,
            },
        )
        await publish_event(
            crisis_id=str(report.crisis_id),
            event_type="review_queue_updated",
            data={"report_id": report_id},
        )
    except Exception:
        pass

    log.info(
        "submit_review_decision: report %s → %s by %s",
        report_id, target_status, current_user.full_name,
    )

    return {
        "report_id": report_id,
        "flag_from": previous_flag,
        "flag_to": target_status,
        "decision": body.decision,
    }


# ── Release lock ──────────────────────────────────────────────────────────────

@router.post("/release-lock")
async def release_lock(
    body: ReleaseLockRequest,
    redis=Depends(get_redis),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Release the soft lock held by the current reviewer on any item."""
    try:
        await release_soft_lock(redis, body.item_type, body.item_id, str(current_user.id))
    except Exception:
        pass
    return {"released": True}
