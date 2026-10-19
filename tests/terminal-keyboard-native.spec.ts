import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { installTerminalFixture, openTerminalFixture, inputMessages, resetTerminalCapture, paneActions } from './fixtures/terminal-keyboard/renderer';

async function menuPolicy(app: ElectronApplication) {
  // SAFETY: The fixture records calls while forwarding them to the real Electron method.
  return app.evaluate(() => (globalThis as typeof globalThis & { terminalFixture: { ignoreMenuShortcuts: boolean } }).terminalFixture.ignoreMenuShortcuts);
}

async function sendKey(app: ElectronApplication, keyCode: string, modifiers: string[] = []) {
  await app.evaluate(({ BrowserWindow }, chord) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', ...chord });
    contents.sendInputEvent({ type: 'keyUp', ...chord });
  }, { keyCode, modifiers });
}

async function withNativeApp(run: (app: ElectronApplication) => Promise<void>) {
  const parent = process.env.PANE_TASK_TMP || tmpdir();
  const userData = await mkdtemp(join(parent, 'terminal-keyboard-profile-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve('tests/fixtures/terminal-keyboard/main.cjs')],
      env: { ...process.env, TERMINAL_KEYBOARD_USER_DATA: userData },
    });
    await run(app);
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
}

test('native terminal keys bypass interception and restore menu policy outside terminal input', async ({ baseURL }) => {
  await withNativeApp(async app => {
    const page = await app.firstWindow();
    await installTerminalFixture(page, { initialConfig: { terminalKeyboardPreset: 'readline-friendly' } });
    await page.goto(baseURL!);
    const input = await openTerminalFixture(page);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); });
    await input.focus();
    await sendKey(app, 'W', ['control']);
    await expect.poll(() => inputMessages(page)).toEqual(['\x17']);
    await resetTerminalCapture(page);
    await sendKey(app, 'K', ['control']);
    await expect.poll(() => inputMessages(page)).toEqual(['\x0b']);
    expect(await menuPolicy(app)).toBe(true);

    await resetTerminalCapture(page);
    await sendKey(app, 'V', ['control']);
    await expect.poll(() => inputMessages(page)).toEqual(['\x16']);
    await resetTerminalCapture(page);
    // Key-up checks clipboard menu policy without reading or changing the system clipboard.
    await app.evaluate(({ BrowserWindow }, modifiers) => {
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers });
    }, process.platform === 'darwin' ? ['meta'] : ['control', 'shift']);
    expect(await menuPolicy(app)).toBe(false);
    expect(await inputMessages(page)).toEqual([]);

    await sendKey(app, 'K', ['control']);
    expect(await menuPolicy(app)).toBe(true);

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect.poll(() => menuPolicy(app)).toBe(false);
    await sendKey(app, 'K', ['control']);
    expect(await menuPolicy(app)).toBe(false);
  });
});


