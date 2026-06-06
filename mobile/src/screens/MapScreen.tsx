import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  Dimensions,
  Animated,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
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
import { MaterialIcons } from '@expo/vector-icons';
import api from '../services/api';

const { width: screenWidth } = Dimensions.get('window');
const scale = (size: number) => Math.round((screenWidth / 375) * size);

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
  minimal: '#38A169',
  partial: '#F2994A',
  destroyed: '#E53E3E',
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

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const BUILDINGS_MIN_ZOOM = 14;

/** Parse `[out:json];way["building"](bbox);out geom;` response into GeoJSON polygons. */
function overpassToGeoJSON(elements: any[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = elements
    .filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3)
    .map((el) => {
      const ring: [number, number][] = el.geometry.map((p: { lon: number; lat: number }) => [p.lon, p.lat]);
      // Close the ring if needed.
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
        ring.push(ring[0]);
      }
      return {
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: {},
      };
    });
  return { type: 'FeatureCollection', features };
}

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const [reports, setReports] = useState<ReportPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [selectedReport, setSelectedReport] = useState<ReportPin | null>(null);
  const [crisisRadius, setCrisisRadius] = useState<string>('50 mi');
  const [buildingsFC, setBuildingsFC] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [showZoomHint, setShowZoomHint] = useState(false);
  const cameraRef = useRef<CameraRef | null>(null);
  const buildingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFetchDone = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const btnScale = useRef(new Animated.Value(1)).current;

  // Pulsing animation for offline icon — starts when offline, stops when online
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.12,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    if (!isOnline) {
      loop.start();
    } else {
      loop.stop();
      pulseAnim.setValue(1);
    }
    return () => loop.stop();
  }, [isOnline, pulseAnim]);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const [reportsRes, crisesRes] = await Promise.allSettled([
        api.get('/api/reports?limit=200'),
        api.get('/api/crises/active'),
      ]);

      if (reportsRes.status === 'fulfilled') {
        const pins: ReportPin[] = reportsRes.value.data
          .filter((r: any) => r.gps_latitude && r.gps_longitude)
          .map((r: any) => ({
            id: r.id,
            latitude: parseFloat(r.gps_latitude),
            longitude: parseFloat(r.gps_longitude),
            damage_level: normaliseDamageLevel(r.damage_level),
            infrastructure_type:
              r.infrastructure_types?.[0] ?? r.infrastructure_type ?? 'Unknown',
            submitted_at: r.submitted_at ?? r.created_at,
            photo_url: undefined,
          }));
        setReports(pins);
      }

      if (crisesRes.status === 'fulfilled') {
        const crises: any[] = crisesRes.value.data ?? [];
        const first = crises[0];
        if (first?.map_default_radius_miles) {
          setCrisisRadius(`${first.map_default_radius_miles} mi`);
        }
      }
    } catch {
      // Offline or error — pins stay empty
    } finally {
      setLoading(false);
    }
  };

  const fetchBuildings = async (s: number, w: number, n: number, e: number) => {
    const query = `[out:json][timeout:10];way["building"](${s},${w},${n},${e});out geom;`;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) return;
      const data = await res.json();
      setBuildingsFC(overpassToGeoJSON(data.elements ?? []));
    } catch { /* Non-critical — Overpass may be slow */ }
  };

  /** Called when the map camera settles. Triggers building fetch at zoom ≥ 14. */
  const handleRegionChange = (event: any) => {
    const zoom: number = event?.properties?.zoomLevel ?? 0;
    const bounds: [[number, number], [number, number]] | undefined =
      event?.properties?.visibleBounds;

    if (zoom < BUILDINGS_MIN_ZOOM) {
      setShowZoomHint(zoom > 10); // hint only when user has started zooming in
      setBuildingsFC(EMPTY_FC);
      return;
    }

    setShowZoomHint(false);

    if (!bounds) return;
    const [[neLng, neLat], [swLng, swLat]] = bounds;

    if (buildingsTimer.current) clearTimeout(buildingsTimer.current);
    buildingsTimer.current = setTimeout(() => {
      fetchBuildings(swLat, swLng, neLat, neLng);
    }, 800);
  };

  const recentreMap = async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        await Location.requestForegroundPermissionsAsync();
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
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
        initialFetchDone.current = true;
      } else {
        setLoading(false);
      }
    });

    const unsubscribe = NetInfo.addEventListener((state) => {
      const online =
        state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(online);
      // Guard against stale closure: only fetch once on first connectivity event.
      if (online && !initialFetchDone.current) {
        fetchReports();
        initialFetchDone.current = true;
      }
    });

    return () => {
      unsubscribe();
      if (buildingsTimer.current) clearTimeout(buildingsTimer.current);
    };
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

  const handlePinPress = (
    event: NativeSyntheticEvent<PressEventWithFeatures>,
  ) => {
    const { features } = event.nativeEvent;
    if (!features?.length) return;
    const props = features[0].properties;
    const report = reports.find((r) => r.id === props?.id);
    if (report) setSelectedReport(report);
  };

  // ── OFFLINE STATE ─────────────────────────────────────────────────────────
  if (!isOnline && reports.length === 0) {
    return (
      <View style={styles.offlineRoot}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
          <Text style={styles.headerTitle}>Crisis Reporter</Text>
        </View>

        {/* Offline banner — full-width strip below header */}
        <View style={styles.offlineBanner}>
          <MaterialIcons name="cloud-off" size={scale(16)} color="#FFFFFF" />
          <Text style={styles.offlineBannerText}>Working Offline</Text>
        </View>

        {/* Content area — fills space between banner and bottom nav */}
        <View style={styles.offlineArea}>
          <View style={styles.offlineCard}>
            {/* Pulsing icon group */}
            <Animated.View
              style={[
                styles.offlineIconOuter,
                { transform: [{ scale: pulseAnim }] },
              ]}
            >
              <MaterialIcons name="wifi-off" size={scale(36)} color="#717782" />
            </Animated.View>

            <Text style={styles.offlineTitle}>Map unavailable</Text>
            <Text style={styles.offlineSubtitle}>
              Connect to the internet to view the map and reported incidents near
              you
            </Text>

            {/* GPS note row */}
            <View style={styles.gpsNoteRow}>
              <MaterialIcons
                name="location-searching"
                size={scale(18)}
                color="#0468B1"
                style={{ marginTop: 2 }}
              />
              <Text style={styles.gpsNoteText}>
                Your GPS location is still being recorded in the background
              </Text>
            </View>

            {/* Check connection button with press scale */}
            <Animated.View
              style={[styles.checkBtnWrap, { transform: [{ scale: btnScale }] }]}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={styles.checkBtn}
                onPressIn={() =>
                  Animated.spring(btnScale, {
                    toValue: 0.97,
                    useNativeDriver: true,
                  }).start()
                }
                onPressOut={() =>
                  Animated.spring(btnScale, {
                    toValue: 1,
                    useNativeDriver: true,
                  }).start()
                }
                onPress={() => {
                  NetInfo.fetch().then((state) => {
                    if (state.isConnected) {
                      setIsOnline(true);
                      fetchReports();
                    }
                  });
                }}
              >
                <MaterialIcons name="refresh" size={scale(18)} color="#FFFFFF" />
                <Text style={styles.checkBtnText}>Check Connection</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </View>

        {/* Bottom navigation — Map tab is active */}
        <View style={[styles.bottomNav, { paddingBottom: insets.bottom }]}>
          <TouchableOpacity
            style={styles.navItem}
            onPress={() => navigation.navigate('Home')}
          >
            <Text style={styles.navIconInactive}>🏠</Text>
            <Text style={styles.navLabelInactive}>HOME</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.navItem}>
            <View style={styles.activeNavPill}>
              <Text style={styles.navIconActive}>🗺</Text>
              <Text style={styles.navLabelActive}>MAP</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.navItem}
            onPress={() => navigation.navigate('MyReports')}
          >
            <Text style={styles.navIconInactive}>📋</Text>
            <Text style={styles.navLabelInactive}>REPORTS</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── ONLINE STATE ──────────────────────────────────────────────────────────
  return (
    <View style={styles.onlineRoot}>
      {/* Map fills entire screen — edge to edge, behind all overlays */}
      <MLMap
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE_URL}
        logo={false}
        attribution={false}
        onPress={() => setSelectedReport(null)}
        onRegionDidChange={handleRegionChange}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [20, 20], zoom: 5 }}
        />

        <UserLocation />

        {/* Building footprints — rendered below report pins */}
        <GeoJSONSource id="buildings-source" data={buildingsFC}>
          <Layer
            id="buildings-fill"
            type="fill"
            paint={{
              'fill-color': '#CBD5E0',
              'fill-opacity': 0.45,
            }}
          />
          <Layer
            id="buildings-outline"
            type="line"
            paint={{
              'line-color': '#718096',
              'line-width': 0.7,
            }}
          />
        </GeoJSONSource>

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

      {/* Loading overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color="#0468B1" size="large" />
        </View>
      )}

      {/* Floating header with glassmorphism — sits above map */}
      <View style={[styles.header, styles.headerAbsolute, { paddingTop: insets.top, height: 56 + insets.top }]}>
        <Text style={styles.headerTitle}>Crisis Reporter</Text>
      </View>

      {/* Location pill — floating top-center below header */}
      <View style={[styles.locationPillWrap, { top: insets.top + 64 }]}>
        <View style={styles.locationPill}>
          <MaterialIcons name="my-location" size={scale(14)} color="#FFFFFF" />
          <Text style={styles.locationPillText}>Near you — {crisisRadius} radius</Text>
        </View>
      </View>

      {/* "Zoom in to see buildings" hint — shown at zoom 10–13 */}
      {showZoomHint && (
        <View style={[styles.zoomHintPill, { top: insets.top + 100 }]}>
          <Text style={styles.zoomHintText}>Zoom in to see building outlines</Text>
        </View>
      )}

      {/* GPS recentre FAB — bottom-right */}
      <TouchableOpacity
        style={[styles.gpsFab, { bottom: insets.bottom + 80 }]}
        onPress={recentreMap}
        activeOpacity={0.85}
      >
        <MaterialIcons name="gps-fixed" size={scale(24)} color="#FFFFFF" />
      </TouchableOpacity>

      {/* Popup card — shown when a pin is tapped */}
      <Modal
        visible={!!selectedReport}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedReport(null)}
      >
        <TouchableOpacity
          style={styles.popupOverlay}
          activeOpacity={1}
          onPress={() => setSelectedReport(null)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={[styles.popupCard, { marginBottom: insets.bottom + 100 }]}
          >
            {selectedReport && (
              <>
                <Text style={styles.popupTitle}>
                  {selectedReport.infrastructure_type}
                </Text>
                <Text
                  style={[
                    styles.popupDamage,
                    { color: PIN_COLOURS[selectedReport.damage_level] },
                  ]}
                >
                  {PIN_LABELS[selectedReport.damage_level]}
                </Text>
                <View style={styles.popupReportsRow}>
                  <MaterialIcons
                    name="group"
                    size={scale(14)}
                    color="#9CA3AF"
                  />
                  <Text style={styles.popupReportsText}>1 report received</Text>
                </View>
                <Text style={styles.popupCoords}>
                  {selectedReport.latitude.toFixed(5)},{' '}
                  {selectedReport.longitude.toFixed(5)}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    const id = selectedReport.id;
                    setSelectedReport(null);
                    navigation.navigate('ReportDetailScreen', { reportId: id });
                  }}
                >
                  <Text style={styles.popupViewDetails}>View Details ›</Text>
                </TouchableOpacity>
              </>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Bottom navigation — Map tab is active */}
      <View style={[styles.bottomNav, styles.bottomNavAbsolute, { paddingBottom: insets.bottom }]}>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate('Home')}
        >
          <Text style={styles.navIconInactive}>🏠</Text>
          <Text style={styles.navLabelInactive}>HOME</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem}>
          <View style={styles.activeNavPill}>
            <Text style={styles.navIconActive}>🗺</Text>
            <Text style={styles.navLabelActive}>MAP</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navItem}
          onPress={() => navigation.navigate('MyReports')}
        >
          <Text style={styles.navIconInactive}>📋</Text>
          <Text style={styles.navLabelInactive}>REPORTS</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Shared ──────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    backgroundColor: 'rgba(255,255,255,0.92)',
    zIndex: 20,
  },
  headerAbsolute: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  headerTitle: {
    fontSize: scale(17),
    fontWeight: '600',
    color: '#1B1C1C',
    textAlign: 'center',
  },

  // ── Offline state ────────────────────────────────────────────────────────
  offlineRoot: {
    flex: 1,
    backgroundColor: '#F6F3F2',
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    backgroundColor: '#F5A623',
    gap: 8,
  },
  offlineBannerText: {
    color: '#FFFFFF',
    fontSize: scale(13),
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  offlineArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  offlineCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingVertical: 32,
    paddingHorizontal: 24,
    width: screenWidth * 0.88,
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
  },
  offlineIconOuter: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(193,199,210,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  offlineTitle: {
    fontSize: scale(22),
    fontWeight: '700',
    color: '#1B1C1C',
    textAlign: 'center',
    marginBottom: 8,
  },
  offlineSubtitle: {
    fontSize: scale(14),
    color: '#414751',
    textAlign: 'center',
    lineHeight: scale(14) * 1.5,
    maxWidth: screenWidth * 0.65,
    marginBottom: 24,
  },
  gpsNoteRow: {
    flexDirection: 'row',
    backgroundColor: '#F6F3F2',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 24,
    width: '100%',
  },
  gpsNoteText: {
    fontSize: scale(12),
    color: '#717782',
    flex: 1,
    lineHeight: scale(12) * 1.5,
  },
  checkBtnWrap: {
    width: '100%',
  },
  checkBtn: {
    backgroundColor: '#0468B1',
    height: 52,
    borderRadius: 26,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  checkBtnText: {
    color: '#FFFFFF',
    fontSize: scale(15),
    fontWeight: '700',
  },

  // ── Online state ─────────────────────────────────────────────────────────
  onlineRoot: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 15,
  },
  locationPillWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  locationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(27,28,28,0.85)',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  locationPillText: {
    color: '#FFFFFF',
    fontSize: scale(12),
    fontWeight: '500',
  },
  zoomHintPill: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
    pointerEvents: 'none',
  },
  zoomHintText: {
    backgroundColor: 'rgba(26,43,74,0.82)',
    color: '#FFFFFF',
    fontSize: scale(11),
    fontWeight: '500',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    overflow: 'hidden',
  },
  gpsFab: {
    position: 'absolute',
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#00508A',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#00508A',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    zIndex: 10,
  },

  // ── Popup card ───────────────────────────────────────────────────────────
  popupOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  popupCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    minWidth: screenWidth * 0.55,
    maxWidth: screenWidth * 0.75,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
  },
  popupTitle: {
    fontSize: scale(14),
    fontWeight: '700',
    color: '#1B1C1C',
    marginBottom: 4,
  },
  popupDamage: {
    fontSize: scale(12),
    fontWeight: '600',
    marginBottom: 4,
  },
  popupReportsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  popupReportsText: {
    fontSize: scale(11),
    color: '#717782',
  },
  popupCoords: {
    fontSize: scale(11),
    color: '#9CA3AF',
    marginBottom: 4,
  },
  popupViewDetails: {
    fontSize: scale(12),
    fontWeight: '700',
    color: '#0468B1',
    marginTop: 4,
  },

  // ── Bottom navigation ────────────────────────────────────────────────────
  bottomNav: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 24,
    elevation: 8,
  },
  bottomNavAbsolute: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
    minHeight: 44,
  },
  activeNavPill: {
    backgroundColor: 'rgba(4,104,177,0.1)',
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 2,
  },
  navIconActive: {
    fontSize: scale(24),
    color: '#0468B1',
  },
  navLabelActive: {
    fontSize: scale(10),
    fontWeight: '600',
    color: '#0468B1',
    letterSpacing: 1.2,
  },
  navIconInactive: {
    fontSize: scale(24),
    color: '#717782',
  },
  navLabelInactive: {
    fontSize: scale(10),
    fontWeight: '500',
    color: '#717782',
    letterSpacing: 1.2,
    marginTop: 2,
  },
});
