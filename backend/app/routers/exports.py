"""
exports.py — CSV, GeoJSON, Shapefile, and GeoPackage export generation
with RAPIDA field mapping applied at export time.

RAPIDA field mappings:
  damage_level        → damage_classification (Complete / Partial / Minimal)
  location_lat        → latitude              (decimal degrees — building centroid > pin drop > device GPS)
  location_lng        → longitude             (decimal degrees)
  created_at          → timestamp             (ISO 8601 UTC)
  infrastructure_name → infrastructure_type   (single value)
  infrastructure_types → infrastructure_type  (pipe-delimited multi-select)
"""

import csv
import hashlib
import hmac
import json
import os
import pathlib
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator, model_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.crisis import Crisis
from app.models.dashboard_user import DashboardUser
from app.models.flag_event import FlagEvent  # noqa: F401 — ensures relationship loaded
from app.models.report import Report
from app.services.dependencies import get_current_dashboard_user, require_section_access

try:
    import geopandas as gpd
    from shapely.geometry import Point
    GEOPANDAS_AVAILABLE = True
except ImportError:
    GEOPANDAS_AVAILABLE = False

router = APIRouter(prefix="/api/exports", tags=["Exports"])

# ── Signed URL helpers ────────────────────────────────────────────────────────


def generate_signed_download_url(job_id: str) -> str:
    """Generate a signed download URL that expires in EXPORT_DOWNLOAD_EXPIRY_MINUTES."""
    expires_at = int(time.time()) + (settings.EXPORT_DOWNLOAD_EXPIRY_MINUTES * 60)
    payload = f"{job_id}:{expires_at}"
    signature = hmac.new(
        settings.EXPORT_URL_SIGN_SECRET.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"/api/exports/{job_id}/download?expires={expires_at}&sig={signature}"


def verify_signed_download_url(job_id: str, expires: int, sig: str) -> bool:
    """Return True if the signature is valid and the URL has not expired."""
    if time.time() > expires:
        return False
    payload = f"{job_id}:{expires}"
    expected = hmac.new(
        settings.EXPORT_URL_SIGN_SECRET.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)

# ── Storage ───────────────────────────────────────────────────────────────────

EXPORT_DIR = pathlib.Path("/tmp/exports")
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

# ── In-memory job store ───────────────────────────────────────────────────────

_jobs: dict[str, dict] = {}

# ── Constants ─────────────────────────────────────────────────────────────────

VALID_REPORT_TYPES = {
    "standard_damage",
    "full_data",
    "reporter_activity",
    "flagged_reports",
    "project_summary",
}

VALID_FORMATS = {"csv", "json", "geojson", "shapefile", "geopackage"}

_CONTENT_TYPE: dict[str, str] = {
    "csv": "text/csv",
    "json": "application/json",
    "geojson": "application/geo+json",
    "shapefile": "application/zip",
    "geopackage": "application/geopackage+sqlite3",
}

_FILE_EXT: dict[str, str] = {
    "csv": "csv",
    "json": "json",
    "geojson": "geojson",
    "shapefile": "zip",
    "geopackage": "gpkg",
}

DAMAGE_MAP: dict[str, str] = {
    "complete": "Complete",
    "partial": "Partial",
    "minimal": "Minimal",
}

# ── Schemas ───────────────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    report_type: str
    format: str
    date_from: str
    date_to: str
    country_filter: list[str] | None = None
    damage_level: list[str] | None = None
    crisis_type: list[str] | None = None
    flag_status: list[str] | None = None
    platform: list[str] | None = None
    project_id: str | None = None

    @field_validator("date_from", "date_to", mode="before")
    @classmethod
    def date_not_empty(cls, v: object) -> str:
        if not v or not str(v).strip():
            raise ValueError("Date range is required for all exports.")
        return str(v).strip()

    @model_validator(mode="after")
    def cross_field_validate(self) -> "GenerateRequest":
        if self.date_from and self.date_to and self.date_to < self.date_from:
            raise ValueError("End date cannot be before start date.")
        if self.report_type == "project_summary" and not self.project_id:
            raise ValueError("Project selection is required for Project Summary Report.")
        return self


class GenerateResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    status: str
    download_url: Optional[str] = None
    error: Optional[str] = None


class ExportHistoryItem(BaseModel):
    id: str
    report_type: str
    format: str
    date_from: str
    date_to: str
    country_filter: Optional[list[str]] = None
    damage_level: Optional[list[str]] = None
    crisis_type: Optional[list[str]] = None
    flag_status: Optional[list[str]] = None
    platform: Optional[list[str]] = None
    project_id: Optional[str] = None
    status: str
    download_url: Optional[str] = None
    created_at: datetime
    created_by: str


class RedownloadResponse(BaseModel):
    job_id: str


# ── Shared utilities ──────────────────────────────────────────────────────────


def _parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# Values stored in reports.platform by each client. The Android app sends
# "Native App Android"; early builds sent "android".
_PLATFORM_ALIASES: dict[str, list[str]] = {
    "android": ["android", "Native App Android"],
    "ios": ["ios", "Native App iOS"],
    "pwa": ["pwa"],
    "web": ["web"],
}


def _normalize_disaster_type(value: str) -> str:
    """Map a label ("Hurricane or Cyclone") to the stored Q4 option_value ("hurricane_cyclone").

    Older dashboard builds sent labels; stored exports in history still carry them.
    """
    return value.strip().lower().replace(" or ", "_").replace(" ", "_")


def _fmt_dt(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


def _fmt(v: object) -> str:
    return "" if v is None else str(v)


def _pipe(values: list[str] | None, fallback: str | None) -> str:
    if values:
        return "|".join(values)
    return fallback or ""


def _make_gdf(records: list[dict], crs: str = "EPSG:4326") -> "gpd.GeoDataFrame":
    """
    Build a GeoDataFrame without triggering pandas 2.x StringDtype inference.

    Pandas 2.x defaults to StringDtype for string columns when constructing a
    DataFrame from dicts, but fiona (geopandas' file backend) only understands
    NumPy object dtype.  The fix is to separate geometry from attributes and
    pass dtype=object when constructing the intermediate DataFrame — this
    prevents StringDtype from ever being set, so no post-hoc cast is needed.
    """
    import pandas as pd

    geoms = [r["geometry"] for r in records]
    attrs = [{k: v for k, v in r.items() if k != "geometry"} for r in records]
    df = pd.DataFrame(attrs, dtype=object)
    return gpd.GeoDataFrame(df, geometry=geoms, crs=crs)


def _write_csv(file_path: pathlib.Path, headers: list[str], rows: list[list[str]]) -> None:
    with open(file_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        writer.writerows(rows)


def build_filename(report_type: str, date_from: str, date_to: str, fmt: str) -> str:
    type_labels = {
        "standard_damage": "StandardDamageReport",
        "full_data": "FullDataReport",
        "reporter_activity": "ReporterActivityReport",
        "flagged_reports": "FlaggedReportsReport",
        "project_summary": "ProjectSummaryReport",
    }
    ext_map = {
        "csv": "csv",
        "json": "json",
        "geojson": "geojson",
        "shapefile": "zip",
        "geopackage": "gpkg",
    }
    label = type_labels.get(report_type, report_type)
    ext = ext_map.get(fmt, fmt)
    return f"CrisisReporter_{label}_{date_from}_to_{date_to}_RAPIDA.{ext}"


def _build_where_clauses(job: dict, default_flag_statuses: list[str]) -> list:
    """Return a list of SQLAlchemy WHERE conditions derived from job filter dict."""
    clauses = []

    date_from = _parse_date(job.get("date_from"))
    date_to = _parse_date(job.get("date_to"))
    if date_from:
        clauses.append(Report.created_at >= _as_utc(date_from))
    if date_to:
        # A plain date ("2026-08-27") means the whole day — compare against the next midnight
        if len(str(job.get("date_to"))) == 10:
            clauses.append(Report.created_at < _as_utc(date_to) + timedelta(days=1))
        else:
            clauses.append(Report.created_at <= _as_utc(date_to))

    country_filter = job.get("country_filter")
    if country_filter:
        codes = [c.upper() for c in country_filter if c]
        # The report's own country (ISO code set at submission) is authoritative;
        # fall back to its project's country for reports submitted without one.
        crisis_subq = select(Crisis.id).where(
            func.upper(Crisis.country_code).in_(codes)
        ).scalar_subquery()
        clauses.append(or_(
            func.upper(Report.reporter_country).in_(codes),
            and_(Report.reporter_country.is_(None), Report.crisis_id.in_(crisis_subq)),
        ))

    damage_level = job.get("damage_level")
    if damage_level:
        clauses.append(Report.damage_level.in_(damage_level))

    crisis_type = job.get("crisis_type")
    if crisis_type:
        clauses.append(Report.disaster_type.in_([_normalize_disaster_type(t) for t in crisis_type]))

    flag_status = job.get("flag_status")
    if flag_status:
        clauses.append(Report.flag_status.in_(flag_status))
    else:
        clauses.append(Report.flag_status.in_(default_flag_statuses))

    platform = job.get("platform")
    if platform:
        values = [v for p in platform for v in _PLATFORM_ALIASES.get(p, [p])]
        clauses.append(Report.platform.in_(values))

    project_id = job.get("project_id")
    if project_id:
        clauses.append(Report.crisis_id == project_id)

    return clauses


# ── Standard Damage Report (CSV) ──────────────────────────────────────────────

_STANDARD_DAMAGE_HEADERS = [
    "timestamp",
    "latitude",
    "longitude",
    "damage_classification",
    "infrastructure_type",
    "disaster_type",
    "debris_blocking",
    "reporter_id",
]


async def _gen_standard_damage_csv(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report)
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = [
        [
            _fmt_dt(r.created_at),
            _fmt(r.location_lat),
            _fmt(r.location_lng),
            DAMAGE_MAP.get(r.damage_level, r.damage_level),
            _pipe(r.infrastructure_types, r.infrastructure_name),
            _fmt(r.disaster_type),
            _fmt(r.debris_blocking),
            _fmt(r.reporter_id),
        ]
        for r in reports
    ]
    _write_csv(file_path, _STANDARD_DAMAGE_HEADERS, rows)


# ── Standard Damage Report (GeoJSON) ─────────────────────────────────────────


async def _gen_standard_damage_geojson(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).where(
            Report.location_lat.isnot(None),
            Report.location_lng.isnot(None),
        )
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r.location_lng, r.location_lat],
            },
            "properties": {
                "timestamp": _fmt_dt(r.created_at),
                "damage_classification": DAMAGE_MAP.get(r.damage_level, r.damage_level),
                "infrastructure_type": _pipe(r.infrastructure_types, r.infrastructure_name),
                "disaster_type": _fmt(r.disaster_type),
                "reporter_id": str(r.reporter_id) if r.reporter_id else None,
            },
        }
        for r in reports
    ]
    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh,
                  ensure_ascii=False, indent=2)


