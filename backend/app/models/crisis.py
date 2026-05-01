import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class Crisis(Base):
    __tablename__ = "crises"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    country_code: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    map_center_lat: Mapped[float | None] = mapped_column(nullable=True)
    map_center_lng: Mapped[float | None] = mapped_column(nullable=True)
    map_default_radius_miles: Mapped[int] = mapped_column(
        Integer, default=50, nullable=False
    )
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
    reports: Mapped[list["Report"]] = relationship(
        "Report", back_populates="crisis", lazy="select"
    )

    def __repr__(self) -> str:
        return f"<Crisis {self.name} ({self.country_code})>"