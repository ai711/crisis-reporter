import json
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status, Request, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update
from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Literal

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.crisis import Crisis
from app.models.flag_event import FlagEvent
from app.services.dependencies import get_optional_reporter, get_current_reporter, require_admin
from app.models.dashboard_user import DashboardUser
from app.models.report_edit import ReportEdit
from app.models.photo import Photo
from app.services.encryption import encrypt_field, hash_field
from app.services.auto_flagging import auto_flag_report

router = APIRouter(prefix="/api/reports", tags=["Reports"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LocationData(BaseModel):
    gps_latitude: Optional[float] = None
    gps_longitude: Optional[float] = None
    gps_accuracy_meters: Optional[float] = None
    gps_available: Optional[bool] = True
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
    building_type: Optional[str] = None
    pin_drop_lat: Optional[float] = None
    pin_drop_lng: Optional[float] = None


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
    flow_started_at: Optional[datetime] = None
    submission_started_at: Optional[str] = None
    submission_submitted_at: Optional[str] = None
    photo_metadata: Optional[str] = None
    photo_exif_data: Optional[str] = None
    photos_metadata: Optional[List[dict]] = None

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

    # Device identification
    device_id: Optional[str] = None
    os_device_id: Optional[str] = None
    device_model: Optional[str] = None
    device_brand: Optional[str] = None
    device_os_version: Optional[str] = None

    # Submission context
    network_type_at_submission: Optional[str] = None
    reporter_country: Optional[str] = None

    # Offline queue tracking
    was_queued: bool = False
    queued_at: Optional[datetime] = None


class ReportSubmitResponse(BaseModel):
    report_id: str
    serial_number: Optional[int] = None
    message: str


class ReportResponse(BaseModel):
    """Reporter-facing report detail.

    Intentionally omits flag_status, was_queued, platform, language_code,
    crisis_id and reporter_id — those are internal/dashboard-only fields that
    must not appear in a reporter's browser DevTools.
    """
    id: str
    serial_number: Optional[int] = None
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
    description: Optional[str] = None
    gps_latitude: Optional[float]
    gps_longitude: Optional[float]
    gps_accuracy_meters: Optional[float] = None
    gps_available: bool
    location_address: Optional[str]
    location_landmark: Optional[str]
    location_building_name: Optional[str] = None
    location_note: Optional[str] = None
    building_name_reporter: Optional[str] = None
    building_name_osm: Optional[str] = None
    submitted_at: datetime
    created_at: datetime
    photo_urls: List[str] = []
    photo_count: int = 0

    class Config:
        from_attributes = True


class ReporterReportItem(BaseModel):
    """One row in the reporter's "My Reports" list.

    flag_status is intentionally omitted — review flags are internal and must
    not appear in a reporter's browser Network tab.
    """
    id: str
    serial_number: Optional[int] = None
    damage_level: Optional[str]
    submitted_at: Optional[datetime]
    gps_latitude: Optional[float]
    gps_longitude: Optional[float]
    location_address: Optional[str]
    location_landmark: Optional[str]
    building_name: Optional[str]
    photo_count: int = 0
    first_photo_url: Optional[str] = None
    disaster_type: Optional[str] = None
    infrastructure_type: Optional[str] = None
    infrastructure_name: Optional[str] = None

    class Config:
        from_attributes = True


class ReporterReportsResponse(BaseModel):
    items: List[ReporterReportItem]
    next_cursor: Optional[str] = None
    total: int = 0


class MapReportItem(BaseModel):
    id: str
    damage_level: Optional[str]
    location_lat: float
    location_lng: float
    created_at: Optional[datetime]

    class Config:
        from_attributes = True


class MapReportsResponse(BaseModel):
    reports: List[MapReportItem]
    total_count: int


# ── Helpers ───────────────────────────────────────────────────────────────────

def _compute_location_fields(loc: "LocationData") -> dict:
    """Return location_lat, location_lng, location_source using the canonical priority rule.

    Priority: building_centroid > pin_drop > gps (raw device position).
    location_source records which input won so the dashboard can show it.
    """
    if loc.building_centroid_lat is not None and loc.building_centroid_lng is not None:
        return {
            "location_lat": loc.building_centroid_lat,
            "location_lng": loc.building_centroid_lng,
            "location_source": "building_centroid",
        }
    if loc.pin_drop_lat is not None and loc.pin_drop_lng is not None:
        return {
            "location_lat": loc.pin_drop_lat,
            "location_lng": loc.pin_drop_lng,
            "location_source": "pin_drop",
        }
    if loc.gps_latitude is not None and loc.gps_longitude is not None:
        return {
            "location_lat": loc.gps_latitude,
            "location_lng": loc.gps_longitude,
            "location_source": "gps",
        }
    return {"location_lat": None, "location_lng": None, "location_source": None}


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

    # Resolve crisis — crisis association is optional; reports can be submitted
    # without any active project configured and linked retroactively.
    crisis = None
    if request.crisis_id:
        result = await db.execute(
            select(Crisis).where(Crisis.id == request.crisis_id)
        )
        crisis = result.scalar_one_or_none()
    if crisis is None:
        # No valid crisis_id provided — try to find the most recent active one
        result = await db.execute(
            select(Crisis).where(Crisis.status == "active")
            .order_by(Crisis.created_at.desc()).limit(1)
        )
        crisis = result.scalar_one_or_none()
    resolved_crisis_id = crisis.id if crisis else None

    # Deduplicate offline-queue retries — return the existing report instead of
    # inserting a duplicate. The client then proceeds to upload photos against
    # the original report_id, which is the correct behaviour on retry.
    if request.resolved_local_id:
        dup_result = await db.execute(
            select(Report).where(Report.local_id == request.resolved_local_id)
        )
        existing = dup_result.scalar_one_or_none()
        if existing:
            return ReportSubmitResponse(
                report_id=str(existing.id),
                serial_number=existing.serial_number,
                message="Report already submitted",
            )

    # Validate damage level
    if request.damage_level not in ["minimal", "partial", "complete"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="damage_level must be minimal, partial, or complete",
        )

    # Validate platform
    valid_platforms = {"android", "pwa", "web", "Native App Android", "Native App iOS"}
    if request.platform not in valid_platforms:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="platform must be android, pwa, web, Native App Android, or Native App iOS",
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

    # reporter_id is mandatory — every report must have an owner.
    # If no reporter could be resolved (no JWT, no valid reporter_id in body),
    # try to match by device_id first (covers offline-queued reports submitted
    # with a CR-PENDING- id before registration completed). Only create a new
    # profile when device_id is also absent or matches nothing.
    if reporter_id is None and request.device_id:
        dh = hash_field(request.device_id)
        r2 = await db.execute(select(Reporter).where(Reporter.device_id_hash == dh))
        matched_by_device = r2.scalar_one_or_none()
        if matched_by_device:
            reporter = matched_by_device
            reporter_id = matched_by_device.id

    if reporter_id is None:
        from sqlalchemy import text as sa_text
        auto_reporter = Reporter(
            platform=request.platform,
            country_code=request.reporter_country,
            language_code=request.language_code,
            device_id_encrypted=encrypt_field(request.device_id) if request.device_id else None,
            device_id_hash=hash_field(request.device_id) if request.device_id else None,
        )
        db.add(auto_reporter)
        await db.flush()
        seq_result = await db.execute(sa_text("SELECT nextval('reporter_display_id_seq')"))
        auto_reporter.display_id = seq_result.scalar()
        reporter = auto_reporter
        reporter_id = auto_reporter.id

    # Check if reporter is blocked — route directly to red flag
    submission_flag_status = "grey"
    if reporter and getattr(reporter, 'is_blocked', False):
        submission_flag_status = "red"

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
        pin_drop_lat=request.location.pin_drop_lat,
        pin_drop_lng=request.location.pin_drop_lng,
        # Canonical building coordinate — priority: building_centroid > pin_drop > gps
        **_compute_location_fields(request.location),
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
        flag_status=submission_flag_status,
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
        flow_started_at=request.flow_started_at,
        submission_started_at=submission_started_at,
        submission_submitted_at=submission_submitted_at,
        photo_metadata=json.dumps(request.photos_metadata) if request.photos_metadata else request.photo_metadata,
        photo_exif_data=request.photo_exif_data,
        # Cellular
        mcc=request.mcc,
        mnc=request.mnc,
        carrier_name=request.carrier_name,
        ip_address_encrypted=ip_encrypted,
        ip_address_hash=ip_hash,
        device_id=request.device_id,
        os_device_id=request.os_device_id,
        device_model=request.device_model,
        device_brand=request.device_brand,
        device_os_version=request.device_os_version,
        network_type=request.network_type_at_submission,
        reporter_country=request.reporter_country,
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
        # Capture first-seen IP as Fernet-encrypted (never overwrite, never store plaintext)
        if not reporter.ip_address_encrypted and ip_encrypted:
            reporter.ip_address_encrypted = ip_encrypted
        # Update ip_address_hash on every submission — used by Rule 2 auto-flagging
        # to match the report's submission IP against blocked reporters' last-seen IPs.
        if ip_hash:
            reporter.ip_address_hash = ip_hash
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

    # Notify dashboard that a new report arrived (flag still grey).
    # Skip publish when no crisis is associated — no SSE channel to target.
    if resolved_crisis_id is not None:
        from app.routers.dashboard_sse import publish_event
        await publish_event(
            crisis_id=str(resolved_crisis_id),
            event_type="report_confirmed",
            data={
                "report_id": str(report.id),
                "flag_status": "grey",
                "damage_level": report.damage_level,
                "latitude": report.location_lat,
                "longitude": report.location_lng,
                "platform": report.platform,
            },
        )

    # Auto-flagging runs after the response is sent to the reporter
    background_tasks.add_task(auto_flag_report, str(report.id))

    return ReportSubmitResponse(
        report_id=str(report.id),
        serial_number=report.serial_number,
        message="Report received",
    )

@router.get("", response_model=List[ReportResponse])
async def list_reports(
    limit: int = Query(200, le=500),
    cursor: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """List recent geo-located reports for the mobile map screen."""
    query = select(Report).where(
        Report.gps_latitude.isnot(None),
        Report.gps_longitude.isnot(None),
        Report.flag_status.in_(["green", "orange"]),
    )
    if cursor:
        query = query.where(Report.id < cursor)
    query = query.order_by(Report.created_at.desc()).limit(limit)
    result = await db.execute(query)
    reports_list = result.scalars().all()
    return [
        ReportResponse(
            id=str(r.id),
            building_id=r.building_id,
            building_name=r.building_name,
            damage_level=r.damage_level,
            infrastructure_type=r.infrastructure_type,
            infrastructure_types=r.infrastructure_types,
            infrastructure_other=r.infrastructure_other,
            infrastructure_name=r.infrastructure_name,
            disaster_type=r.disaster_type,
            debris_blocking=r.debris_blocking,
            electricity_condition=r.electricity_condition,
            health_services_condition=r.health_services_condition,
            pressing_needs=r.pressing_needs,
            pressing_needs_other=r.pressing_needs_other,
            gps_latitude=r.gps_latitude,
            gps_longitude=r.gps_longitude,
            gps_available=r.gps_available,
            location_address=r.location_address,
            location_landmark=r.location_landmark,
            submitted_at=r.submitted_at,
            created_at=r.created_at,
        )
        for r in reports_list
    ]


@router.get("/my", response_model=ReporterReportsResponse)
async def get_my_reports(
    limit: int = Query(default=20, le=100),
    cursor: Optional[str] = None,
    current_reporter: Reporter = Depends(get_current_reporter),
    db: AsyncSession = Depends(get_db),
):
    """Returns paginated reports for the authenticated reporter."""
    from sqlalchemy.orm import joinedload
    from app.models.photo import Photo
    from app.services.storage import storage_service

    conditions = [Report.reporter_id == current_reporter.id]
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            conditions.append(Report.submitted_at < cursor_dt)
        except ValueError:
            pass

    query = (
        select(Report)
        .options(joinedload(Report.photos))
        .where(*conditions)
        .order_by(Report.submitted_at.desc())
        .limit(limit + 1)
    )
    result = await db.execute(query)
    reports_list = list(result.scalars().unique().all())

    has_more = len(reports_list) > limit
    if has_more:
        reports_list = reports_list[:limit]

    count_result = await db.execute(
        select(func.count(Report.id)).where(Report.reporter_id == current_reporter.id)
    )
    total = count_result.scalar() or 0

    items = []
    for r in reports_list:
        photos = sorted(r.photos, key=lambda p: p.display_order)
        photo_count = len(photos)
        first_photo_url = storage_service.get_url(photos[0].storage_path) if photos else None
        items.append(ReporterReportItem(
            id=str(r.id),
            serial_number=r.serial_number,
            damage_level=r.damage_level,
            submitted_at=r.submitted_at,
            gps_latitude=r.gps_latitude,
            gps_longitude=r.gps_longitude,
            location_address=r.location_address,
            location_landmark=r.location_landmark,
            building_name=r.building_name,
            photo_count=photo_count,
            first_photo_url=first_photo_url,
            disaster_type=r.disaster_type,
            infrastructure_type=r.infrastructure_type,
            infrastructure_name=r.infrastructure_name,
        ))

    next_cursor = None
    if has_more and reports_list:
        last = reports_list[-1]
        next_cursor = last.submitted_at.isoformat() if last.submitted_at else None

    return ReporterReportsResponse(items=items, next_cursor=next_cursor, total=total)


@router.get("/map", response_model=MapReportsResponse)
async def get_map_reports(
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    radius_miles: float = Query(default=50.0, ge=1, le=500),
    crisis_id: Optional[str] = None,
    limit: int = Query(default=200, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Returns geolocated, verified reports for map display. No authentication required.

    When lat+lng are provided, only reports within radius_miles of that point are returned
    (haversine distance) — centred on the user's GPS position.
    crisis_id is kept for backward compatibility but is no longer used by frontend clients.
    """
    conditions = [
        Report.location_lat.isnot(None),
        Report.location_lng.isnot(None),
        Report.flag_status.in_(["green", "orange"]),
    ]

    if lat is not None and lng is not None:
        radius_km = radius_miles * 1.60934
        dist_km = 6371.0 * func.acos(
            func.least(
                1.0,
                func.cos(func.radians(lat))
                * func.cos(func.radians(Report.location_lat))
                * func.cos(func.radians(Report.location_lng) - func.radians(lng))
                + func.sin(func.radians(lat))
                * func.sin(func.radians(Report.location_lat)),
            )
        )
        conditions.append(dist_km <= radius_km)

    query = (
        select(Report)
        .where(*conditions)
        .order_by(Report.created_at.desc())
        .limit(limit)
    )
    result = await db.execute(query)
    reports_list = result.scalars().all()

    items = [
        MapReportItem(
            id=str(r.id),
            damage_level=r.damage_level,
            location_lat=r.location_lat,
            location_lng=r.location_lng,
            created_at=r.created_at,
        )
        for r in reports_list
    ]

    return MapReportsResponse(reports=items, total_count=len(items))


@router.get("/duplicate-check")
async def check_duplicate_report(
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    building_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_reporter: Optional[Reporter] = Depends(get_optional_reporter),
):
    """Check whether the reporter already has a report for this location within
    the last 24 hours. Works for anonymous reporters with a JWT and for
    unauthenticated callers (returns no duplicate found)."""
    if not current_reporter:
        return {"is_duplicate": False}

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

    # Check by canonical location proximity (~10 m ≈ 0.0001 degrees).
    # Uses location_lat/lng (building centroid > pin drop > GPS) so reporters
    # standing at different spots but reporting the same building are caught.
    if lat is not None and lng is not None:
        result = await db.execute(
            select(Report).where(
                Report.reporter_id == current_reporter.id,
                Report.created_at >= cutoff,
                func.abs(Report.location_lat - lat) < 0.0001,
                func.abs(Report.location_lng - lng) < 0.0001,
            )
        )
        if result.scalar_one_or_none():
            return {"is_duplicate": True}

    return {"is_duplicate": False}


class MergeReportRequest(BaseModel):
    target_report_id: str  # The canonical report to keep
    merge_reason: Optional[str] = None


class EditReportRequest(BaseModel):
    # Values must match the option_value fields in the active question package.
    damage_level: Optional[Literal["minimal", "partial", "complete"]] = None
    infrastructure_types: Optional[List[str]] = None
    infrastructure_name: Optional[str] = None
    disaster_type: Optional[Literal[
        "earthquake", "flood", "tsunami", "hurricane_cyclone",
        "wildfire", "explosion", "chemical_incident", "conflict", "civil_unrest",
    ]] = None
    debris_blocking: Optional[Literal["yes", "no"]] = None
    electricity_condition: Optional[Literal[
        "no_damage", "minor", "moderate", "severe", "destroyed", "unknown",
    ]] = None
    health_services_condition: Optional[Literal[
        "functional", "partial", "disrupted", "not_functioning", "unknown",
    ]] = None
    pressing_needs: Optional[List[str]] = None
    # Coordinate override — used when admin manually looks up a building's position
    # for text-only reports that have no GPS or building-tap coordinates.
    location_lat: Optional[float] = None
    location_lng: Optional[float] = None
    edit_reason: Optional[str] = None


@router.patch("/{report_id}")
async def edit_report(
    report_id: str,
    request: EditReportRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Edit report fields from the dashboard. Creates an audit trail entry."""
    result = await db.execute(select(Report).where(Report.id == report_id))
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found")

    editable_fields = [
        "damage_level",
        "infrastructure_types",
        "infrastructure_name",
        "disaster_type",
        "debris_blocking",
        "electricity_condition",
        "health_services_condition",
        "pressing_needs",
    ]

    fields_changed: dict = {}
    for field in editable_fields:
        new_val = getattr(request, field)
        if new_val is None:
            continue
        current_val = getattr(report, field)
        if new_val != current_val:
            fields_changed[field] = {"from": current_val, "to": new_val}
            setattr(report, field, new_val)

    # Coordinate override — handled separately because we also set location_source.
    # Both lat and lng must be provided together; partial updates are rejected.
    if (request.location_lat is None) != (request.location_lng is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="location_lat and location_lng must be provided together.",
        )
    if request.location_lat is not None:
        if not (-90 <= request.location_lat <= 90):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="location_lat must be between -90 and 90.")
        if not (-180 <= request.location_lng <= 180):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="location_lng must be between -180 and 180.")
        if request.location_lat != report.location_lat or request.location_lng != report.location_lng:
            fields_changed["location_lat"] = {"from": report.location_lat, "to": request.location_lat}
            fields_changed["location_lng"] = {"from": report.location_lng, "to": request.location_lng}
            fields_changed["location_source"] = {"from": report.location_source, "to": "manual"}
            report.location_lat = request.location_lat
            report.location_lng = request.location_lng
            report.location_source = "manual"

    if not fields_changed:
        return {"edited": False, "reason": "no_changes"}

    count_result = await db.execute(
        select(func.count(ReportEdit.id)).where(ReportEdit.report_id == report.id)
    )
    version_number = (count_result.scalar() or 0) + 1

    db.add(ReportEdit(
        report_id=report.id,
        edited_by=current_user.email,
        fields_changed=fields_changed,
        edit_reason=request.edit_reason,
        version_number=version_number,
    ))

    await db.commit()
    return {"edited": True, "version": version_number, "fields_changed": fields_changed}


@router.get("/{report_id}/edits")
async def get_report_edits(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(require_admin),
):
    """Return all edit audit entries for a report, newest first."""
    result = await db.execute(
        select(ReportEdit)
        .where(ReportEdit.report_id == report_id)
        .order_by(ReportEdit.edited_at.desc())
    )
    edits = result.scalars().all()
    return [
        {
            "id": str(e.id),
            "edited_by": e.edited_by,
            "edited_at": e.edited_at.isoformat(),
            "fields_changed": e.fields_changed,
            "edit_reason": e.edit_reason,
            "version_number": e.version_number,
        }
        for e in edits
    ]


@router.post("/{report_id}/merge")
async def merge_reports(
    report_id: str,
    request: MergeReportRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Mark report_id as a duplicate and transfer its photos to target_report_id."""
    # Fetch duplicate
    dup_result = await db.execute(select(Report).where(Report.id == report_id))
    duplicate_report = dup_result.scalar_one_or_none()
    if not duplicate_report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Duplicate report not found")

    # Fetch canonical
    can_result = await db.execute(select(Report).where(Report.id == request.target_report_id))
    canonical_report = can_result.scalar_one_or_none()
    if not canonical_report:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Canonical report not found")

    if duplicate_report.id == canonical_report.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot merge a report into itself")

    if duplicate_report.building_id != canonical_report.building_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reports belong to different properties and cannot be merged",
        )

    # Count photos being transferred
    photo_count_result = await db.execute(
        select(func.count(Photo.id)).where(Photo.report_id == duplicate_report.id)
    )
    photo_count = photo_count_result.scalar() or 0

    # Transfer photos from duplicate to canonical
    await db.execute(
        update(Photo)
        .where(Photo.report_id == duplicate_report.id)
        .values(report_id=canonical_report.id)
    )

    # Mark duplicate as discarded
    duplicate_report.flag_status = "discarded"

    merge_note = (request.merge_reason or "").strip()

    # Flag event on the duplicate
    db.add(FlagEvent(
        report_id=duplicate_report.id,
        flag_from=duplicate_report.flag_status,
        flag_to="discarded",
        changed_by="manual",
        reason=f"duplicate_merged — Merged into {str(canonical_report.id)[:8].upper()}. {merge_note}".strip().rstrip("—").strip(),
        dashboard_user_id=current_user.id,
    ))

    # Note event on the canonical report
    db.add(FlagEvent(
        report_id=canonical_report.id,
        flag_from=canonical_report.flag_status,
        flag_to=canonical_report.flag_status,
        changed_by="manual",
        reason=f"duplicate_absorbed — Absorbed {str(duplicate_report.id)[:8].upper()}. {merge_note}".strip().rstrip("—").strip(),
        dashboard_user_id=current_user.id,
    ))

    await db.commit()

    return {
        "merged": True,
        "canonical_report_id": str(canonical_report.id),
        "duplicate_report_id": str(duplicate_report.id),
        "photos_transferred": photo_count,
    }


@router.get("/{report_id}", response_model=ReportResponse)
async def get_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get a single report by ID — includes all Q1-Q8 fields and photo URLs."""
    from sqlalchemy.orm import joinedload
    from app.services.storage import storage_service

    result = await db.execute(
        select(Report)
        .options(joinedload(Report.photos))
        .where(Report.id == report_id)
    )
    report = result.unique().scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    photos = sorted(report.photos, key=lambda p: p.display_order)
    photo_urls = [storage_service.get_url(p.storage_path) for p in photos]

    return ReportResponse(
        id=str(report.id),
        serial_number=report.serial_number,
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
        description=report.description,
        gps_latitude=report.gps_latitude,
        gps_longitude=report.gps_longitude,
        gps_accuracy_meters=report.gps_accuracy_meters,
        gps_available=report.gps_available,
        location_address=report.location_address,
        location_landmark=report.location_landmark,
        location_building_name=report.location_building_name,
        location_note=report.location_note,
        building_name_reporter=report.building_name_reporter,
        building_name_osm=report.building_name_osm,
        submitted_at=report.submitted_at,
        created_at=report.created_at,
        photo_urls=photo_urls,
        photo_count=len(photos),
    )