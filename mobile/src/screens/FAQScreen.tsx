import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Dimensions, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import api from '../services/api';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round(screenWidth / 375 * size);

const FAQ_ITEMS = [
  {
    q: 'What is Crisis Reporter?',
    a: 'Crisis Reporter is a UNDP tool that lets community members document damage to buildings and infrastructure after a disaster. Your reports help UNDP direct emergency resources to the right places faster.',
  },
  {
    q: 'Do I need internet to submit a report?',
    a: 'You can fill in your report offline. Your text answers and GPS location are saved to your device. Photos require an internet connection to upload. When you reconnect, your report will send automatically.',
  },
  {
    q: 'How do I enable GPS on my device?',
    a: 'On Android: go to Settings → Location and turn it on. Then open Crisis Reporter and try again. If the app still cannot access your location, go to Settings → Apps → Crisis Reporter → Permissions and enable Location.',
  },
  {
    q: 'Is my personal information shared?',
    a: 'Anonymous reports contain no personal information. If you create a verified account with an email or phone number, that contact information is stored securely and shared only with authorised UNDP staff.',
  },
  {
    q: 'How do I know my report was received?',
    a: 'After submission you will see a confirmation screen with your report reference number. You can also view all your submitted reports in the My Reports section.',
  },
  {
    q: 'How do I earn a Safety Training badge?',
    a: 'Complete all three parts of Safety Tips — Part A covers all 9 disaster types, Part B covers reporting guidelines, Part C covers first aid. Then add an email or phone number to your profile. The badge is awarded automatically.',
  },
  {
    q: 'What if my country is not in the list?',
    a: 'Crisis Reporter is currently operational in countries where UNDP is actively responding to a crisis. If your country is not listed it means UNDP has not yet activated it. Check back during an active crisis event.',
  },
  {
    q: 'Can I edit a report after submitting it?',
    a: 'Reports cannot be edited after submission. If you need to update information, you can submit a new report for the same location. UNDP staff will see all reports for a location and consider the most recent.',
  },
  {
    q: 'What do the damage levels mean?',
    a: 'Minimal or No Damage: the building is structurally sound with only cosmetic damage. Partially Damaged: the building is repairable but should be used with caution. Completely Destroyed: the building is structurally unsafe.',
  },
  {
    q: 'Is my data secure?',
    a: 'Yes. All data is transmitted over encrypted connections and stored securely. Photos are anonymised before storage. Your personal details are never shared with third parties.',
  },
  {
    q: 'How do I contact UNDP about a report?',
    a: 'Crisis Reporter is for damage documentation only. For emergency assistance, contact your local emergency services. For questions about UNDP operations in your area, visit undp.org.',
  },
];

export default function FAQScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
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
        <Text style={styles.headerTitle}>FAQ</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {FAQ_ITEMS.map((item, index) => (
          <TouchableOpacity
            key={index}
            style={styles.faqItem}
            onPress={() => setOpenIndex(openIndex === index ? null : index)}
            activeOpacity={0.8}
          >
            <View style={styles.faqQuestion}>
              <Text style={styles.faqQuestionText}>{item.q}</Text>
              <MaterialIcons
                name={openIndex === index ? 'expand-more' : 'chevron-right'}
                size={scale(20)}
                color="#717782"
              />
            </View>
            {openIndex === index && (
              <>
                <View style={styles.separator} />
                <Text style={styles.faqAnswer}>{item.a}</Text>
              </>
            )}
          </TouchableOpacity>
        ))}

        {/* Contact Support */}
        <View style={styles.contactSection}>
          <Text style={styles.contactPrompt}>Still have questions?</Text>
          <TouchableOpacity
            onPress={() => Linking.openURL(`mailto:${supportEmail}`)}
            activeOpacity={0.7}
          >
            <Text style={styles.contactLink}>Contact Support</Text>
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
