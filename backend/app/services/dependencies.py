from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import jwt

from app.database import get_db
from app.services.auth import decode_token
from app.models.dashboard_user import DashboardUser
from app.models.reporter import Reporter

# Bearer token extractor
security = HTTPBearer()


async def get_current_dashboard_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> DashboardUser:
    """Dependency — extracts and verifies JWT for dashboard routes.
    Use this on any route that requires a logged-in UNDP staff member."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_token(credentials.credentials)

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


async def get_current_reporter(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> Reporter:
    """Dependency — extracts and verifies JWT for reporter routes.
    Use this on routes that require a verified reporter account."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = decode_token(credentials.credentials)

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


# Optional reporter auth — used on routes that accept both
# anonymous and verified reporters
async def get_optional_reporter(
    credentials: HTTPAuthorizationCredentials = Depends(
        HTTPBearer(auto_error=False)
    ),
    db: AsyncSession = Depends(get_db),
) -> Reporter | None:
    """Dependency — returns reporter if token provided, None if anonymous."""
    if not credentials:
        return None

    try:
        payload = decode_token(credentials.credentials)
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