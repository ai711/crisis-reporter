import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DashboardUser } from "../types";

interface AuthState {
  user: DashboardUser | null;

  setUser: (user: DashboardUser) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,

      setUser: (user) => set({ user }),

      reset: () => set({ user: null }),
    }),
    { name: "dash_auth" }
  )
);