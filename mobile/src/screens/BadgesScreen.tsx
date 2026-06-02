import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round((screenWidth / 375) * size);

// All disaster keys used in mobile SafetyTipsScreen
const MOBILE_DISASTER_KEYS = [
  'earthquake',
  'flood',
  'tsunami',
  'hurricane_cyclone',
  'wildfire',
  'explosion',
  'chemical_incident',
  'conflict',
  'civil_unrest',
] as const;

function formatDisplayId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
  if (clean.length < 4) return clean;
  return clean.slice(0, 3) + '-' + clean.slice(3);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

type LoadState = 'loading' | 'ready';

export default function BadgesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isLocked, setIsLocked] = useState(false);
  const [reporterId, setReporterId] = useState<string | null>(null);
  const [reporterName, setReporterName] = useState('Reporter');
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [earnedDate, setEarnedDate] = useState(formatDate(new Date()));

  // Local progress counts for locked state
  const [completedPartA, setCompletedPartA] = useState(0);
  const [partBDone, setPartBDone] = useState(false);

  useEffect(() => {
    const load = async () => {
      // Check anonymous status
      const storedId = await SecureStore.getItemAsync('cr_reporter_id');
      const anonymous = !storedId || storedId.startsWith('CR-PENDING-');

      // Load local progress (shown even when locked)
      const progressAStr = await AsyncStorage.getItem('cr_tips_progress_a');
      const progressA: Record<string, boolean> = progressAStr
        ? JSON.parse(progressAStr)
        : {};
      const localCompletedA = MOBILE_DISASTER_KEYS.filter(k => progressA[k] === true).length;
      const localPartB = (await AsyncStorage.getItem('cr_tips_progress_b')) === 'true';
      setCompletedPartA(localCompletedA);
      setPartBDone(localPartB);

      if (anonymous || !storedId) {
        setIsLocked(true);
        setLoadState('ready');
        return;
      }

      setReporterId(storedId);

      try {
        const [profileRes, progressRes] = await Promise.all([
          api.get<{
            email: string | null;
            phone_number: string | null;
            first_name: string | null;
            last_name: string | null;
            created_at?: string;
          }>(`/api/reporters/${storedId}`),
          api.get<{ parts_completed: string[] }>(
            `/api/reporters/${storedId}/safety-progress`
          ),
        ]);

        const { email, phone_number, first_name, last_name, created_at } =
          profileRes.data;
        const hasContact = !!(email?.trim() || phone_number?.trim());

        if (!hasContact) {
          setIsLocked(true);
          setLoadState('ready');
          return;
        }

        const name = [first_name, last_name].filter(Boolean).join(' ').trim();
        setReporterName(name || 'Reporter');

        if (created_at) setEarnedDate(formatDate(new Date(created_at)));

        const { parts_completed } = progressRes.data;
        const partAComplete = Array.isArray(parts_completed) &&
          MOBILE_DISASTER_KEYS.every(k => parts_completed.includes(`A_${k}`));
        const allComplete =
          partAComplete &&
          parts_completed.includes('B') &&
          parts_completed.includes('C');
        setTrainingComplete(allComplete);
      } catch {
        // Fallback: check local storage
        const allLocalA = MOBILE_DISASTER_KEYS.every(k => progressA[k] === true);
        const localPartC = (await AsyncStorage.getItem('cr_tips_progress_c')) === 'true';
        setTrainingComplete(allLocalA && localPartB && localPartC);
      }

      setLoadState('ready');
    };

    load();
  }, []);

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loadState === 'loading') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Badges &amp; Certifications</Text>
          <View style={styles.backBtn} />
        </View>
        <ActivityIndicator color="#0468B1" style={{ marginTop: 40 }} />
      </View>
    );
  }

  // ── Locked state (anonymous or no contact info) ────────────────────────────

  if (isLocked) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Badges &amp; Certifications</Text>
          <View style={styles.backBtn} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32 }}
        >
          {/* Locked banner */}
          <View style={styles.lockedBanner}>
            <MaterialIcons name="lock" size={scale(24)} color="#6C4500" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.lockedBannerTitle}>Badges are locked</Text>
              <Text style={styles.lockedBannerBody}>
                Add your email or phone number to your profile to unlock badges and certifications
              </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('ReporterProfileScreen')}
                style={styles.lockedBannerLink}
              >
                <Text style={styles.lockedBannerLinkText}>Go to Profile</Text>
                <MaterialIcons name="arrow-forward" size={scale(14)} color="#0468B1" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Section label */}
          <Text style={styles.sectionLabel}>Available Badges</Text>

          {/* Safety Training Badge (locked) */}
          <View style={styles.lockedBadgeCard}>
            <View style={styles.lockedBadgeRow}>
              <View style={styles.lockedIconWrapper}>
                <View style={styles.lockedIconCircle}>
                  <MaterialIcons name="verified-user" size={scale(32)} color="#9CA3AF" />
                </View>
                <View style={styles.lockOverlay}>
                  <MaterialIcons name="lock" size={scale(12)} color="#9CA3AF" />
                </View>
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.lockedBadgeName}>Safety Training Badge</Text>
                <Text style={styles.lockedBadgeDesc}>
                  Complete both Part A and Part B of Safety Tips to earn this badge
                </Text>
              </View>
            </View>

            {/* Progress */}
            <Text style={styles.progressLabel}>
              Part A: {completedPartA}/9 completed · Part B:{' '}
              {partBDone ? 'Completed' : 'Not started'}
            </Text>
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${((completedPartA + (partBDone ? 1 : 0)) / 10) * 100}%` as any,
                    backgroundColor: '#C1C7D2',
                  },
                ]}
              />
            </View>

            <TouchableOpacity
              style={styles.outlineBtn}
              onPress={() => navigation.navigate('SafetyTipsScreen')}
            >
              <Text style={styles.outlineBtnText}>Continue Safety Tips</Text>
              <MaterialIcons name="arrow-forward" size={scale(16)} color="#0468B1" />
            </TouchableOpacity>
          </View>

          {/* Referral Badge (coming soon) */}
          <View style={[styles.lockedBadgeCard, { opacity: 0.75 }]}>
            <View style={styles.lockedBadgeRow}>
              <View style={styles.lockedIconWrapper}>
                <View style={styles.lockedIconCircle}>
                  <MaterialIcons name="group" size={scale(32)} color="#9CA3AF" />
                </View>
                <View style={styles.lockOverlay}>
                  <MaterialIcons name="lock" size={scale(12)} color="#9CA3AF" />
                </View>
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.lockedBadgeName}>Referral Badge</Text>
                <Text style={styles.lockedBadgeDesc}>
                  Refer a friend who installs the app and completes safety training
                </Text>
                <View style={styles.comingSoonChip}>
                  <Text style={styles.comingSoonText}>
                    Status: Coming soon — referral program launching later
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Bottom note */}
          <Text style={styles.bottomNote}>
            Badges are only visible inside the app at this stage. Shareable certificates coming soon.
          </Text>
        </ScrollView>
      </View>
    );
  }

  // ── Full badges page (logged in with contact) ──────────────────────────────

  const displayId = reporterId ? formatDisplayId(reporterId) : '---';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Badges &amp; Certifications</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32 }}
      >
        {/* Profile summary row */}
        <View style={styles.profileRow}>
          <View style={styles.profileAvatarCircle}>
            <MaterialIcons name="person" size={scale(28)} color="#0468B1" />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.profileName}>{reporterName}</Text>
            <Text style={styles.profileId}>User ID: {displayId}</Text>
          </View>
          <View style={styles.activeChip}>
            <View style={styles.activeDot} />
            <Text style={styles.activeChipText}>Profile Active</Text>
          </View>
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Section label */}
        <Text style={styles.sectionLabel}>Your Badges</Text>

        {/* Safety Training Badge */}
        {trainingComplete ? (
          // EARNED
          <View style={styles.earnedCard}>
            <View style={styles.earnedTopBar} />
            <View style={styles.earnedCardBody}>
              <View style={styles.earnedCardHeader}>
                {/* Shield icon */}
                <View style={styles.earnedIconContainer}>
                  <MaterialIcons name="shield" size={scale(44)} color="#0468B1" />
                  <MaterialIcons
                    name="auto-awesome"
                    size={scale(18)}
                    color="#FFD700"
                    style={styles.sparkleIcon}
                  />
                </View>
                {/* EARNED chip */}
                <View style={styles.earnedChip}>
                  <Text style={styles.earnedChipText}>EARNED ✓</Text>
                </View>
              </View>

              <Text style={styles.earnedBadgeName}>Safety Training Badge</Text>
              <Text style={styles.earnedBadgeDesc}>
                You completed both Part A and Part B of the Crisis Response Safety
                Protocol. This certification validates your field readiness.
              </Text>

              <View style={styles.earnedFooter}>
                <View>
                  <Text style={styles.earnedDateLabel}>EARNED ON</Text>
                  <Text style={styles.earnedDateValue}>{earnedDate}</Text>
                </View>
                <TouchableOpacity style={styles.shareBtn} disabled>
                  <MaterialIcons name="share" size={scale(14)} color="#717782" />
                  <Text style={styles.shareBtnText}>Share Badge</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ) : (
          // LOCKED / IN PROGRESS
          <View style={styles.lockedBadgeCard}>
            <View style={styles.lockedBadgeRow}>
              <View style={styles.lockedIconWrapper}>
                <View style={styles.lockedIconCircle}>
                  <MaterialIcons name="verified-user" size={scale(32)} color="#9CA3AF" />
                </View>
                <View style={styles.lockOverlay}>
                  <MaterialIcons name="lock" size={scale(12)} color="#9CA3AF" />
                </View>
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.lockedBadgeName}>Safety Training Badge</Text>
                <Text style={styles.lockedBadgeDesc}>
                  Complete both Part A and Part B of Safety Tips to earn this badge
                </Text>
              </View>
            </View>
            <Text style={styles.progressLabel}>
              Part A: {completedPartA}/9 completed · Part B:{' '}
              {partBDone ? 'Completed' : 'Not started'}
            </Text>
            <View style={styles.progressBarBg}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${((completedPartA + (partBDone ? 1 : 0)) / 10) * 100}%` as any,
                    backgroundColor: '#C1C7D2',
                  },
                ]}
              />
            </View>
            <TouchableOpacity
              style={styles.outlineBtn}
              onPress={() => navigation.navigate('SafetyTipsScreen')}
            >
              <Text style={styles.outlineBtnText}>Continue Safety Tips</Text>
              <MaterialIcons name="arrow-forward" size={scale(16)} color="#0468B1" />
            </TouchableOpacity>
          </View>
        )}

        {/* Referral Badge */}
        <View style={styles.referralCard}>
          <View style={styles.referralIconBox}>
            <MaterialIcons name="share" size={scale(28)} color="#717782" />
          </View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <View style={styles.referralTitleRow}>
              <Text style={styles.referralName}>Referral Badge</Text>
              <Text style={styles.lockedLabel}>LOCKED</Text>
            </View>
            <Text style={styles.referralCount}>0 successful referrals</Text>
            <TouchableOpacity style={styles.referralBtn}>
              <Text style={styles.referralBtnText}>Refer a Friend</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Bottom info note */}
        <View style={styles.infoNote}>
          <MaterialIcons name="info-outline" size={scale(14)} color="#717782" style={{ marginTop: 1 }} />
          <Text style={styles.infoNoteText}>
            Badges are only visible inside the app and linked to your verified ID. Sharing
            capabilities are currently restricted for security compliance.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F3F2' },
  scroll: { flex: 1 },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 56,
    backgroundColor: '#F6F3F2',
    borderBottomWidth: 1,
    borderBottomColor: '#E4E2E1',
  },
  backBtn: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  headerTitle: {
    fontSize: scale(17),
    fontWeight: '600',
    color: '#1B1C1C',
  },

  // ── Locked banner ────────────────────────────────────────────────────────────
  lockedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFDDB4',
    borderRadius: 16,
    padding: 18,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(108,69,0,0.12)',
  },
  lockedBannerTitle: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#291800',
    marginBottom: 4,
  },
  lockedBannerBody: {
    fontSize: scale(13),
    color: '#6C4500',
    lineHeight: scale(13) * 1.5,
    marginBottom: 10,
  },
  lockedBannerLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  lockedBannerLinkText: {
    fontSize: scale(13),
    fontWeight: '700',
    color: '#0468B1',
    marginRight: 4,
  },

  // ── Section label ────────────────────────────────────────────────────────────
  sectionLabel: {
    fontSize: scale(10),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 14,
  },

  // ── Locked badge card ────────────────────────────────────────────────────────
  lockedBadgeCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  lockedBadgeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  lockedIconWrapper: { position: 'relative' },
  lockedIconCircle: {
    width: scale(60),
    height: scale(60),
    borderRadius: scale(30),
    backgroundColor: '#F0EDED',
    justifyContent: 'center',
    alignItems: 'center',
    opacity: 0.6,
  },
  lockOverlay: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: '#FFFFFF',
    padding: 3,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: '#F0EDED',
  },
  lockedBadgeName: {
    fontSize: scale(16),
    fontWeight: '700',
    color: '#717782',
    marginBottom: 4,
  },
  lockedBadgeDesc: {
    fontSize: scale(13),
    color: '#9CA3AF',
    lineHeight: scale(13) * 1.5,
  },
  progressLabel: {
    fontSize: scale(12),
    fontWeight: '500',
    color: '#717782',
    marginBottom: 8,
  },
  progressBarBg: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F0EDED',
    marginBottom: 14,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0468B1',
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#0468B1',
    gap: 6,
  },
  outlineBtnText: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#0468B1',
  },
  comingSoonChip: {
    backgroundColor: '#F0EDED',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 10,
  },
  comingSoonText: {
    fontSize: scale(11),
    fontWeight: '500',
    color: '#717782',
  },

  // ── Bottom note ──────────────────────────────────────────────────────────────
  bottomNote: {
    fontSize: scale(12),
    color: '#717782',
    textAlign: 'center',
    lineHeight: scale(12) * 1.6,
    marginTop: 8,
    paddingHorizontal: 16,
  },

  // ── Profile row ──────────────────────────────────────────────────────────────
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  profileAvatarCircle: {
    width: scale(48),
    height: scale(48),
    borderRadius: scale(24),
    backgroundColor: '#E4E2E1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileName: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#1B1C1C',
    marginBottom: 2,
  },
  profileId: {
    fontSize: scale(12),
    color: '#717782',
  },
  activeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,109,55,0.1)',
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#38A169',
  },
  activeChipText: {
    fontSize: scale(12),
    fontWeight: '700',
    color: '#006D37',
  },
  divider: {
    height: 1,
    backgroundColor: '#E4E2E1',
    marginBottom: 20,
  },

  // ── Earned badge card ────────────────────────────────────────────────────────
  earnedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  earnedTopBar: {
    height: 8,
    backgroundColor: '#0468B1',
  },
  earnedCardBody: {
    padding: 20,
    backgroundColor: 'rgba(4,104,177,0.02)',
  },
  earnedCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  earnedIconContainer: {
    width: scale(72),
    height: scale(72),
    borderRadius: 16,
    backgroundColor: '#D2E4FF',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  sparkleIcon: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  earnedChip: {
    backgroundColor: '#38A169',
    borderRadius: 99,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  earnedChipText: {
    fontSize: scale(11),
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  earnedBadgeName: {
    fontSize: scale(18),
    fontWeight: '800',
    color: '#1B1C1C',
    marginBottom: 8,
  },
  earnedBadgeDesc: {
    fontSize: scale(13),
    color: '#414751',
    lineHeight: scale(13) * 1.6,
    marginBottom: 20,
  },
  earnedFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  earnedDateLabel: {
    fontSize: scale(10),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  earnedDateValue: {
    fontSize: scale(14),
    fontWeight: '600',
    color: '#1B1C1C',
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: '#C1C7D2',
    opacity: 0.6,
  },
  shareBtnText: {
    fontSize: scale(13),
    fontWeight: '600',
    color: '#717782',
  },

  // ── Referral badge card ──────────────────────────────────────────────────────
  referralCard: {
    backgroundColor: '#F0EDED',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  referralIconBox: {
    width: scale(52),
    height: scale(52),
    borderRadius: 14,
    backgroundColor: '#E4E2E1',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  referralTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  referralName: {
    fontSize: scale(15),
    fontWeight: '700',
    color: '#1B1C1C',
  },
  lockedLabel: {
    fontSize: scale(11),
    fontWeight: '700',
    color: '#C1C7D2',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  referralCount: {
    fontSize: scale(13),
    color: '#717782',
    marginBottom: 14,
  },
  referralBtn: {
    height: 42,
    borderRadius: 99,
    borderWidth: 2,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  referralBtnText: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#0468B1',
  },

  // ── Info note ────────────────────────────────────────────────────────────────
  infoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#EAE7E7',
    borderRadius: 12,
    padding: 12,
  },
  infoNoteText: {
    flex: 1,
    fontSize: scale(11),
    color: '#717782',
    lineHeight: scale(11) * 1.6,
  },
});
