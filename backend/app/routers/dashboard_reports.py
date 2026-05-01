import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.report import Report
from app.models.photo import Photo
from app.models.flag_event import FlagEvent
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user
from app.services.storage import storage_service

router = APIRouter(prefix="/api/dashboard/reports", tags=["Dashboard Reports"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class PhotoSummary(BaseModel):
    id: str
    url: str
    display_order: int
    was_compressed: bool


class FlagEventSummary(BaseModel):
    id: str
    flag_from: Optional[str]
    flag_to: str
    changed_by: str
    reason: Optional[str]
    created_at: datetime


class ReportDetail(BaseModel):
    id: str
    crisis_id: str
    reporter_id: Optional[str]
    building_id: Optional[str]
    building_name: Optional[str]
    damage_level: str
    infrastructure_type: str
    description: Optional[str]
    description_translated: Optional[str]
    flag_status: str
    platform: str
    language_code: str
    gps_latitude: Optional[float]
    gps_longitude: Optional[float]
    gps_available: bool
    location_address: Optional[str]
    location_landmark: Optional[str]
    was_queued: bool
    mcc: Optional[str]
    carrier_name: Optional[str]
    submitted_at: datetime
    created_at: datetime
    photos: list[PhotoSummary]
    flag_events: list[FlagEventSummary]


class ReportListItem(BaseModel):
    id: str
    crisis_id: str
    reporter_id: Optional[str]
    building_id: Optional[str]
    damage_level: str
    infrastructure_type: str
    flag_status: str
    platform: str
    gps_latitude: Optional[float]
    gps_longitude: Optional[float]
    submitted_at: datetime
    created_at: datetime
    photo_count: int


class ReportListResponse(BaseModel):
    items: list[ReportListItem]
    total: int
    cursor: Optional[str]
    has_more: bool


class FlagUpdateRequest(BaseModel):
    flag_status: str  # grey, green, orange, red
    reason: Optional[str] = None


class TranslateRequest(BaseModel):
    target_language: str = "en"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=ReportListResponse)
async def list_reports(
    crisis_id: Optional[str] = Query(None),
    flag_status: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
    damage_level: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=50, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """List reports with filtering and cursor-based pagination.
    Cursor-based pagination only — never offset pagination."""

    # Build base query
    conditions = []

    if crisis_id:
        conditions.append(Report.crisis_id == crisis_id)
    if flag_status:
        conditions.append(Report.flag_status == flag_status)
    if platform:
        conditions.append(Report.platform == platform)
    if damage_level:
        conditions.append(Report.damage_level == damage_level)

    # Cursor pagination — anchor on created_at + id
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.split("_")
            cursor_datetime = datetime.fromisoformat(cursor_ts)
            conditions.append(
                Report.created_at < cursor_datetime
            )
        except Exception:
            pass

    query = (
        select(Report)
        .where(and_(*conditions) if conditions else True)
        .order_by(Report.created_at.desc())
        .limit(limit + 1)
    )

    result = await db.execute(query)
    reports = result.scalars().all()

    has_more = len(reports) > limit
    if has_more:
        reports = reports[:limit]

    # Get photo counts
    items = []
    for report in reports:
        photo_result = await db.execute(
            select(func.count(Photo.id)).where(Photo.report_id == report.id)
        )
        photo_count = photo_result.scalar() or 0

        items.append(ReportListItem(
            id=str(report.id),
            crisis_id=str(report.crisis_id),
            reporter_id=str(report.reporter_id) if report.reporter_id else None,
            building_id=report.building_id,
            damage_level=report.damage_level,
            infrastructure_type=report.infrastructure_type,
            flag_status=report.flag_status,
            platform=report.platform,
            gps_latitude=report.gps_latitude,
            gps_longitude=report.gps_longitude,
            submitted_at=report.submitted_at,
            created_at=report.created_at,
            photo_count=photo_count,
        ))

    # Build next cursor
    next_cursor = None
    if has_more and reports:
        last = reports[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    # Get total count
    count_query = select(func.count(Report.id)).where(
        and_(*conditions) if conditions else True
    )
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    return ReportListResponse(
        items=items,
        total=total,
        cursor=next_cursor,
        has_more=has_more,
    )


@router.get("/{report_id}", response_model=ReportDetail)
async def get_report_detail(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Get full report detail including photos and flag history."""

    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    # Get photos
    photo_result = await db.execute(
        select(Photo)
        .where(Photo.report_id == report_id)
        .order_by(Photo.display_order)
    )
    photos = photo_result.scalars().all()

    # Get flag events
    flag_result = await db.execute(
        select(FlagEvent)
        .where(FlagEvent.report_id == report_id)
        .order_by(FlagEvent.created_at)
    )
    flag_events = flag_result.scalars().all()

    return ReportDetail(
        id=str(report.id),
        crisis_id=str(report.crisis_id),
        reporter_id=str(report.reporter_id) if report.reporter_id else None,
        building_id=report.building_id,
        building_name=report.building_name,
        damage_level=report.damage_level,
        infrastructure_type=report.infrastructure_type,
        description=report.description,
        description_translated=report.description_translated,
        flag_status=report.flag_status,
        platform=report.platform,
        language_code=report.language_code,
        gps_latitude=report.gps_latitude,
        gps_longitude=report.gps_longitude,
        gps_available=report.gps_available,
        location_address=report.location_address,
        location_landmark=report.location_landmark,
        was_queued=report.was_queued,
        mcc=report.mcc,
        carrier_name=report.carrier_name,
        submitted_at=report.submitted_at,
        created_at=report.created_at,
        photos=[
            PhotoSummary(
                id=str(p.id),
                url=storage_service.get_url(p.storage_path),
                display_order=p.display_order,
                was_compressed=p.was_compressed,
            )
            for p in photos
        ],
        flag_events=[
            FlagEventSummary(
                id=str(f.id),
                flag_from=f.flag_from,
                flag_to=f.flag_to,
                changed_by=f.changed_by,
                reason=f.reason,
                created_at=f.created_at,
            )
            for f in flag_events
        ],
    )


@router.patch("/{report_id}/flag", response_model=dict)
async def update_report_flag(
    report_id: str,
    request: FlagUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Manually update a report flag status. Logged as a flag event."""

    if request.flag_status not in ["grey", "green", "orange", "red"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="flag_status must be grey, green, orange, or red",
        )

    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    previous_flag = report.flag_status
    report.flag_status = request.flag_status
    report.updated_at = datetime.now(timezone.utc)

    # Log flag event
    flag_event = FlagEvent(
        report_id=report.id,
        dashboard_user_id=current_user.id,
        flag_from=previous_flag,
        flag_to=request.flag_status,
        changed_by="manual",
        reason=request.reason,
    )
    db.add(flag_event)
    await db.commit()

    return {
        "report_id": report_id,
        "flag_from": previous_flag,
        "flag_to": request.flag_status,
        "message": "Flag updated successfully",
    }


@router.post("/{report_id}/translate", response_model=dict)
async def translate_report_description(
    report_id: str,
    request: TranslateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """On-demand translation of report description via LibreTranslate.
    Only called when dashboard user clicks Translate button."""

    import httpx

    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    if not report.description:
        return {"translated": None, "message": "No description to translate"}

    # Call LibreTranslate
    try:
        from app.config import settings
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                f"{settings.LIBRETRANSLATE_URL}/translate",
                json={
                    "q": report.description,
                    "source": "auto",
                    "target": request.target_language,
                    "format": "text",
                },
            )
            response.raise_for_status()
            data = response.json()
            translated_text = data.get("translatedText", "")

        # Save translation to database
        report.description_translated = translated_text
        await db.commit()

        return {
            "original": report.description,
            "translated": translated_text,
            "target_language": request.target_language,
        }

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Translation service unavailable. Please try again.",
        )