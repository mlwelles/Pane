import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import {
  installTerminalFixture, openTerminalFixture, inputMessages, resetTerminalCapture, paneActions,
  project, session, panels,
} from './fixtures/terminal-keyboard/renderer';
import type { JsonObject } from '../shared/validation/boundaryDecoder';


declare global {
  interface Window {
    __terminalInputMessages: string[];
    __holdFontLoads?: Promise<void>;
    __releaseFontLoads?: () => void;
  }
}

const cases = [
  {
    key: 'Alt+ArrowUp', vt: '\x1b[1;3A',
    win32: ['\x1b[18;56;0;1;2;1_', '\x1b[38;72;0;1;258;1_', '\x1b[38;72;0;0;258;1_', '\x1b[18;56;0;0;0;1_'],
  },
  {
    key: 'Shift+ArrowLeft', vt: '\x1b[1;2D',
    win32: ['\x1b[16;42;0;1;16;1_', '\x1b[37;75;0;1;272;1_', '\x1b[37;75;0;0;272;1_', '\x1b[16;42;0;0;0;1_'],
  },
  {
    key: 'Shift+ArrowUp', vt: '\x1b[1;2A',
    win32: ['\x1b[16;42;0;1;16;1_', '\x1b[38;72;0;1;272;1_', '\x1b[38;72;0;0;272;1_', '\x1b[16;42;0;0;0;1_'],
  },
  { key: 'F6', vt: '\x1b[17~', win32: ['\x1b[117;64;0;1;0;1_', '\x1b[117;64;0;0;0;1_'] },
];

for (const fullscreen of [false, true]) {
  for (const win32 of [false, true]) {
    test(`terminal input stays intact: fullscreen=${fullscreen}, win32=${win32}`, async ({ page }) => {
      const modes = (fullscreen ? '\x1b[?1049h' : '') + (win32 ? '\x1b[?9001h' : '');
      await installElectronApiMock(page, {
        initialProjects: [project], initialSessions: [session], initialPanels: panels,
        initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: modes } },
        activeProjectId: project.id,
      });
      await page.goto('/');
      await page.evaluate((isAlternateScreen) => {
        const calls: string[] = [];
        window.__terminalInputMessages = calls;
        const invoke = window.electronAPI.invoke;
        window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
          if (channel === 'terminal:getAltScreenState') return Promise.resolve({ isAlternateScreen });
          if (channel === 'terminal:input') calls.push(String(args[1]));
          return invoke(channel, ...args);
        };
      }, fullscreen);
      await page.getByRole('button', { name: 'Expand project Terminal input fixture', exact: true }).click();
      await page.getByRole('button', { name: session.name, exact: true }).click();
      const terminal = page.getByRole('tabpanel');
      const input = terminal.locator('.xterm-helper-textarea').first();
      await expect(input).toBeAttached();
      await expect(terminal.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
      await input.focus();
      for (const { key, vt, win32: records } of cases) {
        await page.evaluate(() => window.__terminalInputMessages.length = 0);
        await page.keyboard.press(key);
        // Pane owns Shift+Up for scrollback outside a fullscreen TUI. Modifier
        // transitions still pass through; the arrow itself must stay consumed.
        const paneOwnsKey = key === 'Shift+ArrowUp' && !fullscreen;
        const expected = paneOwnsKey
          ? (win32 ? [records[0], records[records.length - 1]] : [])
          : (win32 ? records : [vt]);
        expect(await inputMessages(page), key).toEqual(expected);
      }
    });
  }
}

