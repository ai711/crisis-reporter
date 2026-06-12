import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)

# Supported language codes for LibreTranslate.
# If a target language is not in this map the request is rejected early
# rather than sending an invalid code to the API.
LIBRETRANSLATE_LANG_MAP: dict[str, str] = {
    "ar": "ar",  # Arabic
    "zh": "zh",  # Chinese (Simplified)
    "en": "en",  # English
    "fr": "fr",  # French
    "ru": "ru",  # Russian
    "es": "es",  # Spanish
    # Add further ISO 639-1 codes here as LibreTranslate support is confirmed
}


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
    # Warn if the public rate-limited instance is in use
    url_base = settings.LIBRETRANSLATE_URL.strip()
    if not url_base or "libretranslate.com" in url_base:
        log.warning(
            "LIBRETRANSLATE_URL points to public instance (%s) — rate limits apply. "
            "Consider self-hosting or using the Hugging Face Spaces instance.",
            url_base or "(empty)",
        )

    # Reject unsupported language codes early to avoid sending a bad request
    mapped_lang = LIBRETRANSLATE_LANG_MAP.get(target_lang)
    if mapped_lang is None:
        raise ValueError(
            f"Language '{target_lang}' is not supported by the LibreTranslate fallback. "
            f"Supported codes: {', '.join(sorted(LIBRETRANSLATE_LANG_MAP))}"
        )

    translate_url = url_base.rstrip("/") + "/translate"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            translate_url,
            json={"q": text, "source": source_lang, "target": mapped_lang, "format": "text"},
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
    log.info("translate_text called: primary=%s, has_google_key=%s", settings.TRANSLATION_PRIMARY, bool(settings.GOOGLE_TRANSLATE_API_KEY))
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

    # LibreTranslate is primary. Fall back to Google when the language is unsupported.
    try:
        result = await _translate_via_libretranslate(text, target_lang, source_lang)
        return result, "libretranslate"
    except ValueError as exc:
        if settings.GOOGLE_TRANSLATE_API_KEY:
            log.warning(
                "LibreTranslate does not support [%s], falling back to Google: %s",
                target_lang,
                exc,
            )
            result = await _translate_via_google(text, target_lang, source_lang)
            return result, "google"
        raise
