from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel

from app.database import get_db, AsyncSessionLocal
from app.models.country import Country
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import require_admin

router = APIRouter(prefix="/api/countries", tags=["Countries"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CountryCreate(BaseModel):
    code: str
    name: str
    official_language: str
    is_active: bool = False


class CountryPatch(BaseModel):
    is_active: bool


class CountryResponse(BaseModel):
    code: str
    name: str
    official_language: str
    is_active: bool

    class Config:
        from_attributes = True


# ── Seed data ─────────────────────────────────────────────────────────────────

SEED_COUNTRIES = [
    ("SY", "Syria", "Arabic"),
    ("UA", "Ukraine", "Ukrainian"),
    ("TR", "Turkey", "Turkish"),
    ("MA", "Morocco", "Arabic"),
    ("LY", "Libya", "Arabic"),
    ("AF", "Afghanistan", "Dari"),
    ("PK", "Pakistan", "Urdu"),
    ("BD", "Bangladesh", "Bengali"),
    ("PH", "Philippines", "Filipino"),
    ("HT", "Haiti", "Haitian Creole"),
    ("NP", "Nepal", "Nepali"),
    ("ET", "Ethiopia", "Amharic"),
    ("SO", "Somalia", "Somali"),
    ("SD", "Sudan", "Arabic"),
    ("YE", "Yemen", "Arabic"),
    ("MM", "Myanmar", "Burmese"),
    ("IQ", "Iraq", "Arabic"),
    ("NG", "Nigeria", "English"),
    ("KE", "Kenya", "Swahili"),
    ("CO", "Colombia", "Spanish"),
]


async def seed_countries() -> None:
    async with AsyncSessionLocal() as session:
        count_result = await session.execute(select(func.count()).select_from(Country))
        if count_result.scalar_one() > 0:
            return
        for code, name, language in SEED_COUNTRIES:
            session.add(Country(code=code, name=name, official_language=language, is_active=True))
        await session.commit()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[CountryResponse])
async def list_countries(db: AsyncSession = Depends(get_db)):
    """List all countries — public endpoint."""
    result = await db.execute(select(Country).order_by(Country.name))
    return result.scalars().all()


@router.post("", response_model=CountryResponse, status_code=status.HTTP_201_CREATED)
async def create_country(
    request: CountryCreate,
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(require_admin),
):
    """Create a new country. Admin only."""
    existing = await db.get(Country, request.code.upper())
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Country code already exists",
        )
    country = Country(
        code=request.code.upper(),
        name=request.name,
        official_language=request.official_language,
        is_active=request.is_active,
    )
    db.add(country)
    await db.commit()
    await db.refresh(country)
    return country


@router.patch("/{code}", response_model=CountryResponse)
async def update_country(
    code: str,
    request: CountryPatch,
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(require_admin),
):
    """Update country is_active status. Admin only."""
    country = await db.get(Country, code.upper())
    if not country:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Country not found",
        )
    country.is_active = request.is_active
    await db.commit()
    await db.refresh(country)
    return country
