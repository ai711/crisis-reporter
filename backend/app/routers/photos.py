import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.photo import Photo
from app.models.report import Report
from app.services.storage import storage_service
from app.services.photo_processor import extract_exif, compress_image
from app.services.dependencies import get_optional_reporter

router = APIRouter(prefix="/api/photos", tags=["Photos"])

# Allowed MIME types
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png"}
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB hard limit before processing


class PhotoResponse(BaseModel):
    id: str
    report_id: str
    url: str
    display_order: int
    original_size_bytes: Optional[int]
    final_size_bytes: Optional[int]
    was_compressed: bool


@router.post("", response_model=PhotoResponse)
async def upload_photo(
    report_id: str = Form(...),
    display_order: int = Form(default=0),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_reporter=Depends(get_optional_reporter),
):
    """Upload a photo for a report.

    Accepts JPEG and PNG.
    Applies compression according to project thresholds.
    Extracts EXIF metadata.
    Stores via StorageService (local or R2).
    """

    # Validate file type
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"File type not allowed. Accepted: JPEG, PNG",
        )

    # Read file
    image_bytes = await file.read()

    # Validate file size
    if len(image_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File too large. Maximum size is 20 MB",
        )

    # Validate report exists
    result = await db.execute(
        select(Report).where(Report.id == report_id)
    )
    report = result.scalar_one_or_none()
    if not report:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report not found",
        )

    # Validate max 3 photos per report
    result = await db.execute(
        select(Photo).where(Photo.report_id == report_id)
    )
    existing_photos = result.scalars().all()
    if len(existing_photos) >= 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Maximum 3 photos per report",
        )

    original_size = len(image_bytes)

    # Extract EXIF metadata
    exif_data = extract_exif(image_bytes)

    # Compress image
    processed_bytes, was_compressed, compression_ratio = compress_image(
        image_bytes, file.content_type
    )

    final_size = len(processed_bytes)

    # Store via StorageService
    storage_path = await storage_service.save(
        file_data=processed_bytes,
        filename=file.filename or f"photo_{uuid.uuid4()}.jpg",
        content_type=file.content_type,
    )

    # Get serving URL
    photo_url = storage_service.get_url(storage_path)

    # Save photo record to database
    photo = Photo(
        report_id=report_id,
        storage_path=storage_path,
        storage_backend=storage_service.__class__.__name__,
        original_filename=file.filename,
        mime_type=file.content_type,
        original_size_bytes=original_size,
        final_size_bytes=final_size,
        was_compressed=was_compressed,
        compression_ratio=compression_ratio,
        exif_latitude=exif_data.get("latitude"),
        exif_longitude=exif_data.get("longitude"),
        exif_timestamp=exif_data.get("timestamp"),
        exif_device_make=exif_data.get("device_make"),
        exif_device_model=exif_data.get("device_model"),
        display_order=display_order,
    )

    db.add(photo)
    await db.commit()
    await db.refresh(photo)

    return PhotoResponse(
        id=str(photo.id),
        report_id=str(photo.report_id),
        url=photo_url,
        display_order=photo.display_order,
        original_size_bytes=photo.original_size_bytes,
        final_size_bytes=photo.final_size_bytes,
        was_compressed=photo.was_compressed,
    )


@router.get("/report/{report_id}", response_model=list[PhotoResponse])
async def get_report_photos(
    report_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all photos for a report ordered by display_order."""
    result = await db.execute(
        select(Photo)
        .where(Photo.report_id == report_id)
        .order_by(Photo.display_order)
    )
    photos = result.scalars().all()

    return [
        PhotoResponse(
            id=str(p.id),
            report_id=str(p.report_id),
            url=storage_service.get_url(p.storage_path),
            display_order=p.display_order,
            original_size_bytes=p.original_size_bytes,
            final_size_bytes=p.final_size_bytes,
            was_compressed=p.was_compressed,
        )
        for p in photos
    ]