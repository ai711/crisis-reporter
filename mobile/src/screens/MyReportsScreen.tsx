import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect, useCallback } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Image, ActivityIndicator,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import { useAuthStore } from "../stores/authStore";
import api from "../services/api";

interface ReporterReport {
  id: string;
  damage_level: "minimal" | "partial" | "complete";
  submitted_at: string;
  location: {
    location_address: string | null;
    gps_latitude: number | null;
    gps_longitude: number | null;
  } | null;
  photo_count: number;
  first_photo_url: string | null;
}

interface ReportsResponse {
  items: ReporterReport[];
  next_cursor: string | null;
}

const DAMAGE_COLOR: Record<string, string> = {
  complete: "#e53935",
  partial: "#f57c00",
  minimal: "#388e3c",
};

const DAMAGE_LABEL: Record<string, string> = {
  complete: "Completely Damaged",
  partial: "Partially Damaged",
  minimal: "Minimal / No Damage",
};

function formatLocation(report: ReporterReport): string {
  if (report.location?.location_address) return report.location.location_address;
  if (report.location?.gps_latitude != null && report.location?.gps_longitude != null) {
    return `${report.location.gps_latitude.toFixed(4)}, ${report.location.gps_longitude.toFixed(4)}`;
  }
  return "Location not recorded";
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const PAGE_SIZE = 20;

export default function MyReportsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { reporterId } = useAuthStore();

  const [reports, setReports] = useState<ReporterReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const fetchReports = useCallback(async (cursor?: string) => {
    if (!reporterId) {
      setLoading(false);
      return;
    }

    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError(null);
    }

    try {
      const params: Record<string, string> = {
        reporter_id: reporterId,
        limit: String(PAGE_SIZE),
      };
      if (cursor) params.cursor = cursor;

      const res = await api.get<ReportsResponse>("/api/reports", { params });
      const data = res.data;

      if (cursor) {
        setReports((prev) => [...prev, ...data.items]);
      } else {
        setReports(data.items);
      }
      setNextCursor(data.next_cursor);
    } catch {
      setError("Failed to load reports. Please try again.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [reporterId]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("home.myReports")}</Text>
      </View>

      {loading ? (
        <View style={styles.centred}>
          <ActivityIndicator size="large" color="#0468B1" />
        </View>
      ) : error ? (
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => fetchReports()}>
            <Text style={styles.retryBtnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : reports.length === 0 ? (
        <View style={styles.centred}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyText}>No reports submitted yet</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {reports.map((report) => (
            <View key={report.id} style={styles.card}>
              {report.first_photo_url ? (
                <Image
                  source={{ uri: report.first_photo_url }}
                  style={styles.thumbnail}
                />
              ) : (
                <View style={styles.thumbnailPlaceholder}>
                  <Text style={styles.thumbnailIcon}>📷</Text>
                </View>
              )}
              <View style={styles.cardBody}>
                <View style={[
                  styles.damageBadge,
                  { backgroundColor: (DAMAGE_COLOR[report.damage_level] ?? "#999") + "22" },
                ]}>
                  <Text style={[
                    styles.damageBadgeText,
                    { color: DAMAGE_COLOR[report.damage_level] ?? "#999" },
                  ]}>
                    {DAMAGE_LABEL[report.damage_level] ?? report.damage_level}
                  </Text>
                </View>
                <Text style={styles.cardDate}>{formatDate(report.submitted_at)}</Text>
                <Text style={styles.cardLocation} numberOfLines={2}>
                  📍 {formatLocation(report)}
                </Text>
              </View>
            </View>
          ))}

          {nextCursor && (
            <TouchableOpacity
              style={[styles.loadMoreBtn, loadingMore && styles.loadMoreBtnDisabled]}
              onPress={() => fetchReports(nextCursor)}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <ActivityIndicator color="#0468B1" size="small" />
              ) : (
                <Text style={styles.loadMoreText}>Load More</Text>
              )}
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },
  header: {
    backgroundColor: "#1A2B4A",
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  backBtn: { color: "#fff", fontSize: 22 },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
  },
  errorText: { fontSize: 16, color: "#d32f2f", textAlign: "center" },
  retryBtn: {
    backgroundColor: "#0468B1",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  retryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  emptyIcon: { fontSize: 64 },
  emptyText: { fontSize: 16, color: "#666" },
  list: { flex: 1 },
  listContent: { padding: 16, gap: 12 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    flexDirection: "row",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  thumbnail: { width: 88, height: 88 },
  thumbnailPlaceholder: {
    width: 88,
    height: 88,
    backgroundColor: "#f0f2f5",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbnailIcon: { fontSize: 28 },
  cardBody: {
    flex: 1,
    padding: 12,
    gap: 4,
    justifyContent: "center",
  },
  damageBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 20,
    marginBottom: 2,
  },
  damageBadgeText: { fontSize: 12, fontWeight: "600" },
  cardDate: { fontSize: 13, color: "#888" },
  cardLocation: { fontSize: 13, color: "#1A2B4A", marginTop: 2 },
  loadMoreBtn: {
    marginTop: 8,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#0468B1",
    paddingVertical: 13,
    alignItems: "center",
  },
  loadMoreBtnDisabled: { opacity: 0.6 },
  loadMoreText: { color: "#0468B1", fontWeight: "600", fontSize: 15 },
});
