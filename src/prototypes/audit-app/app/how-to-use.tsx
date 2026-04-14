import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function HowToUseScreen() {
  const steps = [
    { id: 1, title: 'Scan OR Upload a video', desc: 'Tap "Record Video" and use your device camera for a guided scan of the room. \nTap "Upload Video" to select an existing video from your device.', icon: 'camera-outline' },
    { id: 2, title: 'Object Detection', desc: 'The app automatically detects objects like doors, furniture, and fixtures.', icon: 'search-outline' },
    { id: 3, title: 'Automatic Analysis', desc: 'Your scan is analyzed against ADA and accessibility standards.', icon: 'checkmark-circle-outline' },
    { id: 4, title: 'View Results', desc: 'Review results in your summary or export them as a report.', icon: 'list-outline' },
  ];

  return (
    <ScrollView style={styles.container}>
      <Stack.Screen options={{ title: 'How to Use', headerBackTitle: 'Home' }} />
      
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Getting Started with AccessAudit</Text>
        <Text style={styles.headerSubtitle}>Follow these simple steps to conduct accessibility audits efficiently.</Text>
      </View>

      {steps.map((step) => (
        <View key={step.id} style={styles.stepCard}>
          <View style={styles.iconContainer}>
            <Ionicons name={step.icon as any} size={24} color="#4C66EE" />
          </View>
          <View style={styles.textContainer}>
            <Text style={styles.stepNumber}>Step {step.id}</Text>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDesc}>{step.desc}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF', padding: 20 },
  header: { alignItems: 'center', marginBottom: 30, marginTop: 20 },
  headerTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', color: '#1A1A1A' },
  headerSubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginTop: 10, paddingHorizontal: 20 },
  stepCard: { flexDirection: 'row', marginBottom: 25, alignItems: 'flex-start' },
  iconContainer: { width: 50, height: 50, borderRadius: 12, backgroundColor: '#F0F3FF', justifyContent: 'center', alignItems: 'center', marginRight: 15 },
  textContainer: { flex: 1 },
  stepNumber: { fontSize: 12, color: '#4C66EE', fontWeight: 'bold', textTransform: 'uppercase' },
  stepTitle: { fontSize: 18, fontWeight: '600', color: '#1A1A1A', marginVertical: 2 },
  stepDesc: { fontSize: 14, color: '#666', lineHeight: 20 },
});