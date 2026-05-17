from sqlalchemy.ext.asyncio import AsyncSession
from app.models.reporter_activity_log import ReporterActivityLog


async def write_activity_log(
    db: AsyncSession,
    reporter_id,
    action: str,
    source: str,
    previous_value: str | None = None,
    new_value: str | None = None,
    dashboard_user_id: str | None = None,
    comment: str | None = None,
    matched_reporter_id: str | None = None,
) -> ReporterActivityLog:
    entry = ReporterActivityLog(
        reporter_id=reporter_id,
        action=action,
        source=source,
        previous_value=previous_value,
        new_value=new_value,
        dashboard_user_id=dashboard_user_id,
        comment=comment,
        matched_reporter_id=matched_reporter_id,
    )
    db.add(entry)
    await db.flush()
    return entry
