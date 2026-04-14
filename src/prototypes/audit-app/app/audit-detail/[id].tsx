import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Text, ScrollView, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { useGlobal } from '../../context/global-provider';

// --- Types ---
interface ComplianceItem {
  test_id: string;
  name: string;
  status: 'red' | 'green' | 'unknown';
  message: string;
  regulations: string;
  recommendations: string;
  measured_value: number | boolean | string | null;
  target_object: string;
}

interface AuditData {
  compliance_report: ComplianceItem[];
}

export default function AuditDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const { apiUrl, token } = useGlobal();

  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAuditDetails();
  }, [id]);

  const fetchAuditDetails = async () => {
    try {
      const response = await fetch(`${apiUrl}/audits/${id}/result`, {
        headers: { 'token': token! }
      });

      if (response.ok) {
        const jsonData = await response.json();

        // --- Normalize the data ---
        // If backend sends Array --> wrap, if Object --> use directly
        if (Array.isArray(jsonData)) {
          setData({
            compliance_report: jsonData,
          });
        } else {
          setData(jsonData);
        }

      } else {
        Alert.alert("Error", "Could not load audit details.");
      }
    } catch (error) {
      console.error("Error fetching audit details:", error);
      Alert.alert("Error", "Failed to connect to server.");
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'green': return COLORS.success;
      case 'red': return COLORS.error;
      default: return COLORS.warning;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'green': return "checkmark-circle";
      case 'red': return "alert-circle";
      default: return "help-circle";
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.loadingContainer}>
            <Text style={{color: COLORS.textSecondary}}>No data available.</Text>
            <TouchableOpacity onPress={() => router.back()} style={{marginTop: 20}}>
                <Text style={{color: COLORS.primary}}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const report = data.compliance_report || [];

  // calculate score
  const passed = report.filter(i => i.status === 'green').length;
  const failed = report.filter(i => i.status === 'red').length;
  const unknown = report.filter(i => i.status === 'unknown').length;
  const total = passed + failed + unknown;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;

  const handleViewDetails = () => {
    console.log("Navigate to 3D model");
    router.push({
      pathname: "../audit-model/[id]",
      params: { id }
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.closeButton}>
          <Ionicons name="close" size={28} color={COLORS.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Audit Report</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>

        {/* Score Card */}
        <View style={styles.scoreCard}>
          <View style={styles.scoreLeft}>
            <Text style={styles.scoreLabel}>Compliance Score</Text>
            <Text style={[styles.scoreValue, { color: score > 70 ? COLORS.success : COLORS.error }]}>
              {score}%
            </Text>
          </View>
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={[styles.statNumber, { color: COLORS.success }]}>{passed}</Text>
              <Text style={styles.statLabel}>Pass</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statNumber, { color: COLORS.error }]}>{failed}</Text>
              <Text style={styles.statLabel}>Fail</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statNumber, { color: COLORS.warning }]}>{unknown}</Text>
              <Text style={styles.statLabel}>Skipped</Text>
            </View>
          </View>
        </View>

        {/* Action Button */}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleViewDetails}
        >
          <Text style={styles.primaryButtonText}>
            View 3D Model
          </Text>
        </TouchableOpacity>

        {/* Compliance List */}
        <Text style={styles.sectionTitle}>Compliance Checklist</Text>

        {report.map((item, index) => (
          <View key={index} style={[styles.reportCard, { borderLeftColor: getStatusColor(item.status) }]}>

            <View style={styles.reportHeader}>
              <View style={styles.titleRow}>
                <Ionicons name={getStatusIcon(item.status) as any} size={20} color={getStatusColor(item.status)} />
                <Text style={styles.reportName}>{item.name}</Text>
              </View>

              {/* Only show numeric measurements */}
              {typeof item.measured_value === 'number' && (
                <View style={styles.measureBadge}>
                  <Text style={styles.measureText}>{item.measured_value.toFixed(2)}m</Text>
                </View>
              )}
            </View>

            <Text style={styles.reportMessage}>
              {item.message || "No details available."}
            </Text>

            {!!item.recommendations && (
              <Text style={styles.reportRecommendations}>
                {item.recommendations}
              </Text>
            )}

            {!!item.regulations && (
              <Text style={styles.reportRegulations}>
                {item.regulations}
              </Text>
            )}

            <View style={[styles.statusPill, { backgroundColor: getStatusColor(item.status) + '20' }]}>
              <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>
                {item.status.toUpperCase()}
              </Text>
            </View>
          </View>
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 15, paddingBottom: 15, paddingHorizontal: 20,
    backgroundColor: COLORS.card, borderBottomWidth: 1, borderColor: COLORS.border,
  },
  headerTitle: { fontSize: 25, fontWeight: 'bold', color: COLORS.textPrimary },
  closeButton: { padding: 4 },
  scrollContent: { padding: 20 },
  scoreCard: {
    backgroundColor: COLORS.card, borderRadius: 12, padding: 20, marginBottom: 20,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8, elevation: 3,
  },
  scoreLeft: { alignItems: 'flex-start' },
  scoreLabel: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 4 },
  scoreValue: { fontSize: 32, fontWeight: '900' },
  statsRow: { flexDirection: 'row', gap: 15 },
  statItem: { alignItems: 'center' },
  statNumber: { fontSize: 18, fontWeight: 'bold' },
  statLabel: { fontSize: 12, color: COLORS.textSecondary },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: COLORS.textPrimary, marginBottom: 12, marginTop: 10 },
  assetsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  assetBadge: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#EEF2FF',
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: '#C7D2FE',
  },
  assetText: { marginLeft: 6, color: COLORS.primary, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  reportCard: {
    backgroundColor: COLORS.card, borderRadius: 12, padding: 16, marginBottom: 12,
    borderLeftWidth: 4, borderWidth: 1, borderColor: COLORS.border,
  },
  reportHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 },
  reportName: { fontSize: 16, fontWeight: '600', color: COLORS.textPrimary, marginLeft: 8, flex: 1, flexWrap: 'wrap' },
  measureBadge: { backgroundColor: '#F5F5F5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  measureText: { fontSize: 12, fontWeight: 'bold', color: COLORS.textPrimary },
  reportMessage: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 12, lineHeight: 20 },
  reportRegulations: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 12, lineHeight: 20 },
  reportRecommendations: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 12, lineHeight: 20 },
  statusPill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  statusText: { fontSize: 11, fontWeight: '800' },
  primaryButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 24,
  },

  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

});