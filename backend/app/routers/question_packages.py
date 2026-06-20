"""
question_packages.py

Endpoints for the question-package versioning system.

GET  /api/question-packages/active            — public; reporter app calls on startup
GET  /api/question-packages                   — dashboard auth; list all packages
POST /api/question-packages                   — dashboard auth; create draft
POST /api/question-packages/draft/questions   — dashboard auth; add question to current/new draft
PATCH /api/question-packages/{version}/publish — admin only; promote draft → published

A separate async helper `seed_initial_package` is called from the app lifespan
to insert v1.0.0 if the table is empty.
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, or_, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal, get_db
from app.models.dashboard_user import DashboardUser
from app.models.question_package import Question, QuestionOption, QuestionPackage
from app.services.dependencies import get_current_dashboard_user, require_admin

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/question-packages", tags=["Question Packages"])


# ── Response schemas ──────────────────────────────────────────────────────────


class OptionOut(BaseModel):
    id: str
    option_text: str
    option_value: str
    order_index: int

    class Config:
        from_attributes = True


class QuestionOut(BaseModel):
    id: str
    question_text: str
    question_type: str
    order_index: int
    is_mandatory: bool
    is_active: bool
    is_core: bool
    options: list[OptionOut]

    class Config:
        from_attributes = True


class ActivePackageOut(BaseModel):
    id: str
    version: str
    published_at: datetime
    questions: list[QuestionOut]

    class Config:
        from_attributes = True


class PackageListItem(BaseModel):
    id: str
    version: str
    status: str
    created_at: datetime
    published_at: Optional[datetime]
    question_count: int

    class Config:
        from_attributes = True


class PackageOut(BaseModel):
    id: str
    version: str
    status: str
    created_at: datetime
    published_at: Optional[datetime]
    questions: list[QuestionOut]

    class Config:
        from_attributes = True


class PublishPackageOut(BaseModel):
    id: str
    version: str
    status: str
    created_at: datetime
    published_at: Optional[datetime]
    questions: list[QuestionOut]
    auto_language_published: bool = False
    content_version: int = 1

    class Config:
        from_attributes = True


# ── Request schemas ───────────────────────────────────────────────────────────


class OptionIn(BaseModel):
    option_text: str
    option_value: str
    # order_index derived from list position if omitted
    order_index: Optional[int] = None


class QuestionIn(BaseModel):
    question_text: str
    question_type: str  # single_select | multi_select | text
    order_index: int
    is_mandatory: bool = True
    options: list[OptionIn] = []


class PackageCreate(BaseModel):
    version: str
    questions: list[QuestionIn]


class AddQuestionRequest(BaseModel):
    question_text: str
    question_type: str  # single_select | multi_select | text
    is_mandatory: bool = False
    available_offline: bool = True
    country_codes: list[str] = []  # empty = all countries
    options: list[OptionIn] = []


# ── Helpers ───────────────────────────────────────────────────────────────────

VALID_QUESTION_TYPES = {"single_select", "multi_select", "text"}


def _build_question_out(q: Question) -> QuestionOut:
    return QuestionOut(
        id=str(q.id),
        question_text=q.question_text,
        question_type=q.question_type,
        order_index=q.order_index,
        is_mandatory=q.is_mandatory,
        is_active=q.is_active,
        is_core=q.is_core,
        options=[
            OptionOut(
                id=str(o.id),
                option_text=o.option_text,
                option_value=o.option_value,
                order_index=o.order_index,
            )
            for o in q.options
        ],
    )


# ── Content-version helpers ───────────────────────────────────────────────────

async def get_questions_content_version(db: AsyncSession) -> int:
    from app.models.app_setting import AppSetting
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == "questions_content_version")
    )
    row = result.scalar_one_or_none()
    if row and row.value:
        return int(row.value.get("count", 1))
    return 1


async def increment_questions_content_version(db: AsyncSession) -> int:
    from app.models.app_setting import AppSetting
    result = await db.execute(
        select(AppSetting).where(AppSetting.key == "questions_content_version")
    )
    row = result.scalar_one_or_none()
    if row is None:
        next_val = 2
        db.add(AppSetting(key="questions_content_version", value={"count": next_val}))
    else:
        current = int(row.value.get("count", 1))
        next_val = current + 1
        row.value = {"count": next_val}
    await db.commit()
    return next_val


async def _auto_publish_language(db: AsyncSession, language_code: str) -> bool:
    """Publish language package without user auth. Returns True on success."""
    from app.models.language_package import Language, StringKey, Translation, LanguagePackage
    from app.services.translation_audit_service import write_translation_audit

    pending_result = await db.execute(
        select(func.count(Translation.id)).where(
            Translation.language_code == language_code,
            Translation.status.in_(["draft", "failed"]),
        )
    )
    if (pending_result.scalar() or 0) > 0:
        return False

    all_keys_result = await db.execute(
        select(StringKey).where(StringKey.is_active == True)
    )
    all_keys = all_keys_result.scalars().all()
    if not all_keys:
        return False

    approved_result = await db.execute(
        select(Translation).where(
            Translation.language_code == language_code,
            Translation.status == "approved",
        )
    )
    approved = {t.string_key_id: t for t in approved_result.scalars().all()}

    published_ids_result = await db.execute(
        select(Translation.string_key_id).where(
            Translation.language_code == language_code,
            Translation.status == "published",
        )
    )
    already_published_ids = {row[0] for row in published_ids_result.all()}

    missing = [k.key for k in all_keys if k.id not in approved and k.id not in already_published_ids]
    if missing:
        return False

    for translation in approved.values():
        translation.status = "published"

    prev_result = await db.execute(
        select(LanguagePackage).where(
            LanguagePackage.language_code == language_code,
            LanguagePackage.status == "published",
        )
    )
    for prev in prev_result.scalars().all():
        prev.status = "archived"

    count_result = await db.execute(
        select(func.count(LanguagePackage.id)).where(
            LanguagePackage.language_code == language_code
        )
    )
    next_version = f"1.{(count_result.scalar() or 0)}"

    from app.models.language_package import LanguagePackage as LP
    db.add(LP(
        language_code=language_code,
        version=next_version,
        status="published",
        published_at=datetime.now(timezone.utc),
        string_count=len(approved),
        published_by="system_auto",
    ))

    try:
        await write_translation_audit(
            db,
            event_type="package_published",
            lang_code=language_code,
            details={"version": next_version, "string_count": len(approved), "auto": True},
            performed_by="system_auto",
            dashboard_user_id="",
        )
    except Exception as exc:
        log.warning("_auto_publish_language audit write failed for %s: %s", language_code, exc)

    await db.commit()
    return True


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/active", response_model=ActivePackageOut)
async def get_active_package(
    db: AsyncSession = Depends(get_db),
) -> ActivePackageOut:
    """
    Return the currently published question package with all active questions
    and their options.

    Public endpoint — no authentication required.
    Called by the reporter app (PWA and Android) on startup to fetch and cache
    the current question set.
    """
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.status == "published")
        .options(
            selectinload(QuestionPackage.questions).selectinload(Question.options)
        )
    )
    pkg = result.scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No published question package found",
        )

    active_questions = sorted(
        [q for q in pkg.questions if q.is_active], key=lambda q: q.order_index
    )

    return ActivePackageOut(
        id=str(pkg.id),
        version=pkg.version,
        published_at=pkg.published_at,  # type: ignore[arg-type]
        questions=[_build_question_out(q) for q in active_questions],
    )


@router.get("/version")
async def get_package_version(
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return the version of the currently published question package.
    Public endpoint — no authentication required.
    Used by mobile apps to check whether a full package re-download is needed.
    """
    result = await db.execute(
        select(QuestionPackage.version, QuestionPackage.published_at)
        .where(QuestionPackage.status == "published")
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No published question package found",
        )
    content_version = await get_questions_content_version(db)
    published_at = row.published_at.isoformat() if row.published_at else None
    return {"version": row.version, "content_version": content_version, "published_at": published_at}


