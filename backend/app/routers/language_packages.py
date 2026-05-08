"""
language_packages.py

Three router prefixes live in this file because the feature spans three
top-level URL namespaces:

    /api/language-packages   — package lifecycle (active fetch, publish)
    /api/string-keys         — key catalogue management
    /api/translations        — per-language translation workflow

Register all three in main.py:
    app.include_router(language_packages.packages_router)
    app.include_router(language_packages.keys_router)
    app.include_router(language_packages.translations_router)
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import AsyncSessionLocal, get_db
from app.models.language_package import LanguagePackage, StringKey, Translation
from app.services.dependencies import get_current_dashboard_user, require_admin

log = logging.getLogger(__name__)

VALID_CATEGORIES = {
    "button", "question", "answer", "error",
    "content", "safety", "onboarding", "tc",
}

# ── Three routers ─────────────────────────────────────────────────────────────

packages_router = APIRouter(prefix="/api/language-packages", tags=["Language Packages"])
keys_router = APIRouter(prefix="/api/string-keys", tags=["Language Packages"])
translations_router = APIRouter(prefix="/api/translations", tags=["Language Packages"])


# ── Shared schemas ────────────────────────────────────────────────────────────

class StringKeyOut(BaseModel):
    id: str
    key: str
    category: str
    english_text: str
    is_active: bool
    translations: dict[str, str]   # language_code → status
    created_at: datetime

    class Config:
        from_attributes = True


class TranslationOut(BaseModel):
    id: str
    string_key: str
    english_text: str
    translated_text: str
    status: str
    translated_by: str
    reviewed_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LanguagePackageOut(BaseModel):
    id: str
    language_code: str
    version: str
    status: str
    published_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


class LanguagePackageListOut(BaseModel):
    id: str
    language_code: str
    version: str
    status: str
    published_at: Optional[datetime]
    created_at: datetime
    string_count: int

    class Config:
        from_attributes = True


# ── /api/language-packages ────────────────────────────────────────────────────

@packages_router.get("/active/{language_code}", response_model=dict[str, str])
async def get_active_package(
    language_code: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Return the full published translation package as a flat key→value map.

    Called by the reporter app (PWA + Android) on startup.  No auth required.
    Falls back gracefully — if no published package exists for this language,
    returns an empty dict so the app can fall back to English.
    """
    # Confirm a published package exists for this language
    pkg_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    pkg = pkg_result.scalar_one_or_none()
    if not pkg:
        return {}

    # Return all published translations for this language
    result = await db.execute(
        select(StringKey.key, Translation.translated_text)
        .join(Translation, Translation.string_key_id == StringKey.id)
        .where(
            Translation.language_code == language_code,
            Translation.status == "published",
            StringKey.is_active == True,
        )
    )
    return {row.key: row.translated_text for row in result.all()}


@packages_router.post(
    "/publish/{language_code}",
    response_model=LanguagePackageOut,
    status_code=status.HTTP_201_CREATED,
)
async def publish_language_package(
    language_code: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
) -> LanguagePackageOut:
    """Publish all approved translations for a language as a new package version.

    Fails with 422 if any active string key has no approved translation for
    this language — every key must be covered before publish.

    Admin only.  Archives any previously published package for this language.
    """
    # Collect active string keys
    all_keys_result = await db.execute(
        select(StringKey).where(StringKey.is_active == True)
    )
    all_keys = all_keys_result.scalars().all()
    if not all_keys:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No active string keys found — seed the database first",
        )

    # Collect approved translations for this language
    approved_result = await db.execute(
        select(Translation).where(
            Translation.language_code == language_code,
            Translation.status == "approved",
        )
    )
    approved = {t.string_key_id: t for t in approved_result.scalars().all()}

    # Gate: every active key must have an approved translation
    missing = [k.key for k in all_keys if k.id not in approved]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Cannot publish — {len(missing)} active key(s) have no approved "
                f"translation for '{language_code}': {', '.join(missing[:10])}"
                + ("…" if len(missing) > 10 else "")
            ),
        )

    # Mark approved translations as published
    for translation in approved.values():
        translation.status = "published"

    # Archive the previous published package for this language (if any)
    prev_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    for prev in prev_result.scalars().all():
        prev.status = "archived"

    # Generate next version number (count of all packages for this language + 1)
    count_result = await db.execute(
        select(func.count(LanguagePackage.id)).where(
            LanguagePackage.language_code == language_code
        )
    )
    next_version = f"1.{(count_result.scalar() or 0)}"

    pkg = LanguagePackage(
        language_code=language_code,
        version=next_version,
        status="published",
        published_at=datetime.now(timezone.utc),
    )
    db.add(pkg)
    await db.commit()
    await db.refresh(pkg)

    return LanguagePackageOut(
        id=str(pkg.id),
        language_code=pkg.language_code,
        version=pkg.version,
        status=pkg.status,
        published_at=pkg.published_at,
        created_at=pkg.created_at,
    )


