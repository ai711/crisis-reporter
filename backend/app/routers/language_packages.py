"""
language_packages.py

Four router prefixes:
    /api/languages            — language lifecycle management
    /api/language-packages    — package lifecycle (active fetch, publish)
    /api/string-keys          — key catalogue management
    /api/translations         — per-language translation workflow (edit locks, audit)
"""

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import AsyncSessionLocal, get_db
from app.utils.translation import translate_text
from app.models.language_package import Language, LanguagePackage, StringKey, Translation
from app.models.translation_audit_log import TranslationAuditLog
from app.services.dependencies import (
    get_current_dashboard_user,
    require_admin,
    require_superadmin,
)
from app.services.translation_audit_service import write_translation_audit
from app.services.translation_lock_service import (
    acquire_translation_lock,
    get_translation_lock,
    refresh_translation_lock_ttl,
    release_translation_lock,
    release_translation_lock_admin,
)

log = logging.getLogger(__name__)

VALID_CATEGORIES = {
    "button", "question", "answer", "error",
    "content", "safety", "onboarding", "tc",
}

TRANSLATION_BATCH_SIZE = 5  # change here only to tune concurrency

# Tracks in-progress auto-translation per language code; cleared on completion.
_translation_progress: dict[str, dict] = {}

# ── Four routers ───────────────────────────────────────────────────────────────

languages_router = APIRouter(prefix="/api/languages", tags=["Language Packages"])
packages_router = APIRouter(prefix="/api/language-packages", tags=["Language Packages"])
keys_router = APIRouter(prefix="/api/string-keys", tags=["Language Packages"])
translations_router = APIRouter(prefix="/api/translations", tags=["Language Packages"])


# ── Shared schemas ────────────────────────────────────────────────────────────

class LanguageOut(BaseModel):
    id: str
    code: str
    name: str
    status: str
    is_protected: bool
    deprecated_at: Optional[datetime]
    removal_scheduled_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


class StringKeyOut(BaseModel):
    id: str
    key: str
    category: str
    english_text: str
    is_active: bool
    translations: dict[str, str]
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
    rejected_at: Optional[datetime]
    rejection_reason: Optional[str]
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
    string_count: Optional[int] = None
    published_by: Optional[str] = None

    class Config:
        from_attributes = True


# ── /api/languages ────────────────────────────────────────────────────────────

@languages_router.get("", response_model=list[LanguageOut])
async def list_languages(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> list[LanguageOut]:
    result = await db.execute(select(Language).order_by(Language.name))
    langs = result.scalars().all()
    return [
        LanguageOut(
            id=str(l.id),
            code=l.code,
            name=l.name,
            status=l.status,
            is_protected=l.is_protected,
            deprecated_at=l.deprecated_at,
            removal_scheduled_at=l.removal_scheduled_at,
            created_at=l.created_at,
        )
        for l in langs
    ]


# ── /api/languages/public — no auth, reporter-facing ─────────────────────────

# Native-script names for the 6 UN languages (hardcoded — not stored in DB)
_NATIVE_NAMES: dict[str, str] = {
    "ar": "العربية",
    "zh": "中文",
    "en": "English",
    "fr": "Français",
    "ru": "Русский",
    "es": "Español",
}


class PublicLanguageOut(BaseModel):
    code: str
    name: str
    native_name: Optional[str] = None
    is_active: bool


@languages_router.get("/public", response_model=list[PublicLanguageOut])
async def list_public_languages(
    db: AsyncSession = Depends(get_db),
) -> list[PublicLanguageOut]:
    """Public endpoint — no auth required.

    Returns active languages that have at least one published package.
    Ordered: English first, then alphabetical by name.
    Used by the reporter onboarding page More button.
    """
    # Codes that have at least one published package
    pkg_result = await db.execute(
        select(LanguagePackage.language_code).where(
            LanguagePackage.status == "published"
        )
    )
    published_codes = {row[0] for row in pkg_result.all()}

    if not published_codes:
        return []

    # Active languages that have a published package
    result = await db.execute(
        select(Language).where(
            Language.status == "active",
            Language.code.in_(published_codes),
        )
    )
    langs = result.scalars().all()

    # English first, then alphabetical by name
    sorted_langs = sorted(langs, key=lambda l: (0 if l.code == "en" else 1, l.name))

    return [
        PublicLanguageOut(
            code=l.code,
            name=l.name,
            native_name=_NATIVE_NAMES.get(l.code),
            is_active=True,
        )
        for l in sorted_langs
    ]


# ── /api/languages mutations (auth required) ──────────────────────────────────

class LanguageCreate(BaseModel):
    name: str
    code: str


class LanguageCreateOut(BaseModel):
    id: str
    code: str
    name: str
    status: str
    is_protected: bool
    translation_package_available: bool

    class Config:
        from_attributes = True


@languages_router.post("", response_model=LanguageCreateOut, status_code=status.HTTP_201_CREATED)
async def create_language(
    body: LanguageCreate,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> LanguageCreateOut:
    if len(body.code) != 2 or not body.code.isalpha():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Language code must be a valid ISO 639-1 two-letter alphabetic code",
        )

    existing = await db.execute(select(Language).where(Language.code == body.code))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Language code already exists",
        )

    pkg_result = await db.execute(
        select(LanguagePackage).where(LanguagePackage.language_code == body.code).limit(1)
    )
    has_package = pkg_result.scalar_one_or_none() is not None

    lang = Language(
        code=body.code,
        name=body.name,
        status="pending",
        is_protected=False,
    )
    db.add(lang)
    await db.commit()
    await db.refresh(lang)

    return LanguageCreateOut(
        id=str(lang.id),
        code=lang.code,
        name=lang.name,
        status=lang.status,
        is_protected=lang.is_protected,
        translation_package_available=has_package,
    )


class LanguageStatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in ("active", "deprecated", "pending"):
            raise ValueError("status must be active, deprecated, or pending")
        return v


