"""
Dashboard authentication router.

Endpoints:
  POST /api/dashboard/auth/login          — email + password login
  POST /api/dashboard/auth/refresh        — silent token refresh
  POST /api/dashboard/auth/logout         — invalidate session (server-side no-op with JWT, client clears tokens)
  GET  /api/dashboard/auth/me             — current user profile
  PATCH /api/dashboard/auth/me            — update profile (name, contact, photo)
  POST /api/dashboard/auth/users          — create dashboard user (admin only)
"""

import time
import threading
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.services.auth import (
    create_token_pair,
    decode_token,
    hash_password,
    verify_password,
)
from app.services.dependencies import get_current_dashboard_user
from app.services.storage import storage_service

router = APIRouter(prefix="/api/dashboard/auth", tags=["Dashboard Auth"])

# ── Allowed content types for profile photos ──────────────────────────────────

_ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}

# ── In-memory IP rate limiter ─────────────────────────────────────────────────
# Each entry: {"attempts": int, "window_start": float, "locked_until": float | None}
# Uses monotonic clock so it is not affected by system clock changes.

_rl_store: dict[str, dict[str, Any]] = defaultdict(
    lambda: {"attempts": 0, "window_start": time.monotonic(), "locked_until": None}
)
_rl_lock = threading.Lock()


def _check_rate_limit(ip: str) -> None:
    """Raise 429 if this IP is currently locked out."""
    now = time.monotonic()
    window_secs = settings.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60

    with _rl_lock:
        state = _rl_store[ip]
        locked_until = state.get("locked_until")

        # Still in lockout window?
        if locked_until and now < locked_until:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="too_many_attempts",
            )

        # Sliding window expired — reset counter
        if now - state["window_start"] > window_secs:
            state["attempts"] = 0
            state["window_start"] = now
            state["locked_until"] = None


def _record_failure(ip: str) -> None:
    """Increment the failure counter for an IP; apply lockout if threshold reached."""
    now = time.monotonic()
    window_secs = settings.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60
    lockout_secs = settings.LOGIN_LOCKOUT_MINUTES * 60

    with _rl_lock:
        state = _rl_store[ip]

        # Reset window if expired before incrementing
        if now - state["window_start"] > window_secs:
            state["attempts"] = 0
            state["window_start"] = now
            state["locked_until"] = None

        state["attempts"] += 1

        if state["attempts"] >= settings.LOGIN_RATE_LIMIT_ATTEMPTS:
            state["locked_until"] = now + lockout_secs


def _reset_rate_limit(ip: str) -> None:
    """Clear the failure counter for an IP after a successful login."""
    with _rl_lock:
        _rl_store[ip] = {
            "attempts": 0,
            "window_start": time.monotonic(),
            "locked_until": None,
        }


# ── Request / Response Schemas ────────────────────────────────────────────────


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int
    inactivity_timeout_minutes: int


class RefreshRequest(BaseModel):
    refresh_token: str


class DashboardUserResponse(BaseModel):
    id: str
    email: str
    full_name: str
    first_name: str | None
    last_name: str | None
    contact_number: str | None
    profile_photo_url: str | None
    role: str
    last_login_at: datetime | None
    inactivity_timeout_minutes: int

    class Config:
        from_attributes = True


def _user_response(user: DashboardUser) -> DashboardUserResponse:
    """Build the standard user response dict, injecting the inactivity timeout."""
    return DashboardUserResponse(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        first_name=user.first_name,
        last_name=user.last_name,
        contact_number=user.contact_number,
        profile_photo_url=user.profile_photo_url,
        role=user.role,
        last_login_at=user.last_login_at,
        inactivity_timeout_minutes=settings.INACTIVITY_TIMEOUT_MINUTES,
    )


