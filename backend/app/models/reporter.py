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

    # Profile status — tri-state replaces boolean is_blocked for new code
    profile_status: Mapped[str] = mapped_column(
        String(20), default="active", nullable=False, index=True
    )  # "active" | "flagged" | "blocked"

    # Profile type — cached, recomputed on submission
    profile_type: Mapped[str] = mapped_column(
        String(30), default="anonymous_no_reports", nullable=False, index=True
    )  # "anonymous_no_reports" | "anonymous_with_reports" | "named_profile"

    # Identity / device detail fields
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    app_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    browser_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    mcc: Mapped[str | None] = mapped_column(String(10), nullable=True)

    # 24-hour submission pause
    is_paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    pause_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    pause_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Auto-block state for Tab 4
    auto_blocked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    auto_block_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    auto_block_confirmed: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    auto_block_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    auto_block_confirmed_by: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    matched_blocked_reporter_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    pending_auto_block_confirmation: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, index=True
    )

    # Profile photo
    photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

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
    safety_progress: Mapped[list["SafetyProgress"]] = relationship(
        "SafetyProgress", back_populates="reporter", lazy="select"
    )
    activity_log: Mapped[list["ReporterActivityLog"]] = relationship(
        "ReporterActivityLog",
        back_populates="reporter",
        order_by="ReporterActivityLog.created_at",
        lazy="select",
    )

    def __repr__(self) -> str:
        return f"<Reporter {self.id} ({self.platform})>"