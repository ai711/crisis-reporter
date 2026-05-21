import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import api from '../services/api';

// ── Types ─────────────────────────────────────────────────────────────────

type ReportDetail = {
  id: string;
  damage_level?: string;
  infrastructure_types?: string[];
  infrastructure_other?: string;
  infrastructure_name?: string;
  disaster_type?: string;
  debris_blocking?: string;
  electricity_condition?: string;
  health_services_condition?: string;
  pressing_needs?: string[];
  pressing_needs_other?: string;
  gps_latitude?: number;
  gps_longitude?: number;
  gps_available?: boolean;
  location_address?: string;
  location_landmark?: string;
  building_name?: string;
  submitted_at?: string;
  created_at?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const formatDate = (iso?: string): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const formatList = (items?: string[], other?: string): string => {
  if (!items || items.length === 0) return '—';
  const all = other ? [...items, `Other: ${other}`] : items;
  return all.join(', ');
};

// ── Component ─────────────────────────────────────────────────────────────

export default function ReportDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<any>();
  const reportId: string = route.params?.reportId ?? '';

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = async () => {
    if (!reportId) {
      setError('Report not found.');
      setLoading(false);
      return;
    }
    try {
      const response = await api.get(`/api/reports/${reportId}`);
      setReport(response.data);
      setError(null);
    } catch {
      setError('Could not load report. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReport();
  }, [reportId]);

  // ── Loading ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Report</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.centred}>
          <ActivityIndicator color="#0468B1" size="large" />
        </View>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────

  if (error || !report) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Report</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error ?? 'Report not found.'}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setError(null);
              setLoading(true);
              fetchReport();
            }}
          >
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Report Detail</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Submission date */}
        <Text style={styles.submittedDate}>
          Submitted: {formatDate(report.submitted_at ?? report.created_at)}
        </Text>

        {/* ── SECTION 1: LOCATION ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>LOCATION</Text>

          {report.building_name ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Building</Text>
              <Text style={styles.rowValue}>{report.building_name}</Text>
            </View>
          ) : null}

          {report.location_address ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Address</Text>
              <Text style={styles.rowValue}>{report.location_address}</Text>
            </View>
          ) : null}

          {report.location_landmark ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Landmark</Text>
              <Text style={styles.rowValue}>{report.location_landmark}</Text>
            </View>
          ) : null}

          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.rowLabel}>GPS</Text>
            <Text style={[
              styles.rowValue,
              report.gps_available ? styles.gpsGreen : styles.gpsOrange,
            ]}>
              {report.gps_available && report.gps_latitude != null
                ? `${report.gps_latitude.toFixed(5)}, ${(report.gps_longitude ?? 0).toFixed(5)}`
                : 'Not captured'
              }
            </Text>
          </View>
        </View>

        {/* ── SECTION 2: QUESTIONS ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>QUESTIONS</Text>

          {([
            { label: 'Damage level', value: report.damage_level },
            {
              label: 'Infrastructure type',
              value: formatList(report.infrastructure_types, report.infrastructure_other),
            },
            { label: 'Infrastructure name', value: report.infrastructure_name },
            { label: 'Disaster type', value: report.disaster_type },
            { label: 'Debris clearing needed', value: report.debris_blocking },
            { label: 'Electricity condition', value: report.electricity_condition },
            { label: 'Health services', value: report.health_services_condition },
            {
              label: 'Pressing needs',
              value: formatList(report.pressing_needs, report.pressing_needs_other),
            },
          ] as { label: string; value: string | undefined }[])
            .filter((item) => !!item.value && item.value !== '—')
            .map((item, index, arr) => (
              <View
                key={index}
                style={[styles.row, index === arr.length - 1 ? styles.rowLast : null]}
              >
                <Text style={styles.rowLabel}>{item.label}</Text>
                <Text style={styles.rowValue}>{item.value}</Text>
              </View>
            ))}
        </View>

        <View style={{ height: insets.bottom + 24 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
  },
  backBtn: { width: 60 },
  backText: { color: '#0468B1', fontSize: 15 },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#333333' },
  centred: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { fontSize: 15, color: '#D32F2F', textAlign: 'center', marginBottom: 16 },
  retryBtn: {
    backgroundColor: '#0468B1', borderRadius: 20,
    paddingHorizontal: 24, paddingVertical: 10,
  },
  retryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 12 },

  submittedDate: {
    fontSize: 13,
    color: '#888888',
    marginBottom: 16,
    textAlign: 'center',
  },

  section: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#EEEEEE',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888888',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    fontSize: 13,
    color: '#888888',
    flex: 1,
    marginRight: 8,
  },
  rowValue: {
    fontSize: 14,
    color: '#333333',
    flex: 2,
    textAlign: 'right',
  },
  gpsGreen: { color: '#2E7D32', fontSize: 12 },
  gpsOrange: { color: '#E65100', fontSize: 12 },
});
