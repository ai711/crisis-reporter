from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.reporter import Reporter
from app.models.report import Report
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user
from app.services.encryption import decrypt_field

router = APIRouter(prefix="/api/dashboard/reporters", tags=["Dashboard Reporters"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ReporterListItem(BaseModel):
    id: str
    platform: str
    country_code: Optional[str]
    language_code: str
    is_verified: bool
    is_blocked: bool
    report_count: int
    last_active_at: Optional[datetime]
    created_at: datetime


class ReporterDetail(BaseModel):
    id: str
    platform: str
    country_code: Optional[str]
    language_code: str
    is_verified: bool
    is_blocked: bool
    block_reason: Optional[str]
    blocked_at: Optional[datetime]
    report_count: int
    last_active_at: Optional[datetime]
    created_at: datetime
    # Decrypted sensitive fields — only shown to dashboard users
    email: Optional[str] = None


class ReporterListResponse(BaseModel):
    items: list[ReporterListItem]
    total: int
    cursor: Optional[str]
    has_more: bool


class BlockReporterRequest(BaseModel):
    reason: str


class UnblockReporterRequest(BaseModel):
    reason: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=ReporterListResponse)
async def list_reporters(
    platform: Optional[str] = Query(None),
    country_code: Optional[str] = Query(None),
    is_blocked: Optional[bool] = Query(None),
    is_verified: Optional[bool] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=50, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """List reporters with filtering and cursor-based pagination."""

    conditions = []

    if platform:
        conditions.append(Reporter.platform == platform)
    if country_code:
        conditions.append(Reporter.country_code == country_code.upper())
    if is_blocked is not None:
        conditions.append(Reporter.is_blocked == is_blocked)
    if is_verified is not None:
        conditions.append(Reporter.is_verified == is_verified)

    # Cursor pagination
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.split("_")
            cursor_datetime = datetime.fromisoformat(cursor_ts)
            conditions.append(Reporter.created_at < cursor_datetime)
        except Exception:
            pass

    query = (
        select(Reporter)
        .where(and_(*conditions) if conditions else True)
        .order_by(Reporter.created_at.desc())
        .limit(limit + 1)
    )

    result = await db.execute(query)
    reporters = result.scalars().all()

    has_more = len(reporters) > limit
    if has_more:
        reporters = reporters[:limit]

    items = [
        ReporterListItem(
            id=str(r.id),
            platform=r.platform,
            country_code=r.country_code,
            language_code=r.language_code,
            is_verified=r.is_verified,
            is_blocked=r.is_blocked,
            report_count=r.report_count,
            last_active_at=r.last_active_at,
            created_at=r.created_at,
        )
        for r in reporters
    ]

    next_cursor = None
    if has_more and reporters:
        last = reporters[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    count_query = select(func.count(Reporter.id)).where(
        and_(*conditions) if conditions else True
    )
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    return ReporterListResponse(
        items=items,
        total=total,
        cursor=next_cursor,
        has_more=has_more,
    )


@router.get("/{reporter_id}", response_model=ReporterDetail)
async def get_reporter_detail(
    reporter_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get full reporter detail. Decrypts email for display."""

    result = await db.execute(
        select(Reporter).where(Reporter.id == reporter_id)
    )
    reporter = result.scalar_one_or_none()
    if not reporter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reporter not found",
        )

    # Decrypt email if present
    email = None
    if reporter.email_encrypted:
        try:
            email = decrypt_field(reporter.email_encrypted)
        except Exception:
            email = None

    return ReporterDetail(
        id=str(reporter.id),
        platform=reporter.platform,
        country_code=reporter.country_code,
        language_code=reporter.language_code,
        is_verified=reporter.is_verified,
        is_blocked=reporter.is_blocked,
        block_reason=reporter.block_reason,
        blocked_at=reporter.blocked_at,
        report_count=reporter.report_count,
        last_active_at=reporter.last_active_at,
        created_at=reporter.created_at,
        email=email,
    )


@router.post("/{reporter_id}/block", response_model=dict)
async def block_reporter(
    reporter_id: str,
    request: BlockReporterRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Block a reporter. All future reports from this reporter
    will be auto-flagged Red."""

    result = await db.execute(
        select(Reporter).where(Reporter.id == reporter_id)
    )
    reporter = result.scalar_one_or_none()
    if not reporter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reporter not found",
        )

    reporter.is_blocked = True
    reporter.block_reason = request.reason
    reporter.blocked_at = datetime.now(timezone.utc)
    await db.commit()

    return {
        "reporter_id": reporter_id,
        "is_blocked": True,
        "message": "Reporter blocked successfully",
    }


@router.post("/{reporter_id}/unblock", response_model=dict)
async def unblock_reporter(
    reporter_id: str,
    request: UnblockReporterRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Unblock a reporter."""

    result = await db.execute(
        select(Reporter).where(Reporter.id == reporter_id)
    )
    reporter = result.scalar_one_or_none()
    if not reporter:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reporter not found",
        )

    reporter.is_blocked = False
    reporter.block_reason = None
    reporter.blocked_at = None
    await db.commit()

    return {
        "reporter_id": reporter_id,
        "is_blocked": False,
        "message": "Reporter unblocked successfully",
    }