import { useState, useEffect, useRef, useMemo } from "react";
import { Lock } from "lucide-react";

// ── Country list fetcher ──────────────────────────────────────────────────────

export interface CountryOption {
  code: string; // ISO 3166-1 alpha-2, e.g. "KE"
  name: string; // display name, e.g. "Kenya"
}

export async function fetchCountries(): Promise<CountryOption[]> {
  const res = await fetch(
    (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000") + "/api/countries"
  );
  if (!res.ok) return [];
  const data = await res.json() as unknown[];
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null && "code" in data[0]) {
    return (data as { code: string; name: string }[]).map(d => ({
      code: d.code.toUpperCase(),
      name: d.name,
    }));
  }
  return [];
}

// ── Country multi-select dropdown ─────────────────────────────────────────────

interface CountrySelectProps {
  // selected holds ISO 3166-1 alpha-2 codes (e.g. ["KE", "IN"])
  selected: string[];
  onChange: (v: string[]) => void;
  // countries is the full list with codes + display names
  countries: CountryOption[];
  placeholder?: string;
  readOnly?: boolean;
}

export default function CountrySelect({ selected, onChange, countries, placeholder = "Select countries", readOnly = false }: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // code → display name lookup for rendering chips
  const codeToName = useMemo(
    () => Object.fromEntries(countries.map(c => [c.code, c.name])),
    [countries]
  );

  const filtered = countries.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.code.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (code: string) => {
    onChange(selected.includes(code) ? selected.filter(x => x !== code) : [...selected, code]);
  };

  if (readOnly) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, background: "#f9f9f9" }}>
        {selected.length === 0 && <span style={{ color: "#aaa" }}>None</span>}
        {selected.map((code) => (
          <span key={code} style={{ display: "flex", alignItems: "center", gap: 3, background: "#eee", borderRadius: 4, padding: "2px 8px", fontSize: 12 }}>
            <Lock size={10} color="#999" />
            {codeToName[code] ?? code}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          minHeight: 38, border: "1px solid #ccc", borderRadius: 6, padding: "4px 8px",
          cursor: "pointer", display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
          background: "#fff",
        }}
      >
        {selected.length === 0 && <span style={{ color: "#aaa", fontSize: 13 }}>{placeholder}</span>}
        {selected.map((code) => (
          <span key={code} style={{ display: "flex", alignItems: "center", gap: 3, background: "#E3F2FD", borderRadius: 4, padding: "2px 7px", fontSize: 12 }}>
            {codeToName[code] ?? code}
            <button
              onClick={(e) => { e.stopPropagation(); toggle(code); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "#555" }}
            >×</button>
          </span>
        ))}
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200,
          background: "#fff", border: "1px solid #ccc", borderRadius: 6,
          maxHeight: 200, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
        }}>
          <div style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by country name or code…"
              style={{ width: "100%", border: "1px solid #ddd", borderRadius: 4, padding: "4px 8px", fontSize: 13, boxSizing: "border-box" }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {filtered.map((c) => (
            <label key={c.code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={selected.includes(c.code)} onChange={() => toggle(c.code)} />
              {c.name}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#9aa5b4", fontWeight: 600 }}>{c.code}</span>
            </label>
          ))}
          {filtered.length === 0 && <div style={{ padding: "8px 12px", color: "#aaa", fontSize: 13 }}>No results</div>}
        </div>
      )}
    </div>
  );
}
