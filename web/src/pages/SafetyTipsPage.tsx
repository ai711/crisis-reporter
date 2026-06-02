import { useState, useCallback, useEffect } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const GREEN = "#38A169";
const BG = "#F6F3F2";
const CARD_BG = "#FFFFFF";
const FIELD_BG = "#F0EDED";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Slide {
  title: string;
  bullets: [string, string];
}

interface DisasterType {
  id: string;
  label: string;
  icon: string; // Material Symbol icon name
  slides: Slide[];
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

// ── Safety Content ─────────────────────────────────────────────────────────────

const DISASTERS: DisasterType[] = [
  {
    id: "earthquake",
    label: "Earthquake",
    icon: "volcano",
    slides: [
      { title: "Do: Drop and Take Cover", bullets: ["Drop to your hands and knees immediately", "Take cover under a sturdy table or desk, or against an interior wall away from windows"] },
      { title: "Do: Hold On and Stay Put", bullets: ["Hold on and protect your head and neck with your arms", "Stay where you are until the shaking stops — most injuries happen when people try to move"] },
      { title: "Do: Move Away from Outdoor Hazards", bullets: ["If outdoors, move away from buildings, streetlights, and utility wires", "If in a vehicle, pull over away from buildings and overpasses and stay inside"] },
      { title: "Do: After the Shaking Stops", bullets: ["After shaking stops, check yourself and others for injuries before moving", "Expect aftershocks — drop, cover, and hold on each time"] },
      { title: "Don't: Run Outside or Use Doorways", bullets: ["Do not run outside while shaking is happening — most injuries occur when people try to move during shaking", "Do not stand in a doorway — doorways offer no special protection"] },
      { title: "Don't: Use Elevators or Open Flames", bullets: ["Do not use elevators after an earthquake — use stairs only", "Do not light candles, matches, or any open flame — gas pipes may be damaged"] },
      { title: "Don't: Re-enter or Spread Rumours", bullets: ["Do not return to a damaged building until declared structurally safe", "Do not spread unverified information — only share from official sources"] },
    ],
  },
  {
    id: "flood",
    label: "Flood",
    icon: "water_drop",
    slides: [
      { title: "Do: Move to Higher Ground", bullets: ["Move immediately to higher ground if flooding is imminent", "Turn off utilities at the main switch if safe to do so"] },
      { title: "Do: Disconnect Appliances and Evacuate", bullets: ["Disconnect electrical appliances — do not touch them if wet or standing in water", "If evacuation is ordered, leave immediately with your emergency kit"] },
      { title: "Do: If Trapped, Signal for Help", bullets: ["If trapped, move to the highest floor and signal for help from a window", "Drink only bottled or boiled water — floodwater contaminates supplies"] },
      { title: "Do: Protect Yourself and Monitor Updates", bullets: ["Wear rubber boots and waterproof gloves if walking through floodwater", "Listen to official emergency broadcasts for updates and evacuation routes"] },
      { title: "Don't: Walk or Drive Through Floodwater", bullets: ["Do not walk through moving floodwater — 15cm of fast-moving water can knock an adult down", "Do not drive through flooded roads — water depth is impossible to judge"] },
      { title: "Don't: Touch Floodwater or Return Too Soon", bullets: ["Do not touch floodwater if avoidable — it may contain sewage, chemicals, or debris", "Do not return home until authorities declare it safe"] },
      { title: "Don't: Use Damaged Appliances or Ignore Orders", bullets: ["Do not use electrical equipment that has been in contact with floodwater", "Do not ignore evacuation orders — each flood event is different"] },
    ],
  },
  {
    id: "tsunami",
    label: "Tsunami",
    icon: "tsunami",
    slides: [
      { title: "Do: Move to Higher Ground Immediately", bullets: ["If you feel a strong earthquake near the coast, move immediately to higher ground — do not wait for a warning", "A sudden recession of the sea is a natural warning sign — move inland immediately"] },
      { title: "Do: Move on Foot and Seek High Ground", bullets: ["Move on foot if possible — roads may be congested or damaged", "Go to a designated tsunami evacuation zone or the highest ground available"] },
      { title: "Do: If Caught in a Wave", bullets: ["If caught in a wave, grab onto something that floats", "After the first wave, stay where you are — later waves are often larger"] },
      { title: "Do: Wait for the Official All-Clear", bullets: ["Listen to official broadcasts — an all-clear must come from authorities before returning", "Help others move to higher ground only if you can do so safely"] },
      { title: "Don't: Go to the Coast or Assume It's Over", bullets: ["Do not go to the coast to watch the tsunami — people who do are frequently killed", "Do not assume danger is over after the first wave — subsequent waves can arrive for hours"] },
      { title: "Don't: Use Bridges or Return Too Soon", bullets: ["Do not use bridges or low-lying roads during or after a tsunami warning", "Do not return to coastal areas until authorities issue a formal all-clear"] },
      { title: "Don't: Rely Solely on Sirens or Drive Through Zones", bullets: ["Do not rely solely on sirens — if you feel a large earthquake near the coast, act immediately", "Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away"] },
    ],
  },
  {
    id: "hurricane",
    label: "Hurricane / Cyclone",
    icon: "cyclone",
    slides: [
      { title: "Do: Follow Evacuation Orders", bullets: ["Follow evacuation orders immediately when issued", "Board up windows and secure outdoor furniture before the storm arrives"] },
      { title: "Do: Prepare Emergency Supplies", bullets: ["Prepare an emergency kit with water, food, medications, flashlight — enough for 72 hours", "Fill clean containers with drinking water before the storm — supplies may be disrupted"] },
      { title: "Do: Stay Indoors During the Storm", bullets: ["Stay indoors during the storm, away from windows and glass doors", "If the eye passes over, stay sheltered — dangerous winds will return from the opposite direction"] },
      { title: "Do: After the Storm", bullets: ["After the storm, check your home for structural damage before entering", "Listen to official broadcasts for road conditions and public health guidance"] },
      { title: "Don't: Go Outside During the Storm", bullets: ["Do not go outside during the storm — flying debris causes most hurricane fatalities", "Do not assume the storm is over if winds suddenly calm — the eye passes quickly"] },
      { title: "Don't: Use Generators Indoors or Touch Downed Lines", bullets: ["Do not use generators or charcoal grills indoors — carbon monoxide poisoning is a leading cause of post-hurricane deaths", "Do not touch downed power lines or walk through standing water near them"] },
      { title: "Don't: Drive Through Flooding or Return Too Soon", bullets: ["Do not drive through flooded roads — hurricane flooding is extensive", "Do not return to evacuated areas until authorities declare it safe"] },
    ],
  },
  {
    id: "wildfire",
    label: "Wildfire",
    icon: "local_fire_department",
    slides: [
      { title: "Do: Evacuate Immediately When Ordered", bullets: ["If you receive an evacuation order, leave immediately — wildfires change direction rapidly", "Close all windows and doors as you leave to slow fire entering — leave them unlocked for emergency responders"] },
      { title: "Do: Protect Yourself While Evacuating", bullets: ["Wear a mask or cover your nose and mouth with a damp cloth while evacuating", "Take your emergency kit, medications, important documents, and pets if you can do so quickly"] },
      { title: "Do: If There Is No Escape Route", bullets: ["If caught with no escape route, shelter in a building or lie face down in a ditch away from vegetation", "Breathe through your nose — nasal passages filter more smoke than mouth breathing"] },
      { title: "Do: After a Wildfire", bullets: ["After a wildfire, check your roof for embers before re-entering — embers can smoulder for hours", "Wear a mask and gloves when working in ash — it may contain toxic materials"] },
      { title: "Don't: Ignore Orders or Re-enter Too Soon", bullets: ["Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run", "Do not re-enter evacuated areas until declared safe — hidden hot spots can reignite"] },
      { title: "Don't: Park Under Trees or Use Contaminated Water", bullets: ["Do not park under trees during or after a wildfire — weakened trees can fall without warning", "Do not use water that may be contaminated by fire retardants — use bottled water only"] },
      { title: "Don't: Inhale Ash or Fight the Fire Yourself", bullets: ["Do not inhale ash unnecessarily — wear a properly fitted particulate mask where available", "Do not attempt to fight a wildfire yourself — evacuate and let trained firefighters handle it"] },
    ],
  },
  {
    id: "explosion",
    label: "Explosion",
    icon: "explosion",
    slides: [
      { title: "Do: Take Cover Immediately", bullets: ["Immediately take cover behind a solid object or drop to the ground face down", "Cover your head and neck with your arms to protect from debris"] },
      { title: "Do: Move Away and Help If Safe", bullets: ["Once the immediate danger passes, move away from the site quickly and calmly", "Help injured people move away only if you can do so safely without putting yourself at risk"] },
      { title: "Do: Seek Medical Attention and Report", bullets: ["Seek medical attention for any injuries — blast injuries may not be immediately visible", "Report the explosion to emergency services as soon as you are in a safe location"] },
      { title: "Do: Follow Official Instructions", bullets: ["Follow instructions from emergency services and authorities on the ground", "Stay upwind of the explosion site to avoid inhaling smoke or chemical fumes"] },
      { title: "Don't: Return to the Site or Use Phones Near Gas", bullets: ["Do not return to the explosion site — secondary explosions are common", "Do not use mobile phones or electrical switches near a gas leak — sparks can trigger another explosion"] },
      { title: "Don't: Touch Debris or Spread Rumours", bullets: ["Do not touch suspicious packages or debris around the site", "Do not post unverified information about the cause — this can spread panic"] },
      { title: "Don't: Block Access or Enter Damaged Buildings", bullets: ["Do not block emergency service access routes", "Do not enter damaged buildings — structural collapse risk is high after an explosion"] },
    ],
  },
  {
    id: "chemical",
    label: "Chemical Incident",
    icon: "science",
    slides: [
      { title: "Do: Move Upwind or Shelter in Place", bullets: ["Move upwind and uphill from the incident immediately", "If indoors, shelter in place — close all windows, doors, and ventilation systems"] },
      { title: "Do: Decontaminate and Cover Your Mouth", bullets: ["If you have been exposed, remove outer clothing and wash skin thoroughly with water", "Cover your nose and mouth with a wet cloth if you must move through contaminated air"] },
      { title: "Do: Follow Evacuation Instructions", bullets: ["Follow evacuation instructions from emergency services exactly", "Seek medical attention even if you feel well — chemical exposure symptoms can be delayed"] },
      { title: "Do: Monitor Updates and Flush Eyes If Needed", bullets: ["Listen to official broadcasts for information on safe zones and decontamination points", "If your eyes are burning, flush them with clean water for at least 15 minutes"] },
      { title: "Don't: Approach the Source or Eat Nearby", bullets: ["Do not approach the source of a chemical incident — even brief exposure can be fatal", "Do not eat, drink, or smoke in or near the affected area"] },
      { title: "Don't: Trust Your Nose or Re-enter Too Soon", bullets: ["Do not rely on smell to determine safety — many hazardous chemicals are odourless", "Do not re-enter the affected area until authorities declare it safe"] },
      { title: "Don't: Spread Rumours or Remove Protective Gear", bullets: ["Do not spread rumours about the cause — chemical incidents cause significant public panic", "Do not remove protective clothing given by emergency services until instructed"] },
    ],
  },
  {
    id: "conflict",
    label: "Conflict",
    icon: "military_tech",
    slides: [
      { title: "Do: Find Cover and Stay Away from Windows", bullets: ["If caught in an active conflict zone, find cover immediately — lie flat behind a solid structure", "Stay away from windows, doors, and open spaces during active shooting or shelling"] },
      { title: "Do: Follow Legitimate Authority and Move Safely", bullets: ["Follow instructions from legitimate security forces or humanitarian organisations", "If evacuating, move quickly and low, using buildings and terrain as cover"] },
      { title: "Do: Keep an Emergency Bag Ready", bullets: ["Keep an emergency bag ready with documents, water, food, and medications", "Identify safe exit routes from your home and neighbourhood in advance"] },
      { title: "Do: Shelter in Place and Conserve Power", bullets: ["If sheltering in place, move to an interior room away from windows on the lowest floor", "Conserve phone battery and charge devices whenever power is available"] },
      { title: "Don't: Film Military or Touch Unexploded Ordnance", bullets: ["Do not film or photograph military personnel or equipment — this can put you at serious risk", "Do not approach unexploded ordnance or debris — mark the location and report it"] },
      { title: "Don't: Use Open Flames or Post Your Location", bullets: ["Do not use open flames at night — light can attract attention in conflict zones", "Do not spread your location on social media during active conflict"] },
      { title: "Don't: Cross Front Lines or Ignore Curfews", bullets: ["Do not attempt to cross front lines or enter restricted areas", "Do not ignore curfews or movement restrictions imposed by authorities"] },
    ],
  },
  {
    id: "unrest",
    label: "Civil Unrest",
    icon: "groups_2",
    slides: [
      { title: "Do: Move Calmly to the Edges", bullets: ["If caught in a crowd disturbance, move calmly to the edges and away from the crowd", "Stay aware of your surroundings and identify exit routes before any situation escalates"] },
      { title: "Do: If Tear Gas Is Used", bullets: ["If tear gas is used, move upwind and flush eyes with clean water", "Cover your nose and mouth with a wet cloth to reduce inhalation of irritants"] },
      { title: "Do: Stay in Contact and Follow Instructions", bullets: ["Stay in contact with family or trusted contacts about your location", "Follow instructions from police or security forces unless doing so puts you at immediate risk"] },
      { title: "Do: Observe Safely and Document from a Distance", bullets: ["If you are a reporter or observer, identify yourself clearly and stay to the periphery", "Document damage and injuries only from a safe distance"] },
      { title: "Don't: Engage or Blend In With Crowds", bullets: ["Do not engage with crowds or attempt to intervene in confrontations", "Do not wear clothing that could be mistaken for that of any group involved"] },
      { title: "Don't: Share Real-Time Movements or Use Flash", bullets: ["Do not share real-time location of security forces or crowd movements on social media", "Do not use flash photography in tense situations — it can provoke a response"] },
      { title: "Don't: Block Emergency Routes or Spread Rumours", bullets: ["Do not block emergency vehicle access routes", "Do not spread unverified reports of casualties or causes — this escalates tensions"] },
    ],
  },
];

const PART_B_SLIDES: Slide[] = [
  { title: "Only Report What You Can Safely See", bullets: ["Never put yourself in danger to get closer to an incident. If you cannot see it from a safe distance, do not report it.", "Your safety is more valuable than any report. Accurate reporting from a safe vantage point is always better than no report at all."] },
  { title: "Take Clear Photos from a Safe Distance", bullets: ["Use zoom rather than approaching the damage. A clear photo from 20 metres is more useful than a blurred one from 5 metres.", "Photograph the full structure, not just the damage. Context — surrounding buildings, street layout — is essential for assessment."] },
  { title: "Be Accurate with Location — Use GPS When Possible", bullets: ["Enable GPS on your device before reaching the site. Allow the app to auto-detect your location for the highest accuracy.", "If GPS is unavailable, note the building name, street address, or a nearby landmark to allow accurate manual geo-coding."] },
  { title: "One Report Per Building — No Duplicates", bullets: ["Submit only one report per building per visit. Duplicate reports waste analyst time and distort damage statistics.", "If conditions have changed significantly since your last report on a building, submit an update rather than a new report."] },
  { title: "Your Identity is Protected — Reports Are Anonymised", bullets: ["Your name, email, and device information are encrypted at rest and never included in exported datasets.", "Reports shared with humanitarian organisations contain only location data, damage classification, and timestamps — never personal identifiers."] },
];

const PART_C_SLIDES: Slide[] = [
  { title: "Controlling Bleeding", bullets: ["Apply firm, direct pressure to the wound with a clean cloth or bandage and maintain it continuously for at least 10 minutes.", "Elevate the injured limb above heart level if possible. Do not remove the cloth — add more on top if it soaks through."] },
  { title: "Recovery Position", bullets: ["Place an unconscious, breathing person on their side with their top knee bent forward to prevent them rolling back.", "Tilt their head back gently to open the airway, and place their hand under their cheek. Monitor breathing continuously."] },
  { title: "Treating Shock", bullets: ["Lay the person flat and, if not injured, raise their legs 20–30 cm above heart level to improve blood flow to vital organs.", "Keep them warm with a blanket. Do not give food or water. Reassure them calmly and monitor their breathing until help arrives."] },
  { title: "Burns Treatment", bullets: ["Cool the burn immediately under cool (not cold) running water for at least 20 minutes. Remove jewellery near the burn if possible.", "Cover the burn loosely with cling film or a clean non-fluffy material. Do not apply butter, toothpaste, or ice."] },
  { title: "Fractures and Immobilisation", bullets: ["Do not attempt to straighten a fractured limb. Immobilise it in the position found using a splint and soft padding.", "A splint can be improvised from a straight stick, rolled newspaper, or folded clothing tied firmly — not tightly — above and below the fracture."] },
  { title: "When Not to Move an Injured Person", bullets: ["Do not move someone who may have a spinal injury (high-impact trauma, neck pain, tingling/numbness) unless they are in immediate danger.", "If you must move them, keep the head, neck, and spine aligned at all times and use multiple people to maintain a straight carry."] },
];

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

// ── SlideViewer ────────────────────────────────────────────────────────────────

interface SlideViewerProps {
  slides: Slide[];
  completionKey: { part: Part; id?: string };
  onComplete: () => void;
}

function SlideViewer({ slides, completionKey, onComplete }: SlideViewerProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState(() => isComplete(completionKey.part, completionKey.id));
  const total = slides.length;
  const slide = slides[current];
  const isLast = current === total - 1;
  const isDo = slide.title.startsWith("Do:");

  async function handleComplete() {
    markComplete(completionKey.part, completionKey.id);
    setDone(true);
    const reporterId = localStorage.getItem("cr_reporter_id");
    if (reporterId) {
      const partKey = completionKey.id
        ? `${completionKey.part}_${completionKey.id}`
        : completionKey.part;
      try {
        await api.post(`/api/reporters/${reporterId}/safety-progress`, {
          part_completed: partKey,
          completed_at: new Date().toISOString(),
        });
      } catch { /* silent fail */ }
    }
    onComplete();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Slide counter + dots */}
      <div style={{ padding: "10px 24px", background: BG, borderBottom: `1px solid #E4E2E1`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: "#717782", fontWeight: 500 }}>
          {t('safety.slide_progress', { n: current + 1, total })}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {slides.map((_, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: i === current ? BLUE : i < current ? GREEN : "#C1C7D2",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>
      </div>

      {/* Slide content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px" }}>
        <div style={{
          background: isDo ? "#f0fff4" : "#fff5f5",
          border: `2px solid ${isDo ? "#9ae6b4" : "#feb2b2"}`,
          borderRadius: 16,
          padding: "20px 20px",
        }}>
          <div style={{
            display: "inline-block",
            background: isDo ? GREEN : "#e53e3e",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 4,
            padding: "2px 10px",
            marginBottom: 14,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}>
            {isDo ? t('safety.do') : t('safety.dont')}
          </div>
          <h3 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.4 }}>
            {slide.title.replace(/^Do: |^Don't: /, "")}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {slide.bullets.map((b, i) => (
              <li key={i} style={{ color: "#414751", fontSize: 14, lineHeight: 1.7, marginBottom: i === 0 ? 8 : 0 }}>{b}</li>
            ))}
          </ul>
        </div>
        {done && (
          <div style={{ marginTop: 16, padding: "10px 16px", background: "#f0fff4", borderRadius: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <MatIcon name="check_circle" size={18} color={GREEN} fill />
            <span style={{ fontSize: 13, color: "#276749", fontWeight: 600 }}>{t('safety.completed')}</span>
          </div>
        )}
      </div>

      {/* Navigation footer */}
      <div style={{ padding: "14px 24px", background: BG, borderTop: `1px solid #E4E2E1`, display: "flex", gap: 10, flexShrink: 0 }}>
        <button
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
          style={{
            flex: 1,
            padding: "12px 0",
            borderRadius: 10,
            border: `1.5px solid ${current === 0 ? "#E4E2E1" : BLUE}`,
            background: CARD_BG,
            color: current === 0 ? "#C1C7D2" : BLUE,
            fontWeight: 600,
            fontSize: 14,
            cursor: current === 0 ? "not-allowed" : "pointer",
          }}
        >
          {t('common.previous')}
        </button>
        {isLast ? (
          <button
            onClick={handleComplete}
            style={{
              flex: 2,
              padding: "12px 0",
              borderRadius: 10,
              border: "none",
              background: done ? GREEN : BLUE,
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {done ? t('safety.completed') : t('safety.mark_complete')}
            {!done && <MatIcon name="check" size={16} color="#fff" />}
          </button>
        ) : (
          <button
            onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
            style={{
              flex: 1,
              padding: "12px 0",
              borderRadius: 10,
              border: "none",
              background: BLUE,
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {t('common.next')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SafetyTipsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ type: "home" });
  const [rev, setRev] = useState(0);

  // Inject Material Symbols font if not already loaded
  useEffect(() => {
    const id = "material-symbols-stylesheet";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  const refresh = useCallback(() => setRev((n) => n + 1), []);
  // rev is read below inside render branches to force re-render after markComplete
  void rev;

  // ── Slide view ───────────────────────────────────────────────────────────────
  if (view.type === "slide") {
    const { part, disasterId } = view;
    const backTarget: View = part === "A" ? { type: "partA_list" } : { type: "home" };

    let slides: Slide[];
    let slideTitle: string;
    if (part === "A") {
      const d = DISASTERS.find((d) => d.id === disasterId)!;
      slides = d.slides;
      slideTitle = d.label;
    } else if (part === "B") {
      slides = PART_B_SLIDES;
      slideTitle = t('safety.part_b_title');
    } else {
      slides = PART_C_SLIDES;
      slideTitle = t('safety.part_c_title');
    }

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
        <header
          className="page-header"
          style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}
        >
          <button
            className="page-header-back"
            onClick={() => setView(backTarget)}
          >
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="page-header-title">{slideTitle}</span>
          <div className="page-header-spacer" />
        </header>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <SlideViewer
            slides={slides}
            completionKey={{ part, id: disasterId }}
            onComplete={() => { refresh(); setView(backTarget); }}
          />
        </div>
      </div>
    );
  }

  // ── Part A disaster list ─────────────────────────────────────────────────────
  if (view.type === "partA_list") {
    const completedA = DISASTERS.filter((d) => isComplete("A", d.id)).length;

    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
        <header
          className="page-header"
          style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}
        >
          <button
            className="page-header-back"
            onClick={() => setView({ type: "home" })}
          >
            <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="page-header-title">Part A — Safety Tips</span>
          <div className="page-header-spacer" />
        </header>

        {/* Progress tracker */}
        <div style={{ padding: "12px 24px 0", background: BG }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "#717782", fontWeight: 500 }}>
              {completedA} of 9 completed
            </span>
          </div>
          <div style={{ height: 6, background: "#E4E2E1", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(completedA / 9) * 100}%`, background: BLUE, borderRadius: 3, transition: "width 0.3s" }} />
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 32px" }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: "#717782", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
            Tap a disaster type to read the safety tips
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {DISASTERS.map((d) => {
              const done = isComplete("A", d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => setView({ type: "slide", part: "A", disasterId: d.id })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    background: FIELD_BG,
                    border: "none",
                    borderRadius: 12,
                    padding: "14px 16px",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#E8E5E4")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = FIELD_BG)}
                >
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: "#E4E2E1",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 14,
                    flexShrink: 0,
                  }}>
                    <MatIcon name={d.icon} size={22} color={BLUE} />
                  </div>
                  <span style={{ flex: 1, fontWeight: 700, fontSize: 15, color: "#1B1C1C" }}>{d.label}</span>
                  {done ? (
                    <MatIcon name="check_circle" size={22} color={GREEN} fill />
                  ) : (
                    <MatIcon name="chevron_right" size={20} color="#C1C7D2" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Offline info banner */}
          <div style={{ marginTop: 32, background: "#EAE7E7", borderRadius: 16, padding: "20px 16px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <MatIcon name="cloud_done" size={28} color={BLUE} />
            <p style={{ margin: "10px 0 4px", fontSize: 14, fontWeight: 600, color: "#1B1C1C" }}>Ready for the field</p>
            <p style={{ margin: 0, fontSize: 13, color: "#717782", lineHeight: 1.5 }}>
              Content works offline and is available in all supported languages
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Home screen ──────────────────────────────────────────────────────────────

  const completedA = DISASTERS.filter((d) => isComplete("A", d.id)).length;
  const partBDone = isComplete("B");
  const partCDone = isComplete("C");

  // First 3 disaster chips — show completion status
  const shownChips = DISASTERS.slice(0, 3);
  const moreCount = DISASTERS.length - shownChips.length; // 6

  const partABtnLabel =
    completedA === 9 ? "✓ Completed" : completedA > 0 ? "Continue Safety Tips" : "Start";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: BG }}>
      <header
        className="page-header"
        style={{ background: BG, borderBottom: "1px solid #E4E2E1" }}
      >
        <button className="page-header-back" onClick={() => navigate("/")}>
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="page-header-title">{t('safety.title')}</span>
        <div className="page-header-spacer" />
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
        {/* Intro */}
        <p style={{ fontSize: 14, color: "#414751", textAlign: "center", marginBottom: 28, lineHeight: 1.6, padding: "0 8px" }}>
          Learn how to stay safe and report effectively. Complete both parts to earn your Safety Training badge.
        </p>

        {/* ── Part A Card ── */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="shield" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>
                Part A — Safety Tips by Disaster Type
              </h3>
              <p style={{ margin: 0, fontSize: 13, color: "#717782" }}>{completedA} of 9 completed</p>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: `${(completedA / 9) * 100}%`, background: BLUE, borderRadius: 4, transition: "width 0.3s" }} />
          </div>

          {/* Disaster chips */}
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

          {/* Button */}
          <button
            onClick={() => setView({ type: "partA_list" })}
            style={{
              width: "100%",
              height: 48,
              borderRadius: 12,
              background: completedA === 9 ? "transparent" : BLUE,
              color: completedA === 9 ? GREEN : "#fff",
              border: completedA === 9 ? `1.5px solid ${GREEN}` : "none",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              transition: "opacity 0.15s",
            }}
          >
            {partABtnLabel}
            {completedA < 9 && <MatIcon name="arrow_forward" size={18} color="#fff" />}
          </button>
        </article>

        {/* ── Part B Card ── */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="description" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>
                  Part B — Reporting Guidelines
                </h3>
              </div>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: partBDone ? GREEN : "#F5A623" }}>
                {partBDone ? "Completed" : "Not started"}
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ height: "100%", width: partBDone ? "100%" : "0%", background: BLUE, borderRadius: 4, transition: "width 0.3s" }} />
          </div>

          <p style={{ fontSize: 14, color: "#414751", lineHeight: 1.6, marginBottom: 20 }}>
            Simple do's and don'ts for submitting a report safely and accurately during a crisis
          </p>

          <button
            onClick={() => setView({ type: "slide", part: "B" })}
            style={{
              width: "100%",
              height: 48,
              borderRadius: 12,
              background: partBDone ? "transparent" : BLUE,
              color: partBDone ? GREEN : "#fff",
              border: partBDone ? `1.5px solid ${GREEN}` : "none",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {partBDone ? "✓ Completed" : "Start"}
            {!partBDone && <MatIcon name="arrow_forward" size={18} color="#fff" />}
          </button>
        </article>

        {/* ── Part C Card ── */}
        <article style={{ background: CARD_BG, borderRadius: 16, padding: 24, marginBottom: 24, boxShadow: "0 4px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
            <div style={{ background: "rgba(4,104,177,0.08)", padding: 12, borderRadius: 16, flexShrink: 0 }}>
              <MatIcon name="medical_services" size={22} color={BLUE} fill />
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1B1C1C", lineHeight: 1.3 }}>
                Part C — First Aid Tips
              </h3>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: partCDone ? GREEN : "#F5A623" }}>
                {partCDone ? "Completed" : "Not started"}
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ height: 8, background: "#E4E2E1", borderRadius: 4, overflow: "hidden", marginBottom: 20 }}>
            <div style={{ height: "100%", width: partCDone ? "100%" : "0%", background: BLUE, borderRadius: 4 }} />
          </div>

          <button
            onClick={() => setView({ type: "slide", part: "C" })}
            style={{
              width: "100%",
              height: 48,
              borderRadius: 12,
              background: partCDone ? "transparent" : BLUE,
              color: partCDone ? GREEN : "#fff",
              border: partCDone ? `1.5px solid ${GREEN}` : "none",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
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
