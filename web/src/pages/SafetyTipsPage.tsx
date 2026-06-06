import { useState, useCallback, useEffect } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { enqueueProgress } from "../utils/progressQueue";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const GREEN = "#38A169";
const BG = "#F6F3F2";
const CARD_BG = "#FFFFFF";
const FIELD_BG = "#F0EDED";
const BASE_URL = (import.meta.env.VITE_API_URL as string) || "http://127.0.0.1:8000";
const SLIDE_FETCH_TIMEOUT = 8_000;

// ── Types ──────────────────────────────────────────────────────────────────────

// Part A: each slide has separate DO and DON'T bullet arrays (backend schema)
interface SlideA {
  title: string;
  dos: string[];
  donts: string[];
}

// Parts B/C: bullet list slides
interface SlideBC {
  title: string;
  bullets: string[];
}

interface DisasterType {
  id: string;
  label: string;
  icon: string;
  slides: SlideA[];
}

type Part = "A" | "B" | "C";

type View =
  | { type: "home" }
  | { type: "partA_list" }
  | { type: "slide"; part: Part; disasterId?: string };

// ── Material Symbol component ─────────────────────────────────────────────────

function MatIcon({
  name,
  size = 24,
  fill = false,
  color = "currentColor",
  style: extraStyle,
}: {
  name: string;
  size?: number;
  fill?: boolean;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: "'Material Symbols Outlined'",
        fontWeight: 400,
        fontStyle: "normal",
        fontSize: size,
        lineHeight: 1,
        letterSpacing: "normal",
        textTransform: "none",
        display: "inline-block",
        whiteSpace: "nowrap",
        wordWrap: "normal",
        direction: "ltr",
        WebkitFontSmoothing: "antialiased",
        fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
        color,
        userSelect: "none",
        ...extraStyle,
      }}
    >
      {name}
    </span>
  );
}

// ── Translation key helper ────────────────────────────────────────────────────
// Returns a factory bound to the i18next `t` function from the calling component.
// Keys follow the backend pipeline pattern:
//   SAFETY_TIP_A_{DISASTER}_SLIDE_{N}_TITLE
//   SAFETY_TIP_A_{DISASTER}_SLIDE_{N}_DO_{M}
//   SAFETY_TIP_A_{DISASTER}_SLIDE_{N}_DONT_{M}
//   SAFETY_TIP_B_SLIDE_{N}_TITLE / BULLET_{M}
//   SAFETY_TIP_C_SLIDE_{N}_TITLE / BULLET_{M}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTip(t: (key: string, opts?: any) => string) {
  return function tip(
    part: Part,
    disaster: string,
    slideIdx: number,       // 1-based
    field: "TITLE" | "DO" | "DONT" | "BULLET",
    bulletIdx: number,      // 1-based; 0 = no suffix (for TITLE)
    fallback: string,
  ): string {
    const d = disaster ? `_${disaster.toUpperCase().replace(/-/g, "_")}` : "";
    const b = bulletIdx > 0 ? `_${bulletIdx}` : "";
    return t(`SAFETY_TIP_${part}${d}_SLIDE_${slideIdx}_${field}${b}`, { defaultValue: fallback });
  };
}

// ── Fallback content (used when API is unavailable and cache is empty) ─────────

