"""Add os_device_id and t_and_c_accepted_at to reporters

Revision ID: 014
Revises: 013
Create Date: 2026-05-19

"""
from alembic import op
import sqlalchemy as sa

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "reporters",
        sa.Column("os_device_id", sa.String(64), nullable=True),
    )
    op.add_column(
        "reporters",
        sa.Column("t_and_c_accepted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reporters", "t_and_c_accepted_at")
    op.drop_column("reporters", "os_device_id")