# ── Shapefile (ZIP) ───────────────────────────────────────────────────────────


async def _gen_shapefile(file_path: pathlib.Path, job: dict) -> None:
    if not GEOPANDAS_AVAILABLE:
        raise RuntimeError(
            "Shapefile/GeoPackage generation unavailable — GIS libraries not installed "
            "on this server. Please use GeoJSON format instead."
        )
    async with AsyncSessionLocal() as session:
        stmt = select(Report).where(
            Report.location_lat.isnot(None),
            Report.location_lng.isnot(None),
        )
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    if not reports:
        raise RuntimeError("No records with valid location coordinates to export as Shapefile.")

    # Shapefile column names are capped at 10 chars by the ESRI format spec
    records = [
        {
            "rpt_id": str(r.serial_number if r.serial_number is not None else r.id)[:10],
            "timestamp": _fmt_dt(r.created_at)[:80],
            "dmg_class": DAMAGE_MAP.get(r.damage_level, r.damage_level),
            "infra_type": _pipe(r.infrastructure_types, r.infrastructure_name)[:80],
            "dsastr_tp": _fmt(r.disaster_type)[:40],
            "flag_stat": r.flag_status,
            "rptr_id": str(r.reporter_id)[:36] if r.reporter_id else "",
            "geometry": Point(r.location_lng, r.location_lat),
        }
        for r in reports
    ]

    gdf = _make_gdf(records)

    with tempfile.TemporaryDirectory() as tmpdir:
        shp_path = os.path.join(tmpdir, "crisis_reporter_export.shp")
        gdf.to_file(shp_path, driver="ESRI Shapefile")
        with zipfile.ZipFile(str(file_path), "w") as zf:
            for fname in os.listdir(tmpdir):
                zf.write(os.path.join(tmpdir, fname), fname)