const DISASTERS_FALLBACK: DisasterType[] = [
  {
    id: "earthquake", label: "Earthquake", icon: "volcano",
    slides: [
      { title: "Drop and Take Cover", dos: ["Drop to your hands and knees immediately", "Take cover under a sturdy table or desk, or against an interior wall away from windows"], donts: [] },
      { title: "Hold On and Stay Put", dos: ["Hold on and protect your head and neck with your arms", "Stay where you are until the shaking stops — most injuries happen when people try to move"], donts: [] },
      { title: "Move Away from Outdoor Hazards", dos: ["If outdoors, move away from buildings, streetlights, and utility wires", "If in a vehicle, pull over away from buildings and overpasses and stay inside"], donts: [] },
      { title: "After the Shaking Stops", dos: ["After shaking stops, check yourself and others for injuries before moving", "Expect aftershocks — drop, cover, and hold on each time"], donts: [] },
      { title: "Run Outside or Use Doorways", dos: [], donts: ["Do not run outside while shaking is happening — most injuries occur when people try to move during shaking", "Do not stand in a doorway — doorways offer no special protection"] },
      { title: "Use Elevators or Open Flames", dos: [], donts: ["Do not use elevators after an earthquake — use stairs only", "Do not light candles, matches, or any open flame — gas pipes may be damaged"] },
      { title: "Re-enter or Spread Rumours", dos: [], donts: ["Do not return to a damaged building until declared structurally safe", "Do not spread unverified information — only share from official sources"] },
    ],
  },
  {
    id: "flood", label: "Flood", icon: "water_drop",
    slides: [
      { title: "Move to Higher Ground", dos: ["Move immediately to higher ground if flooding is imminent", "Turn off utilities at the main switch if safe to do so"], donts: [] },
      { title: "Disconnect Appliances and Evacuate", dos: ["Disconnect electrical appliances — do not touch them if wet or standing in water", "If evacuation is ordered, leave immediately with your emergency kit"], donts: [] },
      { title: "If Trapped, Signal for Help", dos: ["If trapped, move to the highest floor and signal for help from a window", "Drink only bottled or boiled water — floodwater contaminates supplies"], donts: [] },
      { title: "Protect Yourself and Monitor Updates", dos: ["Wear rubber boots and waterproof gloves if walking through floodwater", "Listen to official emergency broadcasts for updates and evacuation routes"], donts: [] },
      { title: "Walk or Drive Through Floodwater", dos: [], donts: ["Do not walk through moving floodwater — 15cm of fast-moving water can knock an adult down", "Do not drive through flooded roads — water depth is impossible to judge"] },
      { title: "Touch Floodwater or Return Too Soon", dos: [], donts: ["Do not touch floodwater if avoidable — it may contain sewage, chemicals, or debris", "Do not return home until authorities declare it safe"] },
      { title: "Use Damaged Appliances or Ignore Orders", dos: [], donts: ["Do not use electrical equipment that has been in contact with floodwater", "Do not ignore evacuation orders — each flood event is different"] },
    ],
  },
  {
    id: "tsunami", label: "Tsunami", icon: "tsunami",
    slides: [
      { title: "Move to Higher Ground Immediately", dos: ["If you feel a strong earthquake near the coast, move immediately to higher ground — do not wait for a warning", "A sudden recession of the sea is a natural warning sign — move inland immediately"], donts: [] },
      { title: "Move on Foot and Seek High Ground", dos: ["Move on foot if possible — roads may be congested or damaged", "Go to a designated tsunami evacuation zone or the highest ground available"], donts: [] },
      { title: "If Caught in a Wave", dos: ["If caught in a wave, grab onto something that floats", "After the first wave, stay where you are — later waves are often larger"], donts: [] },
      { title: "Wait for the Official All-Clear", dos: ["Listen to official broadcasts — an all-clear must come from authorities before returning", "Help others move to higher ground only if you can do so safely"], donts: [] },
      { title: "Go to the Coast or Assume It's Over", dos: [], donts: ["Do not go to the coast to watch the tsunami — people who do are frequently killed", "Do not assume danger is over after the first wave — subsequent waves can arrive for hours"] },
      { title: "Use Bridges or Return Too Soon", dos: [], donts: ["Do not use bridges or low-lying roads during or after a tsunami warning", "Do not return to coastal areas until authorities issue a formal all-clear"] },
      { title: "Rely Solely on Sirens or Drive Through Zones", dos: [], donts: ["Do not rely solely on sirens — if you feel a large earthquake near the coast, act immediately", "Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away"] },
    ],
  },
  {
    id: "hurricane_cyclone", label: "Hurricane / Cyclone", icon: "cyclone",
    slides: [
      { title: "Follow Evacuation Orders", dos: ["Follow evacuation orders immediately when issued", "Board up windows and secure outdoor furniture before the storm arrives"], donts: [] },
      { title: "Prepare Emergency Supplies", dos: ["Prepare an emergency kit with water, food, medications, flashlight — enough for 72 hours", "Fill clean containers with drinking water before the storm — supplies may be disrupted"], donts: [] },
      { title: "Stay Indoors During the Storm", dos: ["Stay indoors during the storm, away from windows and glass doors", "If the eye passes over, stay sheltered — dangerous winds will return from the opposite direction"], donts: [] },
      { title: "After the Storm", dos: ["After the storm, check your home for structural damage before entering", "Listen to official broadcasts for road conditions and public health guidance"], donts: [] },
      { title: "Go Outside During the Storm", dos: [], donts: ["Do not go outside during the storm — flying debris causes most hurricane fatalities", "Do not assume the storm is over if winds suddenly calm — the eye passes quickly"] },
      { title: "Use Generators Indoors or Touch Downed Lines", dos: [], donts: ["Do not use generators or charcoal grills indoors — carbon monoxide poisoning is a leading cause of post-hurricane deaths", "Do not touch downed power lines or walk through standing water near them"] },
      { title: "Drive Through Flooding or Return Too Soon", dos: [], donts: ["Do not drive through flooded roads — hurricane flooding is extensive", "Do not return to evacuated areas until authorities declare it safe"] },
    ],
  },
  {
    id: "wildfire", label: "Wildfire", icon: "local_fire_department",
    slides: [
      { title: "Evacuate Immediately When Ordered", dos: ["If you receive an evacuation order, leave immediately — wildfires change direction rapidly", "Close all windows and doors as you leave to slow fire entering — leave them unlocked for emergency responders"], donts: [] },
      { title: "Protect Yourself While Evacuating", dos: ["Wear a mask or cover your nose and mouth with a damp cloth while evacuating", "Take your emergency kit, medications, important documents, and pets if you can do so quickly"], donts: [] },
      { title: "If There Is No Escape Route", dos: ["If caught with no escape route, shelter in a building or lie face down in a ditch away from vegetation", "Breathe through your nose — nasal passages filter more smoke than mouth breathing"], donts: [] },
      { title: "After a Wildfire", dos: ["After a wildfire, check your roof for embers before re-entering — embers can smoulder for hours", "Wear a mask and gloves when working in ash — it may contain toxic materials"], donts: [] },
      { title: "Ignore Orders or Re-enter Too Soon", dos: [], donts: ["Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run", "Do not re-enter evacuated areas until declared safe — hidden hot spots can reignite"] },
      { title: "Park Under Trees or Use Contaminated Water", dos: [], donts: ["Do not park under trees during or after a wildfire — weakened trees can fall without warning", "Do not use water that may be contaminated by fire retardants — use bottled water only"] },
      { title: "Inhale Ash or Fight the Fire Yourself", dos: [], donts: ["Do not inhale ash unnecessarily — wear a properly fitted particulate mask where available", "Do not attempt to fight a wildfire yourself — evacuate and let trained firefighters handle it"] },
    ],
  },
  {
    id: "explosion", label: "Explosion", icon: "explosion",
    slides: [
      { title: "Take Cover Immediately", dos: ["Immediately take cover behind a solid object or drop to the ground face down", "Cover your head and neck with your arms to protect from debris"], donts: [] },
      { title: "Move Away and Help If Safe", dos: ["Once the immediate danger passes, move away from the site quickly and calmly", "Help injured people move away only if you can do so safely without putting yourself at risk"], donts: [] },
      { title: "Seek Medical Attention and Report", dos: ["Seek medical attention for any injuries — blast injuries may not be immediately visible", "Report the explosion to emergency services as soon as you are in a safe location"], donts: [] },
      { title: "Follow Official Instructions", dos: ["Follow instructions from emergency services and authorities on the ground", "Stay upwind of the explosion site to avoid inhaling smoke or chemical fumes"], donts: [] },
      { title: "Return to the Site or Use Phones Near Gas", dos: [], donts: ["Do not return to the explosion site — secondary explosions are common", "Do not use mobile phones or electrical switches near a gas leak — sparks can trigger another explosion"] },
      { title: "Touch Debris or Spread Rumours", dos: [], donts: ["Do not touch suspicious packages or debris around the site", "Do not post unverified information about the cause — this can spread panic"] },
      { title: "Block Access or Enter Damaged Buildings", dos: [], donts: ["Do not block emergency service access routes", "Do not enter damaged buildings — structural collapse risk is high after an explosion"] },
    ],
  },
  {
    id: "chemical_incident", label: "Chemical Incident", icon: "science",
    slides: [
      { title: "Move Upwind or Shelter in Place", dos: ["Move upwind and uphill from the incident immediately", "If indoors, shelter in place — close all windows, doors, and ventilation systems"], donts: [] },
      { title: "Decontaminate and Cover Your Mouth", dos: ["If you have been exposed, remove outer clothing and wash skin thoroughly with water", "Cover your nose and mouth with a wet cloth if you must move through contaminated air"], donts: [] },
      { title: "Follow Evacuation Instructions", dos: ["Follow evacuation instructions from emergency services exactly", "Seek medical attention even if you feel well — chemical exposure symptoms can be delayed"], donts: [] },
      { title: "Monitor Updates and Flush Eyes If Needed", dos: ["Listen to official broadcasts for information on safe zones and decontamination points", "If your eyes are burning, flush them with clean water for at least 15 minutes"], donts: [] },
      { title: "Approach the Source or Eat Nearby", dos: [], donts: ["Do not approach the source of a chemical incident — even brief exposure can be fatal", "Do not eat, drink, or smoke in or near the affected area"] },
      { title: "Trust Your Nose or Re-enter Too Soon", dos: [], donts: ["Do not rely on smell to determine safety — many hazardous chemicals are odourless", "Do not re-enter the affected area until authorities declare it safe"] },
      { title: "Spread Rumours or Remove Protective Gear", dos: [], donts: ["Do not spread rumours about the cause — chemical incidents cause significant public panic", "Do not remove protective clothing given by emergency services until instructed"] },
    ],
  },
  {
    id: "conflict", label: "Conflict", icon: "military_tech",
    slides: [
      { title: "Find Cover and Stay Away from Windows", dos: ["If caught in an active conflict zone, find cover immediately — lie flat behind a solid structure", "Stay away from windows, doors, and open spaces during active shooting or shelling"], donts: [] },
      { title: "Follow Legitimate Authority and Move Safely", dos: ["Follow instructions from legitimate security forces or humanitarian organisations", "If evacuating, move quickly and low, using buildings and terrain as cover"], donts: [] },
      { title: "Keep an Emergency Bag Ready", dos: ["Keep an emergency bag ready with documents, water, food, and medications", "Identify safe exit routes from your home and neighbourhood in advance"], donts: [] },
      { title: "Shelter in Place and Conserve Power", dos: ["If sheltering in place, move to an interior room away from windows on the lowest floor", "Conserve phone battery and charge devices whenever power is available"], donts: [] },
      { title: "Film Military or Touch Unexploded Ordnance", dos: [], donts: ["Do not film or photograph military personnel or equipment — this can put you at serious risk", "Do not approach unexploded ordnance or debris — mark the location and report it"] },
      { title: "Use Open Flames or Post Your Location", dos: [], donts: ["Do not use open flames at night — light can attract attention in conflict zones", "Do not spread your location on social media during active conflict"] },
      { title: "Cross Front Lines or Ignore Curfews", dos: [], donts: ["Do not attempt to cross front lines or enter restricted areas", "Do not ignore curfews or movement restrictions imposed by authorities"] },
    ],
  },
  {
    id: "civil_unrest", label: "Civil Unrest", icon: "groups_2",
    slides: [
      { title: "Move Calmly to the Edges", dos: ["If caught in a crowd disturbance, move calmly to the edges and away from the crowd", "Stay aware of your surroundings and identify exit routes before any situation escalates"], donts: [] },
      { title: "If Tear Gas Is Used", dos: ["If tear gas is used, move upwind and flush eyes with clean water", "Cover your nose and mouth with a wet cloth to reduce inhalation of irritants"], donts: [] },
      { title: "Stay in Contact and Follow Instructions", dos: ["Stay in contact with family or trusted contacts about your location", "Follow instructions from police or security forces unless doing so puts you at immediate risk"], donts: [] },
      { title: "Observe Safely and Document from a Distance", dos: ["If you are a reporter or observer, identify yourself clearly and stay to the periphery", "Document damage and injuries only from a safe distance"], donts: [] },
      { title: "Engage or Blend In With Crowds", dos: [], donts: ["Do not engage with crowds or attempt to intervene in confrontations", "Do not wear clothing that could be mistaken for that of any group involved"] },
      { title: "Share Real-Time Movements or Use Flash", dos: [], donts: ["Do not share real-time location of security forces or crowd movements on social media", "Do not use flash photography in tense situations — it can provoke a response"] },
      { title: "Block Emergency Routes or Spread Rumours", dos: [], donts: ["Do not block emergency vehicle access routes", "Do not spread unverified reports of casualties or causes — this escalates tensions"] },
    ],
  },
];

