import React, { useState } from 'react';
import { StyleSheet, View, Text, Switch, TouchableOpacity, ScrollView, Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { COLORS } from '../constants/theme';
import { useGlobal } from '../context/global-provider';
import { Stack } from 'expo-router';

export default function SettingsScreen() {
  const router = useRouter();
  const { apiUrl, token, logout } = useGlobal();
  
  const [isNotificationsEnabled, setIsNotificationsEnabled] = useState(true);
  const toggleNotifications = () => setIsNotificationsEnabled(previousState => !previousState);

  // --- Logic to Delete Account ---
  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "Are you sure? This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: async () => {
            try {
              // Call Backend
              await axios.delete(`${apiUrl}/auth/delete-account`, {
                headers: { token: token }
              });
              
              // Log out locally
              await logout();
              Alert.alert("Account Deleted", "We are sorry to see you go.");
              router.replace('/'); // Go to Login
            } catch (error) {
              Alert.alert("Error", "Could not delete account. Please try again.");
            }
          }
        }
      ]
    );
  };

  // Helper for rendering rows
  const renderRow = (label: string, icon: any, onPress: () => void, isDestructive = false) => (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.rowLeft}>
        <View style={[styles.iconContainer, isDestructive && styles.destructiveIcon]}>
          <Ionicons 
            name={icon} 
            size={22} 
            color={isDestructive ? COLORS.error : COLORS.textSecondary} 
          />
        </View>
        <Text style={[styles.rowLabel, isDestructive && styles.destructiveLabel]}>
          {label}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={COLORS.border} />
    </TouchableOpacity>
  );

return (
  <>
    <Stack.Screen options={{ title: 'Settings', headerBackTitle: 'Home' }} />

    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Section 1: Preferences */}
        <Text style={styles.sectionHeader}>PREFERENCES</Text>
        <View style={styles.sectionCard}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <View style={styles.iconContainer}>
                <Ionicons
                  name="notifications-outline"
                  size={22}
                  color={COLORS.textSecondary}
                />
              </View>
              <Text style={styles.rowLabel}>Push Notifications</Text>
            </View>
            <Switch
              trackColor={{ false: "#767577", true: COLORS.primary }}
              thumbColor={"#f4f3f4"}
              onValueChange={toggleNotifications}
              value={isNotificationsEnabled}
            />
          </View>
        </View>

        {/* Section 2: Support */}
        <Text style={styles.sectionHeader}>SUPPORT</Text>
        <View style={styles.sectionCard}>
          {renderRow("Help Center", "help-buoy-outline", () =>
            Alert.alert("Help", "Opening Help Center...")
          )}
          <View style={styles.divider} />
          {renderRow("Report a Bug", "bug-outline", () =>
            Alert.alert("Report", "Opening Bug Report Form...")
          )}
        </View>

        {/* Section 3: Legal */}
        <Text style={styles.sectionHeader}>LEGAL</Text>
        <View style={styles.sectionCard}>
          {renderRow("Privacy Policy", "lock-closed-outline", () =>
            Linking.openURL("https://google.com")
          )}
          <View style={styles.divider} />
          {renderRow("Terms of Service", "document-text-outline", () =>
            Linking.openURL("https://google.com")
          )}
        </View>

        {/* Section 4: Danger Zone */}
        <Text style={styles.sectionHeader}>ACCOUNT</Text>
        <View style={styles.sectionCard}>
          {renderRow("Delete Account", "trash-outline", handleDeleteAccount, true)}
        </View>

        <Text style={styles.versionText}>
          Crepancy v1.0.0 (Build 2026.02)
        </Text>
      </ScrollView>
    </View>
  </>
);

}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollContent: { padding: 20 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 8,
    marginLeft: 12,
    marginTop: 20,
  },
  sectionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    width: 32,
    alignItems: 'flex-start',
  },
  rowLabel: {
    fontSize: 16,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  
  destructiveLabel: { color: COLORS.error },
  destructiveIcon: { opacity: 1 }, 
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginLeft: 48, 
    opacity: 0.5,
  },
  versionText: {
    textAlign: 'center',
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 30,
    marginBottom: 40,
  },
});