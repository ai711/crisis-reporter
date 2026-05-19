import json
from datetime import datetime, timezone
from app.config import settings

LOCK_PREFIX = "translation_lock"


async def acquire_translation_lock(
    redis, lang_code: str, editor_name: str, editor_id: str
) -> bool:
    key = f"{LOCK_PREFIX}:{lang_code}"
    existing = await redis.get(key)
    if existing:
        data = json.loads(existing)
        if data["editor_id"] != editor_id:
            return False
    payload = json.dumps({
        "editor_name": editor_name,
        "editor_id": editor_id,
        "locked_at": datetime.now(timezone.utc).isoformat(),
    })
    ttl_seconds = settings.TRANSLATION_LOCK_MINUTES * 60
    await redis.setex(key, ttl_seconds, payload)
    return True


async def get_translation_lock(redis, lang_code: str) -> dict | None:
    key = f"{LOCK_PREFIX}:{lang_code}"
    existing = await redis.get(key)
    if not existing:
        return None
    return json.loads(existing)


async def release_translation_lock(
    redis, lang_code: str, editor_id: str
) -> bool:
    key = f"{LOCK_PREFIX}:{lang_code}"
    existing = await redis.get(key)
    if not existing:
        return True
    data = json.loads(existing)
    if data["editor_id"] != editor_id:
        return False
    await redis.delete(key)
    return True


async def release_translation_lock_admin(redis, lang_code: str) -> bool:
    key = f"{LOCK_PREFIX}:{lang_code}"
    await redis.delete(key)
    return True


async def refresh_translation_lock_ttl(redis, lang_code: str) -> None:
    """Refresh TTL on an existing lock without changing payload."""
    key = f"{LOCK_PREFIX}:{lang_code}"
    ttl_seconds = settings.TRANSLATION_LOCK_MINUTES * 60
    await redis.expire(key, ttl_seconds)
