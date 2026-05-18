import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
from app.database import Base


class ReportProject(Base):
    __tablename__ = "report_projects"

    report_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reports.id"), primary_key=True
    )
    crisis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("crises.id"), primary_key=True
    )
    linked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    linked_by: Mapped[str] = mapped_column(
        String(20), default="auto", nullable=False
    )
    # Values: "auto" (import job), "realtime" (new report), "manual" (future)

    # Relationships
    report: Mapped["Report"] = relationship("Report", back_populates="project_links")
    crisis: Mapped["Crisis"] = relationship("Crisis", back_populates="report_links")
