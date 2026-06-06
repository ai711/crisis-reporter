from fastapi import APIRouter, Depends, HTTPException, status, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Any, Optional

from app.config import settings as app_config
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.dashboard_user import DashboardUser
from app.services.dependencies import get_current_dashboard_user, require_admin, require_superadmin, require_section_access
from app.services.storage import storage_service

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("/public")
async def get_public_settings(db: AsyncSession = Depends(get_db)):
    """Returns non-sensitive settings readable without authentication."""
    setting = await _get_setting(db, "general")
    support_email = setting.get("support_email", "") if isinstance(setting, dict) else ""
    map_setting = await _get_setting(db, "map")
    building_footprint_source = "osm"
    if isinstance(map_setting, dict):
        building_footprint_source = map_setting.get("building_source", "osm")
    return {
        "support_email": support_email,
        "building_footprint_source": building_footprint_source,
    }

# ── Default values ────────────────────────────────────────────────────────────

DEFAULTS: dict[str, Any] = {
    "general": {
        "org_name": "UNDP",
        "dashboard_title": "Crisis Reporter Dashboard",
        "support_email": "",
        "timezone": "UTC+0",
        "date_format": "DD/MM/YYYY",
        "logo_url": None,
    },
    "security": {
        "session_timeout": 30,
        "max_login_attempts": 5,
        "lockout_duration": 15,
        "password_min_length": 10,
        "require_special_char": True,
        "require_number": True,
        "require_uppercase": True,
        "require_lowercase": True,
        "password_expiry_days": 0,  # 0 = disabled — prevents prototype demo account from expiring
    },
    "notifications": {
        "types": [
            {
                "key": "review_queue_threshold",
                "label": "Review Queue — Red flagged reports threshold exceeded",
                "description": "Triggers when the number of Red-flagged reports in Review Queue Tab 1 exceeds the configured threshold.",
                "active": True,
                "subscribers": [],
                "threshold": 50,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "new_red_flagged_report",
                "label": "New Red-flagged report received",
                "description": "Triggers when any new report receives a Red flag from the automatic check system.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "summary",
                "summary_interval_minutes": 15,
            },
            {
                "key": "reporter_auto_paused",
                "label": "Reporter automatically paused",
                "description": "Triggers when a reporter is automatically paused due to exceeding the submission rate limit.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "high_volume_processing_delay",
                "label": "High volume processing delay",
                "description": "Triggers when the system is processing a high volume of reports and map updates may be delayed.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "grey_flag_processing_delay",
                "label": "Grey flag processing delay",
                "description": "Triggers when the background monitoring job identifies reports stuck in Grey flag status beyond the configured threshold.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "translation_auto_translation_complete",
                "label": "Auto-translation complete",
                "description": "Triggers when a background auto-translation job completes following an English content change.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "auto_block_confirmation_expiring",
                "label": "Auto-block confirmation window expiring",
                "description": "Triggers when a reporter profile in the Review Queue has less than 24 hours remaining in its 72-hour confirmation window.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
            },
            {
                "key": "language_deprecation_expiring",
                "label": "Language deprecation window expiring",
                "description": "Triggers when a deprecated language has less than 7 days remaining before its 90-day hard-removal window expires.",
                "active": True,
                "subscribers": [],
                "threshold": None,
                "delivery_mode": "immediate",
                "summary_interval_minutes": None,
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


async def get_security_settings_dict(db: AsyncSession) -> dict:
    """Public helper — returns current security settings, falling back to DEFAULTS."""
    setting = await _get_setting(db, "security")
    if not isinstance(setting, dict):
        return dict(DEFAULTS["security"])
    merged = dict(DEFAULTS["security"])
    merged.update(setting)
    return merged


async def get_map_settings_dict(db: AsyncSession) -> dict:
    """Public helper — returns current map settings with building_footprint_source derived from building_source."""
    defaults = {
        "reporting_radius_miles": app_config.REPORTING_RADIUS_DEFAULT_MILES,
        "building_source": "osm",
        "building_footprint_source": "osm",
        "country_overrides": {},
    }
    current = await _get_setting(db, "map")
    if not isinstance(current, dict):
        return defaults
    merged = dict(defaults)
    merged.update(current)
    merged["building_footprint_source"] = merged.get("building_source", "osm")
    return merged


# ── General settings ──────────────────────────────────────────────────────────

_ALLOWED_LOGO_TYPES = {"image/jpeg", "image/png", "image/svg+xml"}


@router.get("/general")
async def get_general_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    setting = await _get_setting(db, "general")
    if not isinstance(setting, dict):
        setting = dict(DEFAULTS["general"])
    if "logo_url" not in setting:
        setting["logo_url"] = None
    return setting


@router.patch("/general")
async def patch_general_settings(
    org_name: Optional[str] = Form(None),
    dashboard_title: Optional[str] = Form(None),
    support_email: Optional[str] = Form(None),
    timezone: Optional[str] = Form(None),
    date_format: Optional[str] = Form(None),
    logo: Optional[UploadFile] = File(None),
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    current = await _get_setting(db, "general")
    if not isinstance(current, dict):
        current = dict(DEFAULTS["general"])
    if "logo_url" not in current:
        current["logo_url"] = None

    if org_name is not None:
        current["org_name"] = org_name
    if dashboard_title is not None:
        current["dashboard_title"] = dashboard_title
    if support_email is not None:
        current["support_email"] = support_email
    if timezone is not None:
        current["timezone"] = timezone
    if date_format is not None:
        current["date_format"] = date_format

    if logo and logo.filename:
        if logo.content_type not in _ALLOWED_LOGO_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Logo must be JPEG, PNG, or SVG.",
            )
        logo_bytes = await logo.read()
        storage_path = await storage_service.save(
            logo_bytes, logo.filename, logo.content_type
        )
        current["logo_url"] = storage_service.get_url(storage_path)

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
    require_uppercase: bool | None = None
    require_lowercase: bool | None = None
    password_expiry_days: int | None = None


@router.get("/security")
async def get_security_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    return await get_security_settings_dict(db)


@router.patch("/security")
async def patch_security_settings(
    payload: SecuritySettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    current = await get_security_settings_dict(db)
    updates = payload.model_dump(exclude_none=True)

    if "session_timeout" in updates and not (5 <= updates["session_timeout"] <= 480):
        raise HTTPException(status_code=400, detail="session_timeout must be 5–480 minutes")
    if "max_login_attempts" in updates and not (3 <= updates["max_login_attempts"] <= 10):
        raise HTTPException(status_code=400, detail="max_login_attempts must be 3–10")
    if "password_min_length" in updates and not (8 <= updates["password_min_length"] <= 64):
        raise HTTPException(status_code=400, detail="password_min_length must be 8–64")
    if "password_expiry_days" in updates and updates["password_expiry_days"] < 0:
        raise HTTPException(status_code=400, detail="password_expiry_days must be >= 0")

    current.update(updates)
    await _upsert_setting(db, "security", current)
    return current


# ── Notification settings ─────────────────────────────────────────────────────

class NotificationTypeUpdate(BaseModel):
    key: str
    active: bool | None = None
    subscribers: list[str] | None = None
    threshold: int | None = None
    delivery_mode: str | None = None
    summary_interval_minutes: int | None = None


class NotificationSettingsPayload(BaseModel):
    types: list[NotificationTypeUpdate]


@router.get("/notifications")
async def get_notification_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    stored = await _get_setting(db, "notifications")
    if not isinstance(stored, dict) or "types" not in stored:
        return dict(DEFAULTS["notifications"])
    # Merge: any new default notification types not yet stored are appended
    # so existing databases automatically gain newly-added notification keys.
    stored_keys = {t["key"] for t in stored["types"]}
    merged = list(stored["types"])
    for dt in DEFAULTS["notifications"]["types"]:
        if dt["key"] not in stored_keys:
            merged.append(dict(dt))
    return {"types": merged}


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
        if update.threshold is not None:
            entry["threshold"] = update.threshold
        if update.delivery_mode is not None:
            if update.delivery_mode not in ("immediate", "summary"):
                raise HTTPException(status_code=400, detail="delivery_mode must be 'immediate' or 'summary'")
            entry["delivery_mode"] = update.delivery_mode
        if update.summary_interval_minutes is not None:
            if update.summary_interval_minutes < 5:
                raise HTTPException(status_code=400, detail="summary_interval_minutes must be >= 5")
            entry["summary_interval_minutes"] = update.summary_interval_minutes

    current["types"] = list(existing_types.values())
    await _upsert_setting(db, "notifications", current)
    return current


# ── Map settings ──────────────────────────────────────────────────────────────

class MapSettingsPayload(BaseModel):
    reporting_radius_miles: Optional[int] = None
    building_source: Optional[str] = None
    country_overrides: Optional[dict] = None


@router.get("/map")
async def get_map_settings(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_section_access("app_configuration")),
):
    """Return current map settings. Dashboard auth required."""
    result = await get_map_settings_dict(db)
    return result


@router.patch("/map")
async def patch_map_settings(
    payload: MapSettingsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_admin),
    _section: DashboardUser = Depends(require_section_access("app_configuration", require_edit=True)),
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


# ── System thresholds ─────────────────────────────────────────────────────────

class ThresholdsPayload(BaseModel):
    stuck_report_threshold_minutes: int | None = None
    auto_block_confirmation_hours: int | None = None
    language_deprecation_window_days: int | None = None


def _threshold_defaults() -> dict:
    return {
        "stuck_report_threshold_minutes": app_config.STUCK_REPORT_THRESHOLD_MINUTES,
        "auto_block_confirmation_hours": app_config.AUTO_BLOCK_CONFIRMATION_HOURS,
        "language_deprecation_window_days": app_config.LANGUAGE_DEPRECATION_WINDOW_DAYS,
    }


@router.get("/thresholds")
async def get_thresholds(
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    defaults = _threshold_defaults()
    current = await _get_setting(db, "thresholds")
    if not isinstance(current, dict):
        return defaults
    merged = dict(defaults)
    merged.update(current)
    return merged


@router.patch("/thresholds")
async def patch_thresholds(
    payload: ThresholdsPayload,
    db: AsyncSession = Depends(get_db),
    current_user: DashboardUser = Depends(require_superadmin),
):
    defaults = _threshold_defaults()
    current = await _get_setting(db, "thresholds")
    if not isinstance(current, dict):
        current = dict(defaults)
    else:
        merged = dict(defaults)
        merged.update(current)
        current = merged

    updates = payload.model_dump(exclude_none=True)

    if "stuck_report_threshold_minutes" in updates and not (1 <= updates["stuck_report_threshold_minutes"] <= 60):
        raise HTTPException(status_code=400, detail="stuck_report_threshold_minutes must be 1–60")
    if "auto_block_confirmation_hours" in updates and not (24 <= updates["auto_block_confirmation_hours"] <= 168):
        raise HTTPException(status_code=400, detail="auto_block_confirmation_hours must be 24–168")
    if "language_deprecation_window_days" in updates and not (30 <= updates["language_deprecation_window_days"] <= 365):
        raise HTTPException(status_code=400, detail="language_deprecation_window_days must be 30–365")

    current.update(updates)
    await _upsert_setting(db, "thresholds", current)
    return current


@router.post("/retry-stuck-reports", dependencies=[Depends(require_superadmin)])
async def retry_stuck_reports(db: AsyncSession = Depends(get_db)):
    """Run auto-flagging synchronously for every stuck grey report and return per-report results.
    Errors are returned in the response body so they are never lost to log rate limits."""
    import traceback
    from datetime import datetime, timezone, timedelta
    from app.models.report import Report
    from sqlalchemy import and_
    from app.services.auto_flagging import auto_flag_report

    threshold_minutes = app_config.STUCK_REPORT_THRESHOLD_MINUTES
    stuck_cutoff = datetime.now(timezone.utc) - timedelta(minutes=threshold_minutes)

    result = await db.execute(
        select(Report).where(and_(
            Report.flag_status == "grey",
            Report.created_at <= stuck_cutoff,
        ))
    )
    stuck = result.scalars().all()

    results = []
    for report in stuck:
        report_id = str(report.id)
        try:
            await auto_flag_report(report_id, delay=0)
            # Re-read the flag from DB to confirm what it became
            await db.refresh(report)
            results.append({"report_id": report_id, "status": "ok", "new_flag": report.flag_status})
        except Exception as e:
            results.append({"report_id": report_id, "status": "error", "error": traceback.format_exc()})

    return {"total": len(stuck), "results": results}
