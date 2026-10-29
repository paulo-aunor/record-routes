import "@/lib/tracking";   // registers the background task that records the shift
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: "#0a0a0a" },
            headerTintColor: "#f5f5f5",
            headerTitleStyle: { fontWeight: "700" },
            contentStyle: { backgroundColor: "#0a0a0a" },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Record Routes" }} />
          <Stack.Screen name="shift" options={{ title: "Tonight's shift" }} />
          <Stack.Screen name="import" options={{ title: "Add route from PDF" }} />
          <Stack.Screen name="routes" options={{ title: "Manage routes" }} />
          <Stack.Screen name="paused" options={{ title: "Stopped houses" }} />
          <Stack.Screen name="earnings" options={{ title: "Earnings and reports" }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
