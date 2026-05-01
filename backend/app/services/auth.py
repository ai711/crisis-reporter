import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
import jwt
from passlib.context import CryptContext
from app.config import settings

# Password hashing context — bcrypt
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Token types
TokenType = Literal["access", "refresh"]


def hash_password(password: str) -> str:
    """Hash a plain text password using bcrypt."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain text password against a bcrypt hash."""
    return pwd_context.verify(plain_password, hashed_password)


def create_token(
    subject: str,
    token_type: TokenType,
    role: str,
    context: Literal["dashboard", "reporter"],
    extra_claims: dict = {},
) -> str:
    """Create a signed JWT token.
    
    Args:
        subject: The user ID (UUID as string)
        token_type: access or refresh
        role: admin, analyst, reporter, anonymous
        context: dashboard or reporter — enforces separation
        extra_claims: any additional claims to include
    
    Returns:
        Signed JWT token string
    """
    now = datetime.now(timezone.utc)

    if token_type == "access":
        expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    else:
        expire = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    payload = {
        "sub": subject,
        "type": token_type,
        "role": role,
        "ctx": context,
        "iat": now,
        "exp": expire,
        "jti": str(uuid.uuid4()),  # unique token ID for revocation
        **extra_claims,
    }

    return jwt.encode(
        payload,
        settings.JWT_SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )


def decode_token(token: str) -> dict:
    """Decode and verify a JWT token.
    
    Raises:
        jwt.ExpiredSignatureError: if token has expired
        jwt.InvalidTokenError: if token is invalid
    
    Returns:
        Token payload as dict
    """
    return jwt.decode(
        token,
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
    )


def create_token_pair(
    subject: str,
    role: str,
    context: Literal["dashboard", "reporter"],
    extra_claims: dict = {},
) -> dict:
    """Create an access + refresh token pair.
    
    Returns:
        Dict with access_token, refresh_token, token_type, expires_in
    """
    access_token = create_token(subject, "access", role, context, extra_claims)
    refresh_token = create_token(subject, "refresh", role, context, extra_claims)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,  # seconds
    }