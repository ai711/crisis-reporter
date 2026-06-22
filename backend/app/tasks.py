"""
tasks.py

Background task implementations for auto-translation workflows.
Called via asyncio.create_task() so the triggering endpoint returns immediately.

auto_translate_question_package — translates all question strings in a draft
    package version that don't yet have an approved translation.

auto_translate_content — translates content strings (TC, onboarding, etc.)
    that don't yet have an approved translation.

Both use translate_text() from app.utils.translation so that TRANSLATION_PRIMARY
and GOOGLE_TRANSLATE_API_KEY are respected — Google Translate is used when
configured, with LibreTranslate as fallback.

Strings that fail translation are marked status="failed" in the DB so they
don't silently retry on every subsequent run. The user-triggered
POST /api/translations/auto-translate endpoint picks up both "missing" and
"failed" rows, making the Translate button act as a retry as well.
"""

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.language_package import Language, StringKey, Translation
from app.utils.translation import translate_text

log = logging.getLogger(__name__)

# Fallback used only when the DB cannot be reached
_FALLBACK_LANGUAGES = ["ar", "zh", "fr", "ru", "es"]


async def _active_target_languages(db) -> list[str]:
    """Return all active non-English language codes from the DB."""
    result = await db.execute(
        select(Language.code).where(Language.status == "active", Language.code != "en")
    )
    codes = [row[0] for row in result.all()]
    return codes if codes else _FALLBACK_LANGUAGES


async def auto_translate_question_package(package_version: str) -> None:
    """
    For every active non-English language, auto-translate all string keys in
    the given package version that don't yet have an approved translation.
    Stores results as Draft translations in the translations table.
    Failed strings are marked status="failed" so they don't loop forever.
    """
    log.info("auto_translate_question_package: starting for version %s", package_version)
    async with AsyncSessionLocal() as db:
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

        for lang_code in target_languages:
            # Skip keys that already have a usable translation.
            # "failed" is NOT treated as done — it must be retried.
            existing_result = await db.execute(
                select(Translation.string_key_id).where(
                    Translation.language_code == lang_code,
                    Translation.status.not_in(["missing", "failed"]),
                )
            )
            already_translated = {row[0] for row in existing_result.all()}

            keys_to_translate = [sk for sk in keys if sk.id not in already_translated]
            if not keys_to_translate:
                continue

            # Preload existing missing/failed rows so we UPDATE rather than INSERT.
            existing_rows_result = await db.execute(
                select(Translation).where(
                    Translation.string_key_id.in_([sk.id for sk in keys_to_translate]),
                    Translation.language_code == lang_code,
                    Translation.status.in_(["missing", "failed"]),
                )
            )
            existing_by_key = {
                r.string_key_id: r
                for r in existing_rows_result.scalars().all()
            }

            for sk in keys_to_translate:
                existing_row = existing_by_key.get(sk.id)
                try:
                    translated_text, service_used = await translate_text(sk.english_text, lang_code)
                    if existing_row is not None:
                        existing_row.translated_text = translated_text
                        existing_row.status = "draft"
                        existing_row.translated_by = service_used
                    else:
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text=translated_text,
                            status="draft",
                            translated_by=service_used,
                        ))
                    translated_total += 1
                except Exception as exc:
                    log.warning(
                        "auto_translate_question_package: failed key=%s lang=%s: %s",
                        sk.key, lang_code, exc,
                    )
                    if existing_row is not None:
                        existing_row.status = "failed"
                    else:
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text="",
                            status="failed",
                            translated_by="",
                        ))

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
    Failed strings are marked status="failed" so they don't loop forever.

    content_type may be one of the named types below, or the special value
    "all" which translates every active StringKey regardless of category.
    """
    log.info("auto_translate_content: starting for content_type=%s", content_type)

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

        for lang_code in target_languages:
            # Skip keys that already have a usable translation.
            # "failed" is NOT treated as done — it must be retried.
            existing_result = await db.execute(
                select(Translation.string_key_id).where(
                    Translation.language_code == lang_code,
                    Translation.status.not_in(["missing", "failed"]),
                )
            )
            already_translated = {row[0] for row in existing_result.all()}

            keys_to_translate = [sk for sk in keys if sk.id not in already_translated]
            if not keys_to_translate:
                continue

            # Preload existing missing/failed rows so we UPDATE rather than INSERT.
            existing_rows_result = await db.execute(
                select(Translation).where(
                    Translation.string_key_id.in_([sk.id for sk in keys_to_translate]),
                    Translation.language_code == lang_code,
                    Translation.status.in_(["missing", "failed"]),
                )
            )
            existing_by_key = {
                r.string_key_id: r
                for r in existing_rows_result.scalars().all()
            }

            for sk in keys_to_translate:
                existing_row = existing_by_key.get(sk.id)
                try:
                    translated_text, service_used = await translate_text(sk.english_text, lang_code)
                    if existing_row is not None:
                        existing_row.translated_text = translated_text
                        existing_row.status = "published"
                        existing_row.translated_by = service_used
                    else:
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text=translated_text,
                            status="published",
                            translated_by=service_used,
                        ))
                    translated_total += 1
                    translated_langs.add(lang_code)
                except Exception as exc:
                    log.warning(
                        "auto_translate_content: failed key=%s lang=%s: %s",
                        sk.key, lang_code, exc,
                    )
                    if existing_row is not None:
                        existing_row.status = "failed"
                    else:
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text="",
                            status="failed",
                            translated_by="",
                        ))

        await db.commit()

    # Bump language package versions so clients detect and re-download the
    # updated translations.
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
