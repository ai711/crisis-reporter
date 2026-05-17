import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, Text, ForeignKey, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class FlagEvent(Base):
    __tablename__ = "flag_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Foreign keys
    report_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reports.id"), nullable=False, index=True
    )
    dashboard_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )

    # Flag transition
    flag_from: Mapped[str | None] = mapped_column(String(20), nullable=True)
    flag_to: Mapped[str] = mapped_column(String(20), nullable=False)

    # Source of change
    changed_by: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # auto, manual
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Structured context for auto-flag reasons (IP details, device lists, etc.)
    flag_metadata: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True)

    # Superadmin emergency override — bypasses normal transition matrix
    is_emergency_override: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )

    # Timestamp
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow,
        nullable=False, index=True
    )

    # Relationships
    report: Mapped["Report"] = relationship("Report", back_populates="flag_events")
    dashboard_user: Mapped["DashboardUser"] = relationship(
        "DashboardUser", back_populates="flag_events"
    )

    def __repr__(self) -> str:
        return f"<FlagEvent {self.flag_from} -> {self.flag_to} (report={self.report_id})>"