@packages_router.get("", response_model=list[LanguagePackageListOut])
async def list_language_packages(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> list[LanguagePackageListOut]:
    """Return all language packages sorted newest first.

    Includes a string_count derived from current published translations for
    the package language.  Dashboard auth required.
    """
    pkgs_result = await db.execute(
        select(LanguagePackage).order_by(LanguagePackage.published_at.desc())
    )
    pkgs = pkgs_result.scalars().all()

    # Count currently-published translations per language for the string_count column
    counts_result = await db.execute(
        select(Translation.language_code, func.count(Translation.id))
        .where(Translation.status == "published")
        .group_by(Translation.language_code)
    )
    lang_counts: dict[str, int] = {row[0]: row[1] for row in counts_result.all()}

    return [
        LanguagePackageListOut(
            id=str(p.id),
            language_code=p.language_code,
            version=p.version,
            status=p.status,
            published_at=p.published_at,
            created_at=p.created_at,
            string_count=lang_counts.get(p.language_code, 0),
        )
        for p in pkgs
    ]


# ── /api/string-keys ─────────────────────────────────────────────────────────

class StringKeyCreate(BaseModel):
    key: str
    category: str
    english_text: str


@keys_router.get("", response_model=list[StringKeyOut])
async def list_string_keys(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> list[StringKeyOut]:
    """Return all string keys with their English text and per-language translation status.

    Dashboard auth required.
    """
    result = await db.execute(
        select(StringKey)
        .options(selectinload(StringKey.translations))
        .order_by(StringKey.key)
    )
    keys = result.scalars().all()

    return [
        StringKeyOut(
            id=str(k.id),
            key=k.key,
            category=k.category,
            english_text=k.english_text,
            is_active=k.is_active,
            translations={t.language_code: t.status for t in k.translations},
            created_at=k.created_at,
        )
        for k in keys
    ]


@keys_router.post("", response_model=StringKeyOut, status_code=status.HTTP_201_CREATED)
async def create_string_key(
    body: StringKeyCreate,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
) -> StringKeyOut:
    """Create a new translatable string key.  Admin only."""
    if body.category not in VALID_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Invalid category '{body.category}'. "
                f"Must be one of: {', '.join(sorted(VALID_CATEGORIES))}"
            ),
        )

    existing = await db.execute(
        select(StringKey).where(StringKey.key == body.key)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"String key '{body.key}' already exists",
        )

    sk = StringKey(key=body.key, category=body.category, english_text=body.english_text)
    db.add(sk)
    await db.commit()
    await db.refresh(sk)

    return StringKeyOut(
        id=str(sk.id),
        key=sk.key,
        category=sk.category,
        english_text=sk.english_text,
        is_active=sk.is_active,
        translations={},
        created_at=sk.created_at,
    )


# ── /api/translations ─────────────────────────────────────────────────────────

class AutoTranslateRequest(BaseModel):
    language_code: str


class AutoTranslateResult(BaseModel):
    language_code: str
    translated: int
    skipped: int
    failed: int
    errors: list[str]


class ApproveResponse(BaseModel):
    id: str
    status: str
    reviewed_by: str


