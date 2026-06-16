import { useState, useEffect } from "react";
import { I18nManager, AppState } from "react-native";
import type { AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
// Background sync — must be imported before any React component so the task
// definition (TaskManager.defineTask) runs at module scope.
import { registerBackgroundSync } from "./src/utils/backgroundSync";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { useAuthStore } from "./src/stores/authStore";
import { initDeviceId, syncRegistrationQueue } from "./src/services/auth";
import { flushProgressQueue } from "./src/utils/progressQueue";
import { syncQueue, resetStuckItems } from "./src/utils/offlineQueue";
import { API_BASE } from "./src/services/api";
import "./src/i18n";

import OnboardingScreen from "./src/screens/OnboardingScreen";
import HomeScreen from "./src/screens/HomeScreen";
import ReportScreen from "./src/screens/ReportScreen";
import MapScreen from "./src/screens/MapScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import MyReportsScreen from "./src/screens/MyReportsScreen";
import LoginScreen from "./src/screens/LoginScreen";
import ReporterProfileScreen from "./src/screens/ReporterProfileScreen";
import SafetyTipsScreen from "./src/screens/SafetyTipsScreen";
import BadgesScreen from "./src/screens/BadgesScreen";
import FAQScreen from "./src/screens/FAQScreen";
import AboutScreen from "./src/screens/AboutScreen";
import ReportDetailScreen from "./src/screens/ReportDetailScreen";
import QueuedReportDetailScreen from "./src/screens/QueuedReportDetailScreen";
import RegisterScreen from "./src/screens/RegisterScreen";
import ErrorBoundary from "./src/components/ErrorBoundary";

// Show notifications even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Module-level ref so the notification tap listener (outside component tree)
// can call navigate() after the container is ready.
const navigationRef = createNavigationContainerRef<any>();

const Stack = createNativeStackNavigator();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 2,
    },
  },
});

function Navigation() {
  const { isOnboarded } = useAuthStore();

  useEffect(() => {
    initDeviceId();
    // Reset any items that were mid-sync when the app was last killed.
    resetStuckItems();
    // Register the background fetch task so offline reports sync even when
    // the app is fully killed (minimum 15-minute OS interval).
    registerBackgroundSync().catch(() => { /* non-critical */ });

    // Navigate to My Reports when the user taps a sync notification
    // (both foreground and background/killed-app taps).
    const notifSub = Notifications.addNotificationResponseReceivedListener(() => {
      if (navigationRef.isReady()) {
        navigationRef.navigate("MyReports" as never);
      }
    });
    return () => notifSub.remove();
  }, []);

  useEffect(() => {
    // Attempt to flush queued progress once on mount.
    flushProgressQueue();

    // Sync queued reports whenever connectivity is restored while the app
    // is in the foreground.
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable !== false) {
        syncRegistrationQueue();
        flushProgressQueue();
        syncQueue(API_BASE).catch(() => {});
      }
    });

    // Also sync when the app returns to the foreground — covers the gap
    // between background-fetch intervals when the user reopens the app.
    const appStateSub = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active") {
          NetInfo.fetch().then((state) => {
            if (state.isConnected && state.isInternetReachable !== false) {
              syncQueue(API_BASE).catch(() => {});
            }
          });
        }
      }
    );

    return () => {
      unsubscribeNet();
      appStateSub.remove();
    };
  }, []);

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!isOnboarded ? (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        ) : (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="Report" component={ReportScreen} />
            <Stack.Screen name="Map" component={MapScreen} />
            <Stack.Screen name="SettingsScreen" component={SettingsScreen} options={{ headerShown: false }} />
            <Stack.Screen name="MyReports" component={MyReportsScreen} />
            <Stack.Screen name="LoginScreen" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen name="RegisterScreen" component={RegisterScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ReporterProfileScreen" component={ReporterProfileScreen} options={{ headerShown: false }} />
            <Stack.Screen name="SafetyTipsScreen" component={SafetyTipsScreen} options={{ headerShown: false }} />
            <Stack.Screen name="BadgesScreen" component={BadgesScreen} options={{ headerShown: false }} />
            <Stack.Screen name="FAQScreen" component={FAQScreen} options={{ headerShown: false }} />
            <Stack.Screen name="AboutScreen" component={AboutScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ReportDetailScreen" component={ReportDetailScreen} options={{ headerShown: false }} />
            <Stack.Screen name="QueuedReportDetailScreen" component={QueuedReportDetailScreen} options={{ headerShown: false }} />
            {/* Reuse OnboardingScreen for viewing T&C from Settings (step 3 only). */}
            <Stack.Screen name="TermsScreen" component={OnboardingScreen} initialParams={{ initialStep: 3 }} options={{ headerShown: false }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [rtlReady, setRtlReady] = useState(false);

  useEffect(() => {
    // Apply RTL direction before the first screen renders so Arabic users
    // see correct mirrored layout from the very first frame.
    AsyncStorage.getItem("cr_language")
      .then((lang) => { I18nManager.forceRTL(lang === "ar"); })
      .catch(() => {})
      .finally(() => setRtlReady(true));
  }, []);

  if (!rtlReady) return null;

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Navigation />
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}