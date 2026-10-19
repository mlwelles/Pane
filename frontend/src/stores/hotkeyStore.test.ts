import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';
import { isHotkeyEnabledForEvent, useHotkeyStore } from './hotkeyStore';
import { handleTerminalKeyboardPresetEvent } from '../utils/terminalKeyHandling';

interface HotkeyTestTarget {
  tagName: string;
  isContentEditable: boolean;
  classList?: { contains: (name: string) => boolean };
  closest: (selector: string) => { matched: true } | null;
  matches?: (selector: string) => boolean;
}

interface HotkeyTestEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: HotkeyTestTarget;
  getModifierState: (keyArg: string) => boolean;
  preventDefault: () => void;
}

function keyboardEvent(
  init: KeyboardEventInit,
  target: HotkeyTestTarget,
  preventDefault: () => void,
): HotkeyTestEvent {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target,
    getModifierState: () => false,
    preventDefault,
  };
}

describe('hotkeyStore keyboard shortcut preference', () => {
  let keydownListener: ((event: HotkeyTestEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('navigator', { platform: 'Linux' });
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: HotkeyTestEvent) => void) => {
        if (type === 'keydown') keydownListener = listener;
      },
      removeEventListener: vi.fn(),
    });
  });

  it.each(['a', 'k', 'w'])('leaves Ctrl+%s to focused Readline terminal input', (letter) => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { terminalKeyboardPreset: 'readline-friendly' } });
    useHotkeyStore.getState().register({
      id: 'test-shortcut', label: 'Test shortcut', keys: `mod+${letter}`, category: 'tabs', action,
    });
    const event = keyboardEvent({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }, {
      tagName: 'TEXTAREA', isContentEditable: false, closest: () => null,
      matches: selector => selector === 'textarea.xterm-helper-textarea',
      classList: { contains: name => name === 'xterm-helper-textarea' },
    }, preventDefault);
    keydownListener?.(event);
    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    const availabilityEvent: Event = Object.assign(new Event('keydown'), {
      key: event.key, code: event.code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      getModifierState: () => false,
    });
    Object.defineProperty(availabilityEvent, 'target', { value: Object.assign(new EventTarget(), event.target) });
    // SAFETY: The structural event includes the keyboard fields read by hotkey matching.
    expect(isHotkeyEnabledForEvent(availabilityEvent as KeyboardEvent)).toBe(false);
  });

  it.each([
    { key: 'k', code: 'KeyK', metaKey: true, keys: 'mod+k' },
    { key: 'k', code: 'KeyK', metaKey: true, altKey: true, keys: 'mod+alt+k' },
    { key: '\\', code: 'Backslash', metaKey: true, keys: 'mod+\\' },
  ])('runs a nonconflicting macOS shortcut from terminal input: $keys', ({ keys, ...input }) => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const action = vi.fn();
    useConfigStore.setState({ config: { terminalKeyboardPreset: 'readline-friendly' } });
    useHotkeyStore.getState().register({ id: 'test-shortcut', label: 'Test shortcut', keys, category: 'tabs', action });
    keydownListener?.(keyboardEvent(input, {
      tagName: 'TEXTAREA', isContentEditable: false, closest: () => null,
      matches: () => true, classList: { contains: () => true },
    }, vi.fn()));
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps a nonconflicting registered palette chord alongside its terminal replacement', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: {
      terminalKeyboardPreset: 'readline-friendly',
      terminalEscapeShortcut: { code: 'KeyO', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false },
    } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette', label: 'Open Command Palette', keys: 'mod+shift+p', category: 'navigation', action,
    });
    const target = {
      tagName: 'TEXTAREA', isContentEditable: false, closest: () => null,
      matches: (selector: string) => selector === 'textarea.xterm-helper-textarea',
      classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
    };
    keydownListener?.(keyboardEvent({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }, target, preventDefault));
    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    keydownListener?.(keyboardEvent({ key: 'o', code: 'KeyO', altKey: true }, target, preventDefault));
    expect(action).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it.each([
    { preset: 'standard' as const, helper: true },
    { preset: 'readline-friendly' as const, helper: false },
  ])('retains ordinary shortcut behavior for $preset, helper=$helper', ({ preset, helper }) => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { terminalKeyboardPreset: preset } });
    useHotkeyStore.getState().register({
      id: 'test-shortcut', label: 'Test shortcut', keys: 'mod+k', category: 'tabs', action,
    });
    keydownListener?.(keyboardEvent({ key: 'k', code: 'KeyK', ctrlKey: true }, {
      tagName: helper ? 'TEXTAREA' : 'INPUT', isContentEditable: false, closest: () => null,
      matches: () => helper,
      classList: { contains: () => helper },
    }, preventDefault));
    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('keeps modal and availability restrictions on the terminal palette escape', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { terminalKeyboardPreset: 'readline-friendly' } });
    const definition = {
      id: 'open-command-palette', label: 'Open Command Palette', keys: 'mod+shift+p',
      category: 'navigation' as const, action,
    };
    let modalOpen = true;
    const dispatch = () => keydownListener?.(keyboardEvent({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }, {
      tagName: 'TEXTAREA', isContentEditable: false,
      closest: selector => modalOpen && selector === '[aria-modal="true"]' ? { matched: true } : null,
      matches: () => true, classList: { contains: () => true },
    }, preventDefault));
    useHotkeyStore.getState().register(definition);
    dispatch();
    modalOpen = false;
    useHotkeyStore.getState().register({ ...definition, enabled: () => false });
    dispatch();
    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it.each(['standard', 'readline-friendly'] as const)('requires modal opt-in in the shared availability check for %s', preset => {
    useConfigStore.setState({ config: { terminalKeyboardPreset: preset } });
    const definition = {
      id: 'open-command-palette', label: 'Open Command Palette', keys: 'mod+shift+p',
      category: 'navigation' as const, action: () => {},
    };
    const target = Object.assign(new EventTarget(), {
      matches: (selector: string) => selector === 'textarea.xterm-helper-textarea',
      closest: (selector: string) => selector === '[aria-modal="true"]' ? target : null,
    });
    const event: Event = Object.assign(new Event('keydown'), {
      key: 'P', code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true,
      getModifierState: () => false,
    });
    Object.defineProperty(event, 'target', { value: target });
    useHotkeyStore.getState().register(definition);
    // SAFETY: The structural event supplies the keyboard fields consumed by hotkey matching.
    expect(isHotkeyEnabledForEvent(event as KeyboardEvent)).toBe(false);
    useHotkeyStore.getState().register({ ...definition, allowInModal: true });
    // SAFETY: The structural event supplies the keyboard fields consumed by hotkey matching.
    expect(isHotkeyEnabledForEvent(event as KeyboardEvent)).toBe(true);
  });

  it.each([false, true])('honors allowInModal=%s through the direct terminal palette callback', allowInModal => {
    const config = { terminalKeyboardPreset: 'readline-friendly' as const };
    useConfigStore.setState({ config });
    let paletteOpens = 0;
    useHotkeyStore.getState().register({
      id: 'open-command-palette', label: 'Open Command Palette', keys: 'mod+shift+p',
      category: 'navigation', allowInModal, action: () => { paletteOpens += 1; },
    });
    const target = Object.assign(new EventTarget(), {
      matches: (selector: string) => selector === 'textarea.xterm-helper-textarea',
      closest: (selector: string) => selector === '[aria-modal="true"]' ? target : null,
    });
    const event: Event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'P', code: 'KeyP', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true,
      getModifierState: () => false,
    });
    Object.defineProperty(event, 'target', { value: target });
    // SAFETY: The structural event supplies the DOM keyboard fields read by both routing helpers.
    const input = event as KeyboardEvent;
    const result = handleTerminalKeyboardPresetEvent(input, config, {
      copy: () => {},
      openPalette: () => {
        if (isHotkeyEnabledForEvent(input)) useHotkeyStore.getState().hotkeys.get('open-command-palette')?.action();
      },
    }, false);

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(paletteOpens).toBe(allowInModal ? 1 : 0);
  });

  afterEach(() => {
    useHotkeyStore.getState().unregister('test-shortcut');
    useHotkeyStore.getState().unregister('open-command-palette');
    useConfigStore.setState({ config: null });
    vi.unstubAllGlobals();
  });

  it('does not execute or prevent disabled Pane shortcuts', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'test-shortcut',
      label: 'Test shortcut',
      keys: 'mod+w',
      category: 'tabs',
      action,
    });

    keydownListener?.(keyboardEvent({
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('waits for config while preserving legacy enabled behavior', () => {
    expect(areKeyboardShortcutsEnabled(null)).toBe(false);
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
    expect(isCommandPaletteShortcutEnabled(null)).toBe(false);
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
  });

  it('allows only the Command Palette shortcut when configured as an exception', () => {
    const paletteAction = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: { keyboardShortcutsEnabled: false } });
    useHotkeyStore.getState().register({
      id: 'open-command-palette',
      label: 'Open Command Palette',
      keys: 'mod+shift+p',
      category: 'navigation',
      action: paletteAction,
    });

    keydownListener?.(keyboardEvent({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();

    useConfigStore.setState({
      config: {
        keyboardShortcutsEnabled: false,
        commandPaletteShortcutEnabled: false,
      },
    });
    keydownListener?.(keyboardEvent({
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, { tagName: 'DIV', isContentEditable: false, closest: () => null }, preventDefault));

    expect(paletteAction).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('allows an opted-in unmodified shortcut from xterm but not ordinary textareas', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: {} });
    useHotkeyStore.getState().register({
      id: 'test-shortcut',
      label: 'Scroll terminal',
      keys: 'shift+ArrowDown',
      category: 'view',
      action,
      allowInXterm: true,
    });
    const event = {
      key: 'ArrowDown',
      code: 'ArrowDown',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      getModifierState: () => false,
      preventDefault,
    };

    keydownListener?.(keyboardEvent({
      ...event,
    }, {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        classList: { contains: (name: string) => name === 'xterm-helper-textarea' },
        closest: () => null,
      }, preventDefault));
    keydownListener?.(keyboardEvent({
      ...event,
    }, {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        classList: { contains: () => false },
        closest: () => null,
      }, preventDefault));

    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('runs only explicitly modal-safe shortcuts inside dialogs', () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    useConfigStore.setState({ config: {} });
    const definition = {
      id: 'test-shortcut',
      label: 'Scroll modal',
      keys: 'shift+ArrowUp',
      category: 'view' as const,
      action,
    };
    const dispatch = () => keydownListener?.(keyboardEvent({
      key: 'ArrowUp',
      code: 'ArrowUp',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, {
        tagName: 'DIV',
        isContentEditable: false,
        closest: (selector: string) => selector === '[aria-modal="true"]' ? { matched: true } : null,
      }, preventDefault));

    useHotkeyStore.getState().register(definition);
    dispatch();
    useHotkeyStore.getState().register({ ...definition, allowInModal: true });
    dispatch();

    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
