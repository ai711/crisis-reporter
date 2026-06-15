"""Property service — find-or-create properties from flagged reports.

Called by auto_flagging after a report is assigned Green or Orange status.
"""

import logging
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func

from app.models.property import Property, generate_property_id
from app.models.report import Report
from app.config import settings

log = logging.getLogger(__name__)


async def get_or_create_property(db: AsyncSession, report: Report) -> Property:
    """Find the existing Property for this report's building, or create one.

    Grouping logic:
    1. If report.building_id is not null — look up Property by building_id.
    2. If no match by building_id — look up by GPS proximity within
       GPS_GROUPING_RADIUS_DEGREES (building_id IS NULL properties only).
    3. If still no match — create a new Property record.
    """
    radius = settings.GPS_GROUPING_RADIUS_DEGREES

    # ── Path 1: building_id present — exact match ─────────────────────────────
    if report.building_id:
        result = await db.execute(
            select(Property).where(Property.building_id == report.building_id)
        )
        prop = result.scalar_one_or_none()
        if prop:
            return prop

        # No existing property for this building_id — create one
        prop = Property(
            id=generate_property_id(),
            building_id=report.building_id,
            latitude=report.gps_latitude or 0.0,
            longitude=report.gps_longitude or 0.0,
            confirmed_status=None,
            is_recovered=False,
            has_conflict_warning=False,
        )
        db.add(prop)
        await db.flush()
        log.info("property_service: created %s for building_id=%s", prop.id, report.building_id)
        return prop

    # ── Path 2: no building_id — GPS proximity match ──────────────────────────
    if report.gps_latitude is not None and report.gps_longitude is not None:
        result = await db.execute(
            select(Property).where(
                and_(
                    Property.building_id.is_(None),
                    Property.latitude.between(
                        report.gps_latitude - radius, report.gps_latitude + radius
                    ),
                    Property.longitude.between(
                        report.gps_longitude - radius, report.gps_longitude + radius
                    ),
                )
            ).order_by(
                # Pick nearest centroid
                (Property.latitude - report.gps_latitude) * (Property.latitude - report.gps_latitude)
                + (Property.longitude - report.gps_longitude) * (Property.longitude - report.gps_longitude)
            ).limit(1)
        )
        prop = result.scalar_one_or_none()
        if prop:
            return prop

    # ── Path 3: create new property ───────────────────────────────────────────
    lat = report.gps_latitude or 0.0
    lng = report.gps_longitude or 0.0
    prop = Property(
        id=generate_property_id(),
        building_id=None,
        latitude=lat,
        longitude=lng,
        confirmed_status=None,
        is_recovered=False,
        has_conflict_warning=False,
    )
    db.add(prop)
    await db.flush()
    log.info(
        "property_service: created %s for GPS (%.6f, %.6f)", prop.id, lat, lng
    )
    return prop


async def update_conflict_warning(db: AsyncSession, property_id: str) -> Property:
    """Recompute and cache the conflict warning flag for a property.

    Conflict warning fires when the dominant damage level has less than
    (1 - CONFLICT_WARNING_THRESHOLD) share of all Green/Orange reports,
    i.e., no single level has a strong enough consensus.
    """
    result = await db.execute(
        select(Property).where(Property.id == property_id)
    )
    prop = result.scalar_one_or_none()
    if not prop:
        log.warning("update_conflict_warning: property %s not found", property_id)
        return prop  # type: ignore[return-value]

    # Manual confirmation resolves conflict — auto-confirmation does not
    if prop.confirmed_status is not None and prop.manual_confirmed_lock:
        prop.has_conflict_warning = False
        await db.flush()
        return prop

    # Count qualifying reports per damage level
    reports_result = await db.execute(
        select(Report.damage_level).where(
            and_(
                Report.property_id == property_id,
                Report.flag_status.in_(["green", "orange"]),
            )
        )
    )
    levels = [row[0] for row in reports_result.all()]
    total = len(levels)

    if total < 2:
        prop.has_conflict_warning = False
    else:
        counts: dict[str, int] = {}
        for lvl in levels:
            counts[lvl] = counts.get(lvl, 0) + 1
        max_count = max(counts.values())
        max_pct = max_count / total
        # Conflict when majority level doesn't hold (1 - threshold) consensus
        prop.has_conflict_warning = max_pct < (1.0 - settings.CONFLICT_WARNING_THRESHOLD)

    await db.flush()
    return prop


async def auto_confirm_property(db: AsyncSession, property_id: str) -> None:
    """Set confirmed_status to the majority damage level across all qualifying reports.

    Rules:
    - Skips if manual_confirmed_lock is True (human override in place).
    - Minimum 1 qualifying report required.
    - Tie-break: the damage level from the most recent qualifying report wins.
    - Does NOT suppress conflict warning — that stays live so reviewers can spot disagreement
      even when a majority status has been auto-confirmed.
    """
    result = await db.execute(select(Property).where(Property.id == property_id))
    prop = result.scalar_one_or_none()
    if not prop or prop.manual_confirmed_lock:
        return

    # Aggregate: count + most-recent submission timestamp per damage level
    agg_result = await db.execute(
        select(
            Report.damage_level,
            func.count(Report.id).label("cnt"),
            func.max(Report.submitted_at).label("latest"),
        )
        .where(
            and_(
                Report.property_id == property_id,
                Report.flag_status.in_(["green", "orange"]),
                Report.damage_level.isnot(None),
            )
        )
        .group_by(Report.damage_level)
    )
    rows = agg_result.all()
    if not rows:
        return

    max_count = max(r.cnt for r in rows)
    tied = [r for r in rows if r.cnt == max_count]

    if len(tied) == 1:
        majority_level = tied[0].damage_level
    else:
        # Tie-break: latest submission timestamp
        majority_level = max(tied, key=lambda r: r.latest).damage_level

    if prop.confirmed_status == majority_level and prop.auto_confirmed:
        return  # Already up to date

    prop.confirmed_status = majority_level
    prop.confirmed_by = None
    prop.confirmed_at = datetime.now(timezone.utc)
    prop.auto_confirmed = True

    await db.flush()
    log.info(
        "auto_confirm_property: %s confirmed_status=%s (majority of qualifying reports)",
        property_id, majority_level,
    )
