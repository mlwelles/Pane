import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type { ListeningPortsSnapshot } from '../shared/types/listeningPorts';
import type {} from './fixtures/browser-ports';

const snapshot = (...ports: number[]): ListeningPortsSnapshot => ({
  host: 'devbox',
  ports: ports.map(port => ({ port, pid: port, process: 'node', group: 'other', kind: 'web' })),
});

async function openBrowserPanel(page: Page, url = ''): Promise<void> {
  const { outputFiles } = await build({
    entryPoints: [path.resolve('tests/fixtures/browser-ports.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  });
  // A real origin: the panel's stores read localStorage, which about:blank denies.
  await page.route('https://pane.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height: 100vh"></div>' }));
  await page.goto(`https://pane.test/#${new URLSearchParams({ url })}`);
  await page.addScriptTag({ content: outputFiles[0].text });
}

const answerPortsList = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.answerPortsList(value), ports);
const answerConnectionState = (page: Page, mode: 'local' | 'remote') => page.evaluate(value => window.portsTest.answerConnectionState(value), mode);
const emitPorts = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.emitPorts(value), ports);
const loadConfig = (page: Page, mode: 'local' | 'remote') => page.evaluate(value => window.portsTest.loadConfig(value), mode);

test('ports open only once this computer is known to be the host', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));

  await expect(page.getByText('5173')).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);

  await answerConnectionState(page, 'local');
  await expect(page.getByTitle('Open localhost:5173')).toBeVisible();
});

test('ports stay closed on a remote desktop', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));
  await answerConnectionState(page, 'remote');

  await expect(page.getByText("These ports are on devbox, so this computer can't open them.")).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);
});

test('a late list reply does not replace a newer port change', async ({ page }) => {
  await openBrowserPanel(page);
  await answerConnectionState(page, 'local');
  await emitPorts(page, snapshot(5174));
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();

  await answerPortsList(page, snapshot(5173));
  // Give the late reply time to render if it were going to.
  await page.waitForTimeout(200);
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();
  await expect(page.getByText('5173')).toHaveCount(0);
});

test('the Ports menu works from the keyboard', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173, 5174));
  const trigger = page.getByRole('button', { name: /Ports/ });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('Open localhost:5173')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTitle('Open localhost:5174')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTitle('Open localhost:5174')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test.describe('a remote desktop loading a host page', () => {
  const tunnelled = (localPort: number): ListeningPortsSnapshot => ({
    host: 'devbox',
    ports: [{ port: 5173, pid: 5173, process: 'node', group: 'other', kind: 'web', localPort }],
  });
  const page5173 = 'http://localhost:5173/app';

  test('waits for the host\'s ports, then loads the tunnelled port marked with the host', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await expect(page.getByText("Connecting to the host's ports…")).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);

    await answerPortsList(page, tunnelled(5174));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5174/app');
    await expect(page.getByText('on devbox')).toBeVisible();
  });

  test('never loads this computer\'s own port for a host port without a tunnel', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, snapshot(5173));

    await expect(page.getByText("Port 5173 on devbox isn't reachable from this computer.")).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);
  });

  test('unloads the page while the host stops listening, and loads it again when the port returns', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, tunnelled(5174));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5174/app');

    await emitPorts(page, { host: 'devbox', ports: [] });
    await expect(page.getByText("The host isn't listing it right now.", { exact: false })).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);

    await emitPorts(page, tunnelled(5175));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5175/app');
  });

  test('loads the URL as it is from a host too old to list ports', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, { host: 'old host', ports: [], unsupportedHost: true });

    await expect(page.locator('webview')).toHaveAttribute('src', page5173);
    await expect(page.getByText('on old host')).toHaveCount(0);
  });
});

const passiveSnapshot = (localPort?: number): ListeningPortsSnapshot => ({
  host: 'devbox', discoveryMode: 'passive',
  ports: [{ port: 5173, pid: 123, process: 'callback-service', group: 'pane-terminal', paneName: 'Feature work', kind: 'tcp', probeStatus: 'unchecked', localPort }],
});

test('Passive lists unchecked ownership and opens locally from the keyboard without a probe', async ({ page }) => {
  await openBrowserPanel(page);
  await loadConfig(page, 'local');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, passiveSnapshot());
  await expect(page.getByText('Passive discovery', { exact: true })).toBeVisible();
  await expect(page.getByText('unchecked', { exact: true })).toBeVisible();
  await expect(page.getByText('callback-service')).toBeVisible();
  await expect(page.getByText('From Pane terminals')).toBeVisible();
  await expect(page.getByText('Feature work')).toBeVisible();
  await expect(page.locator('[title*="does not answer HTTP"]')).toHaveCount(0);
  await page.getByTitle('Open localhost:5173').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5173');
  expect(await page.evaluate(() => window.portsTest.invocations)).toEqual(['ports:list']);
});

test('empty Passive snapshots still identify the discovery mode', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, { host: 'devbox', ports: [], discoveryMode: 'passive' });
  await expect(page.getByText('Passive discovery', { exact: true })).toBeVisible();
  await expect(page.getByText('No listening ports on devbox')).toBeVisible();
});

test('remote unchecked ports require a local forward and keep HTTP failure tooltips absent', async ({ page }) => {
  await openBrowserPanel(page);
  await loadConfig(page, 'remote');
  await answerConnectionState(page, 'remote');
  await answerPortsList(page, passiveSnapshot());
  await expect(page.getByText('unchecked', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);
  await expect(page.locator('[title*="does not answer HTTP"]')).toHaveCount(0);
  await emitPorts(page, passiveSnapshot(15173));
  await page.getByTitle('Open localhost:5173').click();
  await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:15173/');
  expect(await page.evaluate(() => window.portsTest.invocations)).toEqual(['ports:list']);
});

test('Retry reloads a failed forward while the successful port stays openable', async ({ page }) => {
  await openBrowserPanel(page);
  await loadConfig(page, 'remote');
  await answerConnectionState(page, 'remote');
  const ports = passiveSnapshot();
  ports.ports[0].forwardingError = {
    code: 'PORT_FORWARDING_UNAVAILABLE', message: 'Port 5173 has no verified local forwarding address.', next: 'Retry this port in the Ports list.',
  };
  ports.ports.push({ port: 5174, pid: 124, process: 'node', group: 'other', kind: 'tcp', probeStatus: 'unchecked', localPort: 15174 });
  await answerPortsList(page, ports);
  await expect(page.getByText('Port 5173 has no verified local forwarding address.')).toBeVisible();
  await expect(page.getByText('Retry this port in the Ports list.')).toBeVisible();
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();
  await page.getByRole('button', { name: 'Retry forwarding port 5173' }).click();
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();
  const retried = passiveSnapshot(15173);
  retried.ports.push(ports.ports[1]);
  await answerPortsList(page, retried);
  await expect(page.getByTitle('Open localhost:5173')).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry forwarding/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.portsTest.invocations)).toEqual(['ports:list', 'ports:list']);
});

test('ordinary Active TCP rows retain their classification and cannot open', async ({ page }) => {
  await openBrowserPanel(page);
  await answerConnectionState(page, 'local');
  await answerPortsList(page, { host: 'devbox', ports: [{ port: 5432, pid: 20, process: 'postgres', group: 'other', kind: 'tcp' }] });
  await expect(page.getByText('tcp', { exact: true })).toBeVisible();
  await expect(page.getByTitle('5432 does not answer HTTP')).toBeVisible();
  await expect(page.getByTitle('Open localhost:5432')).toHaveCount(0);
});
