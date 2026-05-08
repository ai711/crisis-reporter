"""
exports.py — Real CSV and GeoJSON export file generation with RAPIDA field mapping.

RAPIDA field name mapping applied at export time:
  internal damage_level       → RAPIDA damage_classification
  internal gps_latitude       → RAPIDA latitude_decimal
  internal gps_longitude      → RAPIDA longitude_decimal
  internal created_at         → RAPIDA timestamp
  internal infrastructure_name → RAPIDA infrastructure_type
"""

import csv
import json
import pathlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal
from app.models.crisis import Crisis
from app.models.dashboard_user import DashboardUser
from app.models.flag_event import FlagEvent  # noqa: F401 — ensures relationship is loaded
from app.models.report import Report
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/exports", tags=["Exports"])

# ── Storage ───────────────────────────────────────────────────────────────────

EXPORT_DIR = pathlib.Path("/tmp/exports")
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

# ── In-memory job store ───────────────────────────────────────────────────────
# Sufficient for prototype — survives process lifetime

_jobs: dict[str, dict] = {}

# ── Constants ─────────────────────────────────────────────────────────────────

VALID_REPORT_TYPES = {
    "standard_damage",
    "full_data",
    "reporter_activity",
    "flagged_reports",
    "project_summary",
}

VALID_FORMATS = {"csv", "json", "geojson"}

_CONTENT_TYPE: dict[str, str] = {
    "csv": "text/csv",
    "json": "application/json",
    "geojson": "application/geo+json",
}

_FILE_EXT: dict[str, str] = {
    "csv": "csv",
    "json": "json",
    "geojson": "geojson",
}

# ── Schemas ───────────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    report_type: str
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    country_filter: Optional[str] = None
    format: str = "csv"


class GenerateResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    status: str
    download_url: Optional[str] = None
    error: Optional[str] = None


class ExportHistoryItem(BaseModel):
    job_id: str
    report_type: str
    format: str
    country_filter: Optional[str]
    date_from: Optional[str]
    date_to: Optional[str]
    status: str
    download_url: Optional[str]
    created_at: datetime
    created_by: str


# ── Shared utilities ──────────────────────────────────────────────────────────


