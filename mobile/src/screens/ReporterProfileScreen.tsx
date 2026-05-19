import React, { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import * as SecureStore from "expo-secure-store";
import api from "../services/api";

export default function ReporterProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [reporterId, setReporterIdLocal] = useState<string | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync("cr_reporter_id").then((id) => {
      setReporterIdLocal(id);
    });
  }, []);

  const hasAtLeastOne = name.trim() || email.trim() || phone.trim();

  const handleSave = async () => {
    if (!hasAtLeastOne || !reporterId) return;
    setLoading(true);
    try {
      await api.patch(`/api/reporters/${reporterId}`, {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      navigation.goBack();
    } catch {
      Alert.alert("Error", "Could not save profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create Account</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.form}>
        {reporterId && (
          <View style={styles.reporterIdBox}>
            <Text style={styles.reporterIdLabel}>Your Reporter ID</Text>
            <Text style={styles.reporterIdValue}>{reporterId}</Text>
          </View>
        )}

        <TextInput
          style={styles.input}
          placeholder="Your name (optional)"
          placeholderTextColor="#999"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Email address (optional)"
          placeholderTextColor="#999"
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone number (optional)"
          placeholderTextColor="#999"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
        />

        {!hasAtLeastOne && (
          <Text style={styles.validationText}>
            Please fill in at least one field to continue.
          </Text>
        )}

        <TouchableOpacity
          style={[
            styles.saveBtn,
            (!hasAtLeastOne || loading) && styles.saveBtnDisabled,
          ]}
          onPress={handleSave}
          disabled={!hasAtLeastOne || loading}
        >
          {loading ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.saveBtnText}>Save Profile</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E0E0E0",
  },
  backBtn: { width: 60 },
  backText: { color: "#0468B1", fontSize: 15 },
  headerTitle: { fontSize: 18, fontWeight: "bold", color: "#333" },
  form: { padding: 24, gap: 12 },
  reporterIdBox: {
    backgroundColor: "#F0F7FF",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    marginBottom: 8,
  },
  reporterIdLabel: { fontSize: 12, color: "#666", marginBottom: 4 },
  reporterIdValue: { fontSize: 18, fontWeight: "bold", color: "#0468B1" },
  input: {
    height: 52,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    color: "#333",
  },
  validationText: { color: "#D32F2F", fontSize: 13 },
  saveBtn: {
    height: 52,
    borderRadius: 28,
    backgroundColor: "#0468B1",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  saveBtnDisabled: { backgroundColor: "#B0C4D8" },
  saveBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