# ── GeoPackage ────────────────────────────────────────────────────────────────


async def _gen_geopackage(file_path: pathlib.Path, job: dict) -> None:
    if not GEOPANDAS_AVAILABLE:
        raise RuntimeError(
            "Shapefile/GeoPackage generation unavailable — GIS libraries not installed "
            "on this server. Please use GeoJSON format instead."
        )
    async with AsyncSessionLocal() as session:
        stmt = select(Report).where(
            Report.location_lat.isnot(None),
            Report.location_lng.isnot(None),
        )
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    if not reports:
        raise RuntimeError("No records with valid location coordinates to export as GeoPackage.")

    records = [
        {
            "report_id": r.serial_number if r.serial_number is not None else str(r.id),
            "timestamp": _fmt_dt(r.created_at),
            "damage_classification": DAMAGE_MAP.get(r.damage_level, r.damage_level),
            "infrastructure_type": _pipe(r.infrastructure_types, r.infrastructure_name),
            "disaster_type": _fmt(r.disaster_type),
            "flag_status": r.flag_status,
            "reporter_id": str(r.reporter_id) if r.reporter_id else "",
            "geometry": Point(r.location_lng, r.location_lat),
        }
        for r in reports
    ]

    gdf = _make_gdf(records)
    gdf.to_file(str(file_path), driver="GPKG")


