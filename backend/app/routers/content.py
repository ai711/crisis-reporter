import asyncio
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update as sql_update
from pydantic import BaseModel
from typing import Any

from app.database import get_db, AsyncSessionLocal
from app.models.app_setting import AppSetting
from app.models.language_package import StringKey, Translation
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
        {"key": "report.error_no_internet",    "label": "Network Error",     "text": "No internet connection. Please check your connection and try again."},
        {"key": "errors.location_denied",       "label": "Location Denied",   "text": "Location access was denied. Please enable location services and try again."},
        {"key": "report.review_photo_required", "label": "Photo Required",    "text": "At least one photo is required. Please add a photo before submitting."},
        {"key": "report.error_timeout",         "label": "Submission Failed", "text": "This is taking longer than expected. Please try again."},
        {"key": "errors.session_expired",       "label": "Session Expired",   "text": "Your session has expired. Please log in again."},
    ],
    "version": 1,
    "updated_at": None,
}

_SYSTEM_MESSAGES_DEFAULT = {
    "items": [
        {"key": "messages.sync_complete",   "label": "Sync Complete",   "text": "Your offline reports have been synced successfully."},
        {"key": "messages.tc_update",        "label": "T&C Updated",     "text": "Our Terms and Conditions have been updated. Please review and accept to continue."},
        {"key": "messages.report_received",  "label": "Report Received", "text": "Your report has been received and is being processed."},
        {"key": "offline.banner",            "label": "Offline Banner",  "text": "You are offline. Reports will be saved and sent when you reconnect."},
        {"key": "messages.update_available", "label": "Update Available","text": "A new version of the app is available. Please refresh to update."},
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


def _ensure_slide_ids(slides: list) -> list[dict]:
    """Convert Pydantic models or dicts to dicts, assigning a stable UUID to any slide missing one."""
    result = []
    for s in slides:
        d = s.model_dump() if hasattr(s, "model_dump") else dict(s)
        if not d.get("slide_id"):
            d["slide_id"] = uuid.uuid4().hex[:8]
        result.append(d)
    return result


async def _translate_slides_bc(db: AsyncSession, slides: list, part: str, lang: str) -> list:
    """Fetch published translations for Part B/C slides and return translated slide list."""
    prefix_pattern = f"SAFETY_TIP_{part}_%"
    rows = await db.execute(
        select(StringKey.key, Translation.translated_text)
        .join(Translation, Translation.string_key_id == StringKey.id)
        .where(
            StringKey.key.like(prefix_pattern),
            Translation.language_code == lang,
            Translation.status == "published",
        )
    )
    tr = {row.key: row.translated_text for row in rows.all()}
    result = []
    for idx, slide in enumerate(slides, start=1):
        slide_id = slide.get("slide_id") if isinstance(slide, dict) else None
        sp = f"SAFETY_TIP_{part}_{slide_id}" if slide_id else f"SAFETY_TIP_{part}_SLIDE_{idx}"
        title = tr.get(f"{sp}_TITLE") or slide.get("title", "")
        bullets = [
            tr.get(f"{sp}_BULLET_{bidx}") or b
            for bidx, b in enumerate(slide.get("bullets", []), start=1)
        ]
        result.append({"slide_id": slide_id, "title": title, "bullets": bullets})
    return result


async def _translate_slides_a(db: AsyncSession, slides: list, disaster_type: str, lang: str) -> list:
    """Fetch published translations for Part A disaster slides and return translated slide list."""
    disaster_upper = disaster_type.upper().replace("-", "_")
    prefix_pattern = f"SAFETY_TIP_A_{disaster_upper}_%"
    rows = await db.execute(
        select(StringKey.key, Translation.translated_text)
        .join(Translation, Translation.string_key_id == StringKey.id)
        .where(
            StringKey.key.like(prefix_pattern),
            Translation.language_code == lang,
            Translation.status == "published",
        )
    )
    tr = {row.key: row.translated_text for row in rows.all()}
    result = []
    for idx, slide in enumerate(slides, start=1):
        slide_id = slide.get("slide_id") if isinstance(slide, dict) else None
        sp = f"SAFETY_TIP_A_{disaster_upper}_{slide_id}" if slide_id else f"SAFETY_TIP_A_{disaster_upper}_SLIDE_{idx}"
        title = tr.get(f"{sp}_TITLE") or slide.get("title", "")
        dos = [tr.get(f"{sp}_DO_{i}") or d for i, d in enumerate(slide.get("dos", []), start=1)]
        donts = [tr.get(f"{sp}_DONT_{i}") or d for i, d in enumerate(slide.get("donts", []), start=1)]
        result.append({"slide_id": slide_id, "title": title, "dos": dos, "donts": donts})
    return result


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
    tc_version_string: str | None = None  # optional semantic version bump (e.g. "1.1")


class SafetyTipSlide(BaseModel):
    slide_id: str | None = None
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
    lang: str = Query("en"),
    db: AsyncSession = Depends(get_db),
):
    """Public — no auth required. Reporter app fetches this to show in-app safety tips.
    Pass ?lang=zh (or ar/fr/ru/es) to receive pre-translated slide content."""
    if disaster_type not in DISASTER_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown disaster type: {disaster_type}")
    key = f"content_safety-tips_{disaster_type}"
    data = await _get(db, key, _safety_tips_default(disaster_type))
    if lang != "en" and data.get("slides"):
        data = dict(data)
        data["slides"] = await _translate_slides_a(db, data["slides"], disaster_type, lang)
    return data


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
            slide_id = slide.get("slide_id") if isinstance(slide, dict) else getattr(slide, "slide_id", None)
            if slide_id:
                slide_prefix = f"SAFETY_TIP_A_{disaster_upper}_{slide_id}"
            else:
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

        live_key_names = {kn for kn, _, _ in keys_to_ensure}

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
                else:
                    if not existing.is_active:
                        existing.is_active = True
                    if existing.english_text != english_text:
                        existing.english_text = english_text
                        # Reset non-published translations so auto-translate re-queues them.
                        # Published rows stay intact for in-flight language packages.
                        await db.execute(
                            sql_update(Translation)
                            .where(
                                Translation.string_key_id == existing.id,
                                Translation.status != "published",
                            )
                            .values(status="missing", translated_text="")
                            .execution_options(synchronize_session=False)
                        )

            # Deactivate StringKeys for deleted slides / bullets so they stop
            # bloating language packages and auto-translation runs.
            # This also handles the positional→UUID key migration: old SLIDE_N
            # keys become orphans the first time a save with UUIDs runs.
            prefix_pattern = f"SAFETY_TIP_A_{disaster_upper}_%"
            orphan_result = await db.execute(
                sa_select(StringKey).where(
                    StringKey.key.like(prefix_pattern),
                    StringKey.is_active.is_(True),
                )
            )
            for sk in orphan_result.scalars().all():
                if sk.key not in live_key_names:
                    sk.is_active = False

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
    slides_with_ids = _ensure_slide_ids(payload.slides)
    updated = {
        "slides": slides_with_ids,
        "version": current.get("version", 1) + 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await _upsert(db, key, updated)
    asyncio.create_task(_sync_safety_tips_to_translation(disaster_type, slides_with_ids))
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
            slide_id = slide.get("slide_id") if isinstance(slide, dict) else getattr(slide, "slide_id", None)
            if slide_id:
                slide_prefix = f"SAFETY_TIP_{part}_{slide_id}"
            else:
                slide_prefix = f"SAFETY_TIP_{part}_SLIDE_{slide_idx}"

            title_text = slide.get("title", "") if isinstance(slide, dict) else getattr(slide, "title", "")
            if title_text:
                keys_to_ensure.append((f"{slide_prefix}_TITLE", title_text, "content"))

            bullets = slide.get("bullets", []) if isinstance(slide, dict) else getattr(slide, "bullets", [])
            for bullet_idx, bullet_text in enumerate(bullets, start=1):
                if bullet_text:
                    keys_to_ensure.append((f"{slide_prefix}_BULLET_{bullet_idx}", bullet_text, "content"))

        live_key_names = {kn for kn, _, _ in keys_to_ensure}

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
                else:
                    if not existing.is_active:
                        existing.is_active = True
                    if existing.english_text != english_text:
                        existing.english_text = english_text
                        # Reset non-published translations so auto-translate re-queues them.
                        # Published rows stay intact for in-flight language packages.
                        await db.execute(
                            sql_update(Translation)
                            .where(
                                Translation.string_key_id == existing.id,
                                Translation.status != "published",
                            )
                            .values(status="missing", translated_text="")
                            .execution_options(synchronize_session=False)
                        )

            # Deactivate StringKeys for deleted slides / bullets.
            # Also handles positional→UUID key migration: old SLIDE_N keys
            # become orphans the first time a save with UUIDs runs.
            prefix_pattern = f"SAFETY_TIP_{part}_%"
            orphan_result = await db.execute(
                sa_select(StringKey).where(
                    StringKey.key.like(prefix_pattern),
                    StringKey.is_active.is_(True),
                )
            )
            for sk in orphan_result.scalars().all():
                if sk.key not in live_key_names:
                    sk.is_active = False

            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content(content_type))

    except Exception as exc:
        import logging
        logging.getLogger(__name__).error(
            "Slideshow translation sync failed for part=%s: %s", part, exc
        )


async def _sync_tc_to_translation(new_text: str, new_version: int, tc_version_string: str | None) -> None:
    """Update tc_text (and optionally tc_version) StringKey rows and trigger auto-translation."""
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        from app.tasks import auto_translate_content
        from app.models.language_package import StringKey
        from sqlalchemy import select as sa_select

        async with AsyncSessionLocal() as db:
            # Update tc_text
            r = await db.execute(sa_select(StringKey).where(StringKey.key == "tc_text"))
            sk = r.scalar_one_or_none()
            if sk and sk.english_text != new_text:
                sk.english_text = new_text
                await db.execute(
                    sql_update(Translation)
                    .where(Translation.string_key_id == sk.id, Translation.status != "published")
                    .values(status="missing", translated_text="")
                    .execution_options(synchronize_session=False)
                )
            # Update tc_version (use semantic string if provided, otherwise integer counter)
            version_str = tc_version_string if tc_version_string else str(new_version)
            r2 = await db.execute(sa_select(StringKey).where(StringKey.key == "tc_version"))
            sk2 = r2.scalar_one_or_none()
            if sk2 and sk2.english_text != version_str:
                sk2.english_text = version_str
                await db.execute(
                    sql_update(Translation)
                    .where(Translation.string_key_id == sk2.id, Translation.status != "published")
                    .values(status="missing", translated_text="")
                    .execution_options(synchronize_session=False)
                )
            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content("tc"))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("TC translation sync failed: %s", exc)


