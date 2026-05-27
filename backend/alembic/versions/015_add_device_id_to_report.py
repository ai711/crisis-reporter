"""Add device_id and os_device_id to reports

Revision ID: 015
Revises: f7a1b3c2d4e8
Create Date: 2026-05-27

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "015"
down_revision: Union[str, Sequence[str], None] = "f7a1b3c2d4e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("device_id", sa.String(100), nullable=True))
    op.add_column("reports", sa.Column("os_device_id", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "os_device_id")
    op.drop_column("reports", "device_id")
