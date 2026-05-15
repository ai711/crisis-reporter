"""Add reporter display_id sequential integer

Revision ID: 010
Revises: 009
Create Date: 2026-05-15

"""
from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS reporter_display_id_seq START 1")
    op.add_column("reporters", sa.Column("display_id", sa.Integer(), nullable=True))
    op.create_index("ix_reporters_display_id", "reporters", ["display_id"], unique=True)
    op.execute("""
        UPDATE reporters
        SET display_id = nextval('reporter_display_id_seq')
        WHERE display_id IS NULL
    """)


def downgrade() -> None:
    op.drop_index("ix_reporters_display_id", table_name="reporters")
    op.drop_column("reporters", "display_id")
    op.execute("DROP SEQUENCE IF EXISTS reporter_display_id_seq")
