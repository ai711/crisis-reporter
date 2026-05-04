import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";

export default function MyReportsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backBtn}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("home.myReports")}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.emptyIcon}>📋</Text>
        <Text style={styles.emptyText}>
          Your submitted reports will appear here
        </Text>
      </View>
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
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  emptyIcon: { fontSize: 64 },
  emptyText: { fontSize: 16, color: "#666" },
});