from pydantic_settings import BaseSettings
from typing import Literal
import secrets


class Settings(BaseSettings):
    # Application
    APP_NAME: str = "Crisis Reporter"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://crisis_user:crisis_pass@localhost:5432/crisis_reporter"

    # Redis
    REDIS_URL: str = "redis://localhost:6379"

    # JWT
    JWT_SECRET_KEY: str = secrets.token_urlsafe(32)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Login rate limiting
    LOGIN_RATE_LIMIT_ATTEMPTS: int = 5          # failed attempts before lockout
    LOGIN_RATE_LIMIT_WINDOW_MINUTES: int = 10   # rolling window for counting attempts
    LOGIN_LOCKOUT_MINUTES: int = 15             # how long to block after threshold reached

    # Session / inactivity
    INACTIVITY_TIMEOUT_MINUTES: int = 30        # dashboard idle timeout

    # Encryption
    FERNET_KEY: str = ""

    # Storage
    STORAGE_BACKEND: Literal["local", "r2"] = "local"
    LOCAL_UPLOAD_PATH: str = "uploads/photos"
    R2_ACCOUNT_ID: str = ""
    R2_ACCESS_KEY_ID: str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    R2_BUCKET_NAME: str = ""
    R2_PUBLIC_URL: str = ""  # e.g. https://pub-xxxx.r2.dev or custom domain

    # Maptiler
    MAPTILER_API_KEY: str = ""

    # Web Push
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""

    # Expo Push
    EXPO_PUSH_TOKEN: str = ""

    # LibreTranslate
    LIBRETRANSLATE_URL: str = "https://libretranslate.com"

    # Bootstrap admin — created once on first startup if no admin exists
    FIRST_ADMIN_EMAIL: str = ""
    FIRST_ADMIN_PASSWORD: str = ""

    # Auto-flagging thresholds
    SAME_IP_DEVICE_THRESHOLD: int = 3   # distinct device IDs from one IP in 24 h before red flag

    # Property grouping and conflict warning
    CONFLICT_WARNING_THRESHOLD: float = 0.25  # minority share >= 25% triggers conflict warning
    GPS_GROUPING_RADIUS_DEGREES: float = 0.001  # ~100 metres at equator

    # Map settings
    REPORTING_RADIUS_DEFAULT_MILES: int = 50

    # Translation governance
    LANGUAGE_DEPRECATION_WINDOW_DAYS: int = 90
    TRANSLATION_LOCK_MINUTES: int = 30

    # Review Queue
    REVIEW_SOFT_LOCK_MINUTES: int = 15
    AUTO_BLOCK_CONFIRMATION_HOURS: int = 72
    AUTO_BLOCK_CHECK_INTERVAL_MINUTES: int = 15
    STUCK_REPORT_THRESHOLD_MINUTES: int = 10

    # CORS — origins allowed to call the API
    ALLOWED_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
        "http://192.168.1.69:5173",
        "http://192.168.1.69:5174",
        "https://crisis-reporter-production.up.railway.app",
    ]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()