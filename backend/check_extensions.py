import asyncio
import asyncpg

async def check_extensions():
    conn = await asyncpg.connect(
        "postgresql://postgres:HkKiafZdZvAvVvWDXOLDTMOVTmvyIiWP@tramway.proxy.rlwy.net:57206/railway"
    )
    result = await conn.fetch(
        "SELECT name FROM pg_available_extensions WHERE name LIKE '%postgis%' ORDER BY name;"
    )
    for row in result:
        print(row["name"])
    await conn.close()

asyncio.run(check_extensions())