@router.get("", response_model=list[PackageListItem])
async def list_packages(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> list[PackageListItem]:
    """
    Return all question packages ordered newest-first.
    Dashboard auth required.
    """
    result = await db.execute(
        select(QuestionPackage)
        .options(selectinload(QuestionPackage.questions))
        .order_by(QuestionPackage.created_at.desc())
    )
    packages = result.scalars().all()

    return [
        PackageListItem(
            id=str(pkg.id),
            version=pkg.version,
            status=pkg.status,
            created_at=pkg.created_at,
            published_at=pkg.published_at,
            question_count=len([q for q in pkg.questions if q.is_active]),
        )
        for pkg in packages
    ]


@router.post("", response_model=PackageOut, status_code=status.HTTP_201_CREATED)
async def create_package(
    request: PackageCreate,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> PackageOut:
    """
    Create a new question package in draft status.
    Dashboard auth required.
    """
    # Validate version uniqueness
    existing = await db.execute(
        select(QuestionPackage).where(QuestionPackage.version == request.version)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Package version '{request.version}' already exists",
        )

    # Validate question types
    for q in request.questions:
        if q.question_type not in VALID_QUESTION_TYPES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Invalid question_type '{q.question_type}'. "
                    f"Must be one of: {', '.join(sorted(VALID_QUESTION_TYPES))}"
                ),
            )

    pkg = QuestionPackage(
        version=request.version,
        status="draft",
        created_by=current_user.id,
    )
    db.add(pkg)
    await db.flush()  # get pkg.id before inserting children

    for q_in in request.questions:
        question = Question(
            package_id=pkg.id,
            question_text=q_in.question_text,
            question_type=q_in.question_type,
            order_index=q_in.order_index,
            is_mandatory=q_in.is_mandatory,
            is_active=True,
        )
        db.add(question)
        await db.flush()  # get question.id

        for idx, opt_in in enumerate(q_in.options):
            order = opt_in.order_index if opt_in.order_index is not None else idx
            db.add(
                QuestionOption(
                    question_id=question.id,
                    option_text=opt_in.option_text,
                    option_value=opt_in.option_value,
                    order_index=order,
                )
            )

        # Register question strings in the translation pipeline (idempotent)
        from app.models.language_package import StringKey
        _q_label_key = f"Q{q_in.order_index}_LABEL"
        if (await db.execute(select(StringKey).where(StringKey.key == _q_label_key))).scalar_one_or_none() is None:
            db.add(StringKey(key=_q_label_key, category="question", english_text=q_in.question_text, is_active=True))
        for _opt in q_in.options:
            _opt_key = f"Q{q_in.order_index}_OPT_{_opt.option_value.upper()}"
            if (await db.execute(select(StringKey).where(StringKey.key == _opt_key))).scalar_one_or_none() is None:
                db.add(StringKey(key=_opt_key, category="answer", english_text=_opt.option_text, is_active=True))

    await db.commit()

    try:
        from app.routers.language_packages import ensure_string_keys_synced
        await ensure_string_keys_synced(db)
    except Exception as exc:
        log.warning("create_package: ensure_string_keys_synced failed: %s", exc)

    # Re-fetch with eager-loaded relationships for the response
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.id == pkg.id)
        .options(
            selectinload(QuestionPackage.questions).selectinload(Question.options)
        )
    )
    pkg = result.scalar_one()

    # Enqueue background auto-translation for the new draft
    from app.tasks import auto_translate_question_package
    asyncio.create_task(auto_translate_question_package(package_version=pkg.version))

    return PackageOut(
        id=str(pkg.id),
        version=pkg.version,
        status=pkg.status,
        created_at=pkg.created_at,
        published_at=pkg.published_at,
        questions=[_build_question_out(q) for q in pkg.questions],
    )


