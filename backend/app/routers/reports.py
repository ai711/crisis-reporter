import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.crisis import Crisis
from app.models.flag_event import FlagEvent
from app.services.dependencies import get_optional_reporter
from app.services.encryption import encrypt_field

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
    crisis_id: str
    damage_level: str  # minimal, partial, complete
    infrastructure_type: str
    platform: str  # android, pwa, web
    submitted_at: datetime
    location: LocationData

    # Optional
    local_id: Optional[str] = None
    reporter_id: Optional[str] = None
    building_id: Optional[str] = None
    building_name: Optional[str] = None
    description: Optional[str] = None
    language_code: str = "en"
    app_version: Optional[str] = None
    question_package_version: Optional[int] = None
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
    infrastructure_type: str
    description: Optional[str]
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


# ── Auto-flagging logic ───────────────────────────────────────────────────────

async def run_auto_flagging(
    report: Report,
    reporter: Optional[Reporter],
    db: AsyncSession,
) -> str:
    """Run auto-flagging rules in order. Returns the assigned flag status.

    Rules (in order):
    1. Blocked device ID → Red
    2. Blocked IP address → Red
    3. Duplicate (same reporter + same building + within 24h) → Orange
    4. All checks pass → Green
    """

    # Rule 1 — Blocked reporter
    if reporter and reporter.is_blocked:
        return "red"

    # Rule 2 — Duplicate detection
    if report.reporter_id and report.building_id:
        from datetime import timedelta
        window_start = datetime.now(timezone.utc) - timedelta(hours=24)
        result = await db.execute(
            select(func.count(Report.id)).where(
                Report.reporter_id == report.reporter_id,
                Report.building_id == report.building_id,
                Report.created_at >= window_start,
                Report.id != report.id,
                Report.flag_status.in_(["green", "orange"]),
            )
        )
        duplicate_count = result.scalar()
        if duplicate_count and duplicate_count > 0:
            return "orange"

    # Rule 3 — All checks pass
    return "green"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", response_model=ReportSubmitResponse)
async def submit_report(
    request: ReportSubmitRequest,
    http_request: Request,
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

    # Validate crisis exists and is active
    result = await db.execute(
        select(Crisis).where(
            Crisis.id == request.crisis_id,
            Crisis.is_active == True,
        )
    )
    crisis = result.scalar_one_or_none()
    if not crisis:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Crisis not found or no longer active",
        )

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
        crisis_id=request.crisis_id,
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
        infrastructure_type=request.infrastructure_type,
        description=request.description,
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
    await db.flush()  # Get report ID without committing

    # Run auto-flagging synchronously for now
    # (will be moved to ARQ worker in next stage)
    new_flag = await run_auto_flagging(report, reporter, db)

    # Record initial flag event
    flag_event = FlagEvent(
        report_id=report.id,
        flag_from=None,
        flag_to="grey",
        changed_by="auto",
        reason="Report received",
    )
    db.add(flag_event)

    # Record auto-flagging result if different from grey
    if new_flag != "grey":
        report.flag_status = new_flag
        flag_event2 = FlagEvent(
            report_id=report.id,
            flag_from="grey",
            flag_to=new_flag,
            changed_by="auto",
            reason="Auto-flagging rules applied",
        )
        db.add(flag_event2)

    # Update reporter activity
    if reporter:
        reporter.report_count = (reporter.report_count or 0) + 1
        reporter.last_active_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(report)

    # Publish SSE event to connected dashboard clients
    from app.routers.dashboard_sse import publish_event
    await publish_event(
        crisis_id=str(report.crisis_id),
        event_type="report_confirmed",
        data={
            "report_id": str(report.id),
            "flag_status": report.flag_status,
            "damage_level": report.damage_level,
            "latitude": report.gps_latitude,
            "longitude": report.gps_longitude,
            "platform": report.platform,
        },
    )

    return ReportSubmitResponse(
        report_id=str(report.id),
        flag_status=report.flag_status,
        message="Report received successfully",
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
        description=report.description,
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