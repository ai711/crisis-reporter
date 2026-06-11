import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl, Dimensions, Animated,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import * as SecureStore from 'expo-secure-store';
import api, { API_BASE } from '../services/api';
import {
  getQueue,
  removeFromQueue,
  resetItemForRetry,
  onQueueChange,
  syncQueue,
  getLocalSubmittedReports,
  type LocalSubmittedRecord,
} from '../utils/offlineQueue';
import type { QueuedReport } from '../types';
import NetInfo from '@react-native-community/netinfo';

// ── Scale ──────────────────────────────────────────────────────────────────────
const { width: _screenWidthRaw } = Dimensions.get('window');
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round((screenWidth / 375) * size);

// ── Types ──────────────────────────────────────────────────────────────────────

interface SubmittedReport {
  id: string;
  damage_level: string | null;
  submitted_at: string | null;
  // Flat fields matching /api/reports/my response (no nested location object)
  gps_latitude: number | null;
  gps_longitude: number | null;
  location_address: string | null;
  location_landmark: string | null;
  building_name: string | null;
  photo_count: number;
  first_photo_url: string | null;
  disaster_type?: string | null;
  infrastructure_type?: string | null;
  infrastructure_name?: string | null;
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
  if (report.building_name) return report.building_name;
  if (report.location_address) return report.location_address;
  if (report.location_landmark) return report.location_landmark;
  if (report.gps_latitude != null) {
    return `${report.gps_latitude.toFixed(4)}, ${(report.gps_longitude ?? 0).toFixed(4)}`;
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

// Damage level key lookup — maps raw values to mobile en.json keys
const DAMAGE_KEY_MAP: Record<string, string> = {
  complete:            'report.complete',
  completely_destroyed:'report.complete',
  partial:             'report.partial',
  partially_damaged:   'report.partial',
  minimal:             'report.minimal',
  minimal_no_damage:   'report.minimal',
};

const getDamagePill = (level: string | null | undefined) => {
  if (!level) return { bg: 'rgba(113,119,130,0.1)', color: '#717782' };
  if (level === 'completely_destroyed' || level === 'complete') return { bg: 'rgba(229,62,62,0.1)', color: '#E53E3E' };
  if (level === 'partially_damaged' || level === 'partial') return { bg: 'rgba(242,153,74,0.1)', color: '#F2994A' };
  return { bg: 'rgba(56,161,105,0.1)', color: '#38A169' };
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function MyReportsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const formatDamageLevel = (level: string | null | undefined): string => {
    if (!level) return '—';
    return t(DAMAGE_KEY_MAP[level] ?? level, { defaultValue: level });
  };

  // undefined = still loading from SecureStore; null = no ID; string = has ID
  const [reporterId, setReporterId] = useState<string | null | undefined>(undefined);
  const [queuedReports, setQueuedReports] = useState<QueuedReport[]>([]);
  const [submittedReports, setSubmittedReports] = useState<SubmittedReport[]>([]);
  const [localSubmittedReports, setLocalSubmittedReports] = useState<LocalSubmittedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const skeletonOpacity = useRef(new Animated.Value(0.4)).current;
  const skeletonAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (loading) {
      skeletonAnimRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(skeletonOpacity, { toValue: 0.8, duration: 800, useNativeDriver: true }),
          Animated.timing(skeletonOpacity, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        ])
      );
      skeletonAnimRef.current.start();
    } else {
      skeletonAnimRef.current?.stop();
    }
    return () => skeletonAnimRef.current?.stop();
  }, [loading, skeletonOpacity]);

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
      } else {
        // Anonymous — load any locally-saved submitted records.
        const local = await getLocalSubmittedReports();
        setLocalSubmittedReports(local);
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
    } else {
      const local = await getLocalSubmittedReports();
      setLocalSubmittedReports(local);
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

  const handleRetry = async (report: QueuedReport) => {
    const netState = await NetInfo.fetch();
    if (!netState.isConnected || !netState.isInternetReachable) {
      Alert.alert(
        'Still offline',
        'Internet is not available yet. Your report is saved and will send when you reconnect.'
      );
      return;
    }
    try {
      await resetItemForRetry(report.local_id);
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

  // ── Loading state — 3 skeleton cards ─────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { height: 56 + insets.top, paddingTop: insets.top }]}>
          <Text style={styles.headerTitle}>My Reports</Text>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {[0, 1, 2].map((i) => (
            <Animated.View key={i} style={[styles.skeletonCard, { opacity: skeletonOpacity }]} />
          ))}
        </ScrollView>

        {/* Bottom navigation — Reports tab is active */}
        <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
          <TouchableOpacity
            style={styles.navItem}
            onPress={() => navigation.navigate('Home')}
          >
            <Text style={styles.navIconInactive}>🏠</Text>
            <Text style={styles.navLabelInactive}>HOME</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navItem}
            onPress={() => navigation.navigate('Map')}
          >
            <Text style={styles.navIconInactive}>🗺</Text>
            <Text style={styles.navLabelInactive}>MAP</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navItem}>
            <View style={styles.activeNavPill}>
              <Text style={styles.navIconActive}>📋</Text>
              <Text style={styles.navLabelActive}>REPORTS</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { height: 56 + insets.top, paddingTop: insets.top }]}>
        <Text style={styles.headerTitle}>My Reports</Text>
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

        {/* ── SECTION 1: ANONYMOUS LOGIN PROMPT ── */}
        {isAnonymousId(reporterId) && (
          <View style={styles.loginPromptCard}>
            <MaterialIcons name="info" color="#0468B1" size={scale(24)} style={styles.loginPromptIcon} />
            <Text style={styles.loginPromptTitle}>Log in to see your full history</Text>
            <Text style={styles.loginPromptSubtitle}>
              Log in or create a free account to view all your reports across devices.
            </Text>
            <View style={styles.loginPromptButtons}>
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
          </View>
        )}

        {/* ── SECTION 2: QUEUED / PENDING REPORTS (all reporter states) ── */}
        {queuedReports.length > 0 && (
          <View>
            <Text style={styles.sectionHeader}>PENDING</Text>
            {queuedReports.map((report) => {
              const failed = isFailed(report);
              const damagePill = getDamagePill(report.report.damage_level);
              const infraType = (report.report as any).infrastructure_type as string | null | undefined;
              return (
                <TouchableOpacity
                  key={report.local_id}
                  style={styles.reportCard}
                  activeOpacity={0.85}
                  onPress={() => navigation.navigate('QueuedReportDetailScreen', { queuedReport: report })}
                  accessibilityRole="button"
                  accessibilityLabel={`Queued report — ${getQueuedLocationLabel(report)}. Tap to view details.`}
                >
                  {/* ROW 1: Status pill + date */}
                  <View style={styles.cardRow1}>
                    <View style={[
                      styles.statusPill,
                      { backgroundColor: failed ? 'rgba(229,62,62,0.12)' : 'rgba(245,166,35,0.12)' },
                    ]}>
                      <Text style={[styles.statusPillText, { color: failed ? '#E53E3E' : '#F5A623' }]}>
                        {failed ? 'Failed' : 'Pending Sync'}
                      </Text>
                    </View>
                    <Text style={styles.cardDate}>{formatTime(report.created_at)}</Text>
                  </View>

                  {/* ROW 2: Location */}
                  <View style={styles.cardRow2}>
                    <MaterialIcons name="location-on" color="#0468B1" size={scale(16)} />
                    <Text style={styles.locationText} numberOfLines={1}>
                      {getQueuedLocationLabel(report)}
                    </Text>
                  </View>

                  {/* ROW 3: Damage pill */}
                  <View style={[styles.damagePill, { backgroundColor: damagePill.bg }]}>
                    <Text style={[styles.damagePillText, { color: damagePill.color }]}>
                      {formatDamageLevel(report.report.damage_level)}
                    </Text>
                  </View>

                  {/* ROW 4: Infrastructure type */}
                  {!!infraType && (
                    <Text style={styles.infraText}>{infraType}</Text>
                  )}

                  {/* Failed attempts note */}
                  {failed && report.retry_count > 0 && (
                    <Text style={styles.retryCountText}>
                      Failed after {report.retry_count} attempt{report.retry_count !== 1 ? 's' : ''}
                    </Text>
                  )}

                  {/* Divider */}
                  <View style={styles.cardDivider} />

                  {/* Action row */}
                  <View style={styles.cardActions}>
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={(e) => { e.stopPropagation?.(); handleRetry(report); }}
                    >
                      <MaterialIcons name="refresh" color="#0468B1" size={scale(15)} />
                      <Text style={styles.retryBtnText}>Retry</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deleteBtn}
                      onPress={(e) => { e.stopPropagation?.(); handleDelete(report); }}
                    >
                      <MaterialIcons name="delete" color="#E53E3E" size={scale(15)} />
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Anonymous: locally-saved submitted report history */}
        {isAnonymousId(reporterId) && localSubmittedReports.length > 0 && (
          <View>
            <Text style={styles.sectionHeader}>SUBMITTED (THIS DEVICE)</Text>
            {localSubmittedReports.map((report) => {
              const damagePill = getDamagePill(report.damage_level);
              const locationLabel =
                report.building_name ||
                report.location_address ||
                report.location_landmark ||
                (report.gps_latitude != null
                  ? `${report.gps_latitude.toFixed(4)}, ${(report.gps_longitude ?? 0).toFixed(4)}`
                  : 'Unknown location');
              return (
                <TouchableOpacity
                  key={report.id}
                  style={styles.reportCard}
                  onPress={() => navigation.navigate('ReportDetailScreen', { reportId: report.id })}
                  activeOpacity={0.75}
                >
                  <View style={styles.cardRow1}>
                    <View style={[styles.statusPill, { backgroundColor: 'rgba(56,161,105,0.12)' }]}>
                      <Text style={[styles.statusPillText, { color: '#38A169' }]}>✓ Submitted</Text>
                    </View>
                    <Text style={styles.cardDate}>{formatTime(report.submitted_at)}</Text>
                  </View>
                  <View style={styles.cardRow2}>
                    <MaterialIcons name="location-on" color="#0468B1" size={scale(16)} />
                    <Text style={styles.locationText} numberOfLines={1}>{locationLabel}</Text>
                    <MaterialIcons name="chevron-right" color="#C1C7D2" size={scale(18)} />
                  </View>
                  <View style={[styles.damagePill, { backgroundColor: damagePill.bg }]}>
                    <Text style={[styles.damagePillText, { color: damagePill.color }]}>
                      {formatDamageLevel(report.damage_level)}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Empty state for anonymous with no queue AND no local history */}
        {isAnonymousId(reporterId) && queuedReports.length === 0 && localSubmittedReports.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialIcons name="assignment" color="#C1C7D2" size={scale(56)} />
            <Text style={styles.emptyTitle}>No reports yet</Text>
            <Text style={styles.emptySubtitle}>Your submitted reports will appear here.</Text>
          </View>
        )}

        {/* ── SECTION 3: SUBMITTED REPORTS (logged-in reporters only) ── */}
        {!isAnonymousId(reporterId) && (
          <View>
            <Text style={styles.sectionHeader}>SUBMITTED</Text>

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity
                  style={styles.tryAgainBtn}
                  onPress={() => {
                    setError(null);
                    loadSubmitted();
                  }}
                >
                  <Text style={styles.tryAgainBtnText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            )}

            {!error && submittedReports.length === 0 && (
              <View style={styles.emptyState}>
                <MaterialIcons name="assignment" color="#C1C7D2" size={scale(56)} />
                <Text style={styles.emptyTitle}>No reports yet</Text>
                <Text style={styles.emptySubtitle}>Your submitted reports will appear here.</Text>
              </View>
            )}

            {submittedReports.map((report) => {
              const damagePill = getDamagePill(report.damage_level);
              return (
                <TouchableOpacity
                  key={report.id}
                  style={styles.reportCard}
                  onPress={() => navigation.navigate('ReportDetailScreen', { reportId: report.id })}
                  activeOpacity={0.75}
                >
                  {/* ROW 1: Status pill + date */}
                  <View style={styles.cardRow1}>
                    <View style={[styles.statusPill, { backgroundColor: 'rgba(56,161,105,0.12)' }]}>
                      <Text style={[styles.statusPillText, { color: '#38A169' }]}>
                        ✓ Submitted
                      </Text>
                    </View>
                    <Text style={styles.cardDate}>{formatTime(report.submitted_at)}</Text>
                  </View>

                  {/* ROW 2: Location + tappability chevron */}
                  <View style={styles.cardRow2}>
                    <MaterialIcons name="location-on" color="#0468B1" size={scale(16)} />
                    <Text style={styles.locationText} numberOfLines={1}>
                      {getSubmittedLocationLabel(report)}
                    </Text>
                    <MaterialIcons name="chevron-right" color="#C1C7D2" size={scale(18)} />
                  </View>

                  {/* ROW 3: Damage pill */}
                  <View style={[styles.damagePill, { backgroundColor: damagePill.bg }]}>
                    <Text style={[styles.damagePillText, { color: damagePill.color }]}>
                      {formatDamageLevel(report.damage_level)}
                    </Text>
                  </View>

                  {/* ROW 4: Disaster type + infrastructure */}
                  {(report.disaster_type || report.infrastructure_name || report.infrastructure_type) && (
                    <Text style={styles.submittedMetaText} numberOfLines={1}>
                      {[
                        report.disaster_type ? `⚡ ${report.disaster_type}` : null,
                        (report.infrastructure_name || report.infrastructure_type)
                          ? `🏗 ${report.infrastructure_name || report.infrastructure_type}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join('  ·  ')}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}

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

        <View style={{ height: 60 + insets.bottom + 24 }} />
      </ScrollView>

      {/* Bottom navigation — Reports tab is active */}
      <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate('Home')}
        >
          <Text style={styles.navIconInactive}>🏠</Text>
          <Text style={styles.navLabelInactive}>HOME</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate('Map')}
        >
          <Text style={styles.navIconInactive}>🗺</Text>
          <Text style={styles.navLabelInactive}>MAP</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem}>
          <View style={styles.activeNavPill}>
            <Text style={styles.navIconActive}>📋</Text>
            <Text style={styles.navLabelActive}>REPORTS</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F3F2' },

  header: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(193,199,210,0.3)',
  },
  headerTitle: {
    fontSize: scale(17),
    fontWeight: '600',
    color: '#1B1C1C',
  },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: screenWidth * 0.04,
    paddingTop: 16,
  },

  // ── Skeleton ────────────────────────────────────────────────────────────────
  skeletonCard: {
    height: 100,
    borderRadius: 16,
    backgroundColor: '#F0EDED',
    marginBottom: 12,
  },

  // ── Section header ──────────────────────────────────────────────────────────
  sectionHeader: {
    fontSize: scale(11),
    fontWeight: '700',
    color: '#717782',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 20,
  },

  // ── Anonymous login prompt card ─────────────────────────────────────────────
  loginPromptCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: screenWidth * 0.06,
    marginTop: 20,
    marginBottom: 4,
    alignItems: 'center',
  },
  loginPromptIcon: {
    marginBottom: 12,
  },
  loginPromptTitle: {
    fontSize: scale(16),
    fontWeight: '700',
    color: '#1B1C1C',
    textAlign: 'center',
  },
  loginPromptSubtitle: {
    fontSize: scale(14),
    color: '#717782',
    textAlign: 'center',
    marginTop: 6,
    lineHeight: scale(20),
  },
  loginPromptButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  loginBtn: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  loginBtnText: {
    color: '#FFFFFF',
    fontSize: scale(14),
    fontWeight: '600',
  },
  createBtn: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  createBtnText: {
    color: '#0468B1',
    fontSize: scale(14),
    fontWeight: '600',
  },

  // ── Report card (shared between queued and submitted) ───────────────────────
  reportCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    elevation: 1,
    shadowColor: '#000000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },

  // Card ROW 1: status pill + date
  cardRow1: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  statusPill: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusPillText: {
    fontSize: scale(11),
    fontWeight: '700',
  },
  cardDate: {
    fontSize: scale(11),
    color: '#9CA3AF',
    fontWeight: '400',
  },

  // Card ROW 2: icon + location + optional chevron
  cardRow2: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  locationText: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#1B1C1C',
    flex: 1,
    marginLeft: 6,
  },

  // Card ROW 3: damage classification pill
  damagePill: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 4,
  },
  damagePillText: {
    fontSize: scale(12),
    fontWeight: '600',
  },

  // Card ROW 4: infrastructure type (queued cards)
  infraText: {
    fontSize: scale(13),
    color: '#717782',
    marginTop: 4,
  },

  // Submitted card meta row (disaster type + infrastructure)
  submittedMetaText: {
    fontSize: scale(12),
    color: '#717782',
    marginTop: 6,
  },

  // Failed attempts note
  retryCountText: {
    fontSize: scale(11),
    color: '#E53E3E',
    marginTop: 4,
    fontStyle: 'italic',
  },

  // Divider (queued cards only, between content and actions)
  cardDivider: {
    height: 1,
    backgroundColor: '#F6F3F2',
    marginVertical: 12,
  },

  // Action row (queued cards only)
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(4,104,177,0.08)',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
    minWidth: 44,
    minHeight: 44,
  },
  retryBtnText: {
    color: '#0468B1',
    fontSize: scale(13),
    fontWeight: '600',
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(229,62,62,0.08)',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
    minWidth: 44,
    minHeight: 44,
  },
  deleteBtnText: {
    color: '#E53E3E',
    fontSize: scale(13),
    fontWeight: '600',
  },

  // ── Empty state ─────────────────────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: scale(18),
    fontWeight: '700',
    color: '#1B1C1C',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: scale(14),
    color: '#717782',
    textAlign: 'center',
    marginTop: 8,
    maxWidth: screenWidth * 0.6,
  },

  // ── Load more ───────────────────────────────────────────────────────────────
  loadMoreBtn: {
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    minHeight: 44,
  },
  loadMoreText: {
    color: '#0468B1',
    fontSize: scale(14),
    fontWeight: '600',
  },

  // ── Error ────────────────────────────────────────────────────────────────────
  errorBox: {
    backgroundColor: 'rgba(229,62,62,0.08)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    alignItems: 'center',
  },
  errorText: {
    fontSize: scale(14),
    color: '#E53E3E',
    marginBottom: 12,
    textAlign: 'center',
  },
  tryAgainBtn: {
    height: 44,
    paddingHorizontal: 24,
    borderRadius: 22,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  tryAgainBtnText: {
    color: '#FFFFFF',
    fontSize: scale(13),
    fontWeight: '600',
  },

  // ── Bottom navigation ────────────────────────────────────────────────────
  bottomNav: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 8,
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
    minHeight: 44,
  },
  activeNavPill: {
    backgroundColor: 'rgba(4,104,177,0.1)',
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 2,
  },
  navIconActive: {
    fontSize: scale(24),
    color: '#0468B1',
  },
  navLabelActive: {
    fontSize: scale(10),
    fontWeight: '600',
    color: '#0468B1',
    letterSpacing: 1.2,
  },
  navIconInactive: {
    fontSize: scale(24),
    color: '#717782',
  },
  navLabelInactive: {
    fontSize: scale(10),
    fontWeight: '500',
    color: '#717782',
    letterSpacing: 1.2,
    marginTop: 2,
  },
});
