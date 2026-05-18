import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, Integer, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class QuestionPackage(Base):
    """
    A versioned bundle of questions sent to reporter apps.
    Only one package may be in "published" status at a time;
    publishing a new one archives the previous.
    """

    __tablename__ = "question_packages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    version: Mapped[str] = mapped_column(
        String(20), nullable=False, unique=True, index=True
    )
    # draft → published → archived
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="draft", index=True
    )

    # Nullable so the system seed (which has no dashboard user) can insert rows
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("dashboard_users.id", ondelete="SET NULL"),
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    questions: Mapped[list["Question"]] = relationship(
        "Question",
        back_populates="package",
        order_by="Question.order_index",
        cascade="all, delete-orphan",
        lazy="select",
    )

    def __repr__(self) -> str:
        return f"<QuestionPackage v{self.version} ({self.status})>"


class Question(Base):
    """A single question within a QuestionPackage."""

    __tablename__ = "questions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    package_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("question_packages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    question_text: Mapped[str] = mapped_column(String(500), nullable=False)
    # single_select | multi_select | text
    question_type: Mapped[str] = mapped_column(String(20), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_mandatory: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_core: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Relationships
    package: Mapped["QuestionPackage"] = relationship(
        "QuestionPackage", back_populates="questions"
    )
    options: Mapped[list["QuestionOption"]] = relationship(
        "QuestionOption",
        back_populates="question",
        order_by="QuestionOption.order_index",
        cascade="all, delete-orphan",
        lazy="select",
    )

    def __repr__(self) -> str:
        return f"<Question {self.order_index}: {self.question_text[:40]}>"


class QuestionOption(Base):
    """A selectable option for a single_select or multi_select question."""

    __tablename__ = "question_options"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    question_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("questions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    option_text: Mapped[str] = mapped_column(String(255), nullable=False)
    option_value: Mapped[str] = mapped_column(String(100), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Relationship
    question: Mapped["Question"] = relationship(
        "Question", back_populates="options"
    )

    def __repr__(self) -> str:
        return f"<QuestionOption {self.option_value}>"
