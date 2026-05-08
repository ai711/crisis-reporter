"""Add electricity_condition, health_services_condition, pressing_needs, pressing_needs_other to reports

Revision ID: 003
Revises: 002
Create Date: 2026-05-08

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("electricity_condition", sa.String(50), nullable=True))
    op.add_column("reports", sa.Column("health_services_condition", sa.String(50), nullable=True))
    op.add_column("reports", sa.Column("pressing_needs", ARRAY(sa.String()), nullable=True))
    op.add_column("reports", sa.Column("pressing_needs_other", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "pressing_needs_other")
    op.drop_column("reports", "pressing_needs")
    op.drop_column("reports", "health_services_condition")
    op.drop_column("reports", "electricity_condition")
