from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import jwt

from app.database import get_db
from app.services.auth import decode_token
from app.models.dashboard_user import DashboardUser
from app.models.reporter import Reporter
from app.models.role import Role

# Bearer token extractor (kept for OpenAPI docs / mobile clients that use Bearer)
security = HTTPBearer(auto_error=False)


def _extract_token(request: Request, cookie_name: str) -> str | None:
    """Read JWT from HttpOnly cookie (web clients) or Authorization header (mobile).
    Cookie takes precedence — if present it was set server-side and is XSS-safe."""
    token = request.cookies.get(cookie_name)
    if token:
        return token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


async def get_current_dashboard_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> DashboardUser:
    """Dependency — extracts and verifies JWT for dashboard routes.
    Checks HttpOnly cookie first (web), then Authorization header (mobile/API)."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    raw_token = _extract_token(request, "dash_access_token")
    if not raw_token:
        raise credentials_exception

    try:
        payload = decode_token(raw_token)

        # Enforce dashboard context — reporter tokens cannot access dashboard
        if payload.get("ctx") != "dashboard":
            raise credentials_exception

        if payload.get("type") != "access":
            raise credentials_exception

        user_id: str = payload.get("sub")
        if not user_id:
            raise credentials_exception

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise credentials_exception

    # Fetch user from database
    result = await db.execute(
        select(DashboardUser).where(DashboardUser.id == user_id)
    )
    user = result.scalar_one_or_none()

    if not user or not user.is_active:
        raise credentials_exception

    return user


async def require_admin(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> DashboardUser:
    """Dependency — requires Admin role. Use on admin-only routes."""
    if current_user.role not in ("admin", "superadmin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return current_user


async def require_superadmin(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> DashboardUser:
    """Dependency — requires Superadmin role. Use on superadmin-only routes."""
    if current_user.role != "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Superadmin role required",
        )
    return current_user


def require_section_access(section_key: str, require_edit: bool = False):
    """
    Returns a FastAPI dependency that checks the current user has access
    to the given section based on their role's permissions.
    Superadmin and Admin always pass. Custom roles are checked against the
    role's permissions dict stored in the roles table.
    """
    async def _check(
        current_user: DashboardUser = Depends(get_current_dashboard_user),
        db: AsyncSession = Depends(get_db),
    ) -> DashboardUser:
        if current_user.role in ("superadmin", "admin"):
            return current_user

        role_result = await db.execute(
            select(Role).where(Role.name == current_user.role)
        )
        role = role_result.scalar_one_or_none()

        if not role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Role not found or has been deleted.",
            )

        section_perms = role.permissions.get(section_key, {})
        has_view = section_perms.get("view", False)
        has_edit = section_perms.get("edit", False)

        if require_edit and not has_edit:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Your role does not have edit access to this section.",
            )

        if not has_view:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Your role does not have access to this section.",
            )

        return current_user

    return _check


async def get_current_reporter(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Reporter:
    """Dependency — extracts and verifies JWT for reporter routes.
    Checks HttpOnly cookie first (web PWA), then Authorization header (Android)."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    raw_token = _extract_token(request, "cr_access_token")
    if not raw_token:
        raise credentials_exception

    try:
        payload = decode_token(raw_token)

        # Enforce reporter context — dashboard tokens cannot access reporter routes
        if payload.get("ctx") != "reporter":
            raise credentials_exception

        if payload.get("type") != "access":
            raise credentials_exception

        user_id: str = payload.get("sub")
        if not user_id:
            raise credentials_exception

    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise credentials_exception

    # Fetch reporter from database
    result = await db.execute(
        select(Reporter).where(Reporter.id == user_id)
    )
    reporter = result.scalar_one_or_none()

    if not reporter or reporter.is_blocked:
        raise credentials_exception

    return reporter


async def get_redis(request: Request):
    """Returns the shared Redis connection from app state."""
    return request.app.state.redis


# Optional reporter auth — used on routes that accept both
# anonymous and verified reporters
async def get_optional_reporter(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Reporter | None:
    """Dependency — returns reporter if token provided (cookie or Bearer), None if anonymous."""
    raw_token = _extract_token(request, "cr_access_token")
    if not raw_token:
        return None

    try:
        payload = decode_token(raw_token)
        if payload.get("ctx") != "reporter":
            return None
        if payload.get("type") != "access":
            return None

        user_id: str = payload.get("sub")
        if not user_id:
            return None

        result = await db.execute(
            select(Reporter).where(Reporter.id == user_id)
        )
        reporter = result.scalar_one_or_none()

        if not reporter or reporter.is_blocked:
            return None

        return reporter

    except jwt.InvalidTokenError:
        return None