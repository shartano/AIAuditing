import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import * as ImagePicker from 'expo-image-picker';

export default function HomeScreen() {
  const router = useRouter();

  const handleUploadFromHome = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: false,
        quality: 1,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      const videoUri = asset?.uri;
      if (!videoUri) return;

      router.push({
        pathname: '/camera',
        params: { videoUri },
      });
    } catch (e) {
      console.error('handleUploadFromHome error:', e);
      Alert.alert('Upload failed', 'Could not select a video. Please try again.');
    }
  };

  return (
    <ScrollView 
      style={styles.container} 
      contentContainerStyle={styles.scrollContent}
    >
      {/* 1. Header Section */}
      <View style={styles.header}>
        <Text style={styles.welcomeText}>Welcome back</Text>
        <Text style={styles.subtitleText}>Ready to audit accessible spaces?</Text>
      </View>

      {/* 2. "How to Use" Card */}
      <TouchableOpacity 
        style={styles.howToCard} 
        onPress={() => router.push('/how-to-use')}
        activeOpacity={0.8}
      >
        <View style={styles.iconCircleWhite}>
          <Ionicons name="information-circle" size={28} color={COLORS.accent} />
        </View>
        <View style={styles.cardContent}>
          <Text style={styles.cardTitleWhite}>How to Use</Text>
          <Text style={styles.cardSubtitleWhite}>Quick guide to get started</Text>
        </View>
        <Ionicons name="arrow-forward" size={20} color="rgba(255,255,255,0.8)" />
      </TouchableOpacity>

      {/* Bottom Grid (History & Reports) */}
      <View style={styles.gridContainer}>
        
        {/* History Card */}
        <TouchableOpacity 
          style={styles.gridCard} 
          onPress={() => router.push('/camera')}
        >
          <View style={[styles.iconCircle, { backgroundColor: '#E3F2FD' }]}>
            <Ionicons name="scan-circle" size={24} color={COLORS.primary} />
          </View>
          <Text style={styles.gridCardTitle}>Record Video</Text>
          <Text style={styles.gridCardSubtitle}>Record a guided video for a new audit</Text>
        </TouchableOpacity>

        {/* Profile Card */}
        <TouchableOpacity style={styles.gridCard} 
          onPress={handleUploadFromHome}
          activeOpacity={0.8}
        >
          <View style={[styles.iconCircle, { backgroundColor: COLORS.successBg }]}>
            <Ionicons name="cloud-upload" size={24} color={COLORS.success} />
          </View>
          <Text style={styles.gridCardTitle}>Upload Video</Text>
          <Text style={styles.gridCardSubtitle}>Upload an existing video from your device</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: COLORS.background, 
  },
  scrollContent: {
    padding: 20,
  },
  
  // Header
  header: { marginBottom: 25 },
  welcomeText: { 
    fontSize: 28, 
    fontWeight: 'bold', 
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  subtitleText: { 
    fontSize: 16, 
    color: COLORS.textSecondary,
  },
  
  // "How to Use" Card
  howToCard: {
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    // Shadows
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  iconCircleWhite: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: '#fff', 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginRight: 15 
  },
  cardContent: { flex: 1 },
  cardTitleWhite: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 2 },
  cardSubtitleWhite: { color: 'rgba(255,255,255,0.9)', fontSize: 14 },

  // Main Action Button
  mainActionButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    height: 64,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },

  // Grid Section
  gridContainer: { flexDirection: 'row', justifyContent: 'space-between' },
  gridCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 20,
    width: '48%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  iconCircle: { 
    width: 50, 
    height: 50, 
    borderRadius: 25, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginBottom: 12 
  },
  gridCardTitle: { 
    fontSize: 16, 
    fontWeight: '600', 
    color: COLORS.textPrimary,
    marginBottom: 4,
  },
  gridCardSubtitle: { 
    fontSize: 12, 
    color: COLORS.textSecondary, 
    textAlign: 'center',
  },
});