@languages_router.patch("/{code}/status", response_model=LanguageOut)
async def update_language_status(
    code: str,
    body: LanguageStatusUpdate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
) -> LanguageOut:
    result = await db.execute(select(Language).where(Language.code == code))
    lang = result.scalar_one_or_none()
    if not lang:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Language not found")
    if lang.is_protected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The 6 UN languages cannot be deactivated or deprecated.",
        )

    now = datetime.now(timezone.utc)
    old_status = lang.status

    if body.status == "deprecated":
        lang.status = "deprecated"
        lang.deprecated_at = now
        lang.removal_scheduled_at = now + timedelta(days=settings.LANGUAGE_DEPRECATION_WINDOW_DAYS)
        event = "language_deprecated"
    elif body.status == "active" and old_status == "deprecated":
        lang.status = "active"
        lang.deprecated_at = None
        lang.removal_scheduled_at = None
        event = "language_activated"
    else:
        lang.status = body.status
        event = "language_activated" if body.status == "active" else "language_deprecated"

    await write_translation_audit(
        db,
        event_type=event,
        lang_code=lang.code,
        details={"old_status": old_status, "new_status": lang.status},
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.commit()
    await db.refresh(lang)

    return LanguageOut(
        id=str(lang.id),
        code=lang.code,
        name=lang.name,
        status=lang.status,
        is_protected=lang.is_protected,
        deprecated_at=lang.deprecated_at,
        removal_scheduled_at=lang.removal_scheduled_at,
        created_at=lang.created_at,
    )


@languages_router.delete("/{code}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_language(
    code: str,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_superadmin),
) -> None:
    result = await db.execute(select(Language).where(Language.code == code))
    lang = result.scalar_one_or_none()
    if not lang:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Language not found")
    if lang.is_protected:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Protected languages cannot be removed.",
        )
    if lang.status != "deprecated":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only deprecated languages can be hard-removed.",
        )
    if lang.removal_scheduled_at and lang.removal_scheduled_at > datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Removal not yet scheduled — earliest removal: {lang.removal_scheduled_at.isoformat()}",
        )
    await write_translation_audit(
        db,
        event_type="language_removed",
        lang_code=lang.code,
        details={"name": lang.name},
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.delete(lang)
    await db.commit()


# ── /api/language-packages ────────────────────────────────────────────────────

_AVAILABLE_UN_LANG_CODES = ["en", "fr", "ar", "zh", "ru", "es"]
_AVAILABLE_UN_LANG_NAMES = {
    "en": "English",
    "fr": "French",
    "ar": "Arabic",
    "zh": "Chinese",
    "ru": "Russian",
    "es": "Spanish",
}


@packages_router.get("/available")
async def get_available_languages(
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Public endpoint — returns all reporter-visible languages.

    Always includes the 6 UN languages (hardcoded). Also includes any
    non-UN language that has a published package.
    """
    lang_result = await db.execute(select(Language))
    all_langs = lang_result.scalars().all()
    lang_map = {l.code: l.name for l in all_langs}
    lang_status_map = {l.code: l.status for l in all_langs}

    pkg_result = await db.execute(
        select(LanguagePackage.language_code).where(LanguagePackage.status == "published")
    )
    published_codes = {row[0] for row in pkg_result.all()}

    result: list[dict] = []
    for code in _AVAILABLE_UN_LANG_CODES:
        result.append({
            "code": code,
            "name": lang_map.get(code, _AVAILABLE_UN_LANG_NAMES[code]),
            "status": "protected",
            "is_un_language": True,
        })

    non_un: list[dict] = []
    for code in published_codes:
        if code not in _AVAILABLE_UN_LANG_CODES:
            # Exclude deprecated/inactive languages — they must not appear to reporters
            if lang_status_map.get(code, "active") == "deprecated":
                continue
            non_un.append({
                "code": code,
                "name": lang_map.get(code, code),
                "status": "active",
                "is_un_language": False,
            })
    non_un.sort(key=lambda x: x["name"])
    result.extend(non_un)

    return result


@packages_router.get("/active/{language_code}")
async def get_active_package(
    language_code: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public endpoint — returns the full published string package for a language.

    Response shape:
        {
          "version": "1.3",          # version string from LanguagePackage row
          "language_code": "ar",
          "strings": {"KEY": "translated text", ...}
        }

    Every active string key is guaranteed to appear in "strings". Keys that
    have a published translation use that translation. Keys that do not have
    a published translation fall back to the English source text, so the
    frontend never receives an incomplete bundle.

    Returns version=None and strings={} when no published package exists yet.
    The translation pipeline is dashboard-driven (manual): staff translate,
    approve, and publish via the dashboard. This endpoint only serves the
    published snapshot — draft/approved translations are staff-side only.
    """
    pkg_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    pkg = pkg_result.scalar_one_or_none()
    if not pkg:
        return {
            "version": None,
            "language_code": language_code,
            "strings": {},
        }

    # Fetch all published translations for this language
    result = await db.execute(
        select(StringKey.key, Translation.translated_text)
        .join(Translation, Translation.string_key_id == StringKey.id)
        .where(
            Translation.language_code == language_code,
            Translation.status == "published",
            StringKey.is_active == True,
        )
    )
    strings_dict = {row.key: row.translated_text for row in result.all()}

    # English fallback: fetch any active string keys with no published translation
    # and substitute the English source text so no key is ever silently dropped.
    published_keys = set(strings_dict.keys())
    missing_result = await db.execute(
        select(StringKey.key, StringKey.english_text)
        .where(
            StringKey.is_active == True,
            StringKey.key.not_in(published_keys) if published_keys else True,
        )
    )
    for row in missing_result.all():
        strings_dict[row.key] = row.english_text  # English fallback

    return {
        "version": pkg.version,
        "language_code": language_code,
        "strings": strings_dict,
    }


@packages_router.get("/{language_code}/version")
async def get_package_version(
    language_code: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Public endpoint — returns only the current published version for a language.

    Used by the mobile app to check whether a newer package is available
    before downloading the full string payload. No auth required.

    Response shape:
        {
          "language_code": "ar",
          "version": "1.3",   # None when no published package exists
          "has_package": true
        }
    """
    pkg_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    pkg = pkg_result.scalar_one_or_none()
    return {
        "language_code": language_code,
        "version": pkg.version if pkg else None,
        "has_package": pkg is not None,
    }


@packages_router.post(
    "/publish/{language_code}",
    response_model=LanguagePackageOut,
    status_code=status.HTTP_201_CREATED,
)
async def publish_language_package(
    language_code: str,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_superadmin),
) -> LanguagePackageOut:
    """Publish all approved translations for a language as a new package version.

    Superadmin only. Fails if any active string key has no approved translation
    or if the review queue (draft/failed) is non-empty for this language.
    """
    # Gate: review queue must be empty
    pending_result = await db.execute(
        select(func.count(Translation.id)).where(
            Translation.language_code == language_code,
            Translation.status.in_(["draft", "failed"]),
        )
    )
    pending_count = pending_result.scalar() or 0
    if pending_count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"review_queue_not_empty: {pending_count} draft/failed translations must be reviewed before publishing.",
        )

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

    # Collect already-published translations — keys with a published translation
    # from a previous cycle do not need to be re-approved for this publish run
    published_ids_result = await db.execute(
        select(Translation.string_key_id).where(
            Translation.language_code == language_code,
            Translation.status == "published",
        )
    )
    already_published_ids = {row[0] for row in published_ids_result.all()}

    # Gate: every active key must have an approved OR already-published translation
    missing = [k.key for k in all_keys if k.id not in approved and k.id not in already_published_ids]
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

    # Generate next version number
    count_result = await db.execute(
        select(func.count(LanguagePackage.id)).where(
            LanguagePackage.language_code == language_code
        )
    )
    next_version = f"1.{(count_result.scalar() or 0)}"

    # Total strings in this published package = ALL active keys.
    # The gate above guarantees every active key has either an approved or an
    # already-published translation, so after promoting approved → published the
    # full set of active keys is covered.
    #
    # Formula: retained_from_prev - removed_inactive + new_translations
    #          = (active keys with prev published) - 0 + len(approved)
    #          = len(all_keys)          ← simplified, because gate ensures coverage
    active_key_ids = {k.id for k in all_keys}
    retained_count = len(active_key_ids & already_published_ids)
    new_count      = len(approved)
    total_strings  = len(all_keys)   # retained_count + new_count (= total active keys)

    pkg = LanguagePackage(
        language_code=language_code,
        version=next_version,
        status="published",
        published_at=datetime.now(timezone.utc),
        string_count=total_strings,
        published_by=current_user.email,
    )
    db.add(pkg)

    await write_translation_audit(
        db,
        event_type="package_published",
        lang_code=language_code,
        details={
            "version": next_version,
            "string_count": total_strings,
            "new_strings": new_count,
            "retained_strings": retained_count,
        },
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )

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
    pkgs_result = await db.execute(
        select(LanguagePackage).order_by(LanguagePackage.published_at.desc())
    )
    pkgs = pkgs_result.scalars().all()

    # Fallback for pre-fix rows that have string_count = NULL:
    # Count active string keys (the source of truth for what's in the current
    # package). This is only a valid approximation for the *currently published*
    # package — archived packages with a NULL count cannot be reconstructed
    # accurately, so we leave them as 0 rather than displaying a misleading number.
    active_key_count_result = await db.execute(
        select(func.count(StringKey.id)).where(StringKey.is_active == True)
    )
    active_key_count: int = active_key_count_result.scalar() or 0

    return [
        LanguagePackageListOut(
            id=str(p.id),
            language_code=p.language_code,
            version=p.version,
            status=p.status,
            published_at=p.published_at,
            created_at=p.created_at,
            # Use stored count when available. For legacy NULL rows: approximate
            # with active key count for the current published package only;
            # archived packages with no stored count show 0 (unknown).
            string_count=(
                p.string_count
                if p.string_count is not None
                else (active_key_count if p.status == "published" else 0)
            ),
            published_by=p.published_by,
        )
        for p in pkgs
    ]


# ── Utility: ensure Translation rows are in sync with StringKeys + Languages ──

async def ensure_string_keys_synced(db: AsyncSession) -> dict:
    """Ensures all active StringKey records have a Translation row for every
    active or protected Language.

    - Creates missing Translation rows with status='missing', translated_text=''.
    - Marks Translation rows whose StringKey is now inactive as status='retired'
      (does not delete them).

    Returns {"created": N, "retired": N}.
    """
    # All active string keys
    active_keys_result = await db.execute(
        select(StringKey).where(StringKey.is_active == True)
    )
    active_keys = active_keys_result.scalars().all()

    # All active or protected languages
    active_langs_result = await db.execute(
        select(Language).where(
            or_(Language.status == "active", Language.is_protected == True)
        )
    )
    active_langs = active_langs_result.scalars().all()

    if not active_keys or not active_langs:
        return {"created": 0, "retired": 0}

    active_key_ids = [k.id for k in active_keys]
    active_lang_codes = [l.code for l in active_langs]

    # Existing (string_key_id, language_code) pairs
    existing_result = await db.execute(
        select(Translation.string_key_id, Translation.language_code).where(
            Translation.string_key_id.in_(active_key_ids),
            Translation.language_code.in_(active_lang_codes),
        )
    )
    existing_pairs = {(row[0], row[1]) for row in existing_result.all()}

    # Create missing Translation rows
    created = 0
    for key in active_keys:
        for lang in active_langs:
            if (key.id, lang.code) not in existing_pairs:
                db.add(Translation(
                    string_key_id=key.id,
                    language_code=lang.code,
                    translated_text="",
                    status="missing",
                    translated_by="",
                ))
                created += 1

    # Retire translations whose StringKey is now inactive
    retired_result = await db.execute(
        select(Translation)
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            StringKey.is_active == False,
            Translation.status != "retired",
        )
    )
    retired_rows = retired_result.scalars().all()
    for t in retired_rows:
        t.status = "retired"
    retired = len(retired_rows)

    await db.commit()
    log.info("ensure_string_keys_synced: created=%d retired=%d", created, retired)
    return {"created": created, "retired": retired}


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

    # Auto-sync: create Translation rows for this new key in all active languages
    # TODO: call ensure_string_keys_synced after any StringKey retire operation
    await ensure_string_keys_synced(db)

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

# ── Helper: check edit lock ───────────────────────────────────────────────────

async def _assert_lock(request: Request, lang_code: str, caller_id: str) -> None:
    """Raise 409 if the caller does not hold the edit lock for lang_code."""
    redis = request.app.state.redis
    lock = await get_translation_lock(redis, lang_code)
    if not lock or lock["editor_id"] != caller_id:
        locked_by = lock["editor_name"] if lock else None
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "detail": "edit_lock_required",
                "locked_by": locked_by,
            },
        )
    await refresh_translation_lock_ttl(redis, lang_code)


# ── Translation lock endpoints ────────────────────────────────────────────────

class LockResponse(BaseModel):
    locked: bool
    locked_by: Optional[str] = None
    locked_at: Optional[str] = None


@translations_router.post("/lock/{lang_code}", response_model=LockResponse)
async def acquire_lang_lock(
    lang_code: str,
    request: Request,
    current_user=Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
) -> LockResponse:
    redis = request.app.state.redis
    acquired = await acquire_translation_lock(
        redis, lang_code, current_user.full_name, str(current_user.id)
    )
    if acquired:
        await write_translation_audit(
            db,
            event_type="edit_lock_acquired",
            lang_code=lang_code,
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
        return LockResponse(locked=True)

    existing = await get_translation_lock(redis, lang_code)
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "locked": False,
            "locked_by": existing["editor_name"] if existing else None,
            "locked_at": existing["locked_at"] if existing else None,
        },
    )


@translations_router.post("/unlock/{lang_code}", response_model=dict)
async def release_lang_lock(
    lang_code: str,
    request: Request,
    current_user=Depends(get_current_dashboard_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    redis = request.app.state.redis
    released = await release_translation_lock(redis, lang_code, str(current_user.id))
    if not released:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not hold the lock for this language.",
        )
    await write_translation_audit(
        db,
        event_type="edit_lock_released",
        lang_code=lang_code,
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.commit()
    return {"released": True}


@translations_router.post("/unlock/{lang_code}/admin", response_model=dict)
async def admin_release_lang_lock(
    lang_code: str,
    request: Request,
    current_user=Depends(require_superadmin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    redis = request.app.state.redis
    existing = await get_translation_lock(redis, lang_code)
    locked_by = existing["editor_name"] if existing else None
    await release_translation_lock_admin(redis, lang_code)
    await write_translation_audit(
        db,
        event_type="edit_lock_force_released",
        lang_code=lang_code,
        details={"was_locked_by": locked_by},
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.commit()
    return {"released": True, "was_locked_by": locked_by}


# ── Translation CRUD ──────────────────────────────────────────────────────────

class ApproveAllRequest(BaseModel):
    language_code: str


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


class RejectRequest(BaseModel):
    reason: str

    @field_validator("reason")
    @classmethod
    def validate_reason(cls, v: str) -> str:
        if len(v.strip()) < 5:
            raise ValueError("Rejection reason must be at least 5 characters.")
        return v.strip()


class RejectResponse(BaseModel):
    id: str
    status: str
    rejected_at: datetime
    rejection_reason: str


@translations_router.get("/queue-status")
async def get_queue_status(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> dict:
    result = await db.execute(
        select(
            Translation.language_code,
            Translation.status,
            func.count(Translation.id),
        )
        .where(Translation.status.in_(["draft", "failed"]))
        .group_by(Translation.language_code, Translation.status)
    )
    rows = result.all()

    lang_data: dict[str, dict] = {}
    for lang_code, st, count in rows:
        if lang_code not in lang_data:
            lang_data[lang_code] = {"draft_count": 0, "failed_count": 0}
        if st == "draft":
            lang_data[lang_code]["draft_count"] += count
        elif st == "failed":
            lang_data[lang_code]["failed_count"] += count

    # Get language names
    lang_result = await db.execute(select(Language))
    lang_name_map = {l.code: l.name for l in lang_result.scalars().all()}

    by_language = [
        {
            "lang_code": code,
            "lang_name": lang_name_map.get(code, code),
            "draft_count": data["draft_count"],
            "failed_count": data["failed_count"],
        }
        for code, data in sorted(lang_data.items())
    ]
    total_pending = sum(d["draft_count"] + d["failed_count"] for d in by_language)

    return {
        "has_pending": total_pending > 0,
        "total_pending": total_pending,
        "by_language": by_language,
        "batch_progress": next(iter(_translation_progress.values()), None),
    }


@translations_router.get("/unified-queue")
async def get_unified_queue(
    status_filter: str = "draft,failed",
    lang_code: Optional[str] = None,
    string_key: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> dict:
    statuses = [s.strip() for s in status_filter.split(",") if s.strip()]
    valid_statuses = {"draft", "failed", "approved", "published", "missing"}
    statuses = [s for s in statuses if s in valid_statuses]
    if not statuses:
        statuses = ["draft", "failed"]

    q = (
        select(
            Translation,
            StringKey.key.label("string_key"),
            StringKey.english_text.label("source_text"),
        )
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(Translation.status.in_(statuses))
    )
    if lang_code:
        q = q.where(Translation.language_code == lang_code)
    if string_key:
        q = q.where(StringKey.key.ilike(f"%{string_key}%"))
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            q = q.where(Translation.updated_at < cursor_dt)
        except ValueError:
            pass

    q = q.order_by(Translation.updated_at.desc()).limit(limit + 1)
    result = await db.execute(q)
    rows = result.all()

    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = rows[-1].Translation.updated_at.isoformat()

    items = [
        {
            "id": str(row.Translation.id),
            "lang_code": row.Translation.language_code,
            "string_key": row.string_key,
            "source_text": row.source_text,
            "translated_text": row.Translation.translated_text,
            "status": row.Translation.status,
            "updated_at": row.Translation.updated_at.isoformat(),
        }
        for row in rows
    ]
    return {"items": items, "next_cursor": next_cursor, "count": len(items)}


@translations_router.get("/audit-log")
async def get_audit_log(
    event_type: Optional[str] = None,
    lang_code: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> dict:
    from sqlalchemy import and_
    q = select(TranslationAuditLog)
    filters = []
    if event_type:
        filters.append(TranslationAuditLog.event_type == event_type)
    if lang_code:
        filters.append(TranslationAuditLog.lang_code == lang_code)
    if date_from:
        try:
            filters.append(TranslationAuditLog.created_at >= datetime.fromisoformat(date_from))
        except ValueError:
            pass
    if date_to:
        try:
            filters.append(TranslationAuditLog.created_at <= datetime.fromisoformat(date_to))
        except ValueError:
            pass
    if filters:
        q = q.where(and_(*filters))

    count_q = select(func.count()).select_from(q.subquery())
    total_result = await db.execute(count_q)
    total = total_result.scalar() or 0

    q = q.order_by(TranslationAuditLog.created_at.desc())
    q = q.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(q)
    entries = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "lang_code": e.lang_code,
                "string_key": e.string_key,
                "details": e.details,
                "performed_by": e.performed_by,
                "dashboard_user_id": e.dashboard_user_id,
                "created_at": e.created_at.isoformat(),
            }
            for e in entries
        ],
    }


@translations_router.post("/approve-all")
async def approve_all_translations(
    body: ApproveAllRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> dict:
    # Check edit lock — HTTP 423 per spec (distinct from the 409 used by _assert_lock)
    redis = request.app.state.redis
    lock = await get_translation_lock(redis, body.language_code)
    if not lock or lock["editor_id"] != str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Edit lock not held. Acquire the lock before approving.",
        )
    await refresh_translation_lock_ttl(redis, body.language_code)

    # Query all draft translations for this language
    result = await db.execute(
        select(Translation).where(
            Translation.language_code == body.language_code,
            Translation.status == "draft",
        )
    )
    drafts = result.scalars().all()

    if not drafts:
        return {"approved_count": 0, "message": "No pending translations to approve"}

    # Approve all and commit — audit log written separately so a log failure
    # does not roll back the approvals
    for t in drafts:
        t.status = "approved"
        t.reviewed_by = str(current_user.id)

    await db.commit()

    # Write one audit entry covering the bulk operation
    try:
        await write_translation_audit(
            db,
            event_type="translations_bulk_approved",
            lang_code=body.language_code,
            details={"count": len(drafts), "reviewed_by": current_user.full_name},
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
    except Exception as exc:
        log.error(
            "approve_all audit log write failed for %s: %s",
            body.language_code,
            exc,
        )

    return {
        "approved_count": len(drafts),
        "language_code": body.language_code,
        "message": f"{len(drafts)} strings approved",
    }


@translations_router.post("/sync-string-keys")
async def sync_string_keys(
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> dict:
    """Admin utility: ensure every active StringKey has a Translation row for
    every active/protected language. Idempotent — safe to run multiple times."""
    result = await ensure_string_keys_synced(db)
    log.info(
        "sync_string_keys called by %s: created=%d retired=%d",
        current_user.full_name,
        result["created"],
        result["retired"],
    )
    return result


@translations_router.get("/{language_code}", response_model=list[TranslationOut])
async def list_translations(
    language_code: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> list[TranslationOut]:
    keys_result = await db.execute(
        select(StringKey)
        .options(selectinload(StringKey.translations))
        .where(StringKey.is_active == True)
        .order_by(StringKey.key)
    )
    keys = keys_result.scalars().all()

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
                rejected_at=t.rejected_at if t else None,
                rejection_reason=t.rejection_reason if t else None,
                created_at=t.created_at if t else k.created_at,
                updated_at=t.updated_at if t else k.updated_at,
            )
        )
    return out


async def _run_auto_translation(language_code: str) -> None:
    async with AsyncSessionLocal() as db:
        try:
            missing_trans_result = await db.execute(
                select(Translation).where(
                    Translation.language_code == language_code,
                    Translation.status == "missing",
                )
            )
            missing_translations = missing_trans_result.scalars().all()
            if not missing_translations:
                return

            sk_ids = [t.string_key_id for t in missing_translations]
            sk_result = await db.execute(select(StringKey).where(StringKey.id.in_(sk_ids)))
            sk_map = {sk.id: sk for sk in sk_result.scalars().all()}

            trans_to_translate = [
                (t, sk_map[t.string_key_id])
                for t in missing_translations
                if t.string_key_id in sk_map
            ]
            if not trans_to_translate:
                return

            total_keys = len(trans_to_translate)
            translated = 0
            failed = 0
            errors: list[str] = []

            batches = [
                trans_to_translate[i:i + TRANSLATION_BATCH_SIZE]
                for i in range(0, total_keys, TRANSLATION_BATCH_SIZE)
            ]

            # Exponential backoff delays for 429/403 responses (seconds).
            # Concurrent requests flood public rate-limited APIs, so translations
            # are processed one-at-a-time; batches exist only for DB commit cadence.
            _BACKOFF = [5.0, 15.0, 45.0]

            async def _translate_single(key_id, key_name, english_text, target_lang) -> dict:
                last_exc: Exception | None = None
                for attempt in range(len(_BACKOFF) + 1):
                    if attempt > 0:
                        wait = _BACKOFF[attempt - 1]
                        log.warning(
                            "HTTP error translating %s (attempt %d/%d), retrying after %.0fs",
                            key_name, attempt, len(_BACKOFF), wait,
                        )
                        await asyncio.sleep(wait)
                    try:
                        t_text, svc = await translate_text(english_text, target_lang)
                        if svc == "libretranslate":
                            await asyncio.sleep(2.0)
                        return {"key_id": key_id, "key_name": key_name, "translated_text": t_text, "service_used": svc, "error": None}
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code in (429, 403):
                            last_exc = exc
                            continue
                        return {"key_id": key_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(exc)}
                    except Exception as exc:
                        return {"key_id": key_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(exc)}
                return {"key_id": key_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(last_exc)}

            for batch_idx, batch in enumerate(batches):
                _translation_progress[language_code] = {
                    "completed": batch_idx * TRANSLATION_BATCH_SIZE,
                    "total": total_keys,
                    "current_batch": batch_idx + 1,
                }

                trans_map_batch = {t.id: t for t, _ in batch}

                # Sequential — not concurrent — to avoid hammering public rate limits
                results = []
                for t, sk in batch:
                    results.append(await _translate_single(t.id, sk.key, sk.english_text, language_code))

                for result in results:
                    if result["error"]:
                        failed += 1
                        errors.append(f"{result['key_name']}: {result['error']}")
                        log.warning("auto_translate failed for key %s: %s", result["key_name"], result["error"])
                    else:
                        t_obj = trans_map_batch.get(result["key_id"])
                        if t_obj is not None:
                            t_obj.translated_text = result["translated_text"]
                            t_obj.status = "draft"
                            t_obj.translated_by = result["service_used"]
                            translated += 1
                            log.info("Translated key %s via %s", result["key_name"], result["service_used"])

                await db.commit()

            _translation_progress.pop(language_code, None)

            if translated > 0:
                await write_translation_audit(
                    db,
                    event_type="translation_auto_generated",
                    lang_code=language_code,
                    details={"translated": translated, "failed": failed},
                    performed_by="auto",
                    dashboard_user_id="",
                )
                await db.commit()
        except Exception as exc:
            _translation_progress.pop(language_code, None)
            log.error("_run_auto_translation background task failed for %s: %s", language_code, exc)


@translations_router.post("/auto-translate")
async def auto_translate(
    body: AutoTranslateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
) -> dict:
    missing_count_result = await db.execute(
        select(func.count(Translation.id)).where(
            Translation.language_code == body.language_code,
            Translation.status == "missing",
        )
    )
    missing_count = missing_count_result.scalar() or 0

    if missing_count == 0:
        return {"status": "no_op", "language_code": body.language_code, "translated": 0, "skipped": 0, "failed": 0}

    background_tasks.add_task(_run_auto_translation, body.language_code)
    return {"status": "translation_started", "language_code": body.language_code}


@translations_router.patch(
    "/{translation_id}/approve",
    response_model=ApproveResponse,
)
async def approve_translation(
    translation_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> ApproveResponse:
    result = await db.execute(
        select(Translation).where(Translation.id == translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation not found")
    if translation.status == "published":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Translation is already published — unpublish the package first to re-review",
        )

    await _assert_lock(request, translation.language_code, str(current_user.id))

    sk_result = await db.execute(
        select(StringKey).where(StringKey.id == translation.string_key_id)
    )
    sk = sk_result.scalar_one_or_none()

    translation.status = "approved"
    translation.reviewed_by = str(current_user.id)

    await write_translation_audit(
        db,
        event_type="translation_approved",
        lang_code=translation.language_code,
        string_key=sk.key if sk else None,
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.commit()

    return ApproveResponse(
        id=str(translation.id),
        status=translation.status,
        reviewed_by=translation.reviewed_by,
    )


@translations_router.patch(
    "/{translation_id}/reject",
    response_model=RejectResponse,
)
async def reject_translation(
    translation_id: str,
    body: RejectRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> RejectResponse:
    result = await db.execute(
        select(Translation).where(Translation.id == translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation not found")
    if translation.status == "published":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot reject a published translation",
        )

    await _assert_lock(request, translation.language_code, str(current_user.id))

    sk_result = await db.execute(
        select(StringKey).where(StringKey.id == translation.string_key_id)
    )
    sk = sk_result.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    translation.status = "failed"
    translation.rejected_at = now
    translation.rejection_reason = body.reason

    await write_translation_audit(
        db,
        event_type="translation_rejected",
        lang_code=translation.language_code,
        string_key=sk.key if sk else None,
        details={"reason": body.reason, "reviewer": current_user.full_name},
        performed_by=current_user.full_name,
        dashboard_user_id=str(current_user.id),
    )
    await db.commit()

    return RejectResponse(
        id=str(translation.id),
        status=translation.status,
        rejected_at=translation.rejected_at,
        rejection_reason=translation.rejection_reason,
    )


class TranslationUpdate(BaseModel):
    translated_text: str


class TranslationCreate(BaseModel):
    string_key: str
    language_code: str
    translated_text: str


@translations_router.patch(
    "/{translation_id}",
    response_model=TranslationOut,
)
async def update_translation(
    translation_id: str,
    body: TranslationUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> TranslationOut:
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

    await _assert_lock(request, translation.language_code, str(current_user.id))

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
        rejected_at=translation.rejected_at,
        rejection_reason=translation.rejection_reason,
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> TranslationOut:
    await _assert_lock(request, body.language_code, str(current_user.id))

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
        rejected_at=t.rejected_at,
        rejection_reason=t.rejection_reason,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


# ── Regenerate endpoints ──────────────────────────────────────────────────────

class RegenerateSingleRequest(BaseModel):
    translation_id: str
    language_code: str


class RegenerateAllDraftRequest(BaseModel):
    language_code: str


@translations_router.post("/regenerate-single", response_model=TranslationOut)
async def regenerate_single_translation(
    body: RegenerateSingleRequest,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> TranslationOut:
    """Retranslate a single draft translation using the translation service."""
    result = await db.execute(
        select(Translation).where(Translation.id == body.translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation not found")

    sk_result = await db.execute(
        select(StringKey).where(StringKey.id == translation.string_key_id)
    )
    sk = sk_result.scalar_one_or_none()
    if not sk:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="String key not found")

    try:
        t_text, service_used = await translate_text(sk.english_text, body.language_code)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Translation service error: {exc}",
        )

    translation.translated_text = t_text
    translation.status = "draft"
    translation.translated_by = service_used

    await db.commit()
    await db.refresh(translation)

    return TranslationOut(
        id=str(translation.id),
        string_key=sk.key,
        english_text=sk.english_text,
        translated_text=translation.translated_text,
        status=translation.status,
        translated_by=translation.translated_by,
        reviewed_by=translation.reviewed_by,
        rejected_at=translation.rejected_at,
        rejection_reason=translation.rejection_reason,
        created_at=translation.created_at,
        updated_at=translation.updated_at,
    )


@translations_router.post("/regenerate-all-draft")
async def regenerate_all_draft_translations(
    body: RegenerateAllDraftRequest,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> dict:
    """Retranslate all draft translations for a language in batches."""
    result = await db.execute(
        select(Translation).where(
            Translation.language_code == body.language_code,
            Translation.status == "draft",
        )
    )
    drafts = result.scalars().all()

    if not drafts:
        return {"regenerated_count": 0, "language_code": body.language_code}

    sk_ids = [d.string_key_id for d in drafts]
    sk_result = await db.execute(select(StringKey).where(StringKey.id.in_(sk_ids)))
    sk_map = {sk.id: sk for sk in sk_result.scalars().all()}

    regenerated = 0
    batches = [
        drafts[i:i + TRANSLATION_BATCH_SIZE]
        for i in range(0, len(drafts), TRANSLATION_BATCH_SIZE)
    ]

    async def _regen_single(t: Translation) -> bool:
        sk = sk_map.get(t.string_key_id)
        if not sk:
            return False
        try:
            t_text, service_used = await translate_text(sk.english_text, body.language_code)
            t.translated_text = t_text
            t.translated_by = service_used
            return True
        except Exception as exc:
            log.warning("regenerate_all_draft failed for key %s: %s", sk.key, exc)
            return False

    for batch in batches:
        results = await asyncio.gather(*[_regen_single(t) for t in batch])
        regenerated += sum(1 for r in results if r)
        await db.commit()

    return {"regenerated_count": regenerated, "language_code": body.language_code}


# ── Seed data ─────────────────────────────────────────────────────────────────

_SEED_KEYS: list[tuple[str, str, str]] = [
    ("Q1_LABEL",       "question", "How bad is the damage?"),
    ("Q1_OPT_MINIMAL", "answer",   "Minimal / No damage"),
    ("Q1_OPT_PARTIAL", "answer",   "Partially damaged"),
    ("Q1_OPT_COMPLETE","answer",   "Completely damaged"),
    ("Q2_LABEL",              "question", "What type of infrastructure is this?"),
    ("Q2_OPT_RESIDENTIAL",    "answer",   "Residential Infrastructure"),
    ("Q2_OPT_COMMERCIAL",     "answer",   "Commercial Infrastructure"),
    ("Q2_OPT_GOVERNMENT",     "answer",   "Government Building"),
    ("Q2_OPT_UTILITY",        "answer",   "Utility Infrastructure"),
    ("Q2_OPT_TRANSPORT_COMM", "answer",   "Transport and Communication Infrastructure"),
    ("Q2_OPT_COMMUNITY",      "answer",   "Community Infrastructure"),
    ("Q2_OPT_PUBLIC_SPACES",  "answer",   "Public Spaces / Recreation Infrastructure"),
    ("Q2_OPT_OTHER",          "answer",   "Other (please specify)"),
    ("Q3_LABEL", "question", "What is the name of this infrastructure?"),
    ("Q4_LABEL",          "question", "What type of disaster caused this damage?"),
    ("Q4_OPT_EARTHQUAKE", "answer",   "Earthquake"),
    ("Q4_OPT_FLOOD",      "answer",   "Flood"),
    ("Q4_OPT_CYCLONE",    "answer",   "Cyclone / Typhoon / Hurricane"),
    ("Q4_OPT_LANDSLIDE",  "answer",   "Landslide"),
    ("Q4_OPT_FIRE",       "answer",   "Fire"),
    ("Q4_OPT_CONFLICT",   "answer",   "Conflict / War"),
    ("Q4_OPT_OTHER",      "answer",   "Other"),
    ("Q5_LABEL",         "question", "Is there debris blocking access?"),
    ("Q5_OPT_YES",       "answer",   "Yes"),
    ("Q5_OPT_NO",        "answer",   "No"),
    ("Q5_OPT_PARTIALLY", "answer",   "Partially"),
    ("Q6_LABEL",           "question", "What is the current condition of electricity infrastructure in your community following the crisis?"),
    ("Q6_OPT_NO_DAMAGE",   "answer",   "No damage observed"),
    ("Q6_OPT_MINOR",       "answer",   "Minor damage — service disruptions but quickly repairable"),
    ("Q6_OPT_MODERATE",    "answer",   "Moderate damage — partial outages requiring repairs"),
    ("Q6_OPT_SEVERE",      "answer",   "Severe damage — major infrastructure damaged, prolonged outages"),
    ("Q6_OPT_DESTROYED",   "answer",   "Completely destroyed — no electricity infrastructure functioning"),
    ("Q6_OPT_UNKNOWN",     "answer",   "Unknown / cannot be assessed"),
    ("Q7_LABEL",                    "question", "How would you rate the overall functioning of health services in your community since the event?"),
    ("Q7_OPT_FULLY_FUNCTIONAL",     "answer",   "Fully functional"),
    ("Q7_OPT_PARTIALLY_FUNCTIONAL", "answer",   "Partially functional"),
    ("Q7_OPT_LARGELY_DISRUPTED",    "answer",   "Largely disrupted"),
    ("Q7_OPT_NOT_FUNCTIONING",      "answer",   "Not functioning at all"),
    ("Q7_OPT_UNKNOWN",              "answer",   "Unknown"),
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

    # ── Navigation / global chrome ────────────────────────────────────────────────
    ("NAV_HOME",            "ui_nav",   "Home"),
    ("NAV_MAP",             "ui_nav",   "Map"),
    ("NAV_REPORTS",         "ui_nav",   "Reports"),

    # ── Common / shared UI ────────────────────────────────────────────────────────
    ("COMMON_LOADING",              "ui_common", "Loading..."),
    ("COMMON_LOADING_COUNTRIES",    "ui_common", "Loading countries…"),
    ("COMMON_RETRY",                "ui_common", "Retry"),
    ("COMMON_CANCEL",               "ui_common", "Cancel"),
    ("COMMON_CONFIRM",              "ui_common", "Confirm"),
    ("COMMON_BACK",                 "ui_common", "← Back"),
    ("COMMON_NEXT",                 "ui_common", "Next →"),
    ("COMMON_PREVIOUS",             "ui_common", "← Previous"),
    ("COMMON_EDIT",                 "ui_common", "Edit"),
    ("COMMON_OPTIONAL",             "ui_common", "Optional"),
    ("COMMON_SAVING",               "ui_common", "Saving…"),
    ("COMMON_GO_BACK",              "ui_common", "Go Back"),
    ("COMMON_GO_HOME",              "ui_common", "Go to Home"),
    ("COMMON_GOT_IT",               "ui_common", "Got it"),
    ("COMMON_REFRESH",              "ui_common", "Refresh"),

    # ── Terms & Conditions ────────────────────────────────────────────────────────
    ("TERMS_TITLE",         "ui_terms", "Terms and Conditions"),
    ("TERMS_SUBTITLE",      "ui_terms", "Please read and accept the terms below to continue."),
    ("TERMS_ERROR",         "ui_terms", "You must accept the Terms and Conditions to continue."),
    ("TERMS_AGREE",         "ui_terms", "I Agree"),
    ("TERMS_DECLINE",       "ui_terms", "Decline"),
    ("TERMS_PRIVACY",       "ui_terms", "Your data is secured by UNDP Privacy Protocols"),

    # ── Onboarding ────────────────────────────────────────────────────────────────
    ("ONBOARDING_SELECT_COUNTRY",       "ui_onboarding", "Select Your Country"),
    ("ONBOARDING_SELECT_LANGUAGE",      "ui_onboarding", "Select Language"),
    ("ONBOARDING_COUNTRY_PLACEHOLDER",  "ui_onboarding", "Search for your country..."),
    ("ONBOARDING_INACTIVE",             "ui_onboarding", "We are unable to provide any assistance for your region at this moment"),
    ("ONBOARDING_CONTINUE",             "ui_onboarding", "Continue"),
    ("ONBOARDING_MORE_LANGUAGES_TITLE", "ui_onboarding", "More languages"),
    ("ONBOARDING_MORE_LANGUAGES_BTN",   "ui_onboarding", "+ More"),
    ("ONBOARDING_SHOW_LESS",            "ui_onboarding", "Show less"),
    ("ONBOARDING_LANG_LOAD_ERROR",      "ui_onboarding", "Could not load language. Check your connection and try again."),

    # ── Home screen ───────────────────────────────────────────────────────────────
    ("HOME_REPORT_BUTTON",      "ui_home", "Report an Incident"),
    ("HOME_QUEUED_REPORTS",     "ui_home", "{{count}} report(s) waiting to sync"),
    ("HOME_MY_REPORTS",         "ui_home", "My Reports"),
    ("HOME_NO_REPORTS_TITLE",   "ui_home", "No reports yet"),
    ("HOME_NO_REPORTS_BODY",    "ui_home", "Your submitted reports will appear here"),
    ("HOME_RECENT_REPORTS",     "ui_home", "YOUR RECENT REPORTS"),

    # ── Report form ───────────────────────────────────────────────────────────────
    ("REPORT_TITLE",            "ui_report", "Report Damage"),
    ("REPORT_SUBMIT",           "ui_report", "Submit Report"),
    ("REPORT_SUBMITTING",       "ui_report", "Submitting..."),
    ("REPORT_SUCCESS",          "ui_report", "Report submitted successfully"),
    ("REPORT_ERROR",            "ui_report", "Failed to submit report. Please try again."),
    ("REPORT_QUEUED",           "ui_report", "Report saved. Will sync when internet is available."),
    ("REPORT_PHOTO_REQUIRED",   "ui_report", "At least one photo is required"),
    ("REPORT_MAX_PHOTOS",       "ui_report", "Maximum 3 photos per report"),
    ("REPORT_ADD_PHOTO",        "ui_report", "Add Photo"),
    ("REPORT_TAKE_PHOTO",       "ui_report", "Take a Photo"),
    ("REPORT_UPLOAD_PHOTO",     "ui_report", "Upload from Gallery"),
    ("REPORT_GPS_BUTTON",       "ui_report", "Use My GPS Location"),
    ("REPORT_GPS_GETTING",      "ui_report", "Getting location…"),
    ("REPORT_SELECT_BUILDING",  "ui_report", "Select building on map"),
    ("REPORT_SUBMIT_ANOTHER",   "ui_report", "Submit Another Report"),
    ("REPORT_REVIEW_TITLE",     "ui_report", "Review Your Report"),
    ("REPORT_DUPE_TITLE",       "ui_report", "Possible duplicate report"),
    ("REPORT_DUPE_SUBMIT",      "ui_report", "Submit anyway"),
    ("REPORT_NO_CRISIS",        "ui_report", "No active crisis found. Please try again later."),

    # ── Settings ──────────────────────────────────────────────────────────────────
    ("SETTINGS_TITLE",          "ui_settings", "Settings"),
    ("SETTINGS_LANGUAGE",       "ui_settings", "Language"),
    ("SETTINGS_COUNTRY",        "ui_settings", "Country"),
    ("SETTINGS_ACCOUNT",        "ui_settings", "Account"),
    ("SETTINGS_LOGIN",          "ui_settings", "Log In"),
    ("SETTINGS_REGISTER",       "ui_settings", "Create Account"),
    ("SETTINGS_LOGOUT",         "ui_settings", "Log Out"),
    ("SETTINGS_CHANGE_COUNTRY", "ui_settings", "Change Country"),
    ("SETTINGS_CHANGE_LANGUAGE","ui_settings", "Change Language"),
    ("SETTINGS_PRIVACY_POLICY", "ui_settings", "Privacy Policy"),

    # ── Offline / connectivity ────────────────────────────────────────────────────
    ("OFFLINE_BANNER",  "ui_offline", "You are offline. Reports will be saved and sent when you reconnect."),
    ("OFFLINE_SYNCING", "ui_offline", "Syncing your reports..."),

    # ── Error messages ────────────────────────────────────────────────────────────
    ("ERROR_REQUIRED",       "ui_error", "This field is required"),
    ("ERROR_NETWORK",        "ui_error", "Network error. Please check your connection."),
    ("ERROR_UNKNOWN",        "ui_error", "Something went wrong. Please try again."),
    ("ERROR_NO_INTERNET",    "ui_error", "No internet connection. Please check your connection and try again."),
    ("ERROR_TIMEOUT",        "ui_error", "This is taking longer than expected. Please try again."),

    # ── Profile ───────────────────────────────────────────────────────────────────
    ("PROFILE_TITLE",           "ui_profile", "My Profile"),
    ("PROFILE_ANONYMOUS",       "ui_profile", "Anonymous Reporter"),
    ("PROFILE_FIRST_NAME",      "ui_profile", "First Name"),
    ("PROFILE_LAST_NAME",       "ui_profile", "Last Name"),
    ("PROFILE_EMAIL",           "ui_profile", "Email Address"),
    ("PROFILE_PHONE",           "ui_profile", "Phone Number"),
    ("PROFILE_SAVE_BTN",        "ui_profile", "Save Profile"),
    ("PROFILE_SAVE_SUCCESS",    "ui_profile", "Profile saved"),
    ("PROFILE_SAVE_ERROR",      "ui_profile", "Could not save profile. Please try again."),
    ("PROFILE_ANON_GATE",       "ui_profile", "Create a free account to save your profile and earn badges."),

    # ── Login ─────────────────────────────────────────────────────────────────────
    ("LOGIN_TITLE",             "ui_login", "Sign In"),
    ("LOGIN_EMAIL_LABEL",       "ui_login", "Email"),
    ("LOGIN_PASSWORD_LABEL",    "ui_login", "Password"),
    ("LOGIN_SUBMIT_BTN",        "ui_login", "Sign In"),
    ("LOGIN_SIGNING_IN",        "ui_login", "Signing in…"),
    ("LOGIN_INVALID_CREDENTIALS","ui_login","Invalid email or password."),
    ("LOGIN_NO_ACCOUNT",        "ui_login", "Don't have an account?"),

    # ── My Reports ────────────────────────────────────────────────────────────────
    ("MY_REPORTS_EMPTY_TITLE",  "ui_my_reports", "No reports submitted yet"),
    ("MY_REPORTS_LOAD_ERROR",   "ui_my_reports", "Failed to load reports. Please try again."),
    ("MY_REPORTS_LOAD_MORE",    "ui_my_reports", "Load More"),
    ("MY_REPORTS_LABEL_DAMAGE", "ui_my_reports", "Damage Level:"),
    ("MY_REPORTS_LABEL_DATE",   "ui_my_reports", "Date:"),
    ("MY_REPORTS_LABEL_STATUS", "ui_my_reports", "Status:"),

    # ── Safety Tips UI ────────────────────────────────────────────────────────────
    ("SAFETY_TITLE",            "ui_safety", "Safety Tips"),
    ("SAFETY_DO",               "ui_safety", "DO"),
    ("SAFETY_DONT",             "ui_safety", "DON'T"),
    ("SAFETY_MARK_COMPLETE",    "ui_safety", "Mark as Complete"),
    ("SAFETY_COMPLETED",        "ui_safety", "✓ Completed"),
    ("SAFETY_PART_B_TITLE",     "ui_safety", "Reporting Guidelines"),
    ("SAFETY_PART_C_TITLE",     "ui_safety", "First Aid Essentials"),
    ("SAFETY_SLIDE_PROGRESS",   "ui_safety", "Slide {{n}} of {{total}}"),

    # ── Badges ────────────────────────────────────────────────────────────────────
    ("BADGES_TITLE",            "ui_badges", "Badges & Certifications"),
    ("BADGES_ANON_HEADING",     "ui_badges", "Badges are available to reporters with a verified account."),
    ("BADGES_ANON_BODY",        "ui_badges", "Log in or create a free account to earn and view your badges."),
    ("BADGES_STATUS_EARNED",    "ui_badges", "Earned ✓"),
    ("BADGES_STATUS_LOCKED",    "ui_badges", "Locked"),
    ("BADGES_SAFETY_NAME",      "ui_badges", "Safety Training Completion"),
    ("BADGES_SAFETY_DESC",      "ui_badges", "Complete all safety training modules in Crisis Reporter."),
    ("BADGES_REFERRAL_NAME",    "ui_badges", "Community Referral"),

    # ── Disaster type labels (for display in UI) ─────────────────────────────────
    ("DISASTER_EARTHQUAKE",         "disaster_label", "Earthquake"),
    ("DISASTER_FLOOD",              "disaster_label", "Flood"),
    ("DISASTER_TSUNAMI",            "disaster_label", "Tsunami"),
    ("DISASTER_HURRICANE_CYCLONE",  "disaster_label", "Hurricane or Cyclone"),
    ("DISASTER_WILDFIRE",           "disaster_label", "Wildfire"),
    ("DISASTER_EXPLOSION",          "disaster_label", "Explosion"),
    ("DISASTER_CHEMICAL_INCIDENT",  "disaster_label", "Chemical Incident"),
    ("DISASTER_CONFLICT",           "disaster_label", "Conflict"),
    ("DISASTER_CIVIL_UNREST",       "disaster_label", "Civil Unrest"),

    # ── Dotted-path keys — match en.json structure used by web/mobile pages ──────
    # The original UPPERCASE keys above were not resolvable by i18next dot-path
    # lookups (t("home.reportButton") ≠ "HOME_REPORT_BUTTON"). These dotted keys
    # are returned by the backend and unflattened into nested objects by i18n.ts
    # so the existing t() calls in all pages resolve correctly without page changes.
    # UPPERCASE safety/common keys stay UPPERCASE (SafetyTipsPage calls them that way).

    # nav
    ("nav.home",    "ui_nav", "Home"),
    ("nav.map",     "ui_nav", "Map"),
    ("nav.reports", "ui_nav", "Reports"),

    # common
    ("common.loading",            "ui_common", "Loading..."),
    ("common.loading_countries",  "ui_common", "Loading countries…"),
    ("common.retry",              "ui_common", "Retry"),
    ("common.cancel",             "ui_common", "Cancel"),
    ("common.confirm",            "ui_common", "Confirm"),
    ("common.back",               "ui_common", "← Back"),
    ("common.next",               "ui_common", "Next →"),
    ("common.previous",           "ui_common", "← Previous"),
    ("common.edit",               "ui_common", "Edit"),
    ("common.optional",           "ui_common", "Optional"),
    ("common.saving",             "ui_common", "Saving…"),
    ("common.go_back",            "ui_common", "Go Back"),
    ("common.go_home",            "ui_common", "Go to Home"),
    ("common.got_it",             "ui_common", "Got it"),
    ("common.refresh",            "ui_common", "Refresh"),

    # app chrome
    ("app.name", "ui_common", "Crisis Reporter"),

    # terms & conditions (onboarding flow)
    ("terms.title",    "ui_terms", "Terms and Conditions"),
    ("terms.subtitle", "ui_terms", "Please read and accept the terms below to continue."),
    ("terms.error",    "ui_terms", "You must accept the Terms and Conditions to continue."),
    ("terms.agree",    "ui_terms", "I Agree"),
    ("terms.decline",  "ui_terms", "Decline"),
    ("terms.privacy",  "ui_terms", "Your data is secured by UNDP Privacy Protocols"),

    # onboarding
    ("onboarding.selectCountry",       "ui_onboarding", "Select Your Country"),
    ("onboarding.selectLanguage",      "ui_onboarding", "Select Language"),
    ("onboarding.countryPlaceholder",  "ui_onboarding", "Search for your country..."),
    ("onboarding.inactive",            "ui_onboarding", "We are unable to provide any assistance for your region at this moment"),
    ("onboarding.continue",            "ui_onboarding", "Continue"),
    ("onboarding.more_languages_title","ui_onboarding", "More languages"),
    ("onboarding.more_languages_btn",  "ui_onboarding", "+ More"),
    ("onboarding.show_less",           "ui_onboarding", "Show less"),
    ("onboarding.lang_load_error",     "ui_onboarding", "Could not load language. Check your connection and try again."),

    # home screen
    ("home.reportButton",    "ui_home", "Report an Incident"),
    ("home.myReports",       "ui_home", "My Reports"),
    ("home.noReportsTitle",  "ui_home", "No reports yet"),
    ("home.noReportsBody",   "ui_home", "Your submitted reports will appear here"),
    ("home.recentReports",   "ui_home", "YOUR RECENT REPORTS"),
    ("home.queuedReports",   "ui_home", "{{count}} report(s) waiting to sync"),
    ("home.loadingReports",  "ui_home", "Loading your reports..."),
    ("home.pendingSync",     "ui_home", "Pending Sync"),
    ("home.offline",         "ui_home", "Offline"),
    ("home.unknownLocation", "ui_home", "Unknown location"),
    ("home.unnamedLocation", "ui_home", "Unnamed location"),
    ("home.firstReportHint", "ui_home", "Tap \"Report an Incident\" to submit your first report"),
    ("home.welcomeText",     "ui_home", "Crisis Reporter helps you document damage to buildings and infrastructure after a disaster. You can report earthquakes, floods, conflicts, and other crises. Your reports help UNDP get help to the right places faster."),
    ("home.welcomeGotIt",    "ui_home", "Got it"),
    ("home.whatCanReport",   "ui_home", "What can I report?"),

    # login prompt (home screen modal)
    ("loginPrompt.title",      "ui_home", "Have you used Crisis Reporter before?"),
    ("loginPrompt.body",       "ui_home", "If you have an existing verified account, log in to restore your reports, badges, and profile."),
    ("loginPrompt.settingUp",  "ui_home", "Setting up…"),
    ("loginPrompt.skip",       "ui_home", "Skip for now"),

    # settings
    ("settings.title",            "ui_settings", "Settings"),
    ("settings.language",         "ui_settings", "Language"),
    ("settings.country",          "ui_settings", "Country"),
    ("settings.account",          "ui_settings", "Account"),
    ("settings.login",            "ui_settings", "Log In"),
    ("settings.register",         "ui_settings", "Create Account"),
    ("settings.logout",           "ui_settings", "Log Out"),
    ("settings.section_account",  "ui_settings", "ACCOUNT"),
    ("settings.section_about",    "ui_settings", "ABOUT"),
    ("settings.section_session",  "ui_settings", "SESSION"),
    ("settings.change_country",   "ui_settings", "Change Country"),
    ("settings.change_language",  "ui_settings", "Change Language"),
    ("settings.version",          "ui_settings", "Version"),
    ("settings.privacy_policy",   "ui_settings", "Privacy Policy"),
    ("settings.search_countries", "ui_settings", "Search countries..."),
    ("settings.no_countries_match","ui_settings","No countries match your search."),
    ("settings.select_language",  "ui_settings", "Select Language"),
    ("settings.lang_load_error",  "ui_settings", "Could not load the language package. Please check your connection and try again."),
    ("settings.lang_cache_note",  "ui_settings", "Using saved language data. Some text may not be fully updated."),

    # offline / connectivity
    ("offline.banner",  "ui_offline", "You are offline. Reports will be saved and sent when you reconnect."),
    ("offline.syncing", "ui_offline", "Syncing your reports..."),

    # error messages
    ("errors.required",     "ui_error", "This field is required"),
    ("errors.networkError", "ui_error", "Network error. Please check your connection."),
    ("errors.unknownError", "ui_error", "Something went wrong. Please try again."),

    # profile
    ("profile.title",              "ui_profile", "My Profile"),
    ("profile.anonymous",          "ui_profile", "Anonymous Reporter"),
    ("profile.first_name",         "ui_profile", "First Name"),
    ("profile.last_name",          "ui_profile", "Last Name"),
    ("profile.email",              "ui_profile", "Email Address"),
    ("profile.phone",              "ui_profile", "Phone Number"),
    ("profile.save_btn",           "ui_profile", "Save Profile"),
    ("profile.save_success",       "ui_profile", "Profile saved"),
    ("profile.save_error",         "ui_profile", "Could not save profile. Please try again."),
    ("profile.anon_gate_heading",  "ui_profile", "Create a free account to save your profile and earn badges."),
    ("profile.anon_gate_subtext",  "ui_profile", "You can still submit reports anonymously without an account."),
    ("profile.anon_note",          "ui_profile", "All profile fields are optional. You can submit reports anonymously."),
    ("profile.edit_photo",         "ui_profile", "Edit photo"),
    ("profile.completion_label",   "ui_profile", "Profile {{completion}}% complete"),

    # login
    ("login.title",               "ui_login", "Sign In"),
    ("login.email_label",         "ui_login", "Email"),
    ("login.password_label",      "ui_login", "Password"),
    ("login.submit_btn",          "ui_login", "Sign In"),
    ("login.signing_in",          "ui_login", "Signing in…"),
    ("login.validation",          "ui_login", "Please enter your email and password."),
    ("login.invalid_credentials", "ui_login", "Invalid email or password."),
    ("login.no_account",          "ui_login", "Don't have an account?"),
    ("login.setup_profile",       "ui_login", "Set up your profile →"),

    # my reports
    ("my_reports.empty_title",     "ui_my_reports", "No reports submitted yet"),
    ("my_reports.load_error",      "ui_my_reports", "Failed to load reports. Please try again."),
    ("my_reports.load_more",       "ui_my_reports", "Load More"),
    ("my_reports.label_location",  "ui_my_reports", "Location:"),
    ("my_reports.label_damage",    "ui_my_reports", "Damage Level:"),
    ("my_reports.label_date",      "ui_my_reports", "Date:"),
    ("my_reports.label_status",    "ui_my_reports", "Status:"),
    ("my_reports.login_prompt",    "ui_my_reports", "Log in to see all your reports across sessions and devices."),
    ("my_reports.session_note",    "ui_my_reports", "Showing reports from this session. Log in to see your full history."),
    ("my_reports.damage_complete", "ui_my_reports", "Completely Damaged"),
    ("my_reports.damage_partial",  "ui_my_reports", "Partially Damaged"),
    ("my_reports.damage_minimal",  "ui_my_reports", "Minimal / No Damage"),
    ("my_reports.status_submitted","ui_my_reports", "✓ Submitted"),
    ("my_reports.detail_title",    "ui_my_reports", "Report Details"),
    ("my_reports.back",            "ui_my_reports", "← Back to My Reports"),
    ("my_reports.loading_detail",  "ui_my_reports", "Loading report details…"),
    ("my_reports.description",     "ui_my_reports", "Description"),
    ("my_reports.report_number",   "ui_my_reports", "Report #{{n}}"),

    # stepper
    ("stepper.step_photo",     "ui_stepper", "Photo"),
    ("stepper.step_location",  "ui_stepper", "Location"),
    ("stepper.step_questions", "ui_stepper", "Questions"),
    ("stepper.step_review",    "ui_stepper", "Review"),
    ("stepper.step_submit",    "ui_stepper", "Submit"),

    # side menu
    ("menu.safety_tips", "ui_menu", "Safety Tips"),
    ("menu.profile",     "ui_menu", "Reporter Profile"),

    # faq / about
    ("faq.title",   "ui_about", "FAQ"),
    ("about.title", "ui_about", "About Crisis Reporter"),

    # badges (dotted — BADGES_* UPPERCASE kept for mobile)
    ("badges.title",          "ui_badges", "Badges & Certifications"),
    ("badges.anon_heading",   "ui_badges", "Badges are available to reporters with a verified account."),
    ("badges.anon_body",      "ui_badges", "Log in or create a free account to earn and view your badges."),
    ("badges.subtitle",       "ui_badges", "Badges are awarded to reporters with a verified profile. Complete your profile to unlock badges."),
    ("badges.status_earned",  "ui_badges", "Earned ✓"),
    ("badges.status_claim",   "ui_badges", "Add email or phone to claim"),
    ("badges.status_locked",  "ui_badges", "Locked"),
    ("badges.status_coming_soon","ui_badges","Coming Soon"),
    ("badges.safety_name",    "ui_badges", "Safety Training Completion"),
    ("badges.safety_desc_locked","ui_badges","Complete all safety training modules in Crisis Reporter."),
    ("badges.referral_name",  "ui_badges", "Community Referral"),
    ("badges.modules_progress","ui_badges","{{n}} of {{total}} modules complete"),

    # safety tabs (dotted — t("safety.*") calls in SafetyTipsPage tab labels)
    ("safety.tab_a",            "ui_safety", "Part A: Disaster Tips"),
    ("safety.tab_b",            "ui_safety", "Part B: Reporting"),
    ("safety.tab_c",            "ui_safety", "Part C: First Aid"),
    ("safety.complete",         "ui_safety", "✓ Complete"),
    ("safety.progress_label",   "ui_safety", "Disaster types completed"),
    ("safety.all_complete_banner","ui_safety","Safety Training Complete — you are now eligible for the Safety Training Badge"),

    # disaster type labels (dotted — used in dropdowns / display)
    ("disaster_types.earthquake",       "disaster_label", "Earthquake"),
    ("disaster_types.flood",            "disaster_label", "Flood"),
    ("disaster_types.tsunami",          "disaster_label", "Tsunami"),
    ("disaster_types.hurricane_cyclone","disaster_label", "Hurricane or Cyclone"),
    ("disaster_types.wildfire",         "disaster_label", "Wildfire"),
    ("disaster_types.explosion",        "disaster_label", "Explosion"),
    ("disaster_types.chemical_incident","disaster_label", "Chemical Incident"),
    ("disaster_types.conflict",         "disaster_label", "Conflict"),
    ("disaster_types.civil_unrest",     "disaster_label", "Civil Unrest"),

    # report form (most-used strings)
    ("report.title",             "ui_report", "Report Damage"),
    ("report.damageLevel",       "ui_report", "Damage Level"),
    ("report.minimal",           "ui_report", "Minimal or No Damage"),
    ("report.partial",           "ui_report", "Partially Damaged"),
    ("report.complete",          "ui_report", "Completely Destroyed"),
    ("report.infrastructureType","ui_report", "Infrastructure Type"),
    ("report.residential",       "ui_report", "Residential Building"),
    ("report.commercial",        "ui_report", "Commercial Building"),
    ("report.school",            "ui_report", "School"),
    ("report.hospital",          "ui_report", "Hospital"),
    ("report.road",              "ui_report", "Road or Bridge"),
    ("report.other",             "ui_report", "Other"),
    ("report.description",       "ui_report", "Description (optional)"),
    ("report.photos",            "ui_report", "Photos"),
    ("report.addPhoto",          "ui_report", "Add Photo"),
    ("report.takePhoto",         "ui_report", "Take a Photo"),
    ("report.uploadPhoto",       "ui_report", "Upload from Gallery"),
    ("report.photoRequired",     "ui_report", "At least one photo is required"),
    ("report.maxPhotos",         "ui_report", "Maximum 3 photos per report"),
    ("report.location",          "ui_report", "Location"),
    ("report.submit",            "ui_report", "Submit Report"),
    ("report.submitting",        "ui_report", "Submitting..."),
    ("report.queued",            "ui_report", "Report saved. Will sync when internet is available."),
    ("report.success",           "ui_report", "Report submitted successfully"),
    ("report.error",             "ui_report", "Failed to submit report. Please try again."),
    ("report.success_title",     "ui_report", "Report Submitted"),
    ("report.submit_another",    "ui_report", "Submit Another Report"),
    ("report.review_title",      "ui_report", "Review Your Report"),
    ("report.dupe_title",        "ui_report", "Possible duplicate report"),
    ("report.dupe_body",         "ui_report", "It looks like you have already submitted a report for this location. Are you sure you want to submit another?"),
    ("report.dupe_submit_anyway","ui_report", "Submit anyway"),
    ("report.no_crisis",         "ui_report", "No active crisis found. Please try again later."),
    ("report.gps_button",        "ui_report", "Use My GPS Location"),
    ("report.gps_getting",       "ui_report", "Getting location…"),
    ("report.selectBuilding",    "ui_report", "Select building on map"),
    ("report.back_to_review",    "ui_report", "Back to Review without changes"),
    ("report.select_at_least_one","ui_report","Select all that apply. At least one required."),

    # map
    ("map.loading",          "ui_map", "Loading map..."),
    ("map.selectLocation",   "ui_map", "Tap a building to select it"),
    ("map.searchPlaceholder","ui_map", "Search for a location..."),
    ("map.zoom_hint",        "ui_map", "Zoom in to see buildings"),
    ("map.damage_complete",  "ui_map", "Completely Damaged"),
    ("map.damage_partial",   "ui_map", "Partially Damaged"),
    ("map.damage_minimal",   "ui_map", "Minimal / No Damage"),
    ("map.loading_reports",  "ui_map", "Loading reports…"),

    # photo step guidelines
    ("photo_guidelines.guideline_1","ui_report","Make sure the damage is clearly visible in the photo"),
    ("photo_guidelines.guideline_2","ui_report","Avoid photos that are too dark or blurry"),
    ("photo_guidelines.guideline_3","ui_report","Take the photo from a safe distance — do not put yourself at risk"),
    ("photo_guidelines.guideline_4","ui_report","Include the full structure in the frame where possible"),

    # report step labels + photo tips (visible in photos/location steps)
    ("report.step_1_of_5",        "ui_report", "STEP 1 OF 5 — ADD PHOTO"),
    ("report.step_2_of_5",        "ui_report", "STEP 2 OF 5 — ENTER LOCATION"),
    ("report.step_3_of_5",        "ui_report", "STEP 3 OF 5 — ANSWER QUESTIONS"),
    ("report.step_4_review",      "ui_report", "STEP 4 — REVIEW"),
    ("report.photo_tips_title",   "ui_report", "PHOTO TIPS"),
    ("report.no_photo_added",     "ui_report", "No photo added yet"),
    ("report.photos_added_count", "ui_report", "{{count}} of 3 photos added. You can add up to 3."),
    ("report.q4_category_natural","ui_report", "Natural Hazards"),
    ("report.q4_category_tech",   "ui_report", "Technological or Industrial Hazards"),
    ("report.q4_category_human",  "ui_report", "Human-Made Crises"),

    # settings additions
    ("settings.sign_out",              "ui_settings", "Sign Out"),
    ("settings.terms_and_conditions",  "ui_settings", "Terms and Conditions"),
    ("settings.select_country",        "ui_settings", "Select Country"),

    # about page
    ("about.title",      "ui_about", "About Crisis Reporter"),
    ("about.powered_by", "ui_about", "Powered by UNDP"),
    ("about.mission",    "ui_about", "Crisis Reporter is a UNDP initiative that enables community members to document and report damage to buildings and infrastructure following disasters and crises. Your contributions help humanitarian teams deploy resources where they are needed most."),
    ("about.version",    "ui_about", "Version"),
    ("about.legal",      "ui_about", "This application is operated by the United Nations Development Programme (UNDP). Data submitted through this platform is used solely for humanitarian response coordination and is handled in accordance with UNDP's data privacy policies."),

    # faq page — questions and answers
    ("faq.contact_prompt", "ui_about", "Can't find what you're looking for?"),
    ("faq.contact_link",   "ui_about", "Contact Support"),
    ("faq.q1_question", "ui_about", "How do I submit a report?"),
    ("faq.q1_answer",   "ui_about", "Tap \"Report an Incident\" on the Home screen. You will be guided through steps — take or upload a photo, confirm your location, answer damage assessment questions, then review and submit. At least one photo is required."),
    ("faq.q2_question", "ui_about", "Do I need an internet connection to submit a report?"),
    ("faq.q2_answer",   "ui_about", "No. If you are offline your report will be saved to a queue on your device and sent automatically when internet returns. You can see queued reports in My Reports."),
    ("faq.q3_question", "ui_about", "How do I enable GPS on my device?"),
    ("faq.q3_answer",   "ui_about", "On most devices go to Settings, then Location or Privacy, and enable Location Services. In your browser you may need to allow location access when prompted. GPS helps us pinpoint the exact building affected."),
    ("faq.q4_question", "ui_about", "Can I submit a report anonymously?"),
    ("faq.q4_answer",   "ui_about", "Yes. You do not need to create an account or fill in any profile details to submit a report. Adding your email or phone number is optional and links your reports to your profile."),
    ("faq.q5_question", "ui_about", "What happens to my report after I submit it?"),
    ("faq.q5_answer",   "ui_about", "Your report is received by UNDP staff who review it for accuracy. Verified reports are used to coordinate crisis response and damage assessment. Your identity is never shared publicly."),
    ("faq.q6_question", "ui_about", "How do I earn a Safety Training badge?"),
    ("faq.q6_answer",   "ui_about", "Complete all parts of Safety Tips — Part A covers all 9 disaster types, Part B covers reporting guidelines, Part C covers first aid. Then add an email or phone number to your profile. The badge is awarded automatically."),
    ("faq.q7_question", "ui_about", "What if my country is not in the list?"),
    ("faq.q7_answer",   "ui_about", "Crisis Reporter is currently operational in countries where UNDP is actively responding to a crisis. If your country is not listed it means UNDP has not yet activated it. Check back during an active crisis event."),
    ("faq.q8_question", "ui_about", "How do I contact support?"),
    ("faq.q8_answer",   "ui_about", "Email us at {{email}} — we will respond within 48 hours."),
    ("faq.q9_question", "ui_about", "Can I edit or delete a report after submitting?"),
    ("faq.q9_answer",   "ui_about", "Reports cannot be edited after submission. If you submitted a report in error please contact support with the date and location of the report."),
    ("faq.q10_question","ui_about", "Is my data secure?"),
    ("faq.q10_answer",  "ui_about", "Yes. All data is transmitted over encrypted connections and stored securely. Photos are anonymised before storage. Your personal details are never shared with third parties."),

    # safety tips home screen card strings
    ("safety.part_a_card_title",  "ui_safety", "Part A — Safety Tips by Disaster Type"),
    ("safety.part_b_card_title",  "ui_safety", "Part B — Reporting Guidelines"),
    ("safety.part_c_card_title",  "ui_safety", "Part C — First Aid Tips"),
    ("safety.status_completed",   "ui_safety", "Completed"),
    ("safety.status_not_started", "ui_safety", "Not started"),
    ("safety.start",              "ui_safety", "Start"),
    ("safety.continue_a",         "ui_safety", "Continue Safety Tips"),
    ("safety.intro_text",         "ui_safety", "Learn how to stay safe and report effectively. Complete all parts to earn your Safety Training badge."),
    ("safety.part_b_desc",        "ui_safety", "Simple do's and don'ts for submitting a report safely and accurately during a crisis"),
    ("safety.badge_teaser",       "ui_safety", "Complete all parts to unlock your Safety Training Badge"),
    ("safety.view_badges",        "ui_safety", "View Badges"),
    ("safety.offline_ready",      "ui_safety", "Ready for the field"),
    ("safety.offline_ready_desc", "ui_safety", "Content works offline and is available in all supported languages"),
    ("safety.n_of_9_completed",   "ui_safety", "{{n}} of 9 completed"),
    ("safety.tap_hint",           "ui_safety", "Tap a disaster type to read the safety tips"),

    # badges page strings
    ("badges.locked_title",      "ui_badges", "Badges are locked"),
    ("badges.locked_body",       "ui_badges", "Add your email or phone number to your profile to unlock badges and certifications"),
    ("badges.go_to_profile",     "ui_badges", "Go to Profile"),
    ("badges.section_available", "ui_badges", "Available Badges"),
    ("badges.section_your_badges","ui_badges","Your Badges"),
    ("badges.part_a_progress",   "ui_badges", "Part A: {{n}}/9 completed · Part B: {{status}}"),
    ("badges.safety_earned_desc","ui_badges", "You completed the Crisis Response Safety Protocol. This certification validates your field readiness."),
    ("badges.earned_on_label",   "ui_badges", "Earned on"),
    ("badges.share_badge",       "ui_badges", "Share Badge"),
    ("badges.user_id_label",     "ui_badges", "User ID"),
    ("badges.profile_active",    "ui_badges", "Profile Active"),
    ("badges.visibility_note",   "ui_badges", "Badges are only visible inside the app at this stage. Shareable certificates coming soon."),
    ("badges.security_note",     "ui_badges", "Badges are linked to your verified ID. Sharing capabilities are currently restricted for security compliance."),
    ("badges.referral_desc",     "ui_badges", "Refer a friend who installs the app and completes safety training"),
    ("badges.referral_status",   "ui_badges", "Status: Coming soon — referral program launching later"),
    ("badges.referral_count",    "ui_badges", "{{count}} successful referrals"),
    ("badges.refer_a_friend",    "ui_badges", "Refer a Friend"),

    # Onboarding
    ("onboarding.subtitle",      "ui_onboarding", "Helping UNDP respond faster to crises around the world"),
    ("onboarding.unavailable",   "ui_onboarding", "Unavailable"),

    # Profile form labels and placeholders
    ("profile.add_photo",             "ui_profile", "Add Profile Photo"),
    ("profile.completion_heading",    "ui_profile", "Profile Completion"),
    ("profile.completion_hint",       "ui_profile", "Adding your email or phone number links all your reports to your profile"),
    ("profile.first_name_optional",   "ui_profile", "First Name (optional)"),
    ("profile.first_name_placeholder","ui_profile", "Enter your first name"),
    ("profile.last_name_optional",    "ui_profile", "Last Name (optional)"),
    ("profile.last_name_placeholder", "ui_profile", "Enter your last name"),
    ("profile.email_optional",        "ui_profile", "Email Address (optional)"),
    ("profile.email_hint",            "ui_profile", "Links all your reports to this email"),
    ("profile.email_placeholder",     "ui_profile", "name@example.com"),
    ("profile.phone_optional",        "ui_profile", "Mobile Number (optional)"),
    ("profile.phone_placeholder",     "ui_profile", "Enter mobile number"),
    ("profile.footer_hint",           "ui_profile", "Your profile is saved locally and synced when online"),

    # Side menu / PWA install prompt
    ("sidemenu.install_app",        "ui_menu", "Install App"),
    ("sidemenu.add_to_home_screen", "ui_menu", "Add to home screen"),
    ("sidemenu.version",            "ui_menu", "Crisis Reporter v1.0"),
]


async def seed_string_keys() -> None:
    """Idempotent, incremental seed — inserts only StringKey rows that don't yet
    exist.  New keys added to _SEED_KEYS in future commits will be picked up on
    the next startup without affecting existing translations."""
    async with AsyncSessionLocal() as session:
        # Load all existing keys in one query
        existing_result = await session.execute(select(StringKey.key))
        existing_keys: set[str] = {row[0] for row in existing_result.all()}

        added = 0
        for key, category, english_text in _SEED_KEYS:
            if key not in existing_keys:
                session.add(StringKey(key=key, category=category, english_text=english_text))
                added += 1

        if added:
            await session.commit()
            log.info("Seeded %d new string keys (%d total defined)", added, len(_SEED_KEYS))
