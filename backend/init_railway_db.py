import asyncio
import asyncpg
import uuid
from datetime import datetime
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

DB_URL = "postgresql://crisis_user:crisis_pass@trolley.proxy.rlwy.net:30582/crisis_reporter"

async def init():
    conn = await asyncpg.connect(DB_URL)
    
    # Create all tables
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS crises (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(255) NOT NULL,
            country_code VARCHAR(10) NOT NULL,
            description TEXT,
            is_active BOOLEAN DEFAULT TRUE NOT NULL,
            map_center_lat FLOAT,
            map_center_lng FLOAT,
            map_default_radius_miles INTEGER DEFAULT 50 NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("crises table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS dashboard_users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(255) NOT NULL UNIQUE,
            full_name VARCHAR(255) NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(20) DEFAULT 'analyst' NOT NULL,
            is_active BOOLEAN DEFAULT TRUE NOT NULL,
            last_login_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("dashboard_users table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS reporters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            device_id_encrypted BYTEA,
            device_id_hash VARCHAR(64),
            platform VARCHAR(20) NOT NULL,
            email_encrypted BYTEA,
            email_hash VARCHAR(64),
            name_encrypted BYTEA,
            password_hash VARCHAR(255),
            is_verified BOOLEAN DEFAULT FALSE NOT NULL,
            country_code VARCHAR(10),
            language_code VARCHAR(10) DEFAULT 'en' NOT NULL,
            is_blocked BOOLEAN DEFAULT FALSE NOT NULL,
            block_reason TEXT,
            blocked_at TIMESTAMPTZ,
            report_count INTEGER DEFAULT 0 NOT NULL,
            last_active_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("reporters table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            local_id VARCHAR(100),
            crisis_id UUID NOT NULL REFERENCES crises(id),
            reporter_id UUID REFERENCES reporters(id),
            building_id VARCHAR(255),
            building_name VARCHAR(255),
            gps_latitude FLOAT,
            gps_longitude FLOAT,
            gps_accuracy_meters FLOAT,
            gps_available BOOLEAN DEFAULT TRUE NOT NULL,
            location_address TEXT,
            location_landmark TEXT,
            location_building_name TEXT,
            damage_level VARCHAR(20) NOT NULL,
            infrastructure_type VARCHAR(50) NOT NULL,
            description TEXT,
            description_translated TEXT,
            description_language VARCHAR(10),
            flag_status VARCHAR(20) DEFAULT 'grey' NOT NULL,
            platform VARCHAR(20) NOT NULL,
            app_version VARCHAR(20),
            language_code VARCHAR(10) DEFAULT 'en' NOT NULL,
            question_package_version INTEGER,
            translation_version INTEGER,
            mcc VARCHAR(10),
            mnc VARCHAR(10),
            carrier_name VARCHAR(100),
            ip_address_encrypted VARCHAR(500),
            was_queued BOOLEAN DEFAULT FALSE NOT NULL,
            queued_at TIMESTAMPTZ,
            synced_at TIMESTAMPTZ,
            submitted_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("reports table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS photos (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            report_id UUID NOT NULL REFERENCES reports(id),
            storage_path VARCHAR(500) NOT NULL,
            storage_backend VARCHAR(50) NOT NULL,
            original_filename VARCHAR(255),
            mime_type VARCHAR(50) NOT NULL,
            original_size_bytes INTEGER,
            final_size_bytes INTEGER,
            was_compressed BOOLEAN DEFAULT FALSE NOT NULL,
            compression_ratio FLOAT,
            exif_latitude FLOAT,
            exif_longitude FLOAT,
            exif_timestamp TIMESTAMPTZ,
            exif_device_make VARCHAR(100),
            exif_device_model VARCHAR(100),
            display_order INTEGER DEFAULT 0 NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("photos table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS flag_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            report_id UUID NOT NULL REFERENCES reports(id),
            dashboard_user_id UUID REFERENCES dashboard_users(id),
            flag_from VARCHAR(20),
            flag_to VARCHAR(20) NOT NULL,
            changed_by VARCHAR(20) NOT NULL,
            reason TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("flag_events table created")

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS push_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reporter_id UUID NOT NULL REFERENCES reporters(id),
            token VARCHAR(500) NOT NULL,
            token_type VARCHAR(20) NOT NULL,
            platform VARCHAR(20) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE NOT NULL,
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
        );
    """)
    print("push_tokens table created")

    # Create indexes
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reports_flag_status ON reports(flag_status);")
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reports_crisis_created ON reports(crisis_id, created_at);")
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reports_crisis_flag ON reports(crisis_id, flag_status);")
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reporters_device_id_hash ON reporters(device_id_hash);")
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reporters_is_blocked ON reporters(is_blocked);")
    await conn.execute("CREATE INDEX IF NOT EXISTS ix_reporters_platform ON reporters(platform);")
    print("Indexes created")

    # Create admin user
    password_hash = pwd_context.hash("Admin2026")
    user_id = str(uuid.uuid4())
    now = datetime.utcnow()
    
    await conn.execute("""
        INSERT INTO dashboard_users (id, email, full_name, password_hash, role, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (email) DO NOTHING
    """, user_id, "admin@crisisreporter.org", "Crisis Reporter Admin",
        password_hash, "admin", True, now, now)
    print("Admin user created")

    # Create a test crisis
    crisis_id = str(uuid.uuid4())
    await conn.execute("""
        INSERT INTO crises (id, name, country_code, description, is_active, map_center_lat, map_center_lng, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    """, crisis_id, "Demo Crisis", "IN", "Demo crisis for UNDP evaluation",
        True, 23.0225, 72.5714, now, now)
    print(f"Demo crisis created with ID: {crisis_id}")

    await conn.close()
    print("Database initialisation complete")

asyncio.run(init())