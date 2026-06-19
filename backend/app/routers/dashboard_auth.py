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
from typing import Any, Optional

# ── Security settings cache (module-level, refreshed every 60 s) ──────────────
# Avoids a DB hit on every login attempt while still reacting to admin changes.

_sec_cache: dict[str, Any] = {
    "session_timeout": 30,
    "max_login_attempts": 5,
    "lockout_duration": 15,
}
_sec_cache_ts: float = 0.0
_SEC_CACHE_TTL = 60.0  # seconds


async def _refresh_sec_cache_if_stale(db) -> None:
    """Fetch security settings from AppSetting and update the module-level cache."""
    global _sec_cache, _sec_cache_ts
    now = time.monotonic()
    if now - _sec_cache_ts < _SEC_CACHE_TTL:
        return
    try:
        from app.models.app_setting import AppSetting
        from sqlalchemy import select as _sel
        result = await db.execute(_sel(AppSetting).where(AppSetting.key == "security"))
        row = result.scalar_one_or_none()
        if row and isinstance(row.value, dict):
            _sec_cache = row.value
        _sec_cache_ts = now
    except Exception:
        pass

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.models.role import Role
from app.services.auth import (
    create_token_pair,
    decode_token,
    hash_password,
    verify_password,
)
from app.services.dependencies import get_current_dashboard_user
from app.services.storage import storage_service

router = APIRouter(prefix="/api/dashboard/auth", tags=["Dashboard Auth"])


# ── Cookie helpers ─────────────────────────────────────────────────────────────

def _set_dashboard_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    """Set HttpOnly auth cookies for web clients.
    API/mobile clients ignore cookies and use the response body tokens instead."""
    response.set_cookie(
        key="dash_access_token",
        value=access_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    response.set_cookie(
        key="dash_refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path="/api/dashboard/auth/refresh",
    )


def _clear_dashboard_cookies(response: Response) -> None:
    response.delete_cookie(key="dash_access_token", path="/")
    response.delete_cookie(key="dash_refresh_token", path="/api/dashboard/auth/refresh")


# ── Role permissions helper ───────────────────────────────────────────────────

_ALL_SECTIONS = [
    "main_map_view", "reports_page", "location_page", "review_queue",
    "analytics_and_statistics", "reporter_profiles", "export", "projects",
    "manage_users", "manage_roles", "app_configuration", "content_management",
]


async def get_role_permissions(db: AsyncSession, role_name: str) -> dict:
    """Returns the permissions dict for a given role name."""
    if role_name in ("superadmin", "admin"):
        return {s: {"view": True, "edit": True} for s in _ALL_SECTIONS}

    result = await db.execute(select(Role).where(Role.name == role_name))
    role = result.scalar_one_or_none()

    if not role or not role.permissions:
        return {s: {"view": False, "edit": False} for s in _ALL_SECTIONS}

    permissions = {}
    for section in _ALL_SECTIONS:
        permissions[section] = role.permissions.get(section, {"view": False, "edit": False})
    return permissions


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

        if locked_until and now < locked_until:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="too_many_attempts",
            )

        if now - state["window_start"] > window_secs:
            state["attempts"] = 0
            state["window_start"] = now
            state["locked_until"] = None


def _record_failure(ip: str) -> None:
    """Increment the failure counter for an IP; apply lockout if threshold reached.
    Reads max_login_attempts and lockout_duration from the module-level settings cache."""
    now = time.monotonic()
    window_secs = settings.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60
    max_attempts = _sec_cache.get("max_login_attempts", settings.LOGIN_RATE_LIMIT_ATTEMPTS)
    lockout_secs = _sec_cache.get("lockout_duration", settings.LOGIN_LOCKOUT_MINUTES) * 60

    with _rl_lock:
        state = _rl_store[ip]

        if now - state["window_start"] > window_secs:
            state["attempts"] = 0
            state["window_start"] = now
            state["locked_until"] = None

        state["attempts"] += 1

        if state["attempts"] >= max_attempts:
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


class DashboardUserResponse(BaseModel):
    id: str
    email: str
    full_name: str
    first_name: str | None
    last_name: str | None
    contact_number: str | None
    profile_photo_url: str | None
    role: str
    role_permissions: dict
    last_login_at: datetime | None
    inactivity_timeout_minutes: int

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int
    inactivity_timeout_minutes: int
    user: DashboardUserResponse | None = None


class RefreshRequest(BaseModel):
    refresh_token: Optional[str] = None  # Optional: web uses cookie, API clients send body


