import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AuthState {
  reporterId: string | null;
  isVerified: boolean;
  countryCode: string | null;
  languageCode: string;
  isOnboarded: boolean;

  setReporter: (reporterId: string, isVerified: boolean) => void;
  setCountry: (countryCode: string) => void;
  setLanguage: (languageCode: string) => void;
  setOnboarded: () => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      reporterId: null,
      isVerified: false,
      countryCode: null,
      languageCode: "en",
      isOnboarded: false,

      setReporter: (reporterId, isVerified) =>
        set({ reporterId, isVerified }),

      setCountry: (countryCode) => set({ countryCode }),

      setLanguage: (languageCode) => set({ languageCode }),

      setOnboarded: () => set({ isOnboarded: true }),

      reset: () => {
        localStorage.removeItem("cr_country");
        localStorage.removeItem("cr_language");
        localStorage.removeItem("cr_tc_accepted");
        localStorage.removeItem("cr_access_token");
        localStorage.removeItem("cr_refresh_token");
        localStorage.removeItem("cr_reporter_id");
        set({
          reporterId: null,
          isVerified: false,
          countryCode: null,
          languageCode: "en",
          isOnboarded: false,
        });
      },
    }),
    {
      name: "cr_auth",
    }
  )
);