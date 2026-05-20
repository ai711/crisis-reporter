import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

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
    q: 'Can I edit a report after submitting it?',
    a: 'Reports cannot be edited after submission. If you need to update information, you can submit a new report for the same location. UNDP staff will see all reports for a location and consider the most recent.',
  },
  {
    q: 'What do the damage levels mean?',
    a: 'Minimal or No Damage: the building is structurally sound with only cosmetic damage. Partially Damaged: the building is repairable but should be used with caution. Completely Destroyed: the building is structurally unsafe.',
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

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
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
              <Text style={styles.faqChevron}>{openIndex === index ? '▲' : '▼'}</Text>
            </View>
            {openIndex === index && (
              <Text style={styles.faqAnswer}>{item.a}</Text>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
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
  scrollContent: { padding: 16 },
  faqItem: {
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
    paddingVertical: 16, paddingHorizontal: 8,
  },
  faqQuestion: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
  },
  faqQuestionText: {
    flex: 1, fontSize: 15, fontWeight: '600', color: '#333333', lineHeight: 22, marginRight: 12,
  },
  faqChevron: { fontSize: 12, color: '#0468B1', marginTop: 4 },
  faqAnswer: {
    fontSize: 14, color: '#555555', lineHeight: 21, marginTop: 10,
  },
});