async def _user_response(user: DashboardUser, db: AsyncSession) -> DashboardUserResponse:
    """Build the standard user response dict, injecting the inactivity timeout and role permissions."""
    inactivity = _sec_cache.get("session_timeout", settings.INACTIVITY_TIMEOUT_MINUTES)
    return DashboardUserResponse(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        first_name=user.first_name,
        last_name=user.last_name,
        contact_number=user.contact_number,
        profile_photo_url=user.profile_photo_url,
        role=user.role,
        role_permissions=await get_role_permissions(db, user.role),
        last_login_at=user.last_login_at,
        inactivity_timeout_minutes=inactivity,
    )


# ── Login ─────────────────────────────────────────────────────────────────────


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Dashboard staff login.

    Distinct error codes:
      401 invalid_credentials  — user not found OR wrong password
      403 account_deactivated  — correct credentials but account deactivated
      429 too_many_attempts    — IP has exceeded the failed-attempt threshold
    """
    ip = request.client.host if request.client else "unknown"

    # Refresh security settings cache (async, at most once per 60 s)
    await _refresh_sec_cache_if_stale(db)

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

    # Check password expiry (expiry_days = 0 means disabled)
    expiry_days = int(_sec_cache.get("password_expiry_days", 0))
    if expiry_days > 0 and user.password_changed_at:
        days_since_change = (datetime.now(timezone.utc) - user.password_changed_at).days
        if days_since_change >= expiry_days:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="password_expired",
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

    _set_dashboard_cookies(response, tokens["access_token"], tokens["refresh_token"])

    inactivity = _sec_cache.get("session_timeout", settings.INACTIVITY_TIMEOUT_MINUTES)
    return {
        **tokens,
        "inactivity_timeout_minutes": inactivity,
        "user": await _user_response(user, db),
    }


# ── Refresh ───────────────────────────────────────────────────────────────────


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    http_request: Request,
    body: RefreshRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Silently refresh an expired access token using a valid refresh token.
    Web clients: refresh token read from HttpOnly cookie (body token optional).
    API/mobile clients: refresh token sent in request body.
    Called automatically by the frontend HTTP interceptor — never interrupts
    an active user session."""

    import jwt as pyjwt

    # Cookie takes precedence (web); fall back to body (API clients)
    raw_refresh = http_request.cookies.get("dash_refresh_token") or body.refresh_token
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

    _set_dashboard_cookies(response, tokens["access_token"], tokens["refresh_token"])

    inactivity = _sec_cache.get("session_timeout", settings.INACTIVITY_TIMEOUT_MINUTES)
    return {
        **tokens,
        "inactivity_timeout_minutes": inactivity,
    }


# ── Logout ────────────────────────────────────────────────────────────────────


@router.post("/logout")
async def logout(
    response: Response,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Logout — clears HttpOnly cookies (web) and instructs client to discard stored tokens.
    JWTs are stateless; server-side invalidation relies on token expiry."""
    _clear_dashboard_cookies(response)
    return {"message": "Logged out successfully"}


# ── Current user profile ──────────────────────────────────────────────────────


@router.get("/me", response_model=DashboardUserResponse)
async def get_me(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the currently authenticated dashboard user's full profile."""
    return await _user_response(current_user, db)


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

    return await _user_response(current_user, db)


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
        password_changed_at=datetime.now(timezone.utc),
        role=request.role,
        is_active=request.is_active,
        contact_number=request.contact_number,
        created_by_user_id=current_user.id,
    )

    db.add(user)
    await db.commit()
    await db.refresh(user)

    return await _user_response(user, db)


# ── Reset expired password (no auth required — identity proved via current password) ──


class ResetExpiredPasswordRequest(BaseModel):
    email: str
    current_password: str
    new_password: str

    @validator("new_password")
    def new_password_different(cls, v, values):
        if "current_password" in values and v == values["current_password"]:
            raise ValueError("New password must be different from the current password.")
        return v


@router.post("/reset-expired-password", response_model=TokenResponse)
async def reset_expired_password(
    body: ResetExpiredPasswordRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Reset a password that has expired without requiring an active session.

    Identity is proved by supplying the correct current password.
    Returns a fresh token pair — the user is immediately logged in after reset.
    """
    from app.routers.dashboard_users import _validate_password

    result = await db.execute(
        select(DashboardUser).where(
            DashboardUser.email == body.email.lower().strip()
        )
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="account_deactivated",
        )

    await _validate_password(body.new_password, db)

    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = datetime.now(timezone.utc)
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    tokens = create_token_pair(
        subject=str(user.id),
        role=user.role,
        context="dashboard",
        extra_claims={"email": user.email, "name": user.full_name},
    )

    _set_dashboard_cookies(response, tokens["access_token"], tokens["refresh_token"])

    inactivity = _sec_cache.get("session_timeout", settings.INACTIVITY_TIMEOUT_MINUTES)
    return {
        **tokens,
        "inactivity_timeout_minutes": inactivity,
        "user": await _user_response(user, db),
    }
