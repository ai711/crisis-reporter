"""Add device model, network type, reporter country; widen platform column

Revision ID: 016
Revises: 015
Create Date: 2026-05-27

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "016"
down_revision: Union[str, Sequence[str], None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("reports", "platform", type_=sa.String(50), existing_nullable=False)
    op.add_column("reports", sa.Column("device_model", sa.String(200), nullable=True))
    op.add_column("reports", sa.Column("device_brand", sa.String(100), nullable=True))
    op.add_column("reports", sa.Column("device_os_version", sa.String(50), nullable=True))
    op.add_column("reports", sa.Column("network_type", sa.String(20), nullable=True))
    op.add_column("reports", sa.Column("reporter_country", sa.String(10), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "reporter_country")
    op.drop_column("reports", "network_type")
    op.drop_column("reports", "device_os_version")
    op.drop_column("reports", "device_brand")
    op.drop_column("reports", "device_model")
    op.alter_column("reports", "platform", type_=sa.String(20), existing_nullable=False)
