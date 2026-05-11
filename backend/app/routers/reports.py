import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional, List

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.crisis import Crisis
from app.models.flag_event import FlagEvent
from app.services.dependencies import get_optional_reporter
from app.services.encryption import encrypt_field
from app.services.auto_flagging import auto_flag_report

router = APIRouter(prefix="/api/reports", tags=["Reports"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class LocationData(BaseModel):
    gps_latitude: Optional[float] = None
    gps_longitude: Optional[float] = None
    gps_accuracy_meters: Optional[float] = None
    gps_available: bool = True
    location_address: Optional[str] = None
    location_landmark: Optional[str] = None
    location_building_name: Optional[str] = None


class ReportSubmitRequest(BaseModel):
    # Required
    damage_level: str  # minimal, partial, complete
    infrastructure_types: List[str]  # array — matches frontend field name
    platform: str  # android, pwa, web
    submitted_at: datetime
    location: LocationData

    # crisis_id is optional — if omitted, the first active crisis is used
    crisis_id: Optional[str] = None

    # Optional
    local_id: Optional[str] = None
    reporter_id: Optional[str] = None
    building_id: Optional[str] = None
    building_name: Optional[str] = None
    language_code: str = "en"
    # New UNDP question fields
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
        result = await db.execute(
            select(Reporter).where(Reporter.id == request.reporter_id)
        )
        reporter = result.scalar_one_or_none()
        if reporter:
            reporter_id = reporter.id

# Encrypt IP address
    import base64
    client_ip = http_request.client.host if http_request.client else None
    ip_encrypted = base64.b64encode(encrypt_field(client_ip)).decode() if client_ip else None

    # Create report with initial Grey flag
    report = Report(
        local_id=request.local_id,
        crisis_id=resolved_crisis_id,
        reporter_id=reporter_id,
        building_id=request.building_id,
        building_name=request.building_name,
        gps_latitude=request.location.gps_latitude,
        gps_longitude=request.location.gps_longitude,
        gps_accuracy_meters=request.location.gps_accuracy_meters,
        gps_available=request.location.gps_available,
        location_address=request.location.location_address,
        location_landmark=request.location.location_landmark,
        location_building_name=request.location.location_building_name,
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
        question_package_version=request.question_package_version,
        translation_version=request.translation_version,
        mcc=request.mcc,
        mnc=request.mnc,
        carrier_name=request.carrier_name,
        ip_address_encrypted=ip_encrypted,
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

    # Update reporter activity
    if reporter:
        reporter.report_count = (reporter.report_count or 0) + 1
        reporter.last_active_at = datetime.now(timezone.utc)

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