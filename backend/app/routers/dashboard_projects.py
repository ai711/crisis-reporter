"""Dashboard project management endpoints.

All routes require dashboard authentication unless noted.
Public URL prefix: /api/dashboard/projects
"""

import asyncio
import uuid
import logging
from datetime import datetime, date, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text, and_, or_, delete
from sqlalchemy.orm import joinedload
from pydantic import BaseModel, validator

from app.database import get_db
from app.models.crisis import Crisis, format_serial_id
from app.models.report_project import ReportProject
from app.models.project_user import ProjectUser
from app.models.report import Report
from app.models.reporter import Reporter
from app.models.property import Property
from app.models.dashboard_user import DashboardUser
from app.models.country import Country
from app.services.dependencies import get_current_dashboard_user, require_section_access, require_superadmin

log = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard/projects", tags=["Dashboard Projects"])


# ── Schemas ────────────────────────────────────────────────────────────────────

def _validate_country_codes(raw_list: list[str]) -> list[str]:
    """Normalise and format-check country codes.  DB existence is verified in the endpoint."""
    if not raw_list:
        raise ValueError("At least one country must be selected.")
    normalized = []
    for raw in raw_list:
        code = raw.strip().upper()
        if len(code) != 2 or not code.isalpha():
            raise ValueError(
                f"'{raw}' is not a valid ISO 3166-1 alpha-2 country code. "
                f"Send the 2-letter code (e.g. 'KE' for Kenya, 'IN' for India), "
                f"not the full country name."
            )
        normalized.append(code)
    return normalized


class ProjectCreate(BaseModel):
    name: str
    countries: list[str]
    start_date: date
    end_date: date
    description: Optional[str] = None
    map_center_lat: Optional[float] = None
    map_center_lng: Optional[float] = None

    @validator("name")
    def name_not_empty(cls, v):
        if not v.strip():
            raise ValueError("Project name is required.")
        return v.strip()

    @validator("countries")
    def countries_valid(cls, v):
        return _validate_country_codes(v)

    @validator("start_date")
    def start_not_future(cls, v):
        if v > date.today():
            raise ValueError("Start date cannot be in the future.")
        return v

    @validator("end_date")
    def end_after_start(cls, v, values):
        if "start_date" in values and v < values["start_date"]:
            raise ValueError("End date cannot be before start date.")
        return v


class CountryReconfigRequest(BaseModel):
    countries: list[str]

    @validator("countries")
    def countries_valid(cls, v):
        return _validate_country_codes(v)


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    end_date: Optional[date] = None
    status: Optional[str] = None
    map_center_lat: Optional[float] = None
    map_center_lng: Optional[float] = None


class AddUserRequest(BaseModel):
    dashboard_user_id: str
    access_level: str = "view_and_edit"

    @validator("access_level")
    def valid_access(cls, v):
        if v not in ("view_only", "view_and_edit"):
            raise ValueError("access_level must be 'view_only' or 'view_and_edit'.")
        return v


class UpdateUserAccessRequest(BaseModel):
    access_level: str

    @validator("access_level")
    def valid_access(cls, v):
        if v not in ("view_only", "view_and_edit"):
            raise ValueError("access_level must be 'view_only' or 'view_and_edit'.")
        return v


# ── Response helpers ──────────────────────────────────────────────────────────

def _project_row(c: Crisis, total_reports: int, created_by_name: str | None) -> dict:
    return {
        "id": str(c.id),
        "serial_id": c.serial_id,
        "name": c.name,
        "description": c.description,
        "countries": c.countries or [],
        "start_date": c.start_date.isoformat() if c.start_date else None,
        "end_date": c.end_date.isoformat() if c.end_date else None,
        "status": c.status,
        "total_reports": total_reports,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "created_by_user_id": str(c.created_by_user_id) if c.created_by_user_id else None,
        "created_by_name": created_by_name,
        "import_status": c.import_status,
        "import_progress": c.import_progress,
        "import_total": c.import_total,
        "map_center_lat": c.map_center_lat,
        "map_center_lng": c.map_center_lng,
    }


async def _resolve_serial(serial_id: str, db: AsyncSession) -> Crisis:
    result = await db.execute(
        select(Crisis).where(Crisis.serial_id == serial_id)
    )
    crisis = result.scalar_one_or_none()
    if not crisis:
        raise HTTPException(status_code=404, detail=f"Project {serial_id} not found.")
    return crisis


