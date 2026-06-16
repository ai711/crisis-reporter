"""Dashboard notification bell endpoints.

GET  /api/notifications            — unread notifications for current user (up to 10)
POST /api/notifications/{id}/read  — mark one notification read
POST /api/notifications/mark-all-read — mark all unread as read
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.database import get_db
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])


@router.get("")
async def get_notifications(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return up to 10 unread notifications for the current user."""
    result = await db.execute(
        text("""
            SELECT n.id, n.notification_type_key, n.message, n.triggered_at
            FROM notifications n
            WHERE (n.is_global = TRUE OR n.target_user_id = :user_id::uuid)
              AND NOT EXISTS (
                SELECT 1 FROM notification_reads nr
                WHERE nr.notification_id = n.id
                  AND nr.dashboard_user_id = :user_id
              )
            ORDER BY n.triggered_at DESC
            LIMIT 10
        """),
        {"user_id": str(current_user.id)},
    )
    rows = result.mappings().all()
    return {
        "notifications": [
            {
                "id": r["id"],
                "type_key": r["notification_type_key"],
                "message": r["message"],
                "triggered_at": r["triggered_at"].isoformat() if r["triggered_at"] else None,
            }
            for r in rows
        ],
        "unread_count": len(rows),
    }


@router.post("/{notification_id}/read")
async def mark_notification_read(
    notification_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Mark a single notification as read for the current user."""
    exists = await db.execute(
        text("SELECT id FROM notifications WHERE id = :nid"),
        {"nid": notification_id},
    )
    if not exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Notification not found")
    await db.execute(
        text("""
            INSERT INTO notification_reads (notification_id, dashboard_user_id, read_at)
            VALUES (:nid, :uid, NOW())
            ON CONFLICT DO NOTHING
        """),
        {"nid": notification_id, "uid": str(current_user.id)},
    )
    await db.commit()
    return {"success": True}


@router.post("/mark-all-read")
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Mark all unread global notifications as read for the current user."""
    await db.execute(
        text("""
            INSERT INTO notification_reads (notification_id, dashboard_user_id, read_at)
            SELECT n.id, :uid, NOW()
            FROM notifications n
            WHERE n.is_global = TRUE
              AND NOT EXISTS (
                SELECT 1 FROM notification_reads nr
                WHERE nr.notification_id = n.id
                  AND nr.dashboard_user_id = :uid
              )
            ON CONFLICT DO NOTHING
        """),
        {"uid": str(current_user.id)},
    )
    await db.commit()
    return {"success": True}
