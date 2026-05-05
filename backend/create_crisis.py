import asyncio
import asyncpg
import uuid
from datetime import datetime, timezone

async def create_crisis():
    conn = await asyncpg.connect(
        "postgresql://crisis_user:crisis_pass@trolley.proxy.rlwy.net:30582/crisis_reporter"
    )
    crisis_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    await conn.execute(
        """
        INSERT INTO crises (
            id, name, country_code, description, is_active,
            map_center_lat, map_center_lng, map_default_radius_miles,
            created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """,
        crisis_id, "Demo Crisis", "IN",
        "Demo crisis for UNDP evaluation",
        True, 23.0225, 72.5714, 50, now, now
    )
    print(f"Crisis created: {crisis_id}")
    await conn.close()

asyncio.run(create_crisis())