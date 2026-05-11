"""Create countries table

Revision ID: 009
Revises: 008
Create Date: 2026-05-11

"""
from alembic import op
import sqlalchemy as sa

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "countries",
        sa.Column("code", sa.String(2), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("official_language", sa.String(100), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("countries")
