import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class PushToken(Base):
    __tablename__ = "push_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Foreign key
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reporters.id"),
        nullable=False, index=True
    )

    # Token
    token: Mapped[str] = mapped_column(String(500), nullable=False)
    token_type: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # expo, web_push

    # Platform
    platform: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # android, pwa_android, pwa_ios

    # Status
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    # Relationships
    reporter: Mapped["Reporter"] = relationship(
        "Reporter", back_populates="push_tokens"
    )

    def __repr__(self) -> str:
        return f"<PushToken {self.token_type} ({self.platform})>"