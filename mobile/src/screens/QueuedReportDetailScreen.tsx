import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Image, Alert, ActivityIndicator,
} from 'react-native';
import * as LegacyFS from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import NetInfo from '@react-native-community/netinfo';
import type { QueuedReport } from '../types';
import {
  getQueue,
  removeFromQueue,
  resetItemForRetry,
  syncQueue,
} from '../utils/offlineQueue';
import { API_BASE } from '../services/api';

// ── Screen ────────────────────────────────────────────────────────────────────
// Renders a locally-queued report without making any API calls.
// Receives the full QueuedReport object via navigation params — no local_id lookup
// needed because MyReportsScreen already has the data in memory.

export default function QueuedReportDetailScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();

  const qr: QueuedReport = route.params?.queuedReport;

  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Data URIs loaded from persistent_uri via legacy readAsStringAsync.
  // React Native Image (New Architecture) can't load file:// URIs from
  // documentDirectory, but handles data: URIs reliably.
  const [photoDataUris, setPhotoDataUris] = useState<(string | null)[]>([]);

  // ── Load photos as base64 data URIs ───────────────────────────────────────
  useEffect(() => {
    if (!qr || qr.photos.length === 0) return;
    let cancelled = false;
    (async () => {
      const results: (string | null)[] = [];
      for (const photo of qr.photos) {
        const fileUri = photo.persistent_uri ?? photo.uri;
        try {
          const b64 = await LegacyFS.readAsStringAsync(fileUri, {
            encoding: LegacyFS.EncodingType.Base64,
          });
          results.push(`data:image/jpeg;base64,${b64}`);
        } catch {
          results.push(null); // fall back to file URI (will show blank/error)
        }
      }
      if (!cancelled) setPhotoDataUris(results);
    })();
    return () => { cancelled = true; };
  }, [qr?.local_id]);

  if (!qr) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <Text style={styles.errorText}>Report not found in queue.</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>{t('my_reports.back')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isFailed  = qr.retry_count >= 5;
  const isSyncing = qr.status === 'syncing';

  const loc =
    qr.report.location?.location_building_name ||
    qr.report.location?.location_address ||
    (qr.report.location?.gps_latitude != null
      ? `${qr.report.location.gps_latitude.toFixed(5)}, ${(qr.report.location.gps_longitude ?? 0).toFixed(5)}`
      : t('my_reports.location_not_recorded'));

  const DAMAGE_LABELS: Record<string, string> = {
    complete: t('my_reports.damage_complete'),
    partial:  t('my_reports.damage_partial'),
    minimal:  t('my_reports.damage_minimal'),
  };
  const dmgLabel = DAMAGE_LABELS[qr.report.damage_level as string] ?? qr.report.damage_level ?? '—';

  const statusColor = isFailed ? '#E53E3E' : isSyncing ? '#3182CE' : '#F5A623';
  const statusLabel = isFailed
    ? t('my_reports.offline_upload_failed')
    : isSyncing
      ? t('my_reports.offline_uploading')
      : t('my_reports.offline_label');

  const handleRetry = async () => {
    const netState = await NetInfo.fetch();
    if (!netState.isConnected || netState.isInternetReachable === false) {
      Alert.alert(t('review.still_offline_title'), t('review.still_offline_body'));
      return;
    }
    setRetrying(true);
    try {
      await resetItemForRetry(qr.local_id);
      await syncQueue(API_BASE);
      // Check whether the item was successfully cleared from the queue.
      const queue = await getQueue();
      const stillPending = queue.find((i) => i.local_id === qr.local_id);
      if (stillPending) {
        // Report reached the backend but photos failed — navigate back so
        // the user can see the updated "Submitted" record and pending photo state.
        Alert.alert(
          t('my_reports.retry_partial_title'),
          t('my_reports.retry_partial_body')
        );
      }
      navigation.goBack();
    } catch {
      Alert.alert(t('review.still_offline_title'), t('review.still_offline_body'));
    } finally {
      setRetrying(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      t('review.delete_report_title'),
      t('review.delete_report_body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('review.delete_confirm'),
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await removeFromQueue(qr.local_id);
              navigation.goBack();
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#FFFFFF' }}
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }]}
    >
      {/* Back button */}
      <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
        <Text style={styles.backBtnText}>{t('my_reports.back')}</Text>
      </TouchableOpacity>

      <Text style={styles.title}>{t('my_reports.detail_title')}</Text>

      {/* Pending sync status banner */}
      <View style={[styles.statusBanner, { borderColor: statusColor, backgroundColor: statusColor + '18' }]}>
        <Text style={{ fontSize: 18, marginRight: 8 }}>{isFailed ? '⚠' : isSyncing ? '⬆' : '⏳'}</Text>
        <Text style={[styles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
      </View>

      {/* Detail rows */}
      <DetailRow label={t('my_reports.label_damage')} value={dmgLabel} />
      <DetailRow label={t('my_reports.label_location')} value={loc} />
      <DetailRow label={t('my_reports.label_date')} value={new Date(qr.created_at).toLocaleString()} />
      {(qr.report.infrastructure_types?.length ?? 0) > 0 && (
        <DetailRow
          label={t('my_reports.label_infrastructure')}
          value={(qr.report.infrastructure_types ?? []).join(', ')}
        />
      )}
      {(qr.report as any).disaster_type ? (
        <DetailRow label="Disaster type" value={(qr.report as any).disaster_type as string} />
      ) : null}
      {isFailed && (
        <DetailRow
          label="Upload attempts"
          value={t('my_reports.failed_attempts', { count: qr.retry_count })}
        />
      )}

      {/* Photos */}
      {qr.photos.length > 0 && (
        <View style={styles.photosSection}>
          <Text style={styles.sectionHeader}>{t('my_reports.label_photos')}</Text>
          <View style={styles.photoGrid}>
            {qr.photos.map((photo, i) => {
              const displayUri = photoDataUris[i] ?? (photo.persistent_uri ?? photo.uri);
              return (
                <Image
                  key={i}
                  source={{ uri: displayUri }}
                  style={styles.photoThumb}
                  resizeMode="cover"
                />
              );
            })}
          </View>
          <Text style={styles.photoNote}>{t('my_reports.photos_tap_to_view')}</Text>
        </View>
      )}

      {/* Note: auto-upload is active */}
      <Text style={styles.autoUploadNote}>{t('review.queue_auto_upload')}</Text>

      {/* Action buttons */}
      <View style={styles.actions}>
        {isFailed && (
          <TouchableOpacity
            style={[styles.retryBtn, retrying && { opacity: 0.6 }]}
            onPress={handleRetry}
            disabled={retrying || deleting}
          >
            {retrying
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.retryBtnText}>{t('my_reports.action_retry')}</Text>}
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.deleteBtn, deleting && { opacity: 0.6 }]}
          onPress={handleDelete}
          disabled={deleting || retrying}
        >
          {deleting
            ? <ActivityIndicator color="#E53E3E" size="small" />
            : <Text style={styles.deleteBtnText}>{t('my_reports.action_delete')}</Text>}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ── Sub-component ─────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 15,
    color: '#717782',
    marginBottom: 16,
    textAlign: 'center',
  },
  backBtn: {
    marginBottom: 12,
    alignSelf: 'flex-start',
  },
  backBtnText: {
    fontSize: 14,
    color: '#0468B1',
    fontWeight: '600',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1B1C1C',
    marginBottom: 16,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  detailRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#EBEBEB',
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 11,
    color: '#9CA3AF',
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  detailValue: {
    fontSize: 15,
    color: '#1B1C1C',
  },
  photosSection: {
    marginTop: 20,
  },
  sectionHeader: {
    fontSize: 11,
    color: '#9CA3AF',
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  photoThumb: {
    width: '31%',
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: '#F0F0F0',
  },
  photoNote: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 6,
  },
  autoUploadNote: {
    fontSize: 13,
    color: '#9B6A10',
    fontStyle: 'italic',
    marginTop: 20,
    marginBottom: 8,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  retryBtn: {
    flex: 1,
    height: 48,
    backgroundColor: '#0468B1',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  deleteBtn: {
    flex: 1,
    height: 48,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#E53E3E',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    color: '#E53E3E',
    fontSize: 15,
    fontWeight: '700',
  },
});
