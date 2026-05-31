"""add missing flag_events columns: metadata

Revision ID: 018
Revises: 017
Create Date: 2026-05-31

is_emergency_override was added to the model before the last create_all()
bootstrap so it already exists in the DB.  metadata (flag_metadata) was
added later and is the only column genuinely absent from the live table.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON

revision = '018'
down_revision = '017'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'flag_events',
        sa.Column('metadata', JSON, nullable=True)
    )


def downgrade() -> None:
    op.drop_column('flag_events', 'metadata')