@router.post("/draft/questions", response_model=PackageOut, status_code=status.HTTP_201_CREATED)
async def add_question_to_draft(
    request: AddQuestionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
) -> PackageOut:
    """
    Add a new (non-core) question to the current draft package.
    If no draft exists, creates a new draft by copying the published package
    and incrementing the patch version. Admin/Analyst can call this.
    """
    if request.question_type not in VALID_QUESTION_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid question_type '{request.question_type}'.",
        )

    # Find or create draft
    draft_result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.status == "draft")
        .options(selectinload(QuestionPackage.questions).selectinload(Question.options))
        .order_by(QuestionPackage.created_at.desc())
    )
    draft_pkg = draft_result.scalar_one_or_none()

    if draft_pkg is None:
        # Clone the published package into a new draft
        pub_result = await db.execute(
            select(QuestionPackage)
            .where(QuestionPackage.status == "published")
            .options(selectinload(QuestionPackage.questions).selectinload(Question.options))
        )
        pub_pkg = pub_result.scalar_one_or_none()

        # Determine next version (e.g. 1.0.0 → 1.0.1)
        base_version = pub_pkg.version if pub_pkg else "1.0.0"
        parts = base_version.split(".")
        try:
            parts[-1] = str(int(parts[-1]) + 1)
        except ValueError:
            parts.append("1")
        new_version = ".".join(parts)

        # Ensure version is unique
        while True:
            ex = await db.execute(
                select(QuestionPackage).where(QuestionPackage.version == new_version)
            )
            if ex.scalar_one_or_none() is None:
                break
            parts[-1] = str(int(parts[-1]) + 1)
            new_version = ".".join(parts)

        draft_pkg = QuestionPackage(
            version=new_version,
            status="draft",
            created_by=current_user.id,
        )
        db.add(draft_pkg)
        await db.flush()

        # Copy existing questions from published package
        if pub_pkg:
            for q in sorted(pub_pkg.questions, key=lambda x: x.order_index):
                new_q = Question(
                    package_id=draft_pkg.id,
                    question_text=q.question_text,
                    question_type=q.question_type,
                    order_index=q.order_index,
                    is_mandatory=q.is_mandatory,
                    is_active=q.is_active,
                    is_core=q.is_core,
                )
                db.add(new_q)
                await db.flush()
                for opt in q.options:
                    db.add(QuestionOption(
                        question_id=new_q.id,
                        option_text=opt.option_text,
                        option_value=opt.option_value,
                        order_index=opt.order_index,
                    ))

    # Determine next order index
    existing_count = len(draft_pkg.questions) if draft_pkg.questions else 0
    next_order = existing_count + 1

    # Add the new question
    new_question = Question(
        package_id=draft_pkg.id,
        question_text=request.question_text,
        question_type=request.question_type,
        order_index=next_order,
        is_mandatory=request.is_mandatory,
        is_active=True,
        is_core=False,
    )
    db.add(new_question)
    await db.flush()

    for idx, opt_in in enumerate(request.options):
        order = opt_in.order_index if opt_in.order_index is not None else idx
        db.add(QuestionOption(
            question_id=new_question.id,
            option_text=opt_in.option_text,
            option_value=opt_in.option_value,
            order_index=order,
        ))

    # Register question strings in the translation pipeline (idempotent)
    from app.models.language_package import StringKey
    _q_label_key = f"Q{next_order}_LABEL"
    if (await db.execute(select(StringKey).where(StringKey.key == _q_label_key))).scalar_one_or_none() is None:
        db.add(StringKey(key=_q_label_key, category="question", english_text=request.question_text, is_active=True))
    for _opt in request.options:
        _opt_key = f"Q{next_order}_OPT_{_opt.option_value.upper()}"
        if (await db.execute(select(StringKey).where(StringKey.key == _opt_key))).scalar_one_or_none() is None:
            db.add(StringKey(key=_opt_key, category="answer", english_text=_opt.option_text, is_active=True))

    await db.commit()

    try:
        from app.routers.language_packages import ensure_string_keys_synced
        await ensure_string_keys_synced(db)
    except Exception as exc:
        log.warning("add_question_to_draft: ensure_string_keys_synced failed: %s", exc)

    # Re-fetch
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.id == draft_pkg.id)
        .options(selectinload(QuestionPackage.questions).selectinload(Question.options))
    )
    draft_pkg = result.scalar_one()

    from app.tasks import auto_translate_question_package
    asyncio.create_task(auto_translate_question_package(package_version=draft_pkg.version))

    return PackageOut(
        id=str(draft_pkg.id),
        version=draft_pkg.version,
        status=draft_pkg.status,
        created_at=draft_pkg.created_at,
        published_at=draft_pkg.published_at,
        questions=[_build_question_out(q) for q in draft_pkg.questions],
    )


