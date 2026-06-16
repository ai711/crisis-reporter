import asyncio
import logging
import secrets
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
from sqlalchemy import select, text
from app.config import settings
from app.database import engine, Base, AsyncSessionLocal

logger = logging.getLogger(__name__)

# Import all models so SQLAlchemy registers them
import app.models

# Import routers
from app.routers import (
    dashboard_auth,
    dashboard_users,
    reporter_auth,
    reporters,
    crises,
    reports,
    photos,
    dashboard_reports,
    dashboard_reporters,
    dashboard_map,
    dashboard_properties,
    dashboard_projects,
    analytics,
    exports,
    question_packages,
    flag_rules,
    language_packages,
    push_tokens,
    roles,
    health as health_router,
    app_settings,
    content,
    countries,
    review_queue,
    notifications as notifications_router,
    dashboard_sse,
)
from app.routers.question_packages import seed_initial_package
from app.routers.language_packages import seed_string_keys, ensure_string_keys_synced
from app.routers.countries import seed_countries


async def _seed_notification_types() -> None:
    """Ensure the notifications AppSetting has the 4 correct Chapter 13 types.
    Replaces any old notification types from previous chapters."""
    from app.models.app_setting import AppSetting
    correct_keys = {
        "review_queue_threshold", "new_red_flagged_report",
        "reporter_auto_paused", "high_volume_processing_delay",
    }
    correct_types = [
        {
            "key": "review_queue_threshold",
            "label": "Review Queue — Red flagged reports threshold exceeded",
            "description": "Triggers when the number of Red-flagged reports in Review Queue Tab 1 exceeds the configured threshold.",
            "active": True, "subscribers": [], "threshold": 50,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
        {
            "key": "new_red_flagged_report",
            "label": "New Red-flagged report received",
            "description": "Triggers when any new report receives a Red flag from the automatic check system.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "summary", "summary_interval_minutes": 15,
        },
        {
            "key": "reporter_auto_paused",
            "label": "Reporter automatically paused",
            "description": "Triggers when a reporter is automatically paused due to exceeding the submission rate limit.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
        {
            "key": "high_volume_processing_delay",
            "label": "High volume processing delay",
            "description": "Triggers when the system is processing a high volume of reports and map updates may be delayed.",
            "active": True, "subscribers": [], "threshold": None,
            "delivery_mode": "immediate", "summary_interval_minutes": None,
        },
    ]
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(AppSetting).where(AppSetting.key == "notifications"))
        row = result.scalar_one_or_none()
        if row is None:
            db.add(AppSetting(key="notifications", value={"types": correct_types}))
            await db.commit()
            return
        existing = row.value if isinstance(row.value, dict) else {}
        old_types = {t["key"]: t for t in existing.get("types", [])}
        # Remove old keys not in correct set; preserve subscriber/active state for existing correct keys
        merged = []
        for ct in correct_types:
            if ct["key"] in old_types:
                kept = dict(ct)
                # Preserve user-configured fields
                old = old_types[ct["key"]]
                for field in ("active", "subscribers", "threshold", "delivery_mode", "summary_interval_minutes"):
                    if field in old and old[field] is not None:
                        kept[field] = old[field]
                merged.append(kept)
            else:
                merged.append(ct)
        row.value = {"types": merged}
        await db.commit()
        logger.info("Notification types seeded/updated to Chapter 13 spec")


async def _seed_safety_tips_content() -> None:
    """Seed rich multi-slide safety tips content for all 9 disaster types and Parts B/C.

    Rules:
    - Only inserts an AppSetting row when none exists — never overwrites admin edits.
    - Part A slides are stored as {title, dos, donts} so the mobile slide renderer can
      display the DO / DON'T labels correctly.
    - Part B / Part C slides are stored as {title, bullets}.
    - After seeding, triggers StringKey creation for each disaster so the auto-translation
      pipeline can produce translated versions for all active languages.
    """
    from app.models.app_setting import AppSetting

    # ── Part A — 9 disaster types × 7 slides each ─────────────────────────────
    # Format: {"title": str, "dos": [str, ...], "donts": [str, ...]}
    # Tiles have the Do:/Don't: prefix stripped; bullets placed in the correct array.

    _DISASTER_SLIDES: dict[str, list[dict]] = {
        "earthquake": [
            {"title": "Drop and Take Cover",
             "dos": ["Drop to your hands and knees immediately",
                     "Take cover under a sturdy table or desk, or against an interior wall away from windows"],
             "donts": []},
            {"title": "Hold On and Stay Put",
             "dos": ["Hold on and protect your head and neck with your arms",
                     "Stay where you are until the shaking stops — most injuries happen when people try to move"],
             "donts": []},
            {"title": "Move Away from Outdoor Hazards",
             "dos": ["If outdoors, move away from buildings, streetlights, and utility wires",
                     "If in a vehicle, pull over away from buildings and overpasses and stay inside"],
             "donts": []},
            {"title": "After the Shaking Stops",
             "dos": ["After shaking stops, check yourself and others for injuries before moving",
                     "Expect aftershocks — drop, cover, and hold on each time"],
             "donts": []},
            {"title": "Run Outside or Use Doorways",
             "dos": [],
             "donts": ["Do not run outside while shaking is happening — most injuries occur when people try to move during shaking",
                       "Do not stand in a doorway — doorways offer no special protection"]},
            {"title": "Use Elevators or Open Flames",
             "dos": [],
             "donts": ["Do not use elevators after an earthquake — use stairs only",
                       "Do not light candles, matches, or any open flame — gas pipes may be damaged"]},
            {"title": "Re-enter or Spread Rumours",
             "dos": [],
             "donts": ["Do not return to a damaged building until declared structurally safe",
                       "Do not spread unverified information — only share from official sources"]},
        ],
        "flood": [
            {"title": "Move to Higher Ground",
             "dos": ["Move immediately to higher ground if flooding is imminent",
                     "Turn off utilities at the main switch if safe to do so"],
             "donts": []},
            {"title": "Disconnect Appliances and Evacuate",
             "dos": ["Disconnect electrical appliances — do not touch them if wet or standing in water",
                     "If evacuation is ordered, leave immediately with your emergency kit"],
             "donts": []},
            {"title": "If Trapped, Signal for Help",
             "dos": ["If trapped, move to the highest floor and signal for help from a window",
                     "Drink only bottled or boiled water — floodwater contaminates supplies"],
             "donts": []},
            {"title": "Protect Yourself and Monitor Updates",
             "dos": ["Wear rubber boots and waterproof gloves if walking through floodwater",
                     "Listen to official emergency broadcasts for updates and evacuation routes"],
             "donts": []},
            {"title": "Walk or Drive Through Floodwater",
             "dos": [],
             "donts": ["Do not walk through moving floodwater — 15 cm of fast-moving water can knock an adult down",
                       "Do not drive through flooded roads — water depth is impossible to judge"]},
            {"title": "Touch Floodwater or Return Too Soon",
             "dos": [],
             "donts": ["Do not touch floodwater if avoidable — it may contain sewage, chemicals, or debris",
                       "Do not return home until authorities declare it safe"]},
            {"title": "Use Damaged Appliances or Ignore Orders",
             "dos": [],
             "donts": ["Do not use electrical equipment that has been in contact with floodwater",
                       "Do not ignore evacuation orders — each flood event is different"]},
        ],
        "tsunami": [
            {"title": "Move to Higher Ground Immediately",
             "dos": ["If you feel a strong earthquake near the coast, move immediately to higher ground — do not wait for a warning",
                     "A sudden recession of the sea is a natural warning sign — move inland immediately"],
             "donts": []},
            {"title": "Move on Foot and Seek High Ground",
             "dos": ["Move on foot if possible — roads may be congested or damaged",
                     "Go to a designated tsunami evacuation zone or the highest ground available"],
             "donts": []},
            {"title": "If Caught in a Wave",
             "dos": ["If caught in a wave, grab onto something that floats",
                     "After the first wave, stay where you are — later waves are often larger"],
             "donts": []},
            {"title": "Wait for the Official All-Clear",
             "dos": ["Listen to official broadcasts — an all-clear must come from authorities before returning",
                     "Help others move to higher ground only if you can do so safely"],
             "donts": []},
            {"title": "Go to the Coast or Assume It's Over",
             "dos": [],
             "donts": ["Do not go to the coast to watch the tsunami — people who do are frequently killed",
                       "Do not assume danger is over after the first wave — subsequent waves can arrive for hours"]},
            {"title": "Use Bridges or Return Too Soon",
             "dos": [],
             "donts": ["Do not use bridges or low-lying roads during or after a tsunami warning",
                       "Do not return to coastal areas until authorities issue a formal all-clear"]},
            {"title": "Rely Solely on Sirens or Drive Through Zones",
             "dos": [],
             "donts": ["Do not rely solely on sirens — if you feel a large earthquake near the coast, act immediately",
                       "Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away"]},
        ],
        "hurricane_cyclone": [
            {"title": "Follow Evacuation Orders",
             "dos": ["Follow evacuation orders immediately when issued",
                     "Board up windows and secure outdoor furniture before the storm arrives"],
             "donts": []},
            {"title": "Prepare Emergency Supplies",
             "dos": ["Prepare an emergency kit with water, food, medications, flashlight — enough for 72 hours",
                     "Fill clean containers with drinking water before the storm — supplies may be disrupted"],
             "donts": []},
            {"title": "Stay Indoors During the Storm",
             "dos": ["Stay indoors during the storm, away from windows and glass doors",
                     "If the eye passes over, stay sheltered — dangerous winds will return from the opposite direction"],
             "donts": []},
            {"title": "After the Storm",
             "dos": ["After the storm, check your home for structural damage before entering",
                     "Listen to official broadcasts for road conditions and public health guidance"],
             "donts": []},
            {"title": "Go Outside During the Storm",
             "dos": [],
             "donts": ["Do not go outside during the storm — flying debris causes most hurricane fatalities",
                       "Do not assume the storm is over if winds suddenly calm — the eye passes quickly"]},
            {"title": "Use Generators Indoors or Touch Downed Lines",
             "dos": [],
             "donts": ["Do not use generators or charcoal grills indoors — carbon monoxide poisoning is a leading cause of post-hurricane deaths",
                       "Do not touch downed power lines or walk through standing water near them"]},
            {"title": "Drive Through Flooding or Return Too Soon",
             "dos": [],
             "donts": ["Do not drive through flooded roads — hurricane flooding is extensive",
                       "Do not return to evacuated areas until authorities declare it safe"]},
        ],
        "wildfire": [
            {"title": "Evacuate Immediately When Ordered",
             "dos": ["If you receive an evacuation order, leave immediately — wildfires change direction rapidly",
                     "Close all windows and doors as you leave to slow fire entering — leave them unlocked for emergency responders"],
             "donts": []},
            {"title": "Protect Yourself While Evacuating",
             "dos": ["Wear a mask or cover your nose and mouth with a damp cloth while evacuating",
                     "Take your emergency kit, medications, important documents, and pets if you can do so quickly"],
             "donts": []},
            {"title": "If There Is No Escape Route",
             "dos": ["If caught with no escape route, shelter in a building or lie face down in a ditch away from vegetation",
                     "Breathe through your nose — nasal passages filter more smoke than mouth breathing"],
             "donts": []},
            {"title": "After a Wildfire",
             "dos": ["After a wildfire, check your roof for embers before re-entering — embers can smoulder for hours",
                     "Wear a mask and gloves when working in ash — it may contain toxic materials"],
             "donts": []},
            {"title": "Ignore Orders or Re-enter Too Soon",
             "dos": [],
             "donts": ["Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run",
                       "Do not re-enter evacuated areas until declared safe — hidden hot spots can reignite"]},
            {"title": "Park Under Trees or Use Contaminated Water",
             "dos": [],
             "donts": ["Do not park under trees during or after a wildfire — weakened trees can fall without warning",
                       "Do not use water that may be contaminated by fire retardants — use bottled water only"]},
            {"title": "Inhale Ash or Fight the Fire Yourself",
             "dos": [],
             "donts": ["Do not inhale ash unnecessarily — wear a properly fitted particulate mask where available",
                       "Do not attempt to fight a wildfire yourself — evacuate and let trained firefighters handle it"]},
        ],
        "explosion": [
            {"title": "Take Cover Immediately",
             "dos": ["Immediately take cover behind a solid object or drop to the ground face down",
                     "Cover your head and neck with your arms to protect from debris"],
             "donts": []},
            {"title": "Move Away and Help If Safe",
             "dos": ["Once the immediate danger passes, move away from the site quickly and calmly",
                     "Help injured people move away only if you can do so safely without putting yourself at risk"],
             "donts": []},
            {"title": "Seek Medical Attention and Report",
             "dos": ["Seek medical attention for any injuries — blast injuries may not be immediately visible",
                     "Report the explosion to emergency services as soon as you are in a safe location"],
             "donts": []},
            {"title": "Follow Official Instructions",
             "dos": ["Follow instructions from emergency services and authorities on the ground",
                     "Stay upwind of the explosion site to avoid inhaling smoke or chemical fumes"],
             "donts": []},
            {"title": "Return to the Site or Use Phones Near Gas",
             "dos": [],
             "donts": ["Do not return to the explosion site — secondary explosions are common",
                       "Do not use mobile phones or electrical switches near a gas leak — sparks can trigger another explosion"]},
            {"title": "Touch Debris or Spread Rumours",
             "dos": [],
             "donts": ["Do not touch suspicious packages or debris around the site",
                       "Do not post unverified information about the cause — this can spread panic"]},
            {"title": "Block Access or Enter Damaged Buildings",
             "dos": [],
             "donts": ["Do not block emergency service access routes",
                       "Do not enter damaged buildings — structural collapse risk is high after an explosion"]},
        ],
        "chemical_incident": [
            {"title": "Move Upwind or Shelter in Place",
             "dos": ["Move upwind and uphill from the incident immediately",
                     "If indoors, shelter in place — close all windows, doors, and ventilation systems"],
             "donts": []},
            {"title": "Decontaminate and Cover Your Mouth",
             "dos": ["If you have been exposed, remove outer clothing and wash skin thoroughly with water",
                     "Cover your nose and mouth with a wet cloth if you must move through contaminated air"],
             "donts": []},
            {"title": "Follow Evacuation Instructions",
             "dos": ["Follow evacuation instructions from emergency services exactly",
                     "Seek medical attention even if you feel well — chemical exposure symptoms can be delayed"],
             "donts": []},
            {"title": "Monitor Updates and Flush Eyes If Needed",
             "dos": ["Listen to official broadcasts for information on safe zones and decontamination points",
                     "If your eyes are burning, flush them with clean water for at least 15 minutes"],
             "donts": []},
            {"title": "Approach the Source or Eat Nearby",
             "dos": [],
             "donts": ["Do not approach the source of a chemical incident — even brief exposure can be fatal",
                       "Do not eat, drink, or smoke in or near the affected area"]},
            {"title": "Trust Your Nose or Re-enter Too Soon",
             "dos": [],
             "donts": ["Do not rely on smell to determine safety — many hazardous chemicals are odourless",
                       "Do not re-enter the affected area until authorities declare it safe"]},
            {"title": "Spread Rumours or Remove Protective Gear",
             "dos": [],
             "donts": ["Do not spread rumours about the cause — chemical incidents cause significant public panic",
                       "Do not remove protective clothing given by emergency services until instructed"]},
        ],
        "conflict": [
            {"title": "Find Cover and Stay Away from Windows",
             "dos": ["If caught in an active conflict zone, find cover immediately — lie flat behind a solid structure",
                     "Stay away from windows, doors, and open spaces during active shooting or shelling"],
             "donts": []},
            {"title": "Follow Legitimate Authority and Move Safely",
             "dos": ["Follow instructions from legitimate security forces or humanitarian organisations",
                     "If evacuating, move quickly and low, using buildings and terrain as cover"],
             "donts": []},
            {"title": "Keep an Emergency Bag Ready",
             "dos": ["Keep an emergency bag ready with documents, water, food, and medications",
                     "Identify safe exit routes from your home and neighbourhood in advance"],
             "donts": []},
            {"title": "Shelter in Place and Conserve Power",
             "dos": ["If sheltering in place, move to an interior room away from windows on the lowest floor",
                     "Conserve phone battery and charge devices whenever power is available"],
             "donts": []},
            {"title": "Film Military or Touch Unexploded Ordnance",
             "dos": [],
             "donts": ["Do not film or photograph military personnel or equipment — this can put you at serious risk",
                       "Do not approach unexploded ordnance or debris — mark the location and report it"]},
            {"title": "Use Open Flames or Post Your Location",
             "dos": [],
             "donts": ["Do not use open flames at night — light can attract attention in conflict zones",
                       "Do not spread your location on social media during active conflict"]},
            {"title": "Cross Front Lines or Ignore Curfews",
             "dos": [],
             "donts": ["Do not attempt to cross front lines or enter restricted areas",
                       "Do not ignore curfews or movement restrictions imposed by authorities"]},
        ],
        "civil_unrest": [
            {"title": "Move Calmly to the Edges",
             "dos": ["If caught in a crowd disturbance, move calmly to the edges and away from the crowd",
                     "Stay aware of your surroundings and identify exit routes before any situation escalates"],
             "donts": []},
            {"title": "If Tear Gas Is Used",
             "dos": ["If tear gas is used, move upwind and flush eyes with clean water",
                     "Cover your nose and mouth with a wet cloth to reduce inhalation of irritants"],
             "donts": []},
            {"title": "Stay in Contact and Follow Instructions",
             "dos": ["Stay in contact with family or trusted contacts about your location",
                     "Follow instructions from police or security forces unless doing so puts you at immediate risk"],
             "donts": []},
            {"title": "Observe Safely and Document from a Distance",
             "dos": ["If you are a reporter or observer, identify yourself clearly and stay to the periphery",
                     "Document damage and injuries only from a safe distance"],
             "donts": []},
            {"title": "Engage or Blend In With Crowds",
             "dos": [],
             "donts": ["Do not engage with crowds or attempt to intervene in confrontations",
                       "Do not wear clothing that could be mistaken for that of any group involved"]},
            {"title": "Share Real-Time Movements or Use Flash",
             "dos": [],
             "donts": ["Do not share real-time location of security forces or crowd movements on social media",
                       "Do not use flash photography in tense situations — it can provoke a response"]},
            {"title": "Block Emergency Routes or Spread Rumours",
             "dos": [],
             "donts": ["Do not block emergency vehicle access routes",
                       "Do not spread unverified reports of casualties or causes — this escalates tensions"]},
        ],
    }

    # ── Part B — Reporting Guidelines (5 slides) ──────────────────────────────
    _PART_B_SLIDES: list[dict] = [
        {"title": "Only Report What You Can Safely See",
         "bullets": ["Never put yourself in danger to get closer to an incident. If you cannot see it from a safe distance, do not report it.",
                     "Your safety is more valuable than any report. Accurate reporting from a safe vantage point is always better than no report at all."]},
        {"title": "Take Clear Photos from a Safe Distance",
         "bullets": ["Use zoom rather than approaching the damage. A clear photo from 20 metres is more useful than a blurred one from 5 metres.",
                     "Photograph the full structure, not just the damage. Context — surrounding buildings, street layout — is essential for assessment."]},
        {"title": "Be Accurate with Location — Use GPS When Possible",
         "bullets": ["Enable GPS on your device before reaching the site. Allow the app to auto-detect your location for the highest accuracy.",
                     "If GPS is unavailable, note the building name, street address, or a nearby landmark to allow accurate manual geo-coding."]},
        {"title": "One Report Per Building — No Duplicates",
         "bullets": ["Submit only one report per building per visit. Duplicate reports waste analyst time and distort damage statistics.",
                     "If conditions have changed significantly since your last report on a building, submit an update rather than a new report."]},
        {"title": "Your Identity is Protected — Reports Are Anonymised",
         "bullets": ["Your name, email, and device information are encrypted at rest and never included in exported datasets.",
                     "Reports shared with humanitarian organisations contain only location data, damage classification, and timestamps — never personal identifiers."]},
    ]

    # ── Part C — First Aid Tips (6 slides) ────────────────────────────────────
    _PART_C_SLIDES: list[dict] = [
        {"title": "Controlling Bleeding",
         "bullets": ["Apply firm, direct pressure to the wound with a clean cloth or bandage and maintain it continuously for at least 10 minutes.",
                     "Elevate the injured limb above heart level if possible. Do not remove the cloth — add more on top if it soaks through."]},
        {"title": "Recovery Position",
         "bullets": ["Place an unconscious, breathing person on their side with their top knee bent forward to prevent them rolling back.",
                     "Tilt their head back gently to open the airway, and place their hand under their cheek. Monitor breathing continuously."]},
        {"title": "Treating Shock",
         "bullets": ["Lay the person flat and, if not injured, raise their legs 20–30 cm above heart level to improve blood flow to vital organs.",
                     "Keep them warm with a blanket. Do not give food or water. Reassure them calmly and monitor their breathing until help arrives."]},
        {"title": "Burns Treatment",
         "bullets": ["Cool the burn immediately under cool (not cold) running water for at least 20 minutes. Remove jewellery near the burn if possible.",
                     "Cover the burn loosely with cling film or a clean non-fluffy material. Do not apply butter, toothpaste, or ice."]},
        {"title": "Fractures and Immobilisation",
         "bullets": ["Do not attempt to straighten a fractured limb. Immobilise it in the position found using a splint and soft padding.",
                     "A splint can be improvised from a straight stick, rolled newspaper, or folded clothing tied firmly — not tightly — above and below the fracture."]},
        {"title": "When Not to Move an Injured Person",
         "bullets": ["Do not move someone who may have a spinal injury (high-impact trauma, neck pain, tingling/numbness) unless they are in immediate danger.",
                     "If you must move them, keep the head, neck, and spine aligned at all times and use multiple people to maintain a straight carry."]},
    ]

    seeded_disasters: list[str] = []
    seeded_b = False
    seeded_c = False

    async with AsyncSessionLocal() as db:
        # ── Part A ─────────────────────────────────────────────────────────────
        for disaster_type, slides_data in _DISASTER_SLIDES.items():
            key = f"content_safety-tips_{disaster_type}"
            row = (await db.execute(select(AppSetting).where(AppSetting.key == key))).scalar_one_or_none()
            if row is None:
                db.add(AppSetting(key=key, value={
                    "slides": slides_data,
                    "version": 1,
                    "updated_at": None,
                }))
                seeded_disasters.append(disaster_type)

        # ── Part B ─────────────────────────────────────────────────────────────
        row_b = (await db.execute(
            select(AppSetting).where(AppSetting.key == "content_reporting-guidelines")
        )).scalar_one_or_none()
        if row_b is None:
            db.add(AppSetting(key="content_reporting-guidelines", value={
                "slides": _PART_B_SLIDES,
                "version": 1,
                "updated_at": None,
            }))
            seeded_b = True

        # ── Part C ─────────────────────────────────────────────────────────────
        row_c = (await db.execute(
            select(AppSetting).where(AppSetting.key == "content_first-aid")
        )).scalar_one_or_none()
        if row_c is None:
            db.add(AppSetting(key="content_first-aid", value={
                "slides": _PART_C_SLIDES,
                "version": 1,
                "updated_at": None,
            }))
            seeded_c = True

        if seeded_disasters or seeded_b or seeded_c:
            await db.commit()

    if seeded_disasters:
        logger.info("Safety tips content seeded for: %s", ", ".join(seeded_disasters))
    if seeded_b:
        logger.info("Reporting guidelines (Part B) content seeded")
    if seeded_c:
        logger.info("First aid (Part C) content seeded")

    # Kick off StringKey creation + auto-translation for newly seeded content.
    # Runs in the background — safe to fail gracefully if translation service is unavailable.
    if seeded_disasters or seeded_b or seeded_c:
        async def _run_translation_sync() -> None:
            from app.routers.content import (
                _sync_safety_tips_to_translation,
                _sync_slideshow_to_translation,
            )
            async with AsyncSessionLocal() as db:
                for dt in seeded_disasters:
                    try:
                        await _sync_safety_tips_to_translation(dt, _DISASTER_SLIDES[dt], db)
                    except Exception as exc:
                        logger.warning("Translation sync skipped for %s: %s", dt, exc)
            if seeded_b:
                async with AsyncSessionLocal() as db:
                    try:
                        await _sync_slideshow_to_translation("B", _PART_B_SLIDES, db)
                    except Exception as exc:
                        logger.warning("Translation sync skipped for Part B: %s", exc)
            if seeded_c:
                async with AsyncSessionLocal() as db:
                    try:
                        await _sync_slideshow_to_translation("C", _PART_C_SLIDES, db)
                    except Exception as exc:
                        logger.warning("Translation sync skipped for Part C: %s", exc)

        asyncio.create_task(_run_translation_sync())


async def seed_first_admin() -> None:
    """Create an admin user from FIRST_ADMIN_EMAIL / FIRST_ADMIN_PASSWORD env vars
    if no admin users exist yet. Safe to run every startup — no-op once an admin exists."""
    email = getattr(settings, "FIRST_ADMIN_EMAIL", None)
    password = getattr(settings, "FIRST_ADMIN_PASSWORD", None)
    if not email or not password:
        return
    from app.models.dashboard_user import DashboardUser
    from app.routers.dashboard_auth import hash_password
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(DashboardUser).where(DashboardUser.role.in_(["admin", "superadmin"]))
        )
        if result.scalars().first():
            return
        user = DashboardUser(
            email=email.lower().strip(),
            full_name="Administrator",
            password_hash=hash_password(password),
            role="admin",
        )
        db.add(user)
        await db.commit()
        logger.info("Bootstrap admin created: %s", email)


