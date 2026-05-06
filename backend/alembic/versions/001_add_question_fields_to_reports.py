"""Add question fields to reports table

Revision ID: 001
Revises:
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("infrastructure_types", ARRAY(sa.String()), nullable=True))
    op.add_column("reports", sa.Column("infrastructure_other", sa.Text(), nullable=True))
    op.add_column("reports", sa.Column("infrastructure_name", sa.Text(), nullable=True))
    op.add_column("reports", sa.Column("disaster_type", sa.String(100), nullable=True))
    op.add_column("reports", sa.Column("debris_blocking", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "debris_blocking")
    op.drop_column("reports", "disaster_type")
    op.drop_column("reports", "infrastructure_name")
    op.drop_column("reports", "infrastructure_other")
    op.drop_column("reports", "infrastructure_types")