@router.get("/draft/publish-readiness")
async def get_publish_readiness(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
) -> dict:
    """Return publish gate status without publishing. Admin only."""
    from app.models.language_package import Language, StringKey, Translation

    draft_result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.status == "draft")
        .options(selectinload(QuestionPackage.questions).selectinload(Question.options))
        .order_by(QuestionPackage.created_at.desc())
    )
    draft_pkg = draft_result.scalar_one_or_none()

    if draft_pkg is None:
        return {
            "can_publish": False,
            "has_draft": False,
            "draft_version": None,
            "blocking_languages": [],
            "auto_language_publish_eligible": False,
        }

    # Collect string keys for active questions in draft
    draft_question_keys: set[str] = set()
    for question in draft_pkg.questions:
        if not question.is_active:
            continue
        draft_question_keys.add(f"Q{question.order_index}_LABEL")
        for option in question.options:
            draft_question_keys.add(f"Q{question.order_index}_OPT_{option.option_value.upper()}")

    # Find active languages (skip English — it is the source)
    langs_result = await db.execute(
        select(Language).where(
            or_(Language.status == "active", Language.is_protected == True)
        )
    )
    active_languages = langs_result.scalars().all()

    # Check for MISSING translations per language
    blocking = []
    if draft_question_keys:
        for lang in active_languages:
            if lang.code == "en":
                continue
            missing_result = await db.execute(
                select(StringKey.key)
                .join(Translation, Translation.string_key_id == StringKey.id)
                .where(
                    StringKey.key.in_(draft_question_keys),
                    Translation.language_code == lang.code,
                    Translation.status == "missing",
                )
            )
            missing_keys = [row[0] for row in missing_result.all()]
            if missing_keys:
                blocking.append({
                    "language_code": lang.code,
                    "language_name": lang.name,
                    "missing_count": len(missing_keys),
                    "missing_keys": missing_keys,
                })

    can_publish = len(blocking) == 0

    # auto_language_publish_eligible: ALL active langs have zero missing AND zero draft
    auto_eligible = False
    if can_publish:
        all_clean = True
        for lang in active_languages:
            if lang.code == "en":
                continue
            count_result = await db.execute(
                select(func.count(Translation.id)).where(
                    Translation.language_code == lang.code,
                    Translation.status.in_(["missing", "draft"]),
                )
            )
            if (count_result.scalar() or 0) > 0:
                all_clean = False
                break
        auto_eligible = all_clean

    return {
        "can_publish": can_publish,
        "has_draft": True,
        "draft_version": draft_pkg.version,
        "blocking_languages": blocking,
        "auto_language_publish_eligible": auto_eligible,
    }