# ── GET /api/dashboard/projects ───────────────────────────────────────────────

@router.get("")
async def list_projects(
    status_filter: Optional[str] = Query(None, alias="status"),
    country: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    created_by: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=50, le=200),
    assigned_to_user: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("projects")),
):
    """List projects with cursor-based pagination and all filters."""
    conditions = []

    # Default: active and closed; caller can override
    statuses = ["active", "closed"]
    if status_filter:
        statuses = [s.strip() for s in status_filter.split(",") if s.strip()]
    conditions.append(Crisis.status.in_(statuses))

    # Country filter — project must have this country in its countries array
    if country:
        country_list = [c.strip() for c in country.split(",") if c.strip()]
        if country_list:
            conditions.append(Crisis.countries.overlap(country_list))

    # Date range overlap filter
    if date_from:
        try:
            df = date.fromisoformat(date_from)
            conditions.append(Crisis.end_date >= df)
        except ValueError:
            pass
    if date_to:
        try:
            dt = date.fromisoformat(date_to)
            conditions.append(Crisis.start_date <= dt)
        except ValueError:
            pass

    # Created by filter
    if created_by:
        try:
            conditions.append(Crisis.created_by_user_id == uuid.UUID(created_by))
        except ValueError:
            pass

    # Search — name, serial_id, or any country in the countries array (case-insensitive)
    if search:
        s = f"%{search}%"
        conditions.append(
            or_(
                Crisis.name.ilike(s),
                Crisis.serial_id.ilike(s),
                func.array_to_string(Crisis.countries, ",").ilike(s),
            )
        )

    # Cursor pagination (by created_at descending)
    if cursor:
        try:
            cursor_ts, cursor_uuid = cursor.split("_", 1)
            cursor_dt = datetime.fromisoformat(cursor_ts)
            conditions.append(Crisis.created_at < cursor_dt)
        except Exception:
            pass

    crises_q = (
        select(Crisis)
        .where(and_(*conditions) if conditions else True)
        .order_by(Crisis.created_at.desc())
        .limit(limit + 1)
    )

    if assigned_to_user:
        try:
            _assigned_uuid = uuid.UUID(assigned_to_user)
            crises_q = (
                select(Crisis)
                .join(
                    ProjectUser,
                    and_(
                        ProjectUser.crisis_id == Crisis.id,
                        ProjectUser.dashboard_user_id == _assigned_uuid,
                    ),
                )
                .where(and_(*conditions) if conditions else True)
                .order_by(Crisis.created_at.desc())
                .limit(limit + 1)
            )
        except ValueError:
            pass
    result = await db.execute(crises_q)
    crises = result.scalars().all()

    has_more = len(crises) > limit
    if has_more:
        crises = list(crises[:limit])

    # Bulk-fetch report counts
    if crises:
        crisis_ids = [c.id for c in crises]
        counts_q = (
            select(ReportProject.crisis_id, func.count(ReportProject.report_id))
            .where(ReportProject.crisis_id.in_(crisis_ids))
            .group_by(ReportProject.crisis_id)
        )
        counts_res = await db.execute(counts_q)
        counts_map = {row[0]: row[1] for row in counts_res.all()}
    else:
        counts_map = {}

    # Bulk-fetch creator names
    creator_ids = list({c.created_by_user_id for c in crises if c.created_by_user_id})
    creator_name_map: dict[uuid.UUID, str] = {}
    if creator_ids:
        u_res = await db.execute(
            select(DashboardUser.id, DashboardUser.full_name)
            .where(DashboardUser.id.in_(creator_ids))
        )
        creator_name_map = {row[0]: row[1] for row in u_res.all()}

    items = [
        _project_row(
            c,
            counts_map.get(c.id, 0),
            creator_name_map.get(c.created_by_user_id) if c.created_by_user_id else None,
        )
        for c in crises
    ]

    next_cursor = None
    if has_more and crises:
        last = crises[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    # Total count
    count_q = select(func.count(Crisis.id)).where(
        and_(*conditions) if conditions else True
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── POST /api/dashboard/projects ─────────────────────────────────────────────

@router.post("", status_code=201)
async def create_project(
    body: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("projects", require_edit=True)),
):
    # Name uniqueness check
    existing = await db.execute(
        select(Crisis).where(Crisis.name == body.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="A project with this name already exists.",
        )

    # Verify country codes exist in the countries table (catches typos like "KY" instead of "KE")
    valid_result = await db.execute(
        select(Country.code).where(Country.code.in_(body.countries))
    )
    valid_codes = {row[0] for row in valid_result.fetchall()}
    unknown = [c for c in body.countries if c not in valid_codes]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown country code(s): {', '.join(unknown)}. "
                f"Use a valid ISO 3166-1 alpha-2 code from the countries list "
                f"(e.g. 'KE' for Kenya, 'IN' for India)."
            ),
        )

    # Allocate serial number
    serial_num_res = await db.execute(text("SELECT nextval('crisis_serial_seq')"))
    serial_num = serial_num_res.scalar()
    serial_id = format_serial_id(serial_num)

    crisis = Crisis(
        serial_number=serial_num,
        serial_id=serial_id,
        name=body.name,
        description=body.description,
        countries=body.countries,
        country_code=body.countries[0] if body.countries else None,
        start_date=body.start_date,
        end_date=body.end_date,
        status="active",
        is_active=True,
        map_center_lat=body.map_center_lat,
        map_center_lng=body.map_center_lng,
        created_by_user_id=current_user.id,
        import_status="pending",
        import_progress=0,
        import_total=0,
    )
    db.add(crisis)
    await db.flush()

    # Auto-assign creator to project
    db.add(ProjectUser(
        crisis_id=crisis.id,
        dashboard_user_id=current_user.id,
        access_level="view_and_edit",
        is_creator=True,
    ))

    await db.commit()
    await db.refresh(crisis)

    # Launch background import (fire-and-forget)
    asyncio.create_task(
        _run_import(serial_id, crisis.id, body.countries, body.start_date, body.end_date)
    )

    return _project_row(crisis, 0, current_user.full_name)


