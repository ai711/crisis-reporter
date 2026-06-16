import { create } from "zustand";
import api from "../services/api";

interface SiteSettings {
  dashboard_title: string;
  logo_url: string | null;
}

interface SettingsState {
  dashboardTitle: string;
  logoUrl: string | null;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  setSettings: (s: SiteSettings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  dashboardTitle: "Crisis Reporter",
  logoUrl: null,
  loaded: false,

  loadSettings: async () => {
    try {
      const res = await api.get<SiteSettings>("/api/settings/display");
      set({
        dashboardTitle: res.data.dashboard_title || "Crisis Reporter",
        logoUrl: res.data.logo_url ?? null,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  setSettings: (s) =>
    set({
      dashboardTitle: s.dashboard_title || "Crisis Reporter",
      logoUrl: s.logo_url ?? null,
    }),
}));
