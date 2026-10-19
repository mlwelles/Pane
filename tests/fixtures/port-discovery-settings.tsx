import { createRoot } from 'react-dom/client';
import { Settings } from '../../frontend/src/components/Settings';
import { createDefaultRemoteDaemonConfig, createDefaultRemotePaneConnectionState, createDefaultRemoteDaemonHostRuntimeState } from '../../shared/types/remoteDaemon';
import type { AppConfig, UpdateConfigRequest } from '../../frontend/src/types/config';

const params = new URLSearchParams(location.hash.slice(1));
const remoteConfig = createDefaultRemoteDaemonConfig();
remoteConfig.client.mode = params.has('remote') ? 'remote' : 'local';
let config: AppConfig = { remoteDaemon: remoteConfig };
if (params.get('saved') === 'passive') config.portDiscoveryMode = 'passive';
const saves: UpdateConfigRequest[] = [];
let resolvePlatform: (platform: string) => void = () => {};

export interface PortSettingsTest {
  saves: UpdateConfigRequest[];
  resolvePlatform(platform: string): void;
}

declare global {
  interface Window { portSettingsTest: PortSettingsTest }
}

Object.assign(window, {
  portSettingsTest: { saves, resolvePlatform: (platform: string) => resolvePlatform(platform) },
  electron: { invoke: async () => ({ success: true, data: {} }) },
  electronAPI: {
    getPlatform: () => {
      if (params.get('platform') === 'failed') return Promise.reject(new Error('Platform lookup failed'));
      if (params.has('platform')) return Promise.resolve(params.get('platform'));
      return new Promise<string>(resolve => { resolvePlatform = resolve; });
    },
    remoteDaemon: {
      getConfig: async () => ({ success: true, data: remoteConfig }),
      getConnectionState: async () => ({ success: true, data: { ...createDefaultRemotePaneConnectionState(), mode: remoteConfig.client.mode } }),
      getHostState: async () => ({ success: true, data: { ...createDefaultRemoteDaemonHostRuntimeState(), platform: params.get('remote') } }),
      onConnectionStateChanged: () => () => {},
      onHostStateChanged: () => () => {},
    },
    config: {
      getMonospaceFonts: async () => ({ success: true, data: [] }),
      get: async () => ({ success: true, data: config }),
      update: async (patch: UpdateConfigRequest) => {
        saves.push(patch);
        if (params.has('fail')) return { success: false, error: 'Could not save port discovery. Active remains in use. Try again.' };
        config = { ...config, ...patch };
        return { success: true, data: config };
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <Settings isOpen category="general" onClose={() => {}} onCategoryChange={() => {}}
    onOpenRequestHandled={() => {}} onShowKeyboardShortcuts={() => {}}
    onUpdate={() => {}} onSendFeedback={() => {}} />,
);