const PART_B_FALLBACK: SlideBC[] = [
  { title: "Only Report What You Can Safely See", bullets: ["Never put yourself in danger to get closer to an incident. If you cannot see it from a safe distance, do not report it.", "Your safety is more valuable than any report. Accurate reporting from a safe vantage point is always better than no report at all."] },
  { title: "Take Clear Photos from a Safe Distance", bullets: ["Use zoom rather than approaching the damage. A clear photo from 20 metres is more useful than a blurred one from 5 metres.", "Photograph the full structure, not just the damage. Context — surrounding buildings, street layout — is essential for assessment."] },
  { title: "Be Accurate with Location — Use GPS When Possible", bullets: ["Enable GPS on your device before reaching the site. Allow the app to auto-detect your location for the highest accuracy.", "If GPS is unavailable, note the building name, street address, or a nearby landmark to allow accurate manual geo-coding."] },
  { title: "One Report Per Building — No Duplicates", bullets: ["Submit only one report per building per visit. Duplicate reports waste analyst time and distort damage statistics.", "If conditions have changed significantly since your last report on a building, submit an update rather than a new report."] },
  { title: "Your Identity is Protected — Reports Are Anonymised", bullets: ["Your name, email, and device information are encrypted at rest and never included in exported datasets.", "Reports shared with humanitarian organisations contain only location data, damage classification, and timestamps — never personal identifiers."] },
];

