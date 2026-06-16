"""
notification_service.py

Central dispatch for in-dashboard bell notifications.

Calling convention:
    from app.services.notification_service import fire_notification
    await fire_notification("new_red_flagged_report", "Report #42 flagged Red", label="#42")

Behaviour:
    • Reads notification type config from AppSetting(key="notifications").
    • If the type is inactive → no-op.
    • Subscriber scoping:
        - Empty subscriber list → one global row (is_global=TRUE, visible to all users).
        - Non-empty list → one row per subscriber (is_global=FALSE, target_user_id=<id>).
    • Delivery modes:
        - "immediate" → insert row(s) into notifications table immediately.
        - "summary" + label → push label to Redis pending list;
          flush_pending_batches() drains it when summary_interval_minutes elapsed.
    • Cooldowns (Redis, TTL-based) prevent loop-triggered types from spamming
      the bell when the same condition persists across loop cycles.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy import text

from app.database import AsyncSessionLocal

log = logging.getLogger(__name__)

# Cooldown TTLs (seconds) for loop-fired notification types.
# Per-event types (reporter_auto_paused, new_red_flagged_report, etc.) have no entry.
_COOLDOWNS: dict[str, int] = {
    "grey_flag_processing_delay": 30 * 60,
    "high_volume_processing_delay": 30 * 60,
    "review_queue_threshold": 30 * 60,
    "auto_block_confirmation_expiring": 6 * 60 * 60,
    "language_deprecation_expiring": 24 * 60 * 60,
}


async def _load_type_config(type_key: str) -> dict | None:
    """Return the AppSetting config dict for a notification type, or None if not found."""
    from app.models.app_setting import AppSetting
    from sqlalchemy import select
    try:
        async with AsyncSessionLocal() as db:
            row = await db.execute(select(AppSetting).where(AppSetting.key == "notifications"))
            rec = row.scalar_one_or_none()
            if rec and isinstance(rec.value, dict):
                for t in rec.value.get("types", []):
                    if t.get("key") == type_key:
                        return t
    except Exception:
        log.exception("_load_type_config: failed for key=%s", type_key)
    return None


async def _insert_notification(type_key: str, message: str, subscribers: list[str]) -> int:
    """Insert notification rows into the DB. Returns count of rows inserted."""
    async with AsyncSessionLocal() as db:
        if subscribers:
            for user_id in subscribers:
                await db.execute(
                    text("""
                        INSERT INTO notifications
                            (notification_type_key, message, triggered_at, is_global, target_user_id)
                        VALUES (:key, :msg, NOW(), FALSE, :uid::uuid)
                    """),
                    {"key": type_key, "msg": message, "uid": user_id},
                )
            await db.commit()
            return len(subscribers)
        else:
            await db.execute(
                text("""
                    INSERT INTO notifications
                        (notification_type_key, message, triggered_at, is_global, target_user_id)
                    VALUES (:key, :msg, NOW(), TRUE, NULL)
                """),
                {"key": type_key, "msg": message},
            )
            await db.commit()
            return 1


async def _get_transient_redis():
    """Create a short-lived Redis connection for one-off operations."""
    import redis.asyncio as aioredis
    from app.config import settings
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True, socket_connect_timeout=2)


async def fire_notification(
    type_key: str,
    message: str,
    redis_client=None,
    label: str | None = None,
) -> None:
    """
    Fire a notification of the given type.

    type_key     — must match a key in AppSetting(key="notifications").types
    message      — text shown in the bell dropdown (used for immediate mode and batch flush)
    redis_client — optional persistent client; a transient one is created when omitted
    label        — short string pushed to Redis for summary batching (e.g. "#42")
                   When omitted, falls back to immediate mode even if delivery_mode=summary
    """
    try:
        cfg = await _load_type_config(type_key)
        if not cfg:
            log.debug("fire_notification: type '%s' not in AppSetting — skipping", type_key)
            return
        if not cfg.get("active", True):
            return

        subscribers: list[str] = cfg.get("subscribers") or []
        delivery_mode = cfg.get("delivery_mode", "immediate")
        cooldown_secs = _COOLDOWNS.get(type_key)

        # Cooldown check — only for loop-fired types that have a cooldown entry
        if cooldown_secs:
            _redis = redis_client
            _owned = False
            if _redis is None:
                try:
                    _redis = await _get_transient_redis()
                    _owned = True
                except Exception:
                    log.debug("fire_notification: Redis unavailable, skipping cooldown for '%s'", type_key)
                    _redis = None

            if _redis is not None:
                try:
                    cooldown_key = f"notif:cooldown:{type_key}"
                    if await _redis.exists(cooldown_key):
                        log.debug("fire_notification: '%s' suppressed (cooldown active)", type_key)
                        return
                    await _redis.setex(cooldown_key, cooldown_secs, "1")
                finally:
                    if _owned:
                        await _redis.aclose()

        # Summary batching — push label to Redis pending list
        if delivery_mode == "summary" and label:
            _redis = redis_client
            _owned = False
            if _redis is None:
                try:
                    _redis = await _get_transient_redis()
                    _owned = True
                except Exception:
                    _redis = None

            if _redis is not None:
                try:
                    await _redis.rpush(f"notif:pending:{type_key}", label)
                    log.debug("fire_notification: '%s' queued for batch flush (label=%s)", type_key, label)
                    return
                except Exception:
                    log.warning("fire_notification: Redis push failed for '%s', falling back to immediate", type_key)
                finally:
                    if _owned:
                        await _redis.aclose()

        # Immediate delivery (or fallback when Redis unavailable)
        count = await _insert_notification(type_key, message, subscribers)
        log.info("fire_notification: '%s' delivered immediately — %d recipient(s)", type_key, count)

    except Exception:
        log.exception("fire_notification: unexpected error (type_key=%s)", type_key)


async def flush_pending_batches(redis_client) -> None:
    """
    Drain Redis pending lists for summary-mode notification types.
    Called from the _notification_batch_flush_loop in main.py (every 60 s).
    For each summary type, if enough time has passed since last flush, pops all
    pending labels, builds a grouped message, and inserts notification row(s).
    """
    from app.models.app_setting import AppSetting
    from sqlalchemy import select as _sel
    try:
        async with AsyncSessionLocal() as db:
            row = await db.execute(_sel(AppSetting).where(AppSetting.key == "notifications"))
            rec = row.scalar_one_or_none()
            if not rec or not isinstance(rec.value, dict):
                return
            types = rec.value.get("types", [])

        for cfg in types:
            if cfg.get("delivery_mode") != "summary":
                continue
            type_key = cfg["key"]
            if not cfg.get("active", True):
                continue

            interval_mins = int(cfg.get("summary_interval_minutes") or 15)
            pending_key = f"notif:pending:{type_key}"
            last_flush_key = f"notif:last_flush:{type_key}"

            count = await redis_client.llen(pending_key)
            if count == 0:
                continue

            # Check interval since last flush
            last_ts = await redis_client.get(last_flush_key)
            if last_ts:
                last_str = last_ts if isinstance(last_ts, str) else last_ts.decode()
                elapsed_mins = (
                    datetime.now(timezone.utc) - datetime.fromisoformat(last_str)
                ).total_seconds() / 60
                if elapsed_mins < interval_mins:
                    continue

            # Drain the pending list
            labels_raw = await redis_client.lrange(pending_key, 0, -1)
            await redis_client.delete(pending_key)
            await redis_client.set(
                last_flush_key,
                datetime.now(timezone.utc).isoformat(),
                ex=7 * 24 * 3600,
            )

            labels = [lbl if isinstance(lbl, str) else lbl.decode() for lbl in labels_raw]

            if len(labels) == 1:
                msg = f"Report {labels[0]} was automatically flagged Red and requires review."
            elif len(labels) <= 5:
                msg = (
                    f"{len(labels)} reports flagged Red: {', '.join(labels)}. "
                    "Review queue updated."
                )
            else:
                preview = ", ".join(labels[:5])
                msg = (
                    f"{len(labels)} reports flagged Red in the last {interval_mins} min — "
                    f"{preview} and {len(labels) - 5} more."
                )

            subscribers: list[str] = cfg.get("subscribers") or []
            await _insert_notification(type_key, msg, subscribers)
            log.info("flush_pending_batches: flushed %d item(s) for '%s'", len(labels), type_key)

    except Exception:
        log.exception("flush_pending_batches: error during batch flush")
