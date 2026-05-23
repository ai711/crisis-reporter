"""
language_packages.py

Four router prefixes:
    /api/languages            — language lifecycle management
    /api/language-packages    — package lifecycle (active fetch, publish)
    /api/string-keys          — key catalogue management
    /api/translations         — per-language translation workflow (edit locks, audit)
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import AsyncSessionLocal, get_db
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
    string_count: int

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
    lang_map = {l.code: l.name for l in lang_result.scalars().all()}

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
            non_un.append({
                "code": code,
                "name": lang_map.get(code, code),
                "status": "active",
                "is_un_language": False,
            })
    non_un.sort(key=lambda x: x["name"])
    result.extend(non_un)

    return result


@packages_router.get("/active/{language_code}", response_model=dict[str, str])
async def get_active_package(
    language_code: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    pkg_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    pkg = pkg_result.scalar_one_or_none()
    if not pkg:
        return {}

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

    # Generate next version number
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

    await write_translation_audit(
        db,
        event_type="package_published",
        lang_code=language_code,
        details={"version": next_version, "string_count": len(approved)},
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


async def _run_auto_translation(language_code: str, db: AsyncSession) -> None:
    try:
        existing_result = await db.execute(
            select(Translation.string_key_id).where(
                Translation.language_code == language_code
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
            return

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
                            "target": language_code,
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
                            language_code=language_code,
                            translated_text=translated_text,
                            status="draft",
                            translated_by="auto",
                        )
                    )
                    translated += 1

                except Exception as exc:
                    failed += 1
                    errors.append(f"{sk.key}: {exc}")
                    log.warning("auto_translate failed for key %s: %s", sk.key, exc)

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
        log.error("_run_auto_translation background task failed for %s: %s", language_code, exc)


@translations_router.post("/auto-translate")
async def auto_translate(
    body: AutoTranslateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_admin),
) -> dict:
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

    background_tasks.add_task(_run_auto_translation, body.language_code, db)
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
]


async def seed_string_keys() -> None:
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(StringKey).limit(1))
        if result.scalar_one_or_none() is not None:
            return

        for key, category, english_text in _SEED_KEYS:
            session.add(StringKey(key=key, category=category, english_text=english_text))

        await session.commit()
        log.info("Seeded %d string keys", len(_SEED_KEYS))
