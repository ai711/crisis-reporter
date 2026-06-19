import hashlib
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text
from pydantic import BaseModel, field_validator

from app.config import settings
from app.database import get_db
from app.models.reporter import Reporter
from app.services.auth import (
    verify_password,
    hash_password,
    create_token_pair,
    decode_token,
)
from app.services.encryption import encrypt_field, decrypt_field, hash_field
from app.services.dependencies import get_current_reporter, get_optional_reporter


# ── Cookie helpers ─────────────────────────────────────────────────────────────

def _set_reporter_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    """Set HttpOnly auth cookies for web clients.
    Mobile clients ignore cookies and use the response body tokens instead."""
    response.set_cookie(
        key="cr_access_token",
        value=access_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    response.set_cookie(
        key="cr_refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path="/api/reporter/auth/refresh",
    )


def _clear_reporter_cookies(response: Response) -> None:
    response.delete_cookie(key="cr_access_token", path="/")
    response.delete_cookie(key="cr_refresh_token", path="/api/reporter/auth/refresh")

router = APIRouter(prefix="/api/reporter/auth", tags=["Reporter Auth"])


# ── Request / Response Schemas ────────────────────────────────────────────────

class AnonymousSessionRequest(BaseModel):
    device_id: str
    platform: str  # android, pwa, web
    country_code: str
    language_code: str = "en"
    os_device_id: Optional[str] = None
    t_and_c_accepted_at: Optional[datetime] = None
    mcc: Optional[str] = None

    @field_validator("mcc")
    @classmethod
    def validate_mcc(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        if not v.isdigit() or len(v) != 3:
            return None  # silently discard malformed values rather than reject the registration
        return v


class AnonymousSessionResponse(BaseModel):
    reporter_id: int
    is_verified: bool = False


class RegisterRequest(BaseModel):
    email: str
    password: str
    device_id: str
    platform: str
    country_code: str
    language_code: str = "en"


class LoginRequest(BaseModel):
    email: str
    password: str
    device_id: str
    platform: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int
    reporter_id: int
    is_verified: bool


class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None  # Optional: web uses cookie, mobile sends body


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/anonymous", response_model=AnonymousSessionResponse)
async def create_anonymous_session(
    request: AnonymousSessionRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create or retrieve an anonymous reporter session using device ID.
    Called on first app open. Returns reporter_id for use in report submissions."""

    device_id_hash = hash_field(request.device_id)

    # Check if reporter with this device already exists
    result = await db.execute(
        select(Reporter).where(Reporter.device_id_hash == device_id_hash)
    )
    reporter = result.scalar_one_or_none()

    if reporter:
        # Update activity fields if country or language changed
        reporter.country_code = request.country_code
        reporter.language_code = request.language_code
        reporter.last_active_at = datetime.now(timezone.utc)
        if request.os_device_id is not None:
            reporter.os_device_id = request.os_device_id
        if request.t_and_c_accepted_at is not None:
            reporter.t_and_c_accepted_at = request.t_and_c_accepted_at
        if request.mcc is not None:
            reporter.mcc = request.mcc
        await db.commit()
        return AnonymousSessionResponse(
            reporter_id=reporter.display_id,
            is_verified=reporter.is_verified,
        )

    # Create new anonymous reporter
    reporter = Reporter(
        device_id_encrypted=encrypt_field(request.device_id),
        device_id_hash=device_id_hash,
        platform=request.platform,
        country_code=request.country_code,
        language_code=request.language_code,
        is_verified=False,
        last_active_at=datetime.now(timezone.utc),
        os_device_id=request.os_device_id,
        t_and_c_accepted_at=request.t_and_c_accepted_at,
        mcc=request.mcc,
    )
    db.add(reporter)
    await db.flush()
    seq_result = await db.execute(text("SELECT nextval('reporter_display_id_seq')"))
    reporter.display_id = seq_result.scalar()
    await db.commit()
    await db.refresh(reporter)

    return AnonymousSessionResponse(
        reporter_id=reporter.display_id,
        is_verified=False,
    )


@router.post("/register", response_model=TokenResponse)
async def register(
    request: RegisterRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Register a verified reporter account.
    Links all prior anonymous reports from this device to the new account."""

    # Check email not already registered
    email_hash = hash_field(request.email)
    result = await db.execute(
        select(Reporter).where(Reporter.email_hash == email_hash)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    # Find existing anonymous reporter by device ID
    device_id_hash = hash_field(request.device_id)
    result = await db.execute(
        select(Reporter).where(Reporter.device_id_hash == device_id_hash)
    )
    existing_reporter = result.scalar_one_or_none()

    if existing_reporter and not existing_reporter.is_verified:
        # Upgrade anonymous reporter to verified account
        # All prior reports from this device are automatically linked
        existing_reporter.email_encrypted = encrypt_field(request.email)
        existing_reporter.email_hash = email_hash
        existing_reporter.password_hash = hash_password(request.password)
        existing_reporter.is_verified = True
        existing_reporter.language_code = request.language_code
        existing_reporter.country_code = request.country_code
        existing_reporter.last_active_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing_reporter)
        reporter = existing_reporter
    else:
        # Create new verified reporter
        reporter = Reporter(
            email_encrypted=encrypt_field(request.email),
            email_hash=email_hash,
            password_hash=hash_password(request.password),
            device_id_encrypted=encrypt_field(request.device_id),
            device_id_hash=device_id_hash,
            platform=request.platform,
            country_code=request.country_code,
            language_code=request.language_code,
            is_verified=True,
            last_active_at=datetime.now(timezone.utc),
        )
        db.add(reporter)
        await db.flush()
        seq_result = await db.execute(text("SELECT nextval('reporter_display_id_seq')"))
        reporter.display_id = seq_result.scalar()
        await db.commit()
        await db.refresh(reporter)

    tokens = create_token_pair(
        subject=str(reporter.id),
        role="reporter",
        context="reporter",
    )

    _set_reporter_cookies(response, tokens["access_token"], tokens["refresh_token"])

    return TokenResponse(
        **tokens,
        reporter_id=reporter.display_id,
        is_verified=True,
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    request: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Login with email and password — verified reporters only."""

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

    _set_reporter_cookies(response, tokens["access_token"], tokens["refresh_token"])

    return TokenResponse(
        **tokens,
        reporter_id=reporter.display_id,
        is_verified=True,
    )


@router.post("/refresh")
async def refresh_token(
    http_request: Request,
    body: RefreshRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Silently refresh reporter access token.
    Web clients: refresh token read from HttpOnly cookie (body token optional).
    Mobile clients: refresh token sent in request body.
    Called automatically by HTTP interceptor — never interrupts active form flow."""

    import jwt as pyjwt

    # Cookie takes precedence (web); fall back to body (mobile)
    raw_refresh = http_request.cookies.get("cr_refresh_token") or body.refresh_token
    if not raw_refresh:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No refresh token provided",
        )

    try:
        payload = decode_token(raw_refresh)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token expired — please log in again",
        )
    except pyjwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    if payload.get("type") != "refresh" or payload.get("ctx") != "reporter":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    result = await db.execute(
        select(Reporter).where(Reporter.id == payload.get("sub"))
    )
    reporter = result.scalar_one_or_none()

    if not reporter or reporter.is_blocked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Reporter no longer active",
        )

    tokens = create_token_pair(
        subject=str(reporter.id),
        role="reporter",
        context="reporter",
    )

    _set_reporter_cookies(response, tokens["access_token"], tokens["refresh_token"])

    return {
        **tokens,
        "reporter_id": reporter.display_id,
        "is_verified": reporter.is_verified,
    }


@router.post("/logout")
async def logout(response: Response):
    """Clear reporter auth cookies (web clients).
    Mobile clients should discard their locally stored tokens."""
    _clear_reporter_cookies(response)
    return {"message": "Logged out"}