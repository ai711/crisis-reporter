import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Lock, X, ChevronLeft, ChevronRight, Filter, FolderOpen } from "lucide-react";
import Header from "../components/Header";
import { usePageTitle } from "../hooks/usePageTitle";
import PageSpinner from "../components/PageSpinner";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import { useAuthStore } from "../stores/authStore";
import {
  getDashboardProjects,
  createProject,
  updateProject,
} from "../services/api";
import type { ProjectListRow, ProjectsListResponse } from "../types";
import {
  formatDateTime,
  formatDateRange,
  formatProjectStatus,
  isEndDatePassed,
  PROJECT_STATUS_COLOURS,
} from "../utils/formatters";

// ── Country list fetcher ──────────────────────────────────────────────────────

async function fetchCountries(): Promise<string[]> {
  const res = await fetch(
    (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000") + "/api/countries"
  );
  if (!res.ok) return [];
  const data = await res.json();
  // Accept array of strings or array of {name, code} objects
  if (Array.isArray(data) && data.length > 0) {
    if (typeof data[0] === "string") return data as string[];
    if (typeof data[0] === "object" && data[0].name) return data.map((d: { name: string }) => d.name);
  }
  return [];
}

// ── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9999,
      background: "#2E7D32", color: "#fff", padding: "12px 20px",
      borderRadius: 8, fontSize: 14, fontWeight: 500,
      boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    }}>
      {message}
    </div>
  );
}

// ── Country multi-select dropdown ─────────────────────────────────────────────

interface CountrySelectProps {
  selected: string[];
  onChange: (v: string[]) => void;
  countries: string[];
  placeholder?: string;
  readOnly?: boolean;
}

