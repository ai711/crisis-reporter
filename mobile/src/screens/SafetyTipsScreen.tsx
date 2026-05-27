import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Dimensions,
  BackHandler,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round((screenWidth / 375) * size);

type ViewState =
  | { screen: 'overview' }
  | { screen: 'part_a_list' }
  | { screen: 'disaster_slides'; disasterType: string }
  | { screen: 'part_b_slides' }
  | { screen: 'part_c_slides' };

type LoadState = 'loading' | 'loaded' | 'offline';

interface Slide {
  title: string;
  dos?: string[];
  donts?: string[];
  bullets?: string[];
}

const DISASTER_TYPES: Array<{ key: string; label: string; icon: string }> = [
  { key: 'earthquake', label: 'Earthquake', icon: 'volcano' },
  { key: 'flood', label: 'Flood', icon: 'water_drop' },
  { key: 'tsunami', label: 'Tsunami', icon: 'tsunami' },
  { key: 'hurricane_cyclone', label: 'Hurricane or Cyclone', icon: 'cyclone' },
  { key: 'wildfire', label: 'Wildfire', icon: 'local_fire_department' },
  { key: 'explosion', label: 'Explosion', icon: 'explosion' },
  { key: 'chemical_incident', label: 'Chemical Incident', icon: 'science' },
  { key: 'conflict', label: 'Conflict', icon: 'military_tech' },
  { key: 'civil_unrest', label: 'Civil Unrest', icon: 'groups_2' },
];

async function fetchContent(
  cacheKey: string,
  versionKey: string,
  apiUrl: string,
  setSlides: (s: Slide[]) => void,
  setLoadState: (s: LoadState) => void,
): Promise<void> {
  const cachedVersion = await AsyncStorage.getItem(versionKey);
  const cached = await AsyncStorage.getItem(cacheKey);

  if (cached) {
    setSlides(JSON.parse(cached));
    setLoadState('loaded');
  } else {
    setLoadState('loading');
  }

  try {
    const response = await api.get(apiUrl);
    const data = response.data;
    const freshVersion = String(data.version || '1');
    const freshSlides: Slide[] = data.slides || [];

    if (freshVersion !== cachedVersion || !cached) {
      await AsyncStorage.setItem(cacheKey, JSON.stringify(freshSlides));
      await AsyncStorage.setItem(versionKey, freshVersion);
      setSlides(freshSlides);
    }
    setLoadState('loaded');
  } catch {
    if (!cached) setLoadState('offline');
  }
}

export default function SafetyTipsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();

  const [viewState, setViewState] = useState<ViewState>({ screen: 'overview' });
  const [progressA, setProgressA] = useState<Record<string, boolean>>({});
  const [progressB, setProgressB] = useState(false);
  const [progressC, setProgressC] = useState(false);

  const [currentSlide, setCurrentSlide] = useState(0);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const skeletonAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(skeletonAnim, { toValue: 0.8, duration: 700, useNativeDriver: true }),
        Animated.timing(skeletonAnim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [skeletonAnim]);

  useEffect(() => {
    AsyncStorage.getItem('cr_tips_progress_a').then(v => {
      if (v) setProgressA(JSON.parse(v));
    });
    AsyncStorage.getItem('cr_tips_progress_b').then(v => setProgressB(v === 'true'));
    AsyncStorage.getItem('cr_tips_progress_c').then(v => setProgressC(v === 'true'));
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (viewState.screen === 'disaster_slides') {
        setViewState({ screen: 'part_a_list' });
        return true;
      }
      if (
        viewState.screen === 'part_a_list' ||
        viewState.screen === 'part_b_slides' ||
        viewState.screen === 'part_c_slides'
      ) {
        setViewState({ screen: 'overview' });
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [viewState]);

  useEffect(() => {
    setCurrentSlide(0);
    setSlides([]);

    if (viewState.screen === 'disaster_slides') {
      const key = viewState.disasterType;
      setLoadState('loading');
      fetchContent(
        `cr_tips_a_${key}`,
        `cr_tips_v_a_${key}`,
        `/api/content/safety-tips/${key}`,
        setSlides,
        setLoadState,
      );
    } else if (viewState.screen === 'part_b_slides') {
      setLoadState('loading');
      fetchContent(
        'cr_tips_b',
        'cr_tips_v_b',
        '/api/content/reporting-guidelines',
        setSlides,
        setLoadState,
      );
    } else if (viewState.screen === 'part_c_slides') {
      setLoadState('loading');
      fetchContent(
        'cr_tips_c',
        'cr_tips_v_c',
        '/api/content/first-aid',
        setSlides,
        setLoadState,
      );
    }
  }, [viewState]);

  const syncProgress = useCallback(
    async (pA: Record<string, boolean>, pB: boolean, pC: boolean) => {
      const reporterId = useAuthStore.getState().reporterId;
      if (!reporterId) return;
      try {
        await api.post(`/api/reporters/${reporterId}/safety-progress`, {
          part_a_complete: Object.values(pA).filter(Boolean).length === 9,
          part_a_count: Object.values(pA).filter(Boolean).length,
          part_b_complete: pB,
          part_c_complete: pC,
        });
      } catch (e) {
        console.warn('Progress sync failed', e);
      }
    },
    [],
  );

  const checkBadge = useCallback(
    (pA: Record<string, boolean>, pB: boolean, pC: boolean) => {
      const allComplete = Object.values(pA).filter(Boolean).length === 9 && pB && pC;
      if (allComplete) {
        Alert.alert(
          'Safety Training Complete! 🎉',
          'You have completed all three parts. Check your Badges to see your Safety Training Badge.',
          [
            { text: 'View Badges', onPress: () => navigation.navigate('BadgesScreen') },
            { text: 'Done' },
          ],
        );
      }
    },
    [navigation],
  );

  const handleDisasterComplete = useCallback(
    async (disasterType: string) => {
      const newProgressA = { ...progressA, [disasterType]: true };
      setProgressA(newProgressA);
      await AsyncStorage.setItem('cr_tips_progress_a', JSON.stringify(newProgressA));
      await AsyncStorage.setItem('cr_safety_a_complete', 'true');
      syncProgress(newProgressA, progressB, progressC);
      checkBadge(newProgressA, progressB, progressC);
      setViewState({ screen: 'part_a_list' });
    },
    [progressA, progressB, progressC, syncProgress, checkBadge],
  );

  const handlePartBComplete = useCallback(async () => {
    setProgressB(true);
    await AsyncStorage.setItem('cr_tips_progress_b', 'true');
    await AsyncStorage.setItem('cr_safety_b_complete', 'true');
    syncProgress(progressA, true, progressC);
    checkBadge(progressA, true, progressC);
    setViewState({ screen: 'overview' });
  }, [progressA, progressC, syncProgress, checkBadge]);

  const handlePartCComplete = useCallback(async () => {
    setProgressC(true);
    await AsyncStorage.setItem('cr_tips_progress_c', 'true');
    await AsyncStorage.setItem('cr_safety_c_complete', 'true');
    syncProgress(progressA, progressB, true);
    checkBadge(progressA, progressB, true);
    setViewState({ screen: 'overview' });
  }, [progressA, progressB, syncProgress, checkBadge]);

  const completedA = Object.values(progressA).filter(Boolean).length;

  // ── Overview ─────────────────────────────────────────────────────────────────
  if (viewState.screen === 'overview') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBack}>
            <MaterialIcons name="arrow-back" size={scale(22)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Safety Tips</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <Text style={styles.overviewIntro}>
            Learn how to stay safe and report effectively. Complete all three parts to earn your Safety
            Training badge.
          </Text>

          {/* Part A */}
          <View style={styles.partCard}>
            <View style={styles.cardRow}>
              <View style={[styles.iconContainer, { backgroundColor: 'rgba(4,104,177,0.1)' }]}>
                <MaterialIcons name="shield" size={scale(22)} color="#0468B1" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.cardTitle}>Part A — Safety Tips by Disaster Type</Text>
                <Text style={styles.cardSubtitle}>{completedA} of 9 completed</Text>
              </View>
            </View>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${(completedA / 9) * 100}%` as any }]} />
            </View>
            <TouchableOpacity
              style={[styles.cardBtn, completedA === 9 ? styles.cardBtnComplete : styles.cardBtnPrimary]}
              onPress={() => setViewState({ screen: 'part_a_list' })}
            >
              <Text style={[styles.cardBtnText, completedA === 9 && styles.cardBtnCompleteText]}>
                {completedA === 9 ? '✓ Completed' : 'Continue →'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Part B */}
          <View style={styles.partCard}>
            <View style={styles.cardRow}>
              <View style={[styles.iconContainer, { backgroundColor: 'rgba(4,104,177,0.1)' }]}>
                <MaterialIcons name="description" size={scale(22)} color="#0468B1" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.cardTitle}>Part B — Reporting Guidelines</Text>
                <Text style={[styles.cardStatus, { color: progressB ? '#38A169' : '#F5A623' }]}>
                  {progressB ? 'Completed' : 'Not started'}
                </Text>
              </View>
            </View>
            <Text style={styles.cardDesc}>
              Simple do's and don'ts for submitting a report safely
            </Text>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: progressB ? '100%' : '0%' }]} />
            </View>
            <TouchableOpacity
              style={[styles.cardBtn, progressB ? styles.cardBtnComplete : styles.cardBtnPrimary]}
              onPress={() => setViewState({ screen: 'part_b_slides' })}
            >
              <Text style={[styles.cardBtnText, progressB && styles.cardBtnCompleteText]}>
                {progressB ? '✓ Completed' : 'Continue →'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Part C */}
          <View style={styles.partCard}>
            <View style={styles.cardRow}>
              <View style={[styles.iconContainer, { backgroundColor: 'rgba(4,104,177,0.1)' }]}>
                <MaterialIcons name="medical-services" size={scale(22)} color="#0468B1" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.cardTitle}>Part C — First Aid Tips</Text>
                <Text style={[styles.cardStatus, { color: progressC ? '#38A169' : '#F5A623' }]}>
                  {progressC ? 'Completed' : 'Not started'}
                </Text>
              </View>
            </View>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: progressC ? '100%' : '0%' }]} />
            </View>
            <TouchableOpacity
              style={[styles.cardBtn, progressC ? styles.cardBtnComplete : styles.cardBtnPrimary]}
              onPress={() => setViewState({ screen: 'part_c_slides' })}
            >
              <Text style={[styles.cardBtnText, progressC && styles.cardBtnCompleteText]}>
                {progressC ? '✓ Completed' : 'Continue →'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Badge teaser */}
          <View style={styles.badgeTeaser}>
            <MaterialIcons name="star" size={scale(20)} color="#0468B1" />
            <Text style={styles.badgeTeaserText}>
              Complete all three parts to unlock your Safety Training Badge
            </Text>
            <TouchableOpacity onPress={() => navigation.navigate('BadgesScreen')}>
              <Text style={styles.badgeTeaserLink}>View Badges →</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Part A disaster list ─────────────────────────────────────────────────────
  if (viewState.screen === 'part_a_list') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => setViewState({ screen: 'overview' })}
            style={styles.headerBack}
          >
            <MaterialIcons name="arrow-back" size={scale(22)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Part A — Safety Tips</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={{ marginHorizontal: screenWidth * 0.05, marginTop: 16, marginBottom: 8 }}>
          <View style={styles.progressBarBg}>
            <View style={[styles.progressBarFill, { width: `${(completedA / 9) * 100}%` as any }]} />
          </View>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <Text style={styles.listLabel}>TAP A DISASTER TYPE TO READ THE SAFETY TIPS</Text>

          {DISASTER_TYPES.map(dt => (
            <TouchableOpacity
              key={dt.key}
              style={styles.disasterRow}
              onPress={() => setViewState({ screen: 'disaster_slides', disasterType: dt.key })}
            >
              <View style={styles.disasterIconContainer}>
                <MaterialIcons name={dt.icon as any} size={scale(22)} color="#0468B1" />
              </View>
              <Text style={styles.disasterLabel}>{dt.label}</Text>
              {progressA[dt.key] ? (
                <MaterialIcons name="check-circle" size={scale(22)} color="#38A169" />
              ) : (
                <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
              )}
            </TouchableOpacity>
          ))}

          <View style={styles.offlineInfoCard}>
            <MaterialIcons name="cloud-done" size={scale(22)} color="#0468B1" />
            <Text style={styles.offlineInfoText}>Content works offline once loaded</Text>
            <Text style={styles.offlineInfoSubText}>Available in all supported languages</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Slide viewer (disaster_slides | part_b_slides | part_c_slides) ───────────
  const getTitle = () => {
    if (viewState.screen === 'disaster_slides') {
      return DISASTER_TYPES.find(d => d.key === viewState.disasterType)?.label ?? '';
    }
    if (viewState.screen === 'part_b_slides') return 'Reporting Guidelines';
    return 'First Aid Tips';
  };

  const handleSlideBack = () => {
    if (viewState.screen === 'disaster_slides') setViewState({ screen: 'part_a_list' });
    else setViewState({ screen: 'overview' });
  };

  const handleComplete = async () => {
    if (viewState.screen === 'disaster_slides') {
      await handleDisasterComplete(viewState.disasterType);
    } else if (viewState.screen === 'part_b_slides') {
      await handlePartBComplete();
    } else {
      await handlePartCComplete();
    }
  };

  const retryFetch = () => {
    if (viewState.screen === 'disaster_slides') {
      const key = viewState.disasterType;
      fetchContent(
        `cr_tips_a_${key}`,
        `cr_tips_v_a_${key}`,
        `/api/content/safety-tips/${key}`,
        setSlides,
        setLoadState,
      );
    } else if (viewState.screen === 'part_b_slides') {
      fetchContent(
        'cr_tips_b',
        'cr_tips_v_b',
        '/api/content/reporting-guidelines',
        setSlides,
        setLoadState,
      );
    } else {
      fetchContent(
        'cr_tips_c',
        'cr_tips_v_c',
        '/api/content/first-aid',
        setSlides,
        setLoadState,
      );
    }
  };

  const currentSlideData = slides[currentSlide];
  const isLastSlide = slides.length > 0 && currentSlide === slides.length - 1;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleSlideBack} style={styles.headerBack}>
          <MaterialIcons name="arrow-back" size={scale(22)} color="#0468B1" />
        </TouchableOpacity>
        <Text
          style={[styles.headerTitle, { flex: 1, textAlign: 'center' }]}
          numberOfLines={1}
        >
          {getTitle()}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Loading skeleton */}
      {loadState === 'loading' && (
        <View style={{ padding: screenWidth * 0.05, flex: 1 }}>
          {[1, 2, 3].map(i => (
            <Animated.View key={i} style={[styles.skeleton, { opacity: skeletonAnim }]} />
          ))}
        </View>
      )}

      {/* Offline state */}
      {loadState === 'offline' && (
        <View style={styles.offlineState}>
          <MaterialIcons name="wifi-off" size={scale(48)} color="#C1C7D2" />
          <Text style={styles.offlineTitle}>Content not available offline</Text>
          <Text style={styles.offlineBody}>
            Connect to the internet to load Safety Tips
          </Text>
          <TouchableOpacity style={styles.retryBtn} onPress={retryFetch}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Loaded slide viewer */}
      {loadState === 'loaded' && slides.length > 0 && (
        <>
          <View style={{ marginHorizontal: screenWidth * 0.05, marginTop: 12, marginBottom: 16 }}>
            <Text style={styles.slideCounter}>
              SLIDE {currentSlide + 1} OF {slides.length}
            </Text>
            <View style={[styles.progressBarBg, { height: 4, marginBottom: 0, marginTop: 6 }]}>
              <View
                style={[
                  styles.progressBarFill,
                  {
                    height: 4,
                    borderRadius: 2,
                    width: `${((currentSlide + 1) / slides.length) * 100}%` as any,
                  },
                ]}
              />
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{
              paddingHorizontal: screenWidth * 0.05,
              paddingBottom: 120,
            }}
          >
            <Text style={styles.slideTitle}>{currentSlideData?.title}</Text>

            {/* Dos */}
            {currentSlideData?.dos && currentSlideData.dos.length > 0 && (
              <View>
                <Text style={styles.dosLabel}>✓ DO</Text>
                {currentSlideData.dos.map((item, idx) => (
                  <View key={idx} style={styles.dosDontRow}>
                    <MaterialIcons
                      name="check"
                      size={scale(18)}
                      color="#38A169"
                      style={{ marginTop: 2 }}
                    />
                    <Text style={styles.dosDontText}>{item}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Divider between dos and donts */}
            {currentSlideData?.dos &&
              currentSlideData.dos.length > 0 &&
              currentSlideData?.donts &&
              currentSlideData.donts.length > 0 && <View style={styles.divider} />}

            {/* Donts */}
            {currentSlideData?.donts && currentSlideData.donts.length > 0 && (
              <View>
                <Text style={styles.dontsLabel}>✗ DON'T</Text>
                {currentSlideData.donts.map((item, idx) => (
                  <View key={idx} style={styles.dosDontRow}>
                    <MaterialIcons
                      name="close"
                      size={scale(18)}
                      color="#E53E3E"
                      style={{ marginTop: 2 }}
                    />
                    <Text style={styles.dosDontText}>{item}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Bullets (Part B / Part C) */}
            {currentSlideData?.bullets && currentSlideData.bullets.length > 0 && (
              <View>
                {currentSlideData.bullets.map((item, idx) => (
                  <View key={idx} style={styles.bulletRow}>
                    <View style={styles.bulletDot} />
                    <Text style={styles.bulletText}>{item}</Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {/* Footer nav */}
          <View style={[styles.slideFooter, { paddingBottom: insets.bottom + 16 }]}>
            <TouchableOpacity
              style={[styles.footerBackBtn, currentSlide === 0 && { opacity: 0.4 }]}
              onPress={() => {
                if (currentSlide > 0) setCurrentSlide(prev => prev - 1);
              }}
              disabled={currentSlide === 0}
            >
              <Text style={styles.footerBackText}>Back</Text>
            </TouchableOpacity>

            {isLastSlide ? (
              <TouchableOpacity
                style={[styles.footerActionBtn, styles.completeBtnGreen]}
                onPress={handleComplete}
              >
                <Text style={styles.footerActionText}>Mark as Complete ✓</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.footerActionBtn, styles.nextBtnBlue]}
                onPress={() => setCurrentSlide(prev => prev + 1)}
              >
                <Text style={styles.footerActionText}>Next →</Text>
              </TouchableOpacity>
            )}
          </View>
        </>
      )}
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
    paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.92)',
    height: 56,
  },
  headerBack: { width: 44, minWidth: 44, minHeight: 44 },
  headerSpacer: { width: 44 },
  headerTitle: { fontSize: scale(17), fontWeight: '600', color: '#1B1C1C' },

  // ── Overview intro ───────────────────────────────────────────────────────────
  overviewIntro: {
    fontSize: scale(14),
    color: '#414751',
    textAlign: 'center',
    paddingHorizontal: screenWidth * 0.1,
    marginTop: 20,
    marginBottom: 24,
    lineHeight: scale(14) * 1.5,
  },

  // ── Part cards ───────────────────────────────────────────────────────────────
  partCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    marginBottom: 12,
    padding: 20,
  },
  cardRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardTitle: { fontSize: scale(15), fontWeight: '700', color: '#1B1C1C', marginBottom: 2 },
  cardSubtitle: { fontSize: scale(13), color: '#717782' },
  cardStatus: { fontSize: scale(13), fontWeight: '600' },
  cardDesc: { fontSize: scale(13), color: '#717782', marginTop: 4, marginBottom: 12 },
  progressBarBg: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E4E2E1',
    marginBottom: 16,
    overflow: 'hidden',
  },
  progressBarFill: { height: 6, borderRadius: 3, backgroundColor: '#0468B1' },
  cardBtn: { height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  cardBtnPrimary: { backgroundColor: '#0468B1' },
  cardBtnComplete: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: '#38A169',
  },
  cardBtnText: { fontSize: scale(15), fontWeight: '700', color: '#FFFFFF' },
  cardBtnCompleteText: { color: '#38A169' },

  // ── Badge teaser ─────────────────────────────────────────────────────────────
  badgeTeaser: {
    backgroundColor: 'rgba(4,104,177,0.06)',
    borderRadius: 16,
    padding: 16,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 8,
    alignItems: 'center',
  },
  badgeTeaserText: {
    fontSize: scale(13),
    color: '#0468B1',
    textAlign: 'center',
    marginTop: 8,
  },
  badgeTeaserLink: { fontSize: scale(13), fontWeight: '600', color: '#0468B1', marginTop: 8 },

  // ── Part A list ──────────────────────────────────────────────────────────────
  listLabel: {
    fontSize: scale(10),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
    marginTop: 8,
    marginHorizontal: screenWidth * 0.05,
  },
  disasterRow: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    marginHorizontal: screenWidth * 0.05,
    flexDirection: 'row',
    alignItems: 'center',
  },
  disasterIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#F0EDED',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  disasterLabel: { fontSize: scale(15), fontWeight: '600', color: '#1B1C1C', flex: 1 },

  // ── Offline info card (Part A list footer) ───────────────────────────────────
  offlineInfoCard: {
    backgroundColor: '#F0EDED',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: screenWidth * 0.05,
    marginTop: 8,
    alignItems: 'center',
  },
  offlineInfoText: {
    fontSize: scale(13),
    color: '#717782',
    marginTop: 8,
    textAlign: 'center',
  },
  offlineInfoSubText: {
    fontSize: scale(12),
    color: '#9CA3AF',
    marginTop: 4,
    textAlign: 'center',
  },

  // ── Slide viewer: skeleton ────────────────────────────────────────────────────
  skeleton: { height: 80, borderRadius: 12, backgroundColor: '#F0EDED', marginBottom: 8 },

  // ── Slide viewer: offline state ───────────────────────────────────────────────
  offlineState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: screenWidth * 0.1,
  },
  offlineTitle: {
    fontSize: scale(16),
    fontWeight: '700',
    color: '#1B1C1C',
    marginTop: 16,
    textAlign: 'center',
  },
  offlineBody: {
    fontSize: scale(14),
    color: '#717782',
    marginTop: 8,
    textAlign: 'center',
  },
  retryBtn: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 24,
    marginTop: 16,
    borderWidth: 1.5,
    borderColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  retryBtnText: { fontSize: scale(15), color: '#0468B1', fontWeight: '600' },

  // ── Slide viewer: slide counter ───────────────────────────────────────────────
  slideCounter: {
    fontSize: scale(11),
    fontWeight: '700',
    color: '#0468B1',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // ── Slide viewer: slide content ───────────────────────────────────────────────
  slideTitle: {
    fontSize: scale(18),
    fontWeight: '800',
    color: '#1B1C1C',
    marginTop: 16,
    marginBottom: 20,
  },
  dosLabel: {
    fontSize: scale(11),
    fontWeight: '800',
    color: '#38A169',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  dontsLabel: {
    fontSize: scale(11),
    fontWeight: '800',
    color: '#E53E3E',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  dosDontRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
    alignItems: 'flex-start',
  },
  dosDontText: {
    fontSize: scale(15),
    color: '#414751',
    flex: 1,
    lineHeight: scale(15) * 1.5,
  },
  divider: { height: 1, backgroundColor: '#F0EDED', marginVertical: 20 },
  bulletRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
    alignItems: 'flex-start',
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0468B1',
    marginTop: 8,
  },
  bulletText: { fontSize: scale(15), color: '#414751', flex: 1 },

  // ── Slide viewer: footer nav ──────────────────────────────────────────────────
  slideFooter: {
    flexDirection: 'row',
    paddingHorizontal: screenWidth * 0.05,
    paddingTop: 12,
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderTopWidth: 1,
    borderTopColor: '#E4E2E1',
  },
  footerBackBtn: {
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: '#C1C7D2',
    justifyContent: 'center',
    alignItems: 'center',
  },
  footerBackText: { fontSize: scale(15), color: '#717782' },
  footerActionBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nextBtnBlue: { backgroundColor: '#0468B1' },
  completeBtnGreen: { backgroundColor: '#38A169' },
  footerActionText: { fontSize: scale(15), fontWeight: '700', color: '#FFFFFF' },
});
