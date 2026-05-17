import uuid
from datetime import datetime
from sqlalchemy import String, Text, Boolean, DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class PropertyComment(Base):
    __tablename__ = "property_comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    property_id: Mapped[str] = mapped_column(
        String(50), ForeignKey("properties.id"), nullable=False, index=True
    )

    # Null for system-generated entries
    dashboard_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )

    comment_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_system_generated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # What type of system event generated this entry
    # e.g. "confirmed_status_set", "confirmed_status_changed", "confirmed_status_cleared",
    # "property_recovered", "property_reinstated", "flagged_for_review", "dismissed_from_review"
    system_event_type: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    property: Mapped["Property"] = relationship("Property", back_populates="comments")
    dashboard_user: Mapped["DashboardUser | None"] = relationship("DashboardUser")

    def __repr__(self) -> str:
        return f"<PropertyComment {self.id} property={self.property_id} system={self.is_system_generated}>"
