import json
import asyncio
from datetime import datetime
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.dependencies import get_current_dashboard_user
from app.models.dashboard_user import DashboardUser
from app.config import settings

router = APIRouter(prefix="/api/dashboard", tags=["Dashboard SSE"])


async def event_generator(request: Request, crisis_id: str):
    """Generate SSE events for connected dashboard clients.
    
    Publishes events when:
    - New report confirmed (green/orange flag assigned)
    - Report flag changed manually
    - Reporter status changed
    - Review queue updated (red flag assigned)
    
    Falls back gracefully when Redis pub/sub is unavailable.
    """
    import redis.asyncio as aioredis

    try:
        redis_client = aioredis.from_url(settings.REDIS_URL)
        pubsub = redis_client.pubsub()
        channel = f"dashboard:{crisis_id}"
        await pubsub.subscribe(channel)

        # Send initial connection confirmation
        yield f"data: {json.dumps({'type': 'connected', 'crisis_id': crisis_id})}\n\n"

        while True:
            # Check if client disconnected
            if await request.is_disconnected():
                break

            # Check for new messages
            try:
                message = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True),
                    timeout=1.0,
                )
                if message and message.get("data"):
                    data = message["data"]
                    if isinstance(data, bytes):
                        data = data.decode()
                    yield f"data: {data}\n\n"
            except asyncio.TimeoutError:
                # Send heartbeat every 30 seconds to keep connection alive
                yield f"data: {json.dumps({'type': 'heartbeat', 'ts': datetime.utcnow().isoformat()})}\n\n"

            await asyncio.sleep(0.1)

    except Exception:
        # Redis unavailable — send error event
        # Frontend will fall back to polling automatically
        yield f"data: {json.dumps({'type': 'error', 'message': 'SSE unavailable — falling back to polling'})}\n\n"

    finally:
        try:
            await pubsub.unsubscribe(channel)
            await redis_client.aclose()
        except Exception:
            pass


@router.get("/stream")
async def dashboard_stream(
    request: Request,
    crisis_id: str,
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """SSE endpoint for real-time dashboard updates.
    
    Connect once per dashboard session. Receives push events
    when reports or flags change. Frontend falls back to
    20-second polling if this connection drops.
    """
    return StreamingResponse(
        event_generator(request, crisis_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def publish_event(crisis_id: str, event_type: str, data: dict):
    """Publish an event to all connected dashboard clients for a crisis.
    
    Called from:
    - Report submission (after auto-flagging assigns green/orange)
    - Manual flag updates
    - Reporter block/unblock
    
    Usage:
        await publish_event(crisis_id, "report_confirmed", {
            "report_id": str(report.id),
            "flag_status": "green",
            "latitude": 23.0225,
            "longitude": 72.5714,
        })
    """
    import redis.asyncio as aioredis

    try:
        redis_client = aioredis.from_url(settings.REDIS_URL)
        payload = json.dumps({
            "type": event_type,
            "crisis_id": str(crisis_id),
            "ts": datetime.utcnow().isoformat(),
            **data,
        })
        channel = f"dashboard:{crisis_id}"
        await redis_client.publish(channel, payload)
        await redis_client.aclose()
    except Exception:
        # Redis unavailable — event not published
        # Dashboard will receive data on next poll
        pass