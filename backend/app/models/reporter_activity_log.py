import uuid
from datetime import datetime
from sqlalchemy import String, Text, DateTime, Integer, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy import func
from app.database import Base


class ReporterActivityLog(Base):
    __tablename__ = "reporter_activity_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reporters.id"), nullable=False, index=True
    )

    action: Mapped[str] = mapped_column(String(100), nullable=False)
    # "status_changed" | "pause_applied" | "pause_removed"
    # "auto_blocked" | "auto_block_confirmed" | "auto_block_reversed" | "auto_block_expired"
    # "auto_flagged"

    previous_value: Mapped[str | None] = mapped_column(String(100), nullable=True)
    new_value: Mapped[str | None] = mapped_column(String(100), nullable=True)

    source: Mapped[str] = mapped_column(String(255), nullable=False)
    # "System" for automatic entries, dashboard user full_name for manual

    dashboard_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    # For auto-block/auto-flag entries — stores display_id of the matched reporter
    matched_reporter_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    reporter: Mapped["Reporter"] = relationship("Reporter", back_populates="activity_log")
