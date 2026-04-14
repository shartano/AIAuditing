import { useEffect } from 'react';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { COLORS } from '../constants/theme';
import { GlobalProvider, useGlobal } from '../context/global-provider';

// Navigation access
function RootLayoutNav() {
  const { token, loading } = useGlobal();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const inTabsGroup = segments[0] === '(tabs)';
    const inProtectedScreens = segments[0] === 'settings' || segments[0] === 'audit-detail' || segments[0] === 'how-to-use' || segments[0] === 'camera';
    
    console.log(token)
    if (!token && (inTabsGroup || inProtectedScreens)) {
      router.replace('/'); 
      console.log("No token, can't access internal pages.")
    }
  }, [token, loading, segments]);

  return (
    <ThemeProvider value={DefaultTheme}>
      <Stack>
        {/* Main Tabs (Home, History, Profile) - Header Hidden */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        
        {/* Auth Screens - Header Hidden */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />

        {/* HEADERS: Settings & How-to-Use */}
        <Stack.Screen 
          name="settings" 
          options={{ 
            title: 'Settings', 
            headerStyle: { backgroundColor: COLORS.primary }, 
            headerTintColor: '#fff', 
            headerTitleStyle: { fontWeight: 'bold', fontSize: 25 } 
          }} 
        />
        <Stack.Screen 
          name="how-to-use" 
          options={{ 
            title: 'How to Use', 
            headerStyle: { backgroundColor: COLORS.primary }, 
            headerTintColor: '#fff', 
            headerTitleStyle: { fontWeight: 'bold', fontSize: 25 } 
          }} 
        />
        <Stack.Screen 
          name="camera" 
          options={{ 
            title: 'Camera',
            headerStyle: { backgroundColor: COLORS.primary }, 
            headerTintColor: '#fff', 
            headerTitleStyle: { fontWeight: 'bold', fontSize: 25 } 
          }} 
        />
        <Stack.Screen 
          name="audit-detail/[id]" 
          options={{ 
            presentation: 'modal', // popup sheet
            headerShown: false 
          }} 
        />
        <Stack.Screen 
          name="audit-model/[id]" 
          options={{ 
            presentation: 'fullScreenModal', // popup sheet
            headerShown: false,
            gestureEnabled: false,
            animation: 'slide_from_bottom' // fade in/out animation
          }} 
        />
      </Stack>
      <StatusBar style="light" />
    </ThemeProvider>
  );
}

// Export wraps everything in the Provider
export default function RootLayout() {
  return (
    <GlobalProvider>
      <RootLayoutNav />
    </GlobalProvider>
  );
}