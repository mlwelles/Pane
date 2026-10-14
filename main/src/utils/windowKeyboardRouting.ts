import { resolveTerminalKeyboardEvent, type TerminalKeyboardConfig } from '../../../shared/utils/terminalKeyboardPolicy';
import { areKeyboardShortcutsEnabled } from './keyboardShortcuts';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

export function installWindowKeyboardRouting(
  contents: Electron.WebContents,
  ipcMain: Electron.IpcMain,
  getConfig: () => TerminalKeyboardConfig,
): () => void {
  let terminalInputFocused = false;
  let disposed = false;
  const restoreMenus = () => {
    terminalInputFocused = false;
    if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
  };
  const reportFocus = (event: Electron.IpcMainEvent, value: JsonValue) => {
    const focused = decodeOptionalBoundary(value, boundary.boolean);
    if (focused === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    terminalInputFocused = focused;
    if (!focused) contents.setIgnoreMenuShortcuts(false);
  };
  const startNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame) restoreMenus();
  };
  const beforeInput = (event: Electron.Event, input: Electron.Input) => {
    const config = getConfig();
    const decision = resolveTerminalKeyboardEvent({
      code: input.code, ctrlKey: input.control, metaKey: input.meta,
      altKey: input.alt, shiftKey: input.shift, isComposing: input.isComposing,
    }, config, terminalInputFocused, process.platform === 'darwin');
    const protectedTerminal = decision !== 'standard';
    const nativeClipboardKey = decision === 'copy' || decision === 'paste';
    contents.setIgnoreMenuShortcuts(protectedTerminal && !nativeClipboardKey);
    if (protectedTerminal) return;
    if (!areKeyboardShortcutsEnabled(config)) return;
    if ((input.control || input.meta) && input.key.toLowerCase() === 'w' && input.type === 'keyDown') {
      event.preventDefault();
      contents.send('synthetic-keydown', {
        key: input.key, code: input.code, ctrlKey: input.control,
        metaKey: input.meta, shiftKey: input.shift, altKey: input.alt,
      });
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    restoreMenus();
    ipcMain.removeListener('window:terminal-input-focus', reportFocus);
    contents.removeListener('before-input-event', beforeInput);
    contents.removeListener('did-navigate', restoreMenus);
    contents.removeListener('did-start-navigation', startNavigation);
    contents.removeListener('render-process-gone', restoreMenus);
    contents.removeListener('destroyed', dispose);
  };
  ipcMain.on('window:terminal-input-focus', reportFocus);
  contents.on('before-input-event', beforeInput);
  contents.on('did-navigate', restoreMenus);
  contents.on('did-start-navigation', startNavigation);
  contents.on('render-process-gone', restoreMenus);
  contents.on('destroyed', dispose);
  return dispose;
}
