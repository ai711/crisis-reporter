import { useEffect } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useAuthStore } from "./src/stores/authStore";
import { initDeviceId } from "./src/services/auth";
import "./src/i18n";

import OnboardingScreen from "./src/screens/OnboardingScreen";
import HomeScreen from "./src/screens/HomeScreen";
import ReportScreen from "./src/screens/ReportScreen";
import MapScreen from "./src/screens/MapScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import MyReportsScreen from "./src/screens/MyReportsScreen";

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
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="MyReports" component={MyReportsScreen} />
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