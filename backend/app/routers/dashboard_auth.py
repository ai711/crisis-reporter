from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, EmailStr

from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.services.auth import (
    verify_password,
    hash_password,
    create_token_pair,
    decode_token,
    create_token,
)
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/dashboard/auth", tags=["Dashboard Auth"])


# ── Request / Response Schemas ────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int


class RefreshRequest(BaseModel):
    refresh_token: str


class DashboardUserResponse(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    last_login_at: datetime | None

    class Config:
        from_attributes = True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Dashboard staff login — returns JWT access + refresh token pair."""

    # Find user by email
    result = await db.execute(
        select(DashboardUser).where(
            DashboardUser.email == request.email.lower().strip()
        )
    )
    user = result.scalar_one_or_none()

    # Verify user exists, is active, and password is correct
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not verify_password(request.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Update last login timestamp
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    # Issue token pair
    tokens = create_token_pair(
        subject=str(user.id),
        role=user.role,
        context="dashboard",
        extra_claims={"email": user.email, "name": user.full_name},
    )

    return tokens


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    """Silently refresh an expired access token using a valid refresh token.
    This endpoint is called automatically by the frontend HTTP interceptor
    and must never interrupt an active user session."""

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

    # Verify this is actually a refresh token for the dashboard context
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

    # Verify user still exists and is active
    result = await db.execute(
        select(DashboardUser).where(DashboardUser.id == payload.get("sub"))
    )
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer active",
        )

    # Issue new token pair
    tokens = create_token_pair(
        subject=str(user.id),
        role=user.role,
        context="dashboard",
        extra_claims={"email": user.email, "name": user.full_name},
    )

    return tokens


@router.post("/logout")
async def logout(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Logout — client must discard tokens on receipt of this response.
    Server-side token invalidation is handled by token expiry."""
    return {"message": "Logged out successfully"}


@router.get("/me", response_model=DashboardUserResponse)
async def get_me(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return the currently authenticated dashboard user's profile."""
    return DashboardUserResponse(
        id=str(current_user.id),
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        last_login_at=current_user.last_login_at,
    )


# ── Admin only — create dashboard users ───────────────────────────────────────

class CreateUserRequest(BaseModel):
    email: str
    full_name: str
    password: str
    role: str = "analyst"


@router.post("/users", response_model=DashboardUserResponse)
async def create_dashboard_user(
    request: CreateUserRequest,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new dashboard user — Admin only."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )

    if request.role not in ["admin", "analyst"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be admin or analyst",
        )

    # Check email not already in use
    result = await db.execute(
        select(DashboardUser).where(
            DashboardUser.email == request.email.lower().strip()
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )

    user = DashboardUser(
        email=request.email.lower().strip(),
        full_name=request.full_name,
        password_hash=hash_password(request.password),
        role=request.role,
    )

    db.add(user)
    await db.commit()
    await db.refresh(user)

    return DashboardUserResponse(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        last_login_at=user.last_login_at,
    )