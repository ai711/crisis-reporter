import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class SafetyProgress(Base):
    __tablename__ = "safety_progress"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reporters.id"), nullable=False, index=True
    )
    part_completed: Mapped[str] = mapped_column(
        String(10), nullable=False
    )  # "A", "B", or "C"
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )

    reporter: Mapped["Reporter"] = relationship(
        "Reporter", back_populates="safety_progress"
    )

    def __repr__(self) -> str:
        return f"<SafetyProgress reporter={self.reporter_id} part={self.part_completed}>"
