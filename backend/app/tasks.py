"""
tasks.py

Background task implementations for auto-translation workflows.
Called via asyncio.create_task() so the triggering endpoint returns immediately.

auto_translate_question_package — translates all question strings in a draft
    package version that don't yet have an approved translation.

auto_translate_content — translates content strings (TC, onboarding, etc.)
    that don't yet have an approved translation.

Both follow the same LibreTranslate pattern used by
POST /api/translations/auto-translate in language_packages.py.
"""

import asyncio
import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.language_package import Language, StringKey, Translation

log = logging.getLogger(__name__)

# Fallback used only when the DB cannot be reached
_FALLBACK_LANGUAGES = ["ar", "zh", "fr", "ru", "es"]

# Delay between successive translation requests to stay under the public
# LibreTranslate free-tier rate limit (~1 req/sec). Ignored when using a
# self-hosted or paid instance, but harmless there.
_INTER_REQUEST_DELAY = 0.6  # seconds

# How long to back off when a 429 is received before retrying once.
_RATE_LIMIT_BACKOFF = 65  # seconds


async def _active_target_languages(db) -> list[str]:
    """Return all active non-English language codes from the DB."""
    result = await db.execute(
        select(Language.code).where(Language.status == "active", Language.code != "en")
    )
    codes = [row[0] for row in result.all()]
    return codes if codes else _FALLBACK_LANGUAGES


async def _translate_text(client: httpx.AsyncClient, text: str, target: str) -> str:
    """Call LibreTranslate and return translated text.

    Retries once after backing off if the server returns 429.
    Raises on any other failure.
    """
    url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
    payload = {"q": text, "source": "en", "target": target, "format": "text"}
    for attempt in range(2):
        resp = await client.post(url, json=payload)
        if resp.status_code == 429 and attempt == 0:
            log.warning(
                "_translate_text: rate-limited for lang=%s — backing off %ds before retry",
                target, _RATE_LIMIT_BACKOFF,
            )
            await asyncio.sleep(_RATE_LIMIT_BACKOFF)
            continue
        resp.raise_for_status()
        result = resp.json().get("translatedText", "")
        if not result:
            raise ValueError("Empty translatedText in LibreTranslate response")
        return result
    raise RuntimeError(f"Translation failed for lang={target} after rate-limit retry")


async def auto_translate_question_package(package_version: str) -> None:
    """
    For every active non-English language, auto-translate all string keys in
    the given package version that don't yet have an approved translation.
    Stores results as Draft translations in the translations table.
    """
    log.info("auto_translate_question_package: starting for version %s", package_version)
    async with AsyncSessionLocal() as db:
        # Get all active string keys (question category)
        keys_result = await db.execute(
            select(StringKey).where(
                StringKey.is_active == True,
                StringKey.category.in_(["question", "answer"]),
            )
        )
        keys = keys_result.scalars().all()

        if not keys:
            log.info("auto_translate_question_package: no active question keys found")
            return

        translated_total = 0
        target_languages = await _active_target_languages(db)

        async with httpx.AsyncClient(timeout=30.0) as client:
            for lang_code in target_languages:
                # Skip keys that already have a usable (non-missing) translation.
                # status='missing' means the English source changed — must re-translate.
                existing_result = await db.execute(
                    select(Translation.string_key_id).where(
                        Translation.language_code == lang_code,
                        Translation.status != "missing",
                    )
                )
                already_translated = {row[0] for row in existing_result.all()}

                keys_to_translate = [sk for sk in keys if sk.id not in already_translated]
                if not keys_to_translate:
                    continue

                # Preload existing 'missing' rows so we UPDATE rather than INSERT.
                missing_rows_result = await db.execute(
                    select(Translation).where(
                        Translation.string_key_id.in_([sk.id for sk in keys_to_translate]),
                        Translation.language_code == lang_code,
                        Translation.status == "missing",
                    )
                )
                missing_by_key = {
                    r.string_key_id: r
                    for r in missing_rows_result.scalars().all()
                }

                for sk in keys_to_translate:
                    try:
                        translated_text = await _translate_text(client, sk.english_text, lang_code)
                        existing_row = missing_by_key.get(sk.id)
                        if existing_row is not None:
                            existing_row.translated_text = translated_text
                            existing_row.status = "draft"
                            existing_row.translated_by = "auto"
                        else:
                            db.add(Translation(
                                string_key_id=sk.id,
                                language_code=lang_code,
                                translated_text=translated_text,
                                status="draft",
                                translated_by="auto",
                            ))
                        translated_total += 1
                        await asyncio.sleep(_INTER_REQUEST_DELAY)
                    except Exception as exc:
                        log.warning(
                            "auto_translate_question_package: failed key=%s lang=%s: %s",
                            sk.key, lang_code, exc,
                        )

        if translated_total > 0:
            await db.commit()

    log.info(
        "auto_translate_question_package: done for version %s — %d strings translated",
        package_version, translated_total,
    )
    if translated_total > 0:
        try:
            from app.services.notification_service import fire_notification
            await fire_notification(
                "translation_auto_translation_complete",
                f"Auto-translation complete for question package '{package_version}' — "
                f"{translated_total} string(s) translated into {len(target_languages)} languages.",
            )
        except Exception:
            log.warning("auto_translate_question_package: notification fire failed")


