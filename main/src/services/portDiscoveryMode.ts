import type { PortDiscoveryMode } from '../../../shared/types/listeningPorts';
import { PaneError } from '../../../shared/paneError';
import type { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

export function readPortDiscoveryMode(value: JsonValue | undefined): PortDiscoveryMode {
  if (value === undefined) return 'active';
  if (value === 'active' || value === 'passive') return value;
  throw new PaneError(
    'INVALID_PORT_DISCOVERY_MODE',
    'Port discovery mode is invalid; the current mode was retained.',
    'Set portDiscoveryMode to "active" or "passive" in config.json.',
  );
}

export function bindPortDiscoveryMode(
  configEvents: EventEmitter,
  monitor: { setMode(mode: PortDiscoveryMode): void },
): () => void {
  const onUpdate = (config: AppConfig) => monitor.setMode(readPortDiscoveryMode(config.portDiscoveryMode));
  configEvents.on('config-updated', onUpdate);
  return () => configEvents.off('config-updated', onUpdate);
}
