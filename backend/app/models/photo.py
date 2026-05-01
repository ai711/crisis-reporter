import uuid
from datetime import datetime
from sqlalchemy import String, DateTime, Integer, Float, Boolean, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID
from app.database import Base


class Photo(Base):
    __tablename__ = "photos"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # Foreign key
    report_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reports.id"), nullable=False, index=True
    )

    # Storage
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_backend: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # local, r2

    # File metadata
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mime_type: Mapped[str] = mapped_column(String(50), nullable=False)
    original_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    final_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    was_compressed: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    compression_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)

    # EXIF data
    exif_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    exif_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    exif_timestamp: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    exif_device_make: Mapped[str | None] = mapped_column(String(100), nullable=True)
    exif_device_model: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Order within report
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )

    # Relationships
    report: Mapped["Report"] = relationship("Report", back_populates="photos")

    def __repr__(self) -> str:
        return f"<Photo {self.id} (report={self.report_id})>"