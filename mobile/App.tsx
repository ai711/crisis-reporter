import { useEffect } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { useAuthStore } from "./src/stores/authStore";
import { initDeviceId, syncRegistrationQueue } from "./src/services/auth";
import { flushProgressQueue } from "./src/utils/progressQueue";
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
  }, []);

  useEffect(() => {
    // Attempt to flush queued progress once on mount, then again whenever
    // the device reports a network reconnection.
    flushProgressQueue();
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable !== false) {
        syncRegistrationQueue();
        flushProgressQueue();
      }
    });
    return () => unsubscribe();
  }, []);

  return (
    <NavigationContainer>
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
            <Stack.Screen name="ReporterProfileScreen" component={ReporterProfileScreen} options={{ headerShown: false }} />
            <Stack.Screen name="SafetyTipsScreen" component={SafetyTipsScreen} options={{ headerShown: false }} />
            <Stack.Screen name="BadgesScreen" component={BadgesScreen} options={{ headerShown: false }} />
            <Stack.Screen name="FAQScreen" component={FAQScreen} options={{ headerShown: false }} />
            <Stack.Screen name="AboutScreen" component={AboutScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ReportDetailScreen" component={ReportDetailScreen} options={{ headerShown: false }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <Navigation />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}