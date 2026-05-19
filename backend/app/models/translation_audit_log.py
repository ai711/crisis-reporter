from datetime import datetime
from sqlalchemy import Integer, String, DateTime, JSON, func
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class TranslationAuditLog(Base):
    __tablename__ = "translation_audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # Values: "language_added", "language_deprecated", "language_activated",
    # "language_removed", "translation_approved", "translation_rejected",
    # "translation_auto_generated", "package_published",
    # "edit_lock_acquired", "edit_lock_released", "edit_lock_force_released",
    # "question_package_saved", "content_saved"

    lang_code: Mapped[str | None] = mapped_column(String(10), nullable=True, index=True)
    string_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    performed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dashboard_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