@translations_router.get("/{language_code}", response_model=list[TranslationOut])
async def list_translations(
    language_code: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> list[TranslationOut]:
    """Return all string keys with their translation state for one language.

    Keys that have no translation record are included with placeholder values
    so the dashboard can show the full coverage picture.

    Dashboard auth required.
    """
    keys_result = await db.execute(
        select(StringKey)
        .options(selectinload(StringKey.translations))
        .where(StringKey.is_active == True)
        .order_by(StringKey.key)
    )
    keys = keys_result.scalars().all()

    # Index translations by string_key_id for this language
    trans_map: dict[uuid.UUID, Translation] = {}
    for k in keys:
        for t in k.translations:
            if t.language_code == language_code:
                trans_map[k.id] = t

    out = []
    for k in keys:
        t = trans_map.get(k.id)
        out.append(
            TranslationOut(
                id=str(t.id) if t else "",
                string_key=k.key,
                english_text=k.english_text,
                translated_text=t.translated_text if t else "",
                status=t.status if t else "missing",
                translated_by=t.translated_by if t else "",
                reviewed_by=t.reviewed_by if t else None,
                created_at=t.created_at if t else k.created_at,
                updated_at=t.updated_at if t else k.updated_at,
            )
        )
    return out


@translations_router.post(
    "/auto-translate",
    response_model=AutoTranslateResult,
)
async def auto_translate(
    body: AutoTranslateRequest,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
) -> AutoTranslateResult:
    """Auto-translate all string keys that have no translation yet for this language.

    For each untranslated key: POSTs to LibreTranslate and stores the result as a
    Translation with status="draft" and translated_by="auto".

    Keys that already have any translation record (draft/approved/published) are
    skipped to avoid overwriting human-reviewed work.

    Admin only.
    """
    # Find active keys with no translation record for this language
    existing_result = await db.execute(
        select(Translation.string_key_id).where(
            Translation.language_code == body.language_code
        )
    )
    already_translated = {row[0] for row in existing_result.all()}

    keys_result = await db.execute(
        select(StringKey).where(
            StringKey.is_active == True,
            StringKey.id.not_in(already_translated) if already_translated else True,
        )
    )
    keys_to_translate = keys_result.scalars().all()

    if not keys_to_translate:
        return AutoTranslateResult(
            language_code=body.language_code,
            translated=0,
            skipped=len(already_translated),
            failed=0,
            errors=[],
        )

    translate_url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
    translated = 0
    failed = 0
    errors: list[str] = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        for sk in keys_to_translate:
            try:
                resp = await client.post(
                    translate_url,
                    json={
                        "q": sk.english_text,
                        "source": "en",
                        "target": body.language_code,
                        "format": "text",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                translated_text = data.get("translatedText", "")
                if not translated_text:
                    raise ValueError("Empty translatedText in LibreTranslate response")

                db.add(
                    Translation(
                        string_key_id=sk.id,
                        language_code=body.language_code,
                        translated_text=translated_text,
                        status="draft",
                        translated_by="auto",
                    )
                )
                translated += 1

            except Exception as exc:
                failed += 1
                msg = f"{sk.key}: {exc}"
                errors.append(msg)
                log.warning("auto_translate failed for key %s: %s", sk.key, exc)

    if translated > 0:
        await db.commit()

    return AutoTranslateResult(
        language_code=body.language_code,
        translated=translated,
        skipped=len(already_translated),
        failed=failed,
        errors=errors,
    )


@translations_router.patch(
    "/{translation_id}/approve",
    response_model=ApproveResponse,
)
async def approve_translation(
    translation_id: str,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> ApproveResponse:
    """Mark a translation as approved.

    Sets status to "approved" and records the reviewing user's ID.
    Dashboard auth required.
    """
    result = await db.execute(
        select(Translation).where(Translation.id == translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Translation not found",
        )
    if translation.status == "published":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Translation is already published — unpublish the package first to re-review",
        )

    translation.status = "approved"
    translation.reviewed_by = str(current_user.id)
    await db.commit()

    return ApproveResponse(
        id=str(translation.id),
        status=translation.status,
        reviewed_by=translation.reviewed_by,
    )


class TranslationUpdate(BaseModel):
    translated_text: str


class TranslationCreate(BaseModel):
    string_key: str          # the stable machine key string (e.g. "Q1_LABEL")
    language_code: str
    translated_text: str


@translations_router.patch(
    "/{translation_id}",
    response_model=TranslationOut,
)
async def update_translation(
    translation_id: str,
    body: TranslationUpdate,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> TranslationOut:
    """Update the translated text of an existing translation.

    Resets status from approved → draft so the change goes back through review.
    Published translations cannot be edited — unpublish the package first.

    Dashboard auth required.
    """
    result = await db.execute(
        select(Translation).where(Translation.id == translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation not found")
    if translation.status == "published":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot edit a published translation — unpublish the package first",
        )

    translation.translated_text = body.translated_text
    if translation.status == "approved":
        translation.status = "draft"

    await db.commit()

    sk_result = await db.execute(
        select(StringKey).where(StringKey.id == translation.string_key_id)
    )
    sk = sk_result.scalar_one_or_none()

    return TranslationOut(
        id=str(translation.id),
        string_key=sk.key if sk else "",
        english_text=sk.english_text if sk else "",
        translated_text=translation.translated_text,
        status=translation.status,
        translated_by=translation.translated_by,
        reviewed_by=translation.reviewed_by,
        created_at=translation.created_at,
        updated_at=translation.updated_at,
    )


@translations_router.post(
    "",
    response_model=TranslationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_translation(
    body: TranslationCreate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> TranslationOut:
    """Create a new translation record for a string key / language pair.

    Used when the dashboard user manually types a translation for a key that
    has no translation record yet.  Stores as status="draft".

    Dashboard auth required.
    """
    sk_result = await db.execute(
        select(StringKey).where(StringKey.key == body.string_key)
    )
    sk = sk_result.scalar_one_or_none()
    if not sk:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"String key '{body.string_key}' not found",
        )

    existing = await db.execute(
        select(Translation).where(
            Translation.string_key_id == sk.id,
            Translation.language_code == body.language_code,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Translation already exists — use PATCH /api/translations/{id} to update it",
        )

    t = Translation(
        string_key_id=sk.id,
        language_code=body.language_code,
        translated_text=body.translated_text,
        status="draft",
        translated_by=str(current_user.id),
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    return TranslationOut(
        id=str(t.id),
        string_key=sk.key,
        english_text=sk.english_text,
        translated_text=t.translated_text,
        status=t.status,
        translated_by=t.translated_by,
        reviewed_by=t.reviewed_by,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


# ── Seed data ─────────────────────────────────────────────────────────────────

# All 8 questions + options, keyed by stable machine key
_SEED_KEYS: list[tuple[str, str, str]] = [
    # (key, category, english_text)

    # Q1 — Damage level
    ("Q1_LABEL",       "question", "How bad is the damage?"),
    ("Q1_OPT_MINIMAL", "answer",   "Minimal / No damage"),
    ("Q1_OPT_PARTIAL", "answer",   "Partially damaged"),
    ("Q1_OPT_COMPLETE","answer",   "Completely damaged"),

    # Q2 — Infrastructure type
    ("Q2_LABEL",              "question", "What type of infrastructure is this?"),
    ("Q2_OPT_RESIDENTIAL",    "answer",   "Residential Infrastructure"),
    ("Q2_OPT_COMMERCIAL",     "answer",   "Commercial Infrastructure"),
    ("Q2_OPT_GOVERNMENT",     "answer",   "Government Building"),
    ("Q2_OPT_UTILITY",        "answer",   "Utility Infrastructure"),
    ("Q2_OPT_TRANSPORT_COMM", "answer",   "Transport and Communication Infrastructure"),
    ("Q2_OPT_COMMUNITY",      "answer",   "Community Infrastructure"),
    ("Q2_OPT_PUBLIC_SPACES",  "answer",   "Public Spaces / Recreation Infrastructure"),
    ("Q2_OPT_OTHER",          "answer",   "Other (please specify)"),

    # Q3 — Infrastructure name
    ("Q3_LABEL", "question", "What is the name of this infrastructure?"),

    # Q4 — Disaster type
    ("Q4_LABEL",          "question", "What type of disaster caused this damage?"),
    ("Q4_OPT_EARTHQUAKE", "answer",   "Earthquake"),
    ("Q4_OPT_FLOOD",      "answer",   "Flood"),
    ("Q4_OPT_CYCLONE",    "answer",   "Cyclone / Typhoon / Hurricane"),
    ("Q4_OPT_LANDSLIDE",  "answer",   "Landslide"),
    ("Q4_OPT_FIRE",       "answer",   "Fire"),
    ("Q4_OPT_CONFLICT",   "answer",   "Conflict / War"),
    ("Q4_OPT_OTHER",      "answer",   "Other"),

    # Q5 — Debris blocking
    ("Q5_LABEL",         "question", "Is there debris blocking access?"),
    ("Q5_OPT_YES",       "answer",   "Yes"),
    ("Q5_OPT_NO",        "answer",   "No"),
    ("Q5_OPT_PARTIALLY", "answer",   "Partially"),

    # Q6 — Electricity condition
    ("Q6_LABEL",           "question", "What is the current condition of electricity infrastructure in your community following the crisis?"),
    ("Q6_OPT_NO_DAMAGE",   "answer",   "No damage observed"),
    ("Q6_OPT_MINOR",       "answer",   "Minor damage — service disruptions but quickly repairable"),
    ("Q6_OPT_MODERATE",    "answer",   "Moderate damage — partial outages requiring repairs"),
    ("Q6_OPT_SEVERE",      "answer",   "Severe damage — major infrastructure damaged, prolonged outages"),
    ("Q6_OPT_DESTROYED",   "answer",   "Completely destroyed — no electricity infrastructure functioning"),
    ("Q6_OPT_UNKNOWN",     "answer",   "Unknown / cannot be assessed"),

    # Q7 — Health services
    ("Q7_LABEL",                    "question", "How would you rate the overall functioning of health services in your community since the event?"),
    ("Q7_OPT_FULLY_FUNCTIONAL",     "answer",   "Fully functional"),
    ("Q7_OPT_PARTIALLY_FUNCTIONAL", "answer",   "Partially functional"),
    ("Q7_OPT_LARGELY_DISRUPTED",    "answer",   "Largely disrupted"),
    ("Q7_OPT_NOT_FUNCTIONING",      "answer",   "Not functioning at all"),
    ("Q7_OPT_UNKNOWN",              "answer",   "Unknown"),

    # Q8 — Pressing needs
    ("Q8_LABEL",            "question", "What are the most pressing needs in your community right now?"),
    ("Q8_OPT_FOOD_WATER",   "answer",   "Food assistance and safe drinking water"),
    ("Q8_OPT_CASH",         "answer",   "Cash or financial assistance"),
    ("Q8_OPT_HEALTHCARE",   "answer",   "Access to healthcare and essential medicines"),
    ("Q8_OPT_SHELTER",      "answer",   "Shelter, housing repair, or temporary accommodation"),
    ("Q8_OPT_LIVELIHOODS",  "answer",   "Restoration of livelihoods or income sources"),
    ("Q8_OPT_WASH",         "answer",   "Water, sanitation, and hygiene (toilets, washing facilities)"),
    ("Q8_OPT_BASIC_SVC",    "answer",   "Restoration of basic services and infrastructure (electricity, roads, schools)"),
    ("Q8_OPT_PROTECTION",   "answer",   "Protection services and psychosocial support"),
    ("Q8_OPT_LOCAL_SUPPORT","answer",   "Support from local authorities and community organizations"),
    ("Q8_OPT_OTHER",        "answer",   "Other — please specify"),
]


async def seed_string_keys() -> None:
    """Insert string keys if the table is empty.

    Called from the app lifespan after create_all.
    Safe to call on every restart — no-ops if data already exists.
    """
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(StringKey).limit(1))
        if result.scalar_one_or_none() is not None:
            return  # Already seeded

        for key, category, english_text in _SEED_KEYS:
            session.add(StringKey(key=key, category=category, english_text=english_text))

        await session.commit()
        log.info("Seeded %d string keys", len(_SEED_KEYS))