async def _sync_onboarding_to_translation(new_text: str) -> None:
    """Update onboarding.welcome_message StringKey and trigger auto-translation."""
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        from app.tasks import auto_translate_content
        from app.models.language_package import StringKey
        from sqlalchemy import select as sa_select

        async with AsyncSessionLocal() as db:
            r = await db.execute(sa_select(StringKey).where(StringKey.key == "onboarding.welcome_message"))
            sk = r.scalar_one_or_none()
            if sk is None:
                db.add(StringKey(key="onboarding.welcome_message", english_text=new_text, category="onboarding", is_active=True))
            elif sk.english_text != new_text:
                sk.english_text = new_text
                await db.execute(
                    sql_update(Translation)
                    .where(Translation.string_key_id == sk.id, Translation.status != "published")
                    .values(status="missing", translated_text="")
                    .execution_options(synchronize_session=False)
                )
            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content("onboarding"))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("Onboarding translation sync failed: %s", exc)


async def _sync_messages_to_translation(items: list[dict]) -> None:
    """Update StringKey rows for error/system message items and trigger auto-translation."""
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        from app.tasks import auto_translate_content
        from app.models.language_package import StringKey
        from sqlalchemy import select as sa_select

        async with AsyncSessionLocal() as db:
            for item in items:
                key_name = item.get("key", "")
                text = item.get("text", "")
                if not key_name or not text:
                    continue
                r = await db.execute(sa_select(StringKey).where(StringKey.key == key_name))
                sk = r.scalar_one_or_none()
                if sk is None:
                    # Create the StringKey so future translations are possible
                    db.add(StringKey(key=key_name, english_text=text, category="ui_messages", is_active=True))
                elif sk.english_text != text:
                    sk.english_text = text
                    await db.execute(
                        sql_update(Translation)
                        .where(Translation.string_key_id == sk.id, Translation.status != "published")
                        .values(status="missing", translated_text="")
                        .execution_options(synchronize_session=False)
                    )
            await db.commit()
            await ensure_string_keys_synced(db)
        asyncio.create_task(auto_translate_content("messages"))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("Messages translation sync failed: %s", exc)


