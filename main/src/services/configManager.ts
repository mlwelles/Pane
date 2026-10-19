import { validateCustomCommandResume } from '../../../shared/types/customCommandResume';
import { EventEmitter } from 'events';
import { PaneError } from '../../../shared/paneError';
import type { AnalyticsIdentity, AppConfig } from '../types/config';
import { DEFAULT_PANE_CHAT_AGENT, normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { DEFAULT_WORKTREE_FILE_SYNC_ENTRIES } from '../../../shared/types/worktreeFileSync';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import path from 'path';
import { readPortDiscoveryMode } from './portDiscoveryMode';
import { randomUUID } from 'crypto';
import { HOME_GIT_SCAN_WARNING, isHomeDirectory } from '../utils/gitScanSafety';
import { getAppDirectory } from '../utils/appDirectory';
import { clearShellPathCache } from '../utils/shellPath';
import { restampSharedCredentials } from './sharedCredentials';
import {
  defaultTerminalEscapeShortcut,
  isValidTerminalEscapeShortcut,
  normalizeTerminalKeyboardConfig,
} from '../../../shared/utils/terminalKeyboardPolicy';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  AppearanceValidationError,
  DEFAULT_APPEARANCE,
  isLightTheme,
  isTheme,
  normalizeAppearance,
  type AppearanceConfig,
} from '../../../shared/types/appearance';

const DEFAULT_POSTHOG_API_KEY = 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1';
const LEGACY_POSTHOG_HOST = 'https://us.i.posthog.com';
const DEFAULT_POSTHOG_HOST = 'https://runpane.com/api/c';
/** Bump when agentContext defaults change for existing configs (2: repo AGENTS.md off). */
export const AGENT_CONTEXT_DEFAULTS_VERSION = 2;

