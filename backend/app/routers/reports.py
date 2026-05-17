import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status, Request, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel, ConfigDict
from typing import Optional, List

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.crisis import Crisis
from app.models.flag_event import FlagEvent
from app.services.dependencies import get_optional_reporter, get_current_reporter
from app.services.encryption import encrypt_field, hash_field
from app.services.auto_flagging import auto_flag_report

router = APIRouter(prefix="/api/reports", tags=["Reports"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LocationData(BaseModel):
    gps_latitude: Optional[float] = None
    gps_longitude: Optional[float] = None
    gps_accuracy_meters: Optional[float] = None
    gps_available: bool = True
    gps_denied: Optional[bool] = None
    location_address: Optional[str] = None
    location_landmark: Optional[str] = None
    location_building_name: Optional[str] = None
    # BE-03 — Chapter 5 extended location fields
    building_centroid_lat: Optional[float] = None
    building_centroid_lng: Optional[float] = None
    building_name_osm: Optional[str] = None
    building_name_reporter: Optional[str] = None
    location_note: Optional[str] = None
    location_entry_method: Optional[str] = None
    location_internet_available: Optional[bool] = None


class ReportSubmitRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Required
    damage_level: str  # minimal, partial, complete
    infrastructure_types: List[str]  # array — matches frontend field name
    platform: str  # android, pwa, web
    submitted_at: datetime
    location: LocationData

    # crisis_id is optional — if omitted, the first active crisis is used
    crisis_id: Optional[str] = None

    # Both field names accepted: online web path sends local_report_id,
    # offline queue sends local_id — resolved to the same DB column
    local_report_id: Optional[str] = None
    local_id: Optional[str] = None
    reporter_id: Optional[str] = None

    @property
    def resolved_local_id(self) -> Optional[str]:
        return self.local_report_id or self.local_id

    building_id: Optional[str] = None
    building_name: Optional[str] = None
    language_code: str = "en"

    # BE-02 — Chapter 4 submission timing and photo metadata
    submission_started_at: Optional[str] = None
    submission_submitted_at: Optional[str] = None
    photo_metadata: Optional[str] = None
    photo_exif_data: Optional[str] = None

    # UNDP question fields
    infrastructure_other: Optional[str] = None
    infrastructure_name: Optional[str] = None
    disaster_type: Optional[str] = None
    debris_blocking: Optional[str] = None
    # Appendix questions
    electricity_condition: Optional[str] = None
    health_services_condition: Optional[str] = None
    pressing_needs: Optional[List[str]] = None
    pressing_needs_other: Optional[str] = None
    app_version: Optional[str] = None
    question_package_version: Optional[str] = None
    translation_version: Optional[int] = None

    # BE-05 — Chapter 6 structured answers and precise version fields
    question_answers: Optional[list] = None
    question_package_content_version: Optional[str] = None
    question_package_translation_version: Optional[str] = None

    # MCC data — Android only
    mcc: Optional[str] = None
    mnc: Optional[str] = None
    carrier_name: Optional[str] = None

    # Offline queue tracking
    was_queued: bool = False
    queued_at: Optional[datetime] = None


class ReportSubmitResponse(BaseModel):
    report_id: str
    flag_status: str
    message: str


class ReportResponse(BaseModel):
    id: str
    crisis_id: str
    reporter_id: Optional[str]
    building_id: Optional[str]
    building_name: Optional[str]
    damage_level: str
    infrastructure_type: Optional[str]
    infrastructure_types: Optional[List[str]]
    infrastructure_other: Optional[str]
    infrastructure_name: Optional[str]
    disaster_type: Optional[str]
    debris_blocking: Optional[str]
    electricity_condition: Optional[str]
    health_services_condition: Optional[str]
    pressing_needs: Optional[List[str]]
    pressing_needs_other: Optional[str]
    flag_status: str
    platform: str
    language_code: str
    gps_latitude: Optional[float]
    gps_longitude: Optional[float]
    gps_available: bool
    location_address: Optional[str]
    location_landmark: Optional[str]
    was_queued: bool
    submitted_at: datetime
    created_at: datetime

    class Config:
        from_attributes = True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", response_model=ReportSubmitResponse)
async def submit_report(
    request: ReportSubmitRequest,
    http_request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_reporter: Optional[Reporter] = Depends(get_optional_reporter),
):
    """Submit a damage report.

    Accepts reports from all three tiers:
    - Tier A: Android native app
    - Tier B: PWA
    - Tier C: Plain web

    Accepts both anonymous and verified reporters.
    Accepts both online submissions and offline queue syncs.
    """

    # Resolve crisis — use provided crisis_id or fall back to first active crisis
    if request.crisis_id:
        result = await db.execute(
            select(Crisis).where(
                Crisis.id == request.crisis_id,
                Crisis.is_active == True,
            )
        )
        crisis = result.scalar_one_or_none()
    else:
        result = await db.execute(
            select(Crisis).where(Crisis.is_active == True).order_by(Crisis.created_at.desc()).limit(1)
        )
        crisis = result.scalar_one_or_none()

    if not crisis:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Crisis not found or no longer active",
        )
    resolved_crisis_id = crisis.id

    # Validate damage level
    if request.damage_level not in ["minimal", "partial", "complete"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="damage_level must be minimal, partial, or complete",
        )

    # Validate platform
    if request.platform not in ["android", "pwa", "web"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="platform must be android, pwa, or web",
        )

    # Resolve reporter — use JWT reporter if available,
    # otherwise look up by reporter_id from request
    reporter = current_reporter
    reporter_id = None

    if reporter:
        reporter_id = reporter.id
    elif request.reporter_id:
        # Try integer display_id first (new sessions), then UUID (old sessions)
        matched = None
        try:
            display_id_int = int(request.reporter_id)
            r = await db.execute(
                select(Reporter).where(Reporter.display_id == display_id_int)
            )
            matched = r.scalar_one_or_none()
        except (ValueError, TypeError):
            pass
        if matched is None:
            try:
                r = await db.execute(
                    select(Reporter).where(Reporter.id == request.reporter_id)
                )
                matched = r.scalar_one_or_none()
            except Exception:
                pass
        if matched:
            reporter = matched
            reporter_id = matched.id

# Encrypt IP address
    import base64
    client_ip = http_request.client.host if http_request.client else None
    ip_encrypted = base64.b64encode(encrypt_field(client_ip)).decode() if client_ip else None
    ip_hash = hash_field(client_ip) if client_ip else None

    # Parse optional ISO datetime strings from BE-02 fields
    submission_started_at = None
    if request.submission_started_at:
        try:
            submission_started_at = datetime.fromisoformat(
                request.submission_started_at.replace("Z", "+00:00")
            )
        except ValueError:
            pass

    submission_submitted_at = None
    if request.submission_submitted_at:
        try:
            submission_submitted_at = datetime.fromisoformat(
                request.submission_submitted_at.replace("Z", "+00:00")
            )
        except ValueError:
            pass

    # Create report with initial Grey flag
    report = Report(
        local_id=request.resolved_local_id,
        crisis_id=resolved_crisis_id,
        reporter_id=reporter_id,
        building_id=request.building_id,
        building_name=request.building_name,
        # GPS
        gps_latitude=request.location.gps_latitude,
        gps_longitude=request.location.gps_longitude,
        gps_accuracy_meters=request.location.gps_accuracy_meters,
        gps_available=request.location.gps_available,
        gps_denied=request.location.gps_denied,
        # Location text
        location_address=request.location.location_address,
        location_landmark=request.location.location_landmark,
        location_building_name=request.location.location_building_name,
        # BE-03 — extended location
        building_centroid_lat=request.location.building_centroid_lat,
        building_centroid_lng=request.location.building_centroid_lng,
        building_name_osm=request.location.building_name_osm,
        building_name_reporter=request.location.building_name_reporter,
        location_note=request.location.location_note,
        location_entry_method=request.location.location_entry_method,
        location_internet_available=request.location.location_internet_available,
        # Damage
        damage_level=request.damage_level,
        infrastructure_type=request.infrastructure_types[0] if request.infrastructure_types else "",
        infrastructure_types=request.infrastructure_types,
        infrastructure_other=request.infrastructure_other,
        infrastructure_name=request.infrastructure_name,
        disaster_type=request.disaster_type,
        debris_blocking=request.debris_blocking,
        electricity_condition=request.electricity_condition,
        health_services_condition=request.health_services_condition,
        pressing_needs=request.pressing_needs,
        pressing_needs_other=request.pressing_needs_other,
        description_language=request.language_code,
        flag_status="grey",
        platform=request.platform,
        app_version=request.app_version,
        language_code=request.language_code,
        # Versioning (existing + new precise fields)
        question_package_version=request.question_package_version,
        translation_version=request.translation_version,
        question_package_content_version=request.question_package_content_version,
        question_package_translation_version=request.question_package_translation_version,
        # BE-05 — structured answers
        question_answers=request.question_answers,
        # BE-02 — submission timing + photo metadata
        submission_started_at=submission_started_at,
        submission_submitted_at=submission_submitted_at,
        photo_metadata=request.photo_metadata,
        photo_exif_data=request.photo_exif_data,
        # Cellular
        mcc=request.mcc,
        mnc=request.mnc,
        carrier_name=request.carrier_name,
        ip_address_encrypted=ip_encrypted,
        ip_address_hash=ip_hash,
        was_queued=request.was_queued,
        queued_at=request.queued_at,
        synced_at=datetime.now(timezone.utc) if request.was_queued else None,
        submitted_at=request.submitted_at,
    )

    db.add(report)
    await db.flush()  # Obtain report.id before commit

    # Record initial grey flag event — report is pending auto-flagging
    db.add(FlagEvent(
        report_id=report.id,
        flag_from=None,
        flag_to="grey",
        changed_by="auto",
        reason="Report received — pending auto-flagging",
    ))

    # Update reporter activity and identity fields
    if reporter:
        reporter.report_count = (reporter.report_count or 0) + 1
        reporter.last_active_at = datetime.now(timezone.utc)
        # Capture identity fields on first submission (never overwrite)
        if not reporter.ip_address and client_ip:
            reporter.ip_address = client_ip
        if not reporter.app_version and request.app_version:
            reporter.app_version = request.app_version
        if not reporter.mcc and request.mcc:
            reporter.mcc = request.mcc
        # Update profile_type based on current state
        if reporter.is_verified or reporter.name_encrypted or reporter.email_encrypted:
            reporter.profile_type = "named_profile"
        elif (reporter.report_count or 0) > 0:
            reporter.profile_type = "anonymous_with_reports"

    await db.commit()
    await db.refresh(report)

    # Notify dashboard that a new report arrived (flag still grey)
    from app.routers.dashboard_sse import publish_event
    await publish_event(
        crisis_id=str(resolved_crisis_id),
        event_type="report_confirmed",
        data={
            "report_id": str(report.id),
            "flag_status": "grey",
            "damage_level": report.damage_level,
            "latitude": report.gps_latitude,
            "longitude": report.gps_longitude,
            "platform": report.platform,
        },
    )

    # Auto-flagging runs after the response is sent to the reporter
    background_tasks.add_task(auto_flag_report, str(report.id))

    return ReportSubmitResponse(
        report_id=str(report.id),
        flag_status="grey",
        message="Report received — verification in progress",
    )

@router.get("/duplicate-check")
async def check_duplicate_report(
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    building_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_reporter: Reporter = Depends(get_current_reporter),
):
    """Check whether the authenticated reporter already has a report for this
    location within the last 24 hours. Anonymous reporters are handled
    client-side via sessionStorage."""
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    # Check by building footprint ID — most precise match
    if building_id:
        result = await db.execute(
            select(Report).where(
                Report.reporter_id == current_reporter.id,
                Report.building_id == building_id,
                Report.created_at >= cutoff,
            )
        )
        if result.scalar_one_or_none():
            return {"is_duplicate": True}

    # Check by GPS proximity (~10 metres ≈ 0.0001 degrees)
    if lat is not None and lng is not None:
        result = await db.execute(
            select(Report).where(
                Report.reporter_id == current_reporter.id,
                Report.created_at >= cutoff,
                func.abs(Report.gps_latitude - lat) < 0.0001,
                func.abs(Report.gps_longitude - lng) < 0.0001,
            )
        )
        if result.scalar_one_or_none():
            return {"is_duplicate": True}

    return {"is_duplicate": False}


@router.get("/{report_id}", response_model=ReportResponse)
async def get_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a single report by ID."""
    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )
    return ReportResponse(
        id=str(report.id),
        crisis_id=str(report.crisis_id),
        reporter_id=str(report.reporter_id) if report.reporter_id else None,
        building_id=report.building_id,
        building_name=report.building_name,
        damage_level=report.damage_level,
        infrastructure_type=report.infrastructure_type,
        infrastructure_types=report.infrastructure_types,
        infrastructure_other=report.infrastructure_other,
        infrastructure_name=report.infrastructure_name,
        disaster_type=report.disaster_type,
        debris_blocking=report.debris_blocking,
        electricity_condition=report.electricity_condition,
        health_services_condition=report.health_services_condition,
        pressing_needs=report.pressing_needs,
        pressing_needs_other=report.pressing_needs_other,
        flag_status=report.flag_status,
        platform=report.platform,
        language_code=report.language_code,
        gps_latitude=report.gps_latitude,
        gps_longitude=report.gps_longitude,
        gps_available=report.gps_available,
        location_address=report.location_address,
        location_landmark=report.location_landmark,
        was_queued=report.was_queued,
        submitted_at=report.submitted_at,
        created_at=report.created_at,
    )