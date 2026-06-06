"""Dashboard user management endpoints.

All routes require dashboard authentication.
Admin-only actions require require_admin dependency.

Public URL prefix: /api/dashboard/users
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, validator
from sqlalchemy import select, func, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.models.project_user import ProjectUser
from app.models.crisis import Crisis
from app.services.auth import hash_password
from app.services.dependencies import get_current_dashboard_user, require_admin, require_section_access
from app.routers.app_settings import get_security_settings_dict


async def _validate_password(password: str, db: AsyncSession) -> None:
    """Raise 400 with a specific message if the password fails complexity rules."""
    sec = await get_security_settings_dict(db)
    min_len = sec.get("password_min_length", 10)
    req_upper = sec.get("require_uppercase", True)
    req_lower = sec.get("require_lowercase", True)
    req_number = sec.get("require_number", True)
    req_special = sec.get("require_special_char", True)

    if len(password) < min_len:
        raise HTTPException(status_code=400, detail=f"Password must be at least {min_len} characters.")
    if req_upper and not any(c.isupper() for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one uppercase letter.")
    if req_lower and not any(c.islower() for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one lowercase letter.")
    if req_number and not any(c.isdigit() for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one number.")
    if req_special and not any(c in "!@#$%^&*()_+-=[]{}|;':\",./<>?" for c in password):
        raise HTTPException(status_code=400, detail="Password must contain at least one special character.")

router = APIRouter(prefix="/dashboard/users", tags=["Dashboard Users"])


# ── Response helpers ──────────────────────────────────────────────────────────

def _user_row(user: DashboardUser, created_by_name: str | None = None) -> dict:
    return {
        "id": str(user.id),
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "contact_number": user.contact_number,
        "profile_photo_url": user.profile_photo_url,
        "is_active": user.is_active,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "created_by_user_id": str(user.created_by_user_id) if user.created_by_user_id else None,
        "created_by_name": created_by_name,
    }


async def _resolve_user(user_id: str, db: AsyncSession) -> DashboardUser:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid user_id.")
    user = await db.get(DashboardUser, uid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


# ── Schemas ───────────────────────────────────────────────────────────────────

class CreateUserRequest(BaseModel):
    first_name: str
    last_name: str
    email: str
    password: str
    role: str
    is_active: bool = True
    contact_number: Optional[str] = None

    @validator("email")
    def valid_email(cls, v):
        if "@" not in v:
            raise ValueError("Invalid email address.")
        return v.lower().strip()


class UpdateUserRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    contact_number: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None


class StatusUpdateRequest(BaseModel):
    is_active: bool


# ── GET /api/dashboard/users ──────────────────────────────────────────────────

@router.get("")
async def list_users(
    search: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("manage_users")),
):
    """List all dashboard users, sorted by created_at DESC, with optional search."""
    conditions = []

    if search:
        s = f"%{search.lower()}%"
        conditions.append(
            or_(
                func.lower(DashboardUser.full_name).like(s),
                func.lower(DashboardUser.email).like(s),
                func.lower(DashboardUser.role).like(s),
            )
        )

    if cursor:
        try:
            cursor_ts, cursor_uuid = cursor.split("_", 1)
            cursor_dt = datetime.fromisoformat(cursor_ts)
            conditions.append(DashboardUser.created_at < cursor_dt)
        except Exception:
            pass

    where_clause = and_(*conditions) if conditions else True

    q = (
        select(DashboardUser)
        .where(where_clause)
        .order_by(DashboardUser.created_at.desc())
        .limit(limit + 1)
    )
    result = await db.execute(q)
    users = result.scalars().all()

    has_more = len(users) > limit
    if has_more:
        users = list(users[:limit])

    # Bulk-fetch creator names
    creator_ids = list({u.created_by_user_id for u in users if u.created_by_user_id})
    creator_name_map: dict[uuid.UUID, str] = {}
    if creator_ids:
        cr = await db.execute(
            select(DashboardUser.id, DashboardUser.full_name)
            .where(DashboardUser.id.in_(creator_ids))
        )
        creator_name_map = {row[0]: row[1] for row in cr.all()}

    items = [
        _user_row(u, creator_name_map.get(u.created_by_user_id) if u.created_by_user_id else None)
        for u in users
    ]

    next_cursor = None
    if has_more and users:
        last = users[-1]
        next_cursor = f"{last.created_at.isoformat()}_{str(last.id)}"

    count_q = select(func.count(DashboardUser.id)).where(where_clause)
    total = (await db.execute(count_q)).scalar() or 0

    return {"items": items, "total": total, "cursor": next_cursor, "has_more": has_more}


# ── POST /api/dashboard/users ─────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("manage_users", require_edit=True)),
):
    """Create a new dashboard user. Admin only. Superadmin role requires Superadmin caller."""
    if body.role == "superadmin" and current_user.role != "superadmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a Superadmin can assign the Superadmin role.",
        )

    existing = await db.execute(
        select(DashboardUser).where(DashboardUser.email == body.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="email_taken")

    await _validate_password(body.password, db)

    full_name = f"{body.first_name.strip()} {body.last_name.strip()}".strip()
    user = DashboardUser(
        email=body.email,
        full_name=full_name,
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        password_hash=hash_password(body.password),
        password_changed_at=datetime.now(timezone.utc),
        role=body.role,
        is_active=body.is_active,
        contact_number=body.contact_number,
        created_by_user_id=current_user.id,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return _user_row(user, current_user.full_name)


# ── GET /api/dashboard/users/{user_id} ───────────────────────────────────────

@router.get("/{user_id}")
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("manage_users")),
):
    """Full user detail including project assignments."""
    user = await _resolve_user(user_id, db)

    creator_name = None
    if user.created_by_user_id:
        creator = await db.get(DashboardUser, user.created_by_user_id)
        if creator:
            creator_name = creator.full_name

    # Project assignments
    pu_result = await db.execute(
        select(ProjectUser)
        .options(joinedload(ProjectUser.crisis))
        .where(ProjectUser.dashboard_user_id == user.id)
        .order_by(ProjectUser.assigned_at.desc())
    )
    pu_list = pu_result.scalars().unique().all()

    project_assignments = [
        {
            "serial_id": pu.crisis.serial_id if pu.crisis else None,
            "project_name": pu.crisis.name if pu.crisis else None,
            "countries": pu.crisis.countries if pu.crisis else [],
            "status": pu.crisis.status if pu.crisis else None,
            "access_level": pu.access_level,
            "is_creator": pu.is_creator,
            "assigned_at": pu.assigned_at.isoformat() if pu.assigned_at else None,
        }
        for pu in pu_list
    ]

    row = _user_row(user, creator_name)
    row["project_assignments"] = project_assignments
    return row


# ── PATCH /api/dashboard/users/{user_id} ─────────────────────────────────────

@router.patch("/{user_id}")
async def update_user(
    user_id: str,
    request: Request,
    body: UpdateUserRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("manage_users", require_edit=True)),
):
    """Update a dashboard user. Email cannot be changed after creation."""
    raw_body = await request.json()
    if "email" in raw_body:
        raise HTTPException(
            status_code=400,
            detail="Email address cannot be changed after account creation.",
        )

    user = await _resolve_user(user_id, db)

    if body.role is not None:
        if body.role == "superadmin" and current_user.role != "superadmin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a Superadmin can assign the Superadmin role.",
            )
        user.role = body.role

    if body.first_name is not None:
        user.first_name = body.first_name.strip()
    if body.last_name is not None:
        user.last_name = body.last_name.strip()
    if body.contact_number is not None:
        user.contact_number = body.contact_number.strip() or None
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.password is not None:
        await _validate_password(body.password, db)
        user.password_hash = hash_password(body.password)
        user.password_changed_at = datetime.now(timezone.utc)

    # Recompute full_name if either name part changed
    fn = user.first_name or ""
    ln = user.last_name or ""
    combined = f"{fn} {ln}".strip()
    if combined:
        user.full_name = combined

    user.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    creator_name = None
    if user.created_by_user_id:
        creator = await db.get(DashboardUser, user.created_by_user_id)
        if creator:
            creator_name = creator.full_name

    return _user_row(user, creator_name)


# ── PATCH /api/dashboard/users/{user_id}/status ──────────────────────────────

@router.patch("/{user_id}/status")
async def update_user_status(
    user_id: str,
    body: StatusUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("manage_users", require_edit=True)),
):
    """Activate or deactivate a dashboard user account."""
    user = await _resolve_user(user_id, db)
    user.is_active = body.is_active
    user.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    creator_name = None
    if user.created_by_user_id:
        creator = await db.get(DashboardUser, user.created_by_user_id)
        if creator:
            creator_name = creator.full_name

    return _user_row(user, creator_name)


# ── GET /api/dashboard/users/{user_id}/projects ──────────────────────────────

@router.get("/{user_id}/projects")
async def get_user_projects(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """All project assignments for this user."""
    user = await _resolve_user(user_id, db)

    pu_result = await db.execute(
        select(ProjectUser)
        .options(joinedload(ProjectUser.crisis))
        .where(ProjectUser.dashboard_user_id == user.id)
        .order_by(ProjectUser.assigned_at.desc())
    )
    pu_list = pu_result.scalars().unique().all()

    return [
        {
            "serial_id": pu.crisis.serial_id if pu.crisis else None,
            "project_name": pu.crisis.name if pu.crisis else None,
            "countries": pu.crisis.countries if pu.crisis else [],
            "status": pu.crisis.status if pu.crisis else None,
            "access_level": pu.access_level,
            "is_creator": pu.is_creator,
            "assigned_at": pu.assigned_at.isoformat() if pu.assigned_at else None,
        }
        for pu in pu_list
    ]
