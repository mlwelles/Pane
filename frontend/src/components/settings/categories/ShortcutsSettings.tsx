import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle, SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { TerminalShortcut } from '../../../types/config';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';
import { isMac } from '../../../utils/platformUtils';
import {
  defaultTerminalEscapeShortcut, isValidTerminalEscapeShortcut,
  normalizeTerminalKeyboardConfig, resolveTerminalKeyboardEvent,
  type TerminalEscapeShortcut,
} from '../../../../../shared/utils/terminalKeyboardPolicy';

function displayEscapeShortcut(shortcut: TerminalEscapeShortcut): string {
  const key = shortcut.code.replace(/^(Key|Digit)/, '');
  return [shortcut.ctrlKey && 'Ctrl', shortcut.metaKey && 'Command',
    shortcut.altKey && (isMac() ? 'Option' : 'Alt'), shortcut.shiftKey && 'Shift', key]
    .filter(Boolean).join('+');
}

interface ShortcutsSettingsProps {
  persistence: SettingsPersistence;
  onDirtyChange: (dirty: boolean) => void;
  onShowKeyboardShortcuts: () => void;
}

export function ShortcutsSettings({ persistence, onDirtyChange, onShowKeyboardShortcuts }: ShortcutsSettingsProps) {
  const config = persistence.config!;
  const [recording, setRecording] = useState(false);
  const pendingShortcut = useRef<{ shortcut: TerminalEscapeShortcut; commandReleased: boolean } | null>(null);
  const releasedCommandKey = useRef<string | null>(null);
  const [recordError, setRecordError] = useState<string>();
  const escapeShortcut = normalizeTerminalKeyboardConfig(config, isMac()).terminalEscapeShortcut!;
  const escapeSaving = persistence.saveStates['terminal-escape-shortcut']?.state === 'saving';
  const saveEscape = async (shortcut: TerminalEscapeShortcut) => {
    pendingShortcut.current = null;
    setRecording(false);
    setRecordError(undefined);
    await persistence.saveConfig('terminal-escape-shortcut', { terminalEscapeShortcut: shortcut });
  };
  const cancelRecording = () => {
    pendingShortcut.current = null;
    setRecording(false);
    setRecordError(undefined);
  };
  useEffect(() => {
    if (!recording) return;
    const cancel = () => {
      pendingShortcut.current = null;
      setRecording(false);
      setRecordError(undefined);
    };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [recording]);
  useEffect(() => {
    // macOS may omit keyup for Command chords; consume a still-held key after saving.
    const consumeHeldKey = (event: KeyboardEvent) => {
      if (event.code !== releasedCommandKey.current) return;
      if (event.type === 'keydown' && !event.repeat) {
        releasedCommandKey.current = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keyup') releasedCommandKey.current = null;
    };
    const clearHeldKey = () => { releasedCommandKey.current = null; };
    window.addEventListener('keydown', consumeHeldKey, true);
    window.addEventListener('keyup', consumeHeldKey, true);
    window.addEventListener('blur', clearHeldKey);
    return () => {
      window.removeEventListener('keydown', consumeHeldKey, true);
      window.removeEventListener('keyup', consumeHeldKey, true);
      window.removeEventListener('blur', clearHeldKey);
    };
  }, []);
  const persistedShortcuts = config.terminalShortcuts ?? [];
  const persistedKey = JSON.stringify(persistedShortcuts);
  const [shortcuts, setShortcuts] = useState<TerminalShortcut[]>(persistedShortcuts);
  const dirty = JSON.stringify(shortcuts) !== persistedKey;

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setShortcuts(JSON.parse(persistedKey) as TerminalShortcut[]), [persistedKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const shortcut of shortcuts.filter((item) => item.enabled && item.key)) {
      counts.set(shortcut.key, (counts.get(shortcut.key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
  }, [shortcuts]);
  const invalid = shortcuts.some((shortcut) => !shortcut.label.trim() || !shortcut.key || !shortcut.text.trim()) || duplicateKeys.size > 0;

  const update = (index: number, patch: Partial<TerminalShortcut>) => {
    setShortcuts((current) => current.map((shortcut, shortcutIndex) => (
      shortcutIndex === index ? { ...shortcut, ...patch } : shortcut
    )));
  };

  const apply = async () => {
    if (invalid) return;
    const saved = await persistence.saveConfig('terminal-shortcuts', { terminalShortcuts: shortcuts });
    if (saved) onDirtyChange(false);
  };

  return (
    <SettingsPage title="Shortcuts" description="Control Pane keyboard shortcuts and terminal snippet hotkeys.">
      <SettingsSection title="Application shortcuts">
        <SettingRow
          settingId="keyboard-shortcuts"
          label="Enable Pane keyboard shortcuts"
          description="When disabled, Pane shortcuts won't work, but native terminal and embedded app shortcuts will. The Command Palette shortcut can remain enabled below."
          saveState={persistence.saveStates['keyboard-shortcuts']}
        >
          <ImmediateToggle
            label="Enable Pane keyboard shortcuts"
            value={config.keyboardShortcutsEnabled !== false}
            onSave={(value) => persistence.saveConfig('keyboard-shortcuts', { keyboardShortcutsEnabled: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="command-palette-shortcut"
          label="Keep Command Palette shortcut enabled"
          description="Keep the Command Palette shortcut, including the terminal escape shortcut, available when other Pane keyboard shortcuts are disabled."
          saveState={persistence.saveStates['command-palette-shortcut']}
        >
          <ImmediateToggle
            label="Keep Command Palette shortcut enabled"
            value={config.commandPaletteShortcutEnabled !== false}
            onSave={(value) => persistence.saveConfig('command-palette-shortcut', { commandPaletteShortcutEnabled: value })}
          />
        </SettingRow>
        <button
          type="button"
          className="text-sm font-medium text-interactive underline underline-offset-4 hover:text-interactive-hover"
          onClick={onShowKeyboardShortcuts}
        >
          View all Pane keyboard shortcuts
        </button>
      </SettingsSection>
      <SettingsSection title="Terminal keyboard">
        <SettingRow
          settingId="terminal-keyboard-preset"
          label="Terminal keyboard preset"
          description="Readline-friendly passes editing keys to the terminal. Snippet shortcuts and the @ terminal picker do not intercept input. On macOS, Option sends Meta keys instead of special characters while terminal input has focus."
          saveState={persistence.saveStates['terminal-keyboard-preset']}
        >
          <SegmentedControl
            label="Terminal keyboard preset"
            value={config.terminalKeyboardPreset ?? 'standard'}
            options={[
              { id: 'standard', label: 'Standard' },
              { id: 'readline-friendly', label: 'Readline-friendly' },
            ]}
            onChange={(value) => {
              void persistence.saveConfig('terminal-keyboard-preset', { terminalKeyboardPreset: value });
            }}
          />
        </SettingRow>
        <SettingRow
          settingId="terminal-escape-shortcut"
          label="Open command palette from terminal"
          description="In Readline-friendly, this shortcut opens Pane's command palette. Record one key combination containing Ctrl, Command, or Alt/Option; terminal clipboard shortcuts are reserved."
          saveState={persistence.saveStates['terminal-escape-shortcut']}
        >
          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              aria-label="Record terminal palette shortcut"
              data-shortcut-recording={recording ? 'true' : undefined}
              disabled={escapeSaving}
              onClick={() => { pendingShortcut.current = null; setRecordError(undefined); setRecording(true); }}
              onBlur={cancelRecording}
              onKeyDown={(event) => {
                if (!recording) return;
                event.preventDefault();
                event.stopPropagation();
                if (pendingShortcut.current || event.repeat || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'].includes(event.key)) return;
                const shortcut: TerminalEscapeShortcut = {
                  code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
                  altKey: event.altKey, shiftKey: event.shiftKey,
                };
                if (!isValidTerminalEscapeShortcut(shortcut, isMac())) {
                  const clipboard = resolveTerminalKeyboardEvent(shortcut, { terminalKeyboardPreset: 'readline-friendly' }, true, isMac());
                  setRecordError(clipboard === 'copy' || clipboard === 'paste'
                    ? 'This combination is reserved for terminal clipboard operations.'
                    : 'Use Ctrl, Command, or Alt with a key. Shift alone is not enough.');
                  return;
                }
                pendingShortcut.current = { shortcut, commandReleased: false };
              }}
              onKeyUp={(event) => {
                if (!recording) return;
                event.preventDefault();
                event.stopPropagation();
                const pending = pendingShortcut.current;
                if (!pending) return;
                const { shortcut } = pending;
                if (shortcut.code === event.code) {
                  void saveEscape(shortcut);
                  return;
                }
                if (event.key === 'Meta' && !event.metaKey) pending.commandReleased = true;
                const modifier = ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph'].includes(event.key);
                if (isMac() && shortcut.metaKey && pending.commandReleased && modifier
                  && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                  releasedCommandKey.current = shortcut.code;
                  void saveEscape(shortcut);
                }
              }}
            >
              {recording ? 'Press a key combination' : displayEscapeShortcut(escapeShortcut)}
            </Button>
            <div className="flex gap-2">
              {recording && <Button type="button" variant="secondary" size="sm" onClick={cancelRecording}>Cancel</Button>}
              <Button type="button" variant="secondary" size="sm" disabled={escapeSaving}
                onClick={() => { void saveEscape(defaultTerminalEscapeShortcut(isMac())); }}>
                Restore default
              </Button>
            </div>
            {recordError && <p role="alert" className="text-xs text-status-error">{recordError}</p>}
          </div>
        </SettingRow>
        {config.keyboardShortcutsEnabled === false && config.commandPaletteShortcutEnabled === false && (
          <p className="text-sm text-text-secondary">Both shortcut switches are off. Use the mouse to return to Pane.</p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Terminal key reporting"
        description="How Pane encodes keystrokes for the program running inside a terminal."
      >
        <SettingRow
          settingId="kitty-keyboard"
          label="Kitty keyboard protocol"
          description="Lets a program ask for precise key reporting: key releases and repeats as distinct events, and modifier keys such as Ctrl or Shift reported on their own. Games and full-screen apps need it to tell a held key from a tapped one. Most terminal programs never ask, and are unaffected either way, so this changes nothing for an ordinary shell or for CLI agents that do not request it. Turn it off if a program misreads your keystrokes after asking for the protocol."
          saveState={persistence.saveStates['kitty-keyboard']}
        >
          <ImmediateToggle
            label="Kitty keyboard protocol"
            value={config.kittyKeyboardEnabled !== false}
            onSave={(value) => persistence.saveConfig('kitty-keyboard', { kittyKeyboardEnabled: value })}
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Terminal snippets">
        <SettingRow
          settingId="terminal-shortcuts"
          label="Snippet shortcuts"
          description="Each enabled shortcut needs a unique letter, label, and snippet."
          saveState={persistence.saveStates['terminal-shortcuts']}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[500px]">
            {shortcuts.map((shortcut, index) => (
              <div key={shortcut.id} className="space-y-2 rounded-md border border-border-secondary p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_80px_auto] items-start gap-2">
                  <Input
                    label="Label"
                    value={shortcut.label}
                    onChange={(event) => update(index, { label: event.target.value })}
                    error={!shortcut.label.trim() ? 'Label is required' : undefined}
                    fullWidth
                  />
                  <Input
                    label="Key"
                    value={shortcut.key}
                    onChange={(event) => update(index, { key: event.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 1) })}
                    error={!shortcut.key ? 'Required' : duplicateKeys.has(shortcut.key) ? 'In use' : undefined}
                    fullWidth
                  />
                  <div className="flex gap-1 pt-6">
                    <IconButton
                      type="button"
                      aria-label={shortcut.enabled ? 'Disable shortcut' : 'Enable shortcut'}
                      title={shortcut.enabled ? 'Disable' : 'Enable'}
                      icon={shortcut.enabled ? <Power className="h-4 w-4 text-status-success" /> : <PowerOff className="h-4 w-4" />}
                      onClick={() => update(index, { enabled: !shortcut.enabled })}
                    />
                    <IconButton
                      type="button"
                      aria-label="Delete shortcut"
                      title="Delete"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setShortcuts((current) => current.filter((_, shortcutIndex) => shortcutIndex !== index))}
                    />
                  </div>
                </div>
                <Textarea
                  label="Snippet text"
                  value={shortcut.text}
                  onChange={(event) => update(index, { text: event.target.value })}
                  error={!shortcut.text.trim() ? 'Snippet text is required' : undefined}
                  rows={2}
                  fullWidth
                />
                <p className="text-xs text-text-tertiary">
                  {shortcut.key ? formatKeyDisplay(`mod+alt+${shortcut.key}`) : 'Choose a letter from a-z'}
                </p>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setShortcuts((current) => [...current, {
                  id: crypto.randomUUID(), label: '', key: '', text: '', enabled: true,
                }])}
              >
                Add Shortcut
              </Button>
              <Button type="button" size="sm" disabled={!dirty || invalid} onClick={apply}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
