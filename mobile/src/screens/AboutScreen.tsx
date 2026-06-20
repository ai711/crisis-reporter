import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions, Linking, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

const { width: _screenWidthRaw } = Dimensions.get('window');
const screenWidth = _screenWidthRaw || 375;
const scale = (size: number) => Math.round(screenWidth / 375 * size);

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('about.title')}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Logo section */}
        <View style={styles.logoSection}>
          <View style={styles.logoCircle}>
            <MaterialIcons name="security" size={scale(36)} color="#FFFFFF" />
          </View>
          <Text style={styles.appTitle}>{t('app.name')}</Text>
          <Text style={styles.appSubtitle}>{t('about.powered_by')}</Text>
        </View>

        {/* Card 1 — About */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('about.section_about')}</Text>
          <Text style={styles.cardBody}>{t('about.about_body')}</Text>
        </View>

        {/* Card 2 — How It Works */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('about.section_how')}</Text>
          <Text style={styles.cardBody}>{t('about.how_body')}</Text>
        </View>

        {/* Card 3 — Links */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('about.section_resources')}</Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setShowPrivacyModal(true)}
            activeOpacity={0.7}
          >
            <MaterialIcons name="policy" size={scale(20)} color="#0468B1" />
            <Text style={styles.linkText}>{t('about.privacy_policy')}</Text>
            <MaterialIcons name="chevron-right" size={scale(18)} color="#C1C7D2" />
          </TouchableOpacity>
          <View style={styles.rowSeparator} />
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://www.undp.org')}
            activeOpacity={0.7}
          >
            <MaterialIcons name="language" size={scale(20)} color="#0468B1" />
            <Text style={styles.linkText}>{t('about.undp_website')}</Text>
            <MaterialIcons name="chevron-right" size={scale(18)} color="#C1C7D2" />
          </TouchableOpacity>
        </View>

        {/* Privacy Policy coming-soon modal */}
        <Modal
          visible={showPrivacyModal}
          transparent
          animationType="slide"
          onRequestClose={() => setShowPrivacyModal(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{t('settings.privacy_policy')}</Text>
                <TouchableOpacity onPress={() => setShowPrivacyModal(false)} style={styles.modalCloseBtn}>
                  <Text style={styles.modalClose}>✕</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.privacyBody}>
                <View style={styles.privacyIconCircle}>
                  <MaterialIcons name="security" size={scale(28)} color="#0468B1" />
                </View>
                <Text style={styles.privacyHeading}>{t('about.privacy_coming_soon')}</Text>
                <Text style={styles.privacyText}>
                  Our Privacy Policy is being finalized and will be available here shortly.
                </Text>
                <Text style={styles.privacySubText}>
                  Crisis Reporter is operated by UNDP. Data collected is used solely for humanitarian response and is never shared with third parties without your consent.
                </Text>
                <TouchableOpacity
                  style={styles.privacyCloseBtn}
                  onPress={() => setShowPrivacyModal(false)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.privacyCloseBtnText}>{t('about.privacy_got_it')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Card 4 — Version */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>{t('about.section_info')}</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{t('about.version_label')}</Text>
            <Text style={styles.infoValue}>{t('about.version_value')}</Text>
          </View>
        </View>

        <Text style={styles.versionNote}>{t('about.version_note')}</Text>
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

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  modalTitle: { fontSize: scale(16), fontWeight: '700', color: '#1B1C1C' },
  modalCloseBtn: { padding: 4 },
  modalClose: { fontSize: scale(18), color: '#9CA3AF' },
  privacyBody: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 20, gap: 12 },
  privacyIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#EBF5FB', justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  privacyHeading: { fontSize: scale(18), fontWeight: '700', color: '#1A2B4A', textAlign: 'center' },
  privacyText: { fontSize: scale(14), color: '#718096', lineHeight: scale(14) * 1.65, textAlign: 'center' },
  privacySubText: { fontSize: scale(13), color: '#A0AEC0', lineHeight: scale(13) * 1.6, textAlign: 'center' },
  privacyCloseBtn: {
    marginTop: 8, width: '100%', height: 48, borderRadius: 24,
    backgroundColor: '#0468B1', justifyContent: 'center', alignItems: 'center',
  },
  privacyCloseBtnText: { color: '#FFFFFF', fontSize: scale(15), fontWeight: '600' },
});
