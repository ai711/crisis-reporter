from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
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
    "seychellois creole": "fr", "nauruan": "na", "tongan": "to",
    # palauan/tuvaluan/tetum have no ISO 639-1 code — omitted so the stored
    # language name is returned as-is rather than a non-standard 3-letter code.
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


class CountryDetailResponse(BaseModel):
    code: str
    name: str
    official_language: Optional[str] = None
    official_language_name: Optional[str] = None
    is_active: bool
    dialling_code: Optional[str] = None


# ── Seed data — all 193 UN member states ─────────────────────────────────────
# Tuple: (ISO 3166-1 alpha-2 code, English name, primary official language, is_active)
# is_active=True for the 20 original crisis-affected countries.

SEED_COUNTRIES = [
    # Africa (54)
    # Inactive: ER (Eritrea), ML (Mali), SO (Somalia), SD (Sudan)
    ("DZ", "Algeria", "Arabic", True),
    ("AO", "Angola", "Portuguese", True),
    ("BJ", "Benin", "French", True),
    ("BW", "Botswana", "English", True),
    ("BF", "Burkina Faso", "French", True),
    ("BI", "Burundi", "French", True),
    ("CV", "Cabo Verde", "Portuguese", True),
    ("CM", "Cameroon", "French", True),
    ("CF", "Central African Republic", "French", True),
    ("TD", "Chad", "Arabic", True),
    ("KM", "Comoros", "Arabic", True),
    ("CG", "Congo", "French", True),
    ("CD", "DR Congo", "French", True),
    ("CI", "Côte d'Ivoire", "French", True),
    ("DJ", "Djibouti", "French", True),
    ("EG", "Egypt", "Arabic", True),
    ("GQ", "Equatorial Guinea", "Spanish", True),
    ("ER", "Eritrea", "Tigrinya", False),
    ("SZ", "Eswatini", "English", True),
    ("ET", "Ethiopia", "Amharic", True),
    ("GA", "Gabon", "French", True),
    ("GM", "Gambia", "English", True),
    ("GH", "Ghana", "English", True),
    ("GN", "Guinea", "French", True),
    ("GW", "Guinea-Bissau", "Portuguese", True),
    ("KE", "Kenya", "Swahili", True),
    ("LS", "Lesotho", "Sesotho", True),
    ("LR", "Liberia", "English", True),
    ("LY", "Libya", "Arabic", True),
    ("MG", "Madagascar", "Malagasy", True),
    ("MW", "Malawi", "English", True),
    ("ML", "Mali", "French", False),
    ("MR", "Mauritania", "Arabic", True),
    ("MU", "Mauritius", "English", True),
    ("MA", "Morocco", "Arabic", True),
    ("MZ", "Mozambique", "Portuguese", True),
    ("NA", "Namibia", "English", True),
    ("NE", "Niger", "French", True),
    ("NG", "Nigeria", "English", True),
    ("RW", "Rwanda", "Kinyarwanda", True),
    ("ST", "São Tomé and Príncipe", "Portuguese", True),
    ("SN", "Senegal", "French", True),
    ("SC", "Seychelles", "Seychellois Creole", True),
    ("SL", "Sierra Leone", "English", True),
    ("SO", "Somalia", "Somali", False),
    ("ZA", "South Africa", "Zulu", True),
    ("SS", "South Sudan", "English", True),
    ("SD", "Sudan", "Arabic", False),
    ("TZ", "Tanzania", "Swahili", True),
    ("TG", "Togo", "French", True),
    ("TN", "Tunisia", "Arabic", True),
    ("UG", "Uganda", "English", True),
    ("ZM", "Zambia", "English", True),
    ("ZW", "Zimbabwe", "English", True),

    # Americas (35)
    # Inactive: CU (Cuba), NI (Nicaragua), VE (Venezuela)
    ("AG", "Antigua and Barbuda", "English", True),
    ("AR", "Argentina", "Spanish", True),
    ("BS", "Bahamas", "English", True),
    ("BB", "Barbados", "English", True),
    ("BZ", "Belize", "English", True),
    ("BO", "Bolivia", "Spanish", True),
    ("BR", "Brazil", "Portuguese", True),
    ("CA", "Canada", "English", True),
    ("CL", "Chile", "Spanish", True),
    ("CO", "Colombia", "Spanish", True),
    ("CR", "Costa Rica", "Spanish", True),
    ("CU", "Cuba", "Spanish", False),
    ("DM", "Dominica", "English", True),
    ("DO", "Dominican Republic", "Spanish", True),
    ("EC", "Ecuador", "Spanish", True),
    ("SV", "El Salvador", "Spanish", True),
    ("GD", "Grenada", "English", True),
    ("GT", "Guatemala", "Spanish", True),
    ("GY", "Guyana", "English", True),
    ("HT", "Haiti", "Haitian Creole", True),
    ("HN", "Honduras", "Spanish", True),
    ("JM", "Jamaica", "English", True),
    ("MX", "Mexico", "Spanish", True),
    ("NI", "Nicaragua", "Spanish", False),
    ("PA", "Panama", "Spanish", True),
    ("PY", "Paraguay", "Spanish", True),
    ("PE", "Peru", "Spanish", True),
    ("KN", "Saint Kitts and Nevis", "English", True),
    ("LC", "Saint Lucia", "English", True),
    ("VC", "Saint Vincent and the Grenadines", "English", True),
    ("SR", "Suriname", "Dutch", True),
    ("TT", "Trinidad and Tobago", "English", True),
    ("US", "United States", "English", True),
    ("UY", "Uruguay", "Spanish", True),
    ("VE", "Venezuela", "Spanish", False),

    # Asia (47)
    # Inactive: AF (Afghanistan), IR (Iran), MM (Myanmar), KP (North Korea), SY (Syria), YE (Yemen)
    ("AF", "Afghanistan", "Dari", False),
    ("AM", "Armenia", "Armenian", True),
    ("AZ", "Azerbaijan", "Azerbaijani", True),
    ("BH", "Bahrain", "Arabic", True),
    ("BD", "Bangladesh", "Bengali", True),
    ("BT", "Bhutan", "Dzongkha", True),
    ("BN", "Brunei", "Malay", True),
    ("KH", "Cambodia", "Khmer", True),
    ("CN", "China", "Mandarin", True),
    ("CY", "Cyprus", "Greek", True),
    ("GE", "Georgia", "Georgian", True),
    ("IN", "India", "Hindi", True),
    ("ID", "Indonesia", "Indonesian", True),
    ("IR", "Iran", "Persian", False),
    ("IQ", "Iraq", "Arabic", True),
    ("IL", "Israel", "Hebrew", True),
    ("JP", "Japan", "Japanese", True),
    ("JO", "Jordan", "Arabic", True),
    ("KZ", "Kazakhstan", "Kazakh", True),
    ("KW", "Kuwait", "Arabic", True),
    ("KG", "Kyrgyzstan", "Kyrgyz", True),
    ("LA", "Laos", "Lao", True),
    ("LB", "Lebanon", "Arabic", True),
    ("MY", "Malaysia", "Malay", True),
    ("MV", "Maldives", "Dhivehi", True),
    ("MN", "Mongolia", "Mongolian", True),
    ("MM", "Myanmar", "Burmese", False),
    ("NP", "Nepal", "Nepali", True),
    ("KP", "North Korea", "Korean", False),
    ("OM", "Oman", "Arabic", True),
    ("PK", "Pakistan", "Urdu", True),
    ("PH", "Philippines", "Filipino", True),
    ("QA", "Qatar", "Arabic", True),
    ("SA", "Saudi Arabia", "Arabic", True),
    ("SG", "Singapore", "English", True),
    ("KR", "South Korea", "Korean", True),
    ("LK", "Sri Lanka", "Sinhala", True),
    ("SY", "Syria", "Arabic", False),
    ("TJ", "Tajikistan", "Tajik", True),
    ("TH", "Thailand", "Thai", True),
    ("TL", "Timor-Leste", "Tetum", True),
    ("TR", "Turkey", "Turkish", True),
    ("TM", "Turkmenistan", "Turkmen", True),
    ("AE", "United Arab Emirates", "Arabic", True),
    ("UZ", "Uzbekistan", "Uzbek", True),
    ("VN", "Vietnam", "Vietnamese", True),
    ("YE", "Yemen", "Arabic", False),

    # Europe (43)
    # Inactive: BY (Belarus), RU (Russia)
    ("AL", "Albania", "Albanian", True),
    ("AD", "Andorra", "Catalan", True),
    ("AT", "Austria", "German", True),
    ("BY", "Belarus", "Belarusian", False),
    ("BE", "Belgium", "Dutch", True),
    ("BA", "Bosnia and Herzegovina", "Bosnian", True),
    ("BG", "Bulgaria", "Bulgarian", True),
    ("HR", "Croatia", "Croatian", True),
    ("CZ", "Czechia", "Czech", True),
    ("DK", "Denmark", "Danish", True),
    ("EE", "Estonia", "Estonian", True),
    ("FI", "Finland", "Finnish", True),
    ("FR", "France", "French", True),
    ("DE", "Germany", "German", True),
    ("GR", "Greece", "Greek", True),
    ("HU", "Hungary", "Hungarian", True),
    ("IS", "Iceland", "Icelandic", True),
    ("IE", "Ireland", "Irish", True),
    ("IT", "Italy", "Italian", True),
    ("LV", "Latvia", "Latvian", True),
    ("LI", "Liechtenstein", "German", True),
    ("LT", "Lithuania", "Lithuanian", True),
    ("LU", "Luxembourg", "Luxembourgish", True),
    ("MT", "Malta", "Maltese", True),
    ("MD", "Moldova", "Romanian", True),
    ("MC", "Monaco", "French", True),
    ("ME", "Montenegro", "Montenegrin", True),
    ("NL", "Netherlands", "Dutch", True),
    ("MK", "North Macedonia", "Macedonian", True),
    ("NO", "Norway", "Norwegian", True),
    ("PL", "Poland", "Polish", True),
    ("PT", "Portugal", "Portuguese", True),
    ("RO", "Romania", "Romanian", True),
    ("RU", "Russia", "Russian", False),
    ("SM", "San Marino", "Italian", True),
    ("RS", "Serbia", "Serbian", True),
    ("SK", "Slovakia", "Slovak", True),
    ("SI", "Slovenia", "Slovenian", True),
    ("ES", "Spain", "Spanish", True),
    ("SE", "Sweden", "Swedish", True),
    ("CH", "Switzerland", "German", True),
    ("UA", "Ukraine", "Ukrainian", True),
    ("GB", "United Kingdom", "English", True),

    # Oceania (14)
    ("AU", "Australia", "English", True),
    ("FJ", "Fiji", "English", True),
    ("KI", "Kiribati", "English", True),
    ("MH", "Marshall Islands", "Marshallese", True),
    ("FM", "Micronesia", "English", True),
    ("NR", "Nauru", "Nauruan", True),
    ("NZ", "New Zealand", "English", True),
    ("PW", "Palau", "Palauan", True),
    ("PG", "Papua New Guinea", "English", True),
    ("WS", "Samoa", "Samoan", True),
    ("SB", "Solomon Islands", "English", True),
    ("TO", "Tonga", "Tongan", True),
    ("TV", "Tuvalu", "Tuvaluan", True),
    ("VU", "Vanuatu", "Bislama", True),
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
async def list_countries(
    include_inactive: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    """List countries. By default returns only active countries (reporter onboarding).
    Pass include_inactive=true to return all countries (dashboard management view)."""
    if include_inactive:
        result = await db.execute(
            select(Country).order_by(Country.is_active.desc(), Country.name)
        )
    else:
        result = await db.execute(
            select(Country).where(Country.is_active == True).order_by(Country.name)
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


@router.get("/{code}", response_model=CountryDetailResponse)
async def get_country(code: str, db: AsyncSession = Depends(get_db)):
    """Return a single active country with resolved official language name. Public endpoint."""
    result = await db.execute(
        select(Country).where(
            Country.code == code.upper(),
            Country.is_active == True
        )
    )
    country = result.scalar_one_or_none()
    if not country:
        raise HTTPException(status_code=404, detail="Country not found")

    # OFFICIAL_LANG_NAME_TO_CODE maps name→code; reverse it to get code→name.
    code_to_name = {v: k for k, v in OFFICIAL_LANG_NAME_TO_CODE.items()}
    official_language_code = country.official_language
    # Normalize: if stored value is a full language name (len > 3) convert to ISO code.
    if official_language_code and len(official_language_code) > 3:
        official_language_code = OFFICIAL_LANG_NAME_TO_CODE.get(
            official_language_code.lower().strip(), official_language_code
        )
    official_language_name = code_to_name.get(official_language_code, None)

    return CountryDetailResponse(
        code=country.code,
        name=country.name,
        official_language=official_language_code,
        official_language_name=official_language_name,
        is_active=country.is_active,
        dialling_code=country.dialling_code,
    )


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
    existing_name = await db.execute(
        select(Country).where(func.lower(Country.name) == request.name.lower().strip())
    )
    if existing_name.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A country with this name already exists",
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