async def auto_translate_content(content_type: str) -> None:
    """
    For every active non-English language, auto-translate all string keys in
    the given content type that don't yet have an approved translation.
    Stores results as Draft translations in the translations table.

    content_type may be one of the named types below, or the special value
    "all" which translates every active StringKey regardless of category.
    "all" is used at startup to catch any newly-seeded UI keys.
    """
    log.info("auto_translate_content: starting for content_type=%s", content_type)

    # Map content types to string key categories.
    # "all" is a special sentinel — no category filter applied.
    category_map = {
        "tc": "tc",
        "onboarding": "onboarding",
        "reporting-guidelines": "content",
        "first-aid": "content",
        "safety-tips": "safety",
        "error_messages": "error",
        "system_messages": "content",
    }
    translate_all = (content_type == "all")
    category = category_map.get(content_type) if not translate_all else None
    if not translate_all and category is None:
        log.warning("auto_translate_content: unknown content_type=%s", content_type)
        return

    async with AsyncSessionLocal() as db:
        if translate_all:
            keys_result = await db.execute(
                select(StringKey).where(StringKey.is_active == True)
            )
        else:
            keys_result = await db.execute(
                select(StringKey).where(
                    StringKey.is_active == True,
                    StringKey.category == category,
                )
            )
        keys = keys_result.scalars().all()

        if not keys:
            log.info("auto_translate_content: no active keys for category=%s", category)
            return

        translated_total = 0
        translated_langs: set[str] = set()
        target_languages = await _active_target_languages(db)

        async with httpx.AsyncClient(timeout=30.0) as client:
            for lang_code in target_languages:
                # Skip keys that already have a usable (non-missing) translation.
                # status='missing' means the English source changed — must re-translate.
                existing_result = await db.execute(
                    select(Translation.string_key_id).where(
                        Translation.language_code == lang_code,
                        Translation.status != "missing",
                    )
                )
                already_translated = {row[0] for row in existing_result.all()}

                keys_to_translate = [sk for sk in keys if sk.id not in already_translated]
                if not keys_to_translate:
                    continue

                # Preload existing 'missing' rows so we UPDATE rather than INSERT.
                missing_rows_result = await db.execute(
                    select(Translation).where(
                        Translation.string_key_id.in_([sk.id for sk in keys_to_translate]),
                        Translation.language_code == lang_code,
                        Translation.status == "missing",
                    )
                )
                missing_by_key = {
                    r.string_key_id: r
                    for r in missing_rows_result.scalars().all()
                }

                for sk in keys_to_translate:
                    try:
                        translated_text = await _translate_text(client, sk.english_text, lang_code)
                        existing_row = missing_by_key.get(sk.id)
                        if existing_row is not None:
                            existing_row.translated_text = translated_text
                            existing_row.status = "published"
                            existing_row.translated_by = "auto"
                        else:
                            db.add(Translation(
                                string_key_id=sk.id,
                                language_code=lang_code,
                                translated_text=translated_text,
                                status="published",
                                translated_by="auto",
                            ))
                        translated_total += 1
                        translated_langs.add(lang_code)
                        await asyncio.sleep(_INTER_REQUEST_DELAY)
                    except Exception as exc:
                        log.warning(
                            "auto_translate_content: failed key=%s lang=%s: %s",
                            sk.key, lang_code, exc,
                        )

        if translated_total > 0:
            await db.commit()

    # Bump language package versions so clients detect and re-download the
    # updated translations. Without this bump, clients whose cached version
    # matches the server version will never re-fetch and will keep showing
    # English fallbacks for the newly translated keys.
    if translated_langs:
        try:
            from app.models.language_package import LanguagePackage
            async with AsyncSessionLocal() as pkg_db:
                bump_result = await pkg_db.execute(
                    select(LanguagePackage).where(
                        LanguagePackage.status == "published",
                        LanguagePackage.language_code.in_(list(translated_langs)),
                    )
                )
                bumped = 0
                for pkg in bump_result.scalars().all():
                    try:
                        parts = pkg.version.split(".")
                        patch = int(parts[-1]) + 1 if parts[-1].isdigit() else 1
                        pkg.version = ".".join(parts[:-1] + [str(patch)])
                    except Exception:
                        pkg.version = pkg.version + ".1"
                    bumped += 1
                if bumped:
                    await pkg_db.commit()
                    log.info(
                        "auto_translate_content: bumped %d package version(s) for langs: %s",
                        bumped, sorted(translated_langs),
                    )
        except Exception as exc:
            log.warning("auto_translate_content: failed to bump package versions: %s", exc)

    log.info(
        "auto_translate_content: done for content_type=%s — %d strings translated",
        content_type, translated_total,
    )
    if translated_total > 0:
        try:
            from app.services.notification_service import fire_notification
            await fire_notification(
                "translation_auto_translation_complete",
                f"Auto-translation complete for '{content_type}' — "
                f"{translated_total} string(s) translated into {len(target_languages)} languages.",
            )
        except Exception:
            log.warning("auto_translate_content: notification fire failed")


async def remove_expired_deprecated_languages() -> None:
    """Hard-remove any language where removal_scheduled_at <= now() and status == 'deprecated'."""
    log.info("remove_expired_deprecated_languages: checking for expired deprecations")
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Language).where(
                Language.status == "deprecated",
                Language.removal_scheduled_at <= now,
            )
        )
        expired = result.scalars().all()
        if not expired:
            log.info("remove_expired_deprecated_languages: nothing to remove")
            return
        from app.services.translation_audit_service import write_translation_audit
        for lang in expired:
            await write_translation_audit(
                db,
                event_type="language_removed",
                lang_code=lang.code,
                details={"name": lang.name, "removed_by": "system_scheduler"},
                performed_by="system",
            )
            await db.delete(lang)
        await db.commit()
        log.info(
            "remove_expired_deprecated_languages: removed %d language(s): %s",
            len(expired),
            [l.code for l in expired],
        )
