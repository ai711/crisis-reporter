import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round((screenWidth / 375) * size);

type Badge = {
  id: string;
  name: string;
  description: string;
  earned: boolean;
  icon: string;
};

const BADGE_DEFINITIONS: Badge[] = [
  {
    id: 'safety_training',
    name: 'Safety Training',
    description: 'Completed all three parts of the Safety Tips training.',
    earned: false,
    icon: '🛡️',
  },
  {
    id: 'referral',
    name: 'Referral Badge',
    description: 'Referred another reporter who completed safety training. (Coming soon)',
    earned: false,
    icon: '🤝',
  },
];

export default function BadgesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const [loading, setLoading] = useState(true);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [badges, setBadges] = useState<Badge[]>(BADGE_DEFINITIONS);

  useEffect(() => {
    const load = async () => {
      const reporterId = await SecureStore.getItemAsync('cr_reporter_id');
      if (!reporterId || reporterId.startsWith('CR-PENDING-')) {
        setIsAnonymous(true);
        setLoading(false);
        return;
      }

      // Check local safety completion for badge eligibility
      const safetyA = await AsyncStorage.getItem('cr_safety_a_complete');
      const safetyB = await AsyncStorage.getItem('cr_safety_b_complete');
      const partC = await AsyncStorage.getItem('cr_safety_c_complete');
      const safetyEarned = safetyA === 'true' && safetyB === 'true' && partC === 'true';

      setBadges((prev) =>
        prev.map((b) =>
          b.id === 'safety_training' ? { ...b, earned: safetyEarned } : b
        )
      );
      setLoading(false);
    };
    load();
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <ActivityIndicator color="#0468B1" style={{ marginTop: 40 }} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Badges</Text>
        <View style={styles.backBtn} />
      </View>

      {isAnonymous ? (
        <View style={styles.gateContainer}>
          <Text style={styles.gateIcon}>🏅</Text>
          <Text style={styles.gateTitle}>Badges are for verified reporters</Text>
          <Text style={styles.gateBody}>
            Create an account to earn badges for completing safety training and referring others.
          </Text>
          <TouchableOpacity
            style={styles.gateBtn}
            onPress={() => navigation.navigate('ReporterProfileScreen')}
          >
            <Text style={styles.gateBtnText}>Create Account</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {badges.map((badge) => (
            <View key={badge.id} style={[styles.badgeCard, !badge.earned && styles.badgeCardLocked]}>
              <Text style={styles.badgeIcon}>{badge.icon}</Text>
              <View style={styles.badgeInfo}>
                <Text style={[styles.badgeName, !badge.earned && styles.badgeNameLocked]}>
                  {badge.name}
                </Text>
                <Text style={styles.badgeDesc}>{badge.description}</Text>
                {badge.earned && <Text style={styles.badgeEarned}>✓ Earned</Text>}
                {!badge.earned && <Text style={styles.badgeLocked}>🔒 Not yet earned</Text>}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F3F2' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.92)',
    height: 56,
  },
  backBtn: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  headerTitle: { fontSize: scale(17), fontWeight: '600', color: '#1B1C1C' },
  gateContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  gateIcon: { fontSize: scale(48), marginBottom: 16 },
  gateTitle: { fontSize: scale(18), fontWeight: '600', color: '#1B1C1C', textAlign: 'center', marginBottom: 8 },
  gateBody: { fontSize: scale(14), color: '#717782', textAlign: 'center', lineHeight: scale(20), marginBottom: 24 },
  gateBtn: {
    backgroundColor: '#0468B1', borderRadius: 28, height: 52,
    paddingHorizontal: 32, justifyContent: 'center', alignItems: 'center',
  },
  gateBtnText: { color: '#FFFFFF', fontSize: scale(16), fontWeight: '600' },
  scrollContent: { padding: 24 },
  badgeCard: {
    flexDirection: 'row', padding: 16, borderRadius: 12,
    backgroundColor: 'rgba(4,104,177,0.06)', marginBottom: 16,
    borderWidth: 1, borderColor: '#0468B1',
  },
  badgeCardLocked: { backgroundColor: '#F0EDED', borderColor: '#E4E2E1' },
  badgeIcon: { fontSize: scale(36), marginRight: 16 },
  badgeInfo: { flex: 1 },
  badgeName: { fontSize: scale(16), fontWeight: 'bold', color: '#0468B1', marginBottom: 4 },
  badgeNameLocked: { color: '#9CA3AF' },
  badgeDesc: { fontSize: scale(13), color: '#717782', lineHeight: 18, marginBottom: 6 },
  badgeEarned: { fontSize: scale(13), color: '#38A169', fontWeight: '600' },
  badgeLocked: { fontSize: scale(13), color: '#9CA3AF' },
});