# ── Full Data Report (CSV) ────────────────────────────────────────────────────

_FULL_DATA_HEADERS = [
    "report_id",
    "timestamp",
    "latitude",
    "longitude",
    "damage_classification",
    "infrastructure_type",
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


async def _gen_full_data_csv(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        # Full data: include all flag statuses unless user specified a filter
        for clause in _build_where_clauses(job, ["grey", "green", "orange", "red", "discarded"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = [
        [
            str(r.serial_number) if r.serial_number is not None else str(r.id),
            _fmt_dt(r.created_at),
            _fmt(r.location_lat),
            _fmt(r.location_lng),
            DAMAGE_MAP.get(r.damage_level, r.damage_level),
            _pipe(r.infrastructure_types, r.infrastructure_name),
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
        for r in reports
    ]
    _write_csv(file_path, _FULL_DATA_HEADERS, rows)


# ── Full Data Report (JSON) ───────────────────────────────────────────────────


async def _gen_full_data_json(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        for clause in _build_where_clauses(job, ["grey", "green", "orange", "red", "discarded"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    records = [
        {
            "report_id": r.serial_number if r.serial_number is not None else str(r.id),
            "timestamp": _fmt_dt(r.created_at),
            "latitude": r.location_lat,
            "longitude": r.location_lng,
            "damage_classification": DAMAGE_MAP.get(r.damage_level, r.damage_level),
            "infrastructure_type": _pipe(r.infrastructure_types, r.infrastructure_name),
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


async def _gen_reporter_activity_csv(file_path: pathlib.Path, job: dict) -> None:
    clauses = _build_where_clauses(job, ["grey", "green", "orange", "red", "discarded"])

    async with AsyncSessionLocal() as session:
        agg_stmt = (
            select(
                Report.reporter_id,
                func.count(Report.id).label("total_reports"),
                func.min(Report.created_at).label("first_submission"),
                func.max(Report.created_at).label("last_submission"),
            )
            .where(Report.reporter_id.isnot(None))
        )
        for clause in clauses:
            agg_stmt = agg_stmt.where(clause)
        agg_stmt = agg_stmt.group_by(Report.reporter_id).order_by(
            func.count(Report.id).desc()
        )
        agg_result = await session.execute(agg_stmt)
        agg_rows = agg_result.all()

        reporter_ids = [row.reporter_id for row in agg_rows]
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
            "|".join(sorted(countries_by_reporter.get(row.reporter_id, set()))),
        ]
        for row in agg_rows
    ]
    _write_csv(file_path, _REPORTER_ACTIVITY_HEADERS, rows)


# ── Flagged Reports Report (CSV) ──────────────────────────────────────────────

_FLAGGED_REPORTS_HEADERS = [
    "timestamp",
    "latitude",
    "longitude",
    "damage_classification",
    "infrastructure_type",
    "disaster_type",
    "debris_blocking",
    "reporter_id",
    "flag_status",
    "flag_reason",
]


async def _gen_flagged_reports_csv(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        # Default for audit report: all non-green statuses
        for clause in _build_where_clauses(job, ["red", "orange", "grey", "discarded"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    rows = []
    for r in reports:
        flag_reason = ""
        if r.flag_events:
            latest = max(r.flag_events, key=lambda e: e.created_at)
            flag_reason = latest.reason or ""
        rows.append(
            [
                _fmt_dt(r.created_at),
                _fmt(r.location_lat),
                _fmt(r.location_lng),
                DAMAGE_MAP.get(r.damage_level, r.damage_level),
                _pipe(r.infrastructure_types, r.infrastructure_name),
                _fmt(r.disaster_type),
                _fmt(r.debris_blocking),
                _fmt(r.reporter_id),
                r.flag_status,
                flag_reason,
            ]
        )
    _write_csv(file_path, _FLAGGED_REPORTS_HEADERS, rows)


# ── Flagged Reports Report (JSON) ─────────────────────────────────────────────


async def _gen_flagged_reports_json(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).options(selectinload(Report.flag_events))
        for clause in _build_where_clauses(job, ["red", "orange", "grey", "discarded"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    records = []
    for r in reports:
        flag_reason = ""
        if r.flag_events:
            latest = max(r.flag_events, key=lambda e: e.created_at)
            flag_reason = latest.reason or ""
        records.append(
            {
                "timestamp": _fmt_dt(r.created_at),
                "latitude": r.location_lat,
                "longitude": r.location_lng,
                "damage_classification": DAMAGE_MAP.get(r.damage_level, r.damage_level),
                "infrastructure_type": _pipe(r.infrastructure_types, r.infrastructure_name),
                "disaster_type": _fmt(r.disaster_type),
                "flag_status": r.flag_status,
                "flag_reason": flag_reason,
                "reporter_id": str(r.reporter_id) if r.reporter_id else None,
            }
        )
    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump(records, fh, ensure_ascii=False, indent=2)


# ── Project Summary Report (CSV) ──────────────────────────────────────────────


async def _gen_project_summary_csv(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(
            Report.flag_status,
            Report.damage_level,
            func.count(Report.id).label("count"),
        )
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.group_by(Report.flag_status, Report.damage_level)
        result = await session.execute(stmt)
        summary_rows = result.all()

    headers = ["flag_status", "damage_classification", "count"]
    rows = [
        [row.flag_status, DAMAGE_MAP.get(row.damage_level, row.damage_level), str(row.count)]
        for row in summary_rows
    ]
    _write_csv(file_path, headers, rows)


# ── Project Summary Report (GeoJSON) ─────────────────────────────────────────


async def _gen_project_summary_geojson(file_path: pathlib.Path, job: dict) -> None:
    async with AsyncSessionLocal() as session:
        stmt = select(Report).where(
            Report.location_lat.isnot(None),
            Report.location_lng.isnot(None),
        )
        for clause in _build_where_clauses(job, ["green", "orange"]):
            stmt = stmt.where(clause)
        stmt = stmt.order_by(Report.created_at)
        result = await session.execute(stmt)
        reports = result.scalars().all()

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [r.location_lng, r.location_lat],
            },
            "properties": {
                "timestamp": _fmt_dt(r.created_at),
                "damage_classification": DAMAGE_MAP.get(r.damage_level, r.damage_level),
                "infrastructure_type": _pipe(r.infrastructure_types, r.infrastructure_name),
                "flag_status": r.flag_status,
            },
        }
        for r in reports
    ]
    with open(file_path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh,
                  ensure_ascii=False, indent=2)


# ── Background generation task ────────────────────────────────────────────────


async def _generate_file(job_id: str) -> None:
    job = _jobs.get(job_id)
    if not job:
        return

    report_type: str = job["report_type"]
    fmt: str = job["format"]
    date_from: str = job["date_from"]
    date_to: str = job["date_to"]

    ext = _FILE_EXT.get(fmt, "csv")
    file_path = EXPORT_DIR / f"{job_id}.{ext}"

    try:
        if report_type == "standard_damage" and fmt == "geojson":
            await _gen_standard_damage_geojson(file_path, job)
        elif report_type == "standard_damage" and fmt == "shapefile":
            await _gen_shapefile(file_path, job)
        elif report_type == "standard_damage" and fmt == "geopackage":
            await _gen_geopackage(file_path, job)
        elif report_type == "standard_damage":
            await _gen_standard_damage_csv(file_path, job)
        elif report_type == "full_data" and fmt == "json":
            await _gen_full_data_json(file_path, job)
        elif report_type == "full_data":
            await _gen_full_data_csv(file_path, job)
        elif report_type == "reporter_activity":
            await _gen_reporter_activity_csv(file_path, job)
        elif report_type == "flagged_reports" and fmt == "json":
            await _gen_flagged_reports_json(file_path, job)
        elif report_type == "flagged_reports":
            await _gen_flagged_reports_csv(file_path, job)
        elif report_type == "project_summary" and fmt == "geojson":
            await _gen_project_summary_geojson(file_path, job)
        else:
            await _gen_project_summary_csv(file_path, job)

        _jobs[job_id]["status"] = "complete"
        _jobs[job_id]["file_path"] = str(file_path)
        _jobs[job_id]["download_url"] = generate_signed_download_url(job_id)

    except Exception as exc:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["error"] = str(exc)


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post(
    "/generate",
    response_model=GenerateResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def generate_export(
    request: GenerateRequest,
    background_tasks: BackgroundTasks,
    current_user: DashboardUser = Depends(require_section_access("export", require_edit=True)),
) -> GenerateResponse:
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

    # Belt-and-suspenders: reject missing dates even if the validator was bypassed
    if not request.date_from or not request.date_from.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_from is required.",
        )
    if not request.date_to or not request.date_to.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_to is required.",
        )

    job_id = str(uuid.uuid4())
    configuration = {
        "report_type": request.report_type,
        "format": request.format,
        "date_from": request.date_from,
        "date_to": request.date_to,
        "country_filter": request.country_filter,
        "damage_level": request.damage_level,
        "crisis_type": request.crisis_type,
        "flag_status": request.flag_status,
        "platform": request.platform,
        "project_id": request.project_id,
    }

    _jobs[job_id] = {
        "job_id": job_id,
        **configuration,
        "status": "pending",
        "file_path": None,
        "download_url": None,
        "error": None,
        "created_at": datetime.now(timezone.utc),
        "user_id": str(current_user.id),
        "created_by": current_user.email,
        "configuration": configuration,
    }

    background_tasks.add_task(_generate_file, job_id)
    return GenerateResponse(job_id=job_id)


@router.get("/history")
async def get_export_history(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> list[dict]:
    user_id = str(current_user.id)
    user_jobs = [j for j in _jobs.values() if j["user_id"] == user_id]
    user_jobs.sort(key=lambda j: j["created_at"], reverse=True)

    result = []
    for j in user_jobs[:20]:
        created_at = j["created_at"]
        result.append(
            {
                "id": j["job_id"],
                "report_type": j["report_type"],
                "format": j["format"],
                "date_from": j.get("date_from", ""),
                "date_to": j.get("date_to", ""),
                "country_filter": j.get("country_filter"),
                "damage_level": j.get("damage_level"),
                "crisis_type": j.get("crisis_type"),
                "flag_status": j.get("flag_status"),
                "platform": j.get("platform"),
                "project_id": j.get("project_id"),
                "status": j["status"],
                "download_url": j.get("download_url"),
                "created_at": created_at.isoformat() if isinstance(created_at, datetime) else str(created_at),
                "created_by": j["created_by"],
            }
        )
    return result


@router.get("/{job_id}/status", response_model=JobStatusResponse)
async def get_job_status(
    job_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> JobStatusResponse:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found")
    if job["user_id"] != str(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    return JobStatusResponse(
        status=job["status"],
        download_url=job.get("download_url"),
        error=job.get("error"),
    )


@router.post("/{job_id}/redownload", response_model=GenerateResponse)
async def redownload_export(
    job_id: str,
    background_tasks: BackgroundTasks,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> GenerateResponse:
    """Create a fresh generation job using the same configuration as an existing job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found")
    if job["user_id"] != str(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    configuration: dict = job.get("configuration", {})
    new_job_id = str(uuid.uuid4())

    _jobs[new_job_id] = {
        "job_id": new_job_id,
        **configuration,
        "status": "pending",
        "file_path": None,
        "download_url": None,
        "error": None,
        "created_at": datetime.now(timezone.utc),
        "user_id": str(current_user.id),
        "created_by": current_user.email,
        "configuration": configuration,
    }

    background_tasks.add_task(_generate_file, new_job_id)
    return GenerateResponse(job_id=new_job_id)


@router.get("/{job_id}/download")
async def download_export(
    job_id: str,
    expires: int = Query(...),
    sig: str = Query(...),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> FileResponse:
    if not verify_signed_download_url(job_id, expires, sig):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Download link has expired or is invalid. Please generate a new export.",
        )
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found")
    if job["user_id"] != str(current_user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Export file path missing — regenerate this export")

    file_path = pathlib.Path(file_path_str)
    if not file_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Export file has been removed from disk — regenerate this export")

    fmt: str = job["format"]
    content_type = _CONTENT_TYPE.get(fmt, "application/octet-stream")
    filename = build_filename(
        job["report_type"], job["date_from"], job["date_to"], fmt
    )

    return FileResponse(
        path=str(file_path),
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
