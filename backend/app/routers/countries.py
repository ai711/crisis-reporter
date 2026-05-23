from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.database import get_db, AsyncSessionLocal
from app.models.country import Country
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import require_admin

router = APIRouter(prefix="/api/countries", tags=["Countries"])


# ── Official language name → ISO 639-1 code normalisation map ─────────────────

OFFICIAL_LANG_NAME_TO_CODE: dict[str, str] = {
    # A
    "afar": "aa", "abkhazian": "ab", "avestan": "ae", "afrikaans": "af",
    "akan": "ak", "amharic": "am", "aragonese": "an", "arabic": "ar",
    "assamese": "as", "avaric": "av", "aymara": "ay", "azerbaijani": "az",
    # B
    "bashkir": "ba", "belarusian": "be", "bulgarian": "bg", "bislama": "bi",
    "bambara": "bm", "bengali": "bn", "tibetan": "bo", "breton": "br",
    "bosnian": "bs",
    # C
    "catalan": "ca", "chechen": "ce", "chamorro": "ch", "corsican": "co",
    "cree": "cr", "czech": "cs", "church slavic": "cu", "chuvash": "cv",
    "welsh": "cy",
    # D
    "danish": "da", "german": "de", "divehi": "dv", "dzongkha": "dz",
    # E
    "ewe": "ee", "greek": "el", "english": "en", "esperanto": "eo",
    "spanish": "es", "estonian": "et", "basque": "eu",
    # F
    "persian": "fa", "farsi": "fa", "dari": "fa", "fula": "ff",
    "finnish": "fi", "fijian": "fj", "faroese": "fo", "french": "fr",
    "western frisian": "fy",
    # G
    "irish": "ga", "scottish gaelic": "gd", "galician": "gl", "guarani": "gn",
    "gujarati": "gu", "manx": "gv",
    # H
    "hausa": "ha", "hebrew": "he", "hindi": "hi", "hiri motu": "ho",
    "croatian": "hr", "haitian creole": "ht", "hungarian": "hu",
    "armenian": "hy",
    # I
    "herero": "hz", "interlingua": "ia", "indonesian": "id", "igbo": "ig",
    "sichuan yi": "ii", "inupiaq": "ik", "ido": "io", "icelandic": "is",
    "italian": "it", "inuktitut": "iu",
    # J
    "japanese": "ja", "javanese": "jv",
    # K
    "georgian": "ka", "kongo": "kg", "kikuyu": "ki", "kwanyama": "kj",
    "kazakh": "kk", "kalaallisut": "kl", "khmer": "km", "kannada": "kn",
    "korean": "ko", "kanuri": "kr", "kashmiri": "ks", "kurdish": "ku",
    "komi": "kv", "cornish": "kw", "kyrgyz": "ky",
    # L
    "latin": "la", "luxembourgish": "lb", "ganda": "lg", "limburgish": "li",
    "lingala": "ln", "lao": "lo", "lithuanian": "lt", "luba-katanga": "lu",
    "latvian": "lv",
    # M
    "malagasy": "mg", "marshallese": "mh", "maori": "mi", "macedonian": "mk",
    "malayalam": "ml", "mongolian": "mn", "marathi": "mr", "malay": "ms",
    "maltese": "mt", "burmese": "my", "myanmar": "my",
    # N
    "nauru": "na", "norwegian bokmal": "nb", "north ndebele": "nd",
    "nepali": "ne", "ndonga": "ng", "dutch": "nl", "norwegian nynorsk": "nn",
    "norwegian": "no", "south ndebele": "nr", "navajo": "nv", "chichewa": "ny",
    # O
    "occitan": "oc", "ojibwe": "oj", "oromo": "om", "oriya": "or",
    "odia": "or", "ossetian": "os",
    # P
    "punjabi": "pa", "pali": "pi", "polish": "pl", "pashto": "ps",
    "portuguese": "pt",
    # Q
    "quechua": "qu",
    # R
    "romansh": "rm", "kirundi": "rn", "romanian": "ro", "russian": "ru",
    "kinyarwanda": "rw",
    # S
    "sanskrit": "sa", "sardinian": "sc", "sindhi": "sd", "northern sami": "se",
    "sango": "sg", "sinhala": "si", "slovak": "sk", "slovenian": "sl",
    "samoan": "sm", "shona": "sn", "somali": "so", "albanian": "sq",
    "serbian": "sr", "swati": "ss", "sotho": "st", "sundanese": "su",
    "swedish": "sv", "swahili": "sw",
    # T
    "tamil": "ta", "telugu": "te", "tajik": "tg", "thai": "th",
    "tigrinya": "ti", "turkmen": "tk", "tagalog": "tl", "tswana": "tn",
    "tonga": "to", "turkish": "tr", "tsonga": "ts", "tatar": "tt",
    "twi": "tw", "tahitian": "ty",
    # U
    "uyghur": "ug", "ukrainian": "uk", "urdu": "ur", "uzbek": "uz",
    # V
    "venda": "ve", "vietnamese": "vi", "volapuk": "vo",
    # W
    "walloon": "wa", "wolof": "wo",
    # X
    "xhosa": "xh",
    # Y
    "yiddish": "yi", "yoruba": "yo",
    # Z
    "zhuang": "za", "chinese": "zh", "mandarin": "zh",
    "simplified chinese": "zh", "traditional chinese": "zh",
    "zulu": "zu",
    # Additional
    "filipino": "tl", "dhivehi": "dv", "sesotho": "st", "montenegrin": "sr",
    "seychellois creole": "fr", "nauruan": "na", "palauan": "pau",
    "tongan": "to", "tuvaluan": "tvl", "tetum": "tet",
}