type WatchConfigDirectory = (
  directory: string,
  onChange: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

const watchConfigDirectory: WatchConfigDirectory = (directory, onChange) =>
  watch(directory, { persistent: false }, onChange);

function defaultAnalyticsConfig(): NonNullable<AppConfig['analytics']> {
  return {
    enabled: true,
    posthogApiKey: DEFAULT_POSTHOG_API_KEY,
    posthogHost: DEFAULT_POSTHOG_HOST
  };
}

export class ConfigManager extends EventEmitter {
  private config: AppConfig;
  private configPath: string;
  private configDir: string;
  private fileWatcher: FSWatcher | null = null;
  private watcherReload: ReturnType<typeof setTimeout> | null = null;
  private watching = false;
  private lastConfigJson: string = '';
  private saveConfigQueue: Promise<void> = Promise.resolve();

  constructor(defaultGitPath?: string, private readonly watchDirectory = watchConfigDirectory) {
    super();
    this.configDir = getAppDirectory();
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = {
      gitRepoPath: defaultGitPath || '',
      usePtyHost: process.platform === 'win32',
      verbose: false,
      portDiscoveryMode: 'active',
      anthropicApiKey: undefined,
      falApiKey: undefined,
      openRouterApiKey: undefined,
      deepgramApiKey: undefined,
      voiceTranscriptionMode: 'streaming',
      systemPromptAppend: undefined,
      runScript: undefined,
      theme: 'light-rounded',
      appearanceMode: 'system',
      systemLightTheme: 'light-rounded',
      systemDarkTheme: 'dark',
      highContrast: false,
      terminalFontFamily: 'Geist Mono',
      terminalFontSize: 14,
      terminalPowerMode: 'performance',
      defaultPermissionMode: 'ignore',
      defaultModel: 'sonnet',
      defaultOrchestratorAgent: DEFAULT_PANE_CHAT_AGENT,
      autoStartOnBoot: true,
      keepAwakeWhileSessionsActive: true,
      notifications: {
        playSound: true,
        enabled: true
      },
      sessionCreationPreferences: {
        sessionCount: 1,
        toolType: 'none',
        selectedTools: {
          claude: false
        },
        claudeConfig: {
          model: 'auto',
          permissionMode: 'ignore',
          ultrathink: false
        },
        showAdvanced: false
      },
      analytics: defaultAnalyticsConfig(),
      agentContext: {
        managedAgentsMd: false,
        homeSkill: true,
        defaultsVersion: AGENT_CONTEXT_DEFAULTS_VERSION,
        registerMcp: true,
        cleanupPending: false,
      },
      remoteDaemon: createDefaultRemoteDaemonConfig(),
      keyboardShortcutsEnabled: true,
      terminalKeyboardPreset: 'standard',
      terminalEscapeShortcut: defaultTerminalEscapeShortcut(process.platform === 'darwin'),
      commandPaletteShortcutEnabled: true,
      terminalShortcuts: [
        {
          id: 'default-root-cause',
          label: 'Root cause or symptom?',
          key: 'e',
          text: 'Think hard: is this the root cause or a symptom? How might we solve this at the root?',
          enabled: true
        },
        {
          id: 'default-codex-review',
          label: 'Codex review loop',
          key: 'r',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues.",
          enabled: true
        },
        {
          id: 'default-rebase-merge-release',
          label: 'Rebase, merge & release',
          key: 'd',
          text: 'Rebase main and merge the PR to main, then bump a release patch.',
          enabled: true
        },
        {
          id: 'default-review-and-release',
          label: 'Review and release loop',
          key: 's',
          text: "Prepare a PR once done with changes, then run in a subagent 'codex review --base main' and wait for it to respond. Read its response and make the fixes it suggests. Continue in a loop until it says there are no longer any issues. Once there are no issues, rebase main and merge the PR to main, then bump a release patch.",
          enabled: true
        }
      ],
      worktreeFileSync: DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
    };
  }

  async initialize(): Promise<void> {
    await this.enqueueConfigWrite(() => this.initializeFromDisk(false));
  }

  private async initializeFromDisk(strict: boolean): Promise<void> {
    // Ensure the config directory exists
    await fs.mkdir(this.configDir, { recursive: true });
    
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const wasAccepted = data === this.lastConfigJson;
      // SAFETY: initialize immediately normalizes boundary-sensitive fields before assigning the parsed config.
      const loadedConfig = JSON.parse(data) as AppConfig;
      const portDiscoveryMode = readPortDiscoveryMode(loadedConfig.portDiscoveryMode);
      // Drop keys from the removed Stravu integration so they leave the file on the next save.
      for (const legacyKey of ['stravuApiKey', 'stravuServerUrl']) {
        Reflect.deleteProperty(loadedConfig, legacyKey);
      }
      const normalizedAppearance = normalizeAppearance(loadedConfig);
      const normalizedKeyboard = normalizeTerminalKeyboardConfig(loadedConfig, process.platform === 'darwin');
      for (const diagnostic of normalizedAppearance.diagnostics) {
        console.error(`[ConfigManager] appearance: ${diagnostic}`);
      }
      
      // Migrate legacy notification fields from older config files.
      // notifyWhenBackgrounded -> enabled (if enabled is not explicitly set)
      // notifyWhenViewingOtherPanel is dropped silently.
      const incomingNotifications = decodeBoundary(
        loadedConfig.notifications,
        boundary.optional(boundary.object({
          playSound: boundary.optional(boundary.boolean),
          enabled: boundary.optional(boundary.boolean),
          notifyWhenBackgrounded: boundary.optional(boundary.boolean),
          notifyWhenViewingOtherPanel: boundary.optional(boundary.boolean),
        })),
      );
      const migratedNotifications = incomingNotifications
        ? {
            playSound: incomingNotifications.playSound ?? this.config.notifications!.playSound,
            enabled: incomingNotifications.enabled ?? incomingNotifications.notifyWhenBackgrounded ?? this.config.notifications!.enabled,
          }
        : this.config.notifications!;

      // Merge loaded config with defaults, ensuring nested settings exist
      const candidate: AppConfig = {
        ...this.config,
        ...loadedConfig,
        portDiscoveryMode,
        ...normalizedAppearance.appearance,
        terminalKeyboardPreset: normalizedKeyboard.terminalKeyboardPreset,
        terminalEscapeShortcut: normalizedKeyboard.terminalEscapeShortcut,
        notifications: migratedNotifications,
        sessionCreationPreferences: {
          ...this.config.sessionCreationPreferences,
          ...loadedConfig.sessionCreationPreferences,
          selectedTools: {
            ...this.config.sessionCreationPreferences?.selectedTools,
            ...loadedConfig.sessionCreationPreferences?.selectedTools
          },
          claudeConfig: {
            ...this.config.sessionCreationPreferences?.claudeConfig,
            ...loadedConfig.sessionCreationPreferences?.claudeConfig
          }
        },
        analytics: {
          ...this.config.analytics!,
          ...loadedConfig.analytics
        },
        agentContext: {
          ...this.config.agentContext!,
          ...loadedConfig.agentContext
        },
        defaultOrchestratorAgent: normalizePaneChatAgent(
          loadedConfig.defaultOrchestratorAgent ?? this.config.defaultOrchestratorAgent,
        ),
        remoteDaemon: normalizeRemoteDaemonConfig(loadedConfig.remoteDaemon),
        // Use !== undefined to distinguish "user cleared all entries" (empty array → preserve)
        // from "field absent in config file" (→ use defaults)
        worktreeFileSync: loadedConfig.worktreeFileSync !== undefined
          ? loadedConfig.worktreeFileSync
          : DEFAULT_WORKTREE_FILE_SYNC_ENTRIES
      };

      let shouldPersistMigration = normalizedAppearance.migrated
        || loadedConfig.terminalKeyboardPreset !== normalizedKeyboard.terminalKeyboardPreset
        || loadedConfig.terminalEscapeShortcut !== normalizedKeyboard.terminalEscapeShortcut;
      if (loadedConfig.agentContext?.registerMcp === undefined) {
        candidate.agentContext = { ...candidate.agentContext, registerMcp: true };
        shouldPersistMigration = true;
        console.log('[ConfigManager] Pane now registers its MCP server with Claude Code, Codex, and Cursor.');
      }
      if ((loadedConfig.agentContext?.defaultsVersion ?? 0) < AGENT_CONTEXT_DEFAULTS_VERSION) {
        // Version 2 stopped editing repositories by default. Configs saved under
        // the old default carry managedAgentsMd: true without the user choosing
        // it, so turn it off once; the caller then removes Pane's section from
        // repos exactly as the settings toggle does. A later opt-in sticks.
        candidate.agentContext = {
          ...candidate.agentContext,
          managedAgentsMd: false,
          defaultsVersion: AGENT_CONTEXT_DEFAULTS_VERSION,
          cleanupPending: true,
        };
        shouldPersistMigration = true;
      }
      if (candidate.analytics?.posthogHost === LEGACY_POSTHOG_HOST) {
        candidate.analytics.posthogHost = DEFAULT_POSTHOG_HOST;
        shouldPersistMigration = true;
      }
      const restamped = restampSharedCredentials(candidate, 'untimed');
      if (restamped) {
        candidate.sharedCredentials = restamped;
        shouldPersistMigration = true;
      }
      if (shouldPersistMigration) {
        await this.writeConfigToDisk(candidate);
      }
      const changed = !wasAccepted || Boolean(restamped);
      this.config = candidate;
      if (!shouldPersistMigration) this.lastConfigJson = data;
      if (strict && changed) this.emit('config-updated', this.config);
      if (!strict && restamped) this.emit('config-updated', this.config);
    } catch (error: unknown) {
      let errorCode: string | undefined;
      try {
        errorCode = decodeBoundary(error, boundary.object({
          code: boundary.optional(boundary.string),
        })).code;
      } catch {
        errorCode = undefined;
      }
      const isNotFound = errorCode === 'ENOENT';
      if (isNotFound) {
        if (strict) throw new PaneError('CONFIG_READ_FAILED', 'Could not reload port discovery settings because config.json is missing; the current mode was retained.', 'Restore config.json and reload settings.');
        await this.writeConfigToDisk(this.config);
      } else {
        if (strict) {
          if (error instanceof PaneError) throw error;
          throw new PaneError('CONFIG_READ_FAILED', `Could not reload config.json: ${error instanceof Error ? error.message : String(error)}. The current mode was retained.`, 'Correct config.json and reload settings.');
        }
        this.config = { ...this.config, portDiscoveryMode: 'passive' };
        console.error('[ConfigManager] Failed to load config file; port probes disabled until corrected:', error);
      }
    }
  }

  private async writeConfigToDisk(config: AppConfig): Promise<void> {
    const configJson = JSON.stringify(config, null, 2);
    await fs.mkdir(this.configDir, { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      await fs.writeFile(tmpPath, configJson);
      await fs.rename(tmpPath, this.configPath);
      this.lastConfigJson = configJson;
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  private async enqueueConfigWrite<T>(work: () => Promise<T>): Promise<T> {
    const queuedWrite = this.saveConfigQueue.then(work, work);
    this.saveConfigQueue = queuedWrite.then(() => undefined, () => undefined);
    return queuedWrite;
  }

  private async saveConfig(): Promise<void> {
    await this.enqueueConfigWrite(() => this.writeConfigToDisk(this.config));
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Reload config from disk. Use this when external processes (like setup scripts)
   * may have modified the config file.
   */
  async reloadFromDisk(): Promise<AppConfig> {
    await this.enqueueConfigWrite(() => this.initializeFromDisk(true));
    console.log('[ConfigManager] Reloaded config from disk');
    return this.config;
  }

  /**
   * Start watching config file for external changes (e.g., from setup scripts).
   * Emits 'config-updated' when the file changes.
   */
  startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    try {
      const handleFileChange = async () => {
        try {
          if (!this.watching) return;
          const data = await fs.readFile(this.configPath, 'utf-8');
          if (data !== this.lastConfigJson) {
            await this.reloadFromDisk();
            console.log('[ConfigManager] Config file changed externally, reloaded');
          }
        } catch (err) {
          console.error('[ConfigManager] Error reloading config after file change:', err);
        }
      };

      // The directory watch survives atomic replacement and temporary removal of config.json.
      this.fileWatcher = this.watchDirectory(this.configDir, (_eventType, filename) => {
        if (filename !== null && filename.toString() !== path.basename(this.configPath)) return;
        if (this.watcherReload) clearTimeout(this.watcherReload);
        this.watcherReload = setTimeout(() => {
          this.watcherReload = null;
          void handleFileChange();
        }, 100);
      });
      this.fileWatcher.on('error', (err) => {
        console.error('[ConfigManager] Config file watcher failed:', err);
        this.stopWatching();
      });
      console.log('[ConfigManager] Watching config file for external changes');
    } catch (err) {
      this.watching = false;
      console.error('[ConfigManager] Failed to start file watcher:', err);
    }
  }

  /**
   * Stop watching config file.
   */
  stopWatching(): void {
    this.watching = false;
    if (this.watcherReload) clearTimeout(this.watcherReload);
    this.watcherReload = null;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      console.log('[ConfigManager] Stopped watching config file');
    }
  }

  async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
    if (updates.defaultSessionResume) validateCustomCommandResume(updates.defaultSessionResume);
    for (const command of updates.customCommands ?? []) {
      if (command.resume) validateCustomCommandResume(command.resume);
    }
    return this.updateConfigWith(() => updates);
  }

  async updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueueConfigWrite(async () => {
      const updates = update(this.getConfig());
      if ('terminalKeyboardPreset' in updates
        && updates.terminalKeyboardPreset !== 'standard' && updates.terminalKeyboardPreset !== 'readline-friendly') {
        throw new PaneError(
          'INVALID_TERMINAL_PRESET',
          'The terminal keyboard preset is invalid. Your settings were not changed.',
          'Choose Standard or Readline-friendly.',
        );
      }
      if ('terminalEscapeShortcut' in updates && !isValidTerminalEscapeShortcut(updates.terminalEscapeShortcut, process.platform === 'darwin')) {
        throw new PaneError(
          'INVALID_TERMINAL_SHORTCUT',
          'The terminal escape shortcut is invalid. Your settings were not changed.',
          'Choose a key with Ctrl, Command, or Alt that is not a clipboard shortcut.',
        );
      }
      const analytics = updates.analytics !== undefined
        ? { ...defaultAnalyticsConfig(), ...this.config.analytics, ...updates.analytics }
        : this.config.analytics;
      const agentContext = updates.agentContext !== undefined
        ? { ...this.config.agentContext, ...updates.agentContext }
        : this.config.agentContext;
      const next: AppConfig = {
        ...this.config,
        ...updates,
        analytics,
        agentContext,
        defaultOrchestratorAgent: 'defaultOrchestratorAgent' in updates
          ? normalizePaneChatAgent(updates.defaultOrchestratorAgent)
          : this.config.defaultOrchestratorAgent,
        remoteDaemon: 'remoteDaemon' in updates
          ? normalizeRemoteDaemonConfig(updates.remoteDaemon)
          : this.config.remoteDaemon,
      };
      next.portDiscoveryMode = readPortDiscoveryMode(next.portDiscoveryMode);

      if (updates.agentContext !== undefined) {
        decodeBoundary(updates.agentContext, boundary.object({
          managedAgentsMd: boundary.optional(boundary.boolean),
          homeSkill: boundary.optional(boundary.boolean),
          defaultsVersion: boundary.optional(boundary.number),
        }));
      }
      next.sharedCredentials = restampSharedCredentials(next, 'now') ?? next.sharedCredentials;
      this.validateAppearanceUpdate(updates, next);
      await this.writeConfigToDisk(next);
      this.config = next;

      if ('additionalPaths' in updates) {
        clearShellPathCache();
        console.log('[ConfigManager] Additional paths updated, cleared PATH cache');
      }
      this.emit('config-updated', this.config);
      return this.getConfig();
    });
  }

  private validateAppearanceUpdate(updates: Partial<AppConfig>, next: AppConfig): void {
    if ('appearanceMode' in updates && updates.appearanceMode !== 'system' && updates.appearanceMode !== 'fixed') {
      throw new AppearanceValidationError('appearanceMode must be system or fixed');
    }
    if ('theme' in updates && !isTheme(updates.theme)) {
      throw new AppearanceValidationError('theme must be a valid palette');
    }
    if ('systemLightTheme' in updates && (!isTheme(updates.systemLightTheme) || !isLightTheme(updates.systemLightTheme))) {
      throw new AppearanceValidationError('systemLightTheme must be a light palette');
    }
    if ('systemDarkTheme' in updates && (!isTheme(updates.systemDarkTheme) || isLightTheme(updates.systemDarkTheme))) {
      throw new AppearanceValidationError('systemDarkTheme must be a dark palette');
    }
    const appearance: AppearanceConfig = {
      appearanceMode: next.appearanceMode ?? DEFAULT_APPEARANCE.appearanceMode,
      theme: next.theme ?? DEFAULT_APPEARANCE.theme,
      systemLightTheme: next.systemLightTheme ?? DEFAULT_APPEARANCE.systemLightTheme,
      systemDarkTheme: next.systemDarkTheme ?? DEFAULT_APPEARANCE.systemDarkTheme,
    };
    if (!isLightTheme(appearance.systemLightTheme)) {
      throw new AppearanceValidationError('systemLightTheme must be a light palette');
    }
    if (isLightTheme(appearance.systemDarkTheme)) {
      throw new AppearanceValidationError('systemDarkTheme must be a dark palette');
    }
  }

  getGitRepoPath(): string {
    const repoPath = this.config.gitRepoPath || '';
    if (isHomeDirectory(repoPath)) {
      console.warn(`[ConfigManager] ${HOME_GIT_SCAN_WARNING}`);
      return '';
    }
    return repoPath;
  }

  isVerbose(): boolean {
    return this.config.verbose || false;
  }

  /**
   * Whether PTY spawns should be routed through the isolated ptyHost
   * `UtilityProcess`. On by default on Windows. The `PANE_USE_PTY_HOST=1` env var is
   * honored as a dev override so testing doesn't require flipping the config.
   */
  getUsePtyHost(): boolean {
    if (process.env.PANE_USE_PTY_HOST === '1') return true;
    return this.config.usePtyHost === true;
  }

  getDatabasePath(): string {
    return path.join(this.configDir, 'sessions.db');
  }

  getAnthropicApiKey(): string | undefined {
    return this.config.anthropicApiKey;
  }

  getSystemPromptAppend(): string | undefined {
    return this.config.systemPromptAppend;
  }

  getRunScript(): string[] | undefined {
    return this.config.runScript;
  }

  getDefaultModel(): string {
    return this.config.defaultModel || 'sonnet';
  }

  getSessionCreationPreferences() {
    return this.config.sessionCreationPreferences || {
      sessionCount: 1,
      toolType: 'none',
      selectedTools: {
        claude: false
      },
      claudeConfig: {
        model: 'auto',
        permissionMode: 'ignore',
        ultrathink: false
      },
      showAdvanced: false,
      startPinned: false
    };
  }

  getAnalyticsSettings() {
    return this.config.analytics || defaultAnalyticsConfig();
  }

  isAnalyticsEnabled(): boolean {
    return this.config.analytics?.enabled ?? true;
  }

  getAnalyticsDistinctId(): string | undefined {
    return this.config.analytics?.distinctId;
  }

  private ensureAnalyticsConfig(): NonNullable<AppConfig['analytics']> {
    if (!this.config.analytics) {
      this.config.analytics = defaultAnalyticsConfig();
    }
    return this.config.analytics;
  }

  async getOrCreateAnalyticsInstallId(): Promise<string> {
    const analytics = this.ensureAnalyticsConfig();
    if (!analytics.installId) {
      analytics.installId = `install_${randomUUID()}`;
      await this.saveConfig();
    }
    return analytics.installId;
  }

  async setAnalyticsDistinctId(distinctId: string): Promise<void> {
    const analytics = this.ensureAnalyticsConfig();
    analytics.distinctId = distinctId;
    await this.saveConfig();
  }

  async setAnalyticsIdentity(identity: AnalyticsIdentity): Promise<void> {
    const analytics = this.ensureAnalyticsConfig();
    analytics.distinctId = identity.distinctId;
    analytics.identitySource = identity.identitySource;
    analytics.installId = identity.installId ?? analytics.installId;
    analytics.githubUsername = identity.githubUsername;
    analytics.githubEmail = identity.githubEmail;
    analytics.gitEmail = identity.gitEmail;
    analytics.gitEmailHash = identity.gitEmailHash;
    analytics.gitUserName = identity.gitUserName;
    await this.saveConfig();
  }

  /**
   * Get the user's preferred shell for terminal sessions.
   * Validates the preference against allowed values and returns 'auto' if invalid.
   * @returns One of: 'auto', 'gitbash', 'powershell', 'pwsh', 'cmd'
   */
  getPreferredShell(): string {
    const pref = this.config.preferredShell || 'auto';
    const validPrefs = ['auto', 'gitbash', 'powershell', 'pwsh', 'cmd'];
    return validPrefs.includes(pref) ? pref : 'auto';
  }

  /**
   * Get the configured worktree file sync entries.
   * Returns defaults if no entries are configured.
   */
  getWorktreeFileSyncEntries(): WorktreeFileSyncEntry[] {
    return this.config.worktreeFileSync ?? DEFAULT_WORKTREE_FILE_SYNC_ENTRIES;
  }
}
