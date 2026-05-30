import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text, update, func
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.reporter import Reporter
from app.models.reporter_activity_log import ReporterActivityLog
from app.models.report import Report
from app.models.safety_progress import SafetyProgress
from app.services.auth import verify_password, create_token_pair
from app.services.encryption import encrypt_field, hash_field
from app.services.dependencies import get_current_reporter
from app.services.storage import storage_service

router = APIRouter(prefix="/api/reporters", tags=["Reporters"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    device_id: str
    platform: str
    country_code: str | None = None
    language_code: str = "en"
    tc_accepted_at: str | None = None


class RegisterResponse(BaseModel):
    reporter_id: int
    platform: str


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int
    reporter_id: int
    is_verified: bool


class MergeAnonymousRequest(BaseModel):
    anonymous_device_id: str


class SafetyProgressRequest(BaseModel):
    part_completed: str   # "A", "B", or "C"
    completed_at: str     # ISO datetime string


async def _get_reporter_by_id(reporter_id: str, db: AsyncSession) -> Optional[Reporter]:
    """Look up reporter by display_id (integer) or UUID (backward compat)."""
    try:
        display_id_int = int(reporter_id)
        result = await db.execute(
            select(Reporter).where(Reporter.display_id == display_id_int)
        )
        reporter = result.scalar_one_or_none()
        if reporter:
            return reporter
    except (ValueError, TypeError):
        pass
    try:
        result = await db.execute(
            select(Reporter).where(Reporter.id == reporter_id)
        )
        return result.scalar_one_or_none()
    except Exception:
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/register", response_model=RegisterResponse)
async def register_anonymous(
    request: RegisterRequest,
    db: AsyncSession = Depends(get_db),
):
    """Register an anonymous reporter by device ID.
    Returns existing reporter_id if device is already registered.
    Called from the Home screen login prompt when user taps 'Skip for now'."""

    device_id_hash = hash_field(request.device_id)

    # Return existing reporter if device already registered
    result = await db.execute(
        select(Reporter).where(Reporter.device_id_hash == device_id_hash)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.last_active_at = datetime.now(timezone.utc)
        await db.commit()
        return RegisterResponse(
            reporter_id=existing.display_id,
            platform=existing.platform,
        )

    reporter = Reporter(
        device_id_encrypted=encrypt_field(request.device_id),
        device_id_hash=device_id_hash,
        platform=request.platform,
        country_code=request.country_code,
        language_code=request.language_code,
        is_verified=False,
        last_active_at=datetime.now(timezone.utc),
    )
    db.add(reporter)
    await db.flush()
    seq_result = await db.execute(text("SELECT nextval('reporter_display_id_seq')"))
    reporter.display_id = seq_result.scalar()
    await db.commit()
    await db.refresh(reporter)

    return RegisterResponse(
        reporter_id=reporter.display_id,
        platform=reporter.platform,
    )


@router.post("/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Login with email and password. Accepts email + password only.
    Used by the reporter Login page."""

    email_hash = hash_field(request.email)
    result = await db.execute(
        select(Reporter).where(Reporter.email_hash == email_hash)
    )
    reporter = result.scalar_one_or_none()

    if not reporter or not reporter.is_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if reporter.is_blocked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account has been suspended",
        )

    if not verify_password(request.password, reporter.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    reporter.last_active_at = datetime.now(timezone.utc)
    await db.commit()

    tokens = create_token_pair(
        subject=str(reporter.id),
        role="reporter",
        context="reporter",
    )

    return LoginResponse(
        **tokens,
        reporter_id=reporter.display_id,
        is_verified=True,
    )


@router.post("/merge-anonymous")
async def merge_anonymous(
    request: MergeAnonymousRequest,
    db: AsyncSession = Depends(get_db),
    current_reporter: Reporter = Depends(get_current_reporter),
):
    """Re-attribute all reports from an anonymous session to the verified reporter."""

    device_hash = hash_field(request.anonymous_device_id)
    anon_result = await db.execute(
        select(Reporter).where(
            Reporter.device_id_hash == device_hash,
            Reporter.is_verified == False,
        )
    )
    anon_reporter = anon_result.scalar_one_or_none()

    if not anon_reporter:
        return {"merged": False, "reason": "anonymous_session_not_found"}
    if anon_reporter.id == current_reporter.id:
        return {"merged": False, "reason": "same_account"}

    count_result = await db.execute(
        select(func.count()).select_from(Report).where(Report.reporter_id == anon_reporter.id)
    )
    reports_transferred = count_result.scalar() or 0

    await db.execute(
        update(Report)
        .where(Report.reporter_id == anon_reporter.id)
        .values(reporter_id=current_reporter.id)
    )

    current_reporter.report_count = (current_reporter.report_count or 0) + (anon_reporter.report_count or 0)

    anon_reporter.profile_type = "merged_into_verified"
    anon_reporter.report_count = 0

    db.add(ReporterActivityLog(
        reporter_id=current_reporter.id,
        action="anonymous_merge_received",
        source="System",
        comment=f"Merged from anonymous reporter {str(anon_reporter.id)}",
    ))
    db.add(ReporterActivityLog(
        reporter_id=anon_reporter.id,
        action="anonymous_merge_completed",
        source="System",
        comment=f"Reports transferred to verified reporter {str(current_reporter.id)}",
    ))

    await db.commit()
    return {"merged": True, "reports_transferred": reports_transferred}


# ── Safety progress ───────────────────────────────────────────────────────────

@router.post("/{reporter_id}/safety-progress")
async def record_safety_progress(
    reporter_id: str,
    body: SafetyProgressRequest,
    db: AsyncSession = Depends(get_db),
    current_reporter: Reporter = Depends(get_current_reporter),
):
    """Record completion of one Safety Tips part (A, B, or C).
    Upserts — re-completing a part updates the timestamp."""
    reporter = await _get_reporter_by_id(reporter_id, db)
    if not reporter or reporter.id != current_reporter.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    try:
        completed_at = datetime.fromisoformat(body.completed_at.replace("Z", "+00:00"))
    except ValueError:
        completed_at = datetime.now(timezone.utc)

    result = await db.execute(
        select(SafetyProgress).where(
            SafetyProgress.reporter_id == reporter.id,
            SafetyProgress.part_completed == body.part_completed,
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.completed_at = completed_at
    else:
        db.add(SafetyProgress(
            reporter_id=reporter.id,
            part_completed=body.part_completed,
            completed_at=completed_at,
        ))

    await db.commit()
    return {"success": True}


@router.get("/{reporter_id}/safety-progress")
async def get_safety_progress(
    reporter_id: str,
    db: AsyncSession = Depends(get_db),
    current_reporter: Reporter = Depends(get_current_reporter),
):
    """Return which Safety Tips parts the reporter has completed."""
    reporter = await _get_reporter_by_id(reporter_id, db)
    if not reporter or reporter.id != current_reporter.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    result = await db.execute(
        select(SafetyProgress).where(SafetyProgress.reporter_id == reporter.id)
    )
    records = result.scalars().all()
    return {"parts_completed": [r.part_completed for r in records]}


# ── Profile photo upload ──────────────────────────────────────────────────────

ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


@router.post("/{reporter_id}/photo")
async def upload_reporter_photo(
    reporter_id: str,
    photo: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_reporter: Reporter = Depends(get_current_reporter),
):
    """Upload or replace the reporter's profile photo."""
    reporter = await _get_reporter_by_id(reporter_id, db)
    if not reporter or reporter.id != current_reporter.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    if photo.content_type not in ALLOWED_PHOTO_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid file type. Accepted: JPEG, PNG, WebP",
        )

    contents = await photo.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Profile photo must be under 5 MB",
        )

    ext = (photo.filename or "photo.jpg").rsplit(".", 1)[-1].lower()
    filename = f"reporter-photo-{reporter.id}.{ext}"
    storage_path = await storage_service.save(
        file_data=contents,
        filename=filename,
        content_type=photo.content_type or "image/jpeg",
    )
    photo_url = storage_service.get_url(storage_path)

    reporter.photo_url = photo_url
    await db.commit()

    return {"photo_url": photo_url}
