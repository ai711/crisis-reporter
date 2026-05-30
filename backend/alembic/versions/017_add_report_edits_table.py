"""Add report_edits table for dashboard edit audit trail

Revision ID: 017
Revises: 016
Create Date: 2026-05-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSON

revision: str = "017"
down_revision: Union[str, Sequence[str], None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_edits",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("report_id", UUID(as_uuid=True), sa.ForeignKey("reports.id"), nullable=False),
        sa.Column("edited_by", sa.String(255), nullable=False),
        sa.Column(
            "edited_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("fields_changed", JSON, nullable=False),
        sa.Column("edit_reason", sa.Text, nullable=True),
        sa.Column("version_number", sa.Integer, nullable=False, server_default="1"),
    )
    op.create_index("ix_report_edits_report_id", "report_edits", ["report_id"])


def downgrade() -> None:
    op.drop_index("ix_report_edits_report_id", table_name="report_edits")
    op.drop_table("report_edits")