# ── Generic content endpoints ─────────────────────────────────────────────────

@router.get("/{content_type}")
async def get_content(
    content_type: str,
    lang: str = Query("en"),
    db: AsyncSession = Depends(get_db),
):
    """Public — no auth required. Returns current content for the given type.
    Pass ?lang=zh (or ar/fr/ru/es) to receive pre-translated slide content for
    reporting-guidelines (Part B) and first-aid (Part C)."""
    if content_type not in SIMPLE_TYPES:
        raise HTTPException(status_code=404, detail=f"Unknown content type: {content_type}")
    key = f"content_{content_type}"
    data = await _get(db, key, DEFAULTS.get(content_type, {}))
    if lang != "en" and data.get("slides") and content_type in ("reporting-guidelines", "first-aid"):
        part = "B" if content_type == "reporting-guidelines" else "C"
        data = dict(data)
        data["slides"] = await _translate_slides_bc(db, data["slides"], part, lang)
    return data


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

    # Per-content-type translation sync
    if content_type == "tc" and payload.content is not None:
        asyncio.create_task(_sync_tc_to_translation(payload.content, new_version, payload.tc_version_string))
    elif content_type == "onboarding" and payload.content is not None:
        asyncio.create_task(_sync_onboarding_to_translation(payload.content))
    elif content_type in ("error_messages", "system_messages") and payload.items is not None:
        asyncio.create_task(_sync_messages_to_translation(payload.items))
    elif content_type in ("reporting-guidelines", "first-aid") and payload.slides is not None:
        slides_with_ids = _ensure_slide_ids(payload.slides)
        updated["slides"] = slides_with_ids
        await _upsert(db, key, updated)
        part = "B" if content_type == "reporting-guidelines" else "C"
        asyncio.create_task(_sync_slideshow_to_translation(part, slides_with_ids))

    return updated
