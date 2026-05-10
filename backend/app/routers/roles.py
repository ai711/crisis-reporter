"""
roles.py

GET   /api/roles          — list all custom roles with user count. Dashboard auth.
POST  /api/roles          — create new role. Admin only.
GET   /api/roles/{id}     — role detail with full permissions. Dashboard auth.
PATCH /api/roles/{id}     — update name/permissions. Admin only. Reject if default.
"""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.models.role import Role
from app.services.dependencies import get_current_dashboard_user, require_admin

router = APIRouter(prefix="/api/roles", tags=["Roles"])

# Names that can never be used for custom roles
_RESERVED = {"superadmin", "guest"}


# ── Schemas ───────────────────────────────────────────────────────────────────

class RoleOut(BaseModel):
    id: str
    name: str
    is_default: bool
    permissions: dict[str, Any]
    created_at: datetime
    user_count: int

    class Config:
        from_attributes = True


class CreateRoleRequest(BaseModel):
    name: str
    permissions: dict[str, Any] = {}


class UpdateRoleRequest(BaseModel):
    name: str | None = None
    permissions: dict[str, Any] | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _user_count(db: AsyncSession, role_name: str) -> int:
    result = await db.execute(
        select(func.count())
        .select_from(DashboardUser)
        .where(DashboardUser.role == role_name)
    )
    return result.scalar() or 0


def _to_out(role: Role, count: int) -> RoleOut:
    return RoleOut(
        id=str(role.id),
        name=role.name,
        is_default=role.is_default,
        permissions=role.permissions,
        created_at=role.created_at,
        user_count=count,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[RoleOut])
async def list_roles(
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """List all custom roles with computed user count."""
    result = await db.execute(select(Role).order_by(Role.created_at.asc()))
    roles = result.scalars().all()
    return [_to_out(r, await _user_count(db, r.name)) for r in roles]


@router.get("/{role_id}", response_model=RoleOut)
async def get_role(
    role_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
):
    """Get a single role with full permissions."""
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    return _to_out(role, await _user_count(db, role.name))


@router.post("", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
async def create_role(
    request: CreateRoleRequest,
    current_user: DashboardUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new custom role. Admin only."""
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role name is required")

    if name.lower() in _RESERVED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"'{name}' is a reserved role name and cannot be used",
        )

    existing = await db.execute(
        select(Role).where(func.lower(Role.name) == name.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A role with this name already exists",
        )

    role = Role(name=name, is_default=False, permissions=request.permissions)
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return _to_out(role, 0)


@router.patch("/{role_id}", response_model=RoleOut)
async def update_role(
    role_id: str,
    request: UpdateRoleRequest,
    current_user: DashboardUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update a custom role's name or permissions. Admin only. Default roles are immutable."""
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")

    if role.is_default:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Default roles cannot be modified",
        )

    if request.name is not None:
        name = request.name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Role name cannot be empty"
            )
        if name.lower() in _RESERVED:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"'{name}' is a reserved role name",
            )
        conflict = await db.execute(
            select(Role).where(
                func.lower(Role.name) == name.lower(),
                Role.id != role.id,
            )
        )
        if conflict.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A role with this name already exists",
            )
        role.name = name

    if request.permissions is not None:
        role.permissions = request.permissions

    await db.commit()
    await db.refresh(role)
    return _to_out(role, await _user_count(db, role.name))
