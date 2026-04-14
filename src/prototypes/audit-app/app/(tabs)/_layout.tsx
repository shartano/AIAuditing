import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        // 1. Color Integration
        tabBarActiveTintColor: COLORS.primary, // Navy Blue for active tab
        tabBarInactiveTintColor: COLORS.textSecondary, // Blue-Grey for inactive
        // 2. Styling
        tabBarStyle: {
          backgroundColor: COLORS.card, // White background
          borderTopColor: COLORS.border, // Subtle border
          height: 80,
          paddingBottom: 10,
          paddingTop: 10,
        },
        tabBarLabelStyle: {
          fontSize: 14,
          fontWeight: '600',
          fontFamily: 'System',
        },
        // 3. Header Styling
        headerStyle: {
          backgroundColor: COLORS.primary,
          shadowColor: 'transparent', // Remove shadow line on Android
          elevation: 0,
        },
        headerTintColor: '#fff', 
        headerTitleStyle: {
          fontWeight: 'bold',
          fontSize: 24,
        },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Home',
          headerTitle: 'Home', 
          tabBarIcon: ({ color }) => <Ionicons name="home" size={28} color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          headerTitle: 'My Audit History',
          tabBarIcon: ({ color }) => <Ionicons name="time" size={28} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          headerTitle: 'My Profile',
          tabBarIcon: ({ color }) => <Ionicons name="person" size={28} color={color} />,
        }}
      />
    </Tabs>
  );
}