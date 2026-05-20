import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../services/api';

const SAFETY_TIPS_A = [
  { id: 'a1', text: 'Stay away from damaged buildings — they may collapse without warning.' },
  { id: 'a2', text: 'Do not enter a building that has visible structural cracks or leaning walls.' },
  { id: 'a3', text: 'Watch out for downed power lines — treat all lines as live.' },
  { id: 'a4', text: 'Wear sturdy footwear when moving through damaged areas.' },
  { id: 'a5', text: 'Work in pairs or groups — never assess damage alone.' },
];

const SAFETY_TIPS_B = [
  { id: 'b1', text: 'Photograph damage from a safe distance — do not enter unstable structures.' },
  { id: 'b2', text: 'Report gas leaks immediately — do not use open flames nearby.' },
  { id: 'b3', text: 'Avoid flood water — it may be contaminated or electrically charged.' },
  { id: 'b4', text: 'Keep your phone charged — it is your primary reporting tool.' },
  { id: 'b5', text: 'Follow instructions from local authorities and UNDP field staff at all times.' },
];

export default function SafetyTipsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [partAComplete, setPartAComplete] = useState(false);
  const [partBComplete, setPartBComplete] = useState(false);
  const [activeTab, setActiveTab] = useState<'A' | 'B'>('A');

  useEffect(() => {
    AsyncStorage.getItem('cr_safety_a_complete').then((v) => {
      if (v === 'true') setPartAComplete(true);
    });
    AsyncStorage.getItem('cr_safety_b_complete').then((v) => {
      if (v === 'true') setPartBComplete(true);
    });
  }, []);

  const markComplete = async (part: 'A' | 'B') => {
    const key = part === 'A' ? 'cr_safety_a_complete' : 'cr_safety_b_complete';
    await AsyncStorage.setItem(key, 'true');
    if (part === 'A') setPartAComplete(true);
    else setPartBComplete(true);

    // Sync to backend if logged in
    try {
      const reporterId = await SecureStore.getItemAsync('cr_reporter_id');
      if (reporterId && !reporterId.startsWith('CR-PENDING-')) {
        await api.post(`/api/reporters/${reporterId}/safety-progress`, {
          part_a_complete: part === 'A' ? true : partAComplete,
          part_b_complete: part === 'B' ? true : partBComplete,
        });
      }
    } catch {
      // Non-blocking
    }

    if (part === 'A' && !partBComplete) {
      Alert.alert('Part A Complete', 'Great work! Now read Part B to complete your safety training.');
      setActiveTab('B');
    } else if (part === 'B') {
      Alert.alert('Safety Training Complete', 'You have completed all safety guidelines. Stay safe in the field!');
    }
  };

  const tips = activeTab === 'A' ? SAFETY_TIPS_A : SAFETY_TIPS_B;
  const isComplete = activeTab === 'A' ? partAComplete : partBComplete;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Safety Tips</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Tab switcher */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'A' && styles.tabActive]}
          onPress={() => setActiveTab('A')}
        >
          <Text style={[styles.tabLabel, activeTab === 'A' && styles.tabLabelActive]}>
            Part A {partAComplete ? '✓' : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'B' && styles.tabActive]}
          onPress={() => setActiveTab('B')}
        >
          <Text style={[styles.tabLabel, activeTab === 'B' && styles.tabLabelActive]}>
            Part B {partBComplete ? '✓' : ''}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {tips.map((tip) => (
          <View key={tip.id} style={styles.tipRow}>
            <Text style={styles.tipBullet}>•</Text>
            <Text style={styles.tipText}>{tip.text}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Mark complete button */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={[styles.completeBtn, isComplete && styles.completeBtnDone]}
          onPress={() => !isComplete && markComplete(activeTab)}
          disabled={isComplete}
        >
          <Text style={styles.completeBtnText}>
            {isComplete ? '✓ Completed' : 'Mark as Complete'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#E0E0E0',
  },
  backBtn: { width: 60 },
  backText: { color: '#0468B1', fontSize: 15 },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#333333' },
  tabRow: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#E0E0E0',
  },
  tab: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2, borderBottomColor: '#0468B1',
  },
  tabLabel: { fontSize: 15, color: '#999999' },
  tabLabelActive: { color: '#0468B1', fontWeight: '600' },
  scroll: { flex: 1 },
  scrollContent: { padding: 24 },
  tipRow: {
    flexDirection: 'row', marginBottom: 16,
  },
  tipBullet: { fontSize: 16, color: '#0468B1', marginRight: 10, lineHeight: 22 },
  tipText: { flex: 1, fontSize: 15, color: '#333333', lineHeight: 22 },
  footer: {
    paddingHorizontal: 24, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: '#E0E0E0',
  },
  completeBtn: {
    height: 52, borderRadius: 28, backgroundColor: '#0468B1',
    justifyContent: 'center', alignItems: 'center',
  },
  completeBtnDone: { backgroundColor: '#4CAF50' },
  completeBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