async def _seed_default_roles() -> None:
    """Create the two system default roles if they do not already exist."""
    try:
        from app.models.role import Role
        # Keys must match the SECTIONS keys used in the frontend permissions table
        all_sections = [
            "main_map_view", "reports_page", "location_page", "review_queue",
            "analytics_and_statistics", "reporter_profiles", "export", "projects",
            "manage_users", "manage_roles", "app_configuration", "content_management",
        ]
        superadmin_permissions = {s: {"view": True, "edit": True} for s in all_sections}
        guest_permissions = {"projects": {"view": True, "edit": False}}

        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Role).where(Role.is_default == True))
            existing_names = {r.name for r in result.scalars().all()}

            if "Superadmin" not in existing_names:
                db.add(Role(
                    name="Superadmin",
                    is_default=True,
                    permissions=superadmin_permissions,
                    description="Full access to all dashboard sections. Cannot be modified.",
                ))
            if "Guest" not in existing_names:
                db.add(Role(
                    name="Guest",
                    is_default=True,
                    permissions=guest_permissions,
                    description="View-only access to explicitly assigned projects. No other sections visible.",
                ))
            await db.commit()
        logger.info("Default roles seeded")
    except Exception as e:
        logger.error("_seed_default_roles failed: %s", e)


async def _seed_default_crisis() -> None:
    """Create a default active crisis if no active crisis exists.

    The reporter PWA and Android app call GET /api/crises/active on mount.
    If the list is empty they show a blocking error screen. This seed ensures
    at least one active crisis exists from first startup so reporters can
    submit immediately without a dashboard admin having to create one first.

    The default crisis has no country restriction (countries=[]) so any
    reporter, regardless of selected country, can submit to it.

    Safe to run every startup — no-op once any active crisis exists.
    """
    try:
        from app.models.crisis import Crisis, format_serial_id
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Crisis).where(Crisis.status == "active").limit(1)
            )
            if result.scalar_one_or_none():
                return  # Active crisis already exists — nothing to do

            # Allocate a serial number from the same sequence used by dashboard
            serial_num_res = await db.execute(text("SELECT nextval('crisis_serial_seq')"))
            serial_num = serial_num_res.scalar()
            serial_id = format_serial_id(serial_num)

            crisis = Crisis(
                serial_number=serial_num,
                serial_id=serial_id,
                name="Crisis Response Operation",
                description=(
                    "Default operational crisis created at system startup. "
                    "Replace or supplement with a named crisis from the Projects page."
                ),
                countries=[],
                status="active",
                is_active=True,
                map_default_radius_miles=50,
            )
            db.add(crisis)
            await db.commit()
            logger.info("Default active crisis seeded: %s (%s)", serial_id, crisis.id)
    except Exception as e:
        logger.error("_seed_default_crisis failed: %s", e)