test('keys typed while the terminal is still opening reach the shell', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    activeProjectId: project.id,
  });
  // TerminalPanel opens xterm, then awaits font loads before it subscribes to
  // input. Park it there so typing lands in that window.
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = (...args) => (window.__holdFontLoads ?? Promise.resolve()).then(() => load(...args));
  });
  await page.goto('/');
  await page.evaluate(() => {
    const calls: string[] = [];
    window.__terminalInputMessages = calls;
    window.__holdFontLoads = new Promise(resolve => { window.__releaseFontLoads = resolve; });
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'terminal:input') calls.push(String(args[1]));
      return invoke(channel, ...args);
    };
  });
  await page.getByRole('button', { name: 'Expand project Terminal input fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const terminal = page.getByRole('tabpanel');
  const input = terminal.locator('.xterm-helper-textarea').first();
  await expect(input).toBeAttached();
  await input.focus();
  await page.keyboard.type('pwd');

  await page.evaluate(() => window.__releaseFontLoads?.());
  await expect(terminal.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await expect.poll(() => inputMessages(page)).toEqual(['p', 'w', 'd']);
});

for (const fullscreen of [false, true]) {
  test(`Readline preset preserves editing input and escapes to the palette: fullscreen=${fullscreen}`, async ({ page }) => {
    await installTerminalFixture(page, {
      initialConfig: {
        terminalKeyboardPreset: 'readline-friendly',
        terminalShortcuts: [{ id: 'snippet', key: 'k', label: 'Fixture snippet', text: 'SNIPPET', enabled: true }],
      },
      initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: fullscreen ? '\x1b[?1049h' : '' } },
    });
    await page.goto('/');
    const input = await openTerminalFixture(page);
    for (const [chord, bytes] of [
      ['Control+a', '\x01'], ['Control+k', '\x0b'], ['Control+w', '\x17'],
      ['Control+v', '\x16'], ['Alt+b', '\x1bb'], ['Alt+f', '\x1bf'],
      ['Shift+Enter', '\r'], ['Control+Alt+k', '\x1b\x0b'], ['Shift+ArrowUp', '\x1b[1;2A'],
    ]) {
      await resetTerminalCapture(page);
      await page.keyboard.press(chord);
      expect(await inputMessages(page), chord).toEqual([bytes]);
      expect(await paneActions(page), chord).toEqual([]);
      await expect(input).toBeFocused();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await resetTerminalCapture(page);
    await page.keyboard.type('@word');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await inputMessages(page)).toEqual(['@', 'w', 'o', 'r', 'd', '\x1b[D', '\r']);
    const escape = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Meta+Shift+p' : 'Control+Shift+p');
    await resetTerminalCapture(page);
    await page.keyboard.press(escape);
    await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible();
    expect(await inputMessages(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(input).toBeFocused();
  });
}

async function updateKeyboardConfig(page: Page, patch: JsonObject) {
  await page.evaluate(async (updates) => {
    const modulePath = '/src/stores/configStore.ts';
    // SAFETY: Vite serves this production module at its source path.
    const { useConfigStore } = await import(modulePath) as typeof import('../frontend/src/stores/configStore');
    await useConfigStore.getState().updateConfig(updates);
  }, patch);
}

test('live preset and escape changes retain terminals and respect actual focus', async ({ page }) => {
  await installTerminalFixture(page);
  await page.goto('/');
  const input = await openTerminalFixture(page);
  await page.keyboard.press('Control+k');
  expect(await paneActions(page)).toContain('terminal:clearScrollback');
  await resetTerminalCapture(page);
  await updateKeyboardConfig(page, { terminalKeyboardPreset: 'readline-friendly' });
  await page.keyboard.press('Control+k');
  expect(await inputMessages(page)).toEqual(['\x0b']);
  expect(await paneActions(page)).toEqual([]);
  await updateKeyboardConfig(page, {
    terminalEscapeShortcut: { code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
  });
  await resetTerminalCapture(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible();
  expect(await inputMessages(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  const formerEscape = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Meta+Shift+p' : 'Control+Shift+p');
  await page.keyboard.press(formerEscape);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input).toBeFocused();
  await updateKeyboardConfig(page, { terminalEscapeShortcut: { code: 'KeyP', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true } });
  await resetTerminalCapture(page);
  await page.keyboard.press('Control+k');
  expect(await inputMessages(page)).toEqual(['\x0b']);
  expect(await paneActions(page)).toEqual([]);
  await resetTerminalCapture(page);
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  const otherInput = page.locator('.xterm-helper-textarea').last();
  await expect(otherInput).toBeAttached();
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await otherInput.focus();
  await page.keyboard.press('Control+a');
  await expect.poll(() => inputMessages(page)).toEqual(['\x01']);
  const targets = await page.evaluate(() => window.__terminalCalls.filter(call => call.channel === 'terminal:input').map(call => call.args[0]));
  expect(targets).toEqual([panels[0].id]);
  await updateKeyboardConfig(page, { terminalKeyboardPreset: 'standard' });
  await page.keyboard.press('Control+f');
  const search = page.getByPlaceholder('Search...', { exact: true });
  await expect(search).toBeFocused();
  await updateKeyboardConfig(page, { terminalKeyboardPreset: 'readline-friendly' });
  await resetTerminalCapture(page);
  await page.keyboard.type('find');
  expect(await inputMessages(page)).toEqual([]);
  await page.keyboard.press(formerEscape);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true }).first();
  await settingsButton.focus();
  await expect(settingsButton).toBeFocused();
  await page.keyboard.press(formerEscape);
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsButton).toBeFocused();
});

test('palette navigation keeps its destination focused', async ({ page }) => {
  await installTerminalFixture(page, { initialConfig: { terminalKeyboardPreset: 'readline-friendly' } });
  await page.goto('/');
  await openTerminalFixture(page);
  const escape = await page.evaluate(() => navigator.platform.toUpperCase().includes('MAC') ? 'Meta+Shift+p' : 'Control+Shift+p');
  await page.keyboard.press(escape);
  await page.getByRole('combobox', { name: 'Search commands' }).fill('Focus Sidebar');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.pane-sidebar-shell') !== null)).toBe(true);
  await expect(page.getByRole('button', { name: session.name, exact: true })).toBeFocused();
});

for (const paletteEnabled of [true, false]) {
  test(`terminal escape respects disabled global shortcuts: palette=${paletteEnabled}`, async ({ page }) => {
    await installTerminalFixture(page, { initialConfig: {
      terminalKeyboardPreset: 'readline-friendly', keyboardShortcutsEnabled: false,
      commandPaletteShortcutEnabled: paletteEnabled,
      terminalEscapeShortcut: { code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
    } });
    await page.goto('/');
    const input = await openTerminalFixture(page);
    await page.keyboard.press('Control+k');
    if (paletteEnabled) {
      await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible();
      expect(await inputMessages(page)).toEqual([]);
      await page.keyboard.press('Escape');
    } else {
      expect(await inputMessages(page)).toEqual(['\x0b']);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await expect(input).toBeFocused();
    expect(await paneActions(page)).toEqual([]);
  });
}

for (const contents of ['text', 'browser image', 'native image'] as const) {
  test(`Readline preserves ${contents} paste handling without duplicate input`, async ({ page }) => {
    await installTerminalFixture(page, { initialConfig: { terminalKeyboardPreset: 'readline-friendly' } });
    await page.goto('/');
    const input = await openTerminalFixture(page);
    await page.evaluate(kind => {
      const invoke = window.electronAPI.invoke;
      window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'terminal:clipboard-paste-image' || channel === 'terminal:paste-image') {
          window.__terminalCalls.push({ channel, args });
          return Promise.resolve(kind === 'text' ? null : { filePath: '/fixture/pasted.png', imageNumber: 1 });
        }
        return invoke(channel, ...args);
      };
    }, contents);
    await input.evaluate((element, kind) => {
      const data = new DataTransfer();
      data.setData('text/plain', kind === 'text' ? 'pasted text' : '[Image]');
      if (kind === 'browser image') data.items.add(new File([new Uint8Array([1, 2, 3])], 'fixture.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, contents);
    await expect.poll(() => inputMessages(page)).toEqual([contents === 'text' ? 'pasted text' : '/fixture/pasted.png\r']);
    const channels = await page.evaluate(() => window.__terminalCalls.filter(call => call.channel.includes('paste-image')).map(call => call.channel));
    expect(channels).toEqual([contents === 'browser image' ? 'terminal:paste-image' : 'terminal:clipboard-paste-image']);
    expect(await paneActions(page)).toEqual([]);
    await expect(input).toBeFocused();
  });
}

test('Readline passes AltGr text without claiming a Pane shortcut', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' }));
  await installTerminalFixture(page, { initialConfig: { terminalKeyboardPreset: 'readline-friendly' } });
  await page.goto('/');
  const input = await openTerminalFixture(page);
  await input.evaluate(element => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new KeyboardEvent(type, {
        key: '@', code: 'KeyQ', keyCode: 81, charCode: type === 'keypress' ? 64 : 0,
        ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      });
      Object.defineProperty(event, 'getModifierState', { value: (key: string) => key === 'AltGraph' });
      element.dispatchEvent(event);
    }
  });
  await expect.poll(() => inputMessages(page)).toEqual(['@']);
  expect(await paneActions(page)).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const mode of ['kitty', 'win32'] as const) {
  test(`Readline uses negotiated ${mode} encoding`, async ({ page }) => {
    const sequence = mode === 'kitty' ? '\x1b[>1u' : '\x1b[?9001h';
    await installTerminalFixture(page, {
      initialConfig: { terminalKeyboardPreset: 'readline-friendly' },
      initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: sequence } },
    });
    await page.goto('/');
    await openTerminalFixture(page);
    await page.keyboard.press(mode === 'kitty' ? 'Shift+Enter' : 'F6');
    expect(await inputMessages(page)).toEqual(mode === 'kitty'
      ? ['\x1b[13;2u']
      : ['\x1b[117;64;0;1;0;1_', '\x1b[117;64;0;0;0;1_']);
    expect(await paneActions(page)).toEqual([]);
  });
}
