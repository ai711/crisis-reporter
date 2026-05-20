import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Modal, ActivityIndicator, type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Map as MLMap,
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  UserLocation,
  type PressEventWithFeatures,
} from '@maplibre/maplibre-react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import api from '../services/api';

// Light grey streets style — matches web and report submission map
const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`;

type DamageLevel = 'minimal' | 'partial' | 'destroyed';

type ReportPin = {
  id: string;
  latitude: number;
  longitude: number;
  damage_level: DamageLevel;
  infrastructure_type: string;
  submitted_at: string;
  photo_url?: string;
};

const PIN_COLOURS: Record<DamageLevel, string> = {
  minimal: '#4CAF50',
  partial: '#FF9800',
  destroyed: '#F44336',
};

const PIN_LABELS: Record<DamageLevel, string> = {
  minimal: 'Minimal / No Damage',
  partial: 'Partially Damaged',
  destroyed: 'Completely Destroyed',
};

const normaliseDamageLevel = (raw: any): DamageLevel => {
  if (!raw) return 'minimal';
  const val = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (val.includes('destroy') || val.includes('complet')) return 'destroyed';
  if (val.includes('partial')) return 'partial';
  return 'minimal';
};

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState<ReportPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [selectedReport, setSelectedReport] = useState<ReportPin | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/reports?limit=200');
      const pins: ReportPin[] = response.data
        .filter((r: any) => r.gps_latitude && r.gps_longitude)
        .map((r: any) => ({
          id: r.id,
          latitude: parseFloat(r.gps_latitude),
          longitude: parseFloat(r.gps_longitude),
          damage_level: normaliseDamageLevel(r.damage_level),
          infrastructure_type: r.infrastructure_types?.[0] ?? r.infrastructure_type ?? 'Unknown',
          submitted_at: r.submitted_at ?? r.created_at,
          photo_url: undefined,
        }));
      setReports(pins);
    } catch {
      // Offline or error — pins stay empty
    } finally {
      setLoading(false);
    }
  };

  const recentreMap = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        await Location.requestForegroundPermissionsAsync();
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      cameraRef.current?.easeTo({
        center: [loc.coords.longitude, loc.coords.latitude],
        zoom: 14,
        duration: 500,
      });
    } catch {
      // GPS unavailable
    }
  };

  useEffect(() => {
    NetInfo.fetch().then((state) => {
      setIsOnline(!!state.isConnected);
      if (state.isConnected) {
        fetchReports();
      } else {
        setLoading(false);
      }
    });

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = !!state.isConnected && !!state.isInternetReachable;
      setIsOnline(online);
      if (online && reports.length === 0) {
        fetchReports();
      }
    });

    return () => unsubscribe();
  }, []);

  const reportsGeoJSON: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: reports.map((r) => ({
      type: 'Feature',
      id: r.id,
      geometry: {
        type: 'Point',
        coordinates: [r.longitude, r.latitude],
      },
      properties: {
        id: r.id,
        damage_level: r.damage_level,
        colour: PIN_COLOURS[r.damage_level],
        infrastructure_type: r.infrastructure_type,
        submitted_at: r.submitted_at,
      },
    })),
  };

  const handlePinPress = (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
    const { features } = event.nativeEvent;
    if (!features?.length) return;
    const props = features[0].properties;
    const report = reports.find((r) => r.id === props?.id);
    if (report) setSelectedReport(report);
  };

  if (!isOnline && reports.length === 0) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Crisis Reporter</Text>
        </View>
        <View style={styles.offlineContainer}>
          <Text style={styles.offlineIcon}>🗺️</Text>
          <Text style={styles.offlineTitle}>Map unavailable</Text>
          <Text style={styles.offlineBody}>
            The map requires an internet connection. Please check your connection and try again.
          </Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              NetInfo.fetch().then((state) => {
                if (state.isConnected) {
                  setIsOnline(true);
                  fetchReports();
                }
              });
            }}
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Crisis Reporter</Text>
      </View>

      <View style={styles.mapContainer}>
        <MLMap
          style={styles.map}
          mapStyle={MAP_STYLE_URL}
          logo={false}
          attribution={false}
          onPress={() => setSelectedReport(null)}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{ center: [20, 20], zoom: 5 }}
          />

          <UserLocation />

          {reports.length > 0 && (
            <GeoJSONSource
              id="reports-source"
              data={reportsGeoJSON}
              onPress={handlePinPress}
            >
              <Layer
                id="reports-circles"
                type="circle"
                paint={{
                  'circle-radius': 10,
                  'circle-color': ['get', 'colour'],
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#FFFFFF',
                }}
              />
            </GeoJSONSource>
          )}
        </MLMap>

        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color="#0468B1" size="large" />
          </View>
        )}

        <TouchableOpacity style={styles.recentreBtn} onPress={recentreMap}>
          <Text style={styles.recentreIcon}>◎</Text>
        </TouchableOpacity>

        <View style={styles.legend}>
          {(Object.entries(PIN_LABELS) as [DamageLevel, string][]).map(([level, label]) => (
            <View key={level} style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: PIN_COLOURS[level] }]} />
              <Text style={styles.legendLabel}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      <Modal
        visible={!!selectedReport}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedReport(null)}
      >
        <TouchableOpacity
          style={styles.sheetOverlay}
          activeOpacity={1}
          onPress={() => setSelectedReport(null)}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            {selectedReport && (
              <>
                <View style={styles.sheetHandle} />
                <View style={styles.sheetHeader}>
                  <View style={[styles.sheetDot, { backgroundColor: PIN_COLOURS[selectedReport.damage_level] }]} />
                  <Text style={styles.sheetDamage}>{PIN_LABELS[selectedReport.damage_level]}</Text>
                  <TouchableOpacity onPress={() => setSelectedReport(null)}>
                    <Text style={styles.sheetClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.sheetInfra}>
                  Infrastructure: {selectedReport.infrastructure_type}
                </Text>
                <Text style={styles.sheetDate}>
                  Submitted: {new Date(selectedReport.submitted_at).toLocaleDateString()}
                </Text>
                <Text style={styles.sheetCoords}>
                  {selectedReport.latitude.toFixed(5)}, {selectedReport.longitude.toFixed(5)}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#E0E0E0',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#0468B1', textAlign: 'center' },
  mapContainer: { flex: 1, position: 'relative' },
  map: { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center', alignItems: 'center',
  },
  recentreBtn: {
    position: 'absolute', bottom: 120, right: 16,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4, elevation: 4,
  },
  recentreIcon: { fontSize: 22, color: '#0468B1' },
  legend: {
    position: 'absolute', bottom: 120, left: 16,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 8, padding: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 4, elevation: 3,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  legendDot: { width: 12, height: 12, borderRadius: 6, marginRight: 8 },
  legendLabel: { fontSize: 11, color: '#333333' },
  offlineContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  offlineIcon: { fontSize: 48, marginBottom: 16 },
  offlineTitle: { fontSize: 18, fontWeight: 'bold', color: '#333333', marginBottom: 8 },
  offlineBody: {
    fontSize: 14, color: '#666666', textAlign: 'center', lineHeight: 20, marginBottom: 24,
  },
  retryBtn: {
    backgroundColor: '#0468B1', borderRadius: 28, height: 52,
    paddingHorizontal: 40, justifyContent: 'center', alignItems: 'center',
  },
  retryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  sheetOverlay: {
    flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)',
  },
  sheet: {
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, minHeight: 180,
  },
  sheetHandle: {
    width: 40, height: 4, backgroundColor: '#E0E0E0',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 12,
  },
  sheetDot: { width: 14, height: 14, borderRadius: 7, marginRight: 10 },
  sheetDamage: { flex: 1, fontSize: 16, fontWeight: 'bold', color: '#333333' },
  sheetClose: { fontSize: 16, color: '#999999', padding: 4 },
  sheetInfra: { fontSize: 14, color: '#555555', marginBottom: 4 },
  sheetDate: { fontSize: 13, color: '#888888', marginBottom: 4 },
  sheetCoords: { fontSize: 12, color: '#AAAAAA' },
});
