"""Change question_package_version from Integer to String

Revision ID: 006
Revises: 005
Create Date: 2026-05-10

"""
from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE reports ALTER COLUMN question_package_version "
        "TYPE VARCHAR(20) USING question_package_version::text"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE reports ALTER COLUMN question_package_version "
        "TYPE INTEGER USING NULL"
    )
