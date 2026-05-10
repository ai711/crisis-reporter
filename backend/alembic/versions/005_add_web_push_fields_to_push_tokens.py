"""Add endpoint, p256dh, auth_key to push_tokens

Revision ID: 005
Revises: 004
Create Date: 2026-05-10

"""
from alembic import op
import sqlalchemy as sa

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "push_tokens",
        sa.Column("endpoint", sa.String(2048), nullable=True),
    )
    op.add_column(
        "push_tokens",
        sa.Column("p256dh", sa.String(512), nullable=True),
    )
    op.add_column(
        "push_tokens",
        sa.Column("auth_key", sa.String(256), nullable=True),
    )
    op.create_index(
        "ix_push_tokens_endpoint", "push_tokens", ["endpoint"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_push_tokens_endpoint", table_name="push_tokens")
    op.drop_column("push_tokens", "auth_key")
    op.drop_column("push_tokens", "p256dh")
    op.drop_column("push_tokens", "endpoint")
