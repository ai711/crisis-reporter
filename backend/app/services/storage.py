import os
import uuid
from abc import ABC, abstractmethod
from pathlib import Path
import boto3
from botocore.client import Config
from app.config import settings


class StorageService(ABC):
    """Abstract base class for photo storage.
    All storage backends must implement these three methods.
    Switching backends requires only a config change — no code changes."""

    @abstractmethod
    async def save(self, file_data: bytes, filename: str, content_type: str) -> str:
        """Save a file and return its storage path."""
        pass

    @abstractmethod
    def get_url(self, storage_path: str) -> str:
        """Return the URL for serving a stored file."""
        pass

    @abstractmethod
    async def delete(self, storage_path: str) -> bool:
        """Delete a stored file. Returns True if successful."""
        pass


class LocalFileSystemStorage(StorageService):
    """Development storage — saves photos to local filesystem."""

    def __init__(self):
        # Resolve to absolute path immediately so it stays correct regardless
        # of the working directory uvicorn was started from.
        self.base_path = Path(settings.LOCAL_UPLOAD_PATH).resolve()
        self.base_path.mkdir(parents=True, exist_ok=True)

    async def save(self, file_data: bytes, filename: str, content_type: str) -> str:
        # Generate unique filename to prevent collisions
        ext = Path(filename).suffix.lower()
        unique_filename = f"{uuid.uuid4()}{ext}"
        file_path = self.base_path / unique_filename

        with open(file_path, "wb") as f:
            f.write(file_data)

        return f"photos/{unique_filename}"

    def get_url(self, storage_path: str) -> str:
        # Served via FastAPI static files endpoint
        return f"/api/uploads/{storage_path}"

    async def delete(self, storage_path: str) -> bool:
        file_path = self.base_path / Path(storage_path).name
        try:
            if file_path.exists():
                file_path.unlink()
            return True
        except Exception:
            return False


class CloudflareR2Storage(StorageService):
    """Production storage — Cloudflare R2 (S3-compatible)."""

    def __init__(self):
        self.bucket_name = settings.R2_BUCKET_NAME
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{settings.R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.R2_ACCESS_KEY_ID,
            aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4"),
            region_name="auto",
        )

    async def save(self, file_data: bytes, filename: str, content_type: str) -> str:
        ext = Path(filename).suffix.lower()
        unique_filename = f"{uuid.uuid4()}{ext}"
        storage_path = f"photos/{unique_filename}"

        self.client.put_object(
            Bucket=self.bucket_name,
            Key=storage_path,
            Body=file_data,
            ContentType=content_type,
        )

        return storage_path

    def get_url(self, storage_path: str) -> str:
        # Public R2 URL — set R2_PUBLIC_URL to your bucket's public domain or r2.dev subdomain
        base = settings.R2_PUBLIC_URL.rstrip("/")
        return f"{base}/{storage_path}"

    async def delete(self, storage_path: str) -> bool:
        try:
            self.client.delete_object(
                Bucket=self.bucket_name,
                Key=storage_path,
            )
            return True
        except Exception:
            return False


def get_storage_service() -> StorageService:
    """Factory function — returns the correct storage backend based on config.
    This is the single point of control for switching between local and R2."""
    if settings.STORAGE_BACKEND == "r2":
        return CloudflareR2Storage()
    return LocalFileSystemStorage()


# Singleton instance — created once at startup
storage_service = get_storage_service()