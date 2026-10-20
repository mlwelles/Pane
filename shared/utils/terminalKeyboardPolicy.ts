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
  key?: string;
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

// Standard GNU Emacs/Readline editing and prefix bindings, before Pane's mod alias.
// Shifted Control letters share legacy terminal bytes; Command/Super is separate.
export function isTerminalEditingShortcut(event: TerminalEscapeShortcut): boolean {
  if (event.metaKey) return false;
  const { code, ctrlKey, altKey, shiftKey } = event;
  if (!ctrlKey && !altKey) {
    return !shiftKey && ['Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(code);
  }
  if (ctrlKey && !altKey && /^Key[A-Z]$/.test(code)) return true;
  if (altKey && /^Key[A-Z]$/.test(code)) {
    const letters = ctrlKey ? 'ABCDEFGHIJKLMNOPQRSTUVWXY' : 'ABCDEFGHIJKLMNPQRSTUVWXYZ';
    return letters.includes(code.slice(3));
  }
  if (/^Digit[0-9]$/.test(code)) {
    return !shiftKey || (!ctrlKey && ['Digit3', 'Digit7', 'Digit8'].includes(code))
      || (ctrlKey && !altKey && code === 'Digit2');
  }
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(code)) return !shiftKey;
  if (ctrlKey && ['ArrowUp', 'ArrowDown'].includes(code)) return !shiftKey;
  if (code === 'Space') return !shiftKey || ctrlKey;
  if (code === 'Minus') return !ctrlKey || !altKey || !shiftKey;
  if (code === 'Backslash' || code === 'IntlBackslash') return !shiftKey;
  if (ctrlKey) {
    if (code === 'Slash') return true;
    if (['BracketLeft', 'BracketRight'].includes(code)) return !shiftKey;
    return altKey && !shiftKey && ['Enter', 'Tab', 'Escape', 'Comma', 'Period'].includes(code);
  }
  if (['Comma', 'Period', 'Slash', 'Semicolon', 'Backquote'].includes(code)) return true;
  return !shiftKey && ['Equal', 'Quote', 'Escape'].includes(code);
}

export function defaultTerminalEscapeShortcut(_isMac: boolean): TerminalEscapeShortcut {
  return { code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true };
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
  const physicalCharacter = event.code.match(/^(?:Key([A-Z])|Digit([0-9]))$/);
  if (!isMac && event.ctrlKey && event.altKey && !event.metaKey && event.key !== undefined
    && (event.key === 'Dead' || (physicalCharacter && event.key.length === 1
      && event.key.toLowerCase() !== (physicalCharacter[1] ?? physicalCharacter[2]).toLowerCase()))) return 'terminal';
  const clipboard = clipboardDecision(event, isMac);
  if (clipboard) return clipboard;
  if (isTerminalEditingShortcut(event)) return 'terminal';
  const escape = isValidTerminalEscapeShortcut(config.terminalEscapeShortcut, isMac)
    ? config.terminalEscapeShortcut
    : defaultTerminalEscapeShortcut(isMac);
  const paletteEnabled = config.keyboardShortcutsEnabled !== false || config.commandPaletteShortcutEnabled !== false;
  if (paletteEnabled && event.code === escape.code
    && event.ctrlKey === escape.ctrlKey && event.metaKey === escape.metaKey
    && event.altKey === escape.altKey && event.shiftKey === escape.shiftKey) {
    return 'palette';
  }
  return 'standard';
}
