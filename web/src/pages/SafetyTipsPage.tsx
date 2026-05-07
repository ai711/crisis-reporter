import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

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
      { title: "Do: Drop, Cover, Hold On", bullets: ["Drop to your hands and knees before the shaking throws you down. Cover your head and neck with one arm.", "Hold on to your shelter until the shaking stops. Stay in place — most injuries occur when people try to move."] },
      { title: "Do: Stay Away from Windows", bullets: ["Move away from windows, exterior walls, and anything that could fall — shelves, heavy furniture, light fixtures.", "If outside, move away from buildings, streetlights, and power lines. Once in the open, stay there until shaking stops."] },
      { title: "Do: Check for Injuries After Shaking", bullets: ["When shaking stops, check yourself and others for injuries. Provide first aid before attempting to leave the area.", "Listen to emergency broadcasts for aftershock warnings and evacuation instructions."] },
      { title: "Don't: Run Outside During Shaking", bullets: ["Do not run outside while shaking is occurring — most injuries happen during evacuation when people are struck by falling debris.", "Wait until shaking completely stops before attempting to move to a safer location."] },
      { title: "Don't: Stand in Doorways", bullets: ["Doorways are no safer than any other part of a modern building. A falling door frame can cause serious injury.", "Instead, get under a sturdy desk or table, or crouch against an interior wall away from windows."] },
      { title: "Don't: Use Elevators or Gas Lines", bullets: ["Never use elevators after an earthquake — power outages and structural damage can trap you inside.", "Do not use open flames or switches until you have confirmed there are no gas leaks. Leave the building if you smell gas."] },
    ],
  },
  {
    id: "flood",
    label: "Flood",
    emoji: "🌊",
    slides: [
      { title: "Do: Move to Higher Ground Immediately", bullets: ["If authorities issue a flood warning, move to higher ground without delay. Don't wait for water to reach your home.", "Take emergency supplies, medications, and important documents in a waterproof bag."] },
      { title: "Do: Turn Off Utilities", bullets: ["Turn off electricity at the main breaker and gas at the main valve before floodwater enters your home.", "Disconnect electrical appliances only if it is safe to do so — never touch electrical equipment while standing in water."] },
      { title: "Do: Monitor Emergency Broadcasts", bullets: ["Keep a battery-powered or hand-crank radio to receive official updates when power fails.", "Follow evacuation routes designated by authorities — they are chosen to avoid flooded roads."] },
      { title: "Don't: Walk Through Flowing Water", bullets: ["Six inches of moving water can knock an adult off their feet. Do not attempt to cross any flowing floodwater on foot.", "If you must walk in still water, use a stick to check the ground ahead for holes or compromised surfaces."] },
      { title: "Don't: Drive Through Flooded Roads", bullets: ["Two feet of water can carry away most vehicles. Turn around — do not drown. Never drive into an unknown water depth.", "Abandon a vehicle that becomes submerged and move to higher ground immediately."] },
      { title: "Don't: Return Home Too Early", bullets: ["Do not return home until authorities confirm it is safe. Floodwater can be contaminated with sewage and chemicals.", "Avoid downed power lines and report them to the utility company. Do not enter buildings with structural damage."] },
    ],
  },
  {
    id: "tsunami",
    label: "Tsunami",
    emoji: "🌊",
    slides: [
      { title: "Do: Move Inland and Uphill Immediately", bullets: ["If you feel a strong earthquake near the coast, move inland and uphill without waiting for an official warning.", "Aim for at least 30 metres above sea level or 3 kilometres from the shoreline."] },
      { title: "Do: Follow Evacuation Routes", bullets: ["Use designated tsunami evacuation routes — these are engineered to lead you quickly to safe elevation.", "If no route is marked, move perpendicular to the shoreline, heading inland as fast as possible."] },
      { title: "Do: Wait for the Official All-Clear", bullets: ["Stay at your safe location until official authorities issue a tsunami all-clear — this can take several hours.", "Tune into emergency radio broadcasts for updates. Do not rely on social media alone."] },
      { title: "Don't: Return to the Coast to Watch", bullets: ["A tsunami is not a single wave. Multiple waves can arrive over hours, with later waves sometimes larger than the first.", "Never go to the beach to watch a tsunami — many deaths occur because of this."] },
      { title: "Don't: Assume the First Wave Is the Last", bullets: ["The first wave may be smaller than subsequent ones. The most dangerous wave often arrives 10–60 minutes later.", "Remain in your safe location until the official all-clear is given."] },
      { title: "Don't: Stop to Collect Belongings", bullets: ["Do not stop to collect valuables, electronics, or non-essential items during evacuation — every second matters.", "Alert neighbours and help anyone who cannot evacuate themselves, but do not delay your own evacuation to search buildings."] },
    ],
  },
  {
    id: "hurricane",
    label: "Hurricane / Cyclone",
    emoji: "🌀",
    slides: [
      { title: "Do: Secure Your Home in Advance", bullets: ["Board up windows and reinforce garage doors. Bring outdoor furniture, decorations, and bins inside.", "Secure loose roof sheets and clear gutters and drains to reduce flood risk."] },
      { title: "Do: Stock Emergency Supplies", bullets: ["Prepare a kit with at least 3 days of water (4 litres per person per day), food, medications, and a first aid kit.", "Include a battery-powered radio, torch, extra batteries, and copies of important documents in a waterproof container."] },
      { title: "Do: Evacuate If Ordered", bullets: ["If authorities issue an evacuation order, leave immediately. Do not wait to see if conditions worsen.", "Drive away from the coast and move to the designated shelter or a safe location inland."] },
      { title: "Don't: Go Outside During the Eye", bullets: ["The calm eye of a hurricane can last 30–60 minutes, but dangerous winds will return suddenly from the opposite direction.", "Stay indoors and away from windows until the official all-clear is issued."] },
      { title: "Don't: Shelter Near Windows or Exterior Walls", bullets: ["Shelter in an interior room on the lowest floor above expected flooding — avoid skylights and glass doors.", "Protect your head with cushions, mattresses, or a bicycle helmet if winds breach the structure."] },
      { title: "Don't: Ignore Official Evacuation Orders", bullets: ["Authorities order evacuation when sheltering in place is more dangerous than leaving — take every order seriously.", "Do not return to your home until authorities confirm it is safe. Post-storm hazards include flooding, downed lines, and gas leaks."] },
    ],
  },
  {
    id: "wildfire",
    label: "Wildfire",
    emoji: "🔥",
    slides: [
      { title: "Do: Evacuate When Ordered — Immediately", bullets: ["When an evacuation order is issued, leave at once. Wildfires can accelerate faster than a person can run.", "Take your emergency kit, pets, and medications. Do not attempt to return for belongings."] },
      { title: "Do: Prepare Your Home Before Leaving", bullets: ["Close all windows, doors, vents, and pet flaps to slow fire entry. Seal gaps with wet towels if time permits.", "Turn off gas at the meter and leave exterior lights on to make the house visible in heavy smoke."] },
      { title: "Do: Follow Designated Escape Routes", bullets: ["Use official evacuation routes — shortcuts may be blocked by fire or unsafe road conditions.", "Alert your neighbours and travel at a safe distance from other vehicles in reduced-visibility smoke."] },
      { title: "Don't: Wait to See If Fire Reaches You", bullets: ["Wildfire spread is unpredictable and can accelerate dramatically with wind shifts. Early evacuation is always safer.", "Smoke inhalation can incapacitate you before flames arrive — evacuate before visibility deteriorates."] },
      { title: "Don't: Shelter in a Vehicle If Surrounded", bullets: ["If caught in a vehicle surrounded by fire, park off the road, turn off the engine, turn on hazard lights, and stay low inside.", "Cover yourself with a wool blanket. Do not try to run through fire — the vehicle offers more protection."] },
      { title: "Don't: Re-enter Burned Areas Prematurely", bullets: ["Burned structures may contain toxic ash, smouldering debris, and compromised structural integrity.", "Wait for official clearance before returning — hidden hotspots can reignite hours or days after a wildfire."] },
    ],
  },
  {
    id: "explosion",
    label: "Explosion",
    emoji: "💥",
    slides: [
      { title: "Do: Drop and Cover Immediately", bullets: ["At the sound of an explosion, drop to the floor and protect your head and neck with your arms.", "Seek cover behind a solid object and stay low — secondary explosions and falling debris are common."] },
      { title: "Do: Move Away from the Blast Site", bullets: ["Once safe to move, evacuate the area quickly while staying low. Move upwind of any smoke or chemical release.", "Alert emergency services by calling your local emergency number as soon as you are in a safe location."] },
      { title: "Do: Help Others If It Is Safe", bullets: ["Assist injured people to move away from the area if it is safe to do so. Do not move anyone with suspected spinal injuries.", "Administer basic first aid for bleeding — apply direct pressure with a clean cloth and maintain it."] },
      { title: "Don't: Re-enter a Damaged Building", bullets: ["Explosions can weaken structural integrity. Do not re-enter a building that has been damaged, even to retrieve belongings.", "Expect secondary explosions — many incidents involve multiple blasts designed to catch first responders."] },
      { title: "Don't: Pick Up Unknown Objects", bullets: ["Do not touch, move, or pick up any unknown objects near the blast site — they may be unexploded devices.", "Maintain a safe distance and direct others away from the area until emergency services arrive."] },
      { title: "Don't: Use Mobile Phones Near Suspected Gas Leaks", bullets: ["Mobile phone signals can ignite accumulated gas. If you smell gas near a blast site, do not use your phone until you are clear.", "Do not use cigarette lighters, matches, or any open flame near the blast site."] },
    ],
  },
  {
    id: "chemical",
    label: "Chemical Incident",
    emoji: "☣️",
    slides: [
      { title: "Do: Move Upwind and Uphill", bullets: ["Move quickly upwind and uphill away from the source of the chemical release — toxic vapours are heavier than air and travel downwind.", "Evacuate at right angles to the wind direction before moving upwind to avoid the contamination plume."] },
      { title: "Do: Cover Your Nose and Mouth", bullets: ["If you cannot evacuate immediately, cover your nose and mouth with a damp cloth to reduce inhalation of vapours.", "Seal windows and doors with wet towels or tape if told to shelter in place. Turn off all ventilation systems."] },
      { title: "Do: Follow Hazmat Authority Instructions", bullets: ["Chemical incidents require specialist response. Follow all instructions from hazardous materials (HAZMAT) teams.", "If instructed to decontaminate, remove outer clothing and wash exposed skin with large quantities of clean water for at least 15 minutes."] },
      { title: "Don't: Attempt to Handle Chemical Spills", bullets: ["Never attempt to clean up, neutralise, or contain a chemical spill unless you are a trained responder with proper PPE.", "Even brief skin or eye exposure to industrial chemicals can cause severe injury."] },
      { title: "Don't: Eat, Drink, or Smoke Near Affected Areas", bullets: ["Chemical contamination can be invisible. Do not eat, drink, or smoke in or near the affected area.", "Wash hands thoroughly before touching your face, mouth, or eyes, even after leaving the area."] },
      { title: "Don't: Enter Contaminated Areas Without Protection", bullets: ["Do not enter a contaminated zone to rescue or assist others unless you have appropriate respiratory and skin protection.", "Wait for HAZMAT teams — entering without protection risks making the situation worse and adding more casualties."] },
    ],
  },
  {
    id: "conflict",
    label: "Conflict",
    emoji: "⚔️",
    slides: [
      { title: "Do: Stay Indoors and Away from Windows", bullets: ["If armed conflict occurs nearby, move away from windows and exterior walls. Shelter in an interior room at low floor level.", "Identify the safest room in your building in advance — bathrooms and interior stairwells offer more protection."] },
      { title: "Do: Stay Low If You Must Move", bullets: ["If you must move through an area with active conflict, stay close to walls and as low as possible.", "Move during lulls in activity. Cross open spaces quickly. Never expose yourself unnecessarily."] },
      { title: "Do: Identify Shelter and Evacuation Routes", bullets: ["Know the location of the nearest designated shelter and multiple exit routes from your area before conflict begins.", "Keep a go-bag ready with water, food, documents, medication, and a charged phone."] },
      { title: "Don't: Carry Items Mistaken for Weapons", bullets: ["Do not carry tools, equipment, or objects that could be mistaken for weapons at checkpoints.", "Keep your hands visible and move slowly and calmly when approaching military or police personnel."] },
      { title: "Don't: Approach Checkpoints Aggressively", bullets: ["Approach any checkpoint slowly, with hands visible. Follow all instructions without argument.", "Announce your presence and intentions clearly and calmly. Carry identification documents at all times."] },
      { title: "Don't: Photograph Military Personnel or Equipment", bullets: ["Taking photos of military personnel, vehicles, or installations can be perceived as hostile activity.", "Respect all photography restrictions. If you need to document damage for reporting, focus only on infrastructure."] },
    ],
  },
  {
    id: "unrest",
    label: "Civil Unrest",
    emoji: "🚨",
    slides: [
      { title: "Do: Stay Calm and Move Away Steadily", bullets: ["If caught in civil unrest, stay calm. Panic triggers crowd crush — move steadily and purposefully away from the crowd.", "Move toward the edges of crowds and away from the direction of march or conflict."] },
      { title: "Do: Identify Exits and Safe Routes in Advance", bullets: ["When in a public space, always locate at least two exits as a precaution.", "Know the location of police stations, hospitals, embassies, and hotels that may provide temporary shelter."] },
      { title: "Do: Comply With Law Enforcement Instructions", bullets: ["Follow all instructions from law enforcement. Avoid anything that could be perceived as confrontational.", "Carry identification and keep it accessible. Be prepared to explain your purpose clearly and calmly."] },
      { title: "Don't: Engage With or Confront Demonstrators", bullets: ["Do not engage, argue, or confront demonstrators regardless of your views — your safety is the priority.", "Do not film confrontations at close range. Recording at a safe distance may be acceptable in some contexts."] },
      { title: "Don't: Use Your Phone Visibly in a Hostile Crowd", bullets: ["Using a phone visibly in a hostile crowd can attract attention and make you a target for theft or aggression.", "If you need to communicate, move to a sheltered location out of the crowd before using your phone."] },
      { title: "Don't: Panic or Run Through Crowds", bullets: ["Running through a crowd can trigger a stampede. Move steadily, calmly, and assertively rather than running.", "If you fall in a crowd, protect your head with your arms, curl into a ball, and get up as quickly as possible."] },
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
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
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

function isComplete(part: Part, id?: string): boolean {
  return localStorage.getItem(lsKey(part, id)) === "1";
}

function markComplete(part: Part, id?: string) {
  localStorage.setItem(lsKey(part, id), "1");
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

  function handleComplete() {
    markComplete(completionKey.part, completionKey.id);
    setDone(true);
    onComplete();
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
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#fff", maxWidth: 480, margin: "0 auto" }}>
        <div style={{ background: BLUE, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button onClick={() => navigate("/")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
            <IconBack />
          </button>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>Safety Tips</span>
        </div>
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
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#fff", maxWidth: 480, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ background: BLUE, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button onClick={() => navigate("/")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
            <IconBack />
          </button>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>Safety Tips</span>
        </div>
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
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#fff", maxWidth: 480, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ background: BLUE, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <button onClick={() => navigate("/")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
            <IconBack />
          </button>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>Safety Tips</span>
        </div>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#f7fafc", maxWidth: 480, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ background: BLUE, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={() => navigate("/")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
          <IconBack />
        </button>
        <span style={{ color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 }}>Safety Tips</span>
      </div>

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