const PART_C_FALLBACK: SlideBC[] = [
  { title: "Controlling Bleeding", bullets: ["Apply firm, direct pressure to the wound with a clean cloth or bandage and maintain it continuously for at least 10 minutes.", "Elevate the injured limb above heart level if possible. Do not remove the cloth — add more on top if it soaks through."] },
  { title: "Recovery Position", bullets: ["Place an unconscious, breathing person on their side with their top knee bent forward to prevent them rolling back.", "Tilt their head back gently to open the airway, and place their hand under their cheek. Monitor breathing continuously."] },
  { title: "Treating Shock", bullets: ["Lay the person flat and, if not injured, raise their legs 20–30 cm above heart level to improve blood flow to vital organs.", "Keep them warm with a blanket. Do not give food or water. Reassure them calmly and monitor their breathing until help arrives."] },
  { title: "Burns Treatment", bullets: ["Cool the burn immediately under cool (not cold) running water for at least 20 minutes. Remove jewellery near the burn if possible.", "Cover the burn loosely with cling film or a clean non-fluffy material. Do not apply butter, toothpaste, or ice."] },
  { title: "Fractures and Immobilisation", bullets: ["Do not attempt to straighten a fractured limb. Immobilise it in the position found using a splint and soft padding.", "A splint can be improvised from a straight stick, rolled newspaper, or folded clothing tied firmly — not tightly — above and below the fracture."] },
  { title: "When Not to Move an Injured Person", bullets: ["Do not move someone who may have a spinal injury (high-impact trauma, neck pain, tingling/numbness) unless they are in immediate danger.", "If you must move them, keep the head, neck, and spine aligned at all times and use multiple people to maintain a straight carry."] },
];

// ── API helpers ────────────────────────────────────────────────────────────────

async function fetchAndCacheSlides<T>(url: string, cacheKey: string): Promise<T[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLIDE_FETCH_TIMEOUT);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const slides: T[] = data.slides ?? [];
    if (slides.length > 0) {
      try { localStorage.setItem(cacheKey, JSON.stringify(slides)); } catch {}
    }
    return slides.length > 0 ? slides : null;
  } catch {
    return null;
  }
}

