import { Pressable, StyleSheet, View } from 'react-native';

import type { RemotePaneConnectionStatus } from '@shared/types/remoteDaemon';

import { useTheme, type ThemeColors } from '@/theme';
import { Text } from '@/ui';

const presentation: Record<RemotePaneConnectionStatus, { label: string; color: keyof ThemeColors }> = {
  connected: { label: 'Connected', color: 'success' },
  restoring: { label: 'Restoring…', color: 'warning' },
  connecting: { label: 'Connecting…', color: 'warning' },
  reconnecting: { label: 'Reconnecting…', color: 'warning' },
  error: { label: 'Offline', color: 'danger' },
  local: { label: 'Disconnected', color: 'neutral' },
};

export function ConnectionStatus({ status, onRetry, updateIntent }: { updateIntent?: import('@shared/remoteClient/updateIntent').RemoteUpdateIntent | null; status: RemotePaneConnectionStatus; onRetry: () => void }) {
  const theme = useTheme();
  const { label, color } = presentation[status];
  return (
    <View style={styles.row} testID={`connection-status-${status}`} accessibilityLabel={`Host ${label}`}>
      <View style={[styles.dot, { backgroundColor: theme.colors[color] }]} />
      <Text variant="footnote" tone="secondary">{updateIntent && status !== 'connected' ? `Updating remote Pane · ${updateIntent.id}` : label}</Text>
      {(status === 'error' || status === 'reconnecting') && <Pressable accessibilityRole="button" accessibilityLabel="Retry now" onPress={onRetry}><Text variant="footnote">Retry now</Text></Pressable>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
