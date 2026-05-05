import asyncio
import asyncpg

async def setup():
    conn = await asyncpg.connect(
        "postgresql://crisis_user:crisis_pass@trolley.proxy.rlwy.net:30582/crisis_reporter"
    )
    
    # Enable PostGIS
    await conn.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
    print("PostGIS enabled successfully")
    
    await conn.close()
    print("Done")

asyncio.run(setup())