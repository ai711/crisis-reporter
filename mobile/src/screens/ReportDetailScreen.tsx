import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Image, Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import api, { API_BASE } from '../services/api';

// ── Types ─────────────────────────────────────────────────────────────────

type ReportDetail = {
  id: string;
  serial_number?: number | null;
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
  description?: string | null;
  gps_latitude?: number | null;
  gps_longitude?: number | null;
  gps_accuracy_meters?: number | null;
  location_address?: string | null;
  location_landmark?: string | null;
  location_building_name?: string | null;
  location_note?: string | null;
  building_name?: string | null;
  building_name_reporter?: string | null;
  building_name_osm?: string | null;
  photo_urls?: string[];
  photo_count?: number;
  submitted_at?: string;
  created_at?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const formatDate = (iso?: string | null): string => {
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

/** Convert snake_case option values to Title Case for display. */
const fmtVal = (v?: string | null): string => {
  if (!v) return '—';
  return v.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
};

const fmtList = (items?: string[] | null, other?: string | null): string => {
  if (!items || items.length === 0) return '—';
  const mapped = items.map((v) => fmtVal(v));
  if (other) mapped.push(`Other: ${other}`);
  return mapped.join(', ');
};

/** Resolve relative photo URLs (LocalFileSystemStorage returns "/api/uploads/…"). */
const absUrl = (url: string): string =>
  url.startsWith('/') ? `${API_BASE}${url}` : url;

// ── Sub-components ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({
  label, value, last = false,
}: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.row, last ? styles.rowLast : null]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value || '—'}</Text>
    </View>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export default function ReportDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const route = useRoute<any>();
  const reportId: string = route.params?.reportId ?? '';

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    if (!reportId) {
      setError('Report not found.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.get(`/api/reports/${reportId}`);
      setReport(response.data);
    } catch {
      setError(t('report.detail_load_error'));
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const buildingName =
    report?.building_name ||
    report?.building_name_reporter ||
    report?.building_name_osm ||
    report?.location_building_name ||
    null;

  const hasLocation = !!(
    buildingName ||
    report?.location_address ||
    report?.location_landmark ||
    report?.location_note ||
    report?.gps_latitude != null
  );

  // ── Loading ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={styles.backText}>{t('common.back')}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('reportDetail.header_title')}</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.centred}>
          <ActivityIndicator color="#0468B1" size="large" />
          <Text style={styles.loadingText}>Loading report…</Text>
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
            <Text style={styles.backText}>{t('common.back')}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('reportDetail.header_title')}</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error ?? 'Report not found.'}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchReport}>
            <Text style={styles.retryBtnText}>{t('common.try_again')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────

  const photos = (report.photo_urls ?? []).filter(Boolean);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {report.serial_number ? `Report #${report.serial_number}` : 'Report Detail'}
        </Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Meta: submission date ── */}
        <Text style={styles.submittedDate}>
          {formatDate(report.submitted_at ?? report.created_at)}
        </Text>

        {/* ── PHOTOS ── */}
        {photos.length > 0 && (
          <Section title="📷  PHOTOS">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.photoStrip}
              contentContainerStyle={styles.photoStripContent}
            >
              {photos.map((url, i) => {
                const full = absUrl(url);
                return (
                  <TouchableOpacity
                    key={i}
                    onPress={() => Linking.openURL(full)}
                    activeOpacity={0.8}
                  >
                    <Image
                      source={{ uri: full }}
                      style={styles.photo}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <Text style={styles.photoHint}>{t('reportDetail.photo_hint')}</Text>
          </Section>
        )}

        {/* ── LOCATION ── */}
        {hasLocation && (
          <Section title="📍  LOCATION">
            {buildingName ? (
              <Row label="Building" value={buildingName} />
            ) : null}
            {report.location_address ? (
              <Row label="Address" value={report.location_address} />
            ) : null}
            {report.location_landmark ? (
              <Row label="Landmark" value={report.location_landmark} />
            ) : null}
            {report.location_note ? (
              <Row label="Location note" value={report.location_note} />
            ) : null}
            <Row
              label="GPS"
              value={
                report.gps_latitude != null
                  ? `${report.gps_latitude.toFixed(5)}, ${(report.gps_longitude ?? 0).toFixed(5)}`
                  : 'Not captured'
              }
              last
            />
          </Section>
        )}

        {/* ── DAMAGE ASSESSMENT (Q1-Q8) ── */}
        <Section title="📊  DAMAGE ASSESSMENT">
          {([
            { label: 'Q1 — Damage level',         value: fmtVal(report.damage_level) },
            { label: 'Q2 — Infrastructure type',   value: fmtList(report.infrastructure_types, report.infrastructure_other) },
            { label: 'Q3 — Infrastructure name',   value: report.infrastructure_name ?? null },
            { label: 'Q4 — Disaster type',         value: fmtVal(report.disaster_type) },
            { label: 'Q5 — Debris blocking',       value: fmtVal(report.debris_blocking) },
            { label: 'Q6 — Electricity',           value: fmtVal(report.electricity_condition) },
            { label: 'Q7 — Health services',       value: fmtVal(report.health_services_condition) },
            { label: 'Q8 — Pressing needs',        value: fmtList(report.pressing_needs, report.pressing_needs_other) },
          ] as { label: string; value: string | null }[])
            .filter((item) => item.value && item.value !== '—')
            .map((item, index, arr) => (
              <Row
                key={index}
                label={item.label}
                value={item.value!}
                last={index === arr.length - 1}
              />
            ))}
        </Section>

        {/* ── DESCRIPTION ── */}
        {report.description ? (
          <Section title="📝  DESCRIPTION">
            <Text style={styles.description}>{report.description}</Text>
          </Section>
        ) : null}

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
  headerTitle: { fontSize: 17, fontWeight: 'bold', color: '#333333', textAlign: 'center', flex: 1 },

  centred: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 12, fontSize: 14, color: '#888888' },
  errorText: { fontSize: 15, color: '#D32F2F', textAlign: 'center', marginBottom: 16 },
  retryBtn: {
    backgroundColor: '#0468B1', borderRadius: 20,
    paddingHorizontal: 24, paddingVertical: 10,
  },
  retryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12 },

  submittedDate: { fontSize: 13, color: '#888888', marginBottom: 16 },

  // Photos
  photoStrip: { marginBottom: 4 },
  photoStripContent: { gap: 8 },
  photo: {
    width: 120,
    height: 120,
    borderRadius: 10,
    backgroundColor: '#F0F0F0',
  },
  photoHint: {
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 4,
  },

  // Sections
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

  // Rows
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#EEEEEE',
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { fontSize: 13, color: '#888888', flex: 1, marginRight: 8 },
  rowValue: { fontSize: 14, color: '#333333', flex: 2, textAlign: 'right' },

  // Description
  description: { fontSize: 14, color: '#333333', lineHeight: 22 },
});
