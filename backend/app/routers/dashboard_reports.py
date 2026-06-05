import uuid
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from sqlalchemy.orm import joinedload
from pydantic import BaseModel, validator
from typing import Optional

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.photo import Photo
from app.models.flag_event import FlagEvent
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user, require_superadmin, require_section_access
from app.services.storage import storage_service, LocalFileSystemStorage
from app.config import settings

router = APIRouter(prefix="/api/dashboard/reports", tags=["Dashboard Reports"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class PhotoSummary(BaseModel):
    id: str
    url: str
    display_order: int
    was_compressed: bool
    created_at: datetime
    exif_timestamp: Optional[datetime] = None


class FlagEventSummary(BaseModel):
    id: str
    flag_from: Optional[str]
    flag_to: str
    changed_by: str
    reason: Optional[str]
    metadata: Optional[dict]
    dashboard_user_id: Optional[str]
    dashboard_user_name: Optional[str] = None
    is_emergency_override: bool = False
    created_at: datetime


class ProjectRef(BaseModel):
    id: str
    serial_id: str
    name: str


class VersionHistoryItem(BaseModel):
    id: str
    serial_number: Optional[int] = None
    submitted_at: datetime
    damage_level: str
    flag_status: str
    infrastructure_type: str


class ReportDetail(BaseModel):
    id: str
    serial_number: Optional[int] = None
    crisis_id: str
    reporter_id: Optional[str]
    reporter_display_id: Optional[int]
    reporter_platform: Optional[str]
    reporter_country_code: Optional[str]
    reporter_is_verified: Optional[bool]
    reporter_is_blocked: Optional[bool]
    building_id: Optional[str]
    building_name: Optional[str]
    damage_level: str
    infrastructure_type: str
    disaster_type: Optional[str]
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
    submission_started_at: Optional[datetime]
    submission_submitted_at: Optional[datetime]
    created_at: datetime
    question_answers: Optional[list]
    photos: list[PhotoSummary]
    flag_events: list[FlagEventSummary]
    versions: list[VersionHistoryItem]
    # New fields
    property_id: Optional[str] = None
    projects: list[ProjectRef] = []
    submission_ip: Optional[str] = None


class ReportListItem(BaseModel):
    id: str
    serial_number: Optional[int] = None
    crisis_id: str
    reporter_id: Optional[str]
    reporter_display_id: Optional[int]
    country: Optional[str]
    building_id: Optional[str]
    damage_level: str
    infrastructure_type: str
    disaster_type: Optional[str]
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


VALID_FLAG_STATUSES = {"grey", "green", "orange", "red", "discarded"}

# Transitions that can only happen automatically — reject all manual attempts
AUTO_ONLY_TRANSITIONS = {
    ("grey", "green"),
    ("grey", "red"),
}

# Transitions permitted manually — all require a comment
MANUAL_TRANSITIONS = {
    ("red", "orange"),
    ("red", "discarded"),
    ("discarded", "orange"),
}


class FlagUpdateRequest(BaseModel):
    flag_status: str
    reason: str

    @validator("reason")
    def reason_min_length(cls, v):
        if len(v.strip()) < 10:
            raise ValueError("Comment must be at least 10 characters.")
        return v.strip()


class EmergencyOverrideRequest(BaseModel):
    target_status: str
    reason: str

    @validator("target_status")
    def target_must_be_green_or_red(cls, v):
        if v not in ("green", "red"):
            raise ValueError("target_status must be 'green' or 'red'.")
        return v

    @validator("reason")
    def reason_min_length(cls, v):
        if len(v.strip()) < 10:
            raise ValueError("Comment must be at least 10 characters.")
        return v.strip()


class TranslateRequest(BaseModel):
    target_language: str = "en"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=ReportListResponse)
async def list_reports(
    crisis_id: Optional[str] = Query(None),
    flag_status: Optional[str] = Query(None),
    platform: Optional[str] = Query(None),
    damage_level: Optional[str] = Query(None),        # comma-separated
    infrastructure_type: Optional[str] = Query(None), # comma-separated
    crisis_type: Optional[str] = Query(None),         # comma-separated
    country: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """List reports with filtering and cursor-based pagination."""

    conditions = []

    if crisis_id:
        conditions.append(Report.crisis_id == crisis_id)
    if flag_status:
        # Support comma-separated list of statuses (e.g. "red,orange")
        statuses = [s.strip() for s in flag_status.split(",") if s.strip()]
        if statuses:
            conditions.append(Report.flag_status.in_(statuses))
    else:
        # Default: exclude discarded — must be explicitly filtered to see
        conditions.append(Report.flag_status != "discarded")
    if platform:
        conditions.append(Report.platform == platform)
    if damage_level:
        conditions.append(Report.damage_level.in_(damage_level.split(",")))
    if infrastructure_type:
        conditions.append(Report.infrastructure_type.in_(infrastructure_type.split(",")))
    if crisis_type:
        conditions.append(Report.disaster_type.in_(crisis_type.split(",")))

    # Date range filters
    if date_from:
        try:
            dt_from = datetime.fromisoformat(date_from.replace("Z", "+00:00"))
            conditions.append(Report.submitted_at >= dt_from)
        except ValueError:
            pass
    if date_to:
        try:
            dt_to = datetime.fromisoformat(date_to.replace("Z", "+00:00"))
            conditions.append(Report.submitted_at <= dt_to)
        except ValueError:
            pass

    # Cursor pagination
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.split("_", 1)
            cursor_datetime = datetime.fromisoformat(cursor_ts)
            conditions.append(Report.created_at < cursor_datetime)
        except Exception:
            pass

    query = (
        select(Report)
        .options(joinedload(Report.reporter))
        .where(and_(*conditions) if conditions else True)
        .order_by(Report.created_at.desc())
        .limit(limit + 1)
    )

    # Country filter requires join with reporter
    if country:
        query = query.where(Reporter.country_code == country)

    result = await db.execute(query)
    reports = result.scalars().unique().all()

    has_more = len(reports) > limit
    if has_more:
        reports = list(reports[:limit])

    # Build list items
    items = []
    for report in reports:
        photo_result = await db.execute(
            select(func.count(Photo.id)).where(Photo.report_id == report.id)
        )
        photo_count = photo_result.scalar() or 0

        reporter = report.reporter
        country_code = reporter.country_code if reporter else None

        items.append(ReportListItem(
            id=str(report.id),
            serial_number=report.serial_number,
            crisis_id=str(report.crisis_id),
            reporter_id=str(report.reporter_id) if report.reporter_id else None,
            reporter_display_id=reporter.display_id if reporter else None,
            country=country_code,
            building_id=report.building_id,
            damage_level=report.damage_level,
            infrastructure_type=report.infrastructure_type,
            disaster_type=report.disaster_type,
            flag_status=report.flag_status,
            platform=report.platform,
            gps_latitude=report.gps_latitude,
            gps_longitude=report.gps_longitude,
            submitted_at=report.submitted_at,
            created_at=report.created_at,
            photo_count=photo_count,
        ))

    next_cursor = None
    if has_more and reports:
        last = reports[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

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
    """Get full report detail including photos, flag history, and version history."""

    result = await db.execute(
        select(Report)
        .options(joinedload(Report.reporter))
        .where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    photo_result = await db.execute(
        select(Photo).where(Photo.report_id == report_id).order_by(Photo.display_order)
    )
    photos = photo_result.scalars().all()

    flag_result = await db.execute(
        select(FlagEvent, DashboardUser)
        .outerjoin(DashboardUser, FlagEvent.dashboard_user_id == DashboardUser.id)
        .where(FlagEvent.report_id == report_id)
        .order_by(FlagEvent.created_at)
    )
    flag_rows = flag_result.all()

    # Version history: same reporter + same building (or GPS proximity), exclude self
    versions: list[VersionHistoryItem] = []
    if report.reporter_id:
        version_conditions = [
            Report.reporter_id == report.reporter_id,
            Report.id != report.id,
        ]
        if report.building_id:
            version_conditions.append(Report.building_id == report.building_id)
        elif report.gps_latitude and report.gps_longitude:
            radius = 0.001
            version_conditions += [
                Report.gps_latitude.between(report.gps_latitude - radius, report.gps_latitude + radius),
                Report.gps_longitude.between(report.gps_longitude - radius, report.gps_longitude + radius),
            ]
        v_result = await db.execute(
            select(Report)
            .where(and_(*version_conditions))
            .order_by(Report.created_at.desc())
        )
        for v in v_result.scalars().all():
            versions.append(VersionHistoryItem(
                id=str(v.id),
                serial_number=v.serial_number,
                submitted_at=v.submitted_at,
                damage_level=v.damage_level,
                flag_status=v.flag_status,
                infrastructure_type=v.infrastructure_type,
            ))

    reporter = report.reporter

    # Build URL for authenticated photo serving (relative path)
    photo_list = [
        PhotoSummary(
            id=str(p.id),
            url=f"/api/dashboard/reports/{report_id}/photos/{p.id}",
            display_order=p.display_order,
            was_compressed=p.was_compressed,
            created_at=p.created_at,
            exif_timestamp=p.exif_timestamp,
        )
        for p in photos
    ]

    flag_event_list = [
        FlagEventSummary(
            id=str(f.id),
            flag_from=f.flag_from,
            flag_to=f.flag_to,
            changed_by=f.changed_by,
            reason=f.reason,
            metadata=f.flag_metadata,
            dashboard_user_id=str(f.dashboard_user_id) if f.dashboard_user_id else None,
            dashboard_user_name=user.full_name if user else None,
            is_emergency_override=f.is_emergency_override,
            created_at=f.created_at,
        )
        for f, user in flag_rows
    ]

    # Fetch linked projects (Crisis records via report_projects join table)
    from app.models.report_project import ReportProject
    from app.models.crisis import Crisis as CrisisModel
    proj_result = await db.execute(
        select(CrisisModel)
        .join(ReportProject, ReportProject.crisis_id == CrisisModel.id)
        .where(ReportProject.report_id == report.id)
    )
    projects = [
        ProjectRef(
            id=str(c.id),
            serial_id=c.serial_id or "",
            name=c.name,
        )
        for c in proj_result.scalars().all()
    ]

    # Decrypt submission IP (Fernet-encrypted, base64-stored)
    submission_ip: str | None = None
    if report.ip_address_encrypted:
        try:
            import base64
            from app.services.encryption import decrypt_field
            submission_ip = decrypt_field(base64.b64decode(report.ip_address_encrypted))
        except Exception:
            pass

    # Normalise question_answers — stored as list or dict in JSON column
    qa = report.question_answers
    if isinstance(qa, dict):
        qa = [{"question": k, "answer": v} for k, v in qa.items()]

    return ReportDetail(
        id=str(report.id),
        serial_number=report.serial_number,
        crisis_id=str(report.crisis_id),
        reporter_id=str(report.reporter_id) if report.reporter_id else None,
        reporter_display_id=reporter.display_id if reporter else None,
        reporter_platform=reporter.platform if reporter else None,
        reporter_country_code=reporter.country_code if reporter else None,
        reporter_is_verified=reporter.is_verified if reporter else None,
        reporter_is_blocked=reporter.is_blocked if reporter else None,
        building_id=report.building_id,
        building_name=report.building_name,
        damage_level=report.damage_level,
        infrastructure_type=report.infrastructure_type,
        disaster_type=report.disaster_type,
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
        submission_started_at=report.submission_started_at,
        submission_submitted_at=report.submission_submitted_at,
        created_at=report.created_at,
        question_answers=qa,
        photos=photo_list,
        flag_events=flag_event_list,
        versions=versions,
        property_id=str(report.property_id) if report.property_id else None,
        projects=projects,
        submission_ip=submission_ip,
    )


@router.get("/{report_id}/photos/{photo_id}")
async def serve_photo(
    report_id: str,
    photo_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Serve a report photo — authenticated. JWT required; photos are not public."""

    # Parse IDs explicitly to uuid.UUID so asyncpg comparison is unambiguous.
    try:
        photo_uuid = uuid.UUID(photo_id)
        report_uuid = uuid.UUID(report_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invalid ID format")

    result = await db.execute(
        select(Photo).where(Photo.id == photo_uuid, Photo.report_id == report_uuid)
    )
    photo = result.scalar_one_or_none()
    if not photo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    if settings.STORAGE_BACKEND == "r2":
        # For R2, generate a presigned URL and redirect
        import boto3
        from botocore.client import Config as BotoConfig
        s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{settings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.R2_ACCESS_KEY_ID,
            aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
            config=BotoConfig(signature_version="s3v4"),
            region_name="auto",
        )
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.R2_BUCKET_NAME, "Key": photo.storage_path},
            ExpiresIn=300,
        )
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=url)

    # Local storage — read file and stream it.
    # Use storage_service.base_path (resolved to absolute at startup) so the
    # path is correct regardless of which directory uvicorn was launched from.
    if isinstance(storage_service, LocalFileSystemStorage):
        file_path = storage_service.base_path / Path(photo.storage_path).name
    else:
        # Fallback to settings path (should not reach here for local backend)
        file_path = Path(settings.LOCAL_UPLOAD_PATH) / Path(photo.storage_path).name

    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Photo file not found on disk: {file_path.name}")

    def iterfile():
        with open(file_path, "rb") as f:
            yield from f

    return StreamingResponse(iterfile(), media_type=photo.mime_type or "image/jpeg")


@router.patch("/{report_id}/flag", response_model=dict)
async def update_report_flag(
    report_id: str,
    request: FlagUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("reports_page", require_edit=True)),
):
    """Manually update a report flag status. Enforces strict transition matrix."""

    if request.flag_status not in VALID_FLAG_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"flag_status must be one of: {', '.join(sorted(VALID_FLAG_STATUSES))}",
        )

    result = await db.execute(select(Report).where(Report.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    current_status = report.flag_status
    requested_status = request.flag_status
    transition = (current_status, requested_status)

    if transition in AUTO_ONLY_TRANSITIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This transition is automatic only and cannot be performed manually.",
        )

    if transition not in MANUAL_TRANSITIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid flag transition from {current_status} to {requested_status}.",
        )

    report.flag_status = requested_status
    report.updated_at = datetime.now(timezone.utc)

    flag_event = FlagEvent(
        report_id=report.id,
        dashboard_user_id=current_user.id,
        flag_from=current_status,
        flag_to=requested_status,
        changed_by="manual",
        reason=request.reason,
        is_emergency_override=False,
    )
    db.add(flag_event)
    await db.commit()

    from app.routers.dashboard_sse import publish_event
    await publish_event(
        crisis_id=str(report.crisis_id),
        event_type="flag_changed",
        data={"report_id": report_id, "flag_from": current_status, "flag_to": requested_status},
    )

    return {
        "report_id": report_id,
        "flag_from": current_status,
        "flag_to": requested_status,
        "message": "Flag updated successfully",
    }


@router.post("/{report_id}/emergency-override", response_model=dict)
async def emergency_override_flag(
    report_id: str,
    request: EmergencyOverrideRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    """Superadmin-only: force a Grey report to Green or Red, bypassing the transition matrix."""

    result = await db.execute(select(Report).where(Report.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    if report.flag_status != "grey":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Emergency override only applies to Grey reports. Current status: {report.flag_status}",
        )

    previous_flag = report.flag_status
    report.flag_status = request.target_status
    report.updated_at = datetime.now(timezone.utc)

    flag_event = FlagEvent(
        report_id=report.id,
        dashboard_user_id=current_user.id,
        flag_from=previous_flag,
        flag_to=request.target_status,
        changed_by="manual",
        reason=request.reason,
        is_emergency_override=True,
    )
    db.add(flag_event)
    await db.commit()

    from app.routers.dashboard_sse import publish_event
    await publish_event(
        crisis_id=str(report.crisis_id),
        event_type="flag_changed",
        data={"report_id": report_id, "flag_from": previous_flag, "flag_to": request.target_status},
    )

    return {
        "report_id": report_id,
        "flag_from": previous_flag,
        "flag_to": request.target_status,
        "is_emergency_override": True,
        "message": "Emergency override applied successfully",
    }


@router.post("/{report_id}/translate", response_model=dict)
async def translate_report_description(
    report_id: str,
    request: TranslateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """On-demand translation of report description via LibreTranslate."""

    import httpx

    result = await db.execute(select(Report).where(Report.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    if not report.description:
        return {"translated": None, "message": "No description to translate"}

    try:
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

        report.description_translated = translated_text
        await db.commit()

        return {
            "original": report.description,
            "translated": translated_text,
            "target_language": request.target_language,
        }

    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Translation service unavailable. Please try again.",
        )
