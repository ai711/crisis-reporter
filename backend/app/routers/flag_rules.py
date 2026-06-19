"""Flag rules router.

Exposes the auto-flagging thresholds to the UNDP dashboard so staff can
read and update them without a code deployment.

GET  /api/flag-rules  — any authenticated dashboard user
PATCH /api/flag-rules  — Admin only
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from typing import Optional

from app.services.dependencies import get_current_dashboard_user, require_admin
from app.services.auto_flagging import get_thresholds, update_thresholds

router = APIRouter(prefix="/api/flag-rules", tags=["Flag Rules"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class FlagRulesResponse(BaseModel):
    duplicate_radius_degrees: float = Field(
        description="GPS radius (degrees) within which two reports are considered duplicates (~0.001° ≈ 100 m)"
    )
    duplicate_window_hours: int = Field(
        description="Time window (hours) for duplicate detection"
    )
    rapid_submission_count: int = Field(
        description="Reports-in-window threshold; triggers on the (count+1)th submission"
    )
    rapid_submission_window_hours: int = Field(
        description="Time window (hours) for rapid submission detection"
    )
    gps_duplicate_enabled: bool = Field(
        description="Rule 5 — GPS duplicate check (disabled by default; legitimate reporters often report the same location)"
    )


class FlagRulesUpdate(BaseModel):
    duplicate_radius_degrees: Optional[float] = Field(
        default=None, gt=0,
        description="New duplicate GPS radius in degrees"
    )
    duplicate_window_hours: Optional[int] = Field(
        default=None, gt=0,
        description="New duplicate detection window in hours"
    )
    rapid_submission_count: Optional[int] = Field(
        default=None, gt=0,
        description="New maximum reports-per-window threshold"
    )
    rapid_submission_window_hours: Optional[int] = Field(
        default=None, gt=0,
        description="New rapid submission window in hours"
    )
    gps_duplicate_enabled: Optional[bool] = Field(
        default=None,
        description="Enable or disable Rule 5 (GPS duplicate detection)"
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=FlagRulesResponse)
async def get_flag_rules(
    _=Depends(get_current_dashboard_user),
):
    """Return the currently active auto-flagging thresholds."""
    return FlagRulesResponse(**get_thresholds())


@router.patch("", response_model=FlagRulesResponse)
async def patch_flag_rules(
    body: FlagRulesUpdate,
    _=Depends(require_admin),
):
    """Update one or more auto-flagging thresholds. Admin only.

    Omit a field to leave its current value unchanged.
    Changes take effect immediately for all subsequent submissions;
    they are not persisted across restarts.
    """
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if updates:
        update_thresholds(**updates)
    return FlagRulesResponse(**get_thresholds())