for (const preset of ['standard', 'readline-friendly'] as const) {
  test(`native recorder holds menu suppression through capture and cleanup under ${preset}`, async ({ baseURL }) => {
    await withNativeApp(async app => {
      const page = await app.firstWindow();
      await installTerminalFixture(page, { initialConfig: { terminalKeyboardPreset: preset } });
      await page.goto(baseURL!);
      await openTerminalFixture(page);
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); });
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
      const record = page.getByRole('button', { name: 'Record terminal palette shortcut' });
      await record.evaluate(button => {
        for (const type of ['keydown', 'keyup']) {
          button.addEventListener(type, () => {
            button.setAttribute(`data-test-${type}`, String(Number(button.getAttribute(`data-test-${type}`) || 0) + 1));
          });
        }
        document.addEventListener('keydown', () => { button.setAttribute('data-test-escaped-key', 'true'); });
        document.addEventListener('keyup', () => { button.setAttribute('data-test-escaped-key', 'true'); });
        button.addEventListener('paste', () => { button.setAttribute('data-test-paste', 'true'); });
      });
      await resetTerminalCapture(page);
      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await sendKey(app, ',', process.platform === 'darwin' ? ['meta'] : ['control']);
      await expect(record).toHaveText(process.platform === 'darwin' ? 'Command+Comma' : 'Ctrl+Comma');
      await expect(record).toHaveAttribute('data-test-keydown', '1');
      await expect(record).toHaveAttribute('data-test-keyup', '1');
      await expect.poll(() => menuPolicy(app)).toBe(false);

      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await sendKey(app, 'V', process.platform === 'darwin' ? ['meta'] : ['control', 'shift']);
      await expect(page.getByRole('alert')).toContainText('reserved for terminal clipboard');
      expect(await menuPolicy(app)).toBe(true);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect.poll(() => menuPolicy(app)).toBe(false);

      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'F6', modifiers: ['control'] });
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'F6', modifiers: ['control', 'isAutoRepeat'] });
      });
      await expect(record).toHaveText('Press a key combination');
      expect(await menuPolicy(app)).toBe(true);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F6', modifiers: ['control'] });
      });
      await expect(record).toHaveText('Ctrl+F6');
      await expect.poll(() => menuPolicy(app)).toBe(false);
      await expect(record).toHaveAttribute('data-test-keydown', '4');
      await expect(record).toHaveAttribute('data-test-keyup', '3');
      await expect(record).not.toHaveAttribute('data-test-escaped-key', 'true');
      await expect(record).not.toHaveAttribute('data-test-paste', 'true');
      const savedChords = await page.evaluate(() => {
        // SAFETY: installTerminalFixture installs this mock before renderer navigation.
        const mock = (window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => Array<{ terminalEscapeShortcut?: { code: string } }> } }).__paneTestElectronMock;
        return mock.getConfigUpdates().filter(update => update.terminalEscapeShortcut).map(update => update.terminalEscapeShortcut?.code);
      });
      expect(savedChords).toEqual(['Comma', 'F6']);
      expect(await inputMessages(page)).toEqual([]);
      expect(await paneActions(page)).toEqual([]);
      const nativeCalls = await app.evaluate(() => {
        // SAFETY: The minimal host owns these counters and forwards the real Electron calls.
        const fixture = (globalThis as typeof globalThis & { terminalFixture: { menuCalls: number; syntheticCalls: number } }).terminalFixture;
        return { menu: fixture.menuCalls, synthetic: fixture.syntheticCalls };
      });
      expect(nativeCalls).toEqual({ menu: 0, synthetic: 0 });

      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await page.getByRole('button', { name: 'Restore default', exact: true }).focus();
      await expect(record).not.toHaveText('Press a key combination');
      await expect.poll(() => menuPolicy(app)).toBe(false);
      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].blur(); });
      await expect(record).not.toHaveText('Press a key combination');
      await expect.poll(() => menuPolicy(app)).toBe(false);
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); });
      await record.focus();
      expect(await menuPolicy(app)).toBe(false);
      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await page.getByRole('button', { name: 'Appearance', exact: true }).evaluate(button => button.click());
      await expect(record).toHaveCount(0);
      await expect.poll(() => menuPolicy(app)).toBe(false);
      await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await page.goto('about:blank');
      await expect.poll(() => menuPolicy(app)).toBe(false);
    });
  });
}

for (const extraShift of [false, true]) {
  test(`native macOS recorder finishes ${extraShift ? 'after an extra Shift release' : 'on Command release'} without a comma keyup`, async ({ baseURL }) => {
    test.skip(process.platform !== 'darwin', 'Command release fallback is macOS-specific');
    await withNativeApp(async app => {
      const page = await app.firstWindow();
      await installTerminalFixture(page);
      await page.goto(baseURL!);
      await openTerminalFixture(page);
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); });
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
      const record = page.getByRole('button', { name: 'Record terminal palette shortcut' });
      await resetTerminalCapture(page);
      await record.click();
      await expect.poll(() => menuPolicy(app)).toBe(true);
      await app.evaluate(({ BrowserWindow }, holdShift) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['meta'] });
        contents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['meta', 'isAutoRepeat'] });
        if (holdShift) contents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['meta', 'shift'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta', modifiers: holdShift ? ['shift'] : [] });
      }, extraShift);
      if (extraShift) {
        await expect(record).toHaveText('Press a key combination');
        await expect.poll(() => menuPolicy(app)).toBe(true);
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
        });
      }
      await expect(record).toHaveText('Command+Comma');
      await expect(record).toBeEnabled();
      await expect.poll(() => menuPolicy(app)).toBe(false);
      await record.evaluate(() => {
        document.addEventListener('keydown', () => document.body.setAttribute('data-test-escaped-key', 'true'));
        document.addEventListener('keyup', () => document.body.setAttribute('data-test-escaped-key', 'true'));
      });
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['isAutoRepeat'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: ',' });
      });
      await expect(page.locator('body')).not.toHaveAttribute('data-test-escaped-key', 'true');
      // SAFETY: installTerminalFixture installs this mock before renderer navigation.
      const updates = await page.evaluate(() => (
        window as typeof window & { __paneTestElectronMock: { getConfigUpdates: () => unknown[] } }
      ).__paneTestElectronMock.getConfigUpdates());
      expect(updates).toEqual([{ terminalEscapeShortcut: { code: 'Comma', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false } }]);
      expect(await inputMessages(page)).toEqual([]);
      expect(await paneActions(page)).toEqual([]);
      // SAFETY: The minimal host owns these counters and forwards the real Electron calls.
      expect(await app.evaluate(() => (
        globalThis as typeof globalThis & { terminalFixture: { menuCalls: number; syntheticCalls: number } }
      ).terminalFixture)).toMatchObject({ menuCalls: 0, syntheticCalls: 0 });
    });
  });
}
