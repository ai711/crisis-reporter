from app.models.translation_audit_log import TranslationAuditLog


async def write_translation_audit(
    db,
    event_type: str,
    lang_code: str | None = None,
    string_key: str | None = None,
    details: dict | None = None,
    performed_by: str | None = None,
    dashboard_user_id: str | None = None,
) -> None:
    entry = TranslationAuditLog(
        event_type=event_type,
        lang_code=lang_code,
        string_key=string_key,
        details=details,
        performed_by=performed_by,
        dashboard_user_id=dashboard_user_id,
    )
    db.add(entry)
