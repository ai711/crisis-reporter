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

import logging

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.language_package import StringKey, Translation

log = logging.getLogger(__name__)

# Non-English UN languages to auto-translate into
_TARGET_LANGUAGES = ["ar", "zh", "fr", "ru", "es"]


async def _translate_text(client: httpx.AsyncClient, text: str, target: str) -> str:
    """Call LibreTranslate and return translated text, or raise on failure."""
    url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
    resp = await client.post(
        url,
        json={"q": text, "source": "en", "target": target, "format": "text"},
    )
    resp.raise_for_status()
    result = resp.json().get("translatedText", "")
    if not result:
        raise ValueError("Empty translatedText in LibreTranslate response")
    return result


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

        translate_url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
        translated_total = 0

        async with httpx.AsyncClient(timeout=30.0) as client:
            for lang_code in _TARGET_LANGUAGES:
                # Find keys that already have any translation for this language
                existing_result = await db.execute(
                    select(Translation.string_key_id).where(
                        Translation.language_code == lang_code
                    )
                )
                already_translated = {row[0] for row in existing_result.all()}

                for sk in keys:
                    if sk.id in already_translated:
                        continue
                    try:
                        resp = await client.post(
                            translate_url,
                            json={
                                "q": sk.english_text,
                                "source": "en",
                                "target": lang_code,
                                "format": "text",
                            },
                        )
                        resp.raise_for_status()
                        translated_text = resp.json().get("translatedText", "")
                        if not translated_text:
                            continue
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text=translated_text,
                            status="draft",
                            translated_by="auto",
                        ))
                        translated_total += 1
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


async def auto_translate_content(content_type: str) -> None:
    """
    For every active non-English language, auto-translate all string keys in
    the given content type that don't yet have an approved translation.
    Stores results as Draft translations in the translations table.
    """
    log.info("auto_translate_content: starting for content_type=%s", content_type)

    # Map content types to string key categories
    category_map = {
        "tc": "tc",
        "onboarding": "onboarding",
        "reporting-guidelines": "content",
        "first-aid": "content",
        "safety-tips": "safety",
        "error_messages": "error",
        "system_messages": "content",
    }
    category = category_map.get(content_type)
    if not category:
        log.warning("auto_translate_content: unknown content_type=%s", content_type)
        return

    async with AsyncSessionLocal() as db:
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

        translate_url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
        translated_total = 0

        async with httpx.AsyncClient(timeout=30.0) as client:
            for lang_code in _TARGET_LANGUAGES:
                existing_result = await db.execute(
                    select(Translation.string_key_id).where(
                        Translation.language_code == lang_code
                    )
                )
                already_translated = {row[0] for row in existing_result.all()}

                for sk in keys:
                    if sk.id in already_translated:
                        continue
                    try:
                        resp = await client.post(
                            translate_url,
                            json={
                                "q": sk.english_text,
                                "source": "en",
                                "target": lang_code,
                                "format": "text",
                            },
                        )
                        resp.raise_for_status()
                        translated_text = resp.json().get("translatedText", "")
                        if not translated_text:
                            continue
                        db.add(Translation(
                            string_key_id=sk.id,
                            language_code=lang_code,
                            translated_text=translated_text,
                            status="draft",
                            translated_by="auto",
                        ))
                        translated_total += 1
                    except Exception as exc:
                        log.warning(
                            "auto_translate_content: failed key=%s lang=%s: %s",
                            sk.key, lang_code, exc,
                        )

        if translated_total > 0:
            await db.commit()

    log.info(
        "auto_translate_content: done for content_type=%s — %d strings translated",
        content_type, translated_total,
    )
