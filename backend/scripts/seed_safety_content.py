#!/usr/bin/env python3
"""
Seed Safety Tips content (Parts A, B, C) directly into the database via SQLAlchemy.
No HTTP calls, no backend process required — only a running PostgreSQL database.

Usage:
    cd C:\\Users\\Shivam\\crisis-reporter\\backend
    python scripts/seed_safety_content.py
"""

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow imports from the backend app package
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.app_setting import AppSetting


# ── DB helpers (mirrors content.py) ───────────────────────────────────────────

async def _upsert(db, key: str, value: dict) -> None:
    result = await db.execute(select(AppSetting).where(AppSetting.key == key))
    row = result.scalar_one_or_none()
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    await db.commit()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slides_value(slides: list[dict]) -> dict:
    return {"slides": slides, "version": 1, "updated_at": _now()}


# ── Part A — Safety Tips ───────────────────────────────────────────────────────

SAFETY_TIPS: dict[str, list[dict]] = {
    "earthquake": [
        {
            "title": "Drop, Cover, Hold On",
            "dos": [
                "Drop to your hands and knees immediately when shaking begins — this protects you from being knocked down and allows you to move if needed",
                "Take cover under a sturdy table or desk, or against an interior wall away from windows — cover your head and neck with your arms",
            ],
            "donts": [],
        },
        {
            "title": "Stay in Position",
            "dos": [
                "Hold on to your shelter and be prepared to move with it until the shaking stops",
                "If you are in bed when the earthquake strikes, stay there and protect your head with a pillow",
            ],
            "donts": [],
        },
        {
            "title": "If Outdoors",
            "dos": [
                "If you are outdoors, move away from buildings, streetlights, and utility wires and stay in the open until shaking stops",
                "After shaking stops, check yourself for injuries before helping others — you cannot help others effectively if you are injured",
            ],
            "donts": [],
        },
        {
            "title": "After the Shaking",
            "dos": [
                "Expect aftershocks — they can occur minutes, hours, or days after the main earthquake",
                "Use text messages or social media to communicate if phone lines are busy — texts use less network capacity than voice calls",
            ],
            "donts": [],
        },
        {
            "title": "Utilities and Information",
            "dos": [
                "If you smell gas, leave the building immediately and do not return until authorities say it is safe",
                "Listen to official emergency broadcasts for instructions from local authorities",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do",
            "dos": [],
            "donts": [
                "Do not run outside while shaking is happening — most injuries occur when people try to move or run during shaking",
                "Do not stand in a doorway — doorways are no stronger than other parts of the building and offer no special protection",
            ],
        },
        {
            "title": "After the Earthquake",
            "dos": [],
            "donts": [
                "Do not use elevators after an earthquake — use stairs only",
                "Do not light candles, matches, or any open flame after an earthquake — gas pipes may be damaged and leaking",
            ],
        },
        {
            "title": "Safety and Information",
            "dos": [],
            "donts": [
                "Do not return to a damaged building until it has been declared structurally safe by an authority",
                "Do not spread unverified information — only share information from official sources",
            ],
        },
    ],
    "flood": [
        {
            "title": "Immediate Actions",
            "dos": [
                "Move immediately to higher ground if flooding is imminent — do not wait for instructions if you are in a low-lying area",
                "Turn off utilities at the main switch if instructed by authorities and if it is safe to do so",
            ],
            "donts": [],
        },
        {
            "title": "Electrical Safety",
            "dos": [
                "Disconnect electrical appliances — do not touch them if you are wet or standing in water",
                "If evacuation is ordered, leave immediately — take your emergency kit, important documents, and medications",
            ],
            "donts": [],
        },
        {
            "title": "If Trapped",
            "dos": [
                "If trapped in a building, move to the highest floor and signal for help from a window — do not go to the roof unless absolutely necessary",
                "Drink only bottled or boiled water during and after flooding — floodwater contaminates water supplies",
            ],
            "donts": [],
        },
        {
            "title": "Protection",
            "dos": [
                "Wear rubber boots and waterproof gloves if you must walk through floodwater",
                "Listen to official emergency broadcasts at all times for updates on water levels and evacuation routes",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do — Movement",
            "dos": [],
            "donts": [
                "Do not walk through moving floodwater — 15 centimetres of fast-moving water can knock an adult off their feet",
                "Do not drive through flooded roads — water depth is impossible to judge accurately from a vehicle",
            ],
        },
        {
            "title": "What NOT to Do — Contamination",
            "dos": [],
            "donts": [
                "Do not touch floodwater if you can avoid it — it may be contaminated with sewage, chemicals, or debris",
                "Do not return home until authorities declare it safe — floodwater can weaken building foundations invisibly",
            ],
        },
        {
            "title": "What NOT to Do — Equipment",
            "dos": [],
            "donts": [
                "Do not use electrical equipment that has been in contact with floodwater until it has been inspected by a qualified electrician",
                "Do not ignore evacuation orders — even if previous floods did not affect your area, each event is different",
            ],
        },
    ],
    "tsunami": [
        {
            "title": "Immediate Warning Signs",
            "dos": [
                "If you feel a strong earthquake near the coast, move immediately to higher ground or inland — do not wait for an official warning",
                "A sudden and dramatic recession of the sea — the water pulling back rapidly — is a natural warning sign of an incoming tsunami. Move inland immediately.",
            ],
            "donts": [],
        },
        {
            "title": "Move to Safety",
            "dos": [
                "Move on foot if possible — roads may be congested or damaged. A tsunami can arrive within minutes of an earthquake.",
                "Go to a designated tsunami evacuation zone or the highest ground available to you",
            ],
            "donts": [],
        },
        {
            "title": "If Caught in a Wave",
            "dos": [
                "If caught in a tsunami wave, grab onto something that floats — a door, a large piece of wood, or anything buoyant",
                "After the first wave, stay where you are — tsunamis typically come in a series of waves, and later waves are often larger than the first",
            ],
            "donts": [],
        },
        {
            "title": "Stay Informed",
            "dos": [
                "Listen to official emergency broadcasts — an all-clear must come from authorities before returning to coastal areas",
                "Help others move to higher ground only if you can do so without putting yourself at risk",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do — Curiosity",
            "dos": [],
            "donts": [
                "Do not go to the coast to watch the tsunami — people who go to watch are frequently killed",
                "Do not assume the danger is over after the first wave — subsequent waves can arrive for hours",
            ],
        },
        {
            "title": "What NOT to Do — Routes",
            "dos": [],
            "donts": [
                "Do not use bridges or low-lying roads during or immediately after a tsunami warning",
                "Do not return to coastal or low-lying areas until authorities have issued a formal all-clear",
            ],
        },
        {
            "title": "What NOT to Do — Warnings",
            "dos": [],
            "donts": [
                "Do not rely solely on sirens or official warnings — if you feel a large earthquake near the coast, act immediately without waiting",
                "Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away",
            ],
        },
    ],
    "hurricane_cyclone": [
        {
            "title": "Before the Storm",
            "dos": [
                "Follow evacuation orders immediately when issued — hurricanes are predictable enough that authorities can usually give advance warning",
                "Board up windows and secure outdoor furniture, equipment, and anything that could become airborne before the storm arrives",
            ],
            "donts": [],
        },
        {
            "title": "Prepare Supplies",
            "dos": [
                "Prepare an emergency kit with water, non-perishable food, medications, flashlight, batteries, and important documents — enough for at least 72 hours",
                "Fill clean containers with drinking water before the storm arrives — water supply systems may be disrupted",
            ],
            "donts": [],
        },
        {
            "title": "During the Storm",
            "dos": [
                "Stay indoors during the storm and away from windows and glass doors — shelter in an interior room on the lowest floor",
                "If the eye of the hurricane passes over your location, stay sheltered — dangerous winds will return from the opposite direction shortly",
            ],
            "donts": [],
        },
        {
            "title": "After the Storm",
            "dos": [
                "After the storm, check your home carefully for structural damage before entering — damaged roofs and floors can collapse",
                "Listen to official broadcasts for road conditions, utility status, and public health guidance before going outside",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do — During",
            "dos": [],
            "donts": [
                "Do not go outside during the storm — flying debris causes most hurricane fatalities",
                "Do not assume the storm is over if winds suddenly calm — the eye of the hurricane passes quickly and dangerous conditions return",
            ],
        },
        {
            "title": "What NOT to Do — After",
            "dos": [],
            "donts": [
                "Do not use generators, camp stoves, or charcoal grills indoors or in enclosed spaces — carbon monoxide poisoning is a leading cause of post-hurricane deaths",
                "Do not touch downed power lines or walk through standing water near them",
            ],
        },
        {
            "title": "What NOT to Do — Travel",
            "dos": [],
            "donts": [
                "Do not drive through flooded roads — hurricane flooding is extensive and road conditions change rapidly",
                "Do not return to evacuated areas until authorities declare it safe to do so",
            ],
        },
    ],
    "wildfire": [
        {
            "title": "Evacuate Immediately",
            "dos": [
                "If you receive an evacuation order, leave immediately — wildfires can change direction rapidly and cut off escape routes without warning",
                "As you evacuate, close all windows and doors to slow fire entering your home — leave them unlocked for emergency responders",
            ],
            "donts": [],
        },
        {
            "title": "Protect Yourself",
            "dos": [
                "Wear a mask or cover your nose and mouth with a damp cloth to reduce smoke inhalation while evacuating",
                "Take your emergency kit, medications, important documents, and pets if you can do so quickly and safely",
            ],
            "donts": [],
        },
        {
            "title": "If Trapped",
            "dos": [
                "If caught in a wildfire with no escape route, shelter in a building, lie face down in a ditch or low-lying area away from vegetation, and cover yourself with a blanket or jacket",
                "Breathe through your nose — nasal passages filter more smoke particles than mouth breathing",
            ],
            "donts": [],
        },
        {
            "title": "After the Fire",
            "dos": [
                "After a wildfire, check your roof and around your home for embers before re-entering — embers can smoulder for hours and reignite",
                "Wear a mask and gloves when working in ash — ash is hazardous and can contain toxic materials from burned structures",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do — Evacuation",
            "dos": [],
            "donts": [
                "Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run",
                "Do not re-enter evacuated areas until authorities declare it safe — hidden hot spots can reignite fires",
            ],
        },
        {
            "title": "What NOT to Do — After",
            "dos": [],
            "donts": [
                "Do not park under trees or wooden structures during or after a wildfire — weakened trees can fall without warning",
                "Do not use water that may have been contaminated by fire retardants or wildfire runoff — use bottled water only until water safety is confirmed",
            ],
        },
        {
            "title": "What NOT to Do — Health",
            "dos": [],
            "donts": [
                "Do not inhale ash or smoke unnecessarily — wear a properly fitted mask rated for particulate matter where available",
                "Do not attempt to fight a wildfire yourself unless you are trained to do so — evacuate instead",
            ],
        },
    ],
    "explosion": [
        {
            "title": "Immediate Response",
            "dos": [
                "If you hear an explosion, immediately drop to the floor and take cover under a table or against an interior wall — cover your head and neck",
                "Move away from windows, glass doors, and exterior walls — secondary explosions and debris are common",
            ],
            "donts": [],
        },
        {
            "title": "Evacuate Safely",
            "dos": [
                "Evacuate the building using stairs — do not use elevators",
                "Once outside, move far away from the building and follow instructions from emergency services",
            ],
            "donts": [],
        },
        {
            "title": "If Injured or Trapped",
            "dos": [
                "If you are trapped, tap on a pipe or wall so rescuers can hear you — shout only as a last resort to avoid inhaling dust",
                "Cover your nose and mouth with a cloth to filter dust and debris while evacuating",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do",
            "dos": [],
            "donts": [
                "Do not re-enter a building after an explosion — structural damage may not be visible and secondary explosions can occur",
                "Do not use mobile phones or electrical switches near a gas leak — sparks can trigger further explosions",
            ],
        },
        {
            "title": "Stay Safe",
            "dos": [],
            "donts": [
                "Do not approach the site of an explosion — leave the area immediately and let emergency services respond",
                "Do not touch or move suspicious packages or debris — report them to authorities",
            ],
        },
    ],
    "chemical_incident": [
        {
            "title": "Immediate Actions",
            "dos": [
                "If you suspect a chemical release, move upwind and uphill away from the source immediately",
                "Cover your nose and mouth with a damp cloth and move to a sealed indoor space if evacuation is not possible",
            ],
            "donts": [],
        },
        {
            "title": "Shelter in Place",
            "dos": [
                "Seal windows, doors, and vents with tape and damp towels if sheltering indoors — turn off all ventilation systems",
                "Listen to official emergency broadcasts for instructions on when it is safe to leave shelter",
            ],
            "donts": [],
        },
        {
            "title": "If Exposed",
            "dos": [
                "If you believe you have been exposed, remove and bag your clothing immediately and shower thoroughly with soap and water",
                "Seek medical attention even if you feel no immediate symptoms — some chemical effects are delayed",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do",
            "dos": [],
            "donts": [
                "Do not eat, drink, or touch your face if you think you have been exposed to a chemical release",
                "Do not return to the affected area until authorities declare it safe — residual contamination may not be visible or detectable by smell",
            ],
        },
        {
            "title": "Stay Informed",
            "dos": [],
            "donts": [
                "Do not use an open flame or smoke near a chemical release site — many chemicals are flammable",
                "Do not rely on smell to detect chemical hazards — many dangerous chemicals are odourless",
            ],
        },
    ],
    "conflict": [
        {
            "title": "Stay Low and Hidden",
            "dos": [
                "If you hear gunfire or explosions, immediately take cover behind a solid wall, in a ditch, or inside a building — stay low and do not move until the shooting stops",
                "Stay away from windows, doors, and open spaces — stay inside and away from exterior walls",
            ],
            "donts": [],
        },
        {
            "title": "Move to Safety",
            "dos": [
                "If you must move, do so quickly and with purpose — move from cover to cover and keep low",
                "Display a white flag or white cloth if you need to signal that you are a civilian and not a combatant",
            ],
            "donts": [],
        },
        {
            "title": "Reporting During Conflict",
            "dos": [
                "Only submit a report when you are in a safe location — do not expose yourself to danger to take a photo",
                "Use the offline queue if internet is unavailable — your report will send automatically when connectivity returns",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do",
            "dos": [],
            "donts": [
                "Do not approach military checkpoints, armed groups, or conflict zones to take photos or submit reports",
                "Do not share your location with anyone unless you are certain they are a trusted authority or aid worker",
            ],
        },
        {
            "title": "Your Safety First",
            "dos": [],
            "donts": [
                "Do not prioritise reporting over your personal safety — no report is worth risking your life",
                "Do not spread unverified information about troop movements, casualties, or conflict activity — this can endanger lives",
            ],
        },
    ],
    "civil_unrest": [
        {
            "title": "Avoid Crowds",
            "dos": [
                "Move away from large gatherings, protests, or demonstrations immediately if they become violent — do not stop to watch",
                "Seek shelter in a building with solid walls — stay away from windows and ground floor entrances",
            ],
            "donts": [],
        },
        {
            "title": "Stay Safe",
            "dos": [
                "Keep your phone charged and have emergency contacts saved — include local emergency services and a trusted person outside the area",
                "Follow instructions from police and emergency services — comply calmly and do not resist or argue",
            ],
            "donts": [],
        },
        {
            "title": "Reporting During Unrest",
            "dos": [
                "Only submit a report when you are in a safe location away from the unrest",
                "Keep your report factual — describe damage to infrastructure only, not individuals or groups involved",
            ],
            "donts": [],
        },
        {
            "title": "What NOT to Do",
            "dos": [],
            "donts": [
                "Do not photograph or film individuals in a crowd without their awareness — this can make you a target",
                "Do not share rumours or unverified information about the situation — only share information from official sources",
            ],
        },
        {
            "title": "Your Safety First",
            "dos": [],
            "donts": [
                "Do not prioritise reporting over your personal safety",
                "Do not engage with or confront anyone involved in the unrest — remove yourself from the situation immediately",
            ],
        },
    ],
}

# ── Part B — Reporting Guidelines ─────────────────────────────────────────────

REPORTING_GUIDELINES_SLIDES: list[dict] = [
    {
        "title": "Do's — Part 1",
        "bullets": [
            "Stay calm and take your time to fill in the details correctly",
            "Submit one report per location — avoid duplicates",
        ],
    },
    {
        "title": "Do's — Part 2",
        "bullets": [
            "Make sure your photo clearly shows the damage",
            "Follow guidelines issued by your local government",
        ],
    },
    {
        "title": "Do's — Part 3",
        "bullets": [
            "Add a location note if the building name is unclear",
            "Use the offline queue if you have no internet — your report will send automatically when connectivity returns",
        ],
    },
    {
        "title": "Do's — Part 4",
        "bullets": [
            "Only report what you can personally see and verify — do not guess or estimate",
            "Check that your GPS location is captured before submitting — look for the GPS indicator in the app",
        ],
    },
    {
        "title": "Don'ts — Part 1",
        "bullets": [
            "Do not risk your life to take a photo — safety first",
            "Do not submit photos of people without their consent",
        ],
    },
    {
        "title": "Don'ts — Part 2",
        "bullets": [
            "Do not submit duplicate reports for the same location",
            "Do not submit a report while you are in immediate danger — get to safety first",
        ],
    },
    {
        "title": "Don'ts — Part 3",
        "bullets": [
            "Do not follow guidelines that contradict instructions from your local government or emergency services — their instructions take priority",
            "Do not share your report ID or personal details with anyone claiming to verify your report — UNDP will never ask for this",
        ],
    },
]

# ── Part C — First Aid Tips ────────────────────────────────────────────────────

FIRST_AID_SLIDES: list[dict] = [
    {
        "title": "Controlling Bleeding — Do's",
        "bullets": [
            "Apply firm, direct pressure to the wound using a clean cloth, bandage, or any clean material available — maintain continuous pressure without lifting to check the wound",
            "If blood soaks through the material, add more material on top — do not remove the first layer",
            "Elevate the injured limb above the level of the heart if possible — this reduces blood flow to the wound",
            "Keep the injured person warm and calm — shock is a serious risk with significant blood loss",
        ],
    },
    {
        "title": "Controlling Bleeding — Advanced",
        "bullets": [
            "For a wound on an arm or leg that is bleeding severely and cannot be controlled with pressure, a tourniquet can be applied as a last resort — apply it 5 to 8 centimetres above the wound, note the time it was applied, and do not remove it",
            "Seek medical help as quickly as possible",
        ],
    },
    {
        "title": "Controlling Bleeding — Don'ts",
        "bullets": [
            "Do not remove an object that is embedded in a wound — stabilise it in place with padding around it and seek medical help",
            "Do not apply a tourniquet to the neck, chest, or abdomen — only to limbs",
            "Do not remove direct pressure from a wound to check if it has stopped bleeding — maintain pressure continuously for at least 10 minutes",
        ],
    },
    {
        "title": "Recovery Position",
        "bullets": [
            "Place an unconscious person who is breathing on their side — this prevents choking if they vomit",
            "Tilt their head back gently to keep the airway open",
            "Do not move someone if you suspect a spinal injury — only move them if they are in immediate danger",
            "Stay with the person and monitor their breathing until emergency help arrives",
        ],
    },
    {
        "title": "Treating Shock",
        "bullets": [
            "Lay the person flat and raise their legs about 30 centimetres if there is no suspected spinal or leg injury — this helps blood flow to vital organs",
            "Keep the person warm with a blanket or jacket — do not overheat them",
            "Do not give food or water to a person in shock",
            "Reassure the person calmly — anxiety worsens shock",
        ],
    },
    {
        "title": "Burns",
        "bullets": [
            "Cool a burn immediately with cool running water for at least 10 minutes — do not use ice, butter, or toothpaste",
            "Cover the burn loosely with a clean non-fluffy material such as cling film or a clean plastic bag",
            "Do not burst blisters — this increases the risk of infection",
            "For severe burns covering large areas or affecting the face, hands, or genitals, seek emergency medical help immediately",
        ],
    },
    {
        "title": "Fractures",
        "bullets": [
            "Immobilise the injured area in the position you find it — do not try to straighten a broken bone",
            "Support the injured area with padding such as clothing or blankets to prevent movement",
            "Do not move the person unless absolutely necessary — moving a person with an unimmobilised fracture can cause further injury",
            "Apply ice wrapped in a cloth to reduce swelling — do not apply ice directly to skin",
        ],
    },
    {
        "title": "Heat Exhaustion",
        "bullets": [
            "Move the person to a cool shaded area and lay them down with their legs slightly raised",
            "Give them cool water to drink if they are fully conscious — small sips regularly",
            "Fan them or apply cool damp cloths to their skin",
            "If symptoms worsen or do not improve within 30 minutes, treat as heatstroke and seek emergency help immediately — heatstroke is life-threatening",
        ],
    },
    {
        "title": "Smoke Inhalation",
        "bullets": [
            "Move the person to fresh air immediately — away from smoke and fumes",
            "Loosen tight clothing around the neck and chest to help them breathe",
            "If the person is not breathing, begin CPR if you are trained to do so",
            "Seek medical help even if the person seems to recover — smoke inhalation can cause delayed lung damage",
        ],
    },
    {
        "title": "When NOT to Move an Injured Person",
        "bullets": [
            "Do not move an injured person unless they are in immediate danger from fire, flood, or collapse",
            "If spinal injury is suspected — the person complains of neck or back pain, or has been in a fall, vehicle accident, or was hit on the head — do not move them at all",
            "If you must move them due to immediate danger, keep the head, neck, and spine aligned as one unit — do not allow the neck to bend or twist",
        ],
    },
    {
        "title": "Calling for Help",
        "bullets": [
            "Call emergency services using any available network — even with no signal, emergency calls may still connect on other networks",
            "If phone networks are down, ask others nearby to relay a message to emergency services",
            "Give your exact location, the number of injured people, and the nature of injuries as clearly and calmly as possible",
            "Stay on the line with emergency services if possible — they can guide you through first aid steps",
        ],
    },
]


# ── Seeding ────────────────────────────────────────────────────────────────────

async def seed_safety_tips(db) -> None:
    print("\n=== Part A: Safety Tips ===")
    for disaster_type, slides in SAFETY_TIPS.items():
        print(f"Seeding {disaster_type}...", end=" ", flush=True)
        try:
            await _upsert(db, f"content_safety-tips_{disaster_type}", _slides_value(slides))
            print("done")
        except Exception as exc:
            print(f"FAILED: {exc}")


async def seed_reporting_guidelines(db) -> None:
    print("\n=== Part B: Reporting Guidelines ===")
    print("Seeding reporting-guidelines...", end=" ", flush=True)
    try:
        await _upsert(db, "content_reporting-guidelines", _slides_value(REPORTING_GUIDELINES_SLIDES))
        print("done")
    except Exception as exc:
        print(f"FAILED: {exc}")


async def seed_first_aid(db) -> None:
    print("\n=== Part C: First Aid Tips ===")
    print("Seeding first-aid...", end=" ", flush=True)
    try:
        await _upsert(db, "content_first-aid", _slides_value(FIRST_AID_SLIDES))
        print("done")
    except Exception as exc:
        print(f"FAILED: {exc}")


async def sync_string_keys(db) -> None:
    print("\nSyncing translation string keys...", end=" ", flush=True)
    try:
        from app.routers.language_packages import ensure_string_keys_synced
        await ensure_string_keys_synced(db)
        print("done")
    except Exception as exc:
        print(f"FAILED: {exc}")


# ── Entry point ────────────────────────────────────────────────────────────────

async def main() -> None:
    async with AsyncSessionLocal() as db:
        await seed_safety_tips(db)
        await seed_reporting_guidelines(db)
        await seed_first_aid(db)
        await sync_string_keys(db)
    print("\nSeeding complete.")


if __name__ == "__main__":
    asyncio.run(main())
