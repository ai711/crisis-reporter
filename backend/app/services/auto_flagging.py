"""Auto-flagging service.

Runs as a FastAPI BackgroundTask after every report submission.
Evaluates the new report against ordered rules and transitions its
flag from grey to green (pass) or red (fail), then writes a FlagEvent
and publishes an SSE flag_changed event to the dashboard.

Thresholds are held in a module-level dict and can be updated at
runtime via the /api/flag-rules PATCH endpoint without a restart.
"""

import asyncio
import ipaddress
import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, func, and_

from app.database import AsyncSessionLocal

log = logging.getLogger(__name__)

# ── Configurable thresholds ───────────────────────────────────────────────────

_thresholds: dict = {
    "duplicate_radius_degrees": 0.001,   # ~100 m at equator
    "duplicate_window_hours": 24,
    "rapid_submission_count": 5,
    "rapid_submission_window_hours": 1,
}


def get_thresholds() -> dict:
    return dict(_thresholds)


def update_thresholds(**kwargs: float | int) -> None:
    valid = set(_thresholds.keys())
    for key, value in kwargs.items():
        if key in valid:
            _thresholds[key] = value


# ── IP geolocation helper ─────────────────────────────────────────────────────

async def _geolocate_ip(ip: str) -> str | None:
    """Return ISO country code for a public IP, or None if unavailable."""
    try:
        addr = ipaddress.ip_address(ip)
        if addr.is_private or addr.is_loopback or addr.is_link_local:
            return None
    except ValueError:
        return None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"http://ip-api.com/json/{ip}?fields=countryCode,status")
            data = r.json()
            if data.get("status") == "success":
                return data.get("countryCode")
    except Exception:
        pass
    return None


# ── Background task entry point ───────────────────────────────────────────────

