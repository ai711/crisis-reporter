import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import api from '../services/api';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round(screenWidth / 375 * size);

const FAQ_KEYS = [
  'faq_m.q1', 'faq_m.q2', 'faq_m.q3', 'faq_m.q4', 'faq_m.q5',
  'faq_m.q6', 'faq_m.q7', 'faq_m.q8', 'faq_m.q9', 'faq_m.q10', 'faq_m.q11',
];

export default function FAQScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [supportEmail, setSupportEmail] = useState('support@crisisreporter.org');

  useEffect(() => {
    api.get('/api/settings/public')
      .then((r) => { if (r.data?.support_email) setSupportEmail(r.data.support_email); })
      .catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={scale(24)} color="#0468B1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('faq.title')}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {FAQ_KEYS.map((baseKey, index) => (
          <TouchableOpacity
            key={index}
            style={styles.faqItem}
            onPress={() => setOpenIndex(openIndex === index ? null : index)}
            activeOpacity={0.8}
          >
            <View style={styles.faqQuestion}>
              <Text style={styles.faqQuestionText}>{t(`${baseKey}_question`)}</Text>
              <MaterialIcons
                name={openIndex === index ? 'expand-more' : 'chevron-right'}
                size={scale(20)}
                color="#717782"
              />
            </View>
            {openIndex === index && (
              <>
                <View style={styles.separator} />
                <Text style={styles.faqAnswer}>{t(`${baseKey}_answer`)}</Text>
              </>
            )}
          </TouchableOpacity>
        ))}

        {/* Contact Support */}
        <View style={styles.contactSection}>
          <Text style={styles.contactPrompt}>{t('faq.contact_prompt')}</Text>
          <TouchableOpacity
            onPress={() => Linking.openURL(`mailto:${supportEmail}`)}
            activeOpacity={0.7}
          >
            <Text style={styles.contactLink}>{t('faq.contact_link')}</Text>
          </TouchableOpacity>
        </View>
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
  scrollContent: { paddingTop: 16, paddingBottom: 32 },
  faqItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginHorizontal: screenWidth * 0.05,
    marginBottom: 8,
    overflow: 'hidden',
  },
  faqQuestion: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  faqQuestionText: {
    flex: 1,
    fontSize: scale(15),
    fontWeight: '600',
    color: '#1B1C1C',
    marginRight: 8,
  },
  separator: { height: 1, backgroundColor: '#F6F3F2' },
  faqAnswer: {
    padding: 16,
    paddingTop: 12,
    fontSize: scale(14),
    color: '#414751',
    lineHeight: scale(14) * 1.6,
  },
  contactSection: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: screenWidth * 0.05,
  },
  contactPrompt: {
    fontSize: scale(13),
    color: '#717782',
    marginBottom: 6,
  },
  contactLink: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#0468B1',
    textDecorationLine: 'underline',
  },
});
