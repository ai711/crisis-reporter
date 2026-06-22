import logging
import re

import httpx

from app.config import settings

log = logging.getLogger(__name__)

# All ISO 639-1 codes that LibreTranslate supports (v1.6+).
# This map serves two purposes:
#   1. Early-reject unsupported codes before making a network call.
#   2. Triggers the ValueError→Google fallback path in translate_text when
#      LibreTranslate is primary but the language is unsupported.
# When adding a new language via the dashboard, verify it appears here.
# Note: LibreTranslate uses non-standard codes for a few languages:
#   Chinese Traditional → "zt"  (not "zh-TW")
#   Norwegian Bokmål   → "nb"  (not "no")
LIBRETRANSLATE_LANG_MAP: dict[str, str] = {
    "af": "af",  # Afrikaans
    "sq": "sq",  # Albanian
    "am": "am",  # Amharic
    "ar": "ar",  # Arabic
    "az": "az",  # Azerbaijani
    "eu": "eu",  # Basque
    "bn": "bn",  # Bengali
    "bg": "bg",  # Bulgarian
    "ca": "ca",  # Catalan
    "zh": "zh",  # Chinese (Simplified)
    "zt": "zt",  # Chinese (Traditional) — LibreTranslate code, not zh-TW
    "cs": "cs",  # Czech
    "da": "da",  # Danish
    "nl": "nl",  # Dutch
    "en": "en",  # English
    "eo": "eo",  # Esperanto
    "et": "et",  # Estonian
    "fi": "fi",  # Finnish
    "fr": "fr",  # French
    "gl": "gl",  # Galician
    "de": "de",  # German
    "el": "el",  # Greek
    "he": "he",  # Hebrew
    "hi": "hi",  # Hindi
    "hu": "hu",  # Hungarian
    "id": "id",  # Indonesian
    "ga": "ga",  # Irish
    "it": "it",  # Italian
    "ja": "ja",  # Japanese
    "ko": "ko",  # Korean
    "lv": "lv",  # Latvian
    "lt": "lt",  # Lithuanian
    "ms": "ms",  # Malay
    "nb": "nb",  # Norwegian Bokmål — LibreTranslate code, not "no"
    "fa": "fa",  # Persian / Farsi
    "pl": "pl",  # Polish
    "pt": "pt",  # Portuguese
    "ro": "ro",  # Romanian
    "ru": "ru",  # Russian
    "sk": "sk",  # Slovak
    "sl": "sl",  # Slovenian
    "es": "es",  # Spanish
    "sv": "sv",  # Swedish
    "tl": "tl",  # Tagalog / Filipino
    "th": "th",  # Thai
    "tr": "tr",  # Turkish
    "uk": "uk",  # Ukrainian
    "ur": "ur",  # Urdu
    "vi": "vi",  # Vietnamese
    "cy": "cy",  # Welsh
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
            f"Language '{target_lang}' is not in LIBRETRANSLATE_LANG_MAP — "
            f"add it if LibreTranslate supports it, or use Google Translate. "
            f"Known codes: {', '.join(sorted(LIBRETRANSLATE_LANG_MAP))}"
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


_VAR_PATTERN = re.compile(r'\{\{[^}]+\}\}')


def _protect_vars(text: str) -> tuple[str, list[str]]:
    """Replace {{var}} placeholders with numeric tokens like [0], [1].
    MT systems won't translate numeric tokens, preventing variable name corruption.
    Returns (modified_text, ordered_list_of_originals).
    """
    originals: list[str] = []
    def _sub(m: re.Match) -> str:
        idx = len(originals)
        originals.append(m.group())
        return f"[{idx}]"
    return _VAR_PATTERN.sub(_sub, text), originals


def _restore_vars(text: str, originals: list[str]) -> str:
    for idx, original in enumerate(originals):
        text = text.replace(f"[{idx}]", original)
    return text


async def translate_text(text: str, target_lang: str, source_lang: str = "en") -> tuple[str, str]:
    """Translate text, returning (translated_text, service_used).

    Uses Google Translate when a key is configured and TRANSLATION_PRIMARY is
    "google", falling back to LibreTranslate on any error. Falls back to
    LibreTranslate directly when no Google key is set.
    """
    # Protect {{variable}} interpolation placeholders so MT systems never translate
    # the variable names inside them (e.g. {{number}} must not become {{número}}).
    protected, originals = _protect_vars(text)

    log.info("translate_text called: primary=%s, has_google_key=%s", settings.TRANSLATION_PRIMARY, bool(settings.GOOGLE_TRANSLATE_API_KEY))
    if settings.GOOGLE_TRANSLATE_API_KEY and settings.TRANSLATION_PRIMARY == "google":
        try:
            result = await _translate_via_google(protected, target_lang, source_lang)
            return _restore_vars(result, originals), "google"
        except Exception as exc:
            log.warning(
                "Google Translate failed for [%s], falling back to LibreTranslate: %s",
                target_lang,
                exc,
            )
        # Google failed — try LibreTranslate as fallback. If LibreTranslate also
        # fails (e.g. language not in map, or network error), propagate the error
        # so the caller can log it and mark the translation as failed.
        try:
            result = await _translate_via_libretranslate(protected, target_lang, source_lang)
            return _restore_vars(result, originals), "libretranslate"
        except Exception as lt_exc:
            log.warning(
                "LibreTranslate fallback also failed for [%s]: %s",
                target_lang,
                lt_exc,
            )
            raise lt_exc

    # LibreTranslate is primary. Fall back to Google when the language is unsupported.
    try:
        result = await _translate_via_libretranslate(protected, target_lang, source_lang)
        return _restore_vars(result, originals), "libretranslate"
    except ValueError as exc:
        if settings.GOOGLE_TRANSLATE_API_KEY:
            log.warning(
                "LibreTranslate does not support [%s], falling back to Google: %s",
                target_lang,
                exc,
            )
            result = await _translate_via_google(protected, target_lang, source_lang)
            return _restore_vars(result, originals), "google"
        raise
