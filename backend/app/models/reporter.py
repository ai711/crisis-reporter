import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, Text, Integer, LargeBinary
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class Reporter(Base):
    __tablename__ = "reporters"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Human-readable sequential display ID (e.g. 1, 2, 3) — assigned via DB sequence
    display_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True, unique=True, index=True
    )

    # Device identity
    device_id_encrypted: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    device_id_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    platform: Mapped[str] = mapped_column(
        String(20), nullable=False, index=True
    )  # android, pwa, web

    # Optional verified account
    email_encrypted: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    email_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    name_encrypted: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True
    )
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_verified: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    # Location
    country_code: Mapped[str | None] = mapped_column(
        String(10), nullable=True, index=True
    )
    language_code: Mapped[str] = mapped_column(
        String(10), default="en", nullable=False
    )

    # Status
    is_blocked: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, index=True
    )
    block_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Activity
    report_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False, index=True
    )
    last_active_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow,
        nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    # Relationships
    reports: Mapped[list["Report"]] = relationship(
        "Report", back_populates="reporter", lazy="select"
    )
    push_tokens: Mapped[list["PushToken"]] = relationship(
        "PushToken", back_populates="reporter", lazy="select"
    )

    def __repr__(self) -> str:
        return f"<Reporter {self.id} ({self.platform})>"