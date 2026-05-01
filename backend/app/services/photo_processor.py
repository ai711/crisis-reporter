import io
from PIL import Image, ExifTags
from datetime import datetime
from typing import Optional


def extract_exif(image_bytes: bytes) -> dict:
    """Extract EXIF metadata from image bytes."""
    exif_data = {
        "latitude": None,
        "longitude": None,
        "timestamp": None,
        "device_make": None,
        "device_model": None,
    }

    try:
        image = Image.open(io.BytesIO(image_bytes))
        raw_exif = image._getexif()
        if not raw_exif:
            return exif_data

        # Map EXIF tag IDs to names
        exif = {
            ExifTags.TAGS.get(tag, tag): value
            for tag, value in raw_exif.items()
        }

        # Device info
        exif_data["device_make"] = exif.get("Make")
        exif_data["device_model"] = exif.get("Model")

        # Timestamp
        dt_str = exif.get("DateTimeOriginal") or exif.get("DateTime")
        if dt_str:
            try:
                exif_data["timestamp"] = datetime.strptime(
                    dt_str, "%Y:%m:%d %H:%M:%S"
                )
            except ValueError:
                pass

        # GPS coordinates
        gps_info = exif.get("GPSInfo")
        if gps_info:
            gps = {
                ExifTags.GPSTAGS.get(tag, tag): value
                for tag, value in gps_info.items()
            }

            def convert_to_degrees(value):
                d, m, s = value
                return float(d) + float(m) / 60 + float(s) / 3600

            if "GPSLatitude" in gps and "GPSLongitude" in gps:
                lat = convert_to_degrees(gps["GPSLatitude"])
                lng = convert_to_degrees(gps["GPSLongitude"])

                if gps.get("GPSLatitudeRef") == "S":
                    lat = -lat
                if gps.get("GPSLongitudeRef") == "W":
                    lng = -lng

                exif_data["latitude"] = round(lat, 7)
                exif_data["longitude"] = round(lng, 7)

    except Exception:
        # EXIF extraction is best-effort — never block a submission
        pass

    return exif_data


def compress_image(image_bytes: bytes, content_type: str) -> tuple[bytes, bool, float]:
    """Compress image according to project thresholds.

    Thresholds:
    - Under 1.5 MB: no compression
    - 1.5 MB to 8 MB: compress to ~1 MB
    - Above 8 MB: compress to ~1.5 MB

    Returns:
        Tuple of (processed_bytes, was_compressed, compression_ratio)
    """
    original_size = len(image_bytes)
    MB = 1024 * 1024

    # Under 1.5 MB — send as-is
    if original_size < 1.5 * MB:
        return image_bytes, False, 1.0

    # Determine target size
    target_size = 1.0 * MB if original_size < 8 * MB else 1.5 * MB

    # Determine image format
    fmt = "JPEG"
    if content_type == "image/png":
        fmt = "PNG"

    try:
        image = Image.open(io.BytesIO(image_bytes))

        # Convert RGBA to RGB for JPEG
        if fmt == "JPEG" and image.mode in ("RGBA", "P"):
            image = image.convert("RGB")

        # Binary search for the right quality level
        low, high = 20, 95
        best_bytes = image_bytes

        for _ in range(8):
            mid = (low + high) // 2
            buffer = io.BytesIO()

            if fmt == "JPEG":
                image.save(buffer, format="JPEG", quality=mid, optimize=True)
            else:
                image.save(buffer, format="PNG", optimize=True)

            compressed = buffer.getvalue()

            if len(compressed) <= target_size:
                best_bytes = compressed
                low = mid + 1
            else:
                high = mid - 1

        final_size = len(best_bytes)
        compression_ratio = round(final_size / original_size, 3)
        return best_bytes, True, compression_ratio

    except Exception:
        # If compression fails return original
        return image_bytes, False, 1.0