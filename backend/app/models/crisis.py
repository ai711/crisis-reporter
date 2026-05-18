import uuid
from datetime import datetime, date
from sqlalchemy import (
    String, Boolean, DateTime, Text, Integer, Float,
    ForeignKey, Date,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from sqlalchemy.sql import func
from app.database import Base


def format_serial_id(n: int) -> str:
    """Format integer as PR-XXXX, expanding beyond 4 digits if needed."""
    return f"PR-{n:04d}"


class Crisis(Base):
    __tablename__ = "crises"

    # Internal UUID — used for FK references in other tables
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Public serial number ID — PR-0001, PR-0002, etc.
    serial_id: Mapped[str | None] = mapped_column(
        String(20), unique=True, nullable=True, index=True
    )
    serial_number: Mapped[int | None] = mapped_column(
        Integer, unique=True, nullable=True
    )

    # Core fields
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Countries — stored as array; country_code kept for backward compat with reporter app
    country_code: Mapped[str | None] = mapped_column(
        String(10), nullable=True, index=True
    )
    countries: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(100)), nullable=True
    )

    # Date range
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Status — three values: "active", "closed", "archived"
    status: Mapped[str] = mapped_column(
        String(20), default="active", nullable=False, index=True
    )

    # Map centre
    map_center_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    map_center_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    map_zoom: Mapped[int | None] = mapped_column(Integer, nullable=True)
    map_default_radius_miles: Mapped[int] = mapped_column(
        Integer, default=50, nullable=False
    )

    # Creator
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )

    # Import job tracking
    import_job_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    import_status: Mapped[str] = mapped_column(
        String(20), default="pending", nullable=False
    )
    # Values: "pending", "running", "complete", "failed"
    import_progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    import_total: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Backward compat — kept in sync with status on write
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Relationships
    reports: Mapped[list["Report"]] = relationship(
        "Report", back_populates="crisis", lazy="select"
    )
    project_users: Mapped[list["ProjectUser"]] = relationship(
        "ProjectUser", back_populates="crisis", cascade="all, delete-orphan"
    )
    report_links: Mapped[list["ReportProject"]] = relationship(
        "ReportProject", back_populates="crisis"
    )

    def __repr__(self) -> str:
        return f"<Crisis {self.name} ({self.serial_id or self.id})>"