async def auto_flag_report(report_id: str) -> None:
    """Evaluate flagging rules for *report_id* and persist the result."""
    await asyncio.sleep(10)

    from app.models.report import Report
    from app.models.flag_event import FlagEvent
    from app.models.photo import Photo
    from app.models.reporter import Reporter
    from app.config import settings

    async with AsyncSessionLocal() as db:
        try:
            result = await db.execute(select(Report).where(Report.id == report_id))
            report = result.scalar_one_or_none()
            if not report:
                log.warning("auto_flag_report: report %s not found", report_id)
                return

            new_flag = "green"
            flag_reason: str | None = None
            flag_metadata: dict | None = None

            # ── Rule 1: Photo validation ──────────────────────────────────────
            async def _photo_count() -> int:
                r = await db.execute(
                    select(func.count(Photo.id)).where(Photo.report_id == report.id)
                )
                return r.scalar() or 0

            photo_count = await _photo_count()
            if photo_count == 0 and not report.was_queued:
                age_seconds = (datetime.now(timezone.utc) - report.created_at).total_seconds()
                if age_seconds < 30:
                    await asyncio.sleep(20)
                    photo_count = await _photo_count()
                if photo_count == 0:
                    new_flag = "red"
                    flag_reason = "No photos attached"

            # ── Rule 2: Location validation ───────────────────────────────────
            if new_flag == "green":
                has_gps = report.gps_latitude is not None and report.gps_longitude is not None
                has_address = bool(report.location_address and report.location_address.strip())
                if not has_gps and not has_address:
                    new_flag = "red"
                    flag_reason = "No location provided"

            # ── Rule 3: Coordinated spam detection ────────────────────────────
            if (
                new_flag == "green"
                and report.reporter_id is not None
                and report.gps_latitude is not None
                and report.gps_longitude is not None
            ):
                radius = _thresholds["duplicate_radius_degrees"]
                dup_window = datetime.now(timezone.utc) - timedelta(hours=_thresholds["duplicate_window_hours"])
                dup_result = await db.execute(
                    select(func.count(Report.id)).where(and_(
                        Report.reporter_id != report.reporter_id,
                        Report.crisis_id == report.crisis_id,
                        Report.id != report.id,
                        Report.created_at >= dup_window,
                        Report.gps_latitude.between(
                            report.gps_latitude - radius, report.gps_latitude + radius
                        ),
                        Report.gps_longitude.between(
                            report.gps_longitude - radius, report.gps_longitude + radius
                        ),
                    ))
                )
                if (dup_result.scalar() or 0) > 0:
                    new_flag = "red"
                    flag_reason = "Possible coordinated duplicate — different reporter, same location"

            # ── Rule 4: Rapid submission detection ────────────────────────────
            if new_flag == "green" and report.reporter_id is not None:
                rapid_window = datetime.now(timezone.utc) - timedelta(
                    hours=_thresholds["rapid_submission_window_hours"]
                )
                rapid_result = await db.execute(
                    select(func.count(Report.id)).where(and_(
                        Report.reporter_id == report.reporter_id,
                        Report.id != report.id,
                        Report.created_at >= rapid_window,
                    ))
                )
                if (rapid_result.scalar() or 0) >= _thresholds["rapid_submission_count"]:
                    new_flag = "red"
                    flag_reason = "High submission rate detected"

            # ── Rule 5 (new): IP country mismatch ────────────────────────────
            if new_flag == "green" and report.ip_address_hash:
                try:
                    # Decrypt the IP to geolocate it
                    import base64
                    from app.services.encryption import decrypt_field
                    raw_ip = decrypt_field(base64.b64decode(report.ip_address_encrypted))
                    geo_country = await _geolocate_ip(raw_ip)

                    # Reporter country comes from the linked Reporter record
                    reporter_country: str | None = None
                    if report.reporter_id:
                        rep_r = await db.execute(
                            select(Reporter).where(Reporter.id == report.reporter_id)
                        )
                        rep = rep_r.scalar_one_or_none()
                        if rep:
                            reporter_country = rep.country_code

                    if (
                        geo_country
                        and reporter_country
                        and geo_country.upper() != reporter_country.upper()
                    ):
                        new_flag = "red"
                        flag_reason = "ip_country_mismatch"
                        flag_metadata = {
                            "submission_ip": raw_ip,
                            "geolocated_country": geo_country,
                            "reporter_selected_country": reporter_country,
                        }
                except Exception:
                    log.debug("auto_flag_report: IP country check skipped for %s", report_id)

            # ── Rule 6 (new): Same IP, multiple device IDs ────────────────────
            if new_flag == "green" and report.ip_address_hash:
                ip_window = datetime.now(timezone.utc) - timedelta(hours=24)
                same_ip_result = await db.execute(
                    select(Report.reporter_id).where(and_(
                        Report.ip_address_hash == report.ip_address_hash,
                        Report.id != report.id,
                        Report.created_at >= ip_window,
                        Report.reporter_id.isnot(None),
                        Report.reporter_id != report.reporter_id,
                    )).distinct()
                )
                other_reporter_ids = [str(r) for r in same_ip_result.scalars().all()]

                if len(other_reporter_ids) >= settings.SAME_IP_DEVICE_THRESHOLD:
                    new_flag = "red"
                    flag_reason = "same_ip_multiple_devices"
                    flag_metadata = {
                        "ip_hash": report.ip_address_hash,
                        "other_reporter_ids": other_reporter_ids,
                        "device_count": len(other_reporter_ids) + 1,
                        "window_hours": 24,
                    }

            # ── Rule 7 (new): Duplicate image detection ───────────────────────
            if new_flag == "green":
                photos_r = await db.execute(
                    select(Photo).where(Photo.report_id == report.id)
                )
                new_photos = photos_r.scalars().all()
                for new_photo in new_photos:
                    if not new_photo.photo_hash:
                        continue
                    dup_photo_r = await db.execute(
                        select(Photo).where(and_(
                            Photo.photo_hash == new_photo.photo_hash,
                            Photo.report_id != report.id,
                        )).limit(1)
                    )
                    dup_photo = dup_photo_r.scalar_one_or_none()
                    if dup_photo:
                        new_flag = "red"
                        flag_reason = "duplicate_image"
                        flag_metadata = {
                            "matching_photo_id": str(dup_photo.id),
                            "matching_report_id": str(dup_photo.report_id),
                        }
                        break

            # ── Persist flag transition ───────────────────────────────────────
            old_flag = report.flag_status
            if new_flag != old_flag:
                report.flag_status = new_flag
                db.add(FlagEvent(
                    report_id=report.id,
                    flag_from=old_flag,
                    flag_to=new_flag,
                    changed_by="auto",
                    reason=flag_reason or "Auto-flagging rules applied",
                    flag_metadata=flag_metadata,
                ))
                await db.commit()
                log.info(
                    "auto_flag_report: report %s flagged %s → %s (%s)",
                    report_id, old_flag, new_flag, flag_reason,
                )

                try:
                    from app.routers.dashboard_sse import publish_event
                    await publish_event(
                        crisis_id=str(report.crisis_id),
                        event_type="flag_changed",
                        data={
                            "report_id": report_id,
                            "flag_from": old_flag,
                            "flag_to": new_flag,
                            "reason": flag_reason,
                        },
                    )
                except Exception:
                    log.exception("auto_flag_report: SSE publish failed for %s", report_id)

            # ── Property creation — Green and Orange flags only ────────────────
            if new_flag in ("green", "orange"):
                try:
                    from app.services.property_service import (
                        get_or_create_property,
                        update_conflict_warning,
                    )
                    async with AsyncSessionLocal() as prop_db:
                        prop_report = await prop_db.get(Report, report.id)
                        if prop_report:
                            prop = await get_or_create_property(prop_db, prop_report)
                            prop_report.property_id = prop.id
                            await prop_db.flush()
                            await update_conflict_warning(prop_db, prop.id)
                            await prop_db.commit()
                            log.info(
                                "auto_flag_report: report %s linked to property %s",
                                report_id, prop.id,
                            )
                except Exception:
                    log.exception(
                        "auto_flag_report: property creation failed for report %s", report_id
                    )

        except Exception:
            await db.rollback()
            log.exception("auto_flag_report: unexpected error for report %s", report_id)
            raise


