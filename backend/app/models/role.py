import uuid
from datetime import datetime
from sqlalchemy import String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID, JSONB
from app.database import Base


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(
        String(100), nullable=False, unique=True, index=True
    )
    is_default: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # {section_key: {view: bool, edit: bool}}
    permissions: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dashboard_users.id"), nullable=True
    )

    def __repr__(self) -> str:
        return f"<Role {self.name}>"
