import { boundary, BoundaryDecodeError, decodeBoundary } from '../validation/boundaryDecoder';

export type TerminalKeyboardPreset = 'standard' | 'readline-friendly';

export interface TerminalEscapeShortcut {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface TerminalKeyboardConfig {
  terminalKeyboardPreset?: TerminalKeyboardPreset;
  terminalEscapeShortcut?: TerminalEscapeShortcut;
  keyboardShortcutsEnabled?: boolean;
  commandPaletteShortcutEnabled?: boolean;
}

export interface TerminalKeyboardEvent extends TerminalEscapeShortcut {
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
}

export type TerminalKeyboardDecision = 'standard' | 'terminal' | 'palette' | 'copy' | 'paste';

const nonLetterCodes = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'Backspace', 'Enter', 'Tab', 'Escape', 'Space',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote',
  'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash', 'IntlRo', 'IntlYen',
]);

const escapeShortcutSchema = boundary.object({
  code: boundary.string,
  ctrlKey: boundary.boolean,
  metaKey: boundary.boolean,
  altKey: boundary.boolean,
  shiftKey: boundary.boolean,
});

function clipboardDecision(shortcut: TerminalEscapeShortcut, isMac: boolean): 'copy' | 'paste' | undefined {
  if (shortcut.ctrlKey !== !isMac || shortcut.metaKey !== isMac || shortcut.altKey || shortcut.shiftKey !== !isMac) {
    return undefined;
  }
  if (shortcut.code === 'KeyC') return 'copy';
  if (shortcut.code === 'KeyV') return 'paste';
  return undefined;
}

export function defaultTerminalEscapeShortcut(isMac: boolean): TerminalEscapeShortcut {
  return { code: 'KeyP', ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: true };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parses untrusted disk and IPC shortcut values with the shared boundary schema.
export function isValidTerminalEscapeShortcut(value: unknown, isMac: boolean): value is TerminalEscapeShortcut {
  try {
    const shortcut = decodeBoundary(value, escapeShortcutSchema);
    return (shortcut.ctrlKey || shortcut.metaKey || shortcut.altKey)
      && (/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(shortcut.code) || nonLetterCodes.has(shortcut.code))
      && clipboardDecision(shortcut, isMac) === undefined;
  } catch (error) {
    if (error instanceof BoundaryDecodeError) return false;
    throw error;
  }
}

export function normalizeTerminalKeyboardConfig(value: TerminalKeyboardConfig, isMac: boolean): TerminalKeyboardConfig {
  return {
    ...value,
    terminalKeyboardPreset: value.terminalKeyboardPreset === 'readline-friendly' ? 'readline-friendly' : 'standard',
    terminalEscapeShortcut: isValidTerminalEscapeShortcut(value.terminalEscapeShortcut, isMac)
      ? value.terminalEscapeShortcut
      : defaultTerminalEscapeShortcut(isMac),
  };
}

export function resolveTerminalKeyboardEvent(
  event: TerminalKeyboardEvent,
  config: TerminalKeyboardConfig,
  terminalInputFocused: boolean,
  isMac: boolean,
): TerminalKeyboardDecision {
  if (config.terminalKeyboardPreset !== 'readline-friendly' || !terminalInputFocused) return 'standard';
  if (event.isComposing || event.getModifierState?.('AltGraph')) return 'terminal';
  const clipboard = clipboardDecision(event, isMac);
  if (clipboard) return clipboard;
  const escape = isValidTerminalEscapeShortcut(config.terminalEscapeShortcut, isMac)
    ? config.terminalEscapeShortcut
    : defaultTerminalEscapeShortcut(isMac);
  const paletteEnabled = config.keyboardShortcutsEnabled !== false || config.commandPaletteShortcutEnabled !== false;
  if (paletteEnabled && event.code === escape.code
    && event.ctrlKey === escape.ctrlKey && event.metaKey === escape.metaKey
    && event.altKey === escape.altKey && event.shiftKey === escape.shiftKey) {
    return 'palette';
  }
  return 'terminal';
}