async def _stuck_report_loop() -> None:
    """Run stuck-grey-report monitor on configurable interval, reading threshold from AppSetting."""
    from app.services.auto_flagging import monitor_stuck_grey_reports
    from app.models.app_setting import AppSetting
    # Run immediately on startup so reports stuck across a redeploy are processed right away.
    await monitor_stuck_grey_reports()
    while True:
        interval = settings.STUCK_REPORT_THRESHOLD_MINUTES
        try:
            async with AsyncSessionLocal() as db:
                from sqlalchemy import select as _select
                row = await db.execute(_select(AppSetting).where(AppSetting.key == "thresholds"))
                rec = row.scalar_one_or_none()
                if rec and isinstance(rec.value, dict):
                    interval = rec.value.get("stuck_report_threshold_minutes", interval)
        except Exception:
            pass
        await asyncio.sleep(interval * 60)
        await monitor_stuck_grey_reports()


async def _auto_block_confirmation_loop() -> None:
    """Auto-confirm auto-blocks whose review window has expired with no action.
    Reads auto_block_confirmation_hours from AppSetting, falling back to config."""
    from app.models.reporter import Reporter
    from app.models.app_setting import AppSetting
    interval = settings.AUTO_BLOCK_CHECK_INTERVAL_MINUTES * 60
    while True:
        await asyncio.sleep(interval)
        try:
            async with AsyncSessionLocal() as db:
                # Read configurable window from AppSetting
                confirmation_hours = settings.AUTO_BLOCK_CONFIRMATION_HOURS
                try:
                    row = await db.execute(
                        select(AppSetting).where(AppSetting.key == "thresholds")
                    )
                    rec = row.scalar_one_or_none()
                    if rec and isinstance(rec.value, dict):
                        confirmation_hours = rec.value.get("auto_block_confirmation_hours", confirmation_hours)
                except Exception:
                    pass

                now = datetime.now(timezone.utc)
                expired = await db.execute(
                    select(Reporter).where(
                        Reporter.pending_auto_block_confirmation == True,
                        Reporter.auto_block_confirmed == False,
                        Reporter.auto_block_expires_at <= now,
                    )
                )
                reporters = expired.scalars().all()
                from app.services.reporter_activity_service import write_activity_log
                for reporter in reporters:
                    reporter.auto_block_confirmed = True
                    reporter.auto_block_confirmed_at = now
                    reporter.auto_block_confirmed_by = "system"
                    reporter.pending_auto_block_confirmation = False
                    try:
                        await write_activity_log(
                            db,
                            reporter_id=reporter.id,
                            action="auto_block_expired",
                            source="System",
                            previous_value="blocked",
                            new_value="blocked",
                            comment=(
                                f"Auto-block automatically confirmed after "
                                f"{confirmation_hours}-hour review window "
                                f"with no action taken."
                            ),
                        )
                    except Exception as e:
                        logger.warning("Activity log write failed in auto_block_confirmation_loop: %s", e)
                    logger.info(
                        "Auto-block automatically confirmed for reporter %s after %d-hour window",
                        reporter.id, confirmation_hours,
                    )
                await db.commit()
        except Exception as e:
            logger.error("Auto-block confirmation loop error: %s", e)


