import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { useGlobal } from '../../context/global-provider';

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout, isLoading } = useGlobal();

  const handleSignOut = async () => {
    await logout();
    router.replace('/');
  };

  // Show loading while Context is initializing
  if (isLoading || !user) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  // Formatting helpers
  const initials = user.first_name && user.last_name 
    ? `${user.first_name[0]}${user.last_name[0]}`.toUpperCase() 
    : "??";
    
  const fullName = `${user.first_name} ${user.last_name}`;

  return (
    <ScrollView style={styles.container}>
      
      {/* 1. Header Card (Avatar & Role) */}
      <View style={styles.headerCard}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{fullName}</Text>
          <Text style={styles.headerEmail}>{user.email}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{user.role || "Auditor"}</Text>
          </View>
        </View>
      </View>

      {/* 2. User Information Section */}
      <View style={styles.sectionCard}>
        
        {/* Full Name Row */}
        <View style={styles.infoRow}>
          <View style={styles.iconContainer}>
            <Ionicons name="person-outline" size={20} color={COLORS.textSecondary} />
          </View>
          <View>
            <Text style={styles.label}>Full Name</Text>
            <Text style={styles.value}>{fullName}</Text>
          </View>
        </View>
        <View style={styles.divider} />

        {/* Email Row */}
        <View style={styles.infoRow}>
          <View style={styles.iconContainer}>
            <Ionicons name="mail-outline" size={20} color={COLORS.textSecondary} />
          </View>
          <View>
            <Text style={styles.label}>Email</Text>
            <Text style={styles.value}>{user.email}</Text>
          </View>
        </View>
        <View style={styles.divider} />

        {/* Organization Row */}
        <View style={styles.infoRow}>
          <View style={styles.iconContainer}>
            <Ionicons name="business-outline" size={20} color={COLORS.textSecondary} />
          </View>
          <View>
            <Text style={styles.label}>Organization</Text>
            <Text style={styles.value}>Crepancy Inc.</Text> 
          </View>
        </View>
      </View>

      {/* 3. Settings Section */}
      <View style={styles.sectionCard}>
        <TouchableOpacity style={styles.settingsRow} onPress={() => router.push('/settings')}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <Ionicons name="settings-outline" size={20} color={COLORS.textSecondary} style={{marginRight: 15}} />
            <Text style={styles.settingsText}>Settings</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.border} />
        </TouchableOpacity>
      </View>

      {/* 4. Sign Out Button */}
      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Ionicons name="log-out-outline" size={20} color={COLORS.error} style={{ marginRight: 8 }} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    padding: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  
  // Header Card Styles
  headerCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,

    shadowColor: COLORS.primary,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  avatarCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  avatarText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  headerEmail: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  roleBadge: {
    backgroundColor: COLORS.background,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  roleText: {
    fontSize: 12,
    color: COLORS.textPrimary,
    fontWeight: '600',
    textTransform: 'capitalize',
  },

  // Section Card Styles
  sectionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 20,
    shadowColor: COLORS.primary,
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  iconContainer: {
    width: 30,
    alignItems: 'flex-start',
  },
  label: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginBottom: 2,
  },
  value: {
    fontSize: 16,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginLeft: 30,
    opacity: 0.5,
  },

  // Settings specific
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  settingsText: {
    fontSize: 16,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },

  // Sign Out Button
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: COLORS.error,
    marginBottom: 40,
  },
  signOutText: {
    fontSize: 16,
    color: COLORS.error,
    fontWeight: '600',
  },
});