# ── Schemas ───────────────────────────────────────────────────────────────────

class CountryCreate(BaseModel):
    code: str
    name: str
    official_language: str
    is_active: bool = False
    dialling_code: Optional[str] = None


class CountryPatch(BaseModel):
    is_active: Optional[bool] = None
    dialling_code: Optional[str] = None


class CountryResponse(BaseModel):
    code: str
    name: str
    official_language: str
    is_active: bool
    dialling_code: Optional[str] = None

    class Config:
        from_attributes = True


# ── Seed data — all 193 UN member states ─────────────────────────────────────
# Tuple: (ISO 3166-1 alpha-2 code, English name, primary official language, is_active)
# is_active=True for the 20 original crisis-affected countries.

SEED_COUNTRIES = [
    # Africa (54)
    ("DZ", "Algeria", "Arabic", False),
    ("AO", "Angola", "Portuguese", False),
    ("BJ", "Benin", "French", False),
    ("BW", "Botswana", "English", False),
    ("BF", "Burkina Faso", "French", False),
    ("BI", "Burundi", "French", False),
    ("CV", "Cabo Verde", "Portuguese", False),
    ("CM", "Cameroon", "French", False),
    ("CF", "Central African Republic", "French", False),
    ("TD", "Chad", "Arabic", False),
    ("KM", "Comoros", "Arabic", False),
    ("CG", "Congo", "French", False),
    ("CD", "DR Congo", "French", False),
    ("CI", "Côte d'Ivoire", "French", False),
    ("DJ", "Djibouti", "French", False),
    ("EG", "Egypt", "Arabic", False),
    ("GQ", "Equatorial Guinea", "Spanish", False),
    ("ER", "Eritrea", "Tigrinya", False),
    ("SZ", "Eswatini", "English", False),
    ("ET", "Ethiopia", "Amharic", True),
    ("GA", "Gabon", "French", False),
    ("GM", "Gambia", "English", False),
    ("GH", "Ghana", "English", False),
    ("GN", "Guinea", "French", False),
    ("GW", "Guinea-Bissau", "Portuguese", False),
    ("KE", "Kenya", "Swahili", True),
    ("LS", "Lesotho", "Sesotho", False),
    ("LR", "Liberia", "English", False),
    ("LY", "Libya", "Arabic", True),
    ("MG", "Madagascar", "Malagasy", False),
    ("MW", "Malawi", "English", False),
    ("ML", "Mali", "French", False),
    ("MR", "Mauritania", "Arabic", False),
    ("MU", "Mauritius", "English", False),
    ("MA", "Morocco", "Arabic", True),
    ("MZ", "Mozambique", "Portuguese", False),
    ("NA", "Namibia", "English", False),
    ("NE", "Niger", "French", False),
    ("NG", "Nigeria", "English", True),
    ("RW", "Rwanda", "Kinyarwanda", False),
    ("ST", "São Tomé and Príncipe", "Portuguese", False),
    ("SN", "Senegal", "French", False),
    ("SC", "Seychelles", "Seychellois Creole", False),
    ("SL", "Sierra Leone", "English", False),
    ("SO", "Somalia", "Somali", True),
    ("ZA", "South Africa", "Zulu", False),
    ("SS", "South Sudan", "English", False),
    ("SD", "Sudan", "Arabic", True),
    ("TZ", "Tanzania", "Swahili", False),
    ("TG", "Togo", "French", False),
    ("TN", "Tunisia", "Arabic", False),
    ("UG", "Uganda", "English", False),
    ("ZM", "Zambia", "English", False),
    ("ZW", "Zimbabwe", "English", False),

    # Americas (35)
    ("AG", "Antigua and Barbuda", "English", False),
    ("AR", "Argentina", "Spanish", False),
    ("BS", "Bahamas", "English", False),
    ("BB", "Barbados", "English", False),
    ("BZ", "Belize", "English", False),
    ("BO", "Bolivia", "Spanish", False),
    ("BR", "Brazil", "Portuguese", False),
    ("CA", "Canada", "English", False),
    ("CL", "Chile", "Spanish", False),
    ("CO", "Colombia", "Spanish", True),
    ("CR", "Costa Rica", "Spanish", False),
    ("CU", "Cuba", "Spanish", False),
    ("DM", "Dominica", "English", False),
    ("DO", "Dominican Republic", "Spanish", False),
    ("EC", "Ecuador", "Spanish", False),
    ("SV", "El Salvador", "Spanish", False),
    ("GD", "Grenada", "English", False),
    ("GT", "Guatemala", "Spanish", False),
    ("GY", "Guyana", "English", False),
    ("HT", "Haiti", "Haitian Creole", True),
    ("HN", "Honduras", "Spanish", False),
    ("JM", "Jamaica", "English", False),
    ("MX", "Mexico", "Spanish", False),
    ("NI", "Nicaragua", "Spanish", False),
    ("PA", "Panama", "Spanish", False),
    ("PY", "Paraguay", "Spanish", False),
    ("PE", "Peru", "Spanish", False),
    ("KN", "Saint Kitts and Nevis", "English", False),
    ("LC", "Saint Lucia", "English", False),
    ("VC", "Saint Vincent and the Grenadines", "English", False),
    ("SR", "Suriname", "Dutch", False),
    ("TT", "Trinidad and Tobago", "English", False),
    ("US", "United States", "English", False),
    ("UY", "Uruguay", "Spanish", False),
    ("VE", "Venezuela", "Spanish", False),

    # Asia (47)
    ("AF", "Afghanistan", "Dari", True),
    ("AM", "Armenia", "Armenian", False),
    ("AZ", "Azerbaijan", "Azerbaijani", False),
    ("BH", "Bahrain", "Arabic", False),
    ("BD", "Bangladesh", "Bengali", True),
    ("BT", "Bhutan", "Dzongkha", False),
    ("BN", "Brunei", "Malay", False),
    ("KH", "Cambodia", "Khmer", False),
    ("CN", "China", "Mandarin", False),
    ("CY", "Cyprus", "Greek", False),
    ("GE", "Georgia", "Georgian", False),
    ("IN", "India", "Hindi", False),
    ("ID", "Indonesia", "Indonesian", False),
    ("IR", "Iran", "Persian", False),
    ("IQ", "Iraq", "Arabic", True),
    ("IL", "Israel", "Hebrew", False),
    ("JP", "Japan", "Japanese", False),
    ("JO", "Jordan", "Arabic", False),
    ("KZ", "Kazakhstan", "Kazakh", False),
    ("KW", "Kuwait", "Arabic", False),
    ("KG", "Kyrgyzstan", "Kyrgyz", False),
    ("LA", "Laos", "Lao", False),
    ("LB", "Lebanon", "Arabic", False),
    ("MY", "Malaysia", "Malay", False),
    ("MV", "Maldives", "Dhivehi", False),
    ("MN", "Mongolia", "Mongolian", False),
    ("MM", "Myanmar", "Burmese", True),
    ("NP", "Nepal", "Nepali", True),
    ("KP", "North Korea", "Korean", False),
    ("OM", "Oman", "Arabic", False),
    ("PK", "Pakistan", "Urdu", True),
    ("PH", "Philippines", "Filipino", True),
    ("QA", "Qatar", "Arabic", False),
    ("SA", "Saudi Arabia", "Arabic", False),
    ("SG", "Singapore", "English", False),
    ("KR", "South Korea", "Korean", False),
    ("LK", "Sri Lanka", "Sinhala", False),
    ("SY", "Syria", "Arabic", True),
    ("TJ", "Tajikistan", "Tajik", False),
    ("TH", "Thailand", "Thai", False),
    ("TL", "Timor-Leste", "Tetum", False),
    ("TR", "Turkey", "Turkish", True),
    ("TM", "Turkmenistan", "Turkmen", False),
    ("AE", "United Arab Emirates", "Arabic", False),
    ("UZ", "Uzbekistan", "Uzbek", False),
    ("VN", "Vietnam", "Vietnamese", False),
    ("YE", "Yemen", "Arabic", True),

    # Europe (43)
    ("AL", "Albania", "Albanian", False),
    ("AD", "Andorra", "Catalan", False),
    ("AT", "Austria", "German", False),
    ("BY", "Belarus", "Belarusian", False),
    ("BE", "Belgium", "Dutch", False),
    ("BA", "Bosnia and Herzegovina", "Bosnian", False),
    ("BG", "Bulgaria", "Bulgarian", False),
    ("HR", "Croatia", "Croatian", False),
    ("CZ", "Czechia", "Czech", False),
    ("DK", "Denmark", "Danish", False),
    ("EE", "Estonia", "Estonian", False),
    ("FI", "Finland", "Finnish", False),
    ("FR", "France", "French", False),
    ("DE", "Germany", "German", False),
    ("GR", "Greece", "Greek", False),
    ("HU", "Hungary", "Hungarian", False),
    ("IS", "Iceland", "Icelandic", False),
    ("IE", "Ireland", "Irish", False),
    ("IT", "Italy", "Italian", False),
    ("LV", "Latvia", "Latvian", False),
    ("LI", "Liechtenstein", "German", False),
    ("LT", "Lithuania", "Lithuanian", False),
    ("LU", "Luxembourg", "Luxembourgish", False),
    ("MT", "Malta", "Maltese", False),
    ("MD", "Moldova", "Romanian", False),
    ("MC", "Monaco", "French", False),
    ("ME", "Montenegro", "Montenegrin", False),
    ("NL", "Netherlands", "Dutch", False),
    ("MK", "North Macedonia", "Macedonian", False),
    ("NO", "Norway", "Norwegian", False),
    ("PL", "Poland", "Polish", False),
    ("PT", "Portugal", "Portuguese", False),
    ("RO", "Romania", "Romanian", False),
    ("RU", "Russia", "Russian", False),
    ("SM", "San Marino", "Italian", False),
    ("RS", "Serbia", "Serbian", False),
    ("SK", "Slovakia", "Slovak", False),
    ("SI", "Slovenia", "Slovenian", False),
    ("ES", "Spain", "Spanish", False),
    ("SE", "Sweden", "Swedish", False),
    ("CH", "Switzerland", "German", False),
    ("UA", "Ukraine", "Ukrainian", True),
    ("GB", "United Kingdom", "English", False),

    # Oceania (14)
    ("AU", "Australia", "English", False),
    ("FJ", "Fiji", "English", False),
    ("KI", "Kiribati", "English", False),
    ("MH", "Marshall Islands", "Marshallese", False),
    ("FM", "Micronesia", "English", False),
    ("NR", "Nauru", "Nauruan", False),
    ("NZ", "New Zealand", "English", False),
    ("PW", "Palau", "Palauan", False),
    ("PG", "Papua New Guinea", "English", False),
    ("WS", "Samoa", "Samoan", False),
    ("SB", "Solomon Islands", "English", False),
    ("TO", "Tonga", "Tongan", False),
    ("TV", "Tuvalu", "Tuvaluan", False),
    ("VU", "Vanuatu", "Bislama", False),
]