async def _remove_expired_deprecated_languages_loop() -> None:
    """Daily: hard-remove languages past their removal_scheduled_at date."""
    from app.tasks import remove_expired_deprecated_languages
    while True:
        await asyncio.sleep(24 * 60 * 60)
        try:
            await remove_expired_deprecated_languages()
        except Exception as e:
            logger.error("remove_expired_deprecated_languages loop error: %s", e)


async def _pause_expiry_loop() -> None:
    """Every 15 minutes: clear submission pauses whose expiry time has passed."""
    from app.models.reporter import Reporter
    while True:
        await asyncio.sleep(15 * 60)
        try:
            async with AsyncSessionLocal() as db:
                now = datetime.now(timezone.utc)
                expired = await db.execute(
                    select(Reporter).where(
                        Reporter.is_paused == True,
                        Reporter.pause_expires_at <= now,
                    )
                )
                for reporter in expired.scalars().all():
                    reporter.is_paused = False
                    reporter.pause_expires_at = None
                    reporter.pause_reason = None
                await db.commit()
        except Exception as e:
            logger.error("Pause expiry loop error: %s", e)


_MIGRATIONS = [
    # Report serial number — simple sequential human-readable ID
    "CREATE SEQUENCE IF NOT EXISTS reports_serial_seq START WITH 1 INCREMENT BY 1",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS serial_number INTEGER",
    # Backfill existing rows in submission chronological order using a window function.
    # ROW_NUMBER gives #1 to the oldest report, #2 to the next, etc.
    # WHERE serial_number IS NULL makes this a no-op on subsequent app restarts (idempotent).
    """UPDATE reports AS r
SET serial_number = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM reports
  WHERE serial_number IS NULL
) sub
WHERE r.id = sub.id""",
    # Advance the sequence past the highest assigned value so new reports continue from N+1.
    # setval(..., value, false) means "next nextval() call returns value" — safe to re-run
    # because COALESCE(MAX, 0) + 1 will always be ≥ the current sequence position.
    "SELECT setval('reports_serial_seq', COALESCE((SELECT MAX(serial_number) FROM reports), 0) + 1, false)",
    "ALTER TABLE reports ALTER COLUMN serial_number SET DEFAULT nextval('reports_serial_seq')",
    "CREATE UNIQUE INDEX IF NOT EXISTS uix_reports_serial_number ON reports(serial_number)",
    # Deduplicate local_id before creating the unique index — historical reports submitted
    # before the app-layer dedup check existed may share the same local_id. Keep the oldest
    # report for each local_id and NULL the rest so the index creation below can succeed.
    # Idempotent: if no duplicates exist the UPDATE touches zero rows.
    """DO $$
BEGIN
  UPDATE reports SET local_id = NULL
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY created_at ASC, id ASC) AS rn
      FROM reports
      WHERE local_id IS NOT NULL
    ) sub
    WHERE rn > 1
  );
END $$""",
    # Partial unique index on local_id — prevents race-condition duplicate inserts when the
    # same local_report_id is sent twice before the first INSERT is committed.
    # Partial (WHERE local_id IS NOT NULL) because anonymous/online reports may have no local_id.
    "CREATE UNIQUE INDEX IF NOT EXISTS uix_reports_local_id ON reports(local_id) WHERE local_id IS NOT NULL",
    # Force chronological re-number — fixes out-of-order serial_numbers from the original
    # backfill that used nextval() with no ORDER BY.  The DO block is idempotent: it only
    # runs when the chronologically oldest report does NOT have serial_number = 1.
    """DO $$
DECLARE
  first_sn INTEGER;
BEGIN
  SELECT serial_number INTO first_sn
  FROM reports
  ORDER BY created_at ASC, id ASC
  LIMIT 1;
  IF first_sn IS NULL OR first_sn != 1 THEN
    -- NULL values don't violate unique constraints, so clear first then re-assign
    UPDATE reports SET serial_number = NULL;
    UPDATE reports AS r
    SET serial_number = sub.rn
    FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
      FROM reports
    ) sub
    WHERE r.id = sub.id;
    PERFORM setval('reports_serial_seq',
      COALESCE((SELECT MAX(serial_number) FROM reports), 0) + 1, false);
  END IF;
END $$""",
    # Crisis model overhaul — Chapter 9
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS serial_number INTEGER",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS serial_id VARCHAR(20)",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS countries TEXT[]",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS start_date DATE",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS end_date DATE",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS created_by_user_id UUID",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_job_id VARCHAR(100)",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_status VARCHAR(20) DEFAULT 'pending'",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_progress INTEGER DEFAULT 0",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS import_total INTEGER DEFAULT 0",
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS map_zoom INTEGER",
    # Seed countries array from existing country_code (idempotent)
    "UPDATE crises SET countries = ARRAY[country_code] WHERE countries IS NULL AND country_code IS NOT NULL",
    # Sync status from is_active for existing rows
    "UPDATE crises SET status = CASE WHEN is_active = TRUE THEN 'active' ELSE 'closed' END WHERE status IS NULL OR status = ''",
    # Sequence for serial numbers
    "CREATE SEQUENCE IF NOT EXISTS crisis_serial_seq START WITH 1 INCREMENT BY 1",
    # Seed serial numbers for existing crises that have none (idempotent DO block)
    """DO $$
DECLARE
  r RECORD;
  n INTEGER;
BEGIN
  FOR r IN SELECT id FROM crises WHERE serial_number IS NULL ORDER BY created_at ASC LOOP
    n := nextval('crisis_serial_seq');
    UPDATE crises SET serial_number = n, serial_id = 'PR-' || LPAD(n::text, 4, '0') WHERE id = r.id;
  END LOOP;
END $$""",
    # Advance sequence past any manually seeded values
    "SELECT setval('crisis_serial_seq', COALESCE((SELECT MAX(serial_number) FROM crises), 0) + 1, false)",
    # Unique constraint on serial_id (safe — each row now has one)
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_crises_serial_id_unique ON crises(serial_id) WHERE serial_id IS NOT NULL",
    # report_projects join table
    """CREATE TABLE IF NOT EXISTS report_projects (
    report_id UUID NOT NULL REFERENCES reports(id),
    crisis_id UUID NOT NULL REFERENCES crises(id),
    linked_at TIMESTAMPTZ DEFAULT NOW(),
    linked_by VARCHAR(20) DEFAULT 'auto',
    PRIMARY KEY (report_id, crisis_id)
)""",
    "CREATE INDEX IF NOT EXISTS idx_report_projects_crisis_id ON report_projects(crisis_id)",
    "CREATE INDEX IF NOT EXISTS idx_report_projects_report_id ON report_projects(report_id)",
    # Seed report_projects from existing crisis_id FK on reports
    """INSERT INTO report_projects (report_id, crisis_id, linked_by)
SELECT id, crisis_id, 'auto'
FROM reports
WHERE crisis_id IS NOT NULL
  AND flag_status IN ('green', 'orange')
ON CONFLICT DO NOTHING""",
    # project_users join table
    """CREATE TABLE IF NOT EXISTS project_users (
    crisis_id UUID NOT NULL REFERENCES crises(id),
    dashboard_user_id UUID NOT NULL REFERENCES dashboard_users(id),
    access_level VARCHAR(20) DEFAULT 'view_and_edit',
    is_creator BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (crisis_id, dashboard_user_id)
)""",
    # Dashboard users: existing chapters
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS contact_number VARCHAR(50)",
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT",
    # Chapter 10 — user management
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES dashboard_users(id)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS ip_address_hash VARCHAR(64)",
    # Chapter 12 Part 2 — Translation governance
    """CREATE TABLE IF NOT EXISTS languages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(10) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        is_protected BOOLEAN NOT NULL DEFAULT FALSE,
        deprecated_at TIMESTAMPTZ,
        removal_scheduled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_languages_code_unique ON languages(code)",
    # Seed 6 UN languages (idempotent).
    # id AND created_at must be supplied explicitly: create_all builds the table from the
    # Language model, which uses Python-side defaults (default=uuid.uuid4,
    # default=datetime.utcnow).  SQLAlchemy does NOT emit DEFAULT clauses for those in the
    # DDL, so both columns are NOT NULL with no server-side fallback.  Omitting either
    # column causes a NOT NULL violation which poisons the transaction and rolls back every
    # statement that follows.
    """INSERT INTO languages (id, code, name, status, is_protected, created_at)
       VALUES
         (gen_random_uuid(), 'ar', 'Arabic',  'active', TRUE, NOW()),
         (gen_random_uuid(), 'zh', 'Chinese', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'en', 'English', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'fr', 'French',  'active', TRUE, NOW()),
         (gen_random_uuid(), 'ru', 'Russian', 'active', TRUE, NOW()),
         (gen_random_uuid(), 'es', 'Spanish', 'active', TRUE, NOW())
       ON CONFLICT (code) DO NOTHING""",
    # Ensure protected flag is set for UN languages
    "UPDATE languages SET is_protected = TRUE WHERE code IN ('ar', 'zh', 'en', 'fr', 'ru', 'es')",
    # Translation reject fields
    "ALTER TABLE translations ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ",
    "ALTER TABLE translations ADD COLUMN IF NOT EXISTS rejection_reason TEXT",
    # Audit log table
    """CREATE TABLE IF NOT EXISTS translation_audit_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        lang_code VARCHAR(10),
        string_key VARCHAR(255),
        details JSONB,
        performed_by VARCHAR(255),
        dashboard_user_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_event ON translation_audit_log(event_type)",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_lang ON translation_audit_log(lang_code)",
    "CREATE INDEX IF NOT EXISTS idx_translation_audit_created ON translation_audit_log(created_at DESC)",
    # Chapter 12 — App Configuration structural fixes
    "ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_core BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE countries ADD COLUMN IF NOT EXISTS dialling_code VARCHAR(10)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS tc_version_accepted VARCHAR(20)",
    # Backfill: mark the 5 seeded questions (package v1.0.0) as core
    """UPDATE questions SET is_core = TRUE
       WHERE package_id = '00000000-0000-0000-0000-000000000001'""",
    # Reporter auto-block fields (Chapter 5 Part 1)
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_blocked_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_expires_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed BOOLEAN DEFAULT FALSE",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS auto_block_confirmed_by VARCHAR(255)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS matched_blocked_reporter_id VARCHAR(255)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pending_auto_block_confirmation BOOLEAN DEFAULT FALSE",
    # Chapter 7 — reporter profile fields
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS profile_status VARCHAR(20) DEFAULT 'active'",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS profile_type VARCHAR(30) DEFAULT 'anonymous_no_reports'",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS app_version VARCHAR(50)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS browser_version VARCHAR(100)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS mcc VARCHAR(10)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pause_expires_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(255)",
    # Sync existing is_blocked=True reporters to profile_status='blocked'
    "UPDATE reporters SET profile_status = 'blocked' WHERE is_blocked = TRUE AND profile_status = 'active'",
    # Sync existing verified reporters to profile_type='named_profile'
    "UPDATE reporters SET profile_type = 'named_profile' WHERE is_verified = TRUE AND profile_type = 'anonymous_no_reports'",
    # Sync anonymous reporters who have reports to profile_type='anonymous_with_reports'
    "UPDATE reporters SET profile_type = 'anonymous_with_reports' WHERE is_verified = FALSE AND report_count > 0 AND profile_type = 'anonymous_no_reports'",
    # Chapter 13 — Security setting defaults (idempotent via ON CONFLICT DO NOTHING on unique key)
    # NOTE: app_settings stores settings as JSONB blobs keyed by group name.
    # We seed individual scalar keys here for migration tracking but the actual
    # settings blob is managed by the app_settings router using upsert.
    # Chapter 11 — Role model extensions
    "ALTER TABLE roles ADD COLUMN IF NOT EXISTS description VARCHAR(500)",
    "ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES dashboard_users(id)",
    # Chapter 13 — Notification bell tables
    """CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        notification_type_key VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        triggered_at TIMESTAMPTZ DEFAULT NOW(),
        is_global BOOLEAN DEFAULT TRUE
    )""",
    """CREATE TABLE IF NOT EXISTS notification_reads (
        notification_id INTEGER REFERENCES notifications(id),
        dashboard_user_id UUID REFERENCES dashboard_users(id),
        read_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (notification_id, dashboard_user_id)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_notifications_triggered_at ON notifications(triggered_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads(dashboard_user_id)",
    # Chapter 18 — Password expiry enforcement
    "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ",
    "UPDATE dashboard_users SET password_changed_at = created_at WHERE password_changed_at IS NULL",
    # Photos — columns added after initial table creation
    "ALTER TABLE photos ADD COLUMN IF NOT EXISTS photo_hash VARCHAR(64)",
    "CREATE INDEX IF NOT EXISTS ix_photos_photo_hash ON photos(photo_hash)",
    "ALTER TABLE photos ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0 NOT NULL",
    # flag_events.metadata — JSON blob for structured auto-flag context (IP, device lists, etc.)
    "ALTER TABLE flag_events ADD COLUMN IF NOT EXISTS metadata JSONB",
    # ── Comprehensive schema-gap patch ──────────────────────────────────────────
    # reporters — columns added in later chapters with no prior migration
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS display_id INTEGER",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix_reporters_display_id ON reporters(display_id) WHERE display_id IS NOT NULL",
    "CREATE SEQUENCE IF NOT EXISTS reporter_display_id_seq START WITH 1 INCREMENT BY 1",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS os_device_id VARCHAR(64)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS t_and_c_accepted_at TIMESTAMPTZ",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ",
    # reports — offline-queue tracking and IP encryption columns
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS local_id VARCHAR(100)",
    "CREATE INDEX IF NOT EXISTS ix_reports_local_id ON reports(local_id) WHERE local_id IS NOT NULL",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS ip_address_encrypted VARCHAR(500)",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS was_queued BOOLEAN DEFAULT FALSE",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ",
    "ALTER TABLE reports ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ",
    # crises — map radius default (NOT NULL in model, missing column would break crisis creation)
    "ALTER TABLE crises ADD COLUMN IF NOT EXISTS map_default_radius_miles INTEGER DEFAULT 50",
    # content_management section — copy permissions from app_configuration for existing custom roles
    # so existing role grants don't lose access when the sidebar key changes
    """UPDATE roles SET permissions = permissions || jsonb_build_object('content_management', COALESCE(permissions->'app_configuration', '{"view": false, "edit": false}'::jsonb)) WHERE is_default = false AND NOT (permissions ? 'content_management')""",
    # Safety-net: remove StringKey rows that could only have been created by the wrong disaster keys
    # in the old SystemSettingsPage App Content tab (hurricane→hurricane_cyclone, fire→wildfire, etc.)
    "DELETE FROM string_keys WHERE key LIKE 'SAFETY_TIP_A_HURRICANE_%' AND key NOT LIKE 'SAFETY_TIP_A_HURRICANE_CYCLONE_%'",
    "DELETE FROM string_keys WHERE key LIKE 'SAFETY_TIP_A_FIRE_%'",
    "DELETE FROM string_keys WHERE key LIKE 'SAFETY_TIP_A_LANDSLIDE_%'",
    "DELETE FROM string_keys WHERE key LIKE 'SAFETY_TIP_A_DROUGHT_%'",
    "DELETE FROM string_keys WHERE key LIKE 'SAFETY_TIP_A_EPIDEMIC_%'",
    # reporters.ip_address_hash — SHA-256 hash of the reporter's most-recent submission IP.
    # Required for Rule 2 auto-flagging (IP blocked reporter match) in auto_flagging.py.
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS ip_address_hash VARCHAR(64)",
    "CREATE INDEX IF NOT EXISTS ix_reporters_ip_address_hash ON reporters(ip_address_hash)",
    # Assign serial numbers to reports that still have NULL — uses the sequence so new
    # numbers never conflict with existing ones. The earlier ROW_NUMBER backfill fails when
    # serial_number=1 is already taken; this DO block avoids that by calling nextval() which
    # always returns the next unused value. Idempotent: no NULL rows → no-op.
    """DO $$
DECLARE
  r RECORD;
  next_sn INTEGER;
BEGIN
  FOR r IN
    SELECT id FROM reports WHERE serial_number IS NULL ORDER BY created_at ASC, id ASC
  LOOP
    next_sn := nextval('reports_serial_seq');
    UPDATE reports SET serial_number = next_sn WHERE id = r.id;
  END LOOP;
END $$""",

    # One-time country active-status reset (2026-06-13):
    # Activate all 193 UN member states except 15 sanctioned / severely access-restricted countries.
    # Restricted (inactive): KP AF SY RU MM IR CU VE ER SO YE SD ML BY NI
    """
UPDATE countries
SET is_active = CASE
    WHEN code IN ('KP','AF','SY','RU','MM','IR','CU','VE','ER','SO','YE','SD','ML','BY','NI')
        THEN FALSE
    ELSE TRUE
END
WHERE code IN (
    'DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ',
    'ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU',
    'MA','MZ','NA','NE','NG','RW','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN',
    'UG','ZM','ZW','AG','AR','BS','BB','BZ','BO','BR','CA','CL','CO','CR','CU','DM','DO',
    'EC','SV','GD','GT','GY','HT','HN','JM','MX','NI','PA','PY','PE','KN','LC','VC','SR',
    'TT','US','UY','VE','AF','AM','AZ','BH','BD','BT','BN','KH','CN','CY','GE','IN','ID',
    'IR','IQ','IL','JP','JO','KZ','KW','KG','LA','LB','MY','MV','MN','MM','NP','KP','OM',
    'PK','PH','QA','SA','SG','KR','LK','SY','TJ','TH','TL','TR','TM','AE','UZ','VN','YE',
    'AL','AD','AT','BY','BE','BA','BG','HR','CZ','DK','EE','FI','FR','DE','GR','HU','IS',
    'IE','IT','LV','LI','LT','LU','MT','MD','MC','ME','NL','MK','NO','PL','PT','RO','RU',
    'SM','RS','SK','SI','ES','SE','CH','UA','GB','AU','FJ','KI','MH','FM','NR','NZ','PW',
    'PG','WS','SB','TO','TV','VU'
)
""",
    # reporters.device_id_hash — partial unique index (NULL rows excluded) prevents
    # concurrent anonymous registrations from the same device creating two profiles.
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_reporters_device_id_hash ON reporters(device_id_hash) WHERE device_id_hash IS NOT NULL",
    # reporters.device_id_encrypted — auto-create path in reports.py now stores
    # device_id on auto-created profiles; column already exists from initial schema.
    # No ADD COLUMN needed — just ensuring the unique index above is in place.

    # Property.auto_confirmed — True when confirmed_status was set by the auto-confirm majority loop
    "ALTER TABLE properties ADD COLUMN IF NOT EXISTS auto_confirmed BOOLEAN NOT NULL DEFAULT FALSE",
    # Property.manual_confirmed_lock — True when a dashboard user has manually touched confirmed_status;
    # while True, the auto-confirm loop skips this property entirely
    "ALTER TABLE properties ADD COLUMN IF NOT EXISTS manual_confirmed_lock BOOLEAN NOT NULL DEFAULT FALSE",

    # Reporter profile fields — first_name, last_name, phone_number added for reporter profile page
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)",
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30)",
    # reporters.ip_address_encrypted — Fernet-encrypted first-seen IP (mirrors Report.ip_address_encrypted).
    # Replaces the legacy plaintext reporters.ip_address column for new submissions.
    "ALTER TABLE reporters ADD COLUMN IF NOT EXISTS ip_address_encrypted VARCHAR(500)",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Vuln fix: EXPORT_URL_SIGN_SECRET must not be the known public default.
    # If unset, generate a random per-startup secret so dev works but the
    # known plaintext string is never the active signing key.
    if not settings.EXPORT_URL_SIGN_SECRET:
        settings.EXPORT_URL_SIGN_SECRET = secrets.token_hex(32)
        logger.warning(
            "EXPORT_URL_SIGN_SECRET is not set — using a random per-startup value. "
            "Export download URLs will expire on restart. Set this env var in production."
        )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for stmt in _MIGRATIONS:
            try:
                await conn.execute(text("SAVEPOINT _m"))
                await conn.execute(text(stmt))
                await conn.execute(text("RELEASE SAVEPOINT _m"))
            except Exception as e:
                await conn.execute(text("ROLLBACK TO SAVEPOINT _m"))
                logger.warning("Migration skipped: %s — %s", stmt, e)
    Path(settings.LOCAL_UPLOAD_PATH).mkdir(parents=True, exist_ok=True)
    await seed_initial_package()
    await seed_string_keys()
    # Sync Translation rows: create missing rows for new/reactivated keys and
    # retire rows for keys removed from _SEED_KEYS. Belt-and-suspenders alongside
    # the is_active filters in publish_language_package and get_queue_status.
    async with AsyncSessionLocal() as db:
        await ensure_string_keys_synced(db)
    await seed_countries()
    await seed_first_admin()
    await _seed_default_roles()
    await _seed_default_crisis()
    await _seed_notification_types()
    await _seed_safety_tips_content()
    # Remove the ZZ placeholder country if it exists
    try:
        async with AsyncSessionLocal() as db:
            from app.models.country import Country
            result = await db.execute(
                select(Country).where(Country.code == "ZZ")
            )
            zz_country = result.scalar_one_or_none()
            if zz_country:
                await db.delete(zz_country)
                await db.commit()
                logger.info("Deleted duplicate country with code ZZ")
    except Exception as e:
        logger.error("ZZ country cleanup error: %s", e)
    # Reset / create admin@crisisreporter.org on every startup
    try:
        from app.models.dashboard_user import DashboardUser
        from app.routers.dashboard_auth import hash_password
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(DashboardUser).where(
                    DashboardUser.email == "admin@crisisreporter.org"
                )
            )
            admin = result.scalar_one_or_none()
            if admin:
                admin.password_hash = hash_password("Admin2026")
                await db.commit()
                logger.info("Admin password reset to Admin2026")
                if admin.role != "superadmin":
                    admin.role = "superadmin"
                    await db.commit()
                    print("Updated admin@crisisreporter.org role to superadmin")
            else:
                new_admin = DashboardUser(
                    email="admin@crisisreporter.org",
                    password_hash=hash_password("Admin2026"),
                    full_name="Crisis Reporter Admin",
                    role="superadmin",
                    is_active=True,
                )
                db.add(new_admin)
                await db.commit()
                logger.info("Admin account created: admin@crisisreporter.org")
    except Exception as e:
        logger.error("Admin reset migration error: %s", e)
    # Shared Redis connection on app state (used by soft-lock service and review queue)
    import redis.asyncio as aioredis
    app.state.redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    # Translation config diagnostic — logged every startup so misconfiguration
    # is visible immediately rather than silently falling back to LibreTranslate.
    if settings.TRANSLATION_PRIMARY == "google":
        if settings.GOOGLE_TRANSLATE_API_KEY:
            logger.info(
                "Translation: primary=Google (key configured), fallback=LibreTranslate (%s)",
                settings.LIBRETRANSLATE_URL or "(not set)",
            )
        else:
            logger.error(
                "Translation MISCONFIGURED: TRANSLATION_PRIMARY=google but "
                "GOOGLE_TRANSLATE_API_KEY is not set — all translations will fall "
                "back to LibreTranslate. Set GOOGLE_TRANSLATE_API_KEY in Railway env vars."
            )
    else:
        logger.info(
            "Translation: primary=LibreTranslate (%s)",
            settings.LIBRETRANSLATE_URL or "(not set — will use public instance)",
        )
    if settings.LIBRETRANSLATE_URL and "libretranslate.com" in settings.LIBRETRANSLATE_URL:
        logger.warning(
            "Translation: LIBRETRANSLATE_URL points to public libretranslate.com — "
            "severe rate limits apply. Set LIBRETRANSLATE_URL to your HF Space URL."
        )
    # Background monitors
    task_stuck = asyncio.create_task(_stuck_report_loop())
    task_autoblock = asyncio.create_task(_auto_block_confirmation_loop())
    task_pause_expiry = asyncio.create_task(_pause_expiry_loop())
    task_lang_cleanup = asyncio.create_task(_remove_expired_deprecated_languages_loop())
    yield
    task_stuck.cancel()
    task_autoblock.cancel()
    task_pause_expiry.cancel()
    task_lang_cleanup.cancel()
    await app.state.redis.aclose()
    await engine.dispose()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_origin_regex=r"https://.*\.railway\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if settings.STORAGE_BACKEND == "local":
    uploads_path = Path(settings.LOCAL_UPLOAD_PATH)
    uploads_path.mkdir(parents=True, exist_ok=True)
    app.mount(
        "/api/uploads/photos",
        StaticFiles(directory=str(uploads_path)),
        name="uploads",
    )

# Register routers
app.include_router(dashboard_auth.router)
app.include_router(reporter_auth.router)
app.include_router(reporters.router)
app.include_router(crises.router)
app.include_router(reports.router)
app.include_router(photos.router)
app.include_router(dashboard_reports.router)
app.include_router(dashboard_reporters.router)
app.include_router(dashboard_map.router)
app.include_router(dashboard_properties.router)
app.include_router(analytics.router)
app.include_router(exports.router)
app.include_router(question_packages.router)
app.include_router(flag_rules.router)
app.include_router(language_packages.languages_router)
app.include_router(language_packages.packages_router)
app.include_router(language_packages.keys_router)
app.include_router(language_packages.translations_router)
app.include_router(push_tokens.router)
app.include_router(roles.router)
app.include_router(health_router.router)
app.include_router(app_settings.router)
app.include_router(content.router)
app.include_router(countries.router)
app.include_router(review_queue.router)
app.include_router(dashboard_projects.router, prefix="/api")
app.include_router(dashboard_users.router, prefix="/api")
app.include_router(notifications_router.router)
app.include_router(dashboard_sse.router)
