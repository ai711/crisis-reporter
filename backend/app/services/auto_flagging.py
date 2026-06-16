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
from sqlalchemy import select, func, and_, or_

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


# ── Real-time project linking ────────────────────────────────────────────────

async def _link_report_to_projects(db, report) -> None:
    """Link a newly approved report to all matching active/closed projects."""
    from app.models.crisis import Crisis
    from app.models.report_project import ReportProject
    from app.models.reporter import Reporter

    # Resolve reporter country
    reporter_country: str | None = None
    if report.reporter_id:
        rep_r = await db.execute(
            select(Reporter).where(Reporter.id == report.reporter_id)
        )
        rep = rep_r.scalar_one_or_none()
        if rep:
            reporter_country = rep.country_code

    if not reporter_country or not report.created_at:
        return

    report_date = report.created_at.date()

    matching = await db.execute(
        select(Crisis).where(
            Crisis.status.in_(["active", "closed"]),
            Crisis.start_date <= report_date,
            Crisis.end_date >= report_date,
            Crisis.countries.contains([reporter_country]),
        )
    )

    for crisis in matching.scalars().all():
        existing = await db.execute(
            select(ReportProject).where(
                ReportProject.report_id == report.id,
                ReportProject.crisis_id == crisis.id,
            )
        )
        if not existing.scalar_one_or_none():
            db.add(ReportProject(
                report_id=report.id,
                crisis_id=crisis.id,
                linked_by="realtime",
            ))

    await db.flush()


# ── Background task entry point ───────────────────────────────────────────────

