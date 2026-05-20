import uuid
from datetime import datetime
from sqlalchemy import (
    String, DateTime, Text, Integer, Float,
    Boolean, ForeignKey, Index, JSON
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from app.database import Base


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Local ID from device — used for offline queue merge
    local_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True, index=True
    )

    # Foreign keys
    crisis_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("crises.id"), nullable=False, index=True
    )
    reporter_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reporters.id"), nullable=True, index=True
    )

    # Building identification
    building_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True
    )
    building_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Property record — set after auto-flagging assigns Green or Orange
    property_id: Mapped[str | None] = mapped_column(
        String(50), ForeignKey("properties.id"), nullable=True, index=True
    )

    # Location
    gps_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_accuracy_meters: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_available: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Manual location fallback (when GPS unavailable)
    location_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_landmark: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_building_name: Mapped[str | None] = mapped_column(Text, nullable=True)

    # BE-03 — Chapter 5 extended location fields
    building_centroid_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    building_centroid_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    building_name_osm: Mapped[str | None] = mapped_column(String(300), nullable=True)
    building_name_reporter: Mapped[str | None] = mapped_column(String(300), nullable=True)
    location_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_entry_method: Mapped[str | None] = mapped_column(String(50), nullable=True)
    location_internet_available: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    gps_denied: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # Damage assessment
    damage_level: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # minimal, partial, complete
    infrastructure_type: Mapped[str] = mapped_column(
        String(50), nullable=False
    )
    # New question fields (UNDP required)
    infrastructure_types: Mapped[list[str] | None] = mapped_column(
        ARRAY(String), nullable=True
    )
    infrastructure_other: Mapped[str | None] = mapped_column(Text, nullable=True)
    infrastructure_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    disaster_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    debris_blocking: Mapped[str | None] = mapped_column(String(50), nullable=True)
    electricity_condition: Mapped[str | None] = mapped_column(String(50), nullable=True)
    health_services_condition: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pressing_needs: Mapped[list[str] | None] = mapped_column(ARRAY(String), nullable=True)
    pressing_needs_other: Mapped[str | None] = mapped_column(Text, nullable=True)

    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_translated: Mapped[str | None] = mapped_column(Text, nullable=True)
    description_language: Mapped[str | None] = mapped_column(
        String(10), nullable=True
    )

    # Flag system
    flag_status: Mapped[str] = mapped_column(
        String(20), default="grey", nullable=False, index=True
    )  # grey, green, orange, red, discarded

    # Submission metadata
    platform: Mapped[str] = mapped_column(
        String(20), nullable=False, index=True
    )  # android, pwa, web
    app_version: Mapped[str | None] = mapped_column(String(20), nullable=True)
    language_code: Mapped[str] = mapped_column(
        String(10), default="en", nullable=False
    )

    # Question package versioning
    question_package_version: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )
    translation_version: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # BE-05 — Chapter 6 structured question answers and precise version fields
    question_answers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    question_package_content_version: Mapped[str | None] = mapped_column(
        String(50), nullable=True
    )
    question_package_translation_version: Mapped[str | None] = mapped_column(
        String(50), nullable=True
    )

    # MCC data — Android only
    mcc: Mapped[str | None] = mapped_column(String(10), nullable=True)
    mnc: Mapped[str | None] = mapped_column(String(10), nullable=True)
    carrier_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # IP address (encrypted at application level)
    ip_address_encrypted: Mapped[bytes | None] = mapped_column(
        String(500), nullable=True
    )
    # SHA-256 hash of the IP — allows same-IP queries without decrypting
    ip_address_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )

    # BE-02 — Chapter 4 submission timing and photo metadata
    flow_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    submission_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    submission_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    photo_metadata: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_exif_data: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Offline submission tracking
    was_queued: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    queued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    synced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Timestamps
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow,
        nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    # Relationships
    crisis: Mapped["Crisis"] = relationship(
        "Crisis", back_populates="reports"
    )
    reporter: Mapped["Reporter"] = relationship(
        "Reporter", back_populates="reports"
    )
    photos: Mapped[list["Photo"]] = relationship(
        "Photo", back_populates="report", lazy="select"
    )
    flag_events: Mapped[list["FlagEvent"]] = relationship(
        "FlagEvent", back_populates="report", lazy="select"
    )
    project_links: Mapped[list["ReportProject"]] = relationship(
        "ReportProject", back_populates="report"
    )

    # Composite indexes for dashboard queries
    __table_args__ = (
        Index("ix_reports_crisis_created", "crisis_id", "created_at"),
        Index("ix_reports_crisis_flag", "crisis_id", "flag_status"),
        Index("ix_reports_building_crisis", "building_id", "crisis_id"),
        Index("ix_reports_device_building", "reporter_id", "building_id", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<Report {self.id} ({self.flag_status})>"