"""Add string_keys, translations, language_packages tables

Revision ID: 004
Revises: 003
Create Date: 2026-05-08

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "string_keys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("category", sa.String(20), nullable=False),
        sa.Column("english_text", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("key", name="uq_string_keys_key"),
    )
    op.create_index("ix_string_keys_key", "string_keys", ["key"], unique=True)

    op.create_table(
        "translations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("string_key_id", UUID(as_uuid=True), nullable=False),
        sa.Column("language_code", sa.String(10), nullable=False),
        sa.Column("translated_text", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("translated_by", sa.String(255), nullable=False),
        sa.Column("reviewed_by", sa.String(255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["string_key_id"], ["string_keys.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "string_key_id", "language_code", name="uq_translation_key_lang"
        ),
    )
    op.create_index("ix_translations_string_key_id", "translations", ["string_key_id"])
    op.create_index("ix_translations_language_code", "translations", ["language_code"])
    op.create_index(
        "ix_translations_lang_status", "translations", ["language_code", "status"]
    )

    op.create_table(
        "language_packages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("language_code", sa.String(10), nullable=False),
        sa.Column("version", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "language_code", "version", name="uq_langpkg_lang_version"
        ),
    )
    op.create_index(
        "ix_language_packages_language_code", "language_packages", ["language_code"]
    )
    op.create_index(
        "ix_language_packages_status", "language_packages", ["status"]
    )


def downgrade() -> None:
    op.drop_table("language_packages")
    op.drop_table("translations")
    op.drop_table("string_keys")
