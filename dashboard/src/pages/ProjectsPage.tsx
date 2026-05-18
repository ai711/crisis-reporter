import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Folder, Pencil, Lock, X, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import Header from "../components/Header";
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
        <div style={modalHeaderStyle}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Create Project</span>
          <button onClick={onClose} disabled={mutation.isPending} style={iconBtnStyle}><X size={18} /></button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Name */}
          <div>
            <label style={labelStyle}>Project Name <span style={{ color: "red" }}>*</span></label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setInlineError(null); }}
              placeholder="e.g. 2026 Turkey Earthquake"
              style={inputStyle}
            />
          </div>

          {/* Countries */}
          <div>
            <label style={labelStyle}>Countries <span style={{ color: "red" }}>*</span></label>
            <CountrySelect
              selected={selectedCountries}
              onChange={setSelectedCountries}
              countries={countries}
              placeholder="Select at least one country"
            />
            {selectedCountries.length === 0 && inlineError === null && (
              <span style={{ fontSize: 11, color: "#aaa" }}>At least one country required</span>
            )}
          </div>

          {/* Start Date */}
          <div>
            <label style={labelStyle}>
              Start Date <span style={{ color: "red" }}>*</span>
              <span style={{ fontWeight: 400, color: "#B45309", fontSize: 11, marginLeft: 6 }}>
                Cannot be changed after creation
              </span>
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              max={today}
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: "#B45309", marginTop: 2 }}>
              This field cannot be edited after the project is created.
            </div>
          </div>

          {/* End Date */}
          <div>
            <label style={labelStyle}>End Date <span style={{ color: "red" }}>*</span></label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate || undefined}
              style={inputStyle}
            />
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description <span style={{ color: "#aaa", fontWeight: 400 }}>(optional)</span></label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
              placeholder="Optional — describe the crisis event or project scope."
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
  createdBy: string;
}