function getSlidesFromCache<T>(cacheKey: string): T[] | null {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const slides: T[] = JSON.parse(raw);
      if (Array.isArray(slides) && slides.length > 0) return slides;
    }
  } catch {}
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function lsKey(part: Part, id?: string): string {
  if (part === "A") return `cr_safety_partA_${id}`;
  if (part === "B") return "cr_safety_partB";
  return "cr_safety_partC";
}

function getStorage(): Storage {
  return localStorage.getItem("cr_reporter_id") ? localStorage : sessionStorage;
}

function isComplete(part: Part, id?: string): boolean {
  const key = lsKey(part, id);
  return localStorage.getItem(key) === "1" || sessionStorage.getItem(key) === "1";
}

function markComplete(part: Part, id?: string) {
  getStorage().setItem(lsKey(part, id), "1");
}

function slideContentKey(part: Part, disasterId?: string): string {
  return part === "A" ? `cr_content_safetyA_${disasterId}` : `cr_content_safety${part}`;
}

function slideFetchURL(part: Part, disasterId?: string): string {
  if (part === "A") return `${BASE_URL}/api/content/safety-tips/${disasterId}`;
  if (part === "B") return `${BASE_URL}/api/content/reporting-guidelines`;
  return `${BASE_URL}/api/content/first-aid`;
}

// ── Nav footer ─────────────────────────────────────────────────────────────────

