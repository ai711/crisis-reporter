from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Any

from app.database import get_db
from app.models.app_setting import AppSetting
from app.services.dependencies import require_admin
from app.models.dashboard_user import DashboardUser

router = APIRouter(prefix="/api/content", tags=["Content"])

# ── Constants ─────────────────────────────────────────────────────────────────

SIMPLE_TYPES = {"tc", "onboarding", "reporting-guidelines", "first-aid"}

DISASTER_TYPES = {
    "earthquake", "flood", "hurricane", "landslide", "tsunami",
    "fire", "drought", "conflict", "epidemic",
}

_REPORTING_GUIDELINES_DEFAULT = [
    {"title": "Step 1 — Open the app and locate the building", "bullets": ["Find the damaged building on the map", "Tap the building to select it"]},
    {"title": "Step 2 — Take a clear photo", "bullets": ["Photograph the damage from a safe distance", "Ensure good lighting", "Include the full structure if possible"]},
    {"title": "Step 3 — Classify the damage", "bullets": ["Choose the damage type that best matches what you see", "When in doubt choose the lower severity level"]},
    {"title": "Step 4 — Confirm your location", "bullets": ["Allow GPS if available", "Otherwise confirm the map pin is on the correct building"]},
    {"title": "Step 5 — Submit your report", "bullets": ["Review your report before submitting", "Your report will be sent even on slow connections"]},
]

_FIRST_AID_DEFAULT = [
    {"title": "Scene Safety", "bullets": ["Ensure the scene is safe before approaching", "Do not put yourself at risk"]},
    {"title": "Check Responsiveness", "bullets": ["Tap the person's shoulder and shout 'Are you okay?'", "If no response, call for help immediately"]},
    {"title": "Call for Help", "bullets": ["Contact emergency services", "Give your exact location and the number of casualties"]},
    {"title": "Open the Airway", "bullets": ["Tilt the head back and lift the chin", "Look, listen and feel for breathing for no more than 10 seconds"]},
    {"title": "Start CPR", "bullets": ["Give 30 chest compressions at a rate of 100–120 per minute", "Follow with 2 rescue breaths if trained"]},
    {"title": "Control Bleeding", "bullets": ["Apply firm direct pressure to the wound", "Do not remove embedded objects", "Keep pressure until help arrives"]},
]

DEFAULTS: dict[str, Any] = {
    "tc": {"content": "", "version": 1, "updated_at": None},
    "onboarding": {
        "content": "Welcome to Crisis Reporter. This app helps you document and report damage to buildings and infrastructure during and after a crisis. Your reports help UNDP and partner organisations coordinate emergency response.",
        "version": 1,
        "updated_at": None,
    },
    "reporting-guidelines": {
        "slides": _REPORTING_GUIDELINES_DEFAULT,
        "version": 1,
        "updated_at": None,
    },
    "first-aid": {
        "slides": _FIRST_AID_DEFAULT,
        "version": 1,
        "updated_at": None,
    },
}


def _safety_tips_default(disaster_type: str) -> dict:
    return {
        "slides": [
            {
                "title": "Stay Safe",
                "dos": ["Stay calm", "Follow official instructions", "Move to higher ground if flooding"],
                "donts": ["Do not panic", "Do not spread unverified information", "Do not re-enter damaged buildings"],
            }
        ],
        "version": 1,
        "updated_at": None,
    }


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get(db: AsyncSession, key: str, default: dict) -> dict:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    return row.value if row else default


async def _upsert(db: AsyncSession, key: str, value: dict) -> None:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    await db.commit()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ContentPatch(BaseModel):
    content: str | None = None
    slides: list[dict] | None = None


class SafetyTipSlide(BaseModel):
    title: str
    dos: list[str]
    donts: list[str]


class SafetyTipsPatch(BaseModel):
    slides: list[SafetyTipSlide]


# ── Safety tips endpoints ─────────────────────────────────────────────────────
# Must be defined BEFORE /{content_type} to avoid path conflicts

@router.get("/safety-tips/{disaster_type}")
async def get_safety_tips(
    disaster_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Public — no auth required. Reporter app fetches this to show in-app safety tips."""
    if disaster_type not in DISASTER_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown disaster type: {disaster_type}")
    key = f"content_safety-tips_{disaster_type}"
    return await _get(db, key, _safety_tips_default(disaster_type))


@router.patch("/safety-tips/{disaster_type}")
async def patch_safety_tips(
    disaster_type: str,
    payload: SafetyTipsPatch,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Admin only — update safety tips slides for a disaster type."""
    if disaster_type not in DISASTER_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown disaster type: {disaster_type}")
    key = f"content_safety-tips_{disaster_type}"
    current = await _get(db, key, _safety_tips_default(disaster_type))
    updated = {
        "slides": [s.model_dump() for s in payload.slides],
        "version": current.get("version", 1) + 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await _upsert(db, key, updated)
    return updated


# ── Generic content endpoints ─────────────────────────────────────────────────

@router.get("/{content_type}")
async def get_content(
    content_type: str,
    db: AsyncSession = Depends(get_db),
):
    """Public — no auth required. Returns current content for the given type."""
    if content_type not in SIMPLE_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown content type: {content_type}")
    key = f"content_{content_type}"
    return await _get(db, key, DEFAULTS.get(content_type, {}))


@router.patch("/{content_type}")
async def patch_content(
    content_type: str,
    payload: ContentPatch,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Admin only — update content. Increments version number on each save."""
    if content_type not in SIMPLE_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown content type: {content_type}")
    key = f"content_{content_type}"
    current = await _get(db, key, DEFAULTS.get(content_type, {}))
    new_version = current.get("version", 1) + 1
    now = datetime.now(timezone.utc).isoformat()

    if payload.content is not None:
        # Plain text content (tc, onboarding)
        updated: dict = {"content": payload.content, "version": new_version, "updated_at": now}
    elif payload.slides is not None:
        # Slideshow content (reporting-guidelines, first-aid)
        updated = {"slides": payload.slides, "version": new_version, "updated_at": now}
    else:
        raise HTTPException(status_code=400, detail="Provide either 'content' or 'slides'")

    await _upsert(db, key, updated)
    return updated
