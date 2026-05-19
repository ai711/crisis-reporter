import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface AuthState {
  reporterId: string | null;
  isVerified: boolean;
  countryCode: string | null;
  languageCode: string;
  isOnboarded: boolean;
  activeCrisisId: string | null;
  deviceId: string | null;
  osDeviceId: string | null;
  tAndCAcceptedAt: string | null;

  setReporter: (reporterId: string, isVerified: boolean) => void;
  setReporterId: (reporterId: string) => void;
  setCountry: (countryCode: string) => void;
  setLanguage: (languageCode: string) => void;
  setOnboarded: () => void;
  setActiveCrisis: (crisisId: string) => void;
  setDeviceId: (id: string) => void;
  setOsDeviceId: (id: string | null) => void;
  setTAndCAcceptedAt: (ts: string) => void;
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
      deviceId: null,
      osDeviceId: null,
      tAndCAcceptedAt: null,

      setReporter: (reporterId: string, isVerified: boolean) =>
        set({ reporterId, isVerified }),
      setReporterId: (reporterId: string) => set({ reporterId }),
      setCountry: (countryCode: string) => set({ countryCode }),
      setLanguage: (languageCode: string) => set({ languageCode }),
      setOnboarded: () => set({ isOnboarded: true }),
      setActiveCrisis: (activeCrisisId: string) => set({ activeCrisisId }),
      setDeviceId: (deviceId: string) => set({ deviceId }),
      setOsDeviceId: (osDeviceId: string | null) => set({ osDeviceId }),
      setTAndCAcceptedAt: (tAndCAcceptedAt: string) => set({ tAndCAcceptedAt }),
      reset: () =>
        set({
          reporterId: null,
          isVerified: false,
          countryCode: null,
          languageCode: "en",
          isOnboarded: false,
          activeCrisisId: null,
          deviceId: null,
          osDeviceId: null,
          tAndCAcceptedAt: null,
        }),
    }),
    {
      name: "cr_auth_store",
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);