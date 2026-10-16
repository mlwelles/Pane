import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalKeyboardConfig } from '../../../shared/utils/terminalKeyboardPolicy';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { installWindowKeyboardRouting } from './windowKeyboardRouting';

class TestContents extends EventEmitter {
  // SAFETY: Only main-frame object identity is used by the routing boundary.
  readonly mainFrame = {} as Electron.WebFrameMain;
  readonly send = vi.fn();
  readonly setIgnoreMenuShortcuts = vi.fn();
  isDestroyed(): boolean { return false; }
}

function fixture(config: TerminalKeyboardConfig = { terminalKeyboardPreset: 'readline-friendly' }) {
  const contents = new TestContents();
  const ipc = new EventEmitter();
  let currentConfig = config;
  // SAFETY: These structural doubles implement the Electron methods consumed by the routing helper.
  const dispose = installWindowKeyboardRouting(contents as Electron.WebContents, ipc as Electron.IpcMain, () => currentConfig);
  const focus = (value: JsonValue, sender = contents, senderFrame = contents.mainFrame) => {
    ipc.emit('window:terminal-input-focus', { sender, senderFrame }, value);
  };
  const record = (value: JsonValue, sender = contents, senderFrame = contents.mainFrame) => {
    ipc.emit('window:shortcut-recording-focus', { sender, senderFrame }, value);
  };
  const key = (overrides: Partial<Electron.Input> = {}) => {
    const event = { preventDefault: vi.fn() };
    contents.emit('before-input-event', event, {
      type: 'keyDown', key: 'w', code: 'KeyW', control: true, meta: false, alt: false, shift: false,
      isAutoRepeat: false, isComposing: false, ...overrides,
    });
    return event;
  };
  return { contents, ipc, dispose, focus, record, key, config: (value: TerminalKeyboardConfig) => { currentConfig = value; } };
}

afterEach(() => vi.restoreAllMocks());

describe('window terminal keyboard ownership', () => {
  it.each(['standard', 'readline-friendly'] as const)('keeps every recorder event local under %s', preset => {
    const f = fixture({ terminalKeyboardPreset: preset });
    f.record(true);
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    f.focus(false);
    for (const overrides of [{}, { isAutoRepeat: true }, { type: 'keyUp' as const },
      { key: 'v', code: 'KeyV', meta: true, control: false }]) {
      expect(f.key(overrides).preventDefault).not.toHaveBeenCalled();
      expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    }
    expect(f.contents.send).not.toHaveBeenCalled();
    f.record(false);
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('rejects malformed, foreign-window and child-frame recorder reports', () => {
    const f = fixture({ terminalKeyboardPreset: 'standard' });
    for (const report of [() => f.record('true'), () => f.record(true, new TestContents()),
      () => f.record(true, f.contents, new TestContents().mainFrame)]) {
      report();
      expect(f.key().preventDefault).toHaveBeenCalledOnce();
    }
    f.record(true);
    f.record(false, new TestContents());
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.dispose();
    expect(f.ipc.listenerCount('window:shortcut-recording-focus')).toBe(0);
  });

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])('clears recorder state after %s', event => {
    const f = fixture();
    f.record(true);
    f.key();
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    f.contents.emit(event);
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    if (event !== 'destroyed') expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('clears recorder state only on main-frame navigation', () => {
    const f = fixture();
    f.record(true);
    f.contents.emit('did-start-navigation', { isMainFrame: false });
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.contents.emit('did-start-navigation', { isMainFrame: true });
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('lets Ctrl+W reach the focused terminal without a synthetic renderer event', () => {
    const f = fixture();
    f.focus(true);
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    expect(f.contents.send).not.toHaveBeenCalled();
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    f.dispose();
  });

  it('preserves Standard Ctrl/Cmd+W interception verbatim', () => {
    const f = fixture({ terminalKeyboardPreset: 'standard' });
    f.focus(true);
    expect(f.key({ control: false, meta: true }).preventDefault).toHaveBeenCalledOnce();
    expect(f.contents.send).toHaveBeenCalledWith('synthetic-keydown', {
      key: 'w', code: 'KeyW', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false,
    });
    expect(f.key({ type: 'keyUp' }).preventDefault).not.toHaveBeenCalled();
    f.config({ keyboardShortcutsEnabled: false });
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.dispose();
  });

  it.each(['darwin', 'linux', 'win32'])('permits only exact clipboard menu chords on %s', platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const f = fixture();
    f.focus(true);
    for (const code of ['KeyC', 'KeyV']) {
      f.key({ code, key: code.slice(3).toLowerCase(), control: platform !== 'darwin', meta: platform === 'darwin', shift: platform !== 'darwin' });
      expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      f.key({ code, alt: true });
      expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    }
    f.key({ code: 'KeyP', key: 'P', shift: true });
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    f.dispose();
  });

  it('restores menu handling on focus loss and reads preset changes on each event', () => {
    const f = fixture();
    f.focus(true);
    f.key();
    f.focus(false);
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.focus(true);
    f.config({ terminalKeyboardPreset: 'standard' });
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    f.config({ terminalKeyboardPreset: 'readline-friendly' });
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.dispose();
  });

  it.each(['did-navigate', 'render-process-gone'])('clears stale terminal focus after %s', event => {
    const f = fixture();
    f.focus(true);
    f.key();
    f.contents.emit(event);
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.dispose();
  });

  it('rejects malformed, foreign-window and child-frame focus reports', () => {
    const f = fixture();
    f.focus('true');
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.focus(true, new TestContents());
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.focus(true, f.contents, new TestContents().mainFrame);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.focus(true);
    f.focus(false, new TestContents());
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.dispose();
  });

  it('removes window and IPC listeners when disposed or destroyed', () => {
    const f = fixture();
    f.focus(true);
    f.key();
    f.contents.emit('destroyed');
    expect(f.ipc.listenerCount('window:terminal-input-focus')).toBe(0);
    expect(f.contents.listenerCount('before-input-event')).toBe(0);
    expect(f.contents.listenerCount('did-navigate')).toBe(0);
    expect(f.contents.listenerCount('render-process-gone')).toBe(0);
    f.dispose();
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });

  it('clears focus when main-frame navigation starts but leaves child-frame navigation alone', () => {
    const f = fixture();
    f.focus(true);
    f.key();
    f.contents.emit('did-start-navigation', { isMainFrame: false });
    expect(f.key().preventDefault).not.toHaveBeenCalled();
    f.contents.emit('did-start-navigation', { isMainFrame: true });
    expect(f.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(f.key().preventDefault).toHaveBeenCalledOnce();
    f.dispose();
    expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
  });
});
