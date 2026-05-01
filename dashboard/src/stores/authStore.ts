import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DashboardUser } from "../types";

interface AuthState {
  user: DashboardUser | null;
  activeCrisisId: string | null;
  activeCrisisName: string | null;

  setUser: (user: DashboardUser) => void;
  setActiveCrisis: (id: string, name: string) => void;
  clearActiveCrisis: () => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      activeCrisisId: null,
      activeCrisisName: null,

      setUser: (user) => set({ user }),

      setActiveCrisis: (id, name) =>
        set({ activeCrisisId: id, activeCrisisName: name }),

      clearActiveCrisis: () =>
        set({ activeCrisisId: null, activeCrisisName: null }),

      reset: () =>
        set({ user: null, activeCrisisId: null, activeCrisisName: null }),
    }),
    { name: "dash_auth" }
  )
);