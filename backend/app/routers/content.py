import asyncio
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Any

from app.database import get_db, AsyncSessionLocal
from app.models.app_setting import AppSetting
from app.services.dependencies import require_admin
from app.models.dashboard_user import DashboardUser

router = APIRouter(prefix="/api/content", tags=["Content"])

# ── Constants ─────────────────────────────────────────────────────────────────

SIMPLE_TYPES = {"tc", "onboarding", "reporting-guidelines", "first-aid", "error_messages", "system_messages"}

DISASTER_TYPES = {
    "earthquake",
    "flood",
    "tsunami",
    "hurricane_cyclone",
    "wildfire",
    "explosion",
    "chemical_incident",
    "conflict",
    "civil_unrest",
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

_ERROR_MESSAGES_DEFAULT = {
    "items": [
        {"key": "network_error", "text": "A network error occurred. Please check your connection and try again."},
        {"key": "location_denied", "text": "Location access was denied. Please enable location services and try again."},
        {"key": "photo_required", "text": "At least one photo is required before submitting your report."},
        {"key": "submission_failed", "text": "Your report could not be submitted. It has been saved to your offline queue."},
        {"key": "session_expired", "text": "Your session has expired. Please log in again."},
    ],
    "version": 1,
    "updated_at": None,
}

_SYSTEM_MESSAGES_DEFAULT = {
    "items": [
        {"key": "sync_complete", "text": "Your offline reports have been synced successfully."},
        {"key": "tc_update", "text": "Our Terms and Conditions have been updated. Please review and accept to continue."},
        {"key": "report_received", "text": "Your report has been received and is being processed."},
        {"key": "offline_queued", "text": "You are offline. Your report has been saved and will be sent when you reconnect."},
        {"key": "update_available", "text": "A new version of the app is available. Please refresh to update."},
    ],
    "version": 1,
    "updated_at": None,
}

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
    "error_messages": _ERROR_MESSAGES_DEFAULT,
    "system_messages": _SYSTEM_MESSAGES_DEFAULT,
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
    items: list[dict] | None = None  # for error_messages / system_messages


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


async def _sync_safety_tips_to_translation(
    disaster_type: str,
    slides: list,
) -> None:
    """
    For each slide in the safety tips content, ensure a StringKey row exists
    for every translatable text string and trigger auto-translation for all
    active languages. Called as a background task after content save.

    Creates its own DB session — the request-scoped session may already be
    closed by the time this background task runs.
    """
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        from app.tasks import auto_translate_content
        from app.models.language_package import StringKey
        from sqlalchemy import select as sa_select

        # Key format: SAFETY_TIP_A_{DISASTER_TYPE}_SLIDE_{N}_{FIELD}
        # e.g. SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_TITLE
        #      SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_DO_1
        #      SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_DONT_1
        disaster_upper = disaster_type.upper().replace("-", "_")
        keys_to_ensure = []

        for slide_idx, slide in enumerate(slides, start=1):
            slide_prefix = f"SAFETY_TIP_A_{disaster_upper}_SLIDE_{slide_idx}"

            title_text = slide.title if hasattr(slide, "title") else slide.get("title", "")
            if title_text:
                keys_to_ensure.append((f"{slide_prefix}_TITLE", title_text, "safety"))

            dos = slide.dos if hasattr(slide, "dos") else slide.get("dos", [])
            for do_idx, do_text in enumerate(dos, start=1):
                if do_text:
                    keys_to_ensure.append((f"{slide_prefix}_DO_{do_idx}", do_text, "safety"))

            donts = slide.donts if hasattr(slide, "donts") else slide.get("donts", [])
            for dont_idx, dont_text in enumerate(donts, start=1):
                if dont_text:
                    keys_to_ensure.append((f"{slide_prefix}_DONT_{dont_idx}", dont_text, "safety"))

        async with AsyncSessionLocal() as db:
            for key_name, english_text, category in keys_to_ensure:
                result = await db.execute(
                    sa_select(StringKey).where(StringKey.key == key_name)
                )
                existing = result.scalar_one_or_none()
                if existing is None:
                    db.add(StringKey(
                        key=key_name,
                        english_text=english_text,
                        category=category,
                        is_active=True,
                    ))
                elif existing.english_text != english_text:
                    existing.english_text = english_text

            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content("safety-tips"))

    except Exception as exc:
        import logging
        logging.getLogger(__name__).error(
            "Safety tips translation sync failed for %s: %s", disaster_type, exc
        )


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
    asyncio.create_task(_sync_safety_tips_to_translation(disaster_type, payload.slides))
    return updated


