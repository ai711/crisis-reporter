import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.database import get_db
from app.models.crisis import Crisis
from app.services.dependencies import get_current_dashboard_user, require_admin
from app.models.dashboard_user import DashboardUser

router = APIRouter(prefix="/api/crises", tags=["Crises"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CrisisCreate(BaseModel):
    name: str
    country_code: str
    description: str | None = None
    map_center_lat: float | None = None
    map_center_lng: float | None = None
    map_default_radius_miles: int = 50


class CrisisUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_active: bool | None = None
    map_center_lat: float | None = None
    map_center_lng: float | None = None
    map_default_radius_miles: int | None = None


class CrisisResponse(BaseModel):
    id: str
    name: str
    country_code: str
    description: str | None
    is_active: bool
    map_center_lat: float | None
    map_center_lng: float | None
    map_default_radius_miles: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[CrisisResponse])
async def list_crises(
    active_only: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """List all crises. Dashboard only."""
    query = select(Crisis)
    if active_only:
        query = query.where(Crisis.is_active == True)
    query = query.order_by(Crisis.created_at.desc())
    result = await db.execute(query)
    crises = result.scalars().all()
    return [CrisisResponse(
        id=str(c.id),
        name=c.name,
        country_code=c.country_code,
        description=c.description,
        is_active=c.is_active,
        map_center_lat=c.map_center_lat,
        map_center_lng=c.map_center_lng,
        map_default_radius_miles=c.map_default_radius_miles,
        created_at=c.created_at,
        updated_at=c.updated_at,
    ) for c in crises]


@router.post("", response_model=CrisisResponse)
async def create_crisis(
    request: CrisisCreate,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Create a new crisis. Admin only."""
    crisis = Crisis(
        name=request.name,
        country_code=request.country_code.upper(),
        description=request.description,
        map_center_lat=request.map_center_lat,
        map_center_lng=request.map_center_lng,
        map_default_radius_miles=request.map_default_radius_miles,
    )
    db.add(crisis)
    await db.commit()
    await db.refresh(crisis)
    return CrisisResponse(
        id=str(crisis.id),
        name=crisis.name,
        country_code=crisis.country_code,
        description=crisis.description,
        is_active=crisis.is_active,
        map_center_lat=crisis.map_center_lat,
        map_center_lng=crisis.map_center_lng,
        map_default_radius_miles=crisis.map_default_radius_miles,
        created_at=crisis.created_at,
        updated_at=crisis.updated_at,
    )


@router.get("/active", response_model=list[CrisisResponse])
async def list_active_crises_public(
    db: AsyncSession = Depends(get_db),
):
    """List active crises — public endpoint for reporter app country check."""
    result = await db.execute(
        select(Crisis).where(Crisis.is_active == True).order_by(Crisis.created_at.desc())
    )
    crises = result.scalars().all()
    return [CrisisResponse(
        id=str(c.id),
        name=c.name,
        country_code=c.country_code,
        description=c.description,
        is_active=c.is_active,
        map_center_lat=c.map_center_lat,
        map_center_lng=c.map_center_lng,
        map_default_radius_miles=c.map_default_radius_miles,
        created_at=c.created_at,
        updated_at=c.updated_at,
    ) for c in crises]


@router.patch("/{crisis_id}", response_model=CrisisResponse)
async def update_crisis(
    crisis_id: str,
    request: CrisisUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Update a crisis. Admin only."""
    result = await db.execute(
        select(Crisis).where(Crisis.id == crisis_id)
    )
    crisis = result.scalar_one_or_none()
    if not crisis:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Crisis not found",
        )
    if request.name is not None:
        crisis.name = request.name
    if request.description is not None:
        crisis.description = request.description
    if request.is_active is not None:
        crisis.is_active = request.is_active
    if request.map_center_lat is not None:
        crisis.map_center_lat = request.map_center_lat
    if request.map_center_lng is not None:
        crisis.map_center_lng = request.map_center_lng
    if request.map_default_radius_miles is not None:
        crisis.map_default_radius_miles = request.map_default_radius_miles

    crisis.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(crisis)

    return CrisisResponse(
        id=str(crisis.id),
        name=crisis.name,
        country_code=crisis.country_code,
        description=crisis.description,
        is_active=crisis.is_active,
        map_center_lat=crisis.map_center_lat,
        map_center_lng=crisis.map_center_lng,
        map_default_radius_miles=crisis.map_default_radius_miles,
        created_at=crisis.created_at,
        updated_at=crisis.updated_at,
    )