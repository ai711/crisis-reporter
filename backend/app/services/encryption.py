import hashlib
import base64
from cryptography.fernet import Fernet
from app.config import settings


def _get_fernet() -> Fernet:
    """Get Fernet instance. Generates a key if none is configured (development only)."""
    key = settings.FERNET_KEY
    if not key:
        # Development fallback — generate a temporary key
        # In production, FERNET_KEY must be set as an environment variable
        key = Fernet.generate_key().decode()
    
    # Ensure key is properly formatted
    if isinstance(key, str):
        key = key.encode()
    
    return Fernet(key)


def encrypt_field(value: str) -> bytes:
    """Encrypt a sensitive string field before storing in database."""
    if not value:
        return b""
    f = _get_fernet()
    return f.encrypt(value.encode())


def decrypt_field(encrypted_value: bytes) -> str:
    """Decrypt a sensitive field retrieved from database."""
    if not encrypted_value:
        return ""
    f = _get_fernet()
    return f.decrypt(encrypted_value).decode()


def hash_field(value: str) -> str:
    """Create a SHA-256 hash of a field for indexed lookups.
    Used alongside encryption — hash enables searching without decrypting.
    Example: look up reporter by email hash, then decrypt to verify."""
    if not value:
        return ""
    return hashlib.sha256(value.lower().strip().encode()).hexdigest()


def generate_fernet_key() -> str:
    """Generate a new Fernet key — run once to create your FERNET_KEY value."""
    return Fernet.generate_key().decode()