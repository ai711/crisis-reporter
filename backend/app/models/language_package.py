import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, Text, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class StringKey(Base):
    """A translatable UI string identified by a stable machine key (e.g. Q1_LABEL)."""

    __tablename__ = "string_keys"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    key: Mapped[str] = mapped_column(
        String(100), nullable=False, unique=True, index=True
    )
    # button | question | answer | error | content | safety | onboarding | tc
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    english_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    translations: Mapped[list["Translation"]] = relationship(
        "Translation", back_populates="string_key", cascade="all, delete-orphan", lazy="select"
    )

    def __repr__(self) -> str:
        return f"<StringKey {self.key}>"


class Translation(Base):
    """A translated value for one StringKey in one language."""

    __tablename__ = "translations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    string_key_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("string_keys.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    language_code: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    translated_text: Mapped[str] = mapped_column(Text, nullable=False)

    # draft → approved → published
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")

    # "auto" or a dashboard user UUID as string
    translated_by: Mapped[str] = mapped_column(String(255), nullable=False)
    reviewed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    string_key: Mapped["StringKey"] = relationship("StringKey", back_populates="translations")

    __table_args__ = (
        UniqueConstraint("string_key_id", "language_code", name="uq_translation_key_lang"),
        Index("ix_translations_lang_status", "language_code", "status"),
    )

    def __repr__(self) -> str:
        return f"<Translation {self.string_key_id} [{self.language_code}] {self.status}>"


class LanguagePackage(Base):
    """A published snapshot of all approved translations for one language."""

    __tablename__ = "language_packages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    language_code: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(20), nullable=False)

    # draft | published | archived
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)

    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("language_code", "version", name="uq_langpkg_lang_version"),
    )

    def __repr__(self) -> str:
        return f"<LanguagePackage {self.language_code} v{self.version} ({self.status})>"
