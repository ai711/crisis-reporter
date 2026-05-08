"""Auto-flagging service.

Runs as a FastAPI BackgroundTask after every report submission.
Evaluates the new report against ordered rules and transitions its
flag from grey to green (pass) or red (fail), then writes a FlagEvent
and publishes an SSE flag_changed event to the dashboard.

Thresholds are held in a module-level dict and can be updated at
runtime via the /api/flag-rules PATCH endpoint without a restart.
"""

import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy import select, func, and_

from app.database import AsyncSessionLocal

log = logging.getLogger(__name__)

# ── Configurable thresholds ───────────────────────────────────────────────────

_thresholds: dict = {
    "duplicate_radius_degrees": 0.001,   # ~100 m at equator
    "duplicate_window_hours": 24,
    "rapid_submission_count": 5,         # max reports per window before red
    "rapid_submission_window_hours": 1,
}


def get_thresholds() -> dict:
    return dict(_thresholds)


def update_thresholds(**kwargs: float | int) -> None:
    valid = set(_thresholds.keys())
    for key, value in kwargs.items():
        if key in valid:
            _thresholds[key] = value


# ── Background task entry point ───────────────────────────────────────────────

async def auto_flag_report(report_id: str) -> None:
    """Evaluate flagging rules for *report_id* and persist the result.

    Called as a FastAPI BackgroundTask so it runs after the HTTP response
    has been sent to the reporter.  Opens its own database session.
    """
    from app.models.report import Report
    from app.models.flag_event import FlagEvent
    from app.models.photo import Photo

    async with AsyncSessionLocal() as db:
        try:
            result = await db.execute(
                select(Report).where(Report.id == report_id)
            )
            report = result.scalar_one_or_none()
            if not report:
                log.warning("auto_flag_report: report %s not found", report_id)
                return

            new_flag = "green"
            flag_reason: str | None = None

            # ── Rule 1: Photo validation ──────────────────────────────────────
            photo_count_result = await db.execute(
                select(func.count(Photo.id)).where(Photo.report_id == report.id)
            )
            photo_count = photo_count_result.scalar() or 0
            if photo_count == 0:
                new_flag = "red"
                flag_reason = "No photos attached"

            # ── Rule 2: Location validation ───────────────────────────────────
            if new_flag == "green":
                has_gps = (
                    report.gps_latitude is not None
                    and report.gps_longitude is not None
                )
                has_address = bool(
                    report.location_address and report.location_address.strip()
                )
                if not has_gps and not has_address:
                    new_flag = "red"
                    flag_reason = "No location provided"

            # ── Rule 3: Duplicate detection ───────────────────────────────────
            if (
                new_flag == "green"
                and report.reporter_id is not None
                and report.gps_latitude is not None
                and report.gps_longitude is not None
            ):
                radius = _thresholds["duplicate_radius_degrees"]
                dup_window = datetime.now(timezone.utc) - timedelta(
                    hours=_thresholds["duplicate_window_hours"]
                )
                dup_result = await db.execute(
                    select(func.count(Report.id)).where(
                        and_(
                            Report.reporter_id == report.reporter_id,
                            Report.crisis_id == report.crisis_id,
                            Report.id != report.id,
                            Report.created_at >= dup_window,
                            Report.gps_latitude.between(
                                report.gps_latitude - radius,
                                report.gps_latitude + radius,
                            ),
                            Report.gps_longitude.between(
                                report.gps_longitude - radius,
                                report.gps_longitude + radius,
                            ),
                        )
                    )
                )
                if (dup_result.scalar() or 0) > 0:
                    new_flag = "red"
                    flag_reason = "Possible duplicate submission"

            # ── Rule 4: Rapid submission detection ────────────────────────────
            if new_flag == "green" and report.reporter_id is not None:
                rapid_window = datetime.now(timezone.utc) - timedelta(
                    hours=_thresholds["rapid_submission_window_hours"]
                )
                rapid_result = await db.execute(
                    select(func.count(Report.id)).where(
                        and_(
                            Report.reporter_id == report.reporter_id,
                            Report.id != report.id,
                            Report.created_at >= rapid_window,
                        )
                    )
                )
                if (rapid_result.scalar() or 0) >= _thresholds["rapid_submission_count"]:
                    new_flag = "red"
                    flag_reason = "High submission rate detected"

            # ── Rule 5: All rules passed — green ──────────────────────────────
            # new_flag is already "green" if we reach here without a red hit.

            # Persist flag transition (report always starts as "grey")
            old_flag = report.flag_status
            if new_flag != old_flag:
                report.flag_status = new_flag
                db.add(
                    FlagEvent(
                        report_id=report.id,
                        flag_from=old_flag,
                        flag_to=new_flag,
                        changed_by="auto",
                        reason=flag_reason or "Auto-flagging rules applied",
                    )
                )
                await db.commit()
                log.info(
                    "auto_flag_report: report %s flagged %s → %s (%s)",
                    report_id, old_flag, new_flag, flag_reason,
                )

                # Notify dashboard via SSE
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

        except Exception:
            await db.rollback()
            log.exception("auto_flag_report: unexpected error for report %s", report_id)
            raise
