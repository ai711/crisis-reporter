"""
language_packages.py

Four router prefixes:
    /api/languages            — language lifecycle management
    /api/language-packages    — package lifecycle (active fetch, publish)
    /api/string-keys          — key catalogue management
    /api/translations         — per-language translation workflow (edit locks, audit)
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import redis.asyncio as _redis_asyncio
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select, func, or_, update as sql_update
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

# Redis key prefix for batch progress. Stored in Redis (not in-memory) so progress
# survives multi-worker deployments and is visible across processes.
_PROGRESS_KEY_PREFIX = "translation_batch_progress"
_PROGRESS_TTL = 7200  # 2 hours — auto-expires if the background task crashes

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
    # Gate: review queue must be empty (active keys only — retired-key translations are excluded)
    pending_result = await db.execute(
        select(func.count(Translation.id))
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            Translation.language_code == language_code,
            Translation.status.in_(["draft", "failed"]),
            StringKey.is_active == True,
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

    # Generate next version number using MAX to survive language delete/re-add cycles.
    # COUNT would reset to 0 if the language record were ever deleted and recreated.
    versions_result = await db.execute(
        select(LanguagePackage.version).where(LanguagePackage.language_code == language_code)
    )
    existing_minors = [
        int(v.split(".")[1])
        for (v,) in versions_result.all()
        if "." in v and v.split(".")[1].isdigit()
    ]
    next_version = f"1.{(max(existing_minors) + 1) if existing_minors else 0}"

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
    - Un-retires Translation rows whose StringKey is now active again (resets to
      'missing' so auto-translate picks them up). Existing translated_text is
      preserved so a re-translate gets a meaningful starting point.
    - Marks Translation rows whose StringKey is now inactive as status='retired'
      (does not delete them).

    Returns {"created": N, "unretired": N, "retired": N}.
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
        return {"created": 0, "unretired": 0, "retired": 0}

    active_key_ids = [k.id for k in active_keys]
    active_lang_codes = [l.code for l in active_langs]

    # Existing Translation rows for active key+lang pairs — track both status and pair
    existing_result = await db.execute(
        select(Translation.string_key_id, Translation.language_code, Translation.status).where(
            Translation.string_key_id.in_(active_key_ids),
            Translation.language_code.in_(active_lang_codes),
        )
    )
    existing_rows = existing_result.all()
    existing_pairs = {(row[0], row[1]) for row in existing_rows}
    retired_pairs = {(row[0], row[1]) for row in existing_rows if row[2] == "retired"}

    # Un-retire Translation rows for keys that are active again — these got stranded
    # when a key was temporarily removed from _SEED_KEYS and then re-added. The unique
    # constraint (string_key_id, language_code) means we can't create a new row, so we
    # must reset the existing retired row back to 'missing'.
    unretired = 0
    if retired_pairs:
        unretire_result = await db.execute(
            sql_update(Translation)
            .where(
                Translation.string_key_id.in_(active_key_ids),
                Translation.language_code.in_(active_lang_codes),
                Translation.status == "retired",
            )
            .values(status="missing")
            .execution_options(synchronize_session=False)
        )
        unretired = unretire_result.rowcount

    # Create brand-new Translation rows for pairs that have never existed
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

    # Retire translations whose StringKey is now inactive — bulk UPDATE for efficiency
    retire_result = await db.execute(
        sql_update(Translation)
        .where(
            Translation.string_key_id.in_(
                select(StringKey.id).where(StringKey.is_active == False)
            ),
            Translation.status != "retired",
        )
        .values(status="retired")
        .execution_options(synchronize_session=False)
    )
    retired = retire_result.rowcount

    await db.commit()
    log.info(
        "ensure_string_keys_synced: created=%d unretired=%d retired=%d",
        created, unretired, retired,
    )
    return {"created": created, "unretired": unretired, "retired": retired}


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
    request: Request,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_dashboard_user),
) -> dict:
    result = await db.execute(
        select(
            Translation.language_code,
            Translation.status,
            func.count(Translation.id),
        )
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            Translation.status.in_(["draft", "failed"]),
            StringKey.is_active == True,
        )
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

    # Only load language names when there is something to display
    lang_name_map: dict[str, str] = {}
    if lang_data:
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

    # Read batch progress from Redis — works across multiple workers
    batch_progress = None
    try:
        redis = request.app.state.redis
        keys = await redis.keys(f"{_PROGRESS_KEY_PREFIX}:*")
        if keys:
            raw = await redis.get(keys[0])
            if raw:
                batch_progress = json.loads(raw)
    except Exception as exc:
        log.warning("Failed to read batch_progress from Redis: %s", exc)

    return {
        "has_pending": total_pending > 0,
        "total_pending": total_pending,
        "by_language": by_language,
        "batch_progress": batch_progress,
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
        .where(Translation.status.in_(statuses), StringKey.is_active == True)
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

    # Query all draft translations for this language, excluding retired keys.
    # Retired-key translations are skipped here — the publish gate already
    # excludes them, so approving them would inflate the approved count
    # without ever contributing to a published package.
    result = await db.execute(
        select(Translation)
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            Translation.language_code == body.language_code,
            Translation.status == "draft",
            StringKey.is_active == True,
        )
    )
    drafts = result.scalars().all()

    if not drafts:
        return {"approved_count": 0, "message": "No pending translations to approve"}

    # Approve all and commit — audit log written separately so a log failure
    # does not roll back the approvals
    for t in drafts:
        t.status = "approved"
        t.reviewed_by = current_user.full_name

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
        "sync_string_keys called by %s: created=%d unretired=%d retired=%d",
        current_user.full_name,
        result["created"],
        result.get("unretired", 0),
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
    progress_key = f"{_PROGRESS_KEY_PREFIX}:{language_code}"
    redis_client = _redis_asyncio.from_url(settings.REDIS_URL, decode_responses=True)
    try:
        async with AsyncSessionLocal() as db:
            try:
                # Only translate strings for ACTIVE keys — retired/inactive keys must be excluded
                missing_trans_result = await db.execute(
                    select(Translation)
                    .join(StringKey, StringKey.id == Translation.string_key_id)
                    .where(
                        Translation.language_code == language_code,
                        Translation.status == "missing",
                        StringKey.is_active == True,
                    )
                )
                missing_translations = missing_trans_result.scalars().all()
                if not missing_translations:
                    await redis_client.delete(progress_key)
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
                    await redis_client.delete(progress_key)
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

                async def _translate_single(translation_id, key_name, english_text, target_lang) -> dict:
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
                            return {"translation_id": translation_id, "key_name": key_name, "translated_text": t_text, "service_used": svc, "error": None}
                        except httpx.HTTPStatusError as exc:
                            if exc.response.status_code in (429, 403):
                                last_exc = exc
                                continue
                            return {"translation_id": translation_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(exc)}
                        except Exception as exc:
                            return {"translation_id": translation_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(exc)}
                    return {"translation_id": translation_id, "key_name": key_name, "translated_text": None, "service_used": None, "error": str(last_exc)}

                for batch_idx, batch in enumerate(batches):
                    progress = {
                        "completed": batch_idx * TRANSLATION_BATCH_SIZE,
                        "total": total_keys,
                        "current_batch": batch_idx + 1,
                        "language_code": language_code,
                    }
                    try:
                        await redis_client.setex(progress_key, _PROGRESS_TTL, json.dumps(progress))
                    except Exception as exc:
                        log.warning("Failed to write batch_progress to Redis: %s", exc)

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
                            t_obj = trans_map_batch.get(result["translation_id"])
                            if t_obj is not None:
                                t_obj.translated_text = result["translated_text"]
                                t_obj.status = "draft"
                                t_obj.translated_by = result["service_used"]
                                translated += 1
                                log.info("Translated key %s via %s", result["key_name"], result["service_used"])

                    await db.commit()

                try:
                    await redis_client.delete(progress_key)
                except Exception:
                    pass

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
                try:
                    await redis_client.delete(progress_key)
                except Exception:
                    pass
                log.error("_run_auto_translation background task failed for %s: %s", language_code, exc)
    finally:
        await redis_client.aclose()


@translations_router.post("/auto-translate")
async def auto_translate(
    body: AutoTranslateRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
) -> dict:
    redis = request.app.state.redis
    progress_key = f"{_PROGRESS_KEY_PREFIX}:{body.language_code}"

    # Concurrency guard — reject if a run is already in progress for this language
    try:
        if await redis.exists(progress_key):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "status": "already_running",
                    "language_code": body.language_code,
                    "message": "Auto-translation is already running for this language",
                },
            )
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Failed to check Redis for running translation: %s", exc)

    missing_count_result = await db.execute(
        select(func.count(Translation.id))
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            Translation.language_code == body.language_code,
            Translation.status == "missing",
            StringKey.is_active == True,
        )
    )
    missing_count = missing_count_result.scalar() or 0

    if missing_count == 0:
        return {"status": "no_op", "language_code": body.language_code, "translated": 0, "skipped": 0, "failed": 0}

    # Seed the progress key immediately so concurrent requests are rejected before
    # the background task starts and so the frontend can start polling right away.
    try:
        await redis.setex(
            progress_key,
            _PROGRESS_TTL,
            json.dumps({"completed": 0, "total": missing_count, "current_batch": 0, "language_code": body.language_code}),
        )
    except Exception as exc:
        log.warning("Failed to seed progress key in Redis: %s", exc)

    background_tasks.add_task(_run_auto_translation, body.language_code)
    return {"status": "translation_started", "language_code": body.language_code, "missing_count": missing_count}


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
    translation.reviewed_by = current_user.full_name

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

    try:
        await write_translation_audit(
            db,
            event_type="translation_updated",
            lang_code=translation.language_code,
            string_key=sk.key if sk else None,
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
    except Exception as exc:
        log.warning("Failed to write translation_updated audit log: %s", exc)

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

    try:
        await write_translation_audit(
            db,
            event_type="translation_created",
            lang_code=body.language_code,
            string_key=sk.key,
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
    except Exception as exc:
        log.warning("Failed to write translation_created audit log: %s", exc)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_dashboard_user),
) -> TranslationOut:
    """Retranslate a single draft translation using the translation service."""
    result = await db.execute(
        select(Translation).where(Translation.id == body.translation_id)
    )
    translation = result.scalar_one_or_none()
    if not translation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Translation not found")

    await _assert_lock(request, translation.language_code, str(current_user.id))

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

    try:
        await write_translation_audit(
            db,
            event_type="translation_regenerated",
            lang_code=body.language_code,
            string_key=sk.key,
            details={"service_used": service_used},
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
    except Exception as exc:
        log.warning("Failed to write translation_regenerated audit log: %s", exc)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
) -> dict:
    """Retranslate all draft translations for a language — sequential with retry."""
    await _assert_lock(request, body.language_code, str(current_user.id))

    result = await db.execute(
        select(Translation)
        .join(StringKey, StringKey.id == Translation.string_key_id)
        .where(
            Translation.language_code == body.language_code,
            Translation.status == "draft",
            StringKey.is_active == True,
        )
    )
    drafts = result.scalars().all()

    if not drafts:
        return {"regenerated_count": 0, "language_code": body.language_code}

    sk_ids = [d.string_key_id for d in drafts]
    sk_result = await db.execute(select(StringKey).where(StringKey.id.in_(sk_ids)))
    sk_map = {sk.id: sk for sk in sk_result.scalars().all()}

    _BACKOFF = [5.0, 15.0, 45.0]
    regenerated = 0
    batches = [
        drafts[i:i + TRANSLATION_BATCH_SIZE]
        for i in range(0, len(drafts), TRANSLATION_BATCH_SIZE)
    ]

    for batch in batches:
        for t in batch:
            sk = sk_map.get(t.string_key_id)
            if not sk:
                continue
            last_exc: Exception | None = None
            for attempt in range(len(_BACKOFF) + 1):
                if attempt > 0:
                    wait = _BACKOFF[attempt - 1]
                    log.warning(
                        "HTTP error regenerating %s (attempt %d/%d), retrying after %.0fs",
                        sk.key, attempt, len(_BACKOFF), wait,
                    )
                    await asyncio.sleep(wait)
                try:
                    t_text, service_used = await translate_text(sk.english_text, body.language_code)
                    t.translated_text = t_text
                    t.translated_by = service_used
                    regenerated += 1
                    break
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code in (429, 403):
                        last_exc = exc
                        continue
                    log.warning("regenerate_all_draft HTTP error for key %s: %s", sk.key, exc)
                    break
                except Exception as exc:
                    log.warning("regenerate_all_draft failed for key %s: %s", sk.key, exc)
                    break
            else:
                if last_exc:
                    log.warning("regenerate_all_draft exhausted retries for key %s: %s", sk.key, last_exc)
        await db.commit()

    try:
        await write_translation_audit(
            db,
            event_type="translations_bulk_regenerated",
            lang_code=body.language_code,
            details={"regenerated": regenerated, "total_drafts": len(drafts)},
            performed_by=current_user.full_name,
            dashboard_user_id=str(current_user.id),
        )
        await db.commit()
    except Exception as exc:
        log.warning("Failed to write translations_bulk_regenerated audit log: %s", exc)

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
    ("Q4_LABEL",                 "question", "What type of disaster caused this damage?"),
    ("Q4_OPT_EARTHQUAKE",        "answer",   "Earthquake"),
    ("Q4_OPT_FLOOD",             "answer",   "Flood"),
    ("Q4_OPT_TSUNAMI",           "answer",   "Tsunami"),
    ("Q4_OPT_HURRICANE_CYCLONE", "answer",   "Hurricane or Cyclone"),
    ("Q4_OPT_WILDFIRE",          "answer",   "Wildfire"),
    ("Q4_OPT_EXPLOSION",         "answer",   "Explosion"),
    ("Q4_OPT_CHEMICAL_INCIDENT", "answer",   "Chemical Incident"),
    ("Q4_OPT_CONFLICT",          "answer",   "Conflict / War"),
    ("Q4_OPT_CIVIL_UNREST",      "answer",   "Civil Unrest"),
    # Legacy Q4 keys — kept for backwards compatibility with any existing translations
    ("Q4_OPT_CYCLONE",           "answer",   "Cyclone / Typhoon / Hurricane"),
    ("Q4_OPT_LANDSLIDE",         "answer",   "Landslide"),
    ("Q4_OPT_FIRE",              "answer",   "Fire"),
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

    # ── Map view ─────────────────────────────────────────────────────────────────
    ("map.one_report_received",     "ui_map",    "1 verified report"),

    # ── Navigation / global chrome ────────────────────────────────────────────────

    # ── Common / shared UI ────────────────────────────────────────────────────────
    ("COMMON_NEXT",                 "ui_common", "Next →"),
    ("COMMON_PREVIOUS",             "ui_common", "← Previous"),

    # ── Terms & Conditions ────────────────────────────────────────────────────────

    # ── Onboarding ────────────────────────────────────────────────────────────────

    # ── Home screen ───────────────────────────────────────────────────────────────

    # ── Report form ───────────────────────────────────────────────────────────────

    # ── Settings ──────────────────────────────────────────────────────────────────

    # ── Offline / connectivity ────────────────────────────────────────────────────

    # ── Error messages ────────────────────────────────────────────────────────────

    # ── Profile ───────────────────────────────────────────────────────────────────

    # ── Login ─────────────────────────────────────────────────────────────────────

    # ── My Reports ────────────────────────────────────────────────────────────────

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

    # ── Disaster type labels (for display in UI) ─────────────────────────────────

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
    ("common.edit",               "ui_common", "Edit"),
    ("common.saving",             "ui_common", "Saving…"),
    ("common.go_back",            "ui_common", "Go Back"),
    ("common.go_home",            "ui_common", "Go to Home"),
    ("common.got_it",             "ui_common", "Got it"),

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
    ("onboarding.more_languages_title","ui_onboarding", "More languages"),
    ("onboarding.more_languages_btn",  "ui_onboarding", "+ More"),
    ("onboarding.show_less",           "ui_onboarding", "Show less"),
    ("onboarding.lang_load_error",     "ui_onboarding", "Could not load language. Check your connection and try again."),

    # home screen
    ("home.reportButton",    "ui_home", "Report an Incident"),
    ("home.myReports",       "ui_home", "My Reports"),
    ("home.noReportsTitle",  "ui_home", "No reports yet"),
    ("home.recentReports",   "ui_home", "YOUR RECENT REPORTS"),
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
    ("settings.rtl_restart_title","ui_settings", "Restart Required"),
    ("settings.rtl_restart_body", "ui_settings", "The app needs to restart to apply the new text direction."),
    ("settings.rtl_restart_btn",  "ui_settings", "Restart Now"),

    # offline / connectivity
    ("offline.banner",  "ui_offline", "You are offline. Reports will be saved and sent when you reconnect."),

    # error messages (keyed to real i18n keys used in reporter app)
    ("errors.location_denied",  "ui_errors",   "Location access was denied. Please enable location services and try again."),
    ("errors.session_expired",  "ui_errors",   "Your session has expired. Please log in again."),

    # system / status messages
    ("messages.sync_complete",   "ui_messages", "Your offline reports have been synced successfully."),
    ("messages.tc_update",       "ui_messages", "Our Terms and Conditions have been updated. Please review and accept to continue."),
    ("messages.report_received", "ui_messages", "Your report has been received and is being processed."),
    ("messages.update_available","ui_messages", "A new version of the app is available. Please refresh to update."),

    # profile
    ("profile.title",              "ui_profile", "My Profile"),
    ("profile.first_name",         "ui_profile", "First Name"),
    ("profile.last_name",          "ui_profile", "Last Name"),
    ("profile.phone",              "ui_profile", "Phone Number"),
    ("profile.save_btn",           "ui_profile", "Save Profile"),
    ("profile.save_success",       "ui_profile", "Profile saved"),
    ("profile.save_error",         "ui_profile", "Could not save profile. Please try again."),
    ("profile.anon_gate_heading",  "ui_profile", "Create a free account to save your profile and earn badges."),
    ("profile.anon_gate_subtext",  "ui_profile", "You can still submit reports anonymously without an account."),
    ("profile.anon_note",          "ui_profile", "All profile fields are optional. You can submit reports anonymously."),
    ("profile.edit_photo",         "ui_profile", "Edit photo"),

    # login
    ("login.title",               "ui_login", "Sign In"),
    ("login.email_label",         "ui_login", "Email"),
    ("login.password_label",      "ui_login", "Password"),
    ("login.submit_btn",          "ui_login", "Sign In"),
    ("login.signing_in",          "ui_login", "Signing in…"),
    ("login.validation",          "ui_login", "Please enter your email and password."),
    ("login.invalid_credentials", "ui_login", "Invalid email or password."),
    ("login.invalid_email",       "ui_login", "Please enter a valid email address."),
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

    # stepper — all 5 used via dict lookup: t(I18N_KEYS[step]) in SubmissionStepper.tsx
    ("stepper.step_photo",     "ui_stepper", "Photo"),
    ("stepper.step_location",  "ui_stepper", "Location"),
    ("stepper.step_questions", "ui_stepper", "Questions"),
    ("stepper.step_review",    "ui_stepper", "Review"),
    ("stepper.step_submit",    "ui_stepper", "Submit"),

    # side menu — all nine items + version footer
    ("menu.report_incident", "ui_menu", "Report an Incident"),
    ("menu.map",             "ui_menu", "View Map"),
    ("menu.my_reports",      "ui_menu", "My Reports"),
    ("menu.safety_tips",     "ui_menu", "Safety Tips"),
    ("menu.profile",         "ui_menu", "Reporter Profile"),
    ("menu.badges",          "ui_menu", "My Badges"),
    ("menu.faq",             "ui_menu", "FAQ"),
    ("menu.about",           "ui_menu", "About"),
    ("menu.settings",        "ui_menu", "Settings"),

    # faq / about
    ("faq.title",   "ui_about", "FAQ"),
    ("about.title", "ui_about", "About Crisis Reporter"),

    # badges (dotted — BADGES_* UPPERCASE kept for mobile)
    ("badges.title",          "ui_badges", "Badges & Certifications"),
    ("badges.subtitle",       "ui_badges", "Badges are awarded to reporters with a verified profile. Complete your profile to unlock badges."),
    ("badges.status_earned",  "ui_badges", "Earned ✓"),
    ("badges.status_locked",  "ui_badges", "Locked"),
    ("badges.safety_name",    "ui_badges", "Safety Training Completion"),
    ("badges.safety_desc_locked","ui_badges","Complete all safety training modules in Crisis Reporter."),
    ("badges.referral_name",  "ui_badges", "Community Referral"),

    # safety tabs (dotted — t("safety.*") calls in SafetyTipsPage tab labels)
    ("safety.tab_a",            "ui_safety", "Part A: Disaster Tips"),

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

    # crisis type descriptions — rendered in the web "What can I report?" popup
    # (CrisisTypeModal.tsx uses t(`crisis_types.${key}`) as a template literal)
    ("crisis_types.earthquake",        "disaster_label", "Structural damage to buildings and infrastructure caused by seismic activity"),
    ("crisis_types.flood",             "disaster_label", "Water damage to properties, roads, and community areas"),
    ("crisis_types.tsunami",           "disaster_label", "Coastal destruction caused by large ocean waves"),
    ("crisis_types.hurricane_cyclone", "disaster_label", "Wind and water damage from tropical storm systems"),
    ("crisis_types.wildfire",          "disaster_label", "Fire damage to buildings, land, and surrounding areas"),
    ("crisis_types.explosion",         "disaster_label", "Blast damage to structures and nearby properties"),
    ("crisis_types.chemical_incident", "disaster_label", "Damage or contamination caused by hazardous substances"),
    ("crisis_types.conflict",          "disaster_label", "Damage to buildings and infrastructure in conflict-affected areas"),
    ("crisis_types.civil_unrest",      "disaster_label", "Property damage resulting from civil disturbances"),

    # report form (most-used strings)
    ("report.title",             "ui_report", "Report Damage"),
    ("report.minimal",           "ui_report", "Minimal or No Damage"),
    ("report.partial",           "ui_report", "Partially Damaged"),
    ("report.complete",          "ui_report", "Completely Damaged"),
    ("report.description",       "ui_report", "Description (optional)"),
    ("report.takePhoto",         "ui_report", "Take a Photo"),
    ("report.uploadPhoto",       "ui_report", "Upload from Gallery"),
    ("report.location",          "ui_report", "Location"),
    ("report.submit",            "ui_report", "Submit Report"),
    ("report.submitting",        "ui_report", "Submitting..."),
    ("report.error",             "ui_report", "Failed to submit report. Please try again."),
    ("report.detail_load_error", "ui_report", "Could not load report. Please try again."),
    ("report.success_title",     "ui_report", "Report Submitted"),
    ("report.submit_another",    "ui_report", "Submit Another Report"),
    ("report.dupe_title",        "ui_report", "Possible duplicate report"),
    ("report.dupe_body",         "ui_report", "It looks like you have already submitted a report for this location. Are you sure you want to submit another?"),
    ("report.dupe_submit_anyway","ui_report", "Submit anyway"),
    ("report.gps_button",        "ui_report", "Use My GPS Location"),
    ("report.gps_getting",       "ui_report", "Getting location…"),
    ("report.back_to_review",    "ui_report", "Back to Review without changes"),
    ("report.select_at_least_one","ui_report","Select all that apply. At least one required."),

    # map
    ("map.loading",          "ui_map", "Loading map..."),
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
    ("badges.status_completed",  "ui_badges", "Completed"),
    ("badges.status_not_started","ui_badges", "Not started"),
    ("badges.continue_safety",   "ui_badges", "Continue Safety Tips"),

    # Onboarding
    ("onboarding.subtitle",         "ui_onboarding", "Helping UNDP respond faster to crises around the world"),
    ("onboarding.unavailable",      "ui_onboarding", "Unavailable"),
    ("onboarding.welcome_message",  "ui_onboarding", "Welcome to Crisis Reporter. This app helps you document and report damage to buildings and infrastructure during and after a crisis. Your reports help UNDP and partner organisations coordinate emergency response."),

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

    # Side menu / PWA install prompt (web)
    ("sidemenu.install_app",         "ui_menu", "Install App"),
    ("sidemenu.add_to_home_screen",  "ui_menu", "Add to home screen"),
    ("sidemenu.version",             "ui_menu", "Crisis Reporter v1.0"),
    ("sidemenu.verified_reporter",   "ui_menu", "Verified Reporter"),
    ("sidemenu.anonymous_reporter",  "ui_menu", "Anonymous Reporter"),

    # ── Mobile-only keys ──────────────────────────────────────────────────────────

    # Mobile side menu
    ("menu.version",         "ui_menu", "Crisis Reporter v1.0"),

    # Mobile home screen
    ("home.headline",          "ui_home", "Ready to report?"),
    ("home.subtitle",          "ui_home", "Help UNDP map damage in your area"),
    ("home.status_title",      "ui_home", "Powered by UNDP Crisis Response"),
    ("home.status_connected",  "ui_home", "Connected"),
    ("home.status_offline",    "ui_home", "Offline mode"),
    ("home.sync_banner",       "ui_home", "{{count}} report(s) waiting to sync — connect to internet to upload"),
    ("home.sync_none",         "ui_home", "NO REPORTS PENDING SYNC"),
    ("home.view_map",          "ui_home", "View Map"),
    ("home.recent_reports",    "ui_home", "RECENT REPORTS"),
    ("home.see_all",           "ui_home", "See all"),
    ("home.nav_home",          "ui_home", "HOME"),
    ("home.nav_map",           "ui_home", "MAP"),
    ("home.nav_reports",       "ui_home", "REPORTS"),

    # Mobile settings screen
    ("settings.section_preferences",  "ui_settings", "APP PREFERENCES"),
    ("settings.status_label",         "ui_settings", "Status"),
    ("settings.verified",             "ui_settings", "Verified Reporter"),
    ("settings.anonymous",            "ui_settings", "Anonymous"),
    ("settings.not_set",              "ui_settings", "Not set"),
    ("settings.app_version",          "ui_settings", "App Version"),
    ("settings.version_value",        "ui_settings", "1.0.0"),
    ("settings.reset_app",            "ui_settings", "/ Reset App"),

    # Mobile about screen
    ("about.section_about",   "ui_about", "ABOUT"),
    ("about.about_body",      "ui_about", "Crisis Reporter is a community-driven damage reporting platform built for UNDP. It enables rapid infrastructure assessment following sudden-onset disasters, helping UNDP coordinate crisis response faster and more effectively."),
    ("about.section_how",     "ui_about", "HOW IT WORKS"),
    ("about.how_body",        "ui_about", "Reporters submit photos and damage assessments from the field. UNDP staff review and verify reports on the dashboard. Verified data is exported for crisis response coordination with partner organisations."),
    ("about.section_resources","ui_about","RESOURCES"),
    ("about.privacy_policy",  "ui_about", "Privacy Policy"),
    ("about.undp_website",    "ui_about", "UNDP Website"),
    ("about.section_info",    "ui_about", "APP INFO"),
    ("about.version_label",   "ui_about", "Version"),
    ("about.version_value",   "ui_about", "1.0.0"),
    ("about.version_note",    "ui_about", "Crisis Reporter is built for UNDP's InnoCentive Crisis Mapping Challenge"),

    # Mobile common

    # Mobile confirmation / offline queue strings (ReportScreen)
    ("review.report_summary_header", "ui_report", "REPORT SUMMARY"),
    ("review.confirm_report_id",     "ui_report", "Report ID"),
    ("review.confirm_damage_level",  "ui_report", "Damage level"),
    ("review.confirm_location",      "ui_report", "Location"),
    ("review.confirm_submitted",     "ui_report", "Submitted"),
    ("review.confirm_received_note", "ui_report", "Your report has been received by UNDP staff."),
    ("review.confirm_view_reports",  "ui_report", "View My Reports"),
    ("review.queue_pending_sync",    "ui_report", "PENDING SYNC"),
    ("review.queue_currently_offline","ui_report","Currently offline"),
    ("review.queue_waiting_upload",  "ui_report", "1 report waiting to upload"),
    ("review.queue_auto_upload",     "ui_report", "Your report will upload automatically when internet is available."),
    ("review.queue_retry_helper",    "ui_report", "Tap to attempt upload if you have a connection"),
    ("review.photoCopyWarning",      "ui_report", "Photos couldn't be saved to persistent storage and may be lost if you close the app before syncing. Submit while the app is open for best results."),
    ("review.gps_captured_note",     "ui_report", "GPS location captured and attached to this report"),
    ("review.still_offline_title",   "ui_report", "Still offline"),
    ("review.still_offline_body",    "ui_report", "Internet is not available yet. Your report is saved and will send automatically."),
    ("review.delete_report_title",   "ui_report", "Delete Report"),
    ("review.delete_report_body",    "ui_report", "This report will be permanently deleted and cannot be recovered."),
    ("review.delete_confirm",        "ui_report", "Delete"),
    ("review.delete_report_link",    "ui_report", "Delete this report"),
    ("review.delete_report_warning", "ui_report", "DELETED REPORTS CANNOT BE RECOVERED"),

    # Mobile FAQ (different content from web FAQ)
    ("faq_m.q1_question",  "ui_faq", "What is Crisis Reporter?"),
    ("faq_m.q1_answer",    "ui_faq", "Crisis Reporter is a UNDP tool that lets community members document damage to buildings and infrastructure after a disaster. Your reports help UNDP direct emergency resources to the right places faster."),
    ("faq_m.q2_question",  "ui_faq", "Do I need internet to submit a report?"),
    ("faq_m.q2_answer",    "ui_faq", "You can fill in your report offline. Your text answers and GPS location are saved to your device. Photos require an internet connection to upload. When you reconnect, your report will send automatically."),
    ("faq_m.q3_question",  "ui_faq", "How do I enable GPS on my device?"),
    ("faq_m.q3_answer",    "ui_faq", "On Android: go to Settings → Location and turn it on. Then open Crisis Reporter and try again. If the app still cannot access your location, go to Settings → Apps → Crisis Reporter → Permissions and enable Location."),
    ("faq_m.q4_question",  "ui_faq", "Is my personal information shared?"),
    ("faq_m.q4_answer",    "ui_faq", "Anonymous reports contain no personal information. If you create a verified account with an email or phone number, that contact information is stored securely and shared only with authorised UNDP staff."),
    ("faq_m.q5_question",  "ui_faq", "How do I know my report was received?"),
    ("faq_m.q5_answer",    "ui_faq", "After submission you will see a confirmation screen with your report reference number. You can also view all your submitted reports in the My Reports section."),
    ("faq_m.q6_question",  "ui_faq", "How do I earn a Safety Training badge?"),
    ("faq_m.q6_answer",    "ui_faq", "Complete all three parts of Safety Tips — Part A covers all 9 disaster types, Part B covers reporting guidelines, Part C covers first aid. Then add an email or phone number to your profile. The badge is awarded automatically."),
    ("faq_m.q7_question",  "ui_faq", "What if my country is not in the list?"),
    ("faq_m.q7_answer",    "ui_faq", "Crisis Reporter is currently operational in countries where UNDP is actively responding to a crisis. If your country is not listed it means UNDP has not yet activated it. Check back during an active crisis event."),
    ("faq_m.q8_question",  "ui_faq", "Can I edit a report after submitting it?"),
    ("faq_m.q8_answer",    "ui_faq", "Reports cannot be edited after submission. If you need to update information, you can submit a new report for the same location. UNDP staff will see all reports for a location and consider the most recent."),
    ("faq_m.q9_question",  "ui_faq", "What do the damage levels mean?"),
    ("faq_m.q9_answer",    "ui_faq", "Minimal or No Damage: the building is structurally sound with only cosmetic damage. Partially Damaged: the building is repairable but should be used with caution. Completely Destroyed: the building is structurally unsafe."),
    ("faq_m.q10_question", "ui_faq", "Is my data secure?"),
    ("faq_m.q10_answer",   "ui_faq", "Yes. All data is transmitted over encrypted connections and stored securely. Photos are anonymised before storage. Your personal details are never shared with third parties."),
    ("faq_m.q11_question", "ui_faq", "How do I contact UNDP about a report?"),
    ("faq_m.q11_answer",   "ui_faq", "Crisis Reporter is for damage documentation only. For emergency assistance, contact your local emergency services. For questions about UNDP operations in your area, visit undp.org."),
    # ── Safety Tips: UPPERCASE UI keys ───────────────────────────────────────────
    # Disaster type labels
    ("SAFETY_DISASTER_EARTHQUAKE_LABEL",        "safety_ui", "Earthquake"),
    ("SAFETY_DISASTER_FLOOD_LABEL",             "safety_ui", "Flood"),
    ("SAFETY_DISASTER_TSUNAMI_LABEL",           "safety_ui", "Tsunami"),
    ("SAFETY_DISASTER_HURRICANE_CYCLONE_LABEL", "safety_ui", "Hurricane / Cyclone"),
    ("SAFETY_DISASTER_WILDFIRE_LABEL",          "safety_ui", "Wildfire"),
    ("SAFETY_DISASTER_EXPLOSION_LABEL",         "safety_ui", "Explosion"),
    ("SAFETY_DISASTER_CHEMICAL_INCIDENT_LABEL", "safety_ui", "Chemical Incident"),
    ("SAFETY_DISASTER_CONFLICT_LABEL",          "safety_ui", "Conflict"),
    ("SAFETY_DISASTER_CIVIL_UNREST_LABEL",      "safety_ui", "Civil Unrest"),
    # ── Safety Tips: lowercase safety.* UI keys ───────────────────────────────────
    ("safety.continue_btn",            "safety_ui", "Continue →"),
    ("safety.badge_teaser_link",       "safety_ui", "View Badges →"),
    ("safety.done",                    "safety_ui", "Done"),
    ("safety.offline_content_unavailable", "safety_ui", "Content not available offline"),
    ("safety.connect_to_load",         "safety_ui", "Connect to the internet to load Safety Tips"),
    ("safety.retry",                   "safety_ui", "Retry"),
    ("safety.complete_alert_title",    "safety_ui", "Safety Training Complete!"),
    ("safety.complete_alert_body",     "safety_ui", "You have completed all three parts. Check your Badges to see your Safety Training Badge."),
    # ── Part A: Earthquake ────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_TITLE",  "safety_tips", "Drop and Take Cover"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_DO_1",   "safety_tips", "Drop to your hands and knees immediately"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_1_DO_2",   "safety_tips", "Take cover under a sturdy table or desk, or against an interior wall away from windows"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_2_TITLE",  "safety_tips", "Hold On and Stay Put"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_2_DO_1",   "safety_tips", "Hold on and protect your head and neck with your arms"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_2_DO_2",   "safety_tips", "Stay where you are until the shaking stops — most injuries happen when people try to move"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_3_TITLE",  "safety_tips", "Move Away from Outdoor Hazards"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_3_DO_1",   "safety_tips", "If outdoors, move away from buildings, streetlights, and utility wires"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_3_DO_2",   "safety_tips", "If in a vehicle, pull over away from buildings and overpasses and stay inside"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_4_TITLE",  "safety_tips", "After the Shaking Stops"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_4_DO_1",   "safety_tips", "After shaking stops, check yourself and others for injuries before moving"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_4_DO_2",   "safety_tips", "Expect aftershocks — drop, cover, and hold on each time"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_5_TITLE",  "safety_tips", "Run Outside or Use Doorways"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_5_DONT_1", "safety_tips", "Do not run outside while shaking is happening — most injuries occur when people try to move during shaking"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_5_DONT_2", "safety_tips", "Do not stand in a doorway — doorways offer no special protection"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_6_TITLE",  "safety_tips", "Use Elevators or Open Flames"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_6_DONT_1", "safety_tips", "Do not use elevators after an earthquake — use stairs only"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_6_DONT_2", "safety_tips", "Do not light candles, matches, or any open flame — gas pipes may be damaged"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_7_TITLE",  "safety_tips", "Re-enter or Spread Rumours"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_7_DONT_1", "safety_tips", "Do not return to a damaged building until declared structurally safe"),
    ("SAFETY_TIP_A_EARTHQUAKE_SLIDE_7_DONT_2", "safety_tips", "Do not spread unverified information — only share from official sources"),
    # ── Part A: Flood ─────────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_FLOOD_SLIDE_1_TITLE",  "safety_tips", "Move to Higher Ground"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_1_DO_1",   "safety_tips", "Move immediately to higher ground if flooding is imminent"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_1_DO_2",   "safety_tips", "Turn off utilities at the main switch if safe to do so"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_2_TITLE",  "safety_tips", "Disconnect Appliances and Evacuate"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_2_DO_1",   "safety_tips", "Disconnect electrical appliances — do not touch them if wet or standing in water"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_2_DO_2",   "safety_tips", "If evacuation is ordered, leave immediately with your emergency kit"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_3_TITLE",  "safety_tips", "If Trapped, Signal for Help"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_3_DO_1",   "safety_tips", "If trapped, move to the highest floor and signal for help from a window"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_3_DO_2",   "safety_tips", "Drink only bottled or boiled water — floodwater contaminates supplies"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_4_TITLE",  "safety_tips", "Protect Yourself and Monitor Updates"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_4_DO_1",   "safety_tips", "Wear rubber boots and waterproof gloves if walking through floodwater"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_4_DO_2",   "safety_tips", "Listen to official emergency broadcasts for updates and evacuation routes"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_5_TITLE",  "safety_tips", "Walk or Drive Through Floodwater"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_5_DONT_1", "safety_tips", "Do not walk through moving floodwater — 15cm of fast-moving water can knock an adult down"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_5_DONT_2", "safety_tips", "Do not drive through flooded roads — water depth is impossible to judge"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_6_TITLE",  "safety_tips", "Touch Floodwater or Return Too Soon"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_6_DONT_1", "safety_tips", "Do not touch floodwater if avoidable — it may contain sewage, chemicals, or debris"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_6_DONT_2", "safety_tips", "Do not return home until authorities declare it safe"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_7_TITLE",  "safety_tips", "Use Damaged Appliances or Ignore Orders"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_7_DONT_1", "safety_tips", "Do not use electrical equipment that has been in contact with floodwater"),
    ("SAFETY_TIP_A_FLOOD_SLIDE_7_DONT_2", "safety_tips", "Do not ignore evacuation orders — each flood event is different"),
    # ── Part A: Tsunami ───────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_1_TITLE",  "safety_tips", "Move to Higher Ground Immediately"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_1_DO_1",   "safety_tips", "If you feel a strong earthquake near the coast, move immediately to higher ground — do not wait for a warning"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_1_DO_2",   "safety_tips", "A sudden recession of the sea is a natural warning sign — move inland immediately"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_2_TITLE",  "safety_tips", "Move on Foot and Seek High Ground"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_2_DO_1",   "safety_tips", "Move on foot if possible — roads may be congested or damaged"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_2_DO_2",   "safety_tips", "Go to a designated tsunami evacuation zone or the highest ground available"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_3_TITLE",  "safety_tips", "If Caught in a Wave"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_3_DO_1",   "safety_tips", "If caught in a wave, grab onto something that floats"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_3_DO_2",   "safety_tips", "After the first wave, stay where you are — later waves are often larger"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_4_TITLE",  "safety_tips", "Wait for the Official All-Clear"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_4_DO_1",   "safety_tips", "Listen to official broadcasts — an all-clear must come from authorities before returning"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_4_DO_2",   "safety_tips", "Help others move to higher ground only if you can do so safely"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_5_TITLE",  "safety_tips", "Go to the Coast or Assume It's Over"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_5_DONT_1", "safety_tips", "Do not go to the coast to watch the tsunami — people who do are frequently killed"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_5_DONT_2", "safety_tips", "Do not assume danger is over after the first wave — subsequent waves can arrive for hours"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_6_TITLE",  "safety_tips", "Use Bridges or Return Too Soon"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_6_DONT_1", "safety_tips", "Do not use bridges or low-lying roads during or after a tsunami warning"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_6_DONT_2", "safety_tips", "Do not return to coastal areas until authorities issue a formal all-clear"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_7_TITLE",  "safety_tips", "Rely Solely on Sirens or Drive Through Zones"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_7_DONT_1", "safety_tips", "Do not rely solely on sirens — if you feel a large earthquake near the coast, act immediately"),
    ("SAFETY_TIP_A_TSUNAMI_SLIDE_7_DONT_2", "safety_tips", "Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away"),
    # ── Part A: Hurricane / Cyclone ───────────────────────────────────────────────
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_1_TITLE",  "safety_tips", "Follow Evacuation Orders"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_1_DO_1",   "safety_tips", "Follow evacuation orders immediately when issued"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_1_DO_2",   "safety_tips", "Board up windows and secure outdoor furniture before the storm arrives"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_2_TITLE",  "safety_tips", "Prepare Emergency Supplies"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_2_DO_1",   "safety_tips", "Prepare an emergency kit with water, food, medications, flashlight — enough for 72 hours"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_2_DO_2",   "safety_tips", "Fill clean containers with drinking water before the storm — supplies may be disrupted"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_3_TITLE",  "safety_tips", "Stay Indoors During the Storm"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_3_DO_1",   "safety_tips", "Stay indoors during the storm, away from windows and glass doors"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_3_DO_2",   "safety_tips", "If the eye passes over, stay sheltered — dangerous winds will return from the opposite direction"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_4_TITLE",  "safety_tips", "After the Storm"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_4_DO_1",   "safety_tips", "After the storm, check your home for structural damage before entering"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_4_DO_2",   "safety_tips", "Listen to official broadcasts for road conditions and public health guidance"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_5_TITLE",  "safety_tips", "Go Outside During the Storm"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_5_DONT_1", "safety_tips", "Do not go outside during the storm — flying debris causes most hurricane fatalities"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_5_DONT_2", "safety_tips", "Do not assume the storm is over if winds suddenly calm — the eye passes quickly"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_6_TITLE",  "safety_tips", "Use Generators Indoors or Touch Downed Lines"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_6_DONT_1", "safety_tips", "Do not use generators or charcoal grills indoors — carbon monoxide poisoning is a leading cause of post-hurricane deaths"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_6_DONT_2", "safety_tips", "Do not touch downed power lines or walk through standing water near them"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_7_TITLE",  "safety_tips", "Drive Through Flooding or Return Too Soon"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_7_DONT_1", "safety_tips", "Do not drive through flooded roads — hurricane flooding is extensive"),
    ("SAFETY_TIP_A_HURRICANE_CYCLONE_SLIDE_7_DONT_2", "safety_tips", "Do not return to evacuated areas until authorities declare it safe"),
    # ── Part A: Wildfire ──────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_1_TITLE",  "safety_tips", "Evacuate Immediately When Ordered"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_1_DO_1",   "safety_tips", "If you receive an evacuation order, leave immediately — wildfires change direction rapidly"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_1_DO_2",   "safety_tips", "Close all windows and doors as you leave to slow fire entering — leave them unlocked for emergency responders"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_2_TITLE",  "safety_tips", "Protect Yourself While Evacuating"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_2_DO_1",   "safety_tips", "Wear a mask or cover your nose and mouth with a damp cloth while evacuating"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_2_DO_2",   "safety_tips", "Take your emergency kit, medications, important documents, and pets if you can do so quickly"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_3_TITLE",  "safety_tips", "If There Is No Escape Route"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_3_DO_1",   "safety_tips", "If caught with no escape route, shelter in a building or lie face down in a ditch away from vegetation"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_3_DO_2",   "safety_tips", "Breathe through your nose — nasal passages filter more smoke than mouth breathing"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_4_TITLE",  "safety_tips", "After a Wildfire"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_4_DO_1",   "safety_tips", "After a wildfire, check your roof for embers before re-entering — embers can smoulder for hours"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_4_DO_2",   "safety_tips", "Wear a mask and gloves when working in ash — it may contain toxic materials"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_5_TITLE",  "safety_tips", "Ignore Orders or Re-enter Too Soon"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_5_DONT_1", "safety_tips", "Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_5_DONT_2", "safety_tips", "Do not re-enter evacuated areas until declared safe — hidden hot spots can reignite"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_6_TITLE",  "safety_tips", "Park Under Trees or Use Contaminated Water"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_6_DONT_1", "safety_tips", "Do not park under trees during or after a wildfire — weakened trees can fall without warning"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_6_DONT_2", "safety_tips", "Do not use water that may be contaminated by fire retardants — use bottled water only"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_7_TITLE",  "safety_tips", "Inhale Ash or Fight the Fire Yourself"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_7_DONT_1", "safety_tips", "Do not inhale ash unnecessarily — wear a properly fitted particulate mask where available"),
    ("SAFETY_TIP_A_WILDFIRE_SLIDE_7_DONT_2", "safety_tips", "Do not attempt to fight a wildfire yourself — evacuate and let trained firefighters handle it"),
    # ── Part A: Explosion ─────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_1_TITLE",  "safety_tips", "Take Cover Immediately"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_1_DO_1",   "safety_tips", "Immediately take cover behind a solid object or drop to the ground face down"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_1_DO_2",   "safety_tips", "Cover your head and neck with your arms to protect from debris"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_2_TITLE",  "safety_tips", "Move Away and Help If Safe"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_2_DO_1",   "safety_tips", "Once the immediate danger passes, move away from the site quickly and calmly"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_2_DO_2",   "safety_tips", "Help injured people move away only if you can do so safely without putting yourself at risk"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_3_TITLE",  "safety_tips", "Seek Medical Attention and Report"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_3_DO_1",   "safety_tips", "Seek medical attention for any injuries — blast injuries may not be immediately visible"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_3_DO_2",   "safety_tips", "Report the explosion to emergency services as soon as you are in a safe location"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_4_TITLE",  "safety_tips", "Follow Official Instructions"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_4_DO_1",   "safety_tips", "Follow instructions from emergency services and authorities on the ground"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_4_DO_2",   "safety_tips", "Stay upwind of the explosion site to avoid inhaling smoke or chemical fumes"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_5_TITLE",  "safety_tips", "Return to the Site or Use Phones Near Gas"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_5_DONT_1", "safety_tips", "Do not return to the explosion site — secondary explosions are common"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_5_DONT_2", "safety_tips", "Do not use mobile phones or electrical switches near a gas leak — sparks can trigger another explosion"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_6_TITLE",  "safety_tips", "Touch Debris or Spread Rumours"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_6_DONT_1", "safety_tips", "Do not touch suspicious packages or debris around the site"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_6_DONT_2", "safety_tips", "Do not post unverified information about the cause — this can spread panic"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_7_TITLE",  "safety_tips", "Block Access or Enter Damaged Buildings"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_7_DONT_1", "safety_tips", "Do not block emergency service access routes"),
    ("SAFETY_TIP_A_EXPLOSION_SLIDE_7_DONT_2", "safety_tips", "Do not enter damaged buildings — structural collapse risk is high after an explosion"),
    # ── Part A: Chemical Incident ─────────────────────────────────────────────────
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_1_TITLE",  "safety_tips", "Move Upwind or Shelter in Place"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_1_DO_1",   "safety_tips", "Move upwind and uphill from the incident immediately"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_1_DO_2",   "safety_tips", "If indoors, shelter in place — close all windows, doors, and ventilation systems"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_2_TITLE",  "safety_tips", "Decontaminate and Cover Your Mouth"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_2_DO_1",   "safety_tips", "If you have been exposed, remove outer clothing and wash skin thoroughly with water"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_2_DO_2",   "safety_tips", "Cover your nose and mouth with a wet cloth if you must move through contaminated air"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_3_TITLE",  "safety_tips", "Follow Evacuation Instructions"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_3_DO_1",   "safety_tips", "Follow evacuation instructions from emergency services exactly"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_3_DO_2",   "safety_tips", "Seek medical attention even if you feel well — chemical exposure symptoms can be delayed"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_4_TITLE",  "safety_tips", "Monitor Updates and Flush Eyes If Needed"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_4_DO_1",   "safety_tips", "Listen to official broadcasts for information on safe zones and decontamination points"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_4_DO_2",   "safety_tips", "If your eyes are burning, flush them with clean water for at least 15 minutes"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_5_TITLE",  "safety_tips", "Approach the Source or Eat Nearby"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_5_DONT_1", "safety_tips", "Do not approach the source of a chemical incident — even brief exposure can be fatal"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_5_DONT_2", "safety_tips", "Do not eat, drink, or smoke in or near the affected area"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_6_TITLE",  "safety_tips", "Trust Your Nose or Re-enter Too Soon"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_6_DONT_1", "safety_tips", "Do not rely on smell to determine safety — many hazardous chemicals are odourless"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_6_DONT_2", "safety_tips", "Do not re-enter the affected area until authorities declare it safe"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_7_TITLE",  "safety_tips", "Spread Rumours or Remove Protective Gear"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_7_DONT_1", "safety_tips", "Do not spread rumours about the cause — chemical incidents cause significant public panic"),
    ("SAFETY_TIP_A_CHEMICAL_INCIDENT_SLIDE_7_DONT_2", "safety_tips", "Do not remove protective clothing given by emergency services until instructed"),
    # ── Part A: Conflict ──────────────────────────────────────────────────────────
    ("SAFETY_TIP_A_CONFLICT_SLIDE_1_TITLE",  "safety_tips", "Find Cover and Stay Away from Windows"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_1_DO_1",   "safety_tips", "If caught in an active conflict zone, find cover immediately — lie flat behind a solid structure"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_1_DO_2",   "safety_tips", "Stay away from windows, doors, and open spaces during active shooting or shelling"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_2_TITLE",  "safety_tips", "Follow Legitimate Authority and Move Safely"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_2_DO_1",   "safety_tips", "Follow instructions from legitimate security forces or humanitarian organisations"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_2_DO_2",   "safety_tips", "If evacuating, move quickly and low, using buildings and terrain as cover"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_3_TITLE",  "safety_tips", "Keep an Emergency Bag Ready"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_3_DO_1",   "safety_tips", "Keep an emergency bag ready with documents, water, food, and medications"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_3_DO_2",   "safety_tips", "Identify safe exit routes from your home and neighbourhood in advance"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_4_TITLE",  "safety_tips", "Shelter in Place and Conserve Power"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_4_DO_1",   "safety_tips", "If sheltering in place, move to an interior room away from windows on the lowest floor"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_4_DO_2",   "safety_tips", "Conserve phone battery and charge devices whenever power is available"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_5_TITLE",  "safety_tips", "Film Military or Touch Unexploded Ordnance"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_5_DONT_1", "safety_tips", "Do not film or photograph military personnel or equipment — this can put you at serious risk"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_5_DONT_2", "safety_tips", "Do not approach unexploded ordnance or debris — mark the location and report it"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_6_TITLE",  "safety_tips", "Use Open Flames or Post Your Location"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_6_DONT_1", "safety_tips", "Do not use open flames at night — light can attract attention in conflict zones"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_6_DONT_2", "safety_tips", "Do not spread your location on social media during active conflict"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_7_TITLE",  "safety_tips", "Cross Front Lines or Ignore Curfews"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_7_DONT_1", "safety_tips", "Do not attempt to cross front lines or enter restricted areas"),
    ("SAFETY_TIP_A_CONFLICT_SLIDE_7_DONT_2", "safety_tips", "Do not ignore curfews or movement restrictions imposed by authorities"),
    # ── Part A: Civil Unrest ──────────────────────────────────────────────────────
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_1_TITLE",  "safety_tips", "Move Calmly to the Edges"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_1_DO_1",   "safety_tips", "If caught in a crowd disturbance, move calmly to the edges and away from the crowd"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_1_DO_2",   "safety_tips", "Stay aware of your surroundings and identify exit routes before any situation escalates"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_2_TITLE",  "safety_tips", "If Tear Gas Is Used"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_2_DO_1",   "safety_tips", "If tear gas is used, move upwind and flush eyes with clean water"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_2_DO_2",   "safety_tips", "Cover your nose and mouth with a wet cloth to reduce inhalation of irritants"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_3_TITLE",  "safety_tips", "Stay in Contact and Follow Instructions"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_3_DO_1",   "safety_tips", "Stay in contact with family or trusted contacts about your location"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_3_DO_2",   "safety_tips", "Follow instructions from police or security forces unless doing so puts you at immediate risk"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_4_TITLE",  "safety_tips", "Observe Safely and Document from a Distance"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_4_DO_1",   "safety_tips", "If you are a reporter or observer, identify yourself clearly and stay to the periphery"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_4_DO_2",   "safety_tips", "Document damage and injuries only from a safe distance"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_5_TITLE",  "safety_tips", "Engage or Blend In With Crowds"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_5_DONT_1", "safety_tips", "Do not engage with crowds or attempt to intervene in confrontations"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_5_DONT_2", "safety_tips", "Do not wear clothing that could be mistaken for that of any group involved"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_6_TITLE",  "safety_tips", "Share Real-Time Movements or Use Flash"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_6_DONT_1", "safety_tips", "Do not share real-time location of security forces or crowd movements on social media"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_6_DONT_2", "safety_tips", "Do not use flash photography in tense situations — it can provoke a response"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_7_TITLE",  "safety_tips", "Block Emergency Routes or Spread Rumours"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_7_DONT_1", "safety_tips", "Do not block emergency vehicle access routes"),
    ("SAFETY_TIP_A_CIVIL_UNREST_SLIDE_7_DONT_2", "safety_tips", "Do not spread unverified reports of casualties or causes — this escalates tensions"),
    # ── Part B: Reporting Guidelines ──────────────────────────────────────────────
    ("SAFETY_TIP_B_SLIDE_1_TITLE",    "safety_tips", "Only Report What You Can Safely See"),
    ("SAFETY_TIP_B_SLIDE_1_BULLET_1", "safety_tips", "Never put yourself in danger to get closer to an incident. If you cannot see it from a safe distance, do not report it."),
    ("SAFETY_TIP_B_SLIDE_1_BULLET_2", "safety_tips", "Your safety is more valuable than any report. Accurate reporting from a safe vantage point is always better than no report at all."),
    ("SAFETY_TIP_B_SLIDE_2_TITLE",    "safety_tips", "Take Clear Photos from a Safe Distance"),
    ("SAFETY_TIP_B_SLIDE_2_BULLET_1", "safety_tips", "Use zoom rather than approaching the damage. A clear photo from 20 metres is more useful than a blurred one from 5 metres."),
    ("SAFETY_TIP_B_SLIDE_2_BULLET_2", "safety_tips", "Photograph the full structure, not just the damage. Context — surrounding buildings, street layout — is essential for assessment."),
    ("SAFETY_TIP_B_SLIDE_3_TITLE",    "safety_tips", "Be Accurate with Location — Use GPS When Possible"),
    ("SAFETY_TIP_B_SLIDE_3_BULLET_1", "safety_tips", "Enable GPS on your device before reaching the site. Allow the app to auto-detect your location for the highest accuracy."),
    ("SAFETY_TIP_B_SLIDE_3_BULLET_2", "safety_tips", "If GPS is unavailable, note the building name, street address, or a nearby landmark to allow accurate manual geo-coding."),
    ("SAFETY_TIP_B_SLIDE_4_TITLE",    "safety_tips", "One Report Per Building — No Duplicates"),
    ("SAFETY_TIP_B_SLIDE_4_BULLET_1", "safety_tips", "Submit only one report per building per visit. Duplicate reports waste analyst time and distort damage statistics."),
    ("SAFETY_TIP_B_SLIDE_4_BULLET_2", "safety_tips", "If conditions have changed significantly since your last report on a building, submit an update rather than a new report."),
    ("SAFETY_TIP_B_SLIDE_5_TITLE",    "safety_tips", "Your Identity is Protected — Reports Are Anonymised"),
    ("SAFETY_TIP_B_SLIDE_5_BULLET_1", "safety_tips", "Your name, email, and device information are encrypted at rest and never included in exported datasets."),
    ("SAFETY_TIP_B_SLIDE_5_BULLET_2", "safety_tips", "Reports shared with humanitarian organisations contain only location data, damage classification, and timestamps — never personal identifiers."),
    # ── Part C: First Aid ─────────────────────────────────────────────────────────
    ("SAFETY_TIP_C_SLIDE_1_TITLE",    "safety_tips", "Controlling Bleeding"),
    ("SAFETY_TIP_C_SLIDE_1_BULLET_1", "safety_tips", "Apply firm, direct pressure to the wound with a clean cloth or bandage and maintain it continuously for at least 10 minutes."),
    ("SAFETY_TIP_C_SLIDE_1_BULLET_2", "safety_tips", "Elevate the injured limb above heart level if possible. Do not remove the cloth — add more on top if it soaks through."),
    ("SAFETY_TIP_C_SLIDE_2_TITLE",    "safety_tips", "Recovery Position"),
    ("SAFETY_TIP_C_SLIDE_2_BULLET_1", "safety_tips", "Place an unconscious, breathing person on their side with their top knee bent forward to prevent them rolling back."),
    ("SAFETY_TIP_C_SLIDE_2_BULLET_2", "safety_tips", "Tilt their head back gently to open the airway, and place their hand under their cheek. Monitor breathing continuously."),
    ("SAFETY_TIP_C_SLIDE_3_TITLE",    "safety_tips", "Treating Shock"),
    ("SAFETY_TIP_C_SLIDE_3_BULLET_1", "safety_tips", "Lay the person flat and, if not injured, raise their legs 20–30 cm above heart level to improve blood flow to vital organs."),
    ("SAFETY_TIP_C_SLIDE_3_BULLET_2", "safety_tips", "Keep them warm with a blanket. Do not give food or water. Reassure them calmly and monitor their breathing until help arrives."),
    ("SAFETY_TIP_C_SLIDE_4_TITLE",    "safety_tips", "Burns Treatment"),
    ("SAFETY_TIP_C_SLIDE_4_BULLET_1", "safety_tips", "Cool the burn immediately under cool (not cold) running water for at least 20 minutes. Remove jewellery near the burn if possible."),
    ("SAFETY_TIP_C_SLIDE_4_BULLET_2", "safety_tips", "Cover the burn loosely with cling film or a clean non-fluffy material. Do not apply butter, toothpaste, or ice."),
    ("SAFETY_TIP_C_SLIDE_5_TITLE",    "safety_tips", "Fractures and Immobilisation"),
    ("SAFETY_TIP_C_SLIDE_5_BULLET_1", "safety_tips", "Do not attempt to straighten a fractured limb. Immobilise it in the position found using a splint and soft padding."),
    ("SAFETY_TIP_C_SLIDE_5_BULLET_2", "safety_tips", "A splint can be improvised from a straight stick, rolled newspaper, or folded clothing tied firmly — not tightly — above and below the fracture."),
    ("SAFETY_TIP_C_SLIDE_6_TITLE",    "safety_tips", "When Not to Move an Injured Person"),
    ("SAFETY_TIP_C_SLIDE_6_BULLET_1", "safety_tips", "Do not move someone who may have a spinal injury (high-impact trauma, neck pain, tingling/numbness) unless they are in immediate danger."),
    ("SAFETY_TIP_C_SLIDE_6_BULLET_2", "safety_tips", "If you must move them, keep the head, neck, and spine aligned at all times and use multiple people to maintain a straight carry."),

    # ══════════════════════════════════════════════════════════════════════════════
    # NEW ENTRIES — Keys used in web/mobile code but previously absent from the
    # translation pipeline. Added to ensure all UI strings are translatable.
    # ══════════════════════════════════════════════════════════════════════════════

    # ── Q1–Q8 question labels (mobile uses dotted keys; web uses Q*_LABEL via qTitle()) ──
    ("questions.q1.title",        "question", "How bad is the damage?"),
    ("questions.q2.title",        "question", "What type of infrastructure is this?"),
    ("questions.q2.hint",         "question", "Select all that apply"),
    ("questions.q3.title",        "question", "Name or details of the infrastructure"),
    ("questions.q4.title",        "question", "What type of disaster is this?"),
    ("questions.q4.group_natural",      "question", "Natural hazards"),
    ("questions.q4.group_technological","question", "Technological or industrial hazards"),
    ("questions.q4.group_humanmade",    "question", "Human-made crises"),
    ("questions.q5.title",        "question", "Is there debris that needs clearing near this location?"),
    ("questions.q6.title",        "question", "What is the current condition of electricity infrastructure in your community following the crisis?"),
    ("questions.q7.title",        "question", "How would you rate the overall functioning of health services in your community since the event?"),
    ("questions.q8.title",        "question", "What are the most pressing needs?"),
    ("questions.q8.hint",         "question", "Select all that apply"),

    # ── Q1 answer options (mobile — longer descriptive text than UPPERCASE versions) ──
    ("questions.q1.opt_minimal",  "answer", "Minimal / No damage — structurally sound and functional, showing only cosmetic or no visible damage"),
    ("questions.q1.opt_partial",  "answer", "Partially damaged — repairable, and remains usable with caution"),
    ("questions.q1.opt_complete", "answer", "Completely damaged — structurally unsafe or destroyed"),

    # ── Q2 answer options (mobile — with descriptive context) ──
    ("questions.q2.opt_residential",  "answer", "Residential Infrastructure — houses and apartments"),
    ("questions.q2.opt_commercial",   "answer", "Commercial Infrastructure — markets, malls, shops, hotels, banks, industries, etc."),
    ("questions.q2.opt_government",   "answer", "Government Building — administrative buildings, courthouses, police stations, fire stations, etc."),
    ("questions.q2.opt_utility",      "answer", "Utility Infrastructure — water pumps, power plants, waste treatment plants, etc."),
    ("questions.q2.opt_transport",    "answer", "Transport and Communication Infrastructure — roads, cell towers, bridges, railway station, bus station, etc."),
    ("questions.q2.opt_community",    "answer", "Community Infrastructure — schools, hospitals, community halls, public toilets, etc."),
    ("questions.q2.opt_public_spaces","answer", "Public Spaces / Recreation Infrastructure — stadiums, playgrounds, religious buildings, etc."),
    ("questions.q2.opt_other",        "answer", "Other — please specify"),
    ("questions.q3.placeholder",      "answer", "Enter the name or description of the building or structure"),

    # ── Q4 disaster-type options (mobile uses questions.q4.opt_*; web uses disaster_types.* dynamically) ──
    ("questions.q4.opt_conflict",          "answer", "Conflict"),

    # ── Q5 options (mobile; web uses Q5_OPT_* dynamically via qOptions) ──

    # ── Q6 options (mobile; web uses Q6_OPT_* dynamically) ──

    # ── Q7 options (mobile; web uses Q7_OPT_* dynamically) ──

    # ── Q8 options (mobile uses questions.q8.opt_*; web uses Q8_KEY_MAP literal keys) ──

    # ── Questions UI chrome (recovery modal, hints) ──
    ("questions.recoveryTitle",          "ui_report", "Resume previous report?"),
    ("questions.recoveryMessage",        "ui_report", "You have an unfinished report from a previous session. Would you like to continue where you left off?"),
    ("questions.recoveryContinue",       "ui_report", "Continue"),
    ("questions.recoveryStartFresh",     "ui_report", "Start fresh"),
    ("questions.answerHint",             "ui_report", "Please answer this question to continue."),
    ("questions.please_select",          "ui_report", "Please select an answer to continue."),
    ("questions.otherSpecifyPlaceholder","ui_report", "Please specify..."),

    # ── Report submission — extended web UI strings ──
    ("report.building_selected",        "ui_report", "Building Selected"),
    ("report.building_type_label",      "ui_report", "Type:"),
    ("report.building_name_label",      "ui_report", "BUILDING NAME"),
    ("report.unnamed_building",         "ui_report", "Unnamed Building"),
    ("report.pin_dropped",              "ui_report", "Pin Dropped"),
    ("report.gps_captured",             "ui_report", "GPS Location Captured"),
    ("report.location_zoom_hint",       "ui_report", "Zoom in to see and select buildings"),
    ("report.loading_buildings",        "ui_report", "Loading footprints…"),
    ("report.msft_footprints_note",     "ui_report", "Microsoft Building Footprints active — building selection uses ML-detected footprints."),
    ("report.location_note_label",      "ui_report", "ADD A LOCATION NOTE (OPTIONAL)"),
    ("report.location_note_placeholder","ui_report", "e.g. Blue gate on the left, next to the pharmacy"),
    ("report.landmark_placeholder",     "ui_report", "Landmark (e.g. Near central market)"),
    ("report.show_manual_entry",        "ui_report", "Enter location manually instead ▼"),
    ("report.hide_manual_entry",        "ui_report", "Hide manual entry ▲"),
    ("report.location_changed_warning", "ui_report", "Your location has changed. Please confirm or update the infrastructure name."),
    ("report.select_all_apply",         "ui_report", "Select all that apply."),
    ("report.please_specify",           "ui_report", "Please specify..."),
    ("report.drop_photo_here",          "ui_report", "Drop your photo here"),
    ("report.drag_photo_here",          "ui_report", "Drag a photo here, or"),
    ("report.upload_photo_btn",         "ui_report", "Upload a Photo"),
    ("report.take_photo_btn",           "ui_report", "Take a Photo"),
    ("report.camera_denied_msg",        "ui_report", "Camera access is not available. You can enable it in your browser settings."),
    ("report.max_photos_reached",       "ui_report", "Maximum 3 photos added."),
    ("report.photo_action_view",        "ui_report", "View"),
    ("report.photo_action_replace",     "ui_report", "Replace"),
    ("report.photo_action_remove",      "ui_report", "Remove"),
    ("report.preparing_photos",         "ui_report", "Preparing photos…"),
    ("report.duplicate_inline_warning", "ui_report", "A report for this location may already exist from this device. You can still submit if this is a different incident."),
    ("report.location_outside_crisis_area", "ui_report", "Your selected location appears to be outside the primary crisis area. You can still submit if this is correct."),
    ("report.validation_incomplete",    "ui_report", "Please complete all required fields"),
    ("report.required_fields_title",    "ui_report", "Required Fields"),
    ("report.required_fields_body",     "ui_report", "Please complete all required fields before submitting."),
    ("report.error_no_connection",      "ui_report", "No Connection"),
    ("report.error_no_internet",        "ui_report", "No internet connection. Please check your connection and try again."),
    ("report.error_no_internet_warning","ui_report", "Do not close this tab — your report data will be lost."),
    ("report.error_timeout",            "ui_report", "This is taking longer than expected. Please try again."),

    # ── Report review screen (web) ──
    ("report.review_damage_assessment", "ui_report", "Damage Assessment"),
    ("report.review_community_impact",  "ui_report", "Community Impact"),
    ("report.review_photos",            "ui_report", "Photos"),
    ("report.review_location",          "ui_report", "Location"),
    ("report.review_label_building",    "ui_report", "Building"),
    ("report.review_label_type",        "ui_report", "Type"),
    ("report.review_label_address",     "ui_report", "Address"),
    ("report.review_label_landmark",    "ui_report", "Landmark"),
    ("report.review_label_building_name","ui_report","Building name"),
    ("report.review_label_footprint_id","ui_report", "Footprint ID"),
    ("report.review_label_pin_location","ui_report", "Pin Location"),
    ("report.review_label_gps",         "ui_report", "GPS"),
    ("report.review_label_location_note","ui_report","Location note"),
    ("report.review_label_q2_other",    "ui_report", "Q2 — Other"),
    ("report.review_label_q8_other",    "ui_report", "Q8 — Other"),
    ("report.review_label_location",    "ui_report", "Location"),
    ("report.review_q1",                "ui_report", "Q1 — Damage Level"),
    ("report.review_q2",                "ui_report", "Q2 — Infrastructure"),
    ("report.review_q3",                "ui_report", "Q3 — Infrastructure Name"),
    ("report.review_q4",                "ui_report", "Q4 — Disaster Type"),
    ("report.review_q5",                "ui_report", "Q5 — Debris Blocking"),
    ("report.review_q6",                "ui_report", "Q6 — Electricity"),
    ("report.review_q7",                "ui_report", "Q7 — Health Services"),
    ("report.review_q8",                "ui_report", "Q8 — Pressing Needs"),
    ("report.review_no_location",       "ui_report", "No location details entered"),
    ("report.review_not_specified",     "ui_report", "Not specified"),
    ("report.review_gps_not_available", "ui_report", "Not available"),
    ("report.review_photo_required",    "ui_report", "At least one photo is required. Please add a photo before submitting."),
    ("report.success_report_summary",   "ui_report", "Report Summary"),
    ("report.success_incident_label",   "ui_report", "Incident Type"),
    ("report.success_location_label",   "ui_report", "Location"),
    ("report.success_status_label",     "ui_report", "Status"),
    ("report.success_submitted_now",    "ui_report", "Submitted just now"),
    ("report.success_report_id_note",   "ui_report", "Your report ID has been recorded in the background"),
    ("confirmation.success_message",    "ui_report", "Your report has been submitted. Thank you for helping crisis response teams get to the right places faster."),

    # ── Mobile review / submit screen ──
    ("review.confirmationTitle",          "ui_report", "Report submitted"),
    ("review.confirmationMessage",        "ui_report", "Your report has been submitted. Thank you for helping crisis response teams get to the right places faster."),
    ("review.confirmationSubmitAnother",  "ui_report", "Submit another report"),
    ("review.confirmationGoHome",         "ui_report", "Go to Home"),
    ("review.editLink",                   "ui_report", "Edit"),
    ("review.photosSection",              "ui_report", "Photos"),
    ("review.photoRequired",              "ui_report", "At least one photo is required. Please add a photo before submitting."),
    ("review.locationSection",            "ui_report", "Location"),
    ("review.locationAddress",            "ui_report", "Address"),
    ("review.locationBuilding",           "ui_report", "Building"),
    ("review.locationBuildingName",       "ui_report", "Building name"),
    ("review.locationBuildingType",       "ui_report", "Type"),
    ("review.locationFootprintId",        "ui_report", "Footprint ID"),
    ("review.locationGPS",                "ui_report", "GPS"),
    ("review.locationGPSCaptured",        "ui_report", "GPS coordinates captured"),
    ("review.locationGPSUnavailable",     "ui_report", "GPS not available for this submission"),
    ("review.locationLandmark",           "ui_report", "Landmark"),
    ("review.locationManualNote",         "ui_report", "Map was not available — manual entry used"),
    ("review.locationNote",               "ui_report", "Note"),
    ("review.locationPinDrop",            "ui_report", "Pin dropped on map"),
    ("review.locationChangedNote",        "ui_report", "Your location has changed. Please confirm or update the infrastructure name."),
    ("review.q1Label",                    "ui_report", "Damage level"),
    ("review.q2Label",                    "ui_report", "Infrastructure type"),
    ("review.q3Label",                    "ui_report", "Infrastructure name"),
    ("review.q4Label",                    "ui_report", "Disaster type"),
    ("review.q5Label",                    "ui_report", "Debris clearing needed"),
    ("review.q6Label",                    "ui_report", "Electricity condition"),
    ("review.q7Label",                    "ui_report", "Health services"),
    ("review.q8Label",                    "ui_report", "Pressing needs"),
    ("review.questionsSection",           "ui_report", "Questions"),
    ("review.submitButton",               "ui_report", "Submit"),
    ("review.submitRetry",                "ui_report", "Retry"),
    ("review.submitTimeout",              "ui_report", "This is taking longer than expected. Please try again."),
    ("review.queueTitle",                 "ui_report", "Report saved"),
    ("review.queueMessage",               "ui_report", "No internet connection. Your report has been saved and will be sent automatically when internet returns."),
    ("review.queueRetry",                 "ui_report", "Retry now"),
    ("review.queueAndroidNote",           "ui_report", "You do not need to keep this app open — your report will send automatically in the background."),
    ("review.queueSubmitAnother",         "ui_report", "Submit another report"),
    ("review.queueGoHome",                "ui_report", "Go to Home"),
    ("review.queueSummaryDamage",         "ui_report", "Damage level"),
    ("review.queueSummaryLocation",       "ui_report", "Location"),

    # ── My Reports page (web) ──
    ("my_reports.col_damage",            "ui_report", "Damage Level"),
    ("my_reports.col_date",              "ui_report", "Date"),
    ("my_reports.col_location",          "ui_report", "Location"),
    ("my_reports.col_status",            "ui_report", "Status"),
    ("my_reports.label_building",        "ui_report", "Building"),
    ("my_reports.label_infrastructure",  "ui_report", "Infrastructure"),
    ("my_reports.label_disaster_type",   "ui_report", "Disaster Type:"),
    ("my_reports.label_photos",          "ui_report", "Photos"),
    ("my_reports.photos_tap_to_view",    "ui_report", "Tap to view full size"),
    ("my_reports.location_not_recorded", "ui_report", "Location not recorded"),
    ("my_reports.empty_anonymous",       "ui_report", "Submit your first report to get started."),
    ("my_reports.submitted_section",     "ui_report", "Submitted"),
    ("my_reports.offline_label",         "ui_report", "Offline"),
    ("my_reports.action_retry",          "ui_report", "Retry"),
    ("my_reports.action_delete",         "ui_report", "Delete"),
    ("my_reports.action_deleting",       "ui_report", "Deleting…"),
    ("my_reports.action_retrying",       "ui_report", "Retrying…"),
    ("my_reports.login_btn",             "ui_report", "Log In"),
    ("my_reports.register_btn",          "ui_report", "Create Account"),
    ("my_reports.offline_uploading",     "ui_report", "Uploading…"),
    ("my_reports.offline_upload_failed", "ui_report", "Upload Failed"),
    ("my_reports.pending_upload_label",  "ui_report", "Pending Upload ({{count}})"),
    ("my_reports.upload_issues_label",   "ui_report", "Upload Issues ({{count}})"),
    ("my_reports.failed_attempts",       "ui_report", "Failed after {{count}} attempt(s). Check connection."),
    ("my_reports.retry_partial_title",   "ui_report", "Report uploaded"),
    ("my_reports.retry_partial_body",    "ui_report", "Your report reached our servers. Photos are still uploading — you can see the report in My Reports now."),
    # Location step — geo-fence and offline country picker (Logic 1 + 2)
    ("locationScreen.tooFarFromGps", "ui_location", "This location is too far from your current position. Please select a location closer to where you are."),
    ("locationScreen.countryLabel",  "ui_location", "Country (where is the damage?)"),
    ("locationScreen.countryHint",   "ui_location", "Pre-filled from your profile. Change if the damage is in a different country."),
    ("locationScreen.countrySearch", "ui_location", "Search countries…"),
    ("locationScreen.selectCountry", "ui_location", "Select country"),
    ("location.too_far_from_gps",    "ui_location", "This location is too far from your current position. Please select a location closer to where you are."),
    ("location.country_label",       "ui_location", "Country (where is the damage?)"),
    ("location.country_hint",        "ui_location", "Pre-filled from your settings. Change if the damage is in a different country."),
    ("location.country_search",      "ui_location", "Search countries…"),
    ("location.select_country",      "ui_location", "Select country"),

    # ── Photo screen (mobile) ──
    ("photoScreen.guidelines.title",     "ui_report", "Photo guidelines"),
    ("photoScreen.guidelines.g1",        "ui_report", "Make sure the damage is clearly visible in the photo"),
    ("photoScreen.guidelines.g2",        "ui_report", "Avoid photos that are too dark or blurry"),
    ("photoScreen.guidelines.g3",        "ui_report", "Take the photo from a safe distance — do not put yourself at risk"),
    ("photoScreen.guidelines.g4",        "ui_report", "Include the full structure in the frame where possible"),
    ("photoScreen.maxPhotos",            "ui_report", "Maximum 3 photos reached"),
    ("photoScreen.validationBlank",      "ui_report", "This photo appears to be blank. Please take a new photo."),
    ("photoScreen.validationTitle",      "ui_report", "Cannot Use This Photo"),
    ("photoScreen.validationDuplicate",  "ui_report", "This photo is already added to your report."),
    ("photoScreen.validationEmpty",      "ui_report", "No photo was selected. Please try again."),
    ("photoScreen.validationFormat",     "ui_report", "This file type cannot be used. Please take a new photo or select a JPG, PNG, or similar image from your gallery."),
    ("photoScreen.validationGif",        "ui_report", "Animated or GIF files cannot be used. Please select a standard photo."),
    ("photoScreen.validationTooSmall",   "ui_report", "This image is too small to use. Please take a new photo."),
    ("photoScreen.removeTitle",          "ui_report", "Remove this photo?"),
    ("photoScreen.removeConfirm",        "ui_report", "Remove"),
    ("photoScreen.removeCancel",         "ui_report", "Cancel"),
    ("photoScreen.replaceTitle",         "ui_report", "Replace Photo"),
    ("photoScreen.replaceSource",        "ui_report", "Choose a source"),
    ("photoScreen.replaceButton",        "ui_report", "Replace"),
    ("photoScreen.cameraAccessTitle",    "ui_report", "Camera Access Needed"),
    ("photoScreen.cameraAccessMsg",      "ui_report", "Camera access is not available. You can enable it in your phone settings."),
    ("photoScreen.galleryAccessTitle",   "ui_report", "Gallery Access Needed"),
    ("photoScreen.galleryAccessMsg",     "ui_report", "Gallery access is not available. You can enable it in your phone settings."),
    ("photoScreen.openSettings",         "ui_report", "Open Settings"),

    # ── Location screen (mobile) ──
    ("locationScreen.searchPlaceholder",          "ui_location", "Search for a street, landmark, or building..."),
    ("locationScreen.searchResultsEmpty",         "ui_location", "No results found. Try a different search term."),
    ("locationScreen.confirmBuilding",            "ui_location", "Confirm this building?"),
    ("locationScreen.confirmBuildingButton",      "ui_location", "Confirm"),
    ("locationScreen.buildingNameLabel",          "ui_location", "Building name"),
    ("locationScreen.buildingTypeLabel",          "ui_location", "Building type"),
    ("locationScreen.buildingCoordsLabel",        "ui_location", "Coordinates"),
    ("locationScreen.editBuildingName",           "ui_location", "Edit building name"),
    ("locationScreen.locationNote",               "ui_location", "Add a location note (optional)"),
    ("locationScreen.locationNoteHint",           "ui_location", "The building may appear under a different name on the map — add the name you know it by. Add any detail that helps identify the exact spot."),
    ("locationScreen.manualAddress",              "ui_location", "Address"),
    ("locationScreen.manualAddressPlaceholder",   "ui_location", "Street address or area name"),
    ("locationScreen.manualBuildingName",         "ui_location", "Building Name"),
    ("locationScreen.manualBuildingNamePlaceholder","ui_location","Name of the specific building or structure"),
    ("locationScreen.manualLandmark",             "ui_location", "Landmark"),
    ("locationScreen.manualLandmarkPlaceholder",  "ui_location", "A nearby known place (e.g. near the school next to the market)"),
    ("locationScreen.manualAtLeastOne",           "ui_location", "At least one field must be filled in to continue."),
    ("locationScreen.gpsRecorded",                "ui_location", "Your GPS location has been recorded and will be attached to this report."),
    ("locationScreen.gpsUnavailable",             "ui_location", "GPS signal not available. Your manual location details will be used."),
    ("locationScreen.gpsUnavailableOnline",       "ui_location", "Your GPS location is not available. You can still select a building on the map or use the search bar to find your location."),
    ("locationScreen.gpsCaptured",                "ui_location", "GPS location captured — you can proceed or also select a building for precision."),
    ("locationScreen.offlineBanner",              "ui_location", "You are offline. Please enter your location details below."),
    ("locationScreen.duplicateWarningTitle",      "ui_location", "Possible duplicate report"),
    ("locationScreen.duplicateWarningBody",       "ui_location", "A report for this location was recently submitted. Do you want to continue with a new report?"),
    ("locationScreen.duplicateWarningContinue",   "ui_location", "Continue"),
    ("locationScreen.duplicateWarningGoBack",     "ui_location", "Go Back"),
    ("locationScreen.mapLoading",                 "ui_location", "Loading map…"),
    ("locationScreen.cancelButton",               "ui_location", "Cancel"),
    ("locationScreen.manualAddressRequired",      "ui_location", "* Address is required to continue when offline"),

    # ── Location offline/GPS messages (web) ──
    ("location.offline_banner",           "ui_location", "No internet connection. Please enter your location details below."),
    ("location.connection_lost",          "ui_location", "Connection lost. You can still select a building from the area already loaded, or enter your location manually below."),
    ("location.offline_gps_captured",     "ui_location", "Your GPS location has been recorded and will be attached to this report."),
    ("location.offline_no_gps",           "ui_location", "GPS is not available. Your manual location details will be used to identify this report."),
    ("location.gps_unavailable_inline",   "ui_location", "Your location could not be detected. You can still select a building on the map or use the search bar to find your location."),

    # ── Map UI (web) ──
    ("map.pin_reported",   "ui_map", "Reported: "),
    ("map.pin_id",         "ui_map", "ID: "),
    ("map.offline_message",       "ui_map", "The map requires an internet connection. Please check your connection and try again."),
    ("map.offline_title",         "ui_map", "Map Unavailable"),
    ("map.offline_gps_note",      "ui_map", "GPS still works — your location is recorded in the background"),
    ("map.gps_chip_unavailable",  "ui_map", "GPS not available"),

    # ── Auth / Login (mobile) ──
    ("login.emailPlaceholder",       "ui_auth", "Email address"),
    ("login.passwordPlaceholder",    "ui_auth", "Password"),
    ("login.loginButton",            "ui_auth", "Log In"),
    ("login.forgotPassword",         "ui_auth", "Forgot password?"),
    ("login.forgotPasswordMessage",  "ui_auth", "Please contact your UNDP coordinator to reset your password."),
    ("login.errorInvalid",           "ui_auth", "Invalid email or password. Please try again."),
    ("login.errorGeneric",           "ui_auth", "Something went wrong. Please try again."),
    ("loginPopup.title",             "ui_auth", "Welcome to Crisis Reporter"),
    ("loginPopup.body",              "ui_auth", "Have you used Crisis Reporter before? If you have an existing verified account, log in to restore your reports, badges, and profile."),
    ("loginPopup.loginButton",       "ui_auth", "Log In"),
    ("loginPopup.createButton",      "ui_auth", "Create Account"),
    ("loginPopup.skipButton",        "ui_auth", "Skip for now"),
    ("profile.email_invalid",        "ui_auth", "Please enter a valid email address"),
    ("profile.email_change_confirm", "ui_auth", "You are changing your login email. You will need to use the new address to sign in next time. Continue?"),

    # ── Terms & Conditions (mobile — T&C screen) ──
    ("tandc.title",              "ui_onboarding", "Terms & Conditions"),
    ("tandc.subtitle",           "ui_onboarding", "Please read and accept to continue"),
    ("tandc.agreeButton",        "ui_onboarding", "I Agree"),
    ("tandc.declineButton",      "ui_onboarding", "Decline"),
    ("tandc.declineAlertTitle",  "ui_onboarding", "Cannot Proceed"),
    ("tandc.declineAlertMessage","ui_onboarding", "You are unable to access Crisis Reporter without accepting the Terms and Conditions and Privacy Policy. If you change your mind, please reopen the app and try again."),
    ("tandc.declineAlertButton", "ui_onboarding", "OK"),
    ("tandc.body",               "ui_onboarding", "By using Crisis Reporter, you agree to our Terms and Conditions and Privacy Policy.\n\nCrisis Reporter collects location data, photos, and description information to support UNDP crisis response operations. Your data is stored securely and shared only with authorised UNDP staff.\n\nYou may submit reports anonymously or with a verified profile. Your Reporter ID is assigned to your device and persists across sessions.\n\nBy tapping I Agree, you confirm that you have read and understood these terms and consent to the collection and use of your data as described.\n\nYou may withdraw at any time by uninstalling the app."),
    ("tc_text",    "ui_onboarding", "By using Crisis Reporter you agree to submit accurate damage reports and allow UNDP to use your submitted data for crisis response coordination. Your location and photos will be stored securely. This platform is operated by the United Nations Development Programme (UNDP). Data collected will be used solely for humanitarian response purposes and will not be shared with third parties without your consent except as required by law."),
    ("tc_version", "ui_onboarding", "1.0"),

    # ── iOS PWA install banner (web) ──
    ("ios_install.title",     "ui_pwa", "Install Crisis Reporter"),
    ("ios_install.body",      "ui_pwa", "Add this app to your home screen for the best experience — works offline, no app store required."),
    ("ios_install.step1_text","ui_pwa", "Tap the Share button"),
    ("ios_install.step1_sub", "ui_pwa", "at the bottom of your Safari browser"),
    ("ios_install.step2_text","ui_pwa", "Select \"Add to Home Screen\""),
    ("ios_install.step2_sub", "ui_pwa", "scroll down in the share menu if needed"),
    ("ios_install.step3_text","ui_pwa", "Tap \"Add\" to confirm"),
    ("ios_install.step3_sub", "ui_pwa", "Crisis Reporter will appear on your home screen"),
    ("ios_install.dismiss",   "ui_pwa", "Maybe later"),

    # ── Home screen extras ──
    ("whatCanIReport.close", "ui_home", "Close"),
    ("whatCanIReport.title", "ui_home", "What can I report?"),
    ("whatCanIReport.link",  "ui_home", "What can I report?"),

    # Mobile "What can I report?" popup disaster type subtree.
    # Consumed via t("whatCanIReport.types", { returnObjects: true }) —
    # i18next reconstructs the nested object from these flat dotted keys.
    ("whatCanIReport.types.earthquake.name",            "ui_home", "Earthquake"),
    ("whatCanIReport.types.earthquake.description",     "ui_home", "Structural damage from ground shaking and tremors."),
    ("whatCanIReport.types.flood.name",                 "ui_home", "Flood"),
    ("whatCanIReport.types.flood.description",          "ui_home", "Water damage from overflow, heavy rain, or storm surge."),
    ("whatCanIReport.types.tsunami.name",               "ui_home", "Tsunami"),
    ("whatCanIReport.types.tsunami.description",        "ui_home", "Coastal damage from large ocean waves following seismic events."),
    ("whatCanIReport.types.hurricane_cyclone.name",     "ui_home", "Hurricane or Cyclone"),
    ("whatCanIReport.types.hurricane_cyclone.description", "ui_home", "Wind and rain damage from tropical storms."),
    ("whatCanIReport.types.wildfire.name",              "ui_home", "Wildfire"),
    ("whatCanIReport.types.wildfire.description",       "ui_home", "Fire damage to buildings and infrastructure."),
    ("whatCanIReport.types.explosion.name",             "ui_home", "Explosion"),
    ("whatCanIReport.types.explosion.description",      "ui_home", "Blast damage from industrial or other explosive events."),
    ("whatCanIReport.types.chemical_incident.name",     "ui_home", "Chemical Incident"),
    ("whatCanIReport.types.chemical_incident.description", "ui_home", "Damage or hazard from chemical spill or release."),
    ("whatCanIReport.types.conflict.name",              "ui_home", "Conflict"),
    ("whatCanIReport.types.conflict.description",       "ui_home", "Damage from armed conflict or military activity."),
    ("whatCanIReport.types.civil_unrest.name",          "ui_home", "Civil Unrest"),
    ("whatCanIReport.types.civil_unrest.description",   "ui_home", "Damage from protests, riots, or civil disturbance."),
    ("welcomeCard.body",     "ui_home", "Crisis Reporter helps you document damage to buildings and infrastructure after a disaster. You can report earthquakes, floods, conflicts, and other crises. Your reports help UNDP get help to the right places faster."),
    ("welcomeCard.dismiss",  "ui_home", "Got it"),

    # ── Safety screen extras ──
    ("safety.title", "ui_safety", "Safety Tips"),

    # ── Newly discovered CHECK B keys (added by CI enforcement) ──
    ("location.offline_gps_background", "ui_location", "Your GPS coordinates are still being recorded in the background"),
    ("location.permission_note", "ui_location", "Crisis Reporter needs your location to help identify the building you are reporting."),
    ("navigation.my_reports", "ui_common", "View My Reports"),
    ("report.address_label", "ui_report", "Address"),
    ("report.address_placeholder", "ui_report", "Street address or area name"),
    ("report.address_hint", "ui_report", "e.g. 14 Ataturk Street, Kadikoy"),
    ("report.landmark_label", "ui_report", "Nearby Landmark"),
    ("report.landmark_hint", "ui_report", "e.g. Near the school next to the central market"),
    ("report.building_name_label_manual", "ui_report", "Building Name"),
    ("report.building_name_placeholder", "ui_report", "Name of the specific building or structure"),
    ("report.building_name_hint", "ui_report", "e.g. Residential Block 4B, Al-Nour Mosque"),
    ("report.address_required_offline", "ui_report", "* Address is required to continue when GPS is unavailable"),
    ("report.question_number", "ui_report", "Question {{number}} of {{total}}"),
    ("report.q3_infra_name_placeholder", "placeholder", "e.g. Main Street Bridge"),
    ("report.building_name_optional_placeholder", "placeholder", "Building name (optional)"),
    ("report.location_tap_hint", "ui_report", "Tap a building or drop a pin"),
    ("report.review_intro", "ui_report", "Please review your report before submitting. Tap any section to edit."),
    ("report.review_privacy_note", "ui_report", "Your report will be reviewed by UNDP and used to coordinate crisis response"),
    ("questions.q2.opt_other_prefix", "question", "Other"),
    ("locationScreen.hideManualEntry", "ui_location", "Hide manual entry"),
    ("locationScreen.expandManualEntry", "ui_location", "Enter location manually instead"),

    # register — account creation flow (web + mobile)
    ("register.title",              "ui_register", "Create Account"),
    ("register.hint",               "ui_register", "No email verification required. You can log in on any platform immediately after creating your account."),
    ("register.confirm_password",   "ui_register", "Confirm Password"),
    ("register.password_mismatch",  "ui_register", "Passwords do not match"),
    ("register.password_too_short", "ui_register", "Password must be at least 8 characters"),
    ("register.error",              "ui_register", "Registration failed. Please try again."),
    ("register.email_taken",        "ui_register", "Email already registered"),
    ("register.submit_btn",         "ui_register", "Create Account"),
    ("register.already_have_account","ui_register","Already have an account?"),
    ("register.creating",           "ui_register", "Creating account…"),

    # login — mobile-specific keys (different naming convention from web login.*)
    ("login.emailPlaceholder",      "ui_login", "Email address"),
    ("login.passwordPlaceholder",   "ui_login", "Password"),
    ("login.loginButton",           "ui_login", "Log In"),
    ("login.forgotPassword",        "ui_login", "Forgot password?"),
    ("login.forgotPasswordMessage", "ui_login", "Please contact your UNDP coordinator to reset your password."),
    ("login.errorInvalid",          "ui_login", "Invalid email or password. Please try again."),
    ("login.errorGeneric",          "ui_login", "Something went wrong. Please try again."),

    # common — show/hide toggles used in password fields
    ("common.show", "ui_common", "Show"),
    ("common.hide", "ui_common", "Hide"),

    # common — generic action labels
    ("common.try_again", "ui_common", "Try Again"),

    # about — privacy policy modal (shown before policy is published)
    ("about.privacy_coming_soon", "ui_about", "Coming Soon"),
    ("about.privacy_got_it",      "ui_about", "Got it"),

    # home — "what can I report" card subtitle
    ("home.what_card_subtitle", "ui_home", "Tap to see what types of damage you can report"),

    # map — offline state and overlay hints
    ("map.working_offline",  "ui_map", "Working Offline"),
    ("map.check_connection", "ui_map", "Check Connection"),

    # my_reports — delete/retry error alerts and anonymous login prompt
    ("my_reports.delete_error_title",    "ui_my_reports", "Error"),
    ("my_reports.delete_error_body",     "ui_my_reports", "Could not delete report. Please try again."),
    ("my_reports.retry_failed_title",    "ui_my_reports", "Retry failed"),
    ("my_reports.retry_failed_body",     "ui_my_reports", "Could not send report. It will retry automatically when internet returns."),
    ("my_reports.login_prompt_title",    "ui_my_reports", "Log in to see your full history"),
    ("my_reports.login_prompt_subtitle", "ui_my_reports", "Log in or create a free account to view all your reports across devices."),

    # onboarding — country/language picker modals and offline/privacy notes
    ("onboarding.country_modal_title",          "ui_onboarding", "Select Country"),
    ("onboarding.search_countries_placeholder", "ui_onboarding", "Search countries..."),
    ("onboarding.all_languages_title",          "ui_onboarding", "All Languages"),
    ("onboarding.no_internet_title",            "ui_onboarding", "No internet connection"),
    ("onboarding.data_secured",                 "ui_onboarding", "Your data is secured by UNDP Privacy Protocols"),

    # reportDetail — report detail screen header and photo hint
    ("reportDetail.header_title", "ui_report", "Report"),
    ("reportDetail.photo_hint",   "ui_report", "Tap a photo to view full size"),

    # profile — photo picker sheet, permission alerts, form placeholders and hints
    ("profile.pick_photo_title",         "ui_profile", "Profile Photo"),
    ("profile.pick_photo_take",          "ui_profile", "Take a Photo"),
    ("profile.pick_photo_upload",        "ui_profile", "Upload from Gallery"),
    ("profile.camera_permission_title",  "ui_profile", "Camera needed"),
    ("profile.camera_permission_body",   "ui_profile", "Please allow camera access in settings."),
    ("profile.gallery_permission_title", "ui_profile", "Gallery needed"),
    ("profile.gallery_permission_body",  "ui_profile", "Please allow gallery access in settings."),

    # report — GPS/camera/gallery error alerts, map overlay hints, photo empty state
    ("report.gps_error_title",     "ui_report", "GPS Error"),
    ("report.gps_error_body",      "ui_report", "Could not get location."),
    ("report.camera_error_title",  "ui_report", "Camera Error"),
    ("report.gallery_error_title", "ui_report", "Gallery Error"),
    ("report.zoom_hint_buildings", "ui_report", "Zoom in to see and select buildings"),
    ("report.map_instruction",     "ui_report", "Tap a building or drop a pin to select location"),
    ("report.pin_location_label",  "ui_report", "Pin location"),
    ("report.no_photo_yet",        "ui_report", "No photo added yet"),
    ("report.answer_placeholder",  "ui_report", "Enter your answer..."),

    # report — camera capture overlay buttons (web)
    ("report.capture_btn", "ui_report", "Capture"),

    # pushNotification — web push permission sheet
    ("pushNotification.title", "ui_pwa", "Stay informed during crises"),

]


async def seed_string_keys() -> None:
    """Idempotent seed — inserts new StringKey rows and retires removed ones.

    On every startup:
    - Keys in _SEED_KEYS that do not yet exist → INSERT (is_active=True).
    - Keys in _SEED_KEYS that were previously retired → re-activate.
    - Keys that exist in the DB but are no longer in _SEED_KEYS → set
      is_active=False (retired). Translations are preserved for audit.
    """
    async with AsyncSessionLocal() as session:
        # Load all existing StringKey rows (need the ORM objects to mutate is_active)
        existing_result = await session.execute(select(StringKey))
        existing_map: dict[str, StringKey] = {
            row.key: row for row in existing_result.scalars().all()
        }

        seed_key_set = {k for k, _c, _e in _SEED_KEYS}

        added = 0
        for key, category, english_text in _SEED_KEYS:
            if key not in existing_map:
                session.add(StringKey(key=key, category=category, english_text=english_text))
                added += 1
            elif not existing_map[key].is_active:
                # Re-activate a previously retired key that is back in _SEED_KEYS
                existing_map[key].is_active = True
                added += 1

        # Retire keys that have been removed from _SEED_KEYS.
        # Sets is_active=False so they are excluded from language packages and
        # the dashboard key catalogue, but all translation records are kept.
        retired = 0
        for key, row in existing_map.items():
            if key not in seed_key_set and row.is_active:
                row.is_active = False
                retired += 1

        if added or retired:
            await session.commit()
            log.info(
                "String-key seed: +%d new/reactivated, -%d retired (%d total in _SEED_KEYS)",
                added, retired, len(seed_key_set),
            )
