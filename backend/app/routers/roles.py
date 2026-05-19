"""
roles.py

GET   /api/roles          — list all roles (default + custom) with user count.
POST  /api/roles          — create new custom role. Admin only.
GET   /api/roles/{id}     — role detail with full permissions. Dashboard auth.
PATCH /api/roles/{id}     — update name/permissions. Admin only. Reject if default.
"""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.models.role import Role
from app.services.dependencies import (
    get_current_dashboard_user,
    require_admin,
    require_section_access,
)

router = APIRouter(prefix="/api/roles", tags=["Roles"])

# Names that can never be used for custom roles
_RESERVED = {"superadmin", "guest"}

# Permissions keys that are silently stripped from any non-Superadmin role payload
_PROTECTED_SECTIONS = {"dashboard_settings"}


# ── Schemas ───────────────────────────────────────────────────────────────────

class RoleOut(BaseModel):
    id: str
    name: str
    is_default: bool
    description: str | None
    permissions: dict[str, Any]
    created_at: datetime
    user_count: int
    created_by_user_id: str | None
    created_by_name: str | None

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


def _to_out(role: Role, count: int, creator_name: str | None = None) -> RoleOut:
    resolved_creator = (
        creator_name
        if creator_name
        else ("System" if role.is_default else None)
    )
    return RoleOut(
        id=str(role.id),
        name=role.name,
        is_default=role.is_default,
        description=role.description,
        permissions=role.permissions,
        created_at=role.created_at,
        user_count=count,
        created_by_user_id=str(role.created_by_user_id) if role.created_by_user_id else None,
        created_by_name=resolved_creator,
    )


def _filter_permissions(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip any protected section keys from a permissions payload."""
    return {k: v for k, v in raw.items() if k not in _PROTECTED_SECTIONS}


async def _resolve_creator_names(
    db: AsyncSession, roles: list[Role]
) -> dict[uuid.UUID, str]:
    creator_ids = [r.created_by_user_id for r in roles if r.created_by_user_id]
    if not creator_ids:
        return {}
    result = await db.execute(
        select(DashboardUser.id, DashboardUser.full_name).where(
            DashboardUser.id.in_(creator_ids)
        )
    )
    return {row.id: row.full_name for row in result.all()}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[RoleOut])
async def list_roles(
    current_user: DashboardUser = Depends(require_section_access("manage_roles")),
    db: AsyncSession = Depends(get_db),
):
    """List all roles (default first, then custom) with computed user count."""
    result = await db.execute(
        select(Role).order_by(Role.is_default.desc(), Role.created_at.asc())
    )
    roles = result.scalars().all()
    creator_names = await _resolve_creator_names(db, roles)
    return [
        _to_out(r, await _user_count(db, r.name), creator_names.get(r.created_by_user_id))
        for r in roles
    ]


@router.get("/{role_id}", response_model=RoleOut)
async def get_role(
    role_id: str,
    current_user: DashboardUser = Depends(require_section_access("manage_roles")),
    db: AsyncSession = Depends(get_db),
):
    """Get a single role with full permissions."""
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")
    creator_name: str | None = None
    if role.created_by_user_id:
        creator = await db.get(DashboardUser, role.created_by_user_id)
        if creator:
            creator_name = creator.full_name
    return _to_out(role, await _user_count(db, role.name), creator_name)


@router.post("", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
async def create_role(
    request: CreateRoleRequest,
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("manage_roles", require_edit=True)),
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

    filtered_permissions = _filter_permissions(request.permissions)
    role = Role(
        name=name,
        is_default=False,
        permissions=filtered_permissions,
        created_by_user_id=current_user.id,
    )
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return _to_out(role, 0, current_user.full_name)


@router.patch("/{role_id}", response_model=RoleOut)
async def update_role(
    role_id: str,
    request: UpdateRoleRequest,
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("manage_roles", require_edit=True)),
    db: AsyncSession = Depends(get_db),
):
    """Update a custom role's name or permissions. Admin only. Default roles are immutable."""
    result = await db.execute(select(Role).where(Role.id == role_id))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found")

    if role.is_default:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Default roles cannot be modified. Superadmin and Guest are protected system roles.",
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
        role.permissions = _filter_permissions(request.permissions)

    await db.commit()
    await db.refresh(role)

    creator_name: str | None = None
    if role.created_by_user_id:
        creator = await db.get(DashboardUser, role.created_by_user_id)
        if creator:
            creator_name = creator.full_name
    return _to_out(role, await _user_count(db, role.name), creator_name)
