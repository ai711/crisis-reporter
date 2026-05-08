"""Add question_packages, questions, question_options tables

Revision ID: 002
Revises: 001
Create Date: 2026-05-08

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── question_packages ─────────────────────────────────────────────────────
    op.create_table(
        "question_packages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("version", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("dashboard_users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_question_packages_version", "question_packages", ["version"], unique=True)
    op.create_index("ix_question_packages_status", "question_packages", ["status"])

    # ── questions ─────────────────────────────────────────────────────────────
    op.create_table(
        "questions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "package_id",
            UUID(as_uuid=True),
            sa.ForeignKey("question_packages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("question_text", sa.String(500), nullable=False),
        sa.Column("question_type", sa.String(20), nullable=False),
        sa.Column("order_index", sa.Integer, nullable=False, server_default="0"),
        sa.Column("is_mandatory", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
    )
    op.create_index("ix_questions_package_id", "questions", ["package_id"])

    # ── question_options ──────────────────────────────────────────────────────
    op.create_table(
        "question_options",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "question_id",
            UUID(as_uuid=True),
            sa.ForeignKey("questions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("option_text", sa.String(255), nullable=False),
        sa.Column("option_value", sa.String(100), nullable=False),
        sa.Column("order_index", sa.Integer, nullable=False, server_default="0"),
    )
    op.create_index("ix_question_options_question_id", "question_options", ["question_id"])


def downgrade() -> None:
    op.drop_table("question_options")
    op.drop_table("questions")
    op.drop_table("question_packages")
