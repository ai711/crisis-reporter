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
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal, get_db
from app.models.dashboard_user import DashboardUser
from app.models.question_package import Question, QuestionOption, QuestionPackage
from app.services.dependencies import get_current_dashboard_user, require_admin

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

    await db.commit()

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

    await db.commit()

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


@router.patch("/{version}/publish", response_model=PackageOut)
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

    # Re-fetch to return current state
    result = await db.execute(
        select(QuestionPackage)
        .where(QuestionPackage.id == pkg.id)
        .options(
            selectinload(QuestionPackage.questions).selectinload(Question.options)
        )
    )
    pkg = result.scalar_one()

    return PackageOut(
        id=str(pkg.id),
        version=pkg.version,
        status=pkg.status,
        created_at=pkg.created_at,
        published_at=pkg.published_at,
        questions=[_build_question_out(q) for q in pkg.questions],
    )


# ── Initial seed data ─────────────────────────────────────────────────────────

# The 5 core UNDP questions for version 1.0.0
_SEED_QUESTIONS: list[dict] = [
    {
        "question_text": "What is the level of damage to the structure?",
        "question_type": "single_select",
        "order_index": 1,
        "is_mandatory": True,
        "options": [
            {"option_text": "Minimal / No Damage", "option_value": "minimal", "order_index": 1},
            {"option_text": "Partially Damaged",   "option_value": "partial", "order_index": 2},
            {"option_text": "Completely Damaged",  "option_value": "complete","order_index": 3},
        ],
    },
    {
        "question_text": "What type of infrastructure is affected?",
        "question_type": "multi_select",
        "order_index": 2,
        "is_mandatory": True,
        "options": [
            {"option_text": "Residential",                          "option_value": "residential",    "order_index": 1},
            {"option_text": "Commercial",                           "option_value": "commercial",     "order_index": 2},
            {"option_text": "Educational",                          "option_value": "educational",    "order_index": 3},
            {"option_text": "Healthcare",                           "option_value": "healthcare",     "order_index": 4},
            {"option_text": "Government / Administrative",          "option_value": "government",     "order_index": 5},
            {"option_text": "Infrastructure (roads, bridges, utilities)", "option_value": "infrastructure", "order_index": 6},
            {"option_text": "Religious",                            "option_value": "religious",      "order_index": 7},
            {"option_text": "Industrial",                           "option_value": "industrial",     "order_index": 8},
            {"option_text": "Other",                                "option_value": "other",          "order_index": 9},
        ],
    },
    {
        "question_text": "What is the name or description of the affected infrastructure?",
        "question_type": "text",
        "order_index": 3,
        "is_mandatory": False,
        "options": [],
    },
    {
        "question_text": "What type of disaster caused the damage?",
        "question_type": "single_select",
        "order_index": 4,
        "is_mandatory": True,
        "options": [
            {"option_text": "Earthquake",         "option_value": "earthquake",        "order_index": 1},
            {"option_text": "Flood",              "option_value": "flood",             "order_index": 2},
            {"option_text": "Tsunami",            "option_value": "tsunami",           "order_index": 3},
            {"option_text": "Hurricane / Cyclone","option_value": "hurricane_cyclone", "order_index": 4},
            {"option_text": "Wildfire",           "option_value": "wildfire",          "order_index": 5},
            {"option_text": "Explosion",          "option_value": "explosion",         "order_index": 6},
            {"option_text": "Chemical Incident",  "option_value": "chemical_incident", "order_index": 7},
            {"option_text": "Conflict",           "option_value": "conflict",          "order_index": 8},
            {"option_text": "Civil Unrest",       "option_value": "civil_unrest",      "order_index": 9},
            {"option_text": "Other",              "option_value": "other",             "order_index": 10},
        ],
    },
    {
        "question_text": "Is debris blocking access to the structure?",
        "question_type": "single_select",
        "order_index": 5,
        "is_mandatory": True,
        "options": [
            {"option_text": "No debris blocking access",      "option_value": "none",    "order_index": 1},
            {"option_text": "Partial debris blocking access", "option_value": "partial", "order_index": 2},
            {"option_text": "Debris fully blocking access",   "option_value": "full",    "order_index": 3},
        ],
    },
]


async def seed_initial_package() -> None:
    """
    Insert the v1.0.0 published question package if the table is empty.
    Called from the app lifespan after create_all.
    Safe to call on every restart — no-ops if data already exists.
    """
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(QuestionPackage).limit(1))
        if result.scalar_one_or_none() is not None:
            return  # Already seeded

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

            for opt_data in q_data["options"]:
                session.add(
                    QuestionOption(
                        question_id=question.id,
                        option_text=opt_data["option_text"],
                        option_value=opt_data["option_value"],
                        order_index=opt_data["order_index"],
                    )
                )

        await session.commit()
