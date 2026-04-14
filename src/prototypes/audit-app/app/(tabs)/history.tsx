import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { useGlobal } from '../../context/global-provider';

interface Audit {
  audit_id: string;
  room_name: string;
  created_at: string;
  status: 'queued' | 'completed' | 'failed';
  compliance_score?: number;
}

export default function HistoryScreen() {
  const router = useRouter();
  const { apiUrl, token } = useGlobal(); 
  
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTab, setSelectedTab] = useState<'all' | 'queued' | 'completed'>('all');
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    // Only fetch if we have a token
    if (token) {
      fetchAudits({ isInitialLoad: true });
    }
  }, [token]);

  // fetch function supports initial load vs refresh
  const fetchAudits = useCallback(
    async ({ isInitialLoad = false }: { isInitialLoad?: boolean } = {}) => {
      if (!token) return;

      if (isInitialLoad) setLoading(true);
      else setRefreshing(true);

      try {
        const response = await fetch(`${apiUrl}/audits/history`, {
          headers: { token: token! },
        });

        if (response.ok) {
          const data = await response.json();
          setAudits(data);
        }
      } catch (error) {
        console.error("Failed to fetch history:", error);
      } finally {
        if (isInitialLoad) setLoading(false);
        else setRefreshing(false);
      }
    },
    [apiUrl, token]
  );

  // handler for pull-to-refresh
  const onRefresh = useCallback(async () => {
    await fetchAudits({ isInitialLoad: false });
  }, [fetchAudits]);

  const getFilteredAudits = () => {
    return audits.filter(audit => {
      const matchesTab = 
        selectedTab === 'all' ? true : 
        selectedTab === 'completed' ? audit.status === 'completed' :
        audit.status === 'queued';

      const matchesSearch = audit.room_name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesTab && matchesSearch;
    });
  };

  const handlePressAudit = (audit: Audit) => {
    if (audit.status === 'completed') {
      router.push({
        pathname: '/audit-detail/[id]', 
        params: { id: audit.audit_id }  
      });
    } else {
      alert("Audit is processing. Content is not yet accessible.");
    }
  };

  const renderAuditItem = ({ item }: { item: Audit }) => {
    const isCompleted = item.status === 'completed';
    const isFailed = item.status === 'failed';

    return (
      <TouchableOpacity 
        style={styles.card} 
        onPress={() => handlePressAudit(item)}
        activeOpacity={0.7}
      >
        <View style={styles.cardRow}>
          {/* Status Icon */}
          <View style={[
            styles.iconBox, 
            isCompleted ? styles.iconComplete : styles.iconProcessing
          ]}>
            <Ionicons 
              name={isCompleted ? "checkmark-circle" : "sync"} 
              size={28} 
              color={isCompleted ? COLORS.success : COLORS.warning} 
            />
          </View>

          {/* Text Info */}
          <View style={styles.cardInfo}>
            <Text style={styles.roomName}>{item.room_name}</Text>
            <Text style={styles.dateText}>
              {item.created_at}{' '}
              {isFailed && 'Audit generation failed.'}
              {!isFailed && isCompleted && 'Report Ready'}
              {!isFailed && !isCompleted && 'Processing...'}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={24} color={COLORS.textSecondary} style={styles.searchIcon} />
        <TextInput 
          style={styles.searchInput}
          placeholder="Search audits..."
          placeholderTextColor={COLORS.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Tabs */}
      <View style={styles.tabsContainer}>
        {(['all', 'queued', 'completed'] as const).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[
              styles.tabButton, 
              selectedTab === tab && styles.tabButtonActive
            ]}
            onPress={() => setSelectedTab(tab)}
          >
            <Text style={[
              styles.tabText, 
              selectedTab === tab && styles.tabTextActive
            ]}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        <FlatList
          data={getFilteredAudits()}
          renderItem={renderAuditItem}
          keyExtractor={(item) => item.audit_id}
          contentContainerStyle={styles.listContent}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No audits found matching your criteria.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  
  // Search
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 50,
    borderWidth: 2, 
    borderColor: COLORS.border,
  },
  searchIcon: { marginRight: 12 },
  searchInput: { 
    flex: 1, 
    fontSize: 18, 
    color: COLORS.textPrimary,
  },

  // Tabs
  tabsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginVertical: 20,
    paddingHorizontal: 16,
    gap: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 25,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: COLORS.border,
  },
  tabButtonActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  tabText: { 
    fontSize: 16, 
    fontWeight: '600', 
    color: COLORS.textPrimary,
  },
  tabTextActive: { 
    color: '#FFFFFF', 
  },

  // List Cards
  listContent: { paddingHorizontal: 16, paddingBottom: 30 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    shadowColor: COLORS.primary,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 3,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center' },
  
  // Icon Boxes
  iconBox: {
    width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginRight: 16,
  },
  iconComplete: { backgroundColor: COLORS.successBg },
  iconProcessing: { backgroundColor: COLORS.warningBg },

  // Card Text
  cardInfo: { flex: 1 },
  roomName: { 
    fontSize: 18, 
    fontWeight: '700', 
    color: COLORS.textPrimary, 
    marginBottom: 6,
    lineHeight: 24,
  },
  dateText: { 
    fontSize: 15, 
    color: COLORS.textSecondary,
    fontWeight: '500',
    lineHeight: 20,
  },

  // Score Badge
  scoreBadge: {
    backgroundColor: '#ECEFF1', 
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  scoreText: { 
    fontSize: 14, 
    fontWeight: 'bold', 
    color: COLORS.textPrimary, 
  },

  // Empty State
  emptyState: { alignItems: 'center', marginTop: 50, padding: 20 },
  emptyText: { 
    marginTop: 10, 
    color: COLORS.textSecondary, 
    fontSize: 18, 
    textAlign: 'center',
    lineHeight: 26,
  },
});