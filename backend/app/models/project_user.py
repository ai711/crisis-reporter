import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class ProjectUser(Base):
    __tablename__ = "project_users"

    crisis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("crises.id"), primary_key=True
    )
    dashboard_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), primary_key=True
    )
    access_level: Mapped[str] = mapped_column(
        String(20), default="view_and_edit", nullable=False
    )
    # Values: "view_only", "view_and_edit"

    is_creator: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )

    # Relationships
    crisis: Mapped["Crisis"] = relationship("Crisis", back_populates="project_users")
    dashboard_user: Mapped["DashboardUser"] = relationship("DashboardUser")
