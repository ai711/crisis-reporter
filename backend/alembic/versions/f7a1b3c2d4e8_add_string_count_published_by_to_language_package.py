"""add string_count and published_by to language_package

Revision ID: f7a1b3c2d4e8
Revises: c8672274af72
Create Date: 2026-05-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f7a1b3c2d4e8'
down_revision: Union[str, Sequence[str], None] = 'c8672274af72'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('language_packages', sa.Column('string_count', sa.Integer(), nullable=True))
    op.add_column('language_packages', sa.Column('published_by', sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column('language_packages', 'published_by')
    op.drop_column('language_packages', 'string_count')
