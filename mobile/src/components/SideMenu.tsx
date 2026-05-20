import React from 'react';
import {
  View, Text, TouchableOpacity, Modal,
  StyleSheet, Dimensions, TouchableWithoutFeedback,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const MENU_WIDTH = Dimensions.get('window').width * 0.75;

type SideMenuProps = {
  visible: boolean;
  onClose: () => void;
};

const MENU_ITEMS = [
  { key: 'SafetyTipsScreen', label: 'Safety Tips', icon: '🛡️' },
  { key: 'ReporterProfileScreen', label: 'Reporter Profile', icon: '👤' },
  { key: 'BadgesScreen', label: 'Badges & Certifications', icon: '🏅' },
  { key: 'SettingsScreen', label: 'Settings', icon: '⚙️' },
  { key: 'FAQScreen', label: 'FAQ', icon: '❓' },
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
            <View style={[styles.menu, { paddingTop: insets.top + 16, width: MENU_WIDTH }]}>
              {/* Menu header */}
              <View style={styles.menuHeader}>
                <Text style={styles.menuTitle}>Crisis Reporter</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeIcon}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Divider */}
              <View style={styles.divider} />

              {/* Menu items */}
              {MENU_ITEMS.map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={styles.menuItem}
                  onPress={() => handleNavigate(item.key)}
                >
                  <Text style={styles.menuItemIcon}>{item.icon}</Text>
                  <Text style={styles.menuItemLabel}>{item.label}</Text>
                </TouchableOpacity>
              ))}

              {/* Bottom padding */}
              <View style={{ height: insets.bottom + 24 }} />
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
    backgroundColor: 'rgba(0,0,0,0.45)',
    flexDirection: 'row',
  },
  menu: {
    backgroundColor: '#FFFFFF',
    height: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  menuTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0468B1',
  },
  closeBtn: {
    padding: 8,
    width: 36,
    alignItems: 'center',
  },
  closeIcon: {
    fontSize: 16,
    color: '#666666',
  },
  divider: {
    height: 1,
    backgroundColor: '#E0E0E0',
    marginHorizontal: 20,
    marginBottom: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    minHeight: 52,
  },
  menuItemIcon: {
    fontSize: 20,
    width: 32,
  },
  menuItemLabel: {
    fontSize: 16,
    color: '#333333',
    marginLeft: 12,
  },
});