def _parse_date(s: str | None) -> datetime | None:
    """Accept YYYY-MM-DD or full ISO-8601 strings; return None when blank."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _fmt_dt(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


def _fmt(v: object) -> str:
    return "" if v is None else str(v)


def _write_csv(
    file_path: pathlib.Path,
    headers: list[str],
    rows: list[list[str]],
) -> None:
    """Write a UTF-8 CSV with a header row followed by data rows."""
    with open(file_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        writer.writerows(rows)


# ── Standard Damage Report (CSV) ──────────────────────────────────────────────

_STANDARD_DAMAGE_HEADERS = [
    "timestamp",            # RAPIDA: created_at
    "latitude_decimal",     # RAPIDA: gps_latitude
    "longitude_decimal",    # RAPIDA: gps_longitude
    "damage_classification",# RAPIDA: damage_level
    "infrastructure_type",  # RAPIDA: infrastructure_name
    "disaster_type",
    "debris_blocking",
    "reporter_id",
]


async def _gen_standard_damage_csv(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report)
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        # Default inclusion: green and orange flags only
        stmt = stmt.where(Report.flag_status.in_(["green", "orange"]))
        stmt = stmt.order_by(Report.created_at)

        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = [
        [
            _fmt_dt(r.created_at),
            _fmt(r.gps_latitude),
            _fmt(r.gps_longitude),
            r.damage_level,
            _fmt(r.infrastructure_name),
            _fmt(r.disaster_type),
            _fmt(r.debris_blocking),
            _fmt(r.reporter_id),
        ]
        for r in reports
    ]
    _write_csv(file_path, _STANDARD_DAMAGE_HEADERS, rows)


# ── Standard Damage Report (GeoJSON) ─────────────────────────────────────────


async def _gen_standard_damage_geojson(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report)
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        stmt = stmt.where(Report.flag_status.in_(["green", "orange"]))
        # Only reports that have valid coordinates make sense in GeoJSON
        stmt = stmt.where(Report.gps_latitude.isnot(None))
        stmt = stmt.where(Report.gps_longitude.isnot(None))
        stmt = stmt.order_by(Report.created_at)

        result = await session.execute(stmt)
        reports = result.scalars().all()

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                # GeoJSON spec: [longitude, latitude]
                "coordinates": [r.gps_longitude, r.gps_latitude],
            },
            "properties": {
                "damage_classification": r.damage_level,
                "infrastructure_type": r.infrastructure_name,
                "timestamp": _fmt_dt(r.created_at),
                "disaster_type": r.disaster_type,
                "reporter_id": str(r.reporter_id) if r.reporter_id else None,
            },
        }
        for r in reports
    ]

    feature_collection = {"type": "FeatureCollection", "features": features}
    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump(feature_collection, fh, ensure_ascii=False, indent=2)


# ── Full Data Report (CSV) ────────────────────────────────────────────────────

_FULL_DATA_HEADERS = [
    "id",
    "timestamp",             # RAPIDA: created_at
    "latitude_decimal",      # RAPIDA: gps_latitude
    "longitude_decimal",     # RAPIDA: gps_longitude
    "damage_classification", # RAPIDA: damage_level
    "infrastructure_type",   # RAPIDA: infrastructure_name
    "infrastructure_types",  # multi-select, semicolon-separated
    "infrastructure_other",
    "disaster_type",
    "debris_blocking",
    "flag_status",
    "platform",
    "language_code",
    "location_address",
    "location_landmark",
    "building_id",
    "reporter_id",
    "crisis_id",
    "was_queued",
    "description",
    "flag_history_count",
]


async def _gen_full_data_csv(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        # Full data: all flag statuses included
        stmt = stmt.order_by(Report.created_at)

        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = []
    for r in reports:
        infra_types = (
            ";".join(r.infrastructure_types) if r.infrastructure_types else ""
        )
        rows.append(
            [
                str(r.id),
                _fmt_dt(r.created_at),
                _fmt(r.gps_latitude),
                _fmt(r.gps_longitude),
                r.damage_level,
                _fmt(r.infrastructure_name),
                infra_types,
                _fmt(r.infrastructure_other),
                _fmt(r.disaster_type),
                _fmt(r.debris_blocking),
                r.flag_status,
                r.platform,
                r.language_code,
                _fmt(r.location_address),
                _fmt(r.location_landmark),
                _fmt(r.building_id),
                _fmt(r.reporter_id),
                str(r.crisis_id),
                str(r.was_queued),
                _fmt(r.description),
                str(len(r.flag_events)),
            ]
        )

    _write_csv(file_path, _FULL_DATA_HEADERS, rows)


# ── Full Data Report (JSON) ───────────────────────────────────────────────────


async def _gen_full_data_json(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        stmt = stmt.order_by(Report.created_at)

        result = await session.execute(stmt)
        reports = result.scalars().all()

    records = [
        {
            "id": str(r.id),
            "timestamp": _fmt_dt(r.created_at),
            "latitude_decimal": r.gps_latitude,
            "longitude_decimal": r.gps_longitude,
            "damage_classification": r.damage_level,
            "infrastructure_type": r.infrastructure_name,
            "infrastructure_types": r.infrastructure_types or [],
            "infrastructure_other": r.infrastructure_other,
            "disaster_type": r.disaster_type,
            "debris_blocking": r.debris_blocking,
            "flag_status": r.flag_status,
            "platform": r.platform,
            "language_code": r.language_code,
            "location_address": r.location_address,
            "location_landmark": r.location_landmark,
            "building_id": r.building_id,
            "reporter_id": str(r.reporter_id) if r.reporter_id else None,
            "crisis_id": str(r.crisis_id),
            "was_queued": r.was_queued,
            "description": r.description,
            "flag_history_count": len(r.flag_events),
        }
        for r in reports
    ]

    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, indent=2)


# ── Reporter Activity Report (CSV) ────────────────────────────────────────────

_REPORTER_ACTIVITY_HEADERS = [
    "reporter_id",
    "total_reports",
    "first_submission",
    "last_submission",
    "countries_reported",
]


async def _gen_reporter_activity_csv(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        # Aggregate counts, date range per reporter
        agg_stmt = (
            select(
                Report.reporter_id,
                func.count(Report.id).label("total_reports"),
                func.min(Report.created_at).label("first_submission"),
                func.max(Report.created_at).label("last_submission"),
            )
            .where(Report.reporter_id.isnot(None))
        )
        if country_filter:
            agg_stmt = agg_stmt.join(
                Crisis, Report.crisis_id == Crisis.id
            ).where(Crisis.country_code == country_filter)
        if date_from:
            agg_stmt = agg_stmt.where(Report.created_at >= date_from)
        if date_to:
            agg_stmt = agg_stmt.where(Report.created_at <= date_to)
        agg_stmt = agg_stmt.group_by(Report.reporter_id).order_by(
            func.count(Report.id).desc()
        )
        agg_result = await session.execute(agg_stmt)
        agg_rows = agg_result.all()

        reporter_ids = [row.reporter_id for row in agg_rows]

        # Collect distinct country codes per reporter from their report crises
        countries_by_reporter: dict[uuid.UUID, set[str]] = {
            rid: set() for rid in reporter_ids
        }
        if reporter_ids:
            country_stmt = (
                select(Report.reporter_id, Crisis.country_code)
                .join(Crisis, Report.crisis_id == Crisis.id)
                .where(Report.reporter_id.in_(reporter_ids))
                .distinct()
            )
            country_result = await session.execute(country_stmt)
            for reporter_id, country_code in country_result.all():
                if country_code:
                    countries_by_reporter[reporter_id].add(country_code)

    rows = [
        [
            str(row.reporter_id),
            str(row.total_reports),
            _fmt_dt(row.first_submission),
            _fmt_dt(row.last_submission),
            ";".join(sorted(countries_by_reporter.get(row.reporter_id, set()))),
        ]
        for row in agg_rows
    ]
    _write_csv(file_path, _REPORTER_ACTIVITY_HEADERS, rows)


# ── Flagged Reports Report (CSV) ──────────────────────────────────────────────

_FLAGGED_REPORTS_HEADERS = [
    "timestamp",
    "latitude_decimal",
    "longitude_decimal",
    "damage_classification",
    "infrastructure_type",
    "disaster_type",
    "debris_blocking",
    "reporter_id",
    "flag_status",
    "flag_reason",
]


async def _gen_flagged_reports_csv(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = (
            select(Report)
            .options(selectinload(Report.flag_events))
            .where(Report.flag_status.in_(["red", "orange"]))
        )
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        stmt = stmt.order_by(Report.created_at)

        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = []
    for r in reports:
        # Most recent flag event carries the authoritative reason
        flag_reason = ""
        if r.flag_events:
            latest = max(r.flag_events, key=lambda e: e.created_at)
            flag_reason = latest.reason or ""

        rows.append(
            [
                _fmt_dt(r.created_at),
                _fmt(r.gps_latitude),
                _fmt(r.gps_longitude),
                r.damage_level,
                _fmt(r.infrastructure_name),
                _fmt(r.disaster_type),
                _fmt(r.debris_blocking),
                _fmt(r.reporter_id),
                r.flag_status,
                flag_reason,
            ]
        )

    _write_csv(file_path, _FLAGGED_REPORTS_HEADERS, rows)


# ── Project Summary Report (CSV) ──────────────────────────────────────────────


async def _gen_project_summary_csv(
    file_path: pathlib.Path,
    date_from: datetime | None,
    date_to: datetime | None,
    country_filter: str | None,
) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(
            Report.flag_status,
            Report.damage_level,
            func.count(Report.id).label("count"),
        )
        if country_filter:
            stmt = stmt.join(Crisis, Report.crisis_id == Crisis.id).where(
                Crisis.country_code == country_filter
            )
        if date_from:
            stmt = stmt.where(Report.created_at >= date_from)
        if date_to:
            stmt = stmt.where(Report.created_at <= date_to)
        stmt = stmt.group_by(Report.flag_status, Report.damage_level)

        result = await session.execute(stmt)
        summary_rows = result.all()

    headers = ["flag_status", "damage_classification", "count"]
    rows = [
        [row.flag_status, row.damage_level, str(row.count)]
        for row in summary_rows
    ]
    _write_csv(file_path, headers, rows)


# ── Background generation task ────────────────────────────────────────────────


async def _generate_file(job_id: str) -> None:
    """
    Background task: generates the export file and updates the in-memory job
    record with status and file path.  Runs after the HTTP response is sent.
    """
    job = _jobs.get(job_id)
    if not job:
        return

    report_type: str = job["report_type"]
    fmt: str = job["format"]
    date_from = _parse_date(job["date_from"])
    date_to = _parse_date(job["date_to"])
    country_filter: str | None = job["country_filter"]

    ext = _FILE_EXT.get(fmt, "csv")
    file_path = EXPORT_DIR / f"{job_id}.{ext}"

    try:
        if report_type == "standard_damage" and fmt == "geojson":
            await _gen_standard_damage_geojson(
                file_path, date_from, date_to, country_filter
            )
        elif report_type == "standard_damage":
            await _gen_standard_damage_csv(
                file_path, date_from, date_to, country_filter
            )
        elif report_type == "full_data" and fmt == "json":
            await _gen_full_data_json(file_path, date_from, date_to, country_filter)
        elif report_type == "full_data":
            await _gen_full_data_csv(file_path, date_from, date_to, country_filter)
        elif report_type == "reporter_activity":
            await _gen_reporter_activity_csv(
                file_path, date_from, date_to, country_filter
            )
        elif report_type == "flagged_reports":
            await _gen_flagged_reports_csv(
                file_path, date_from, date_to, country_filter
            )
        else:
            # project_summary and any future types
            await _gen_project_summary_csv(
                file_path, date_from, date_to, country_filter
            )

        _jobs[job_id]["status"] = "complete"
        _jobs[job_id]["file_path"] = str(file_path)
        _jobs[job_id]["download_url"] = f"/api/exports/{job_id}/download"

    except Exception as exc:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["error"] = str(exc)


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post("/generate", response_model=GenerateResponse, status_code=status.HTTP_202_ACCEPTED)
async def generate_export(
    request: GenerateRequest,
    background_tasks: BackgroundTasks,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> GenerateResponse:
    """
    Create an export job.  Returns job_id immediately (202 Accepted).
    The file is generated in a background task; poll /{job_id}/status to
    check progress, then download via /{job_id}/download when complete.
    """
    if request.report_type not in VALID_REPORT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"report_type must be one of: {', '.join(sorted(VALID_REPORT_TYPES))}",
        )
    if request.format not in VALID_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"format must be one of: {', '.join(sorted(VALID_FORMATS))}",
        )

    job_id = str(uuid.uuid4())

    _jobs[job_id] = {
        "job_id": job_id,
        "report_type": request.report_type,
        "format": request.format,
        "country_filter": request.country_filter,
        "date_from": request.date_from,
        "date_to": request.date_to,
        "status": "pending",
        "file_path": None,
        "download_url": None,
        "error": None,
        "created_at": datetime.now(timezone.utc),
        "user_id": str(current_user.id),
        "created_by": current_user.email,
    }

    background_tasks.add_task(_generate_file, job_id)
    return GenerateResponse(job_id=job_id)


@router.get("/history", response_model=list[ExportHistoryItem])
async def get_export_history(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> list[ExportHistoryItem]:
    """Return the last 20 exports initiated by the authenticated user."""
    user_id = str(current_user.id)
    user_jobs = [j for j in _jobs.values() if j["user_id"] == user_id]
    user_jobs.sort(key=lambda j: j["created_at"], reverse=True)

    return [
        ExportHistoryItem(
            job_id=j["job_id"],
            report_type=j["report_type"],
            format=j["format"],
            country_filter=j["country_filter"],
            date_from=j["date_from"],
            date_to=j["date_to"],
            status=j["status"],
            download_url=j.get("download_url"),
            created_at=j["created_at"],
            created_by=j["created_by"],
        )
        for j in user_jobs[:20]
    ]


@router.get("/{job_id}/status", response_model=JobStatusResponse)
async def get_job_status(
    job_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> JobStatusResponse:
    """Poll export job status.  Returns pending → complete or failed."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export job not found",
        )
    if job["user_id"] != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    return JobStatusResponse(
        status=job["status"],
        download_url=job.get("download_url"),
        error=job.get("error"),
    )


@router.get("/{job_id}/download")
async def download_export(
    job_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> FileResponse:
    """
    Stream the generated export file to the browser.

    Sets Content-Type and Content-Disposition so the browser triggers a
    named file download rather than displaying the content inline.
    """
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export job not found",
        )
    if job["user_id"] != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    if job["status"] == "pending":
        raise HTTPException(
            status_code=status.HTTP_425_TOO_EARLY,
            detail="Export is still being generated — poll /status and retry",
        )
    if job["status"] == "failed":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export generation failed: {job.get('error', 'unknown error')}",
        )

    file_path_str: str | None = job.get("file_path")
    if not file_path_str:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export file path missing — regenerate this export",
        )

    file_path = pathlib.Path(file_path_str)
    if not file_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export file has been removed from disk — regenerate this export",
        )

    fmt: str = job["format"]
    ext = _FILE_EXT.get(fmt, "bin")
    content_type = _CONTENT_TYPE.get(fmt, "application/octet-stream")
    # Filename: crisis_reporter_export_<8-char-job-prefix>_<type>.<ext>
    safe_type = job["report_type"].replace(" ", "_")
    filename = f"crisis_reporter_{safe_type}_{job_id[:8]}.{ext}"

    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