async def _run_import(serial_id, crisis_uuid, countries, start_date, end_date):
    from app.services.project_import_service import import_reports_for_project
    try:
        await import_reports_for_project(serial_id, crisis_uuid, countries, start_date, end_date)
    except Exception as exc:
        log.exception("_run_import: failed for %s: %s", serial_id, exc)


# ── GET /api/dashboard/projects/{serial_id} ──────────────────────────────────

@router.get("/{serial_id}")
async def get_project(
    serial_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("projects")),
):
    """Full project detail including creator info and import status."""
    crisis = await _resolve_serial(serial_id, db)

    total_reports = (
        await db.execute(
            select(func.count(ReportProject.report_id))
            .where(ReportProject.crisis_id == crisis.id)
        )
    ).scalar() or 0

    total_properties = (
        await db.execute(
            select(func.count(func.distinct(Report.property_id)))
            .join(ReportProject, ReportProject.report_id == Report.id)
            .where(
                ReportProject.crisis_id == crisis.id,
                Report.property_id.isnot(None),
            )
        )
    ).scalar() or 0

    created_by_name = None
    created_by_email = None
    if crisis.created_by_user_id:
        u = await db.get(DashboardUser, crisis.created_by_user_id)
        if u:
            created_by_name = u.full_name
            created_by_email = u.email

    row = _project_row(crisis, total_reports, created_by_name)
    row["created_by_email"] = created_by_email
    row["total_properties"] = total_properties
    return row


# ── PATCH /api/dashboard/projects/{serial_id} ────────────────────────────────