function CountrySelect({ selected, onChange, countries, placeholder = "Select countries", readOnly = false }: CountrySelectProps) {
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

  const filtered = countries.filter((c) => c.toLowerCase().includes(search.toLowerCase()));

  const toggle = (c: string) => {
    onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
  };

  if (readOnly) {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, background: "#f9f9f9" }}>
        {selected.length === 0 && <span style={{ color: "#aaa" }}>None</span>}
        {selected.map((c) => (
          <span key={c} style={{ display: "flex", alignItems: "center", gap: 3, background: "#eee", borderRadius: 4, padding: "2px 8px", fontSize: 12 }}>
            <Lock size={10} color="#999" />
            {c}
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
        {selected.map((c) => (
          <span key={c} style={{ display: "flex", alignItems: "center", gap: 3, background: "#E3F2FD", borderRadius: 4, padding: "2px 7px", fontSize: 12 }}>
            {c}
            <button
              onClick={(e) => { e.stopPropagation(); toggle(c); }}
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
              placeholder="Search…"
              style={{ width: "100%", border: "1px solid #ddd", borderRadius: 4, padding: "4px 8px", fontSize: 13, boxSizing: "border-box" }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          {filtered.map((c) => (
            <label key={c} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
              {c}
            </label>
          ))}
          {filtered.length === 0 && <div style={{ padding: "8px 12px", color: "#aaa", fontSize: 13 }}>No results</div>}
        </div>
      )}
    </div>
  );
}

// ── Create Project Modal ──────────────────────────────────────────────────────

interface CreateProjectModalProps {
  onClose: () => void;
  countries: string[];
}

function CreateProjectModal({ onClose, countries }: CreateProjectModalProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [description, setDescription] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);

  const today = new Date().toISOString().split("T")[0];

  const isValid = name.trim() !== "" && selectedCountries.length > 0 && startDate !== "" && endDate !== "";

  const mutation = useMutation({
    mutationFn: () =>
      createProject({
        name: name.trim(),
        countries: selectedCountries,
        start_date: startDate,
        end_date: endDate,
        description: description.trim() || undefined,
      }),
    onSuccess: (res) => {
      const serialId: string = res.data?.serial_id;
      queryClient.invalidateQueries({ queryKey: ["dashboard-projects"] });
      onClose();
      if (serialId) navigate(`/projects/${serialId}`);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Failed to create project. Please try again.";
      setInlineError(
        msg.toLowerCase().includes("already exist") || msg.toLowerCase().includes("unique")
          ? "A project with this name already exists."
          : msg
      );
    },
  });

  return (
    <div style={overlayStyle} onClick={mutation.isPending ? undefined : onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: "24px 28px 18px", borderBottom: "1px solid #f0f4f8", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18, color: "#1A2B4A" }}>Create New Project</div>
            <div style={{ fontSize: 12, color: "#718096", marginTop: 2 }}>Initialize a new crisis monitoring project</div>
          </div>
          <button onClick={onClose} disabled={mutation.isPending} style={iconBtnStyle}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 18 }}>

          {/* Important Notice box */}
          <div style={{
            background: "rgba(4,104,177,0.06)", border: "1px solid rgba(4,104,177,0.15)",
            borderRadius: 8, padding: "12px 14px", display: "flex", gap: 10, alignItems: "flex-start",
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--c-primary-container)", flexShrink: 0, fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>info</span>
            <p style={{ fontSize: 12, color: "#00497f", lineHeight: 1.6, margin: 0 }}>
              <strong>Important Notice:</strong> Country selection and start date cannot be changed once the project has been initialized. Please verify all details before creation.
            </p>
          </div>

          {/* Project Name */}
          <div>
            <label style={modalLabelStyle}>Project Name <span style={{ color: "#e53e3e" }}>*</span></label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setInlineError(null); }}
              placeholder="e.g. Sudan Humanitarian Response 2026"
              style={modalInputStyle}
            />
          </div>

          {/* Countries */}
          <div>
            <label style={modalLabelStyle}>Countries <span style={{ color: "#e53e3e" }}>*</span></label>
            <CountrySelect
              selected={selectedCountries}
              onChange={setSelectedCountries}
              countries={countries}
              placeholder="Select at least one country"
            />
            {selectedCountries.length === 0 && !inlineError && (
              <span style={{ fontSize: 11, color: "#9aa5b4", marginTop: 3, display: "block" }}>At least one country is required</span>
            )}
          </div>

          {/* Start Date + End Date — side by side */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label style={modalLabelStyle}>Start Date <span style={{ color: "#e53e3e" }}>*</span></label>
              <div style={{ position: "relative" }}>
                <span className="material-symbols-outlined" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#9aa5b4", pointerEvents: "none", fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>calendar_today</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  max={today}
                  style={{ ...modalInputStyle, paddingLeft: 34 }}
                />
              </div>
              <div style={{ fontSize: 11, color: "#B45309", marginTop: 3 }}>Cannot be changed after creation.</div>
            </div>
            <div>
              <label style={modalLabelStyle}>End Date <span style={{ color: "#e53e3e" }}>*</span></label>
              <div style={{ position: "relative" }}>
                <span className="material-symbols-outlined" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, color: "#9aa5b4", pointerEvents: "none", fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>calendar_today</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate || undefined}
                  style={{ ...modalInputStyle, paddingLeft: 34 }}
                />
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <label style={modalLabelStyle}>Description <span style={{ fontSize: 10, color: "#9aa5b4", fontWeight: 400 }}>(optional)</span></label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
              placeholder="Describe the crisis event or project scope."
              rows={3}
              style={{ ...modalInputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            />
            <div style={{ fontSize: 11, color: "#9aa5b4", textAlign: "right", marginTop: 2 }}>{description.length}/1000</div>
          </div>

          {inlineError && (
            <div style={{ background: "#FDECEA", color: "#C62828", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
              {inlineError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 28px", background: "#f7f9fc", borderTop: "1px solid #f0f4f8", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} disabled={mutation.isPending} style={cancelBtnStyle}>Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!isValid || mutation.isPending}
            style={{ ...primaryBtnStyle, opacity: !isValid || mutation.isPending ? 0.5 : 1 }}
          >
            {mutation.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Project Modal ────────────────────────────────────────────────────────

interface EditProjectModalProps {
  project: ProjectListRow;
  onClose: () => void;
  onSuccess: () => void;
}

function EditProjectModal({ project, onClose, onSuccess }: EditProjectModalProps) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(project.name);
  const [endDate, setEndDate] = useState(project.end_date ? project.end_date.split("T")[0] : "");
  const [status, setStatus] = useState(project.status);
  const [description, setDescription] = useState(project.description ?? "");
  const [inlineError, setInlineError] = useState<string | null>(null);

  const today = new Date().toISOString().split("T")[0];
  const endPassed = isEndDatePassed(project.end_date);

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        status,
        description: description.trim() || null,
      };
      if (!endPassed) payload.end_date = endDate;
      return updateProject(project.serial_id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-projects"] });
      onSuccess();
      onClose();
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        "Failed to save changes. Please try again.";
      setInlineError(
        msg.toLowerCase().includes("already exist") || msg.toLowerCase().includes("unique")
          ? "A project with this name already exists."
          : msg
      );
    },
  });

  return (
    <div style={overlayStyle} onClick={mutation.isPending ? undefined : onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeaderStyle}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Edit Project</span>
          <button onClick={onClose} disabled={mutation.isPending} style={iconBtnStyle}><X size={18} /></button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Name */}
          <div>
            <label style={labelStyle}>Project Name</label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setInlineError(null); }}
              style={inputStyle}
            />
          </div>

          {/* Countries — read-only */}
          <div>
            <label style={labelStyle}>
              Countries
              <span style={{ fontWeight: 400, color: "#C62828", fontSize: 11, marginLeft: 6 }}>
                Country selection cannot be changed after creation.
              </span>
            </label>
            <CountrySelect
              selected={project.countries}
              onChange={() => {}}
              countries={[]}
              readOnly
            />
          </div>

          {/* Start Date — read-only */}
          <div>
            <label style={labelStyle}>
              Start Date
              <span style={{ fontWeight: 400, color: "#C62828", fontSize: 11, marginLeft: 6 }}>
                Start date cannot be changed after creation.
              </span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, background: "#f9f9f9", fontSize: 13 }}>
              <Lock size={12} color="#999" />
              {project.start_date ? new Date(project.start_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
            </div>
          </div>

          {/* End Date */}
          <div>
            <label style={labelStyle}>End Date</label>
            {endPassed ? (
              <>
                <div style={{ padding: "8px 10px", border: "1px solid #ddd", borderRadius: 6, background: "#f9f9f9", fontSize: 13 }}>
                  {project.end_date ? new Date(project.end_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                </div>
                <div style={{ fontSize: 11, color: "#B45309", marginTop: 2 }}>
                  End date has passed and cannot be extended.
                </div>
              </>
            ) : (
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={today}
                style={inputStyle}
              />
            )}
          </div>

          {/* Status */}
          <div>
            <label style={labelStyle}>Project Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description <span style={{ color: "#aaa", fontWeight: 400 }}>(optional)</span></label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
              rows={3}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
            <div style={{ fontSize: 11, color: "#aaa", textAlign: "right" }}>{description.length}/1000</div>
          </div>

          {inlineError && (
            <div style={{ background: "#FDECEA", color: "#C62828", borderRadius: 6, padding: "8px 12px", fontSize: 13 }}>
              {inlineError}
            </div>
          )}
        </div>
        <div style={modalFooterStyle}>
          <button onClick={onClose} disabled={mutation.isPending} style={cancelBtnStyle}>Cancel</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || name.trim() === ""}
            style={{ ...primaryBtnStyle, opacity: mutation.isPending || name.trim() === "" ? 0.5 : 1 }}
          >
            {mutation.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Filter panel ──────────────────────────────────────────────────────────────

interface FilterState {
  status: string[];
  country: string;
  dateFrom: string;
  dateTo: string;
}

const DEFAULT_FILTERS: FilterState = {
  status: ["active"],
  country: "",
  dateFrom: "",
  dateTo: "",
};

interface FilterPanelProps {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  onClose: () => void;
  countries: string[];
}

function FilterPanel({ filters, onChange, onClose, countries }: FilterPanelProps) {
  const [local, setLocal] = useState<FilterState>({ ...filters });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const apply = () => { onChange(local); onClose(); };
  const clear = () => {
    // Preserve current status (controlled by tabs); reset only country/date
    const reset: FilterState = { ...DEFAULT_FILTERS, status: filters.status };
    setLocal(reset); onChange(reset); onClose();
  };

  return (
    <div ref={ref} style={{
      position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 300,
      background: "#fff", border: "1px solid #e0e8f0", borderRadius: 10,
      boxShadow: "0 8px 32px rgba(8,27,57,0.12)", padding: 20, width: 300,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: "#1A2B4A" }}>Advanced Filters</span>
        <button onClick={clear} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--c-primary-container)", fontWeight: 600 }}>Clear</button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>Country</div>
        <select
          value={local.country}
          onChange={(e) => setLocal((p) => ({ ...p, country: e.target.value }))}
          style={{ ...inputStyle, fontSize: 13 }}
        >
          <option value="">All countries</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>Date Range Overlap</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#aaa", marginBottom: 2 }}>From</div>
            <input type="date" value={local.dateFrom} onChange={(e) => setLocal((p) => ({ ...p, dateFrom: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#aaa", marginBottom: 2 }}>To</div>
            <input type="date" value={local.dateTo} onChange={(e) => setLocal((p) => ({ ...p, dateTo: e.target.value }))} style={{ ...inputStyle, fontSize: 12 }} />
          </div>
        </div>
      </div>

      <button onClick={apply} style={{ ...primaryBtnStyle, width: "100%" }}>Apply Filters</button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  usePageTitle("Projects");
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canEdit =
    user?.role === "admin" ||
    user?.role === "superadmin" ||
    user?.role_permissions?.["projects"]?.edit === true;

  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 400);
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTERS });
  const [filterOpen, setFilterOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [editProject, setEditProject] = useState<ProjectListRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [countries, setCountries] = useState<string[]>([]);
  useEffect(() => { fetchCountries().then(setCountries); }, []);

  const isGuest = user?.role === "guest";

  // Build query params
  const queryParams: Record<string, string | number> = { limit: 50 };
  if (search) queryParams.search = search;
  if (filters.status.length > 0) queryParams.status = filters.status.join(",");
  if (filters.country) queryParams.country = filters.country;
  if (filters.dateFrom) queryParams.date_from = filters.dateFrom;
  if (filters.dateTo) queryParams.date_to = filters.dateTo;
  if (cursor) queryParams.cursor = cursor;
  if (isGuest && user?.id) queryParams.assigned_to_user = user.id;

  const { data, isLoading, isError } = useQuery<ProjectsListResponse>({
    queryKey: ["dashboard-projects", search, filters, cursor, isGuest],
    queryFn: async () => {
      const res = await getDashboardProjects(queryParams);
      return res.data as ProjectsListResponse;
    },
    staleTime: 0,
  });

  // Reset pagination when search/filters change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(null);
    setCursorStack([null]);
    setPage(0);
  }, [search, filters]);

  const goNext = useCallback(() => {
    if (!data?.cursor) return;
    setCursorStack((prev) => [...prev, data.cursor]);
    setCursor(data.cursor);
    setPage((p) => p + 1);
  }, [data]);

  const goPrev = useCallback(() => {
    if (page === 0) return;
    const newStack = cursorStack.slice(0, -1);
    setCursorStack(newStack);
    setCursor(newStack[newStack.length - 1] ?? null);
    setPage((p) => p - 1);
  }, [page, cursorStack]);

  // Status is controlled by tabs — only country/date count as "active filters"
  const filtersActive =
    filters.country !== "" ||
    filters.dateFrom !== "" ||
    filters.dateTo !== "";

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Status tab colours (border left on active row)
  const STATUS_ROW_BORDER: Record<string, string> = {
    active: "#005a2c",
    closed: "transparent",
    archived: "transparent",
  };

  return (
    <div>
      <Header title="Projects" subtitle="Manage crisis response projects by country and date range" />
      <div style={{ padding: "24px 32px 40px" }}>

        {/* ── Controls row ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>

          {/* Search */}
          <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 380 }}>
            <span className="material-symbols-outlined" style={{
              position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
              fontSize: 18, color: "#9aa5b4", pointerEvents: "none",
              fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20",
            }}>search</span>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by project name, ID, or country…"
              style={{ ...inputStyle, paddingLeft: 36, fontSize: 13, background: "#fff", boxShadow: "0 1px 4px rgba(8,27,57,0.05)" }}
            />
          </div>

          {/* Status tabs */}
          <div style={{ display: "flex", background: "#fff", border: "1px solid #e0e8f0", borderRadius: 8, padding: 3, gap: 2, boxShadow: "0 1px 4px rgba(8,27,57,0.05)" }}>
            {(["active", "closed", "archived"] as const).map((tab) => {
              const isTab = filters.status.length === 1 && filters.status[0] === tab;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setFilters((prev) => ({ ...prev, status: [tab] }));
                    setCursor(null); setCursorStack([null]); setPage(0);
                  }}
                  style={{
                    padding: "6px 18px", borderRadius: 6, border: "none", cursor: "pointer",
                    fontSize: 12, fontWeight: 700, lineHeight: 1,
                    background: isTab ? "var(--c-primary-container)" : "transparent",
                    color: isTab ? "#fff" : "#718096",
                    transition: "all 0.15s",
                  }}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              );
            })}
          </div>

          {/* Advanced filter button */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setFilterOpen((o) => !o)}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
                border: "1px solid #e0e8f0", borderRadius: 8,
                background: filtersActive ? "#EBF5FB" : "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                color: filtersActive ? "var(--c-primary-container)" : "#555",
                boxShadow: "0 1px 4px rgba(8,27,57,0.05)",
              }}
            >
              <Filter size={13} />
              Filters
              {filtersActive && (
                <span style={{ background: "var(--c-primary-container)", color: "#fff", borderRadius: 10, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>
                  On
                </span>
              )}
            </button>
            {filterOpen && (
              <FilterPanel
                filters={filters}
                onChange={setFilters}
                onClose={() => setFilterOpen(false)}
                countries={countries}
              />
            )}
          </div>

          {/* New Project button */}
          <button
            onClick={() => setShowCreate(true)}
            style={{ ...primaryBtnStyle, display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>add</span>
            New Project
          </button>
        </div>

        {/* ── Table ── */}
        <div style={{ background: "#fff", border: "1px solid #e0e8f0", borderRadius: 12, overflow: "hidden", boxShadow: "0 2px 12px rgba(8,27,57,0.05)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e0e8f0" }}>
                {["Project Name", "Country", "Date Range", "Total Reports", "Status", "Created By", "Actions"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "12px 16px", textAlign: h === "Total Reports" ? "right" : "left",
                      fontWeight: 700, fontSize: 11, color: "#6b7280",
                      letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7}><PageSpinner /></td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={7}><ErrorState message="Failed to load projects. Check your connection and try again." /></td>
                </tr>
              )}
              {!isLoading && !isError && items.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon={<FolderOpen size={28} color="var(--c-text-subtle)" />}
                      title="No projects found"
                      message="Create your first project to start organising crisis reports."
                      action={
                        <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
                          + New Project
                        </button>
                      }
                    />
                  </td>
                </tr>
              )}
              {items.map((row) => {
                const isArchived = row.status === "archived";
                const borderColor = STATUS_ROW_BORDER[row.status] ?? "transparent";
                const statusColors = PROJECT_STATUS_COLOURS[row.status] ?? { bg: "#f5f5f5", text: "#666" };
                return (
                  <tr
                    key={row.id}
                    style={{
                      borderBottom: "1px solid #f0f4f8",
                      borderLeft: `4px solid ${borderColor}`,
                      opacity: isArchived ? 0.6 : 1,
                    }}
                  >
                    {/* Project Name + ID */}
                    <td style={{ padding: "14px 16px", maxWidth: 260 }}>
                      <button
                        onClick={() => navigate(`/projects/${row.serial_id}`)}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
                      >
                        <span style={{ display: "block", fontWeight: 700, fontSize: 13, color: "#1A2B4A" }}>{row.name}</span>
                        <span style={{ display: "block", fontSize: 10, fontWeight: 600, color: "#9aa5b4", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 2 }}>
                          ID: {row.serial_id}
                        </span>
                      </button>
                    </td>

                    {/* Country */}
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#718096", fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>flag</span>
                        <span style={{ fontSize: 13, color: "#1A2B4A", fontWeight: 500 }}>
                          {row.countries.slice(0, 2).join(", ")}
                          {row.countries.length > 2 && (
                            <span style={{ color: "#9aa5b4", fontSize: 11 }}> +{row.countries.length - 2} more</span>
                          )}
                        </span>
                      </div>
                    </td>

                    {/* Date Range */}
                    <td style={{ padding: "14px 16px", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 12, color: "#555" }}>{formatDateRange(row.start_date, row.end_date)}</span>
                      {isEndDatePassed(row.end_date) && (
                        <span style={{ marginLeft: 6, background: "#FFF3E0", color: "#B45309", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 600 }}>
                          Past end date
                        </span>
                      )}
                    </td>

                    {/* Total Reports */}
                    <td style={{ padding: "14px 16px", textAlign: "right" }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: "#1A2B4A" }}>{row.total_reports.toLocaleString()}</span>
                    </td>

                    {/* Status pill */}
                    <td style={{ padding: "14px 16px" }}>
                      <span style={{
                        display: "inline-flex", alignItems: "center",
                        background: statusColors.bg, color: statusColors.text,
                        borderRadius: 20, padding: "3px 10px",
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                      }}>
                        {formatProjectStatus(row.status)}
                      </span>
                    </td>

                    {/* Created By + date */}
                    <td style={{ padding: "14px 16px" }}>
                      {row.created_by_name ? (
                        <>
                          <button
                            onClick={() => row.created_by_user_id && window.open(`/users/${row.created_by_user_id}`, "_blank")}
                            style={{ background: "none", border: "none", cursor: row.created_by_user_id ? "pointer" : "default", padding: 0, display: "block", fontSize: 13, fontWeight: 600, color: "#1A2B4A", textAlign: "left" }}
                          >
                            {row.created_by_name}
                          </button>
                          <span style={{ fontSize: 10, color: "#9aa5b4" }}>{formatDateTime(row.created_at)}</span>
                        </>
                      ) : (
                        <span style={{ color: "#ccc" }}>—</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td style={{ padding: "14px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button
                          onClick={() => navigate(`/projects/${row.serial_id}`)}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--c-primary-container)", padding: 0 }}
                        >
                          View
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => setEditProject(row)}
                            style={{ background: "none", border: "none", cursor: "pointer", padding: "3px 5px", color: "#9aa5b4", borderRadius: 4, display: "flex", alignItems: "center" }}
                            title="Edit project"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {!isLoading && (total > 0 || page > 0) && (
            <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #f0f4f8", background: "#f8fafc" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "#718096" }}>
                {total.toLocaleString()} project{total !== 1 ? "s" : ""} total
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={goPrev}
                  disabled={page === 0}
                  style={{ ...paginationBtnStyle, opacity: page === 0 ? 0.35 : 1 }}
                  title="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  onClick={goNext}
                  disabled={!data?.has_more}
                  style={{ ...paginationBtnStyle, opacity: !data?.has_more ? 0.35 : 1 }}
                  title="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          countries={countries}
        />
      )}
      {editProject && (
        <EditProjectModal
          project={editProject}
          onClose={() => setEditProject(null)}
          onSuccess={() => setToast("Project updated successfully.")}
        />
      )}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #ccc",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 4,
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--c-primary-container)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "8px 18px",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

const cancelBtnStyle: React.CSSProperties = {
  background: "#fff",
  color: "#444",
  border: "1px solid #ccc",
  borderRadius: 6,
  padding: "8px 18px",
  fontWeight: 500,
  fontSize: 13,
  cursor: "pointer",
};

const paginationBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 14px",
  border: "1px solid #ddd",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const modalStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: 10,
  width: 520,
  maxWidth: "95vw",
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
};

const modalHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "18px 24px",
  borderBottom: "1px solid #E5E7EB",
};

const modalFooterStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  padding: "16px 24px",
  borderTop: "1px solid #E5E7EB",
};

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 4,
  color: "#666",
  borderRadius: 4,
};

// Modal-specific label/input — lighter background, no border (matches mockup)
const modalLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  color: "#718096",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 6,
};

const modalInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "#f2f4f7",
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  color: "#1A2B4A",
  boxSizing: "border-box",
  outline: "none",
};
