import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/exports", tags=["Exports"])

# In-memory job store: { job_id: ExportJob }
# Sufficient for prototype — survives the process lifetime
_jobs: dict[str, dict] = {}

VALID_REPORT_TYPES = {
    "field_operations",
    "full_data",
    "gis_shapefile",
    "geopackage",
    "rapida_summary",
}

VALID_FORMATS = {"csv", "xlsx", "json", "zip"}


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


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/generate", response_model=GenerateResponse, status_code=status.HTTP_202_ACCEPTED)
async def generate_export(
    request: GenerateRequest,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Create an export job. Returns job_id immediately.
    Prototype: job is marked complete synchronously with a placeholder URL."""

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
    download_url = f"/api/exports/{job_id}/download"

    _jobs[job_id] = {
        "job_id": job_id,
        "report_type": request.report_type,
        "format": request.format,
        "country_filter": request.country_filter,
        "date_from": request.date_from,
        "date_to": request.date_to,
        "status": "complete",
        "download_url": download_url,
        "error": None,
        "created_at": datetime.now(timezone.utc),
        "user_id": str(current_user.id),
        "created_by": current_user.email,
    }

    return GenerateResponse(job_id=job_id)


@router.get("/history", response_model=list[ExportHistoryItem])
async def get_export_history(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
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
            download_url=j["download_url"],
            created_at=j["created_at"],
            created_by=j["created_by"],
        )
        for j in user_jobs[:20]
    ]


@router.get("/{job_id}/status", response_model=JobStatusResponse)
async def get_job_status(
    job_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Poll export job status. Prototype always returns complete immediately."""
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