# ── Login ─────────────────────────────────────────────────────────────────────


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Dashboard staff login.

    Distinct error codes:
      401 invalid_credentials  — user not found OR wrong password
      403 account_deactivated  — correct credentials but account deactivated
      429 too_many_attempts    — IP has exceeded the failed-attempt threshold
    """
    ip = request.client.host if request.client else "unknown"

    # Enforce rate limit before touching the database
    _check_rate_limit(ip)

    # Look up user
    result = await db.execute(
        select(DashboardUser).where(
            DashboardUser.email == body.email.lower().strip()
        )
    )
    user = result.scalar_one_or_none()

    # Wrong email or wrong password — same 401 so attackers can't enumerate accounts
    if not user or not verify_password(body.password, user.password_hash):
        _record_failure(ip)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
        )

    # Correct credentials but account is deactivated
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="account_deactivated",
        )

    # Successful login — reset rate limiter and update last login timestamp
    _reset_rate_limit(ip)
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    tokens = create_token_pair(
        subject=str(user.id),
        role=user.role,
        context="dashboard",
        extra_claims={"email": user.email, "name": user.full_name},
    )

    return {
        **tokens,
        "inactivity_timeout_minutes": settings.INACTIVITY_TIMEOUT_MINUTES,
    }


# ── Refresh ───────────────────────────────────────────────────────────────────


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    """Silently refresh an expired access token using a valid refresh token.
    Called automatically by the frontend HTTP interceptor — never interrupts
    an active user session."""

    import jwt as pyjwt

    try:
        payload = decode_token(request.refresh_token)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token has expired — please log in again",
        )
    except pyjwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        )

    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token type",
        )

    if payload.get("ctx") != "dashboard":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token context",
        )

    result = await db.execute(
        select(DashboardUser).where(DashboardUser.id == payload.get("sub"))
    )
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer active",
        )

    tokens = create_token_pair(
        subject=str(user.id),
        role=user.role,
        context="dashboard",
        extra_claims={"email": user.email, "name": user.full_name},
    )

    return {
        **tokens,
        "inactivity_timeout_minutes": settings.INACTIVITY_TIMEOUT_MINUTES,
    }


# ── Logout ────────────────────────────────────────────────────────────────────


@router.post("/logout")
async def logout(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Logout — client must discard tokens on receipt.
    JWTs are stateless; server-side invalidation relies on token expiry.
    The client clears local storage regardless of this response."""
    return {"message": "Logged out successfully"}


# ── Current user profile ──────────────────────────────────────────────────────


@router.get("/me", response_model=DashboardUserResponse)
async def get_me(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return the currently authenticated dashboard user's full profile."""
    return _user_response(current_user)


@router.patch("/me", response_model=DashboardUserResponse)
async def update_me(
    first_name: str | None = Form(None),
    last_name: str | None = Form(None),
    contact_number: str | None = Form(None),
    profile_photo: UploadFile | None = File(None),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's profile.

    Accepts multipart/form-data so that a profile photo can be uploaded
    alongside text fields in a single request.

    Accepted photo formats: JPEG, PNG, WebP.
    """
    # Handle profile photo upload
    if profile_photo and profile_photo.filename:
        if profile_photo.content_type not in _ALLOWED_PHOTO_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Profile photo must be JPEG, PNG, or WebP.",
            )
        photo_bytes = await profile_photo.read()
        storage_path = await storage_service.save(
            photo_bytes,
            profile_photo.filename,
            profile_photo.content_type,
        )
        current_user.profile_photo_url = storage_service.get_url(storage_path)

    # Update text fields when provided (empty string is a valid value to clear a field)
    if first_name is not None:
        current_user.first_name = first_name.strip() or None
    if last_name is not None:
        current_user.last_name = last_name.strip() or None
    if contact_number is not None:
        current_user.contact_number = contact_number.strip() or None

    # Sync full_name from first + last name if both are set
    fn = current_user.first_name or ""
    ln = current_user.last_name or ""
    combined = f"{fn} {ln}".strip()
    if combined:
        current_user.full_name = combined

    current_user.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(current_user)

    return _user_response(current_user)


# ── Admin only — create dashboard users ───────────────────────────────────────


class CreateUserRequest(BaseModel):
    email: str
    full_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    password: str
    role: str = "analyst"
    is_active: bool = True
    contact_number: str | None = None


@router.post("/users", response_model=DashboardUserResponse)
async def create_dashboard_user(
    request: CreateUserRequest,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new dashboard user — Admin only. Superadmin role requires Superadmin caller."""
    if current_user.role not in ("admin", "superadmin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )

    allowed_roles = ["admin", "analyst", "superadmin"]
    if request.role not in allowed_roles:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Role must be one of: {', '.join(allowed_roles)}",
        )

    if request.role == "superadmin" and current_user.role != "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a Superadmin can assign the Superadmin role.",
        )

    email = request.email.lower().strip()
    result = await db.execute(
        select(DashboardUser).where(DashboardUser.email == email)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="email_taken",
        )

    # Resolve full_name from first/last if not provided directly
    if request.full_name:
        full_name = request.full_name.strip()
    elif request.first_name or request.last_name:
        full_name = f"{(request.first_name or '').strip()} {(request.last_name or '').strip()}".strip()
    else:
        full_name = email.split("@")[0]

    user = DashboardUser(
        email=email,
        full_name=full_name,
        first_name=request.first_name.strip() if request.first_name else None,
        last_name=request.last_name.strip() if request.last_name else None,
        password_hash=hash_password(request.password),
        role=request.role,
        is_active=request.is_active,
        contact_number=request.contact_number,
        created_by_user_id=current_user.id,
    )

    db.add(user)
    await db.commit()
    await db.refresh(user)

    return _user_response(user)
