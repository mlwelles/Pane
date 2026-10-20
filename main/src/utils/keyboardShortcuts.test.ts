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

  it.each([true, false])('uses Command/Super+Shift+P for the terminal palette, mac=%s', isMac => {
    expect(defaultTerminalEscapeShortcut(isMac)).toEqual({ code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true });
    expect(resolveTerminalKeyboardEvent(defaultTerminalEscapeShortcut(isMac), readline, true, isMac)).toBe('palette');
  });

  it.each([
    { code: 'KeyK', ctrlKey: true },
    { code: 'KeyP', ctrlKey: true, shiftKey: true },
    { code: 'KeyX', ctrlKey: true },
    { code: 'Escape' },
    { code: 'Digit1', ctrlKey: true },
    { code: 'KeyB', altKey: true },
    { code: 'KeyF', altKey: true, shiftKey: true },
    { code: 'KeyK', ctrlKey: true, altKey: true },
    { code: 'ArrowLeft', ctrlKey: true, altKey: true },
    { code: 'Digit1', ctrlKey: true, altKey: true },
    { code: 'Space', ctrlKey: true },
    { code: 'Slash', ctrlKey: true },
    { code: 'BracketLeft', ctrlKey: true },
    { code: 'Backslash', ctrlKey: true },
    { code: 'Minus', ctrlKey: true, shiftKey: true },
    { code: 'Backspace', altKey: true },
    { code: 'Minus', altKey: true, shiftKey: true },
    { code: 'Semicolon', altKey: true, shiftKey: true },
  ])('protects standard editing and prefix input: %j', input => {
    const event = { ...ctrlW, code: 'KeyK', ctrlKey: false, ...input };
    expect(resolveTerminalKeyboardEvent(event, readline, true, true)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent(event, { ...readline, terminalEscapeShortcut: event }, true, true)).toBe('terminal');
  });

  it.each([
    { code: 'KeyK', metaKey: true }, { code: 'KeyF', metaKey: true },
    { code: 'KeyW', metaKey: true }, { code: 'KeyT', metaKey: true },
    { code: 'KeyN', metaKey: true }, { code: 'KeyB', metaKey: true },
    { code: 'ArrowLeft', metaKey: true, altKey: true },
    { code: 'Backslash', metaKey: true },
    { code: 'KeyK', metaKey: true, altKey: true },
    { code: 'KeyZ', ctrlKey: true, altKey: true },
    { code: 'Tab', ctrlKey: true }, { code: 'ArrowUp', shiftKey: true },
    { code: 'Enter', shiftKey: true }, { code: 'F6' },
    { code: 'Equal', altKey: true, shiftKey: true },
  ])('retains nonconflicting Pane shortcuts: %j', input => {
    expect(resolveTerminalKeyboardEvent({ ...ctrlW, ctrlKey: false, ...input }, readline, true, true)).toBe('standard');
  });

  it('matches a nonconflicting recorded palette shortcut with exact modifiers', () => {
    const shortcut = { ...ctrlW, code: 'F6' };
    const config = { ...readline, terminalEscapeShortcut: shortcut };
    expect(resolveTerminalKeyboardEvent(shortcut, config, true, true)).toBe('palette');
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(resolveTerminalKeyboardEvent({ ...shortcut, [modifier]: !shortcut[modifier] }, config, true, true)).toBe('standard');
    }
  });

  it.each([
    { keyboardShortcutsEnabled: true, commandPaletteShortcutEnabled: false, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: undefined, want: 'palette' },
    { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false, want: 'standard' },
  ])('honors the global palette switches: %j', ({ want, ...switches }) => {
    expect(resolveTerminalKeyboardEvent(defaultTerminalEscapeShortcut(true), { ...readline, ...switches }, true, true)).toBe(want);
  });

  it.each([true, false])('preserves exact platform clipboard chords, mac=%s', isMac => {
    for (const [code, decision] of [['KeyC', 'copy'], ['KeyV', 'paste']] as const) {
      const clipboard = { code, ctrlKey: !isMac, metaKey: isMac, altKey: false, shiftKey: !isMac };
      expect(resolveTerminalKeyboardEvent(clipboard, readline, true, isMac)).toBe(decision);
      expect(resolveTerminalKeyboardEvent({ ...clipboard, altKey: true }, readline, true, isMac)).not.toBe(decision);
      expect(resolveTerminalKeyboardEvent({ ...ctrlW, code }, readline, true, isMac)).toBe('terminal');
    }
  });

  it('does not treat unreported AltGr character output as a configured shortcut', () => {
    const shortcut = { code: 'KeyZ', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };
    const config = { ...readline, terminalEscapeShortcut: shortcut };
    const event = { ...shortcut, key: 'Ω' };
    expect(resolveTerminalKeyboardEvent(event, config, true, false)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent({ ...event, key: 'z' }, config, true, false)).toBe('palette');
  });

  it('never claims composition or AltGraph input', () => {
    const escape = defaultTerminalEscapeShortcut(true);
    expect(resolveTerminalKeyboardEvent({ ...escape, isComposing: true }, readline, true, true)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent({ ...escape, getModifierState: key => key === 'AltGraph' }, readline, true, false)).toBe('terminal');
    expect(resolveTerminalKeyboardEvent({ ...escape, getModifierState: () => false }, readline, true, false)).toBe('palette');
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
      terminalEscapeShortcut: { code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true },
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