function SlideNavFooter({
  current,
  total,
  done,
  isPending,
  onPrev,
  onNext,
  onComplete,
  t,
}: {
  current: number;
  total: number;
  done: boolean;
  isPending: boolean;
  onPrev: () => void;
  onNext: () => void;
  onComplete: () => void;
  // opts is optional so callers that pass only a key still compile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (k: string, opts?: any) => string;
}) {
  const isLast = current === total - 1;
  return (
    <div style={{ padding: "14px 24px", background: BG, borderTop: `1px solid #E4E2E1`, display: "flex", gap: 10, flexShrink: 0 }}>
      <button
        onClick={onPrev}
        disabled={current === 0}
        style={{
          flex: 1, padding: "12px 0", borderRadius: 10,
          border: `1.5px solid ${current === 0 ? "#E4E2E1" : BLUE}`,
          background: CARD_BG, color: current === 0 ? "#C1C7D2" : BLUE,
          fontWeight: 600, fontSize: 14, cursor: current === 0 ? "not-allowed" : "pointer",
        }}
      >
        {t("COMMON_PREVIOUS", { defaultValue: "← Previous" })}
      </button>
      {isLast ? (
        <button
          onClick={onComplete}
          disabled={isPending}
          style={{
            flex: 2, padding: "12px 0", borderRadius: 10, border: "none",
            background: done ? GREEN : BLUE, color: "#fff",
            fontWeight: 700, fontSize: 14, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}
        >
          {done
            ? t("SAFETY_COMPLETED", { defaultValue: "✓ Completed" })
            : t("SAFETY_MARK_COMPLETE", { defaultValue: "Mark as Complete" })}
          {!done && <MatIcon name="check" size={16} color="#fff" />}
        </button>
      ) : (
        <button
          onClick={onNext}
          style={{
            flex: 1, padding: "12px 0", borderRadius: 10, border: "none",
            background: BLUE, color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}
        >
          {t("COMMON_NEXT", { defaultValue: "Next →" })}
        </button>
      )}
    </div>
  );
}

// ── SlideViewerA (Part A — dos / donts schema) ────────────────────────────────

function SlideViewerA({
  slides,
  disasterId,
  completionKey,
  onComplete,
}: {
  slides: SlideA[];
  disasterId: string;
  completionKey: { part: Part; id?: string };
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const tip = makeTip(t);
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState(() => isComplete(completionKey.part, completionKey.id));
  const [isPending, setIsPending] = useState(false);
  const total = slides.length;
  const slide = slides[current] ?? { title: "", dos: [], donts: [] };
  const hasDos = slide.dos.length > 0;
  const hasDonts = slide.donts.length > 0;

  async function handleComplete() {
    setIsPending(true);
    markComplete(completionKey.part, completionKey.id);
    setDone(true);
    const reporterId = localStorage.getItem("cr_reporter_id");
    if (reporterId) {
      const partKey = completionKey.id ? `${completionKey.part}_${completionKey.id}` : completionKey.part;
      enqueueProgress(reporterId, partKey);
    }
    setIsPending(false);
    onComplete();
  }

  if (slides.length === 0) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#C1C7D2", fontSize: 14 }}>Loading…</div>;
  }

  const slideTitle = tip("A", disasterId, current + 1, "TITLE", 0, slide.title);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Counter + dots */}
      <div style={{ padding: "10px 24px", background: BG, borderBottom: `1px solid #E4E2E1`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: "#717782", fontWeight: 500 }}>
          {t("SAFETY_SLIDE_PROGRESS", { n: current + 1, total, defaultValue: "Slide {{n}} of {{total}}" })}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {slides.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === current ? BLUE : i < current ? GREEN : "#C1C7D2", transition: "background 0.2s" }} />
          ))}
        </div>
      </div>

      {/* Slide content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.4 }}>
          {slideTitle}
        </h3>

        {hasDos && (
          <div style={{ background: "#f0fff4", border: "2px solid #9ae6b4", borderRadius: 16, padding: "16px 20px", marginBottom: hasDonts ? 12 : 0 }}>
            <div style={{ display: "inline-block", background: GREEN, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "2px 10px", marginBottom: 10, letterSpacing: 0.5, textTransform: "uppercase" }}>
              {t("SAFETY_DO", { defaultValue: "DO" })}
            </div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {slide.dos.map((d, i) => (
                <li key={i} style={{ color: "#414751", fontSize: 14, lineHeight: 1.7, marginBottom: i < slide.dos.length - 1 ? 6 : 0 }}>
                  {tip("A", disasterId, current + 1, "DO", i + 1, d)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {hasDonts && (
          <div style={{ background: "#fff5f5", border: "2px solid #feb2b2", borderRadius: 16, padding: "16px 20px" }}>
            <div style={{ display: "inline-block", background: "#e53e3e", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 4, padding: "2px 10px", marginBottom: 10, letterSpacing: 0.5, textTransform: "uppercase" }}>
              {t("SAFETY_DONT", { defaultValue: "DON'T" })}
            </div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {slide.donts.map((d, i) => (
                <li key={i} style={{ color: "#414751", fontSize: 14, lineHeight: 1.7, marginBottom: i < slide.donts.length - 1 ? 6 : 0 }}>
                  {tip("A", disasterId, current + 1, "DONT", i + 1, d)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {done && (
          <div style={{ marginTop: 16, padding: "10px 16px", background: "#f0fff4", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <MatIcon name="check_circle" size={18} color={GREEN} fill />
            <span style={{ fontSize: 13, color: "#276749", fontWeight: 600 }}>{t("SAFETY_COMPLETED", { defaultValue: "✓ Completed" })}</span>
          </div>
        )}
      </div>

      <SlideNavFooter
        current={current} total={total} done={done} isPending={isPending}
        onPrev={() => setCurrent((c) => Math.max(0, c - 1))}
        onNext={() => setCurrent((c) => Math.min(total - 1, c + 1))}
        onComplete={handleComplete}
        t={t}
      />
    </div>
  );
}

// ── SlideViewerBC (Parts B / C — bullet list schema) ──────────────────────────

function SlideViewerBC({
  slides,
  part,
  completionKey,
  onComplete,
}: {
  slides: SlideBC[];
  part: "B" | "C";
  completionKey: { part: Part; id?: string };
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const tip = makeTip(t);
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState(() => isComplete(completionKey.part, completionKey.id));
  const [isPending, setIsPending] = useState(false);
  const total = slides.length;
  const slide = slides[current] ?? { title: "", bullets: [] };

  async function handleComplete() {
    setIsPending(true);
    markComplete(completionKey.part, completionKey.id);
    setDone(true);
    const reporterId = localStorage.getItem("cr_reporter_id");
    if (reporterId) {
      enqueueProgress(reporterId, completionKey.part);
    }
    setIsPending(false);
    onComplete();
  }

  if (slides.length === 0) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#C1C7D2", fontSize: 14 }}>Loading…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Counter + dots */}
      <div style={{ padding: "10px 24px", background: BG, borderBottom: `1px solid #E4E2E1`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: "#717782", fontWeight: 500 }}>
          {t("SAFETY_SLIDE_PROGRESS", { n: current + 1, total, defaultValue: "Slide {{n}} of {{total}}" })}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {slides.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === current ? BLUE : i < current ? GREEN : "#C1C7D2", transition: "background 0.2s" }} />
          ))}
        </div>
      </div>

      {/* Slide content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
        <div style={{ background: "#F6F3F2", border: "1.5px solid #E4E2E1", borderRadius: 16, padding: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: 17, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.4 }}>
            {tip(part, "", current + 1, "TITLE", 0, slide.title)}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {slide.bullets.map((b, i) => (
              <li key={i} style={{ color: "#414751", fontSize: 14, lineHeight: 1.7, marginBottom: i < slide.bullets.length - 1 ? 8 : 0 }}>
                {tip(part, "", current + 1, "BULLET", i + 1, b)}
              </li>
            ))}
          </ul>
        </div>
        {done && (
          <div style={{ marginTop: 16, padding: "10px 16px", background: "#f0fff4", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <MatIcon name="check_circle" size={18} color={GREEN} fill />
            <span style={{ fontSize: 13, color: "#276749", fontWeight: 600 }}>{t("SAFETY_COMPLETED", { defaultValue: "✓ Completed" })}</span>
          </div>
        )}
      </div>

      <SlideNavFooter
        current={current} total={total} done={done} isPending={isPending}
        onPrev={() => setCurrent((c) => Math.max(0, c - 1))}
        onNext={() => setCurrent((c) => Math.min(total - 1, c + 1))}
        onComplete={handleComplete}
        t={t}
      />
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SafetyTipsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ type: "home" });
  const [rev, setRev] = useState(0);
  // Slides fetched from API — keyed by slideContentKey()
  const [slidesCache, setSlidesCache] = useState<Map<string, SlideA[] | SlideBC[]>>(new Map());

  // Inject Material Symbols font if not already loaded
  useEffect(() => {
    const id = "material-symbols-stylesheet";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // Background-fetch slides when entering a slide view
  useEffect(() => {
    if (view.type !== "slide") return;
    const { part, disasterId } = view;
    const cacheKey = slideContentKey(part, disasterId);
    const url = slideFetchURL(part, disasterId);

    if (part === "A") {
      fetchAndCacheSlides<SlideA>(url, cacheKey).then((slides) => {
        if (slides) setSlidesCache((prev) => new Map(prev).set(cacheKey, slides));
      });
    } else {
      fetchAndCacheSlides<SlideBC>(url, cacheKey).then((slides) => {
        if (slides) setSlidesCache((prev) => new Map(prev).set(cacheKey, slides));
      });
    }
  }, [view]);

  const refresh = useCallback(() => setRev((n) => n + 1), []);
  void rev;

  // ── Helpers to resolve slides for slide view ─────────────────────────────────

  function resolvePartASlides(disasterId: string): SlideA[] {
    const key = slideContentKey("A", disasterId);
    const fromCache = slidesCache.get(key) as SlideA[] | undefined;
    if (fromCache?.length) return fromCache;
    const fromLS = getSlidesFromCache<SlideA>(key);
    if (fromLS?.length) return fromLS;
    return DISASTERS_FALLBACK.find((d) => d.id === disasterId)?.slides ?? [];
  }

  function resolveSlidesBC(part: "B" | "C"): SlideBC[] {
    const key = slideContentKey(part);
    const fromCache = slidesCache.get(key) as SlideBC[] | undefined;
    if (fromCache?.length) return fromCache;
    const fromLS = getSlidesFromCache<SlideBC>(key);
    if (fromLS?.length) return fromLS;
    return part === "B" ? PART_B_FALLBACK : PART_C_FALLBACK;
  }

  // ── Slide view ───────────────────────────────────────────────────────────────
  if (view.type === "slide") {
    const { part, disasterId } = view;
    const backTarget: View = part === "A" ? { type: "partA_list" } : { type: "home" };

    let slideTitle: string;
    if (part === "A") {
      slideTitle = DISASTERS_FALLBACK.find((d) => d.id === disasterId)?.label ?? "";
    } else if (part === "B") {
      slideTitle = t("SAFETY_PART_B_TITLE", { defaultValue: "Reporting Guidelines" });
    } else {
      slideTitle = t("SAFETY_PART_C_TITLE", { defaultValue: "First Aid Essentials" });
    }

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
        <header className="page-header" style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}>
          <button className="page-header-back" onClick={() => setView(backTarget)}>
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="page-header-title">{slideTitle}</span>
          <div className="page-header-spacer" />
        </header>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {part === "A" ? (
            <SlideViewerA
              key={disasterId}
              slides={resolvePartASlides(disasterId!)}
              disasterId={disasterId!}
              completionKey={{ part, id: disasterId }}
              onComplete={() => { refresh(); setView(backTarget); }}
            />
          ) : (
            <SlideViewerBC
              key={part}
              slides={resolveSlidesBC(part as "B" | "C")}
              part={part as "B" | "C"}
              completionKey={{ part }}
              onComplete={() => { refresh(); setView(backTarget); }}
            />
          )}
        </div>
      </div>
    );
  }

  // ── Part A disaster list ─────────────────────────────────────────────────────
  if (view.type === "partA_list") {
    const completedA = DISASTERS_FALLBACK.filter((d) => isComplete("A", d.id)).length;

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
        <header className="page-header" style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}>
          <button className="page-header-back" onClick={() => setView({ type: "home" })}>
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="page-header-title">Part A — Safety Tips</span>
          <div className="page-header-spacer" />
        </header>

        <div style={{ padding: "12px 24px 0", background: BG }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#717782", fontWeight: 500 }}>{completedA} of 9 completed</span>
          </div>
          <div style={{ height: 6, background: "#E4E2E1", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(completedA / 9) * 100}%`, background: BLUE, borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 32px" }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
            Tap a disaster type to read the safety tips
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {DISASTERS_FALLBACK.map((d) => {
              const done = isComplete("A", d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => setView({ type: "slide", part: "A", disasterId: d.id })}
                  style={{ display: "flex", alignItems: "center", background: FIELD_BG, border: "none", borderRadius: 12, padding: "14px 16px", cursor: "pointer", textAlign: "left", transition: "background 0.15s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#E8E5E4")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = FIELD_BG)}
                >
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: "#E4E2E1", display: "flex", alignItems: "center", justifyContent: "center", marginRight: 14, flexShrink: 0 }}>
                    <MatIcon name={d.icon} size={22} color={BLUE} />
                  </div>
                  <span style={{ flex: 1, fontWeight: 700, fontSize: 15, color: "#1B1C1C" }}>{d.label}</span>
                  {done ? <MatIcon name="check_circle" size={22} color={GREEN} fill /> : <MatIcon name="chevron_right" size={20} color="#C1C7D2" />}
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 32, background: "#EAE7E7", borderRadius: 16, padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <MatIcon name="cloud_done" size={28} color={BLUE} />
            <p style={{ margin: "10px 0 4px", fontSize: 14, fontWeight: 600, color: "#1B1C1C" }}>Ready for the field</p>
            <p style={{ margin: 0, fontSize: 13, color: "#717782", lineHeight: 1.5 }}>Content works offline and is available in all supported languages</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Home screen ──────────────────────────────────────────────────────────────

  const completedA = DISASTERS_FALLBACK.filter((d) => isComplete("A", d.id)).length;
  const partBDone = isComplete("B");
  const partCDone = isComplete("C");
  const shownChips = DISASTERS_FALLBACK.slice(0, 3);
  const moreCount = DISASTERS_FALLBACK.length - shownChips.length;
  const partABtnLabel = completedA === 9 ? "✓ Completed" : completedA > 0 ? "Continue Safety Tips" : "Start";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
      <header className="page-header" style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}>
        <button className="page-header-back" onClick={() => navigate("/")}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="page-header-title">{t("SAFETY_TITLE", { defaultValue: "Safety Tips" })}</span>
        <div className="page-header-spacer" />
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
        <p style={{ fontSize: 14, color: "#414751", textAlign: "center", marginBottom: 28, lineHeight: 1.6, padding: "0 8px" }}>
          Learn how to stay safe and report effectively. Complete both parts to earn your Safety Training badge.
        </p>

        {/* Part A Card */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="shield" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>Part A — Safety Tips by Disaster Type</h3>
              <p style={{ margin: 0, fontSize: 13, color: "#717782" }}>{completedA} of 9 completed</p>
            </div>
          </div>
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: `${(completedA / 9) * 100}%`, background: BLUE, borderRadius: 4, transition: "width 0.3s" }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
            {shownChips.map((d) => {
              const done = isComplete("A", d.id);
              return done ? (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: "rgba(56,161,105,0.1)", border: "1px solid rgba(56,161,105,0.25)", borderRadius: 99 }}>
                  <MatIcon name="check_circle" size={15} color={GREEN} fill />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#276749" }}>{d.label}</span>
                </div>
              ) : (
                <div key={d.id} style={{ padding: "5px 12px", background: FIELD_BG, border: "1px solid #C1C7D2", borderRadius: 99 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#414751" }}>{d.label}</span>
                </div>
              );
            })}
            <div style={{ padding: "5px 8px" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#717782" }}>+{moreCount} more</span>
            </div>
          </div>
          <button
            onClick={() => setView({ type: "partA_list" })}
            style={{ width: "100%", height: 48, borderRadius: 12, background: completedA === 9 ? "transparent" : BLUE, color: completedA === 9 ? GREEN : "#fff", border: completedA === 9 ? `1.5px solid ${GREEN}` : "none", fontWeight: 700, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "opacity 0.15s" }}
          >
            {partABtnLabel}
            {completedA < 9 && <MatIcon name="arrow_forward" size={18} color="#fff" />}
          </button>
        </article>

        {/* Part B Card */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="description" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>Part B — Reporting Guidelines</h3>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: partBDone ? GREEN : "#F5A623" }}>{partBDone ? "Completed" : "Not started"}</p>
            </div>
          </div>
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: partBDone ? "100%" : "0%", background: BLUE, borderRadius: 4, transition: "width 0.3s" }} />
          </div>
          <p style={{ fontSize: 14, color: "#414751", lineHeight: 1.6, marginBottom: 20 }}>
            Simple do's and don'ts for submitting a report safely and accurately during a crisis
          </p>
          <button
            onClick={() => setView({ type: "slide", part: "B" })}
            style={{ width: "100%", height: 48, borderRadius: 12, background: partBDone ? "transparent" : BLUE, color: partBDone ? GREEN : "#fff", border: partBDone ? `1.5px solid ${GREEN}` : "none", fontWeight: 700, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            {partBDone ? "✓ Completed" : "Start"}
            {!partBDone && <MatIcon name="arrow_forward" size={18} color="#fff" />}
          </button>
        </article>

        {/* Part C Card */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 24, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="medical_services" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>Part C — First Aid Tips</h3>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: partCDone ? GREEN : "#F5A623" }}>{partCDone ? "Completed" : "Not started"}</p>
            </div>
          </div>
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 20 }}>
            <div style={{ height: "100%", width: partCDone ? "100%" : "0%", background: BLUE, borderRadius: 4 }} />
          </div>
          <button
            onClick={() => setView({ type: "slide", part: "C" })}
            style={{ width: "100%", height: 48, borderRadius: 12, background: partCDone ? "transparent" : BLUE, color: partCDone ? GREEN : "#fff", border: partCDone ? `1.5px solid ${GREEN}` : "none", fontWeight: 700, fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            {partCDone ? "✓ Completed" : "Start"}
            {!partCDone && <MatIcon name="arrow_forward" size={18} color="#fff" />}
          </button>
        </article>

        {/* Badge teaser */}
        <section style={{ background: "rgba(4,104,177,0.07)", borderRadius: 16, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ background: BLUE, borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <MatIcon name="star" size={20} color="#fff" fill />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.4 }}>
              Complete both parts to unlock your Safety Training Badge
            </p>
            <button
              onClick={() => navigate("/badges")}
              style={{ background: "none", border: "none", color: BLUE, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
            >
              View Badges
              <MatIcon name="arrow_forward" size={14} color={BLUE} />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
