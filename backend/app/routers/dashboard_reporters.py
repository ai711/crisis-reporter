from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, distinct, cast, String as SAString

from app.database import get_db
from app.models.reporter import Reporter
from app.models.report import Report
from app.models.reporter_activity_log import ReporterActivityLog
from app.models.dashboard_user import DashboardUser
from app.models.safety_progress import SafetyProgress
from app.services.dependencies import get_current_dashboard_user
from app.services.reporter_activity_service import write_activity_log

router = APIRouter(prefix="/api/dashboard/reporters", tags=["Dashboard Reporters"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compute_profile_type(reporter: Reporter) -> str:
    if reporter.is_verified or reporter.name_encrypted or reporter.email_encrypted:
        return "named_profile"
    if (reporter.report_count or 0) > 0:
        return "anonymous_with_reports"
    return "anonymous_no_reports"


def _platform_label(platform: str) -> str:
    mapping = {
        "android": "Native App Android",
        "ios": "Native App iOS",
        "pwa": "PWA",
        "web": "Plain Web",
    }
    return mapping.get(platform, platform)


# ── Request schemas ───────────────────────────────────────────────────────────

class StatusChangeRequest(BaseModel):
    profile_status: str
    comment: str

    @field_validator("profile_status")
    @classmethod
    def valid_status(cls, v: str) -> str:
        if v not in ("active", "flagged", "blocked"):
            raise ValueError("profile_status must be 'active', 'flagged', or 'blocked'")
        return v

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 10:
            raise ValueError("Comment must be at least 10 characters")
        return v.strip()


class RemovePauseRequest(BaseModel):
    comment: str

    @field_validator("comment")
    @classmethod
    def comment_min_length(cls, v: str) -> str:
        if len(v.strip()) < 10:
            raise ValueError("Comment must be at least 10 characters")
        return v.strip()


# ── GET /api/dashboard/reporters ─────────────────────────────────────────────

@router.get("")
async def list_reporters(
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=100, ge=1, le=500),
    profile_type: Optional[str] = Query(None),
    profile_status: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    report_count_min: Optional[int] = Query(None, ge=0),
    report_count_max: Optional[int] = Query(None, ge=0),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    conditions = []

    # Multi-value filters (comma-separated)
    if profile_type:
        vals = [v.strip() for v in profile_type.split(",") if v.strip()]
        if vals:
            conditions.append(Reporter.profile_type.in_(vals))

    if profile_status:
        vals = [v.strip() for v in profile_status.split(",") if v.strip()]
        if vals:
            conditions.append(Reporter.profile_status.in_(vals))

    if platform:
        vals = [v.strip() for v in platform.split(",") if v.strip()]
        if vals:
            conditions.append(Reporter.platform.in_(vals))

    if country:
        vals = [v.strip().upper() for v in country.split(",") if v.strip()]
        if vals:
            conditions.append(Reporter.country_code.in_(vals))

    if date_from:
        try:
            conditions.append(
                Reporter.created_at >= datetime.fromisoformat(date_from.replace("Z", "+00:00"))
            )
        except ValueError:
            pass

    if date_to:
        try:
            conditions.append(
                Reporter.created_at <= datetime.fromisoformat(date_to.replace("Z", "+00:00"))
            )
        except ValueError:
            pass

    if report_count_min is not None:
        conditions.append(Reporter.report_count >= report_count_min)

    if report_count_max is not None:
        conditions.append(Reporter.report_count <= report_count_max)

    if search:
        term = f"%{search}%"
        conditions.append(
            or_(
                cast(Reporter.display_id, SAString).ilike(term),
                Reporter.ip_address.ilike(term),
                Reporter.platform.ilike(term),
            )
        )

    # Cursor pagination (anchor on created_at DESC, then id)
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.rsplit("_", 1)
            cursor_datetime = datetime.fromisoformat(cursor_ts)
            conditions.append(Reporter.created_at < cursor_datetime)
        except Exception:
            pass

    where_clause = and_(*conditions) if conditions else True

    query = (
        select(Reporter)
        .where(where_clause)
        .order_by(Reporter.created_at.desc(), Reporter.id.desc())
        .limit(limit + 1)
    )

    result = await db.execute(query)
    reporters = list(result.scalars().all())

    has_more = len(reporters) > limit
    if has_more:
        reporters = reporters[:limit]

    # Total count
    count_result = await db.execute(
        select(func.count(Reporter.id)).where(where_clause)
    )
    total = count_result.scalar() or 0

    next_cursor = None
    if has_more and reporters:
        last = reporters[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    items = [
        {
            "reporter_id": r.display_id,
            "uuid": str(r.id),
            "profile_type": _compute_profile_type(r),
            "created_at": r.created_at.isoformat(),
            "country": r.country_code,
            "ip_address": r.ip_address,
            "platform": r.platform,
            "platform_label": _platform_label(r.platform),
            "app_version": r.app_version,
            "browser_version": r.browser_version,
            "total_reports": r.report_count,
            "profile_status": r.profile_status,
            "last_active_at": r.last_active_at.isoformat() if r.last_active_at else None,
        }
        for r in reporters
    ]

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── GET /api/dashboard/reporters/{reporter_id} ────────────────────────────────

@router.get("/{reporter_id}")
async def get_reporter_detail(
    reporter_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get full reporter profile. reporter_id is the integer display_id."""
    reporter = await _find_reporter(db, reporter_id)

    # Decrypt email if available
    email = None
    if reporter.email_encrypted:
        try:
            from app.services.encryption import decrypt_field
            email = decrypt_field(reporter.email_encrypted)
        except Exception:
            pass

    # Decrypt name if available
    name = None
    if reporter.name_encrypted:
        try:
            from app.services.encryption import decrypt_field
            name = decrypt_field(reporter.name_encrypted)
        except Exception:
            pass

    # Report statistics
    stats_result = await db.execute(
        select(Report.flag_status, func.count(Report.id))
        .where(Report.reporter_id == reporter.id)
        .group_by(Report.flag_status)
    )
    flag_counts: dict[str, int] = {row[0]: row[1] for row in stats_result.all()}

    total_reports = sum(flag_counts.values())
    green_orange = flag_counts.get("green", 0) + flag_counts.get("orange", 0)
    red_reports = flag_counts.get("red", 0)
    discarded_reports = flag_counts.get("discarded", 0)

    # Unique properties
    unique_props_result = await db.execute(
        select(func.count(distinct(Report.property_id))).where(
            and_(
                Report.reporter_id == reporter.id,
                Report.property_id.isnot(None),
            )
        )
    )
    total_unique_properties = unique_props_result.scalar() or 0

    # First / last report dates
    date_result = await db.execute(
        select(func.min(Report.created_at), func.max(Report.created_at)).where(
            Report.reporter_id == reporter.id
        )
    )
    first_report_at, last_report_at = date_result.one()

    # Safety Tips progress — separate table, one row per completed part ("A", "B", "C")
    sp_result = await db.execute(
        select(SafetyProgress).where(SafetyProgress.reporter_id == reporter.id)
    )
    sp_records = list(sp_result.scalars().all())
    parts_done = {r.part_completed for r in sp_records}

    profile_type = _compute_profile_type(reporter)

    return {
        "reporter_id": reporter.display_id,
        "uuid": str(reporter.id),
        "profile_type": profile_type,
        "profile_status": reporter.profile_status,
        "platform": reporter.platform,
        "platform_label": _platform_label(reporter.platform),
        "country": reporter.country_code,
        "language_code": reporter.language_code,
        "ip_address": reporter.ip_address,
        "app_version": reporter.app_version,
        "browser_version": reporter.browser_version,
        "mcc": reporter.mcc,
        "is_verified": reporter.is_verified,
        "is_blocked": reporter.is_blocked,
        "is_paused": reporter.is_paused,
        "pause_expires_at": reporter.pause_expires_at.isoformat() if reporter.pause_expires_at else None,
        "pause_reason": reporter.pause_reason,
        "created_at": reporter.created_at.isoformat(),
        "last_active_at": reporter.last_active_at.isoformat() if reporter.last_active_at else None,
        "email": email,
        "name": name,
        "block_reason": reporter.block_reason,
        "blocked_at": reporter.blocked_at.isoformat() if reporter.blocked_at else None,
        "total_reports": total_reports,
        "green_orange_reports": green_orange,
        "red_reports": red_reports,
        "discarded_reports": discarded_reports,
        "total_unique_properties": total_unique_properties,
        "first_report_at": first_report_at.isoformat() if first_report_at else None,
        "last_report_at": last_report_at.isoformat() if last_report_at else None,
        "safety_progress": {
            "part_a_complete": "A" in parts_done,
            "part_b_complete": "B" in parts_done,
            "part_c_complete": "C" in parts_done,
            "part_a_count": sum(1 for r in sp_records if r.part_completed == "A"),
        },
    }


# ── PATCH /api/dashboard/reporters/{reporter_id}/status ──────────────────────

@router.patch("/{reporter_id}/status")
async def change_reporter_status(
    reporter_id: str,
    body: StatusChangeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)

    previous_status = reporter.profile_status
    reporter.profile_status = body.profile_status

    # Keep is_blocked in sync for legacy queries
    if body.profile_status == "blocked":
        reporter.is_blocked = True
        reporter.block_reason = body.comment
        reporter.blocked_at = datetime.now(timezone.utc)
    elif body.profile_status == "active":
        reporter.is_blocked = False
        reporter.block_reason = None
        reporter.blocked_at = None

    await write_activity_log(
        db,
        reporter_id=reporter.id,
        action="status_changed",
        source=current_user.full_name,
        previous_value=previous_status,
        new_value=body.profile_status,
        dashboard_user_id=str(current_user.id),
        comment=body.comment,
    )

    await db.commit()
    await db.refresh(reporter)

    return {
        "reporter_id": reporter.display_id,
        "profile_status": reporter.profile_status,
        "is_blocked": reporter.is_blocked,
        "message": f"Status updated to {body.profile_status}",
    }


# ── POST /api/dashboard/reporters/{reporter_id}/remove-pause ─────────────────

@router.post("/{reporter_id}/remove-pause")
async def remove_reporter_pause(
    reporter_id: str,
    body: RemovePauseRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)

    if not reporter.is_paused:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reporter does not have an active submission pause",
        )

    reporter.is_paused = False
    reporter.pause_expires_at = None
    reporter.pause_reason = None

    await write_activity_log(
        db,
        reporter_id=reporter.id,
        action="pause_removed",
        source=current_user.full_name,
        dashboard_user_id=str(current_user.id),
        comment=body.comment,
    )

    await db.commit()

    return {
        "reporter_id": reporter.display_id,
        "is_paused": False,
        "message": "Submission pause removed",
    }


# ── GET /api/dashboard/reporters/{reporter_id}/reports ───────────────────────

@router.get("/{reporter_id}/reports")
async def get_reporter_reports(
    reporter_id: str,
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=50, ge=1, le=100),
    flag_status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)

    conditions = [Report.reporter_id == reporter.id]

    if flag_status:
        vals = [v.strip() for v in flag_status.split(",") if v.strip()]
        if vals:
            conditions.append(Report.flag_status.in_(vals))

    if cursor:
        try:
            cursor_ts, cursor_id = cursor.rsplit("_", 1)
            cursor_datetime = datetime.fromisoformat(cursor_ts)
            conditions.append(Report.created_at < cursor_datetime)
        except Exception:
            pass

    where_clause = and_(*conditions)

    result = await db.execute(
        select(Report)
        .where(where_clause)
        .order_by(Report.created_at.desc())
        .limit(limit + 1)
    )
    reports = list(result.scalars().all())

    has_more = len(reports) > limit
    if has_more:
        reports = reports[:limit]

    count_result = await db.execute(
        select(func.count(Report.id)).where(where_clause)
    )
    total = count_result.scalar() or 0

    next_cursor = None
    if has_more and reports:
        last = reports[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    items = [
        {
            "id": str(r.id),                        # frontend uses r.id
            "serial_number": r.serial_number,
            "created_at": r.created_at.isoformat(),
            "country": reporter.country_code,
            "damage_level": r.damage_level,
            "infrastructure_type": r.infrastructure_type,
            "infrastructure_types": r.infrastructure_types or (
                [r.infrastructure_type] if r.infrastructure_type else []
            ),
            "disaster_type": r.disaster_type,       # frontend uses r.disaster_type
            "flag_status": r.flag_status,
        }
        for r in reports
    ]

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── GET /api/dashboard/reporters/{reporter_id}/activity-log ──────────────────

@router.get("/{reporter_id}/activity-log")
async def get_reporter_activity_log(
    reporter_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)

    offset = (page - 1) * page_size

    count_result = await db.execute(
        select(func.count(ReporterActivityLog.id)).where(
            ReporterActivityLog.reporter_id == reporter.id
        )
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(ReporterActivityLog)
        .where(ReporterActivityLog.reporter_id == reporter.id)
        .order_by(ReporterActivityLog.created_at.asc())
        .offset(offset)
        .limit(page_size)
    )
    entries = list(result.scalars().all())

    items = [
        {
            "id": e.id,
            "action": e.action,
            "previous_value": e.previous_value,
            "new_value": e.new_value,
            "source": e.source,
            "comment": e.comment,
            "matched_reporter_id": e.matched_reporter_id,
            "created_at": e.created_at.isoformat(),
        }
        for e in entries
    ]

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (total + page_size - 1) // page_size),
    }


# ── GET /api/dashboard/reporters/{reporter_id}/badges ────────────────────────

@router.get("/{reporter_id}/badges")
async def get_reporter_badges(
    reporter_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)

    has_contact = bool(reporter.email_encrypted or reporter.name_encrypted)

    badges = [
        {"badge_name": "Safety Training Complete", "earned_at": None},
        {"badge_name": "First Report Submitted", "earned_at": None},
        {"badge_name": "Verified Reporter", "earned_at": None},
    ]

    return {
        "badges_eligible": has_contact,
        "badges_eligible_note": (
            None if has_contact
            else "Badges are awarded to reporters with a verified contact detail on their profile."
        ),
        "badges": badges,
    }


# ── Legacy block/unblock endpoints (kept for backwards compat) ────────────────

@router.post("/{reporter_id}/block")
async def block_reporter(
    reporter_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)
    reason = body.get("reason", "Blocked by dashboard admin")

    previous_status = reporter.profile_status
    reporter.is_blocked = True
    reporter.profile_status = "blocked"
    reporter.block_reason = reason
    reporter.blocked_at = datetime.now(timezone.utc)

    await write_activity_log(
        db,
        reporter_id=reporter.id,
        action="status_changed",
        source=current_user.full_name,
        previous_value=previous_status,
        new_value="blocked",
        dashboard_user_id=str(current_user.id),
        comment=reason,
    )

    await db.commit()
    return {"reporter_id": reporter_id, "is_blocked": True, "message": "Reporter blocked successfully"}


@router.post("/{reporter_id}/unblock")
async def unblock_reporter(
    reporter_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    reporter = await _find_reporter(db, reporter_id)
    reason = body.get("reason", "Unblocked by dashboard admin")

    previous_status = reporter.profile_status
    reporter.is_blocked = False
    reporter.profile_status = "active"
    reporter.block_reason = None
    reporter.blocked_at = None

    await write_activity_log(
        db,
        reporter_id=reporter.id,
        action="status_changed",
        source=current_user.full_name,
        previous_value=previous_status,
        new_value="active",
        dashboard_user_id=str(current_user.id),
        comment=reason,
    )

    await db.commit()
    return {"reporter_id": reporter_id, "is_blocked": False, "message": "Reporter unblocked successfully"}


# ── Internal helper ───────────────────────────────────────────────────────────

async def _find_reporter(db: AsyncSession, reporter_id: str) -> Reporter:
    """Find a reporter by display_id (integer) or UUID string."""
    reporter = None

    # Try integer display_id first
    try:
        display_id_int = int(reporter_id)
        result = await db.execute(
            select(Reporter).where(Reporter.display_id == display_id_int)
        )
        reporter = result.scalar_one_or_none()
    except (ValueError, TypeError):
        pass

    # Fall back to UUID
    if reporter is None:
        try:
            result = await db.execute(
                select(Reporter).where(Reporter.id == reporter_id)
            )
            reporter = result.scalar_one_or_none()
        except Exception:
            pass

    if not reporter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reporter not found",
        )

    return reporter
