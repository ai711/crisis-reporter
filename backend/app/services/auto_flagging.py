"""Auto-flagging service.

Runs as a FastAPI BackgroundTask after every report submission.
Evaluates the new report against ALL ordered rules regardless of earlier
triggers. Every rule that fires appends an entry to `triggered_rules`.
A single FlagEvent is written at the end with the full list stored in
flag_metadata["triggered_rules"].

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
    "rapid_submission_count": 14,        # triggers on the 15th submission
    "rapid_submission_window_hours": 1,
    "gps_duplicate_enabled": False,      # Rule 5 disabled by default (see notes)
}


def get_thresholds() -> dict:
    return dict(_thresholds)


def update_thresholds(**kwargs) -> None:
    valid = set(_thresholds.keys())
    for key, value in kwargs.items():
        if key in valid:
            _thresholds[key] = value


def init_redis(client) -> None:
    """Wire the shared app.state.redis pool into this module.
    Called once from main.py lifespan after the pool is created.
    Falls back to lazy-init if never called (dev/test environments).
    """
    global _geo_redis_client
    _geo_redis_client = client


# ── IP geolocation helpers ────────────────────────────────────────────────────

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
        from app.config import settings as _cfg
        url = f"http://ip-api.com/json/{ip}?fields=countryCode,status"
        if _cfg.IPAPI_KEY:
            url += f"&key={_cfg.IPAPI_KEY}"
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
            data = r.json()
            if data.get("status") == "success":
                return data.get("countryCode")
    except Exception:
        pass
    return None


_geo_redis_client = None


async def _get_geo_redis():
    """Lazy-init a shared Redis client for the IP geolocation cache."""
    global _geo_redis_client
    if _geo_redis_client is None:
        try:
            import redis.asyncio as aioredis
            from app.config import settings as _s
            _geo_redis_client = aioredis.from_url(_s.REDIS_URL, decode_responses=True)
        except Exception:
            pass
    return _geo_redis_client


async def _geolocate_ip_cached(ip: str, ip_hash: str) -> str | None:
    """Geolocate an IP with Redis caching (24h TTL keyed by ip_hash).

    Cache hit → no external call.
    Cache miss → calls ip-api.com (45 req/min free tier), stores result.
    Returns ISO country code or None.
    """
    _CACHE_KEY = f"geo:{ip_hash}"
    _CACHE_TTL = 86400   # 24 hours
    _NONE_SENTINEL = "_none_"

    try:
        rc = await _get_geo_redis()
        if rc:
            cached = await rc.get(_CACHE_KEY)
            if cached is not None:
                return None if cached == _NONE_SENTINEL else cached
    except Exception:
        pass

    result = await _geolocate_ip(ip)

    try:
        rc = await _get_geo_redis()
        if rc:
            await rc.setex(_CACHE_KEY, _CACHE_TTL, result or _NONE_SENTINEL)
    except Exception:
        pass

    return result


# ── Real-time project linking ────────────────────────────────────────────────

async def _link_report_to_projects(db, report) -> None:
    """Link a newly approved report to all matching active/closed projects.

    Matching criteria:
      - project.status in (active, closed) — archived projects don't receive new reports
      - project.start_date <= report.created_at.date() <= project.end_date
      - report.reporter_country in project.countries (both are ISO 3166-1 alpha-2 codes)

    reporter_country is the 2-letter code set at submission time from GPS reverse-geocoding
    (MapTiler) or, as a fallback, the reporter's onboarding country selection. It reflects
    where the damage is located, NOT the reporter's profile country or IP geolocation.
    project.countries must therefore also store 2-letter codes — full country names will
    never match. The backend ProjectCreate validator enforces this on project creation.
    """
    from app.models.crisis import Crisis
    from app.models.report_project import ReportProject

    report_country: str | None = getattr(report, "reporter_country", None)

    if not report_country or not report.created_at:
        log.debug(
            "_link_report_to_projects: skipping report %s — reporter_country=%r created_at=%r",
            report.id, report_country, report.created_at,
        )
        return

    report_date = report.created_at.date()

    matching = await db.execute(
        select(Crisis).where(
            Crisis.status.in_(["active", "closed"]),
            Crisis.start_date <= report_date,
            Crisis.end_date >= report_date,
            Crisis.countries.contains([report_country]),
        )
    )

    matched = matching.scalars().all()
    if not matched:
        log.debug(
            "_link_report_to_projects: no project found for reporter_country=%s "
            "date=%s report=%s — report will not be auto-linked",
            report_country, report_date, report.id,
        )

    for crisis in matched:
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
            log.debug(
                "_link_report_to_projects: linked report %s → project %s (country=%s)",
                report.id, crisis.serial_id, report_country,
            )

    await db.flush()


# ── Background task entry point ───────────────────────────────────────────────

async def auto_flag_report(report_id: str, delay: int = 10) -> None:
    """Evaluate all flagging rules for *report_id* and persist the result.

    All 9 rules run regardless of earlier triggers. Every rule that fires
    appends an entry to triggered_rules. A single FlagEvent is written with
    the full list in flag_metadata["triggered_rules"].

    delay=0 when called from the stuck-report monitor (report already committed).
    """
    if delay > 0:
        await asyncio.sleep(delay)

    from app.models.report import Report
    from app.models.flag_event import FlagEvent
    from app.models.photo import Photo
    from app.models.reporter import Reporter
    from app.config import settings

    # Rule 3 grace window: give slow live photo uploads up to 20 s more. Done before
    # the main session opens so the wait doesn't hold a pooled DB connection.
    async with AsyncSessionLocal() as db:
        pre = (await db.execute(
            select(Report.was_queued, Report.created_at, func.count(Photo.id),
                   Report.ip_address_hash, Report.ip_address_encrypted)
            .outerjoin(Photo, Photo.report_id == Report.id)
            .where(Report.id == report_id)
            .group_by(Report.id)
        )).first()
    # Rule 7's IP geolocation is an external HTTP call (up to 5 s on a cache miss) —
    # also done here, outside any session, so it never holds a pooled connection.
    geo_country: str | None = None
    geo_failed = False
    if pre is not None:
        was_queued, created_at, pre_photo_count, ip_hash, ip_encrypted = pre
        if (
            pre_photo_count == 0
            and not was_queued
            and (datetime.now(timezone.utc) - created_at).total_seconds() < 30
        ):
            await asyncio.sleep(20)
        if ip_hash and ip_encrypted:
            import base64
            from app.services.encryption import decrypt_field
            raw_ip = decrypt_field(base64.b64decode(ip_encrypted))
            try:
                geo_country = await _geolocate_ip_cached(raw_ip, ip_hash)
            except Exception:
                geo_failed = True

    async with AsyncSessionLocal() as db:
        try:
            result = await db.execute(select(Report).where(Report.id == report_id))
            report = result.scalar_one_or_none()
            if not report:
                log.warning("auto_flag_report: report %s not found", report_id)
                return

            # Accumulates every rule that fires this run
            triggered_rules: list[dict] = []

            # Fetch submitting reporter once — reused across Rules 1, 6, 7
            current_reporter = None
            if report.reporter_id:
                rep_result = await db.execute(
                    select(Reporter).where(Reporter.id == report.reporter_id)
                )
                current_reporter = rep_result.scalar_one_or_none()

            # ── Rule 1: Blocked device ID ─────────────────────────────────────
            # 1a: reporter is themselves directly blocked
            # 1b: device ID matches another blocked reporter → auto-block pending
            if current_reporter and current_reporter.device_id_hash:
                if current_reporter.is_blocked:
                    triggered_rules.append({
                        "rule_id": "1a",
                        "reason": "reporter_blocked",
                        "metadata": None,
                    })

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
                    triggered_rules.append({
                        "rule_id": "1b",
                        "reason": "blocked_device",
                        "metadata": {
                            "matched_blocked_reporter_id": str(matched_blocked.id),
                            "device_id_hash": current_reporter.device_id_hash,
                        },
                    })
                    # Side effect: auto-block submitting reporter (pending staff confirmation).
                    # Guard: skip if already pending — re-running the side effect would reset
                    # auto_blocked_at and auto_block_expires_at, letting the reporter
                    # perpetually delay the confirmation window by submitting new reports.
                    if not current_reporter.pending_auto_block_confirmation:
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
                        matched_display = (
                            str(matched_blocked.display_id)
                            if matched_blocked.display_id
                            else str(matched_blocked.id)
                        )
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
                                comment=(
                                    f"Automatically blocked — device ID matches manually "
                                    f"blocked profile {matched_display}"
                                ),
                            )
                        except Exception:
                            log.exception(
                                "auto_flag_report: activity log failed for auto_blocked %s",
                                current_reporter.id,
                            )
                        log.info(
                            "auto_flag_report: reporter %s auto-blocked — device_id matches %s",
                            current_reporter.id, matched_blocked.id,
                        )

            # ── Rule 2: IP matches a blocked reporter ─────────────────────────
            if report.ip_address_hash:
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
                    triggered_rules.append({
                        "rule_id": "2",
                        "reason": "blocked_ip",
                        "metadata": {
                            "matched_blocked_reporter_id": str(matched_ip_blocked.id),
                            "ip_address_hash": report.ip_address_hash,
                        },
                    })
                    log.info(
                        "auto_flag_report: report %s — IP hash matches blocked reporter %s",
                        report_id, matched_ip_blocked.id,
                    )

            # ── Rule 3: No photos ─────────────────────────────────────────────
            # The 20 s grace window for slow uploads already ran before this session opened.
            photo_count = (await db.execute(
                select(func.count(Photo.id)).where(Photo.report_id == report.id)
            )).scalar() or 0
            if photo_count == 0:
                triggered_rules.append({
                    "rule_id": "3",
                    "reason": "no_photos",
                    "metadata": None,
                })

            # ── Rule 4: No location ───────────────────────────────────────────
            # Use location_lat (canonical coord) so pin-drop reports with GPS denied
            # are not incorrectly flagged as having no location.
            has_coords = report.location_lat is not None and report.location_lng is not None
            has_address = bool(report.location_address and report.location_address.strip())
            if not has_coords and not has_address:
                triggered_rules.append({
                    "rule_id": "4",
                    "reason": "no_location",
                    "metadata": None,
                })

            # ── Rule 5: Coordinated GPS duplicate (disabled by default) ───────
            # Disabled because legitimate reporters often submit from the same
            # damaged location, which would trigger false positives. Enable via
            # PATCH /api/flag-rules {"gps_duplicate_enabled": true} if needed.
            if (
                _thresholds.get("gps_duplicate_enabled", False)
                and report.reporter_id is not None
                and report.gps_latitude is not None
                and report.gps_longitude is not None
            ):
                radius = _thresholds["duplicate_radius_degrees"]
                dup_window = datetime.now(timezone.utc) - timedelta(
                    hours=_thresholds["duplicate_window_hours"]
                )
                dup_row_result = await db.execute(
                    select(Report.id, Report.serial_number).where(and_(
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
                    )).limit(1)
                )
                dup_row = dup_row_result.first()
                if dup_row:
                    triggered_rules.append({
                        "rule_id": "5",
                        "reason": "coordinated_gps_duplicate",
                        "metadata": {
                            "matching_report_id": str(dup_row[0]),
                            "matching_report_serial_number": dup_row[1],
                        },
                    })

            # ── Rule 6: Rapid submission ──────────────────────────────────────
            # Triggers on the (rapid_submission_count + 1)th submission in the window.
            # Side effect: 24-hour submission pause on the reporter.
            if report.reporter_id is not None:
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
                rapid_count = rapid_result.scalar() or 0
                if rapid_count >= _thresholds["rapid_submission_count"]:
                    triggered_rules.append({
                        "rule_id": "6",
                        "reason": "high_submission_rate",
                        "metadata": {
                            "count_in_window": rapid_count,
                            "window_hours": _thresholds["rapid_submission_window_hours"],
                            "threshold": _thresholds["rapid_submission_count"],
                        },
                    })
                    # Apply 24-hour submission pause
                    try:
                        pause_reporter = current_reporter
                        if pause_reporter is None:
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
                            try:
                                from app.services.notification_service import fire_notification
                                reporter_label = (
                                    f"Reporter #{pause_reporter.display_id}"
                                    if pause_reporter.display_id
                                    else "A reporter"
                                )
                                await fire_notification(
                                    "reporter_auto_paused",
                                    f"{reporter_label} was automatically paused after submitting "
                                    f"more than {int(_thresholds['rapid_submission_count'])} reports "
                                    f"in {int(_thresholds['rapid_submission_window_hours'])} hour(s).",
                                )
                            except Exception:
                                log.exception(
                                    "auto_flag_report: reporter_auto_paused notification failed"
                                )
                    except Exception:
                        log.exception(
                            "auto_flag_report: pause apply failed for reporter %s",
                            report.reporter_id,
                        )

            # ── Rule 7: IP country mismatch (Redis-cached geolocation) ────────
            # ip-api.com free tier is capped at 45 req/min. Redis caching means
            # each unique IP is geolocated at most once per 24 hours.
            # geo_country was resolved before this session opened (see top of function).
            if report.ip_address_hash and report.ip_address_encrypted:
                reporter_country: str | None = (
                    current_reporter.country_code if current_reporter else None
                )
                if geo_failed:
                    log.warning(
                        "auto_flag_report: Rule 7 (IP country) skipped for %s — "
                        "geolocation unavailable or throttled",
                        report_id,
                    )
                elif (
                    geo_country
                    and reporter_country
                    and geo_country.upper() != reporter_country.upper()
                ):
                    triggered_rules.append({
                        "rule_id": "7",
                        "reason": "ip_country_mismatch",
                        "metadata": {
                            # Raw IP intentionally omitted — stored encrypted on the report.
                            # Use ReportDetail.submission_ip for on-demand decryption.
                            "geolocated_country": geo_country,
                            "reporter_selected_country": reporter_country,
                        },
                    })

            # ── Rule 8: Same IP, multiple device IDs ──────────────────────────
            if report.ip_address_hash:
                ip_window = datetime.now(timezone.utc) - timedelta(hours=24)
                same_ip = and_(
                    Report.ip_address_hash == report.ip_address_hash,
                    Report.id != report.id,
                    Report.created_at >= ip_window,
                    Report.reporter_id.isnot(None),
                    Report.reporter_id != report.reporter_id,
                )
                # Count in SQL and keep only a sample for reviewer links: behind carrier
                # NAT or shared Wi-Fi one IP can carry thousands of reporters, and listing
                # them all made every auto-flag run (and FlagEvent row) grow with volume.
                other_count = (await db.execute(
                    select(func.count(func.distinct(Report.reporter_id))).where(same_ip)
                )).scalar() or 0

                if other_count >= settings.SAME_IP_DEVICE_THRESHOLD:
                    sample_ids = (await db.execute(
                        select(Report.reporter_id).where(same_ip).distinct().limit(20)
                    )).scalars().all()
                    # Enrich with display_ids so reviewers see Reporter #N links
                    display_rows = await db.execute(
                        select(Reporter.id, Reporter.display_id).where(
                            Reporter.id.in_(sample_ids)
                        )
                    )
                    other_reporters = [
                        {"id": str(rid), "display_id": did}
                        for rid, did in display_rows.all()
                    ]
                    triggered_rules.append({
                        "rule_id": "8",
                        "reason": "same_ip_multiple_devices",
                        "metadata": {
                            "ip_hash": report.ip_address_hash,
                            "other_reporters": other_reporters,  # sample of up to 20
                            "device_count": other_count + 1,
                            "window_hours": 24,
                        },
                    })

            # ── Rule 9: Duplicate image ───────────────────────────────────────
            # Two queries total regardless of photo count:
            # 1. Collect all non-null hashes for this report's photos.
            # 2. One JOIN query finds any matching photo + its report serial_number.
            own_hashes_r = await db.execute(
                select(Photo.photo_hash).where(
                    and_(Photo.report_id == report.id, Photo.photo_hash.isnot(None))
                )
            )
            own_hashes = own_hashes_r.scalars().all()
            if own_hashes:
                dup_r = await db.execute(
                    select(Photo.id, Photo.report_id, Report.serial_number)
                    .join(Report, Photo.report_id == Report.id)
                    .where(and_(
                        Photo.photo_hash.in_(own_hashes),
                        Photo.report_id != report.id,
                    ))
                    .limit(1)
                )
                dup_row = dup_r.first()
                if dup_row:
                    triggered_rules.append({
                        "rule_id": "9",
                        "reason": "duplicate_image",
                        "metadata": {
                            "matching_photo_id": str(dup_row[0]),
                            "matching_report_id": str(dup_row[1]),
                            "matching_report_serial_number": dup_row[2],
                        },
                    })

            # ── Persist flag transition ───────────────────────────────────────
            new_flag = "red" if triggered_rules else "green"
            flag_reason = triggered_rules[0]["reason"] if triggered_rules else None
            flag_metadata = {"triggered_rules": triggered_rules} if triggered_rules else None

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
                rule_ids = ", ".join(r["rule_id"] for r in triggered_rules)
                log.info(
                    "auto_flag_report: report %s %s → %s (%d rule(s): %s)",
                    report_id, old_flag, new_flag, len(triggered_rules), rule_ids,
                )

                try:
                    if report.crisis_id is not None:
                        from app.routers.dashboard_sse import publish_event
                        await publish_event(
                            crisis_id=str(report.crisis_id),
                            event_type="flag_changed",
                            data={
                                "report_id": report_id,
                                "flag_from": old_flag,
                                "flag_to": new_flag,
                                "reason": flag_reason,
                                "rule_count": len(triggered_rules),
                            },
                        )
                except Exception:
                    log.exception(
                        "auto_flag_report: SSE publish failed for %s", report_id
                    )

                if new_flag == "red":
                    try:
                        from app.services.notification_service import fire_notification
                        sn = report.serial_number
                        label = f"#{sn}" if sn else report_id[:8]
                        await fire_notification(
                            "new_red_flagged_report",
                            f"Report {label} was automatically flagged Red "
                            f"({len(triggered_rules)} rule(s) triggered) and requires review.",
                            label=label,
                        )
                    except Exception:
                        log.exception(
                            "auto_flag_report: notification fire failed for %s", report_id
                        )

            # ── Property creation — Green and Orange flags only ────────────────
            if new_flag in ("green", "orange"):
                try:
                    from app.services.property_service import (
                        get_or_create_property,
                        auto_confirm_property,
                        update_conflict_warning,
                    )
                    async with AsyncSessionLocal() as prop_db:
                        _pr = await prop_db.execute(
                            select(Report).where(Report.id == report.id)
                        )
                        prop_report = _pr.scalar_one_or_none()
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
                        "auto_flag_report: property creation failed for report %s",
                        report_id,
                    )

        except Exception:
            await db.rollback()
            log.exception(
                "auto_flag_report: unexpected error for report %s", report_id
            )
            raise


# ── Stuck-report monitor ─────────────────────────────────────────────────────
# Runs every 5 minutes. Finds reports stuck in Grey for > 10 minutes and
# publishes SSE events + logs warnings so ops can investigate.

# Retries of stuck reports run at most 5 at a time: after a surge there can be
# thousands, and firing them all at once would exhaust the DB connection pool.
_stuck_retry_semaphore = asyncio.Semaphore(5)
_stuck_retry_inflight: set[str] = set()


async def _retry_stuck_report(report_id: str) -> None:
    try:
        async with _stuck_retry_semaphore:
            await auto_flag_report(report_id, delay=0)
    finally:
        _stuck_retry_inflight.discard(report_id)


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
                threshold_minutes = rec.value.get(
                    "stuck_report_threshold_minutes", threshold_minutes
                )
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

            try:
                from app.services.notification_service import fire_notification
                await fire_notification(
                    "grey_flag_processing_delay",
                    f"{len(stuck)} report(s) have been stuck in Grey flag status for "
                    f"more than {threshold_minutes} minute(s). Auto-flagging is being retried.",
                )
            except Exception:
                log.exception("monitor_stuck_grey_reports: notification fire failed")

            for report in stuck:
                minutes_stuck = int(
                    (datetime.now(timezone.utc) - report.created_at).total_seconds() / 60
                )
                log.warning(
                    "STUCK_GREY_REPORT report_id=%s crisis_id=%s minutes_stuck=%d — "
                    "re-running auto-flag",
                    report.id, report.crisis_id, minutes_stuck,
                )
                rid = str(report.id)
                if rid not in _stuck_retry_inflight:
                    _stuck_retry_inflight.add(rid)
                    asyncio.create_task(_retry_stuck_report(rid))
                try:
                    if report.crisis_id is not None:
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
                    log.debug(
                        "monitor_stuck_grey_reports: SSE publish failed for %s", report.id
                    )

        except Exception:
            log.exception("monitor_stuck_grey_reports: error during check")