@router.patch("/{serial_id}")
async def update_project(
    serial_id: str,
    request: Request,
    body: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("projects", require_edit=True)),
):
    """Update a project. Countries and start_date are immutable after creation."""
    # Guard: check raw JSON body before Pydantic strips unknown/immutable fields.
    raw_body = await request.json()
    if "countries" in raw_body or "start_date" in raw_body:
        raise HTTPException(
            status_code=400,
            detail="Country selection and start date cannot be changed after project creation.",
        )

    crisis = await _resolve_serial(serial_id, db)
    today = date.today()

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Project name cannot be empty.")
        dup = await db.execute(
            select(Crisis).where(Crisis.name == name, Crisis.id != crisis.id)
        )
        if dup.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="A project with this name already exists.")
        crisis.name = name

    if body.end_date is not None:
        if crisis.end_date and today > crisis.end_date:
            raise HTTPException(
                status_code=400,
                detail="End date has passed and cannot be extended.",
            )
        if crisis.start_date and body.end_date < crisis.start_date:
            raise HTTPException(
                status_code=422,
                detail="End date cannot be before start date.",
            )
        crisis.end_date = body.end_date

    if body.description is not None:
        crisis.description = body.description

    if body.status is not None:
        if body.status not in ("active", "closed", "archived"):
            raise HTTPException(
                status_code=422,
                detail="status must be one of: active, closed, archived.",
            )
        crisis.status = body.status
        crisis.is_active = body.status == "active"

    if body.map_center_lat is not None:
        crisis.map_center_lat = body.map_center_lat
    if body.map_center_lng is not None:
        crisis.map_center_lng = body.map_center_lng

    await db.commit()
    await db.refresh(crisis)

    total_reports = (
        await db.execute(
            select(func.count(ReportProject.report_id))
            .where(ReportProject.crisis_id == crisis.id)
        )
    ).scalar() or 0

    created_by_name = None
    if crisis.created_by_user_id:
        u = await db.get(DashboardUser, crisis.created_by_user_id)
        if u:
            created_by_name = u.full_name

    return _project_row(crisis, total_reports, created_by_name)


# ── POST /api/dashboard/projects/{serial_id}/reconfigure-countries (superadmin) ─

@router.post("/{serial_id}/reconfigure-countries", status_code=200)
async def reconfigure_countries(
    serial_id: str,
    body: CountryReconfigRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    """Superadmin only: correct a project's countries array and re-run the import.

    Removes all automatically-linked report_projects rows (linked_by auto/realtime)
    and re-imports from scratch using the corrected countries list.
    Manually-linked reports are preserved.
    """
    crisis = await _resolve_serial(serial_id, db)

    # Validate codes exist in the countries table
    valid_result = await db.execute(
        select(Country.code).where(Country.code.in_(body.countries))
    )
    valid_codes = {row[0] for row in valid_result.fetchall()}
    unknown = [c for c in body.countries if c not in valid_codes]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown country code(s): {', '.join(unknown)}. "
                f"Use a valid ISO 3166-1 alpha-2 code from the countries list."
            ),
        )

    old_countries = crisis.countries or []

    # Remove all automatically-linked reports — preserve manually-linked ones
    await db.execute(
        delete(ReportProject).where(
            ReportProject.crisis_id == crisis.id,
            ReportProject.linked_by.in_(["auto", "realtime"]),
        )
    )

    # Update project metadata
    crisis.countries = body.countries
    crisis.country_code = body.countries[0] if body.countries else None
    crisis.import_status = "pending"
    crisis.import_progress = 0
    crisis.import_total = 0
    await db.commit()

    log.info(
        "reconfigure_countries: %s updated by superadmin %s — %s → %s, re-importing",
        serial_id, current_user.email, old_countries, body.countries,
    )

    # Re-trigger import with corrected countries
    asyncio.create_task(
        _run_import(serial_id, crisis.id, body.countries, crisis.start_date, crisis.end_date)
    )

    return {
        "message": (
            f"Countries updated from {old_countries} to {body.countries}. "
            f"Re-import started — check import status for progress."
        ),
        "serial_id": serial_id,
        "countries": body.countries,
    }


# ── GET /api/dashboard/projects/{serial_id}/reports ──────────────────────────

