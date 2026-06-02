import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round(screenWidth / 375 * size);

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>About</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Logo section */}
        <View style={styles.logoSection}>
          <View style={styles.logoCircle}>
            <MaterialIcons name="security" size={scale(36)} color="#FFFFFF" />
          </View>
          <Text style={styles.appTitle}>Crisis Reporter</Text>
          <Text style={styles.appSubtitle}>By UNDP</Text>
        </View>

        {/* Card 1 — About */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>ABOUT</Text>
          <Text style={styles.cardBody}>
            Crisis Reporter is a community-driven damage reporting platform built for UNDP. It enables rapid infrastructure assessment following sudden-onset disasters, helping UNDP coordinate crisis response faster and more effectively.
          </Text>
        </View>

        {/* Card 2 — How It Works */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>HOW IT WORKS</Text>
          <Text style={styles.cardBody}>
            Reporters submit photos and damage assessments from the field. UNDP staff review and verify reports on the dashboard. Verified data is exported for crisis response coordination with partner organisations.
          </Text>
        </View>

        {/* Card 3 — Links */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>RESOURCES</Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://www.undp.org/privacy-policy')}
            activeOpacity={0.7}
          >
            <MaterialIcons name="policy" size={scale(20)} color="#0468B1" />
            <Text style={styles.linkText}>Privacy Policy</Text>
            <MaterialIcons name="chevron-right" size={scale(18)} color="#C1C7D2" />
          </TouchableOpacity>
          <View style={styles.rowSeparator} />
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://www.undp.org')}
            activeOpacity={0.7}
          >
            <MaterialIcons name="language" size={scale(20)} color="#0468B1" />
            <Text style={styles.linkText}>UNDP Website</Text>
            <MaterialIcons name="chevron-right" size={scale(18)} color="#C1C7D2" />
          </TouchableOpacity>
        </View>

        {/* Card 4 — Version */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>APP INFO</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Version</Text>
            <Text style={styles.infoValue}>1.0.0</Text>
          </View>
        </View>

        <Text style={styles.versionNote}>
          Crisis Reporter is built for UNDP's InnoCentive Crisis Mapping Challenge
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F6F3F2' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  backBtn: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: scale(17), fontWeight: '600', color: '#1B1C1C' },
  scrollContent: { paddingBottom: 40 },

  logoSection: { alignItems: 'center', marginTop: 24, marginBottom: 32 },
  logoCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#0468B1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appTitle: {
    fontSize: scale(22),
    fontWeight: '900',
    color: '#0468B1',
    marginTop: 12,
    textAlign: 'center',
  },
  appSubtitle: { fontSize: scale(14), color: '#717782', marginTop: 4, textAlign: 'center' },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    padding: 20,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: scale(11),
    fontWeight: '700',
    color: '#717782',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  cardBody: {
    fontSize: scale(14),
    color: '#414751',
    lineHeight: scale(14) * 1.6,
  },

  linkRow: {
    height: 48,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  linkText: { flex: 1, fontSize: scale(15), fontWeight: '600', color: '#1B1C1C' },
  rowSeparator: { height: 1, backgroundColor: '#F6F3F2' },

  infoRow: { flexDirection: 'row', alignItems: 'center' },
  infoLabel: { flex: 1, fontSize: scale(14), color: '#414751' },
  infoValue: { fontSize: scale(14), color: '#717782' },

  versionNote: {
    fontSize: scale(12),
    color: '#9CA3AF',
    textAlign: 'center',
    paddingHorizontal: screenWidth * 0.1,
    marginTop: 8,
  },
});