async def seed_countries() -> None:
    """Insert any missing countries. Idempotent — skips codes that already exist."""
    async with AsyncSessionLocal() as session:
        for code, name, language, is_active in SEED_COUNTRIES:
            existing = await session.get(Country, code)
            if existing is None:
                session.add(Country(
                    code=code,
                    name=name,
                    official_language=language,
                    is_active=is_active,
                ))
        await session.commit()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[CountryResponse])
async def list_countries(db: AsyncSession = Depends(get_db)):
    """List all countries — active countries first, then alphabetical by name."""
    result = await db.execute(
        select(Country).order_by(Country.is_active.desc(), Country.name)
    )
    countries = result.scalars().all()
    response = []
    for country in countries:
        official_lang = country.official_language
        if official_lang:
            normalized = OFFICIAL_LANG_NAME_TO_CODE.get(official_lang.lower().strip())
            if normalized:
                official_lang = normalized
        response.append(CountryResponse(
            code=country.code,
            name=country.name,
            official_language=official_lang,
            is_active=country.is_active,
            dialling_code=country.dialling_code,
        ))
    return response


@router.post("", response_model=CountryResponse, status_code=status.HTTP_201_CREATED)
async def create_country(
    request: CountryCreate,
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(require_admin),
):
    """Create a new country. Admin only."""
    existing = await db.get(Country, request.code.upper())
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Country code already exists",
        )
    country = Country(
        code=request.code.upper(),
        name=request.name,
        official_language=request.official_language,
        is_active=request.is_active,
        dialling_code=request.dialling_code,
    )
    db.add(country)
    await db.commit()
    await db.refresh(country)
    return country


@router.patch("/{code}", response_model=CountryResponse)
async def update_country(
    code: str,
    request: CountryPatch,
    db: AsyncSession = Depends(get_db),
    _: DashboardUser = Depends(require_admin),
):
    """Update country fields. Admin only."""
    country = await db.get(Country, code.upper())
    if not country:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Country not found",
        )
    if request.is_active is not None:
        country.is_active = request.is_active
    if request.dialling_code is not None:
        country.dialling_code = request.dialling_code
    await db.commit()
    await db.refresh(country)
    return country
