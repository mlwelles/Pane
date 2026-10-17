const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const { installWindowKeyboardRouting } = require('../../../main/dist/main/src/utils/windowKeyboardRouting.js');

app.setPath('userData', process.env.TERMINAL_KEYBOARD_USER_DATA);
global.terminalFixture = { config: { terminalKeyboardPreset: 'readline-friendly' }, menuCalls: 0, syntheticCalls: 0, ignoreMenuShortcuts: false };
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  void window.loadURL('about:blank');
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (channel === 'synthetic-keydown') global.terminalFixture.syntheticCalls++;
    send(channel, ...args);
  };
  const setIgnoreMenuShortcuts = window.webContents.setIgnoreMenuShortcuts.bind(window.webContents);
  window.webContents.setIgnoreMenuShortcuts = ignore => {
    global.terminalFixture.ignoreMenuShortcuts = ignore;
    setIgnoreMenuShortcuts(ignore);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Keyboard fixture', submenu: [
      { label: 'Observable accelerator', accelerator: 'Control+K', click: () => { global.terminalFixture.menuCalls++; } },
      { label: 'Observable Settings accelerator', accelerator: 'CommandOrControl+,', click: () => { global.terminalFixture.menuCalls++; } },
      { role: 'copy' }, { role: 'paste' },
    ],
  }]));
  installWindowKeyboardRouting(window.webContents, ipcMain, () => global.terminalFixture.config);
});
app.on('window-all-closed', () => app.quit());
