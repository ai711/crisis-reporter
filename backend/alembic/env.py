import os
import sys
from logging.config import fileConfig
from urllib.parse import urlparse, unquote
from sqlalchemy import create_engine, pool
from alembic import context

# Make app importable
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import Base
from app.models import report, reporter, crisis, flag_event, dashboard_user, push_token, photo, question_package  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_raw_database_url() -> str:
    """Read DATABASE_URL directly from .env to preserve special chars exactly."""
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    return line[len("DATABASE_URL="):]
    from app.config import settings
    return settings.DATABASE_URL


def make_sync_engine():
    """Build a sync psycopg2 engine by parsing URL components individually."""
    raw = get_raw_database_url()
    # Strip asyncpg scheme so urlparse handles it
    raw = raw.replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlparse(raw)
    return create_engine(
        "postgresql+psycopg2://",
        creator=lambda: __import__("psycopg2").connect(
            host=parsed.hostname,
            port=parsed.port or 5432,
            dbname=parsed.path.lstrip("/"),
            user=parsed.username,
            password=unquote(parsed.password) if parsed.password else "",
        ),
        poolclass=pool.NullPool,
    )


def run_migrations_offline() -> None:
    raw = get_raw_database_url()
    url = raw.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = make_sync_engine()
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