async def auto_flag_report(report_id: str, delay: int = 10) -> None:
    """Evaluate flagging rules for *report_id* and persist the result.
    delay=0 when called from the stuck-report monitor (report already committed)."""
    if delay > 0:
        await asyncio.sleep(delay)

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

            # ── Rule 1: Blocked device ID match ───────────────────────────────
            # If the reporter's device_id_hash matches any manually-blocked reporter,
            # auto-block this reporter and flag the report Red immediately.
            if new_flag == "green" and report.reporter_id:
                rep_result = await db.execute(
                    select(Reporter).where(Reporter.id == report.reporter_id)
                )
                current_reporter = rep_result.scalar_one_or_none()
                if current_reporter and current_reporter.device_id_hash:
                    # Also flag if the submitting reporter is themselves blocked
                    if current_reporter.is_blocked and new_flag != "red":
                        new_flag = "red"
                        flag_reason = "reporter_blocked"
                    blocked_match_result = await db.execute(
                        select(Reporter).where(
                            and_(
                                Reporter.device_id_hash == current_reporter.device_id_hash,
                                Reporter.is_blocked == True,
                                Reporter.id != current_reporter.id,
                            )
                        ).limit(1)
                    )
                    matched_blocked = blocked_match_result.scalar_one_or_none()
                    if matched_blocked:
                        new_flag = "red"
                        flag_reason = "Device ID matches a blocked reporter profile"
                        flag_metadata = {
                            "matched_blocked_reporter_id": str(matched_blocked.id),
                            "device_id_hash": current_reporter.device_id_hash,
                        }
                        current_reporter.is_blocked = True
                        current_reporter.profile_status = "blocked"
                        current_reporter.auto_blocked_at = datetime.now(timezone.utc)
                        current_reporter.auto_block_expires_at = (
                            datetime.now(timezone.utc)
                            + timedelta(hours=settings.AUTO_BLOCK_CONFIRMATION_HOURS)
                        )
                        current_reporter.pending_auto_block_confirmation = True
                        current_reporter.matched_blocked_reporter_id = str(matched_blocked.id)
                        current_reporter.auto_block_confirmed = False
                        db.add(current_reporter)
                        matched_display = str(matched_blocked.display_id) if matched_blocked.display_id else str(matched_blocked.id)
                        try:
                            from app.services.reporter_activity_service import write_activity_log
                            await write_activity_log(
                                db,
                                reporter_id=current_reporter.id,
                                action="auto_blocked",
                                source="System",
                                previous_value="active",
                                new_value="blocked",
                                matched_reporter_id=matched_display,
                                comment=f"Automatically blocked — device ID matches manually blocked profile {matched_display}",
                            )
                        except Exception:
                            log.exception("auto_flag_report: activity log write failed for auto_blocked %s", current_reporter.id)
                        log.info(
                            "auto_flag_report: reporter %s auto-blocked — device_id matches blocked reporter %s",
                            current_reporter.id, matched_blocked.id,
                        )

            # ── Rule 2: IP blocked reporter match ────────────────────────────
            # Check if the submission IP hash matches any blocked reporter's stored IP hash.
            # reporter.ip_address_hash is updated on every submission in reports.py,
            # so it reflects their most-recent IP rather than only the first one.
            if new_flag == "green" and report.ip_address_hash:
                blocked_ip_result = await db.execute(
                    select(Reporter).where(
                        and_(
                            Reporter.ip_address_hash == report.ip_address_hash,
                            Reporter.is_blocked == True,
                            Reporter.id != report.reporter_id,
                        )
                    ).limit(1)
                )
                matched_ip_blocked = blocked_ip_result.scalar_one_or_none()
                if matched_ip_blocked:
                    new_flag = "red"
                    flag_reason = "Submission IP matches a blocked reporter"
                    flag_metadata = {
                        "matched_blocked_reporter_id": str(matched_ip_blocked.id),
                        "ip_address_hash": report.ip_address_hash,
                    }
                    log.info(
                        "auto_flag_report: report %s flagged Red — IP hash matches blocked reporter %s",
                        report_id, matched_ip_blocked.id,
                    )

            # ── Rule 3: Photo validation ──────────────────────────────────────
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

            # ── Rule 4: Location validation ───────────────────────────────────
            if new_flag == "green":
                has_gps = report.gps_latitude is not None and report.gps_longitude is not None
                has_address = bool(report.location_address and report.location_address.strip())
                if not has_gps and not has_address:
                    new_flag = "red"
                    flag_reason = "No location provided"

            # ── Rule 5: Coordinated spam detection ────────────────────────────
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

            # ── Rule 6: Rapid submission detection ────────────────────────────
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
                    # Apply 24-hour submission pause on the reporter
                    try:
                        pause_rep_result = await db.execute(
                            select(Reporter).where(Reporter.id == report.reporter_id)
                        )
                        pause_reporter = pause_rep_result.scalar_one_or_none()
                        if pause_reporter and not pause_reporter.is_paused:
                            pause_expires = datetime.now(timezone.utc) + timedelta(hours=24)
                            pause_reporter.is_paused = True
                            pause_reporter.pause_expires_at = pause_expires
                            pause_reporter.pause_reason = "High submission volume"
                            db.add(pause_reporter)
                            from app.services.reporter_activity_service import write_activity_log
                            await write_activity_log(
                                db,
                                reporter_id=pause_reporter.id,
                                action="pause_applied",
                                source="System",
                                comment=(
                                    f"Submission paused — device submitted more than "
                                    f"{int(_thresholds['rapid_submission_count'])} reports in "
                                    f"{int(_thresholds['rapid_submission_window_hours'])} hour(s). "
                                    f"Expires {pause_expires.isoformat()}"
                                ),
                            )
                    except Exception:
                        log.exception("auto_flag_report: pause apply failed for reporter %s", report.reporter_id)

            # ── Rule 7: IP country mismatch ──────────────────────────────────
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
                            # submission_ip intentionally omitted — raw IP must not be
                            # stored in plaintext in flag_events. The decrypted IP is
                            # available on-demand via ReportDetail.submission_ip.
                            "geolocated_country": geo_country,
                            "reporter_selected_country": reporter_country,
                        }
                except Exception:
                    log.debug("auto_flag_report: IP country check skipped for %s", report_id)

            # ── Rule 8: Same IP, multiple device IDs ──────────────────────────
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

            # ── Rule 9: Duplicate image detection ─────────────────────────────
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
                        dup_sn_r = await db.execute(
                            select(Report.serial_number).where(Report.id == dup_photo.report_id)
                        )
                        flag_metadata = {
                            "matching_photo_id": str(dup_photo.id),
                            "matching_report_id": str(dup_photo.report_id),
                            "matching_report_serial_number": dup_sn_r.scalar_one_or_none(),
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
                        auto_confirm_property,
                        update_conflict_warning,
                    )
                    async with AsyncSessionLocal() as prop_db:
                        prop_report = await prop_db.get(Report, report.id)
                        if prop_report:
                            prop = await get_or_create_property(prop_db, prop_report)
                            prop_report.property_id = prop.id
                            await prop_db.flush()
                            await auto_confirm_property(prop_db, prop.id)
                            await update_conflict_warning(prop_db, prop.id)
                            await _link_report_to_projects(prop_db, prop_report)
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
    """Periodic task: find and alert on reports stuck in Grey for > threshold minutes.
    Reads stuck_report_threshold_minutes from AppSetting, falling back to config."""
    from app.models.report import Report
    from app.config import settings

    threshold_minutes = settings.STUCK_REPORT_THRESHOLD_MINUTES
    try:
        from app.models.app_setting import AppSetting
        from sqlalchemy import select as _sel
        async with AsyncSessionLocal() as _db:
            row = await _db.execute(_sel(AppSetting).where(AppSetting.key == "thresholds"))
            rec = row.scalar_one_or_none()
            if rec and isinstance(rec.value, dict):
                threshold_minutes = rec.value.get("stuck_report_threshold_minutes", threshold_minutes)
    except Exception:
        pass

    stuck_threshold = datetime.now(timezone.utc) - timedelta(minutes=threshold_minutes)

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
                    "STUCK_GREY_REPORT report_id=%s crisis_id=%s minutes_stuck=%d — re-running auto-flag",
                    report.id, report.crisis_id, minutes_stuck,
                )
                # Re-run auto-flagging without delay — report is already committed
                asyncio.create_task(auto_flag_report(str(report.id), delay=0))
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
