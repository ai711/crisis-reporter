import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";

// ── Constants ──────────────────────────────────────────────────────────────────

const BLUE = "#0468B1";
const BLUE_DARK = "#035a9a";
const GREEN = "#38A169";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Slide {
  title: string;
  bullets: [string, string];
}

interface DisasterType {
  id: string;
  label: string;
  emoji: string;
  slides: Slide[];
}

type Part = "A" | "B" | "C";

// ── Safety Content ─────────────────────────────────────────────────────────────

const DISASTERS: DisasterType[] = [
  {
    id: "earthquake",
    label: "Earthquake",
    emoji: "🌍",
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
    emoji: "🌊",
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
    emoji: "🌊",
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
    emoji: "🌀",
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
    emoji: "🔥",
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
    emoji: "💥",
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
    emoji: "☣️",
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
    emoji: "⚔️",
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
    emoji: "🚨",
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

// ── Icons ──────────────────────────────────────────────────────────────────────

function IconBack() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#0468B1" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function lsKey(part: Part, id?: string): string {
  if (part === "A") return `cr_safety_partA_${id}`;
  if (part === "B") return "cr_safety_partB";
  return "cr_safety_partC";
}

// B8: Use localStorage for logged-in reporters, sessionStorage for anonymous.
function getStorage(): Storage {
  return localStorage.getItem("cr_reporter_id") ? localStorage : sessionStorage;
}

// B8: Check both storages so progress is visible regardless of login state at time of completion.
function isComplete(part: Part, id?: string): boolean {
  const key = lsKey(part, id);
  return localStorage.getItem(key) === "1" || sessionStorage.getItem(key) === "1";
}

function markComplete(part: Part, id?: string) {
  getStorage().setItem(lsKey(part, id), "1");
}

function isAllComplete(): boolean {
  const aComplete = DISASTERS.every((d) => isComplete("A", d.id));
  return aComplete && isComplete("B") && isComplete("C");
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface SlideViewerProps {
  slides: Slide[];
  totalLabel: string;
  completionKey: { part: Part; id?: string };
  onComplete: () => void;
  onBack: () => void;
  title: string;
}

function SlideViewer({ slides, totalLabel, completionKey, onComplete, onBack, title }: SlideViewerProps) {
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState(() => isComplete(completionKey.part, completionKey.id));
  const total = slides.length;
  const slide = slides[current];
  const isLast = current === total - 1;
  const isDo = slide.title.startsWith("Do:");

  // B7: Backend write for logged-in reporters; localStorage/sessionStorage write for all.
  async function handleComplete() {
    markComplete(completionKey.part, completionKey.id);
    setDone(true);
    onComplete();

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
      } catch { /* silent fail — storage write already succeeded */ }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Slide viewer header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center" }}>
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={BLUE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span style={{ fontWeight: 600, fontSize: 15, color: "#2d3748", flex: 1 }}>{title}</span>
        {done && <span style={{ fontSize: 12, color: GREEN, fontWeight: 600 }}>✓ Complete</span>}
      </div>

      {/* Slide counter */}
      <div style={{ padding: "8px 20px", background: "#f7fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, color: "#718096", fontWeight: 500 }}>Slide {current + 1} of {total}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {slides.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: i === current ? BLUE : i < current ? GREEN : "#cbd5e0", transition: "background 0.2s" }} />
          ))}
        </div>
      </div>

      {/* Slide content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px" }}>
        <div style={{
          background: isDo ? "#f0fff4" : "#fff5f5",
          border: `2px solid ${isDo ? "#9ae6b4" : "#feb2b2"}`,
          borderRadius: 12,
          padding: "20px 18px",
          marginBottom: 16,
        }}>
          <div style={{
            display: "inline-block",
            background: isDo ? GREEN : "#e53e3e",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            borderRadius: 4,
            padding: "2px 8px",
            marginBottom: 12,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}>
            {isDo ? "DO" : "DON'T"}
          </div>
          <h3 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 700, color: "#2d3748", lineHeight: 1.4 }}>
            {slide.title.replace(/^Do: |^Don't: /, "")}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {slide.bullets.map((b, i) => (
              <li key={i} style={{ color: "#4a5568", fontSize: 14, lineHeight: 1.7, marginBottom: i === 0 ? 8 : 0 }}>{b}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Navigation */}
      <div style={{ padding: "14px 20px", borderTop: "1px solid #e2e8f0", display: "flex", gap: 10 }}>
        <button
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
          style={{
            flex: 1,
            padding: "11px 0",
            borderRadius: 8,
            border: `1.5px solid ${current === 0 ? "#e2e8f0" : BLUE}`,
            background: "#fff",
            color: current === 0 ? "#a0aec0" : BLUE,
            fontWeight: 600,
            fontSize: 14,
            cursor: current === 0 ? "not-allowed" : "pointer",
          }}
        >
          ← Previous
        </button>
        {isLast ? (
          <button
            onClick={handleComplete}
            style={{
              flex: 2,
              padding: "11px 0",
              borderRadius: 8,
              border: "none",
              background: done ? GREEN : BLUE,
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {done ? "✓ Completed" : "Mark as Complete"}
          </button>
        ) : (
          <button
            onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
            style={{
              flex: 1,
              padding: "11px 0",
              borderRadius: 8,
              border: "none",
              background: BLUE,
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SafetyTipsPage() {
  const navigate = useNavigate();
  const [activePart, setActivePart] = useState<Part>("A");
  const [selectedDisaster, setSelectedDisaster] = useState<string | null>(null);
  const [completionRevision, setCompletionRevision] = useState(0);

  const refresh = useCallback(() => setCompletionRevision((n) => n + 1), []);

  const allDone = isAllComplete();

  const tabs: { id: Part; label: string }[] = [
    { id: "A", label: "Part A: Disaster Tips" },
    { id: "B", label: "Part B: Reporting" },
    { id: "C", label: "Part C: First Aid" },
  ];

  function handlePartChange(part: Part) {
    setActivePart(part);
    setSelectedDisaster(null);
  }

  // Part A: disaster selected → show slide viewer
  if (activePart === "A" && selectedDisaster) {
    const disaster = DISASTERS.find((d) => d.id === selectedDisaster)!;
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <header className="page-header">
          <button className="page-header-back" onClick={() => navigate("/")}>
            <IconBack />
          </button>
          <span className="page-header-title">Safety Tips</span>
          <div className="page-header-spacer" />
        </header>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <SlideViewer
            slides={disaster.slides}
            totalLabel={`Slide X of ${disaster.slides.length}`}
            completionKey={{ part: "A", id: disaster.id }}
            onComplete={refresh}
            onBack={() => setSelectedDisaster(null)}
            title={`${disaster.emoji} ${disaster.label}`}
          />
        </div>
      </div>
    );
  }

  // Part B: show slide viewer directly
  if (activePart === "B") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <header className="page-header">
          <button className="page-header-back" onClick={() => navigate("/")}>
            <IconBack />
          </button>
          <span className="page-header-title">Safety Tips</span>
          <div className="page-header-spacer" />
        </header>
        <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handlePartChange(tab.id)}
              style={{
                flex: 1,
                padding: "11px 4px",
                border: "none",
                borderBottom: activePart === tab.id ? `3px solid ${BLUE}` : "3px solid transparent",
                background: "#fff",
                color: activePart === tab.id ? BLUE : "#718096",
                fontWeight: activePart === tab.id ? 700 : 500,
                fontSize: 11,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <SlideViewer
            slides={PART_B_SLIDES}
            totalLabel={`Slide X of ${PART_B_SLIDES.length}`}
            completionKey={{ part: "B" }}
            onComplete={refresh}
            onBack={() => {}}
            title="Reporting Guidelines"
          />
        </div>
      </div>
    );
  }

  // Part C: show slide viewer directly
  if (activePart === "C") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <header className="page-header">
          <button className="page-header-back" onClick={() => navigate("/")}>
            <IconBack />
          </button>
          <span className="page-header-title">Safety Tips</span>
          <div className="page-header-spacer" />
        </header>
        <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handlePartChange(tab.id)}
              style={{
                flex: 1,
                padding: "11px 4px",
                border: "none",
                borderBottom: activePart === tab.id ? `3px solid ${BLUE}` : "3px solid transparent",
                background: "#fff",
                color: activePart === tab.id ? BLUE : "#718096",
                fontWeight: activePart === tab.id ? 700 : 500,
                fontSize: 11,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <SlideViewer
            slides={PART_C_SLIDES}
            totalLabel={`Slide X of ${PART_C_SLIDES.length}`}
            completionKey={{ part: "C" }}
            onComplete={refresh}
            onBack={() => {}}
            title="First Aid Essentials"
          />
        </div>
      </div>
    );
  }

  // Part A — disaster list
  const partADone = DISASTERS.filter((d) => isComplete("A", d.id)).length;

  // completionRevision is read here to ensure re-render after markComplete
  void completionRevision;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#F6F3F2" }}>
      {/* Header */}
      <header className="page-header">
        <button className="page-header-back" onClick={() => navigate("/")}>
          <IconBack />
        </button>
        <span className="page-header-title">Safety Tips</span>
        <div className="page-header-spacer" />
      </header>

      {/* Tabs */}
      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handlePartChange(tab.id)}
            style={{
              flex: 1,
              padding: "11px 4px",
              border: "none",
              borderBottom: activePart === tab.id ? `3px solid ${BLUE}` : "3px solid transparent",
              background: "#fff",
              color: activePart === tab.id ? BLUE : "#718096",
              fontWeight: activePart === tab.id ? 700 : 500,
              fontSize: 11,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Completion banner */}
      {allDone && (
        <div style={{
          background: "#f0fff4",
          border: "1.5px solid #9ae6b4",
          borderRadius: 10,
          margin: "14px 16px 0",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 22 }}>🏅</span>
          <span style={{ fontSize: 13, color: "#276749", fontWeight: 600, lineHeight: 1.4 }}>
            Safety Training Complete — you are now eligible for the Safety Training Badge
          </span>
        </div>
      )}

      {/* Progress */}
      <div style={{ padding: "12px 16px 4px", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: "#718096", fontWeight: 500 }}>Disaster types completed</span>
          <span style={{ fontSize: 12, color: BLUE, fontWeight: 700 }}>{partADone} / {DISASTERS.length}</span>
        </div>
        <div style={{ height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${(partADone / DISASTERS.length) * 100}%`, background: BLUE, borderRadius: 3, transition: "width 0.3s" }} />
        </div>
      </div>

      {/* Disaster list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px 24px" }}>
        {DISASTERS.map((d) => {
          const done = isComplete("A", d.id);
          return (
            <button
              key={d.id}
              onClick={() => setSelectedDisaster(d.id)}
              style={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                background: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 10,
                cursor: "pointer",
                boxShadow: "0 1px 3px rgba(0,0,0,0.07)",
                textAlign: "left",
                transition: "box-shadow 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "0 3px 8px rgba(4,104,177,0.15)")}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.07)")}
            >
              <span style={{ fontSize: 28, marginRight: 14, flexShrink: 0 }}>{d.emoji}</span>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 15, color: "#2d3748" }}>{d.label}</span>
              {done ? (
                <IconCheck />
              ) : (
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#cbd5e0" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Suppress unused import warning — BLUE_DARK is kept for potential use in future slide themes
void BLUE_DARK;