@router.get("/{serial_id}/reports")
async def list_project_reports(
    serial_id: str,
    flag_status: Optional[str] = Query(None),
    damage_level: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Reports linked to this project via report_projects."""
    crisis = await _resolve_serial(serial_id, db)

    conditions = [ReportProject.crisis_id == crisis.id]

    if flag_status:
        # Frontend may send a comma-joined list e.g. "green,orange"
        flag_values = [f.strip() for f in flag_status.split(",") if f.strip()]
        if len(flag_values) == 1:
            conditions.append(Report.flag_status == flag_values[0])
        elif flag_values:
            conditions.append(Report.flag_status.in_(flag_values))
    if damage_level:
        conditions.append(Report.damage_level == damage_level)
    if cursor:
        try:
            cursor_ts, _ = cursor.split("_", 1)
            cursor_dt = datetime.fromisoformat(cursor_ts)
            conditions.append(Report.created_at < cursor_dt)
        except Exception:
            pass

    q = (
        select(Report)
        .join(ReportProject, ReportProject.report_id == Report.id)
        .options(joinedload(Report.reporter))
        .where(and_(*conditions))
        .order_by(Report.created_at.desc())
        .limit(limit + 1)
    )

    if country:
        q = q.join(Reporter, Report.reporter_id == Reporter.id, isouter=True).where(
            Reporter.country_code == country
        )

    result = await db.execute(q)
    reports = result.scalars().unique().all()

    has_more = len(reports) > limit
    if has_more:
        reports = list(reports[:limit])

    from app.models.photo import Photo

    items = []
    for r in reports:
        photo_count = (
            await db.execute(
                select(func.count(Photo.id)).where(Photo.report_id == r.id)
            )
        ).scalar() or 0
        reporter = r.reporter
        # infrastructure_types: prefer the ARRAY column; fall back to wrapping
        # the legacy singular field so the frontend array join always works.
        infra_types = r.infrastructure_types
        if not infra_types and r.infrastructure_type:
            infra_types = [r.infrastructure_type]
        items.append({
            "report_id": str(r.id),
            "serial_number": r.serial_number,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "country": reporter.country_code if reporter else None,
            "damage_level": r.damage_level,
            "infrastructure_types": infra_types or [],
            "crisis_type": r.disaster_type,
            "flag_status": r.flag_status,
        })

    next_cursor = None
    if has_more and reports:
        last = reports[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    count_q = (
        select(func.count(Report.id))
        .join(ReportProject, ReportProject.report_id == Report.id)
        .where(and_(*conditions))
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── GET /api/dashboard/projects/{serial_id}/properties ───────────────────────

@router.get("/{serial_id}/properties")
async def list_project_properties(
    serial_id: str,
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Properties with at least one qualifying report linked to this project."""
    crisis = await _resolve_serial(serial_id, db)

    # Distinct property IDs from linked reports
    pid_q = (
        select(func.distinct(Report.property_id))
        .join(ReportProject, ReportProject.report_id == Report.id)
        .where(
            ReportProject.crisis_id == crisis.id,
            Report.property_id.isnot(None),
            Report.flag_status.in_(["green", "orange"]),
        )
    )
    pid_res = await db.execute(pid_q)
    property_ids = [row[0] for row in pid_res.all()]

    if not property_ids:
        return {"items": [], "total": 0, "cursor": None, "has_more": False}

    conditions = [Property.id.in_(property_ids)]
    if cursor:
        conditions.append(Property.id > cursor)

    props_q = (
        select(Property)
        .where(and_(*conditions))
        .order_by(Property.id.asc())
        .limit(limit + 1)
    )
    props_res = await db.execute(props_q)
    props = props_res.scalars().all()

    has_more = len(props) > limit
    if has_more:
        props = list(props[:limit])

    # Report counts + most recent report timestamp per property (scoped to this project)
    if props:
        proj_prop_ids = [p.id for p in props]
        rc_q = (
            select(
                Report.property_id,
                func.count(Report.id),
                func.max(Report.created_at),
            )
            .join(ReportProject, ReportProject.report_id == Report.id)
            .where(
                ReportProject.crisis_id == crisis.id,
                Report.property_id.in_(proj_prop_ids),
                Report.flag_status.in_(["green", "orange"]),
            )
            .group_by(Report.property_id)
        )
        rc_res = await db.execute(rc_q)
        rc_map: dict = {}
        recent_map: dict = {}
        for row in rc_res.all():
            rc_map[row[0]] = row[1]
            recent_map[row[0]] = row[2]
    else:
        rc_map = {}
        recent_map = {}

    items = []
    for p in props:
        most_recent = recent_map.get(p.id)
        items.append({
            "property_id": p.id,
            "building_id": p.building_id,
            "display_name": p.override_name or p.building_id or p.id,
            "address": p.address if hasattr(p, "address") else None,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "current_damage_level": p.current_damage_level if hasattr(p, "current_damage_level") else None,
            "confirmed_status": p.confirmed_status,
            "has_conflict_warning": p.has_conflict_warning,
            "total_reports": rc_map.get(p.id, 0),
            "most_recent_report_at": most_recent.isoformat() if most_recent else None,
            "is_recovered": p.is_recovered,
            "property_status": "Recovered" if p.is_recovered else "Active",
            "is_flagged_for_review": p.is_flagged_for_review if hasattr(p, "is_flagged_for_review") else False,
        })

    next_cursor = props[-1].id if has_more and props else None
    return {"items": items, "total": len(property_ids), "cursor": next_cursor, "has_more": has_more}


# ── GET /api/dashboard/projects/{serial_id}/stats ────────────────────────────

@router.get("/{serial_id}/stats")
async def get_project_stats(
    serial_id: str,
    granularity: str = Query(default="daily"),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Analytics scoped to this project's linked Green/Orange reports."""
    crisis = await _resolve_serial(serial_id, db)

    def _stats_base(stmt):
        """Apply the project scope join and Green/Orange filter to a statement."""
        return (
            stmt
            .join(ReportProject, ReportProject.report_id == Report.id)
            .where(
                ReportProject.crisis_id == crisis.id,
                Report.flag_status.in_(["green", "orange"]),
            )
        )

    # Total
    total = (
        await db.execute(_stats_base(select(func.count(Report.id))))
    ).scalar() or 0

    # Damage distribution
    dmg_res = await db.execute(
        _stats_base(
            select(Report.damage_level, func.count(Report.id))
            .group_by(Report.damage_level)
        )
    )
    damage_distribution = {row[0]: row[1] for row in dmg_res.all()}

    # Reports over time
    if granularity == "weekly":
        trunc_expr = func.date_trunc("week", Report.created_at)
    else:
        trunc_expr = func.date_trunc("day", Report.created_at)

    time_res = await db.execute(
        _stats_base(
            select(trunc_expr.label("period"), func.count(Report.id).label("count"))
            .group_by(text("period"))
            .order_by(text("period"))
        )
    )
    reports_over_time = [
        {"period": row[0].isoformat() if row[0] else None, "count": row[1]}
        for row in time_res.all()
    ]

    # Country breakdown (via reporter)
    country_res = await db.execute(
        select(Reporter.country_code, func.count(Report.id))
        .join(ReportProject, ReportProject.report_id == Report.id)
        .join(Reporter, Report.reporter_id == Reporter.id, isouter=True)
        .where(
            ReportProject.crisis_id == crisis.id,
            Report.flag_status.in_(["green", "orange"]),
        )
        .group_by(Reporter.country_code)
        .order_by(func.count(Report.id).desc())
    )
    country_breakdown = [
        {"country": row[0], "count": row[1]}
        for row in country_res.all()
    ]

    # Infrastructure breakdown
    infra_res = await db.execute(
        _stats_base(
            select(Report.infrastructure_type, func.count(Report.id))
            .group_by(Report.infrastructure_type)
            .order_by(func.count(Report.id).desc())
        )
    )
    infrastructure_breakdown = [
        {"type": row[0], "count": row[1]}
        for row in infra_res.all()
    ]

    # Crisis type breakdown
    crisis_res = await db.execute(
        _stats_base(
            select(Report.disaster_type, func.count(Report.id))
            .group_by(Report.disaster_type)
            .order_by(func.count(Report.id).desc())
        )
    )
    crisis_type_breakdown = [
        {"type": row[0], "count": row[1]}
        for row in crisis_res.all()
    ]

    # Map damage_level DB values (minimal/partial/complete) to frontend keys
    completely_damaged = damage_distribution.get("complete", 0)
    partially_damaged = damage_distribution.get("partial", 0)
    minimal_damage = damage_distribution.get("minimal", 0)

    return {
        "summary": {
            "total_reports": total,
            "completely_damaged": completely_damaged,
            "partially_damaged": partially_damaged,
            "minimal_damage": minimal_damage,
        },
        "damage_distribution": {
            "completely_damaged": completely_damaged,
            "partially_damaged": partially_damaged,
            "minimal_damage": minimal_damage,
        },
        # Rename "period" → "date" so the XAxis dataKey="date" binding works
        "time_series": [
            {"date": row["period"], "count": row["count"]}
            for row in reports_over_time
        ],
        # Rename "type" → "infrastructure_type" for YAxis dataKey binding
        "infrastructure_breakdown": [
            {"infrastructure_type": row["type"], "count": row["count"]}
            for row in infrastructure_breakdown
        ],
        # Rename "type" → "crisis_type" for YAxis dataKey binding
        "crisis_type_breakdown": [
            {"crisis_type": row["type"], "count": row["count"]}
            for row in crisis_type_breakdown
        ],
        "country_breakdown": country_breakdown,
    }


# ── GET /api/dashboard/projects/{serial_id}/users ────────────────────────────

@router.get("/{serial_id}/users")
async def list_project_users(
    serial_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """All users assigned to this project."""
    crisis = await _resolve_serial(serial_id, db)

    result = await db.execute(
        select(ProjectUser)
        .options(joinedload(ProjectUser.dashboard_user))
        .where(ProjectUser.crisis_id == crisis.id)
        .order_by(ProjectUser.is_creator.desc(), ProjectUser.assigned_at.asc())
    )
    pu_list = result.scalars().unique().all()

    return [
        {
            "dashboard_user_id": str(pu.dashboard_user_id),
            "full_name": pu.dashboard_user.full_name if pu.dashboard_user else None,
            "email": pu.dashboard_user.email if pu.dashboard_user else None,
            "role": pu.dashboard_user.role if pu.dashboard_user else None,
            "access_level": pu.access_level,
            "is_creator": pu.is_creator,
            "assigned_at": pu.assigned_at.isoformat() if pu.assigned_at else None,
        }
        for pu in pu_list
    ]


# ── POST /api/dashboard/projects/{serial_id}/users ───────────────────────────

@router.post("/{serial_id}/users", status_code=201)
async def add_project_user(
    serial_id: str,
    body: AddUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Add a dashboard user to this project."""
    crisis = await _resolve_serial(serial_id, db)

    try:
        user_uuid = uuid.UUID(body.dashboard_user_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid dashboard_user_id.")

    user = await db.get(DashboardUser, user_uuid)
    if not user:
        raise HTTPException(status_code=404, detail="Dashboard user not found.")

    existing = await db.execute(
        select(ProjectUser).where(
            ProjectUser.crisis_id == crisis.id,
            ProjectUser.dashboard_user_id == user_uuid,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="User is already assigned to this project.")

    db.add(ProjectUser(
        crisis_id=crisis.id,
        dashboard_user_id=user_uuid,
        access_level=body.access_level,
        is_creator=False,
    ))
    await db.commit()

    return await list_project_users(serial_id, db, current_user)


# ── PATCH /api/dashboard/projects/{serial_id}/users/{user_id} ────────────────

@router.patch("/{serial_id}/users/{user_id}")
async def update_project_user(
    serial_id: str,
    user_id: str,
    body: UpdateUserAccessRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Update a user's access level. Cannot change the creator's access level."""
    crisis = await _resolve_serial(serial_id, db)

    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid user_id.")

    result = await db.execute(
        select(ProjectUser).where(
            ProjectUser.crisis_id == crisis.id,
            ProjectUser.dashboard_user_id == user_uuid,
        )
    )
    pu = result.scalar_one_or_none()
    if not pu:
        raise HTTPException(status_code=404, detail="User not assigned to this project.")
    if pu.is_creator:
        raise HTTPException(status_code=400, detail="Cannot change the creator's access level.")

    pu.access_level = body.access_level
    await db.commit()

    return await list_project_users(serial_id, db, current_user)


# ── DELETE /api/dashboard/projects/{serial_id}/users/{user_id} ───────────────

@router.delete("/{serial_id}/users/{user_id}")
async def remove_project_user(
    serial_id: str,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Remove a user from a project. Cannot remove the creator."""
    crisis = await _resolve_serial(serial_id, db)

    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid user_id.")

    result = await db.execute(
        select(ProjectUser).where(
            ProjectUser.crisis_id == crisis.id,
            ProjectUser.dashboard_user_id == user_uuid,
        )
    )
    pu = result.scalar_one_or_none()
    if not pu:
        raise HTTPException(status_code=404, detail="User not assigned to this project.")
    if pu.is_creator:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove the project creator from the project.",
        )

    await db.delete(pu)
    await db.commit()

    return await list_project_users(serial_id, db, current_user)


# ── GET /api/dashboard/projects/{serial_id}/import-status ────────────────────

@router.get("/{serial_id}/import-status")
async def get_import_status(
    serial_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Poll import progress without reloading the full project."""
    crisis = await _resolve_serial(serial_id, db)
    return {
        "import_status": crisis.import_status,
        "import_progress": crisis.import_progress,
        "import_total": crisis.import_total,
    }
