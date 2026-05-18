from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Any, Optional

from app.config import settings as app_config
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user, require_admin, require_superadmin

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("/public")
async def get_public_settings(db: AsyncSession = Depends(get_db)):
    """Returns non-sensitive settings readable without authentication."""
    setting = await _get_setting(db, "general")
    support_email = setting.get("support_email", "") if isinstance(setting, dict) else ""
    return {"support_email": support_email}

# ── Default values ────────────────────────────────────────────────────────────

DEFAULTS: dict[str, Any] = {
    "general": {
        "org_name": "UNDP",
        "dashboard_title": "Crisis Reporter Dashboard",
        "support_email": "",
        "timezone": "UTC+0",
        "date_format": "DD/MM/YYYY",
    },
    "security": {
        "session_timeout": 60,
        "max_login_attempts": 5,
        "lockout_duration": 30,
        "password_min_length": 8,
        "require_special_char": True,
        "require_number": True,
    },
    "notifications": {
        "types": [
            {
                "key": "new_report",
                "label": "New Report Received",
                "description": "Notify when a new report is submitted",
                "active": True,
                "subscribers": [],
            },
            {
                "key": "report_flagged_red",
                "label": "Report Flagged Red",
                "description": "Notify when a report is auto-flagged red",
                "active": True,
                "subscribers": [],
            },
            {
                "key": "reporter_blocked",
                "label": "Reporter Blocked",
                "description": "Notify when a reporter is blocked",
                "active": False,
                "subscribers": [],
            },
            {
                "key": "crisis_activated",
                "label": "Crisis Activated",
                "description": "Notify when a new crisis is set as active",
                "active": True,
                "subscribers": [],
            },
            {
                "key": "export_completed",
                "label": "Export Completed",
                "description": "Notify when a data export is ready to download",
                "active": False,
                "subscribers": [],
            },
            {
                "key": "system_error",
                "label": "System Error",
                "description": "Notify when a backend error is detected",
                "active": True,
                "subscribers": [],
            },
        ]
    },
}


async def _get_setting(db: AsyncSession, key: str) -> Any:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    if row is None:
        return DEFAULTS.get(key, {})
    return row.value


async def _upsert_setting(db: AsyncSession, key: str, value: Any) -> None:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    await db.commit()


# ── General settings ──────────────────────────────────────────────────────────

class GeneralSettingsPayload(BaseModel):
    org_name: str | None = None
    dashboard_title: str | None = None
    support_email: str | None = None
    timezone: str | None = None
    date_format: str | None = None


@router.get("/general")
async def get_general_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    return await _get_setting(db, "general")


@router.patch("/general")
async def patch_general_settings(
    payload: GeneralSettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    current = await _get_setting(db, "general")
    updates = payload.model_dump(exclude_none=True)
    current.update(updates)
    await _upsert_setting(db, "general", current)
    return current


# ── Security settings ─────────────────────────────────────────────────────────

class SecuritySettingsPayload(BaseModel):
    session_timeout: int | None = None
    max_login_attempts: int | None = None
    lockout_duration: int | None = None
    password_min_length: int | None = None
    require_special_char: bool | None = None
    require_number: bool | None = None


@router.get("/security")
async def get_security_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    return await _get_setting(db, "security")


@router.patch("/security")
async def patch_security_settings(
    payload: SecuritySettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    current = await _get_setting(db, "security")
    updates = payload.model_dump(exclude_none=True)

    if "session_timeout" in updates and not (15 <= updates["session_timeout"] <= 480):
        raise HTTPException(status_code=400, detail="session_timeout must be 15–480 minutes")
    if "max_login_attempts" in updates and not (3 <= updates["max_login_attempts"] <= 10):
        raise HTTPException(status_code=400, detail="max_login_attempts must be 3–10")
    if "password_min_length" in updates and not (6 <= updates["password_min_length"] <= 32):
        raise HTTPException(status_code=400, detail="password_min_length must be 6–32")

    current.update(updates)
    await _upsert_setting(db, "security", current)
    return current


# ── Notification settings ─────────────────────────────────────────────────────

class NotificationTypeUpdate(BaseModel):
    key: str
    active: bool | None = None
    subscribers: list[str] | None = None


class NotificationSettingsPayload(BaseModel):
    types: list[NotificationTypeUpdate]


@router.get("/notifications")
async def get_notification_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    return await _get_setting(db, "notifications")


@router.patch("/notifications")
async def patch_notification_settings(
    payload: NotificationSettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    current = await _get_setting(db, "notifications")
    existing_types = {t["key"]: t for t in current.get("types", [])}

    for update in payload.types:
        if update.key not in existing_types:
            raise HTTPException(status_code=404, detail=f"Notification type '{update.key}' not found")
        entry = existing_types[update.key]
        if update.active is not None:
            entry["active"] = update.active
        if update.subscribers is not None:
            entry["subscribers"] = update.subscribers

    current["types"] = list(existing_types.values())
    await _upsert_setting(db, "notifications", current)
    return current


# ── Map settings ──────────────────────────────────────────────────────────────

class MapSettingsPayload(BaseModel):
    reporting_radius_miles: Optional[int] = None
    building_source: Optional[str] = None
    country_overrides: Optional[dict] = None  # country_code → radius in miles


@router.get("/map")
async def get_map_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(get_current_dashboard_user),
):
    """Return current map settings. Dashboard auth required."""
    defaults = {
        "reporting_radius_miles": app_config.REPORTING_RADIUS_DEFAULT_MILES,
        "building_source": "osm",
        "country_overrides": {},
    }
    current = await _get_setting(db, "map")
    if not isinstance(current, dict):
        return defaults
    defaults.update(current)
    return defaults


@router.patch("/map")
async def patch_map_settings(
    payload: MapSettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
):
    """Update map settings. Admin only."""
    defaults = {
        "reporting_radius_miles": app_config.REPORTING_RADIUS_DEFAULT_MILES,
        "building_source": "osm",
        "country_overrides": {},
    }
    current = await _get_setting(db, "map")
    if not isinstance(current, dict):
        current = defaults
    else:
        merged = dict(defaults)
        merged.update(current)
        current = merged

    updates = payload.model_dump(exclude_none=True)
    current.update(updates)
    await _upsert_setting(db, "map", current)
    return current
