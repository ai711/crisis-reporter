"""add is_emergency_override to flag_events

Revision ID: 018
Revises: 017
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa

revision = '018'
down_revision = '017'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column(
        'flag_events',
        sa.Column(
            'is_emergency_override',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('false')
        )
    )

def downgrade() -> None:
    op.drop_column('flag_events', 'is_emergency_override')
