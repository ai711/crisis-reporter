import json
from datetime import datetime, timezone
from app.config import settings

LOCK_PREFIX = "softlock"


async def acquire_soft_lock(
    redis, item_type: str, item_id: str, reviewer_name: str, reviewer_id: str
) -> bool:
    """
    Attempt to acquire a soft lock on an item.
    item_type: "report" | "property" | "stuck_report" | "auto_block"
    Returns True if lock acquired, False if already locked by someone else.
    """
    key = f"{LOCK_PREFIX}:{item_type}:{item_id}"
    existing = await redis.get(key)
    if existing:
        data = json.loads(existing)
        if data["reviewer_id"] != reviewer_id:
            return False
    payload = json.dumps({
        "reviewer_name": reviewer_name,
        "reviewer_id": reviewer_id,
        "locked_at": datetime.now(timezone.utc).isoformat(),
    })
    ttl_seconds = settings.REVIEW_SOFT_LOCK_MINUTES * 60
    await redis.setex(key, ttl_seconds, payload)
    return True


async def get_soft_lock(redis, item_type: str, item_id: str) -> dict | None:
    """Returns current lock data or None if not locked."""
    key = f"{LOCK_PREFIX}:{item_type}:{item_id}"
    existing = await redis.get(key)
    if not existing:
        return None
    return json.loads(existing)


async def release_soft_lock(
    redis, item_type: str, item_id: str, reviewer_id: str
) -> bool:
    """Release a lock. Only the lock holder can release it."""
    key = f"{LOCK_PREFIX}:{item_type}:{item_id}"
    existing = await redis.get(key)
    if not existing:
        return True
    data = json.loads(existing)
    if data["reviewer_id"] != reviewer_id:
        return False
    await redis.delete(key)
    return True