async def _sync_slideshow_to_translation(
    part: str,
    slides: list,
) -> None:
    """
    For each slide in reporting-guidelines (Part B) or first-aid (Part C) content,
    ensure a StringKey row exists for every translatable string and trigger
    auto-translation. Called as a background task after content save.

    Creates its own DB session — the request-scoped session may already be
    closed by the time this background task runs.

    Key format:
      SAFETY_TIP_B_SLIDE_{N}_TITLE / SAFETY_TIP_B_SLIDE_{N}_BULLET_{M}  (reporting-guidelines)
      SAFETY_TIP_C_SLIDE_{N}_TITLE / SAFETY_TIP_C_SLIDE_{N}_BULLET_{M}  (first-aid)
    """
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        from app.tasks import auto_translate_content
        from app.models.language_package import StringKey
        from sqlalchemy import select as sa_select

        content_type = "reporting-guidelines" if part == "B" else "first-aid"
        keys_to_ensure = []

        for slide_idx, slide in enumerate(slides, start=1):
            slide_prefix = f"SAFETY_TIP_{part}_SLIDE_{slide_idx}"

            title_text = slide.get("title", "") if isinstance(slide, dict) else getattr(slide, "title", "")
            if title_text:
                keys_to_ensure.append((f"{slide_prefix}_TITLE", title_text, "content"))

            bullets = slide.get("bullets", []) if isinstance(slide, dict) else getattr(slide, "bullets", [])
            for bullet_idx, bullet_text in enumerate(bullets, start=1):
                if bullet_text:
                    keys_to_ensure.append((f"{slide_prefix}_BULLET_{bullet_idx}", bullet_text, "content"))

        async with AsyncSessionLocal() as db:
            for key_name, english_text, category in keys_to_ensure:
                result = await db.execute(
                    sa_select(StringKey).where(StringKey.key == key_name)
                )
                existing = result.scalar_one_or_none()
                if existing is None:
                    db.add(StringKey(
                        key=key_name,
                        english_text=english_text,
                        category=category,
                        is_active=True,
                    ))
                elif existing.english_text != english_text:
                    existing.english_text = english_text

            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content(content_type))

    except Exception as exc:
        import logging
        logging.getLogger(__name__).error(
            "Slideshow translation sync failed for part=%s: %s", part, exc
        )


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
        updated: dict = {"content": payload.content, "version": new_version, "updated_at": now}
    elif payload.slides is not None:
        updated = {"slides": payload.slides, "version": new_version, "updated_at": now}
    elif payload.items is not None:
        updated = {"items": payload.items, "version": new_version, "updated_at": now}
    else:
        raise HTTPException(status_code=400, detail="Provide 'content', 'slides', or 'items'")

    await _upsert(db, key, updated)

    # When TC content changes, bump the global tc_current_version counter
    if content_type == "tc":
        tc_ver_key = "tc_current_version"
        result = await db.execute(select(AppSetting).where(AppSetting.key == tc_ver_key))
        row = result.scalar_one_or_none()
        if row is None:
            db.add(AppSetting(key=tc_ver_key, value={"version": new_version}))
        else:
            row.value = {"version": new_version}
        await db.commit()

    # Sync string keys and enqueue background auto-translation
    from app.routers.language_packages import ensure_string_keys_synced
    from app.tasks import auto_translate_content
    await ensure_string_keys_synced(db)
    asyncio.create_task(auto_translate_content(content_type=content_type))
    if content_type in ("reporting-guidelines", "first-aid") and payload.slides is not None:
        part = "B" if content_type == "reporting-guidelines" else "C"
        asyncio.create_task(_sync_slideshow_to_translation(part, payload.slides))

    return updated
