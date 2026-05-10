"""Create settings and health_incidents tables

Revision ID: 008
Revises: 007
Create Date: 2026-05-10

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.String(100), nullable=False, unique=True),
        sa.Column("value", JSONB, nullable=False, server_default="{}"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_app_settings_key", "app_settings", ["key"])

    op.create_table(
        "health_incidents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("component", sa.String(50), nullable=False),
        sa.Column("event_type", sa.String(20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer, nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_health_incidents_component", "health_incidents", ["component"])
    op.create_index("ix_health_incidents_started_at", "health_incidents", ["started_at"])


def downgrade() -> None:
    op.drop_index("ix_health_incidents_started_at", table_name="health_incidents")
    op.drop_index("ix_health_incidents_component", table_name="health_incidents")
    op.drop_table("health_incidents")
    op.drop_index("ix_app_settings_key", table_name="app_settings")
    op.drop_table("app_settings")
