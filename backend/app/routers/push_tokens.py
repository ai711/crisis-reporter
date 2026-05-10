import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.database import get_db
from app.models.push_token import PushToken

router = APIRouter(prefix="/api/push-tokens", tags=["Push Tokens"])


class WebPushSubscriptionRequest(BaseModel):
    reporter_id: str
    endpoint: str
    p256dh: str
    auth_key: str


class WebPushSubscriptionResponse(BaseModel):
    id: str
    reporter_id: str
    endpoint: str
    created_at: datetime


@router.post("", response_model=WebPushSubscriptionResponse, status_code=status.HTTP_201_CREATED)
async def register_push_subscription(
    body: WebPushSubscriptionRequest,
    db: AsyncSession = Depends(get_db),
):
    """Store a web push subscription for a reporter. Upserts by endpoint."""
    try:
        reporter_uuid = uuid.UUID(body.reporter_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid reporter_id")

    # Upsert: if same endpoint already exists, update keys and mark active
    result = await db.execute(
        select(PushToken).where(PushToken.endpoint == body.endpoint)
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.p256dh = body.p256dh
        existing.auth_key = body.auth_key
        existing.is_active = True
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(existing)
        return WebPushSubscriptionResponse(
            id=str(existing.id),
            reporter_id=str(existing.reporter_id),
            endpoint=existing.endpoint,
            created_at=existing.created_at,
        )

    token = PushToken(
        reporter_id=reporter_uuid,
        token=body.endpoint,          # endpoint doubles as the token value
        token_type="web_push",
        platform="pwa",
        endpoint=body.endpoint,
        p256dh=body.p256dh,
        auth_key=body.auth_key,
        is_active=True,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(token)
    await db.commit()
    await db.refresh(token)

    return WebPushSubscriptionResponse(
        id=str(token.id),
        reporter_id=str(token.reporter_id),
        endpoint=token.endpoint,
        created_at=token.created_at,
    )