# ── Stuck-report monitor ─────────────────────────────────────────────────────
# Runs every 5 minutes. Finds reports stuck in Grey for > 10 minutes and
# publishes SSE events + logs warnings so ops can investigate.

async def monitor_stuck_grey_reports() -> None:
    """Periodic task: find and alert on reports stuck in Grey for > 10 minutes."""
    from app.models.report import Report

    stuck_threshold = datetime.now(timezone.utc) - timedelta(minutes=10)

    async with AsyncSessionLocal() as db:
        try:
            result = await db.execute(
                select(Report).where(and_(
                    Report.flag_status == "grey",
                    Report.created_at <= stuck_threshold,
                ))
            )
            stuck = result.scalars().all()

            if not stuck:
                return

            for report in stuck:
                minutes_stuck = int(
                    (datetime.now(timezone.utc) - report.created_at).total_seconds() / 60
                )
                log.warning(
                    "STUCK_GREY_REPORT report_id=%s crisis_id=%s minutes_stuck=%d",
                    report.id, report.crisis_id, minutes_stuck,
                )
                try:
                    from app.routers.dashboard_sse import publish_event
                    await publish_event(
                        crisis_id=str(report.crisis_id),
                        event_type="stuck_report",
                        data={
                            "report_id": str(report.id),
                            "minutes_stuck": minutes_stuck,
                            "flag_status": "grey",
                        },
                    )
                except Exception:
                    log.debug("monitor_stuck_grey_reports: SSE publish failed for %s", report.id)

        except Exception:
            log.exception("monitor_stuck_grey_reports: error during check")
