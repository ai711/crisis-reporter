import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

interface AuthState {
  reporterId: string | null;
  isVerified: boolean;
  countryCode: string | null;
  languageCode: string;
  isOnboarded: boolean;
  activeCrisisId: string | null;

  setReporter: (reporterId: string, isVerified: boolean) => void;
  setCountry: (countryCode: string) => void;
  setLanguage: (languageCode: string) => void;
  setOnboarded: () => void;
  setActiveCrisis: (crisisId: string) => void;
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
      activeCrisisId: null,

      setReporter: (reporterId, isVerified) =>
        set({ reporterId, isVerified }),
      setCountry: (countryCode) => set({ countryCode }),
      setLanguage: (languageCode) => set({ languageCode }),
      setOnboarded: () => set({ isOnboarded: true }),
      setActiveCrisis: (activeCrisisId) => set({ activeCrisisId }),
      reset: () =>
        set({
          reporterId: null,
          isVerified: false,
          countryCode: null,
          languageCode: "en",
          isOnboarded: false,
          activeCrisisId: null,
        }),
    }),
    {
      name: "cr_auth_store",
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);