import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
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
import { enqueueProgress } from '../utils/progressQueue';

const { width: _screenWidthRaw } = Dimensions.get('window');
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round((screenWidth / 375) * size);

type ViewState =
  | { screen: 'overview' }
  | { screen: 'part_a_list' }
  | { screen: 'disaster_slides'; disasterType: string }
  | { screen: 'part_b_slides' }
  | { screen: 'part_c_slides' };

type LoadState = 'loading' | 'loaded' | 'offline';

interface Slide {
  slide_id?: string;
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

// ── Hardcoded slide content (matches web SafetyTipsPage.tsx exactly) ─────────
// Part A uses {dos} or {donts} fields; Parts B/C use {bullets}.

const HARDCODED_DISASTER_SLIDES: Record<string, Slide[]> = {
  earthquake: [
    { title: 'Drop and Take Cover', dos: ['Drop to your hands and knees immediately', 'Take cover under a sturdy table or desk, or against an interior wall away from windows'] },
    { title: 'Hold On and Stay Put', dos: ['Hold on and protect your head and neck with your arms', 'Stay where you are until the shaking stops — most injuries happen when people try to move'] },
    { title: 'Move Away from Outdoor Hazards', dos: ['If outdoors, move away from buildings, streetlights, and utility wires', 'If in a vehicle, pull over away from buildings and overpasses and stay inside'] },
    { title: 'After the Shaking Stops', dos: ['After shaking stops, check yourself and others for injuries before moving', 'Expect aftershocks — drop, cover, and hold on each time'] },
    { title: 'Run Outside or Use Doorways', donts: ['Do not run outside while shaking is happening — most injuries occur when people try to move during shaking', 'Do not stand in a doorway — doorways offer no special protection'] },
    { title: 'Use Elevators or Open Flames', donts: ['Do not use elevators after an earthquake — use stairs only', 'Do not light candles, matches, or any open flame — gas pipes may be damaged'] },
    { title: 'Re-enter or Spread Rumours', donts: ['Do not return to a damaged building until declared structurally safe', 'Do not spread unverified information — only share from official sources'] },
  ],
  flood: [
    { title: 'Move to Higher Ground', dos: ['Move immediately to higher ground if flooding is imminent', 'Turn off utilities at the main switch if safe to do so'] },
    { title: 'Disconnect Appliances and Evacuate', dos: ['Disconnect electrical appliances — do not touch them if wet or standing in water', 'If evacuation is ordered, leave immediately with your emergency kit'] },
    { title: 'If Trapped, Signal for Help', dos: ['If trapped, move to the highest floor and signal for help from a window', 'Drink only bottled or boiled water — floodwater contaminates supplies'] },
    { title: 'Protect Yourself and Monitor Updates', dos: ['Wear rubber boots and waterproof gloves if walking through floodwater', 'Listen to official emergency broadcasts for updates and evacuation routes'] },
    { title: 'Walk or Drive Through Floodwater', donts: ['Do not walk through moving floodwater — 15cm of fast-moving water can knock an adult down', 'Do not drive through flooded roads — water depth is impossible to judge'] },
    { title: 'Touch Floodwater or Return Too Soon', donts: ['Do not touch floodwater if avoidable — it may contain sewage, chemicals, or debris', 'Do not return home until authorities declare it safe'] },
    { title: 'Use Damaged Appliances or Ignore Orders', donts: ['Do not use electrical equipment that has been in contact with floodwater', 'Do not ignore evacuation orders — each flood event is different'] },
  ],
  tsunami: [
    { title: 'Move to Higher Ground Immediately', dos: ['If you feel a strong earthquake near the coast, move immediately to higher ground — do not wait for a warning', 'A sudden recession of the sea is a natural warning sign — move inland immediately'] },
    { title: 'Move on Foot and Seek High Ground', dos: ['Move on foot if possible — roads may be congested or damaged', 'Go to a designated tsunami evacuation zone or the highest ground available'] },
    { title: 'If Caught in a Wave', dos: ['If caught in a wave, grab onto something that floats', 'After the first wave, stay where you are — later waves are often larger'] },
    { title: 'Wait for the Official All-Clear', dos: ['Listen to official broadcasts — an all-clear must come from authorities before returning', 'Help others move to higher ground only if you can do so safely'] },
    { title: 'Go to the Coast or Assume It\'s Over', donts: ['Do not go to the coast to watch the tsunami — people who do are frequently killed', 'Do not assume danger is over after the first wave — subsequent waves can arrive for hours'] },
    { title: 'Use Bridges or Return Too Soon', donts: ['Do not use bridges or low-lying roads during or after a tsunami warning', 'Do not return to coastal areas until authorities issue a formal all-clear'] },
    { title: 'Rely Solely on Sirens or Drive Through Zones', donts: ['Do not rely solely on sirens — if you feel a large earthquake near the coast, act immediately', 'Do not attempt to drive through tsunami inundation zones — vehicles are easily swept away'] },
  ],
  hurricane_cyclone: [
    { title: 'Follow Evacuation Orders', dos: ['Follow evacuation orders immediately when issued', 'Board up windows and secure outdoor furniture before the storm arrives'] },
    { title: 'Prepare Emergency Supplies', dos: ['Prepare an emergency kit with water, food, medications, flashlight — enough for 72 hours', 'Fill clean containers with drinking water before the storm — supplies may be disrupted'] },
    { title: 'Stay Indoors During the Storm', dos: ['Stay indoors during the storm, away from windows and glass doors', 'If the eye passes over, stay sheltered — dangerous winds will return from the opposite direction'] },
    { title: 'After the Storm', dos: ['After the storm, check your home for structural damage before entering', 'Listen to official broadcasts for road conditions and public health guidance'] },
    { title: 'Go Outside During the Storm', donts: ['Do not go outside during the storm — flying debris causes most hurricane fatalities', 'Do not assume the storm is over if winds suddenly calm — the eye passes quickly'] },
    { title: 'Use Generators Indoors or Touch Downed Lines', donts: ['Do not use generators or charcoal grills indoors — carbon monoxide poisoning is a leading cause of post-hurricane deaths', 'Do not touch downed power lines or walk through standing water near them'] },
    { title: 'Drive Through Flooding or Return Too Soon', donts: ['Do not drive through flooded roads — hurricane flooding is extensive', 'Do not return to evacuated areas until authorities declare it safe'] },
  ],
  wildfire: [
    { title: 'Evacuate Immediately When Ordered', dos: ['If you receive an evacuation order, leave immediately — wildfires change direction rapidly', 'Close all windows and doors as you leave to slow fire entering — leave them unlocked for emergency responders'] },
    { title: 'Protect Yourself While Evacuating', dos: ['Wear a mask or cover your nose and mouth with a damp cloth while evacuating', 'Take your emergency kit, medications, important documents, and pets if you can do so quickly'] },
    { title: 'If There Is No Escape Route', dos: ['If caught with no escape route, shelter in a building or lie face down in a ditch away from vegetation', 'Breathe through your nose — nasal passages filter more smoke than mouth breathing'] },
    { title: 'After a Wildfire', dos: ['After a wildfire, check your roof for embers before re-entering — embers can smoulder for hours', 'Wear a mask and gloves when working in ash — it may contain toxic materials'] },
    { title: 'Ignore Orders or Re-enter Too Soon', donts: ['Do not ignore evacuation orders even if the fire seems far away — wildfires can travel faster than a person can run', 'Do not re-enter evacuated areas until declared safe — hidden hot spots can reignite'] },
    { title: 'Park Under Trees or Use Contaminated Water', donts: ['Do not park under trees during or after a wildfire — weakened trees can fall without warning', 'Do not use water that may be contaminated by fire retardants — use bottled water only'] },
    { title: 'Inhale Ash or Fight the Fire Yourself', donts: ['Do not inhale ash unnecessarily — wear a properly fitted particulate mask where available', 'Do not attempt to fight a wildfire yourself — evacuate and let trained firefighters handle it'] },
  ],
  explosion: [
    { title: 'Take Cover Immediately', dos: ['Immediately take cover behind a solid object or drop to the ground face down', 'Cover your head and neck with your arms to protect from debris'] },
    { title: 'Move Away and Help If Safe', dos: ['Once the immediate danger passes, move away from the site quickly and calmly', 'Help injured people move away only if you can do so safely without putting yourself at risk'] },
    { title: 'Seek Medical Attention and Report', dos: ['Seek medical attention for any injuries — blast injuries may not be immediately visible', 'Report the explosion to emergency services as soon as you are in a safe location'] },
    { title: 'Follow Official Instructions', dos: ['Follow instructions from emergency services and authorities on the ground', 'Stay upwind of the explosion site to avoid inhaling smoke or chemical fumes'] },
    { title: 'Return to the Site or Use Phones Near Gas', donts: ['Do not return to the explosion site — secondary explosions are common', 'Do not use mobile phones or electrical switches near a gas leak — sparks can trigger another explosion'] },
    { title: 'Touch Debris or Spread Rumours', donts: ['Do not touch suspicious packages or debris around the site', 'Do not post unverified information about the cause — this can spread panic'] },
    { title: 'Block Access or Enter Damaged Buildings', donts: ['Do not block emergency service access routes', 'Do not enter damaged buildings — structural collapse risk is high after an explosion'] },
  ],
  chemical_incident: [
    { title: 'Move Upwind or Shelter in Place', dos: ['Move upwind and uphill from the incident immediately', 'If indoors, shelter in place — close all windows, doors, and ventilation systems'] },
    { title: 'Decontaminate and Cover Your Mouth', dos: ['If you have been exposed, remove outer clothing and wash skin thoroughly with water', 'Cover your nose and mouth with a wet cloth if you must move through contaminated air'] },
    { title: 'Follow Evacuation Instructions', dos: ['Follow evacuation instructions from emergency services exactly', 'Seek medical attention even if you feel well — chemical exposure symptoms can be delayed'] },
    { title: 'Monitor Updates and Flush Eyes If Needed', dos: ['Listen to official broadcasts for information on safe zones and decontamination points', 'If your eyes are burning, flush them with clean water for at least 15 minutes'] },
    { title: 'Approach the Source or Eat Nearby', donts: ['Do not approach the source of a chemical incident — even brief exposure can be fatal', 'Do not eat, drink, or smoke in or near the affected area'] },
    { title: 'Trust Your Nose or Re-enter Too Soon', donts: ['Do not rely on smell to determine safety — many hazardous chemicals are odourless', 'Do not re-enter the affected area until authorities declare it safe'] },
    { title: 'Spread Rumours or Remove Protective Gear', donts: ['Do not spread rumours about the cause — chemical incidents cause significant public panic', 'Do not remove protective clothing given by emergency services until instructed'] },
  ],
  conflict: [
    { title: 'Find Cover and Stay Away from Windows', dos: ['If caught in an active conflict zone, find cover immediately — lie flat behind a solid structure', 'Stay away from windows, doors, and open spaces during active shooting or shelling'] },
    { title: 'Follow Legitimate Authority and Move Safely', dos: ['Follow instructions from legitimate security forces or humanitarian organisations', 'If evacuating, move quickly and low, using buildings and terrain as cover'] },
    { title: 'Keep an Emergency Bag Ready', dos: ['Keep an emergency bag ready with documents, water, food, and medications', 'Identify safe exit routes from your home and neighbourhood in advance'] },
    { title: 'Shelter in Place and Conserve Power', dos: ['If sheltering in place, move to an interior room away from windows on the lowest floor', 'Conserve phone battery and charge devices whenever power is available'] },
    { title: 'Film Military or Touch Unexploded Ordnance', donts: ['Do not film or photograph military personnel or equipment — this can put you at serious risk', 'Do not approach unexploded ordnance or debris — mark the location and report it'] },
    { title: 'Use Open Flames or Post Your Location', donts: ['Do not use open flames at night — light can attract attention in conflict zones', 'Do not spread your location on social media during active conflict'] },
    { title: 'Cross Front Lines or Ignore Curfews', donts: ['Do not attempt to cross front lines or enter restricted areas', 'Do not ignore curfews or movement restrictions imposed by authorities'] },
  ],
  civil_unrest: [
    { title: 'Move Calmly to the Edges', dos: ['If caught in a crowd disturbance, move calmly to the edges and away from the crowd', 'Stay aware of your surroundings and identify exit routes before any situation escalates'] },
    { title: 'If Tear Gas Is Used', dos: ['If tear gas is used, move upwind and flush eyes with clean water', 'Cover your nose and mouth with a wet cloth to reduce inhalation of irritants'] },
    { title: 'Stay in Contact and Follow Instructions', dos: ['Stay in contact with family or trusted contacts about your location', 'Follow instructions from police or security forces unless doing so puts you at immediate risk'] },
    { title: 'Observe Safely and Document from a Distance', dos: ['If you are a reporter or observer, identify yourself clearly and stay to the periphery', 'Document damage and injuries only from a safe distance'] },
    { title: 'Engage or Blend In With Crowds', donts: ['Do not engage with crowds or attempt to intervene in confrontations', 'Do not wear clothing that could be mistaken for that of any group involved'] },
    { title: 'Share Real-Time Movements or Use Flash', donts: ['Do not share real-time location of security forces or crowd movements on social media', 'Do not use flash photography in tense situations — it can provoke a response'] },
    { title: 'Block Emergency Routes or Spread Rumours', donts: ['Do not block emergency vehicle access routes', 'Do not spread unverified reports of casualties or causes — this escalates tensions'] },
  ],
};

const HARDCODED_PART_B: Slide[] = [
  { title: 'Only Report What You Can Safely See', bullets: ['Never put yourself in danger to get closer to an incident. If you cannot see it from a safe distance, do not report it.', 'Your safety is more valuable than any report. Accurate reporting from a safe vantage point is always better than no report at all.'] },
  { title: 'Take Clear Photos from a Safe Distance', bullets: ['Use zoom rather than approaching the damage. A clear photo from 20 metres is more useful than a blurred one from 5 metres.', 'Photograph the full structure, not just the damage. Context — surrounding buildings, street layout — is essential for assessment.'] },
  { title: 'Be Accurate with Location — Use GPS When Possible', bullets: ['Enable GPS on your device before reaching the site. Allow the app to auto-detect your location for the highest accuracy.', 'If GPS is unavailable, note the building name, street address, or a nearby landmark to allow accurate manual geo-coding.'] },
  { title: 'One Report Per Building — No Duplicates', bullets: ['Submit only one report per building per visit. Duplicate reports waste analyst time and distort damage statistics.', 'If conditions have changed significantly since your last report on a building, submit an update rather than a new report.'] },
  { title: 'Your Identity is Protected — Reports Are Anonymised', bullets: ['Your name, email, and device information are encrypted at rest and never included in exported datasets.', 'Reports shared with humanitarian organisations contain only location data, damage classification, and timestamps — never personal identifiers.'] },
];

const HARDCODED_PART_C: Slide[] = [
  { title: 'Controlling Bleeding', bullets: ['Apply firm, direct pressure to the wound with a clean cloth or bandage and maintain it continuously for at least 10 minutes.', 'Elevate the injured limb above heart level if possible. Do not remove the cloth — add more on top if it soaks through.'] },
  { title: 'Recovery Position', bullets: ['Place an unconscious, breathing person on their side with their top knee bent forward to prevent them rolling back.', 'Tilt their head back gently to open the airway, and place their hand under their cheek. Monitor breathing continuously.'] },
  { title: 'Treating Shock', bullets: ['Lay the person flat and, if not injured, raise their legs 20–30 cm above heart level to improve blood flow to vital organs.', 'Keep them warm with a blanket. Do not give food or water. Reassure them calmly and monitor their breathing until help arrives.'] },
  { title: 'Burns Treatment', bullets: ['Cool the burn immediately under cool (not cold) running water for at least 20 minutes. Remove jewellery near the burn if possible.', 'Cover the burn loosely with cling film or a clean non-fluffy material. Do not apply butter, toothpaste, or ice.'] },
  { title: 'Fractures and Immobilisation', bullets: ['Do not attempt to straighten a fractured limb. Immobilise it in the position found using a splint and soft padding.', 'A splint can be improvised from a straight stick, rolled newspaper, or folded clothing tied firmly — not tightly — above and below the fracture.'] },
  { title: 'When Not to Move an Injured Person', bullets: ['Do not move someone who may have a spinal injury (high-impact trauma, neck pain, tingling/numbness) unless they are in immediate danger.', 'If you must move them, keep the head, neck, and spine aligned at all times and use multiple people to maintain a straight carry.'] },
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

// ── Translation key helper ────────────────────────────────────────────────────
// Key format (UUID scheme — used when slide_id is present from API response):
//   SAFETY_TIP_A_{DISASTER}_{slide_id}_TITLE / DO_{M} / DONT_{M}
//   SAFETY_TIP_B_{slide_id}_TITLE / BULLET_{M}
//   SAFETY_TIP_C_{slide_id}_TITLE / BULLET_{M}
// Positional fallback (used for hardcoded slides that have no slide_id):
//   SAFETY_TIP_A_{DISASTER}_SLIDE_{N}_TITLE / DO_{M} / DONT_{M}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTip(t: (key: string, opts?: any) => string) {
  return function tip(
    part: 'A' | 'B' | 'C',
    disaster: string,
    slideIdx: number,          // 1-based; used only when slideId is absent
    field: 'TITLE' | 'DO' | 'DONT' | 'BULLET',
    bulletIdx: number,         // 1-based; 0 = no suffix (for TITLE)
    slideId: string | null | undefined,
    fallback: string,
  ): string {
    const d = disaster ? `_${disaster.toUpperCase().replace(/-/g, '_')}` : '';
    const b = bulletIdx > 0 ? `_${bulletIdx}` : '';
    const slideKey = slideId ? slideId : `SLIDE_${slideIdx}`;
    return t(`SAFETY_TIP_${part}${d}_${slideKey}_${field}${b}`, { defaultValue: fallback });
  };
}

export default function SafetyTipsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { t, i18n } = useTranslation();
  const tip = makeTip(t);
  const lang = i18n.language || 'en';
  const langParam = lang !== 'en' ? `?lang=${encodeURIComponent(lang)}` : '';
  const langSuffix = lang !== 'en' ? `_${lang}` : '';

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
      // Use hardcoded slides immediately — no API call needed for Part A.
      // This guarantees 7 rich slides per disaster type, offline-capable, matching
      // the web exactly. If an admin has seeded custom content via the API it will
      // be shown on the next app launch via the async background update below.
      const key = viewState.disasterType;
      const hardcoded = HARDCODED_DISASTER_SLIDES[key] ?? [];
      setSlides(hardcoded);
      setLoadState('loaded');

      // Background update: fetch API version; only update if content was changed by admin.
      // Cache keys are language-aware so Turkish content doesn't overwrite the English cache.
      fetchContent(
        `cr_tips_a_${key}${langSuffix}`,
        `cr_tips_v_a_${key}${langSuffix}`,
        `/api/content/safety-tips/${key}${langParam}`,
        (freshSlides) => {
          // Override hardcoded fallback whenever the API returns any slides.
          if (freshSlides.length > 0) setSlides(freshSlides);
        },
        () => { /* ignore load-state changes — we're already 'loaded' */ },
      );
    } else if (viewState.screen === 'part_b_slides') {
      // Show hardcoded content immediately, then refresh from API in background.
      setSlides(HARDCODED_PART_B);
      setLoadState('loaded');
      fetchContent(
        `cr_tips_b${langSuffix}`,
        `cr_tips_v_b${langSuffix}`,
        `/api/content/reporting-guidelines${langParam}`,
        (freshSlides) => { if (freshSlides.length > 0) setSlides(freshSlides); },
        () => {},
      );
    } else if (viewState.screen === 'part_c_slides') {
      // Show hardcoded content immediately, then refresh from API in background.
      setSlides(HARDCODED_PART_C);
      setLoadState('loaded');
      fetchContent(
        `cr_tips_c${langSuffix}`,
        `cr_tips_v_c${langSuffix}`,
        `/api/content/first-aid${langParam}`,
        (freshSlides) => { if (freshSlides.length > 0) setSlides(freshSlides); },
        () => {},
      );
    }
  }, [viewState, lang]);

  const syncPartComplete = useCallback((partCompleted: string) => {
    const reporterId = useAuthStore.getState().reporterId;
    if (!reporterId) return;
    // enqueueProgress posts immediately; queues to AsyncStorage if offline
    enqueueProgress(reporterId, partCompleted);
  }, []);

  const checkBadge = useCallback(
    (pA: Record<string, boolean>, pB: boolean, pC: boolean) => {
      const allComplete = Object.values(pA).filter(Boolean).length === 9 && pB && pC;
      if (allComplete) {
        Alert.alert(
          t('safety.complete_alert_title') + ' 🎉',
          t('safety.complete_alert_body'),
          [
            { text: t('safety.view_badges'), onPress: () => navigation.navigate('BadgesScreen') },
            { text: t('safety.done') },
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
      syncPartComplete(`A_${disasterType}`);
      checkBadge(newProgressA, progressB, progressC);
      setViewState({ screen: 'part_a_list' });
    },
    [progressA, progressB, progressC, syncPartComplete, checkBadge],
  );

  const handlePartBComplete = useCallback(async () => {
    setProgressB(true);
    await AsyncStorage.setItem('cr_tips_progress_b', 'true');
    await AsyncStorage.setItem('cr_safety_b_complete', 'true');
    syncPartComplete('B');
    checkBadge(progressA, true, progressC);
    setViewState({ screen: 'overview' });
  }, [progressA, progressC, syncPartComplete, checkBadge]);

  const handlePartCComplete = useCallback(async () => {
    setProgressC(true);
    await AsyncStorage.setItem('cr_tips_progress_c', 'true');
    await AsyncStorage.setItem('cr_safety_c_complete', 'true');
    syncPartComplete('C');
    checkBadge(progressA, progressB, true);
    setViewState({ screen: 'overview' });
  }, [progressA, progressB, syncPartComplete, checkBadge]);

  const completedA = Object.values(progressA).filter(Boolean).length;

  // ── Overview ─────────────────────────────────────────────────────────────────
  if (viewState.screen === 'overview') {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBack}>
            <MaterialIcons name="arrow-back" size={scale(22)} color="#0468B1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('safety.title')}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <Text style={styles.overviewIntro}>
            {t('safety.intro_text')}
          </Text>

          {/* Part A */}
          <View style={styles.partCard}>
            <View style={styles.cardRow}>
              <View style={[styles.iconContainer, { backgroundColor: 'rgba(4,104,177,0.1)' }]}>
                <MaterialIcons name="shield" size={scale(22)} color="#0468B1" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.cardTitle}>{t('safety.part_a_card_title')}</Text>
                <Text style={styles.cardSubtitle}>{t('safety.n_of_9_completed', { n: completedA })}</Text>
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
                {completedA === 9 ? t('SAFETY_COMPLETED', { defaultValue: '✓ Completed' }) : t('safety.continue_btn')}
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
                <Text style={styles.cardTitle}>{t('safety.part_b_card_title')}</Text>
                <Text style={[styles.cardStatus, { color: progressB ? '#38A169' : '#F5A623' }]}>
                  {progressB ? t('safety.status_completed') : t('safety.status_not_started')}
                </Text>
              </View>
            </View>
            <Text style={styles.cardDesc}>
              {t('safety.part_b_desc')}
            </Text>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: progressB ? '100%' : '0%' }]} />
            </View>
            <TouchableOpacity
              style={[styles.cardBtn, progressB ? styles.cardBtnComplete : styles.cardBtnPrimary]}
              onPress={() => setViewState({ screen: 'part_b_slides' })}
            >
              <Text style={[styles.cardBtnText, progressB && styles.cardBtnCompleteText]}>
                {progressB ? t('SAFETY_COMPLETED', { defaultValue: '✓ Completed' }) : t('safety.continue_btn')}
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
                <Text style={styles.cardTitle}>{t('safety.part_c_card_title')}</Text>
                <Text style={[styles.cardStatus, { color: progressC ? '#38A169' : '#F5A623' }]}>
                  {progressC ? t('safety.status_completed') : t('safety.status_not_started')}
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
                {progressC ? t('SAFETY_COMPLETED', { defaultValue: '✓ Completed' }) : t('safety.continue_btn')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Badge teaser */}
          <View style={styles.badgeTeaser}>
            <MaterialIcons name="star" size={scale(20)} color="#0468B1" />
            <Text style={styles.badgeTeaserText}>
              {t('safety.badge_teaser')}
            </Text>
            <TouchableOpacity onPress={() => navigation.navigate('BadgesScreen')}>
              <Text style={styles.badgeTeaserLink}>{t('safety.badge_teaser_link')}</Text>
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
          <Text style={styles.headerTitle}>{t('safety.tab_a')}</Text>
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
          <Text style={styles.listLabel}>{t('safety.tap_hint').toUpperCase()}</Text>

          {DISASTER_TYPES.map(dt => (
            <TouchableOpacity
              key={dt.key}
              style={styles.disasterRow}
              onPress={() => setViewState({ screen: 'disaster_slides', disasterType: dt.key })}
            >
              <View style={styles.disasterIconContainer}>
                <MaterialIcons name={dt.icon as any} size={scale(22)} color="#0468B1" />
              </View>
              <Text style={styles.disasterLabel}>
                {t(`SAFETY_DISASTER_${dt.key.toUpperCase().replace(/-/g, '_')}_LABEL`, { defaultValue: dt.label })}
              </Text>
              {progressA[dt.key] ? (
                <MaterialIcons name="check-circle" size={scale(22)} color="#38A169" />
              ) : (
                <MaterialIcons name="chevron-right" size={scale(20)} color="#C1C7D2" />
              )}
            </TouchableOpacity>
          ))}

          <View style={styles.offlineInfoCard}>
            <MaterialIcons name="cloud-done" size={scale(22)} color="#0468B1" />
            <Text style={styles.offlineInfoText}>{t('safety.offline_ready')}</Text>
            <Text style={styles.offlineInfoSubText}>{t('safety.offline_ready_desc')}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Slide viewer (disaster_slides | part_b_slides | part_c_slides) ───────────
  const getTitle = () => {
    if (viewState.screen === 'disaster_slides') {
      const dt = DISASTER_TYPES.find(d => d.key === viewState.disasterType);
      return dt ? t(`SAFETY_DISASTER_${dt.key.toUpperCase().replace(/-/g, '_')}_LABEL`, { defaultValue: dt.label }) : '';
    }
    if (viewState.screen === 'part_b_slides') return t('SAFETY_PART_B_TITLE', { defaultValue: 'Reporting Guidelines' });
    return t('SAFETY_PART_C_TITLE', { defaultValue: 'First Aid Tips' });
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
      // Part A is hardcoded — always available offline. Restore hardcoded slides.
      const key = viewState.disasterType;
      setSlides(HARDCODED_DISASTER_SLIDES[key] ?? []);
      setLoadState('loaded');
    } else if (viewState.screen === 'part_b_slides') {
      setSlides(HARDCODED_PART_B);
      setLoadState('loaded');
      fetchContent(`cr_tips_b${langSuffix}`, `cr_tips_v_b${langSuffix}`, `/api/content/reporting-guidelines${langParam}`, setSlides, setLoadState);
    } else {
      setSlides(HARDCODED_PART_C);
      setLoadState('loaded');
      fetchContent(`cr_tips_c${langSuffix}`, `cr_tips_v_c${langSuffix}`, `/api/content/first-aid${langParam}`, setSlides, setLoadState);
    }
  };

  const currentSlideData = slides[currentSlide];
  const isLastSlide = slides.length > 0 && currentSlide === slides.length - 1;

  // Derive part + disasterId for tip() key construction
  const tipPart: 'A' | 'B' | 'C' =
    viewState.screen === 'disaster_slides' ? 'A' :
    viewState.screen === 'part_b_slides' ? 'B' : 'C';
  const tipDisaster =
    viewState.screen === 'disaster_slides' ? viewState.disasterType : '';

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
          <Text style={styles.offlineTitle}>{t('safety.offline_content_unavailable')}</Text>
          <Text style={styles.offlineBody}>
            {t('safety.connect_to_load')}
          </Text>
          <TouchableOpacity style={styles.retryBtn} onPress={retryFetch}>
            <Text style={styles.retryBtnText}>{t('safety.retry')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Loaded slide viewer */}
      {loadState === 'loaded' && slides.length > 0 && (
        <>
          <View style={{ marginHorizontal: screenWidth * 0.05, marginTop: 12, marginBottom: 16 }}>
            <Text style={styles.slideCounter}>
              {t('SAFETY_SLIDE_PROGRESS', { n: currentSlide + 1, total: slides.length, defaultValue: `SLIDE ${currentSlide + 1} OF ${slides.length}` }).toUpperCase()}
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
            <Text style={styles.slideTitle}>
              {tip(tipPart, tipDisaster, currentSlide + 1, 'TITLE', 0, currentSlideData?.slide_id, currentSlideData?.title ?? '')}
            </Text>

            {/* Dos */}
            {currentSlideData?.dos && currentSlideData.dos.length > 0 && (
              <View>
                <Text style={styles.dosLabel}>✓ {t('SAFETY_DO', { defaultValue: 'DO' })}</Text>
                {currentSlideData.dos.map((item, idx) => (
                  <View key={idx} style={styles.dosDontRow}>
                    <MaterialIcons
                      name="check"
                      size={scale(18)}
                      color="#38A169"
                      style={{ marginTop: 2 }}
                    />
                    <Text style={styles.dosDontText}>
                      {tip(tipPart, tipDisaster, currentSlide + 1, 'DO', idx + 1, currentSlideData?.slide_id, item)}
                    </Text>
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
                <Text style={styles.dontsLabel}>✗ {t('SAFETY_DONT', { defaultValue: "DON'T" })}</Text>
                {currentSlideData.donts.map((item, idx) => (
                  <View key={idx} style={styles.dosDontRow}>
                    <MaterialIcons
                      name="close"
                      size={scale(18)}
                      color="#E53E3E"
                      style={{ marginTop: 2 }}
                    />
                    <Text style={styles.dosDontText}>
                      {tip(tipPart, tipDisaster, currentSlide + 1, 'DONT', idx + 1, currentSlideData?.slide_id, item)}
                    </Text>
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
                    <Text style={styles.bulletText}>
                      {tip(tipPart, tipDisaster, currentSlide + 1, 'BULLET', idx + 1, currentSlideData?.slide_id, item)}
                    </Text>
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
              <Text style={styles.footerBackText}>{t('COMMON_PREVIOUS', { defaultValue: 'Back' })}</Text>
            </TouchableOpacity>

            {isLastSlide ? (
              <TouchableOpacity
                style={[styles.footerActionBtn, styles.completeBtnGreen]}
                onPress={handleComplete}
              >
                <Text style={styles.footerActionText}>{t('SAFETY_MARK_COMPLETE', { defaultValue: 'Mark as Complete ✓' })}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.footerActionBtn, styles.nextBtnBlue]}
                onPress={() => setCurrentSlide(prev => prev + 1)}
              >
                <Text style={styles.footerActionText}>{t('COMMON_NEXT', { defaultValue: 'Next →' })}</Text>
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
    backgroundColor: '#F6F3F2',
    height: 56,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E2E1',
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
    backgroundColor: '#F6F3F2',
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