const DEFAULT_FILTERS: FilterState = {
  status: ["active", "closed"],
  country: "",
  dateFrom: "",
  dateTo: "",
  createdBy: "",
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

  const toggleStatus = (s: string) => {
    setLocal((prev) => ({
      ...prev,
      status: prev.status.includes(s) ? prev.status.filter((x) => x !== s) : [...prev.status, s],
    }));
  };

  const apply = () => { onChange(local); onClose(); };
  const clear = () => { setLocal({ ...DEFAULT_FILTERS }); onChange({ ...DEFAULT_FILTERS }); onClose(); };

  return (
    <div ref={ref} style={{
      position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 300,
      background: "#fff", border: "1px solid #ddd", borderRadius: 8,
      boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 20, width: 320,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Filters</span>
        <button onClick={clear} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#0468B1" }}>Clear all</button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>Project Status</div>
        {["active", "closed", "archived"].map((s) => (
          <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={local.status.includes(s)} onChange={() => toggleStatus(s)} />
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </label>
        ))}
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

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 6 }}>Created By</div>
        <input
          value={local.createdBy}
          onChange={(e) => setLocal((p) => ({ ...p, createdBy: e.target.value }))}
          placeholder="Search by user name"
          style={{ ...inputStyle, fontSize: 13 }}
        />
      </div>

      <button onClick={apply} style={{ ...primaryBtnStyle, width: "100%" }}>Apply Filters</button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const canEdit = user?.role === "admin" || user?.role === "superadmin";

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

  // Build query params
  const queryParams: Record<string, string | number> = { limit: 50 };
  if (search) queryParams.search = search;
  if (filters.status.length > 0) queryParams.status = filters.status.join(",");
  if (filters.country) queryParams.country = filters.country;
  if (filters.dateFrom) queryParams.date_from = filters.dateFrom;
  if (filters.dateTo) queryParams.date_to = filters.dateTo;
  if (filters.createdBy) queryParams.created_by = filters.createdBy;
  if (cursor) queryParams.cursor = cursor;

  const { data, isLoading, isError } = useQuery<ProjectsListResponse>({
    queryKey: ["dashboard-projects", search, filters, cursor],
    queryFn: async () => {
      const res = await getDashboardProjects(queryParams);
      return res.data as ProjectsListResponse;
    },
    staleTime: 0,
  });

  // Reset pagination when search/filters change
  useEffect(() => {
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

  const filtersActive =
    filters.status.join(",") !== DEFAULT_FILTERS.status.join(",") ||
    filters.country !== "" ||
    filters.dateFrom !== "" ||
    filters.dateTo !== "" ||
    filters.createdBy !== "";

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <Header title="Projects" />
      <div style={{ padding: "0 32px 32px" }}>

        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, paddingTop: 8 }}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by project name, ID, or country"
            style={{ ...inputStyle, width: 340, fontSize: 13 }}
          />
          <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
            + Create Project
          </button>
        </div>

        {/* Filter bar */}
        <div style={{ position: "relative", marginBottom: 16 }}>
          <button
            onClick={() => setFilterOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 14px",
              border: "1px solid #ccc", borderRadius: 6, background: filtersActive ? "#E3F2FD" : "#fff",
              cursor: "pointer", fontSize: 13, fontWeight: 500, color: filtersActive ? "#0468B1" : "#444",
            }}
          >
            <Filter size={14} />
            Filters
            {filtersActive && (
              <span style={{ background: "#0468B1", color: "#fff", borderRadius: 10, fontSize: 11, padding: "1px 7px", fontWeight: 700 }}>
                Active
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

        {/* Table */}
        <div style={{ border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F9FAFB", borderBottom: "1px solid #E5E7EB" }}>
                {["Project ID", "Project Name", "Countries", "Date Range", "Reports", "Status", "Created", "Created By", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "#6B7280", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={9} style={{ padding: 40, textAlign: "center", color: "#aaa" }}>Loading…</td>
                </tr>
              )}
              {isError && (
                <tr>
                  <td colSpan={9} style={{ padding: 40, textAlign: "center", color: "#C62828" }}>Failed to load projects.</td>
                </tr>
              )}
              {!isLoading && !isError && items.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div style={{ padding: 60, textAlign: "center" }}>
                      <Folder size={40} color="#ccc" style={{ marginBottom: 12 }} />
                      <p style={{ color: "#888", marginBottom: 16 }}>
                        No projects found. Create your first project to start organising crisis reports.
                      </p>
                      <button onClick={() => setShowCreate(true)} style={primaryBtnStyle}>
                        + Create Project
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {items.map((row, idx) => (
                <tr key={row.id} style={{ borderBottom: "1px solid #F3F4F6", background: idx % 2 === 0 ? "#fff" : "#FAFAFA" }}>
                  {/* Project ID */}
                  <td style={{ padding: "10px 14px", fontFamily: "monospace", color: "#555", whiteSpace: "nowrap" }}>
                    {row.serial_id}
                  </td>
                  {/* Project Name */}
                  <td style={{ padding: "10px 14px" }}>
                    <button
                      onClick={() => navigate(`/projects/${row.serial_id}`)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#0468B1", fontWeight: 500, fontSize: 13, padding: 0, textAlign: "left" }}
                    >
                      {row.name}
                    </button>
                  </td>
                  {/* Countries */}
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {row.countries.slice(0, 3).map((c) => (
                        <span key={c} style={{ background: "#F3F4F6", color: "#555", borderRadius: 4, padding: "2px 7px", fontSize: 11 }}>{c}</span>
                      ))}
                      {row.countries.length > 3 && (
                        <span style={{ background: "#F3F4F6", color: "#555", borderRadius: 4, padding: "2px 7px", fontSize: 11 }}>
                          +{row.countries.length - 3} more
                        </span>
                      )}
                    </div>
                  </td>
                  {/* Date Range */}
                  <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                    <span>{formatDateRange(row.start_date, row.end_date)}</span>
                    {isEndDatePassed(row.end_date) && (
                      <span style={{ marginLeft: 6, background: "#FFF3E0", color: "#B45309", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 500 }}>
                        Past end date
                      </span>
                    )}
                  </td>
                  {/* Total Reports */}
                  <td style={{ padding: "10px 14px", color: "#444" }}>{row.total_reports.toLocaleString()}</td>
                  {/* Status */}
                  <td style={{ padding: "10px 14px" }}>
                    <span style={{
                      background: PROJECT_STATUS_COLOURS[row.status]?.bg ?? "#eee",
                      color: PROJECT_STATUS_COLOURS[row.status]?.text ?? "#555",
                      borderRadius: 12, padding: "3px 10px", fontSize: 12, fontWeight: 500,
                    }}>
                      {formatProjectStatus(row.status)}
                    </span>
                  </td>
                  {/* Created */}
                  <td style={{ padding: "10px 14px", whiteSpace: "nowrap", color: "#666" }}>
                    {formatDateTime(row.created_at)}
                  </td>
                  {/* Created By */}
                  <td style={{ padding: "10px 14px" }}>
                    {row.created_by_name && row.created_by_user_id ? (
                      <button
                        onClick={() => window.open(`/dashboard-users/${row.created_by_user_id}`, "_blank")}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#0468B1", fontSize: 13, padding: 0 }}
                      >
                        {row.created_by_name}
                      </button>
                    ) : (
                      <span style={{ color: "#aaa" }}>—</span>
                    )}
                  </td>
                  {/* Edit */}
                  <td style={{ padding: "10px 14px" }}>
                    {canEdit && (
                      <button
                        onClick={() => setEditProject(row)}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "#666", borderRadius: 4 }}
                        title="Edit project"
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!isLoading && (total > 0 || page > 0) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
            <span style={{ fontSize: 13, color: "#666" }}>
              {total.toLocaleString()} project{total !== 1 ? "s" : ""} total
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={goPrev}
                disabled={page === 0}
                style={{ ...paginationBtnStyle, opacity: page === 0 ? 0.4 : 1 }}
              >
                <ChevronLeft size={16} /> Previous
              </button>
              <button
                onClick={goNext}
                disabled={!data?.has_more}
                style={{ ...paginationBtnStyle, opacity: !data?.has_more ? 0.4 : 1 }}
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
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
  background: "#0468B1",
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
