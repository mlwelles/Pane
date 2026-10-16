const { ipcRenderer } = require('electron');
const { installTerminalInputFocusReporting } = require('../../../main/dist/main/src/utils/terminalInputFocus.js');

installTerminalInputFocusReporting(document, window, focused => {
  ipcRenderer.send('window:terminal-input-focus', focused);
}, focused => {
  ipcRenderer.send('window:shortcut-recording-focus', focused);
});
