"""Add extended report fields for chapters 4, 5, and 6

Revision ID: 013
Revises: 012
Create Date: 2026-05-15

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # BE-02 — Chapter 4: submission timing + photo metadata
    op.add_column("reports", sa.Column("submission_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("reports", sa.Column("submission_submitted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("reports", sa.Column("photo_metadata", sa.Text(), nullable=True))
    op.add_column("reports", sa.Column("photo_exif_data", sa.Text(), nullable=True))

    # BE-03 — Chapter 5: extended location
    op.add_column("reports", sa.Column("building_centroid_lat", sa.Float(), nullable=True))
    op.add_column("reports", sa.Column("building_centroid_lng", sa.Float(), nullable=True))
    op.add_column("reports", sa.Column("building_name_osm", sa.String(300), nullable=True))
    op.add_column("reports", sa.Column("building_name_reporter", sa.String(300), nullable=True))
    op.add_column("reports", sa.Column("location_note", sa.Text(), nullable=True))
    op.add_column("reports", sa.Column("location_entry_method", sa.String(50), nullable=True))
    op.add_column("reports", sa.Column("location_internet_available", sa.Boolean(), nullable=True))
    op.add_column("reports", sa.Column("gps_denied", sa.Boolean(), nullable=True))

    # BE-05 — Chapter 6: structured answers + precise version tracking
    op.add_column("reports", sa.Column("question_answers", JSONB(), nullable=True))
    op.add_column("reports", sa.Column("question_package_content_version", sa.String(50), nullable=True))
    op.add_column("reports", sa.Column("question_package_translation_version", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "question_package_translation_version")
    op.drop_column("reports", "question_package_content_version")
    op.drop_column("reports", "question_answers")
    op.drop_column("reports", "gps_denied")
    op.drop_column("reports", "location_internet_available")
    op.drop_column("reports", "location_entry_method")
    op.drop_column("reports", "location_note")
    op.drop_column("reports", "building_name_reporter")
    op.drop_column("reports", "building_name_osm")
    op.drop_column("reports", "building_centroid_lng")
    op.drop_column("reports", "building_centroid_lat")
    op.drop_column("reports", "photo_exif_data")
    op.drop_column("reports", "photo_metadata")
    op.drop_column("reports", "submission_submitted_at")
    op.drop_column("reports", "submission_started_at")
