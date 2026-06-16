"""Project import service.

Links all qualifying (Green + Orange) reports that match a project's
country list and date range. Runs as a background asyncio task triggered
on project creation. Updates import_progress on the Crisis record as it goes.
"""

import logging
import uuid
from datetime import datetime, date, time, timezone

from sqlalchemy import select, func

from app.database import AsyncSessionLocal

log = logging.getLogger(__name__)


async def import_reports_for_project(
    serial_id: str,
    crisis_uuid: uuid.UUID,
    countries: list[str],
    start_date: date,
    end_date: date,
) -> None:
    """Find all qualifying reports and link them to the project via report_projects."""
    from app.models.crisis import Crisis
    from app.models.report import Report
    from app.models.report_project import ReportProject

    start_dt = datetime.combine(start_date, time.min).replace(tzinfo=timezone.utc)
    end_dt = datetime.combine(end_date, time.max).replace(tzinfo=timezone.utc)

    async with AsyncSessionLocal() as db:
        try:
            crisis = await db.get(Crisis, crisis_uuid)
            if not crisis:
                log.error("import_reports_for_project: crisis %s not found", serial_id)
                return

            crisis.import_status = "running"
            await db.commit()

            # Filter by Report.reporter_country — the country captured at submission
            # time via GPS reverse-geocode. This reflects where the damage is located,
            # not the reporter's profile country. No Reporter join required.
            count_q = (
                select(func.count(Report.id))
                .where(
                    Report.flag_status.in_(["green", "orange"]),
                    Report.reporter_country.in_(countries),
                    Report.created_at >= start_dt,
                    Report.created_at <= end_dt,
                )
            )
            total = (await db.execute(count_q)).scalar() or 0

            crisis = await db.get(Crisis, crisis_uuid)
            crisis.import_total = total
            await db.commit()

            log.info(
                "import_reports_for_project: %s — found %d qualifying reports",
                serial_id, total,
            )

            # Fetch report IDs in batches and link them
            offset = 0
            batch_size = 500
            linked = 0

            while True:
                batch_q = (
                    select(Report.id)
                    .where(
                        Report.flag_status.in_(["green", "orange"]),
                        Report.reporter_country.in_(countries),
                        Report.created_at >= start_dt,
                        Report.created_at <= end_dt,
                    )
                    .order_by(Report.created_at.asc())
                    .offset(offset)
                    .limit(batch_size)
                )
                report_ids = (await db.execute(batch_q)).scalars().all()
                if not report_ids:
                    break

                for rid in report_ids:
                    db.add(ReportProject(
                        report_id=rid,
                        crisis_id=crisis_uuid,
                        linked_by="auto",
                    ))

                # Flush and ignore duplicate-key errors (ON CONFLICT DO NOTHING not
                # directly available via ORM — duplicate adds are harmless here since
                # a fresh project won't have existing links)
                try:
                    await db.flush()
                    await db.commit()
                except Exception:
                    await db.rollback()
                    log.warning(
                        "import_reports_for_project: flush error on batch — continuing"
                    )

                linked += len(report_ids)
                offset += batch_size

                # Update progress
                crisis = await db.get(Crisis, crisis_uuid)
                if crisis:
                    crisis.import_progress = linked
                    await db.commit()

            # Mark complete
            crisis = await db.get(Crisis, crisis_uuid)
            if crisis:
                crisis.import_status = "complete"
                crisis.import_progress = linked
                await db.commit()

            log.info(
                "import_reports_for_project: %s — complete, linked %d reports",
                serial_id, linked,
            )

        except Exception as exc:
            log.exception("import_reports_for_project: failed for %s: %s", serial_id, exc)
            try:
                async with AsyncSessionLocal() as db2:
                    crisis = await db2.get(Crisis, crisis_uuid)
                    if crisis:
                        crisis.import_status = "failed"
                        await db2.commit()
            except Exception:
                pass
