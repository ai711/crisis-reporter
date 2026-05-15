from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from pydantic import BaseModel

from app.database import get_db
from app.models.reporter import Reporter
from app.services.auth import verify_password, create_token_pair
from app.services.encryption import encrypt_field, hash_field

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
