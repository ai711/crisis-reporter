import uuid
import secrets
from datetime import datetime
from sqlalchemy import String, Float, Boolean, DateTime, Text, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


def generate_property_id() -> str:
    return "PROP-" + secrets.token_hex(4).upper()


class Property(Base):
    __tablename__ = "properties"

    id: Mapped[str] = mapped_column(String(50), primary_key=True, default=generate_property_id)

    # Primary grouping key — OSM way ID string, e.g. "258734901"
    # Null for GPS-proximity-grouped properties
    building_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True, index=True)

    # GPS centroid — grouping fallback and map display
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    # Override fields — set by dashboard users, never auto-populated from reporter data
    override_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    override_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    override_lng: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Confirmed status — set manually by dashboard users
    confirmed_status: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Recovery status
    is_recovered: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    recovered_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )
    recovered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Review queue flag — manually flagged by a dashboard user
    is_flagged_for_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    flagged_for_review_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Conflict warning — computed and cached server-side
    has_conflict_warning: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    comments: Mapped[list["PropertyComment"]] = relationship(
        "PropertyComment", back_populates="property", order_by="PropertyComment.created_at"
    )

    __table_args__ = (
        Index("ix_properties_lat_lng", "latitude", "longitude"),
    )

    def __repr__(self) -> str:
        return f"<Property {self.id} building={self.building_id}>"
