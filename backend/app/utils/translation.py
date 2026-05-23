import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)


async def _translate_via_google(text: str, target_lang: str, source_lang: str = "en") -> str:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://translation.googleapis.com/language/translate/v2",
            params={"key": settings.GOOGLE_TRANSLATE_API_KEY},
            json={"q": text, "source": source_lang, "target": target_lang, "format": "text"},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"]["translations"][0]["translatedText"]


async def _translate_via_libretranslate(text: str, target_lang: str, source_lang: str = "en") -> str:
    translate_url = settings.LIBRETRANSLATE_URL.rstrip("/") + "/translate"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            translate_url,
            json={"q": text, "source": source_lang, "target": target_lang, "format": "text"},
        )
        resp.raise_for_status()
        data = resp.json()
        translated_text = data.get("translatedText", "")
        if not translated_text:
            raise ValueError("Empty translatedText in LibreTranslate response")
        return translated_text


async def translate_text(text: str, target_lang: str, source_lang: str = "en") -> tuple[str, str]:
    """Translate text, returning (translated_text, service_used).

    Uses Google Translate when a key is configured and TRANSLATION_PRIMARY is
    "google", falling back to LibreTranslate on any error. Falls back to
    LibreTranslate directly when no Google key is set.
    """
    if settings.GOOGLE_TRANSLATE_API_KEY and settings.TRANSLATION_PRIMARY == "google":
        try:
            result = await _translate_via_google(text, target_lang, source_lang)
            return result, "google"
        except Exception as exc:
            log.warning(
                "Google Translate failed for [%s], falling back to LibreTranslate: %s",
                target_lang,
                exc,
            )
        result = await _translate_via_libretranslate(text, target_lang, source_lang)
        return result, "libretranslate"

    result = await _translate_via_libretranslate(text, target_lang, source_lang)
    return result, "libretranslate"
