import React from "react";
import {
  View, Text, TouchableOpacity, Modal,
  StyleSheet, Dimensions, TouchableWithoutFeedback,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";

const { width: screenWidth } = Dimensions.get("window");
const scale = (size: number) => Math.round((screenWidth / 375) * size);

const MENU_WIDTH = screenWidth * 0.78;

type SideMenuProps = {
  visible: boolean;
  onClose: () => void;
};

type MenuItem = {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
};

const MENU_ITEMS: MenuItem[] = [
  { key: "SafetyTipsScreen", label: "Safety Tips", icon: "security" },
  { key: "ReporterProfileScreen", label: "Reporter Profile", icon: "person" },
  { key: "BadgesScreen", label: "Badges & Certifications", icon: "star" },
  { key: "SettingsScreen", label: "Settings", icon: "settings" },
];

export default function SideMenu({ visible, onClose }: SideMenuProps) {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();

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
              {/* Menu header */}
              <View style={[styles.menuHeader, { paddingTop: insets.top + 20 }]}>
                <View style={styles.brandRow}>
                  <View style={styles.brandIconContainer}>
                    <MaterialIcons name="security" size={scale(20)} color="#0468B1" />
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

              {/* Divider */}
              <View style={styles.divider} />

              {/* Menu items */}
              <View style={styles.itemsContainer}>
                {MENU_ITEMS.map((item) => (
                  <TouchableOpacity
                    key={item.key}
                    style={styles.menuItem}
                    onPress={() => handleNavigate(item.key)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name={item.icon} size={scale(22)} color="#414751" />
                    <Text style={styles.menuItemLabel}>{item.label}</Text>
                    <MaterialIcons
                      name="chevron_right"
                      size={scale(18)}
                      color="#C1C7D2"
                      style={styles.chevron}
                    />
                  </TouchableOpacity>
                ))}
              </View>

              {/* Footer */}
              <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
                <View style={styles.footerDivider} />
                <Text style={styles.footerText}>Crisis Reporter v1.0</Text>
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
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 20,
    flexDirection: "column",
  },

  // Header
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  brandIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "rgba(4,104,177,0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  menuTitle: {
    fontSize: scale(18),
    fontWeight: "900",
    color: "#0468B1",
  },
  closeBtn: {
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: "#F0EDED",
  },

  // Items
  itemsContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 4,
    flex: 1,
  },
  menuItem: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minWidth: 44,
    minHeight: 44,
  },
  menuItemLabel: {
    fontSize: scale(16),
    fontWeight: "500",
    color: "#1B1C1C",
    flex: 1,
  },
  chevron: { marginLeft: "auto" },

  // Footer
  footer: {
    paddingHorizontal: 24,
  },
  footerDivider: {
    height: 1,
    backgroundColor: "#F0EDED",
    marginBottom: 16,
  },
  footerText: {
    fontSize: scale(12),
    color: "#9CA3AF",
    fontWeight: "500",
  },
});
