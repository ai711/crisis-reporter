import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import api, { API_BASE } from '../services/api';
import {
  getQueue,
  removeFromQueue,
  onQueueChange,
  syncQueue,
} from '../utils/offlineQueue';
import type { QueuedReport } from '../types';
import NetInfo from '@react-native-community/netinfo';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SubmittedReport {
  id: string;
  damage_level: string | null;
  submitted_at: string | null;
  location: {
    location_address: string | null;
    location_building_name?: string | null;
    gps_latitude: number | null;
    gps_longitude: number | null;
  } | null;
  photo_count: number;
  first_photo_url: string | null;
}

interface SubmittedReportsResponse {
  items: SubmittedReport[];
  next_cursor: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const isAnonymousId = (id: string | null | undefined): boolean => {
  if (!id) return true;
  if (id.startsWith('CR-PENDING-')) return true;
  return false;
};

const getQueuedLocationLabel = (report: QueuedReport): string => {
  const loc = report.report.location;
  if (loc.location_building_name) return loc.location_building_name;
  if (loc.location_address) return loc.location_address;
  if (loc.gps_latitude != null) {
    return `${loc.gps_latitude.toFixed(4)}, ${(loc.gps_longitude ?? 0).toFixed(4)}`;
  }
  return 'Unknown location';
};

const getSubmittedLocationLabel = (report: SubmittedReport): string => {
  if (!report.location) return 'Unknown location';
  if (report.location.location_building_name) return report.location.location_building_name;
  if (report.location.location_address) return report.location.location_address;
  if (report.location.gps_latitude != null) {
    return `${report.location.gps_latitude.toFixed(4)}, ${(report.location.gps_longitude ?? 0).toFixed(4)}`;
  }
  return 'Unknown location';
};

const formatTime = (isoString: string | null | undefined): string => {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
};

// "failed" status is either explicitly set, or the item has exhausted retries
const isFailed = (report: QueuedReport): boolean =>
  report.status === 'failed' || (report.status === 'pending' && report.retry_count >= 5);

// ── Component ──────────────────────────────────────────────────────────────────

export default function MyReportsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

  // undefined = still loading from SecureStore; null = no ID; string = has ID
  const [reporterId, setReporterId] = useState<string | null | undefined>(undefined);
  const [queuedReports, setQueuedReports] = useState<QueuedReport[]>([]);
  const [submittedReports, setSubmittedReports] = useState<SubmittedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Load reporter ID from SecureStore ─────────────────────────────────────

  useEffect(() => {
    SecureStore.getItemAsync('cr_reporter_id').then((id) => {
      setReporterId(id ?? null);
    });
  }, []);

  // ── Load queue ────────────────────────────────────────────────────────────

  const loadQueue = useCallback(async () => {
    try {
      const queue = await getQueue();
      // Show pending, syncing, and failed items — exclude sent
      const active = queue.filter(
        (r) => r.status === 'pending' || r.status === 'syncing' || r.status === 'failed'
      );
      setQueuedReports(active);
    } catch {
      setQueuedReports([]);
    }
  }, []);

  // ── Load submitted reports from backend ───────────────────────────────────

  const loadSubmitted = useCallback(async (cursor?: string) => {
    try {
      const params = cursor ? `?cursor=${cursor}&limit=20` : '?limit=20';
      const response = await api.get<SubmittedReportsResponse>(`/api/reports/my${params}`);
      const items = response.data.items ?? [];
      const newCursor = response.data.next_cursor ?? null;

      if (cursor) {
        setSubmittedReports((prev) => [...prev, ...items]);
      } else {
        setSubmittedReports(items);
      }
      setNextCursor(newCursor);
      setError(null);
    } catch {
      setError('Failed to load reports. Please try again.');
    }
  }, []);

  // ── Initial load — waits for reporter ID to be resolved ──────────────────

  useEffect(() => {
    if (reporterId === undefined) return; // SecureStore not yet read
    const init = async () => {
      setLoading(true);
      await loadQueue();
      if (!isAnonymousId(reporterId)) {
        await loadSubmitted();
      }
      setLoading(false);
    };
    init();
  }, [reporterId, loadQueue, loadSubmitted]);

  // ── Subscribe to offline queue changes ────────────────────────────────────

  useEffect(() => {
    const unsubscribe = onQueueChange((_count: number) => {
      loadQueue();
    });
    return () => unsubscribe();
  }, [loadQueue]);

  // ── Pull-to-refresh ───────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadQueue();
    if (!isAnonymousId(reporterId)) {
      setNextCursor(null);
      await loadSubmitted();
    }
    setRefreshing(false);
  };

  // ── Load more submitted reports ───────────────────────────────────────────

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore || isAnonymousId(reporterId)) return;
    setLoadingMore(true);
    await loadSubmitted(nextCursor);
    setLoadingMore(false);
  };

  // ── Queue actions ─────────────────────────────────────────────────────────

  const handleRetry = async (_report: QueuedReport) => {
    const netState = await NetInfo.fetch();
    if (!netState.isConnected || !netState.isInternetReachable) {
      Alert.alert(
        'Still offline',
        'Internet is not available yet. Your report is saved and will send when you reconnect.'
      );
      return;
    }
    try {
      await syncQueue(API_BASE);
      await loadQueue();
      if (!isAnonymousId(reporterId)) {
        await loadSubmitted();
      }
    } catch {
      Alert.alert(
        'Retry failed',
        'Could not send report. It will retry automatically when internet returns.'
      );
    }
  };

  const handleDelete = (report: QueuedReport) => {
    Alert.alert(
      'Delete this report?',
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFromQueue(report.local_id);
              await loadQueue();
            } catch {
              Alert.alert('Error', 'Could not delete report. Please try again.');
            }
          },
        },
      ]
    );
  };

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.backBtnText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>My Reports</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.centred}>
          <ActivityIndicator color="#0468B1" size="large" />
        </View>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtnText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Reports</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#0468B1"
          />
        }
      >

        {/* ── SECTION 1: QUEUED REPORTS (all reporter states) ── */}
        {queuedReports.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>PENDING REPORTS</Text>
            {queuedReports.map((report) => {
              const failed = isFailed(report);
              return (
                <View key={report.local_id} style={styles.queueCard}>
                  <View style={styles.queueCardHeader}>
                    <Text style={styles.queueLocation} numberOfLines={1}>
                      {getQueuedLocationLabel(report)}
                    </Text>
                    <View style={[
                      styles.statusBadge,
                      failed ? styles.statusBadgeFailed : styles.statusBadgePending,
                    ]}>
                      <Text style={styles.statusBadgeText}>
                        {failed ? 'Failed' : 'Pending'}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.queueDetail}>
                    Damage: {report.report.damage_level ?? '—'}
                  </Text>
                  <Text style={styles.queueDetail}>
                    Saved: {formatTime(report.created_at)}
                  </Text>

                  {failed && report.retry_count > 0 && (
                    <Text style={styles.queueRetryCount}>
                      Failed after {report.retry_count} attempt{report.retry_count !== 1 ? 's' : ''}
                    </Text>
                  )}

                  <View style={styles.queueActions}>
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={() => handleRetry(report)}
                    >
                      <Text style={styles.retryBtnText}>Retry now</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deleteBtn}
                      onPress={() => handleDelete(report)}
                    >
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* ── SECTION 2: ANONYMOUS LOGIN PROMPT ── */}
        {isAnonymousId(reporterId) && (
          <View style={styles.loginPrompt}>
            <Text style={styles.loginPromptText}>
              Log in or create a free account to view your full report history.
            </Text>
            <TouchableOpacity
              style={styles.loginBtn}
              onPress={() => navigation.navigate('LoginScreen')}
            >
              <Text style={styles.loginBtnText}>Log In</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.createBtn}
              onPress={() => navigation.navigate('ReporterProfileScreen')}
            >
              <Text style={styles.createBtnText}>Create Account</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Empty state for anonymous with no queue */}
        {isAnonymousId(reporterId) && queuedReports.length === 0 && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateIcon}>📋</Text>
            <Text style={styles.emptyStateText}>No reports in this session.</Text>
          </View>
        )}

        {/* ── SECTION 3: SUBMITTED REPORTS (logged-in reporters only) ── */}
        {!isAnonymousId(reporterId) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>SUBMITTED REPORTS</Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={() => {
                    setError(null);
                    loadSubmitted();
                  }}
                >
                  <Text style={styles.retryBtnText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            )}

            {!error && submittedReports.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateIcon}>📋</Text>
                <Text style={styles.emptyStateText}>No reports submitted yet.</Text>
                <Text style={styles.emptyStateHint}>
                  Your submitted reports will appear here.
                </Text>
              </View>
            )}

            {submittedReports.map((report) => (
              <TouchableOpacity
                key={report.id}
                style={styles.reportCard}
                onPress={() => {
                  Alert.alert(
                    'Report Detail',
                    `Location: ${getSubmittedLocationLabel(report)}\nDamage: ${report.damage_level ?? '—'}\nSubmitted: ${formatTime(report.submitted_at)}`
                  );
                }}
                activeOpacity={0.75}
              >
                <View style={styles.reportCardRow}>
                  <Text style={styles.reportLocation} numberOfLines={1}>
                    {getSubmittedLocationLabel(report)}
                  </Text>
                  <Text style={styles.reportChevron}>›</Text>
                </View>
                <Text style={styles.reportDetail}>
                  Damage: {report.damage_level ?? '—'}
                </Text>
                <Text style={styles.reportDate}>
                  {formatTime(report.submitted_at)}
                </Text>
              </TouchableOpacity>
            ))}

            {nextCursor && (
              <TouchableOpacity
                style={styles.loadMoreBtn}
                onPress={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? <ActivityIndicator color="#0468B1" size="small" />
                  : <Text style={styles.loadMoreText}>Load more</Text>
                }
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={{ height: insets.bottom + 24 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },

  header: {
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', paddingLeft: 8 },
  backBtnText: { fontSize: 22, color: '#0468B1' },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0468B1',
  },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 16 },
  centred: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888888',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 10,
  },

  // Queued report card
  queueCard: {
    backgroundColor: '#FFF8E1',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#FFE082',
  },
  queueCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  queueLocation: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333333',
    flex: 1,
    marginRight: 8,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusBadgePending: { backgroundColor: '#FF9800' },
  statusBadgeFailed: { backgroundColor: '#F44336' },
  statusBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  queueDetail: {
    fontSize: 13,
    color: '#555555',
    marginBottom: 2,
  },
  queueRetryCount: {
    fontSize: 12,
    color: '#D32F2F',
    marginTop: 2,
    fontStyle: 'italic',
  },
  queueActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  retryBtn: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  deleteBtn: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F44336',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#F44336',
    fontSize: 13,
    fontWeight: '600',
  },

  // Anonymous login prompt
  loginPrompt: {
    backgroundColor: '#F0F7FF',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  loginPromptText: {
    fontSize: 15,
    color: '#333333',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 16,
  },
  loginBtn: {
    width: '100%',
    height: 48,
    borderRadius: 24,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  loginBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  createBtn: {
    width: '100%',
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  createBtnText: {
    color: '#0468B1',
    fontSize: 15,
    fontWeight: '600',
  },

  // Submitted report card
  reportCard: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#EEEEEE',
    minHeight: 80,
  },
  reportCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  reportLocation: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333333',
    flex: 1,
  },
  reportChevron: {
    fontSize: 20,
    color: '#CCCCCC',
    marginLeft: 8,
  },
  reportDetail: {
    fontSize: 13,
    color: '#555555',
    marginBottom: 2,
  },
  reportDate: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },

  // Load more
  loadMoreBtn: {
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  loadMoreText: {
    color: '#0468B1',
    fontSize: 14,
    fontWeight: '600',
  },

  // Error
  errorBox: {
    backgroundColor: '#FFF3F3',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    alignItems: 'center',
  },
  errorText: {
    fontSize: 14,
    color: '#D32F2F',
    marginBottom: 10,
    textAlign: 'center',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyStateIcon: { fontSize: 40, marginBottom: 12 },
  emptyStateText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#555555',
    marginBottom: 4,
  },
  emptyStateHint: {
    fontSize: 13,
    color: '#888888',
    textAlign: 'center',
  },
});