@router.patch("/draft/questions/{question_id}/deactivate")
async def deactivate_question(
    question_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
) -> dict:
    """Set a non-core question inactive and mark its StringKeys inactive. Admin only."""
    from app.models.language_package import StringKey

    result = await db.execute(select(Question).where(Question.id == question_id))
    question = result.scalar_one_or_none()
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")
    if question.is_core:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "core_question_immutable",
                "message": "Core questions cannot be deactivated from the dashboard",
            },
        )

    question.is_active = False

    key_prefix = f"Q{question.order_index}_"
    sk_result = await db.execute(
        select(StringKey).where(StringKey.key.like(f"{key_prefix}%"))
    )
    for sk in sk_result.scalars().all():
        sk.is_active = False

    await db.commit()
    return {"question_id": str(question_id), "deactivated": True}


@router.patch("/draft/questions/{question_id}/reactivate")
async def reactivate_question(
    question_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
) -> dict:
    """Restore a deactivated question and its StringKeys. Admin only."""
    from app.models.language_package import StringKey

    result = await db.execute(select(Question).where(Question.id == question_id))
    question = result.scalar_one_or_none()
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")

    question.is_active = True

    key_prefix = f"Q{question.order_index}_"
    sk_result = await db.execute(
        select(StringKey).where(StringKey.key.like(f"{key_prefix}%"))
    )
    for sk in sk_result.scalars().all():
        sk.is_active = True

    await db.commit()

    try:
        from app.routers.language_packages import ensure_string_keys_synced
        await ensure_string_keys_synced(db)
    except Exception as exc:
        log.warning("reactivate_question: ensure_string_keys_synced failed: %s", exc)

    return {"question_id": str(question_id), "reactivated": True}


@router.patch("/{version}/publish", response_model=PublishPackageOut)
async def publish_package(
    version: str,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
) -> PackageOut:
    """
    Publish a draft package.

    - Sets its status to 'published' and records published_at.
    - Archives the previously published package (if any).

    Admin only.
    """
    from app.models.language_package import Language, StringKey, Translation

    # Fetch the target package
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.version == version)
        .options(
            selectinload(QuestionPackage.questions).selectinload(Question.options)
        )
    )
    pkg = result.scalar_one_or_none()
    if pkg is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Package version '{version}' not found",
        )
    if pkg.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Package is '{pkg.status}' — only draft packages can be published",
        )

    # ── Gate: block only on MISSING translations for draft's active questions ──

    draft_question_keys: set[str] = set()
    for question in pkg.questions:
        if not question.is_active:
            continue
        draft_question_keys.add(f"Q{question.order_index}_LABEL")
        for option in question.options:
            draft_question_keys.add(f"Q{question.order_index}_OPT_{option.option_value.upper()}")

    if draft_question_keys:
        langs_result = await db.execute(
            select(Language).where(
                or_(Language.status == "active", Language.is_protected == True)
            )
        )
        active_languages = langs_result.scalars().all()

        blocking = []
        for lang in active_languages:
            if lang.code == "en":
                continue
            missing_result = await db.execute(
                select(StringKey.key)
                .join(Translation, Translation.string_key_id == StringKey.id)
                .where(
                    StringKey.key.in_(draft_question_keys),
                    Translation.language_code == lang.code,
                    Translation.status == "missing",
                )
            )
            missing_keys = [row[0] for row in missing_result.all()]
            if missing_keys:
                blocking.append({
                    "language_code": lang.code,
                    "language_name": lang.name,
                    "missing_count": len(missing_keys),
                    "missing_keys": missing_keys,
                })

        if blocking:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "translation_incomplete",
                    "message": "Cannot publish — question translations are missing in some languages",
                    "blocking": blocking,
                },
            )

    # Archive the current published package (there should be at most one)
    prev_result = await db.execute(
        select(QuestionPackage).where(QuestionPackage.status == "published")
    )
    for prev_pkg in prev_result.scalars().all():
        prev_pkg.status = "archived"

    # Promote the draft
    pkg.status = "published"
    pkg.published_at = datetime.now(timezone.utc)

    await db.commit()

    # Increment content version after successful publish
    content_version = await increment_questions_content_version(db)

    # Auto-publish language packages if all languages have zero missing + draft
    auto_language_published = False
    try:
        langs_result2 = await db.execute(
            select(Language).where(
                or_(Language.status == "active", Language.is_protected == True)
            )
        )
        all_active_langs = langs_result2.scalars().all()
        all_clean = True
        for lang in all_active_langs:
            if lang.code == "en":
                continue
            count_result = await db.execute(
                select(func.count(Translation.id)).where(
                    Translation.language_code == lang.code,
                    Translation.status.in_(["missing", "draft"]),
                )
            )
            if (count_result.scalar() or 0) > 0:
                all_clean = False
                break

        if all_clean:
            published_any = False
            for lang in all_active_langs:
                if lang.code == "en":
                    continue
                try:
                    ok = await _auto_publish_language(db, lang.code)
                    if ok:
                        published_any = True
                except Exception as exc:
                    log.warning("auto-publish failed for %s: %s", lang.code, exc)
            auto_language_published = published_any
    except Exception as exc:
        log.warning("auto-language-publish check failed: %s", exc)

    # Re-fetch to return current state
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.id == pkg.id)
        .options(
            selectinload(QuestionPackage.questions).selectinload(Question.options)
        )
    )
    pkg = result.scalar_one()

    return PublishPackageOut(
        id=str(pkg.id),
        version=pkg.version,
        status=pkg.status,
        created_at=pkg.created_at,
        published_at=pkg.published_at,
        questions=[_build_question_out(q) for q in pkg.questions],
        auto_language_published=auto_language_published,
        content_version=content_version,
    )


# ── Initial seed data ─────────────────────────────────────────────────────────

# The 8 canonical UNDP RAPIDA questions for version 1.0.0
_SEED_QUESTIONS: list[dict] = [
    {
        "question_text": "How bad is the damage?",
        "question_type": "single_select",
        "order_index": 1,
        "is_mandatory": True,
        "options": [
            {"option_text": "Minimal / No damage — structurally sound and functional, showing only cosmetic or no visible damage", "option_value": "minimal",  "order_index": 1},
            {"option_text": "Partially damaged — repairable, and remains usable with caution",                                    "option_value": "partial",  "order_index": 2},
            {"option_text": "Completely damaged — structurally unsafe or destroyed",                                               "option_value": "complete", "order_index": 3},
        ],
    },
    {
        "question_text": "What type of infrastructure is this?",
        "question_type": "multi_select",
        "order_index": 2,
        "is_mandatory": True,
        "options": [
            {"option_text": "Residential Infrastructure — houses and apartments",                                                                              "option_value": "residential",   "order_index": 1},
            {"option_text": "Commercial Infrastructure — markets, malls, shops, hotels, banks, industries, etc.",                                              "option_value": "commercial",    "order_index": 2},
            {"option_text": "Government Building — administrative buildings, courthouses, police stations, fire stations, etc.",                               "option_value": "government",    "order_index": 3},
            {"option_text": "Utility Infrastructure — water pumps, power plants, waste treatment plants, etc.",                                                "option_value": "utility",       "order_index": 4},
            {"option_text": "Transport and Communication Infrastructure — roads, cell towers, bridges, railway station, bus station, etc.",                    "option_value": "transport_comm","order_index": 5},
            {"option_text": "Community Infrastructure — schools, hospitals, community halls, public toilets, etc.",                                            "option_value": "community",     "order_index": 6},
            {"option_text": "Public Spaces / Recreation Infrastructure — stadiums, playgrounds, religious buildings, etc.",                                    "option_value": "public_spaces", "order_index": 7},
            {"option_text": "Other — please specify",                                                                                                         "option_value": "other",         "order_index": 8},
        ],
    },
    {
        "question_text": "Name or details of the infrastructure",
        "question_type": "text",
        "order_index": 3,
        "is_mandatory": True,
        "options": [],
    },
    {
        "question_text": "What type of disaster is this?",
        "question_type": "single_select",
        "order_index": 4,
        "is_mandatory": True,
        "options": [
            {"option_text": "Earthquake",          "option_value": "earthquake",        "order_index": 1},
            {"option_text": "Flood",               "option_value": "flood",             "order_index": 2},
            {"option_text": "Tsunami",             "option_value": "tsunami",           "order_index": 3},
            {"option_text": "Hurricane or Cyclone","option_value": "hurricane_cyclone", "order_index": 4},
            {"option_text": "Wildfire",            "option_value": "wildfire",          "order_index": 5},
            {"option_text": "Explosion",           "option_value": "explosion",         "order_index": 6},
            {"option_text": "Chemical Incident",   "option_value": "chemical_incident", "order_index": 7},
            {"option_text": "Conflict",            "option_value": "conflict",          "order_index": 8},
            {"option_text": "Civil Unrest",        "option_value": "civil_unrest",      "order_index": 9},
        ],
    },
    {
        "question_text": "Is there debris that needs clearing near this location?",
        "question_type": "single_select",
        "order_index": 5,
        "is_mandatory": True,
        "options": [
            {"option_text": "Yes", "option_value": "yes", "order_index": 1},
            {"option_text": "No",  "option_value": "no",  "order_index": 2},
        ],
    },
    {
        "question_text": "What is the current condition of electricity infrastructure in your community following the crisis?",
        "question_type": "single_select",
        "order_index": 6,
        "is_mandatory": True,
        "options": [
            {"option_text": "No damage observed",                                                   "option_value": "no_damage", "order_index": 1},
            {"option_text": "Minor damage — service disruptions but quickly repairable",             "option_value": "minor",     "order_index": 2},
            {"option_text": "Moderate damage — partial outages requiring repairs",                  "option_value": "moderate",  "order_index": 3},
            {"option_text": "Severe damage — major infrastructure damaged, prolonged outages",      "option_value": "severe",    "order_index": 4},
            {"option_text": "Completely destroyed — no electricity infrastructure functioning",     "option_value": "destroyed", "order_index": 5},
            {"option_text": "Unknown / cannot be assessed",                                         "option_value": "unknown",   "order_index": 6},
        ],
    },
    {
        "question_text": "How would you rate the overall functioning of health services in your community since the event?",
        "question_type": "single_select",
        "order_index": 7,
        "is_mandatory": True,
        "options": [
            {"option_text": "Fully functional",       "option_value": "functional",     "order_index": 1},
            {"option_text": "Partially functional",   "option_value": "partial",        "order_index": 2},
            {"option_text": "Largely disrupted",      "option_value": "disrupted",      "order_index": 3},
            {"option_text": "Not functioning at all", "option_value": "not_functioning","order_index": 4},
            {"option_text": "Unknown",                "option_value": "unknown",        "order_index": 5},
        ],
    },
    {
        "question_text": "What are the most pressing needs?",
        "question_type": "multi_select",
        "order_index": 8,
        "is_mandatory": True,
        "options": [
            {"option_text": "Food assistance and safe drinking water",                                                      "option_value": "food_water",    "order_index": 1},
            {"option_text": "Cash or financial assistance",                                                                 "option_value": "cash",          "order_index": 2},
            {"option_text": "Access to healthcare and essential medicines",                                                 "option_value": "healthcare",    "order_index": 3},
            {"option_text": "Shelter, housing repair, or temporary accommodation",                                         "option_value": "shelter",       "order_index": 4},
            {"option_text": "Restoration of livelihoods or income sources",                                                "option_value": "livelihoods",   "order_index": 5},
            {"option_text": "Water, sanitation, and hygiene — toilets, washing facilities",                                "option_value": "wash",          "order_index": 6},
            {"option_text": "Restoration of basic services and infrastructure — electricity, roads, schools",              "option_value": "basic_services","order_index": 7},
            {"option_text": "Protection services and psychosocial support",                                                "option_value": "protection",    "order_index": 8},
            {"option_text": "Support from local authorities and community organizations",                                  "option_value": "local_support", "order_index": 9},
            {"option_text": "Other — please specify",                                                                      "option_value": "other",         "order_index": 10},
        ],
    },
]


async def seed_initial_package() -> None:
    """
    Insert the v1.0.0 published question package on startup.
    If fewer than 8 questions exist in the database, deletes all packages and reseeds.
    Safe to call on every restart.
    """
    from sqlalchemy import func as sqlfunc
    from app.models.language_package import StringKey

    async with AsyncSessionLocal() as session:
        # Count questions across all packages — reseed if fewer than 8
        q_count_result = await session.execute(select(sqlfunc.count(Question.id)))
        question_count = q_count_result.scalar_one()

        if question_count >= 8:
            return  # Already seeded correctly

        # Delete all existing packages (cascade deletes questions and options)
        pkg_result = await session.execute(select(QuestionPackage))
        for p in pkg_result.scalars().all():
            await session.delete(p)
        await session.flush()

        pkg = QuestionPackage(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            version="1.0.0",
            status="published",
            created_by=None,
            published_at=datetime.now(timezone.utc),
        )
        session.add(pkg)
        await session.flush()

        for q_data in _SEED_QUESTIONS:
            question = Question(
                package_id=pkg.id,
                question_text=q_data["question_text"],
                question_type=q_data["question_type"],
                order_index=q_data["order_index"],
                is_mandatory=q_data["is_mandatory"],
                is_active=True,
                is_core=True,
            )
            session.add(question)
            await session.flush()

            n = q_data["order_index"]

            # StringKey for question label
            key_label = f"Q{n}_LABEL"
            existing_label = (await session.execute(
                select(StringKey).where(StringKey.key == key_label)
            )).scalar_one_or_none()
            if existing_label is None:
                session.add(StringKey(
                    key=key_label,
                    category="question",
                    english_text=q_data["question_text"],
                    is_active=True,
                ))

            for opt_data in q_data["options"]:
                session.add(
                    QuestionOption(
                        question_id=question.id,
                        option_text=opt_data["option_text"],
                        option_value=opt_data["option_value"],
                        order_index=opt_data["order_index"],
                    )
                )
                # StringKey for option label
                opt_key = f"Q{n}_OPT_{opt_data['option_value'].upper()}"
                existing_opt = (await session.execute(
                    select(StringKey).where(StringKey.key == opt_key)
                )).scalar_one_or_none()
                if existing_opt is None:
                    session.add(StringKey(
                        key=opt_key,
                        category="answer",
                        english_text=opt_data["option_text"],
                        is_active=True,
                    ))

        await session.flush()

        # Sync string key registry before committing
        try:
            from app.routers.language_packages import ensure_string_keys_synced
            await ensure_string_keys_synced(session)
        except Exception:
            pass  # Non-blocking — sync failure does not prevent startup

        await session.commit()

    # Trigger auto-translation outside the session
    try:
        from app.tasks import auto_translate_content
        asyncio.create_task(auto_translate_content("question"))
    except Exception:
        pass  # Non-blocking — translation failure does not prevent startup
