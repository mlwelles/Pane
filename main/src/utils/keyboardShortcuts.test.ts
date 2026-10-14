import { describe, expect, it } from 'vitest';
import {
  areKeyboardShortcutsEnabled,
  isCommandPaletteShortcutEnabled,
  shouldForwardCommandPaletteShortcut,
} from './keyboardShortcuts';
import {
  defaultTerminalEscapeShortcut,
  isValidTerminalEscapeShortcut,
  normalizeTerminalKeyboardConfig,
  resolveTerminalKeyboardEvent,
  type TerminalEscapeShortcut,
  type TerminalKeyboardConfig,
} from '../../../shared/utils/terminalKeyboardPolicy';

describe('terminal keyboard policy', () => {
  const ctrlW: TerminalEscapeShortcut = { code: 'KeyW', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  const readline: TerminalKeyboardConfig = { terminalKeyboardPreset: 'readline-friendly' };

  it('applies only to Readline-friendly terminal input focus', () => {
    expect(resolveTerminalKeyboardEvent(ctrlW, {}, true, true)).toBe('standard');
    expect(resolveTerminalKeyboardEvent(ctrlW, { terminalKeyboardPreset: 'standard' }, true, true)).toBe('standard');
    expect(resolveTerminalKeyboardEvent(ctrlW, readline, false, true)).toBe('standard');
    expect(resolveTerminalKeyboardEvent(ctrlW, readline, true, true)).toBe('terminal');
  });

  it.each([true, false])('uses the platform default escape with exact modifiers, mac=%s', (isMac) => {
    const escape = defaultTerminalEscapeShortcut(isMac);
    expect(escape).toEqual({ code: 'KeyP', ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: true });
    expect(resolveTerminalKeyboardEvent(escape, readline, true, isMac)).toBe('palette');
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(resolveTerminalKeyboardEvent({ ...escape, [modifier]: !escape[modifier] }, readline, true, isMac)).toBe('terminal');
    }
    expect(resolveTerminalKeyboardEvent({ ...escape, code: 'KeyQ' }, readline, true, isMac)).toBe('terminal');
  });

  it('keeps Ctrl and Command distinct in a custom macOS binding', () => {
    const config = { ...readline, terminalEscapeShortcut: ctrlW };
    expect(resolveTerminalKeyboardEvent(ctrlW, config, true, true)).toBe('palette');
    expect(resolveTerminalKeyboardEvent({ ...ctrlW, ctrlKey: false, metaKey: true }, config, true, true)).toBe('terminal');
  });

  it.each([
    { keyboardShortcutsEnabled: true, commandPaletteShortcutEnabled: false, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: undefined, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false, want: 'terminal' },
  ])('keeps the palette escape available according to the global switches: %j', ({ want, ...switches }) => {
    expect(resolveTerminalKeyboardEvent(defaultTerminalEscapeShortcut(true), { ...readline, ...switches }, true, true)).toBe(want);
  });

  it.each([true, false])('preserves only exact platform clipboard chords, mac=%s', (isMac) => {
    const base = { ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: !isMac };
    for (const [code, decision] of [['KeyC', 'copy'], ['KeyV', 'paste']] as const) {
      const clipboard = { code, ...base };
      expect(resolveTerminalKeyboardEvent(clipboard, readline, true, isMac)).toBe(decision);
      expect(resolveTerminalKeyboardEvent(clipboard, { ...readline, terminalEscapeShortcut: clipboard }, true, isMac)).toBe(decision);
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
        expect(resolveTerminalKeyboardEvent({ ...clipboard, [modifier]: !clipboard[modifier] }, readline, true, isMac)).toBe('terminal');
      }
      expect(resolveTerminalKeyboardEvent({ code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, readline, true, isMac)).toBe('terminal');
    }
  });

  it('never claims composition or AltGraph input', () => {
    const escape = { code: 'KeyB', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };
    const config = { ...readline, terminalEscapeShortcut: escape };
    expect(resolveTerminalKeyboardEvent({ ...escape, isComposing: true }, config, true, true)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent({ ...escape, getModifierState: (key) => key === 'AltGraph' }, config, true, false)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent({ ...escape, getModifierState: () => false }, config, true, false)).toBe('palette');
    expect(resolveTerminalKeyboardEvent({ code: 'KeyV', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, isComposing: true }, readline, true, true)).toBe('terminal');
  });

  it.each(['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F24', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'Enter', 'Tab', 'Escape', 'Space', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash', 'IntlRo', 'IntlYen'])('accepts a recognized nonmodifier physical code: %s', (code) => {
    expect(isValidTerminalEscapeShortcut({ ...ctrlW, code }, true)).toBe(true);
  });

  it.each(['ControlLeft', 'ControlRight', 'MetaLeft', 'AltRight', 'ShiftLeft', 'Unidentified', '', 'Keya', 'KeyAA', 'Digit10', 'F0', 'F25', 'not-a-code', 'Numpad1'])('rejects unsupported or modifier codes: %s', (code) => {
    expect(isValidTerminalEscapeShortcut({ ...ctrlW, code }, true)).toBe(false);
  });

  it.each([null, undefined, '', [], { code: 'KeyB' }, { ...ctrlW, ctrlKey: 'true' }, { ...ctrlW, metaKey: 0 }, { ...ctrlW, altKey: undefined }, { ...ctrlW, shiftKey: null }, { ...ctrlW, ctrlKey: false, shiftKey: true }])('rejects malformed or Shift-only bindings: %j', (value) => {
    expect(isValidTerminalEscapeShortcut(value, true)).toBe(false);
  });

  it.each([true, false])('rejects clipboard bindings only on their platform, mac=%s', (isMac) => {
    for (const code of ['KeyC', 'KeyV']) {
      expect(isValidTerminalEscapeShortcut({ code, ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: !isMac }, isMac)).toBe(false);
      expect(isValidTerminalEscapeShortcut({ code, ctrlKey: isMac, metaKey: !isMac, altKey: false, shiftKey: isMac }, isMac)).toBe(true);
    }
  });

  it('normalizes fields independently and preserves global switches', () => {
    expect(normalizeTerminalKeyboardConfig({ keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false }, false)).toEqual({
      terminalKeyboardPreset: 'standard',
      terminalEscapeShortcut: { code: 'KeyP', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true },
      keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false,
    });
    // SAFETY: Malformed disk fields exercise normalization below the compile-time config contract.
    expect(normalizeTerminalKeyboardConfig({ terminalKeyboardPreset: 'corrupt' as never, terminalEscapeShortcut: ctrlW }, true)).toMatchObject({ terminalKeyboardPreset: 'standard', terminalEscapeShortcut: ctrlW });
    // SAFETY: An empty saved shortcut exercises normalization below the compile-time config contract.
    expect(normalizeTerminalKeyboardConfig({ ...readline, terminalEscapeShortcut: {} as never }, true)).toMatchObject({
      terminalKeyboardPreset: 'readline-friendly',
      terminalEscapeShortcut: { code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true },
    });
  });
});

describe('areKeyboardShortcutsEnabled', () => {
  it('defaults to enabled for existing configurations', () => {
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
  });

  it('honors explicit enabled and disabled values', () => {
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: true })).toBe(true);
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: false })).toBe(false);
  });

  it('keeps the Command Palette shortcut as an optional exception', () => {
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: false,
      commandPaletteShortcutEnabled: false,
    })).toBe(false);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: true,
      commandPaletteShortcutEnabled: false,
    })).toBe(true);
  });

  it('forwards only the exact Command Palette chord from embedded panels', () => {
    const config = { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true };
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: false, code: 'KeyP' })).toBe(true);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: false, alt: false, code: 'KeyP' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: true, code: 'KeyP' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, { shift: true, alt: false, code: 'KeyW' })).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(
      { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false },
      { shift: true, alt: false, code: 'KeyP' },
    )).toBe(false);
  });
});
