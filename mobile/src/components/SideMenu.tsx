import React from "react";
import {
  View, Text, TouchableOpacity, Modal,
  StyleSheet, Dimensions, TouchableWithoutFeedback,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";

const { width: screenWidth } = Dimensions.get("window");
const scale = (size: number) => Math.round((screenWidth / 375) * size);

const MENU_WIDTH = screenWidth * 0.78;

type SideMenuProps = {
  visible: boolean;
  onClose: () => void;
};

type MenuItem = {
  key: string;
  labelKey: string;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  primary?: boolean;
};

const MENU_ITEMS: MenuItem[] = [
  { key: "ReportScreen",         labelKey: "menu.report_incident", icon: "campaign",  primary: true },
  { key: "SafetyTipsScreen",     labelKey: "menu.safety_tips",     icon: "security" },
  { key: "ReporterProfileScreen",labelKey: "menu.profile",         icon: "person" },
  { key: "BadgesScreen",         labelKey: "menu.badges",          icon: "star" },
  { key: "SettingsScreen",       labelKey: "menu.settings",        icon: "settings" },
];

export default function SideMenu({ visible, onClose }: SideMenuProps) {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  const handleNavigate = (screenKey: string) => {
    onClose();
    setTimeout(() => navigation.navigate(screenKey), 150);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.menu, { width: MENU_WIDTH }]}>

              {/* ── Header: Brand + Close ── */}
              <View style={[styles.menuHeader, { paddingTop: insets.top + 24 }]}>
                <View style={styles.brandRow}>
                  <View style={styles.brandIconContainer}>
                    <MaterialIcons name="security" size={scale(22)} color="#0468B1" />
                  </View>
                  <Text style={styles.menuTitle}>Crisis Reporter</Text>
                </View>
                <TouchableOpacity
                  onPress={onClose}
                  style={styles.closeBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="close" size={scale(22)} color="#717782" />
                </TouchableOpacity>
              </View>

              {/* Subtle divider */}
              <View style={styles.divider} />

              {/* ── Menu items ── */}
              <View style={[styles.itemsContainer, { paddingTop: 12 }]}>
                {MENU_ITEMS.map((item) => (
                  item.primary ? (
                    <TouchableOpacity
                      key={item.key}
                      style={styles.primaryItem}
                      onPress={() => handleNavigate(item.key)}
                      activeOpacity={0.8}
                    >
                      <View style={styles.menuItemLeft}>
                        <MaterialIcons name={item.icon} size={scale(22)} color="#FFFFFF" />
                        <Text style={styles.primaryItemLabel}>{t(item.labelKey)}</Text>
                      </View>
                      <MaterialIcons name="chevron-right" size={scale(18)} color="rgba(255,255,255,0.7)" />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      key={item.key}
                      style={styles.menuItem}
                      onPress={() => handleNavigate(item.key)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.menuItemLeft}>
                        <MaterialIcons name={item.icon} size={scale(22)} color="#414751" />
                        <Text style={styles.menuItemLabel}>{t(item.labelKey)}</Text>
                      </View>
                      <MaterialIcons name="chevron-right" size={scale(18)} color="#C1C7D2" />
                    </TouchableOpacity>
                  )
                ))}
              </View>

              {/* Footer */}
              <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
                <View style={styles.footerDivider} />
                <Text style={styles.footerText}>{t("menu.version")}</Text>
              </View>

            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    flexDirection: "row",
  },
  menu: {
    backgroundColor: "#FFFFFF",
    height: "100%",
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
    flexDirection: "column",
  },

  // Header
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brandIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(4,104,177,0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  menuTitle: {
    fontSize: scale(20),
    fontWeight: "900",
    color: "#0468B1",
  },
  closeBtn: {
    minWidth: 40,
    minHeight: 40,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 20,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: "rgba(193,199,210,0.5)",
    marginBottom: 4,
  },

  // Items container
  itemsContainer: {
    paddingHorizontal: 12,
    gap: 4,
    flex: 1,
  },

  // Primary (Report) item
  primaryItem: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "#0468B1",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    minHeight: 44,
  },
  primaryItemLabel: {
    fontSize: scale(15),
    fontWeight: "700",
    color: "#FFFFFF",
    marginLeft: 14,
  },

  // Regular menu item
  menuItem: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
  },
  menuItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  menuItemLabel: {
    fontSize: scale(15),
    fontWeight: "500",
    color: "#1B1C1C",
    marginLeft: 14,
  },

  // Footer
  footer: {
    paddingHorizontal: 24,
  },
  footerDivider: {
    height: 1,
    backgroundColor: "rgba(193,199,210,0.3)",
    marginBottom: 16,
  },
  footerText: {
    fontSize: scale(12),
    color: "#9CA3AF",
    fontWeight: "500",
    letterSpacing: 0.3,
  },
});
