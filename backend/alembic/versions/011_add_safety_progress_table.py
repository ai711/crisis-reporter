"""Add safety_progress table

Revision ID: 011
Revises: 010
Create Date: 2026-05-15

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "safety_progress",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "reporter_id",
            UUID(as_uuid=True),
            sa.ForeignKey("reporters.id"),
            nullable=False,
        ),
        sa.Column("part_completed", sa.String(10), nullable=False),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_safety_progress_reporter_id", "safety_progress", ["reporter_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_safety_progress_reporter_id", table_name="safety_progress")
    op.drop_table("safety_progress")
