"""Add photo_url to reporters

Revision ID: 012
Revises: 011
Create Date: 2026-05-15

"""
from alembic import op
import sqlalchemy as sa

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "reporters",
        sa.Column("photo_url", sa.String(500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reporters", "photo_url")
