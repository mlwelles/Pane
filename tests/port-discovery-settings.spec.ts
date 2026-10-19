import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type {} from './fixtures/port-discovery-settings';

async function openSettings(page: Page, params: Record<string, string> = {}) {
  const { outputFiles } = await build({
    entryPoints: [path.resolve('tests/fixtures/port-discovery-settings.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  });
  await page.route('https://pane.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(`https://pane.test/#${new URLSearchParams(params)}`);
  await page.addScriptTag({ content: outputFiles[0].text });
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} can save Passive and return to Active`, async ({ page }) => {
    await openSettings(page, { platform });
    await expect(page.getByRole('radio', { name: 'Active', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'Passive', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Passive', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Active', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.portSettingsTest.saves)).toEqual([
      { portDiscoveryMode: 'passive' }, { portDiscoveryMode: 'active' },
    ]);
  });
}

for (const platform of ['win32', 'freebsd', 'unknown', 'pending', 'failed']) {
  test(`${platform} disables only Passive with a visible reason`, async ({ page }) => {
    await openSettings(page, platform === 'pending' ? {} : { platform });
    const passive = page.getByRole('radio', { name: 'Passive', exact: true });
    await expect(passive).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Active', exact: true })).toBeEnabled();
    await expect(page.getByText(platform === 'win32' || platform === 'freebsd'
      ? 'Passive is unavailable on this operating system because Pane cannot verify local forwarding ports without probing them.'
      : 'Passive is unavailable because Pane has not identified this computer’s operating system.')).toBeVisible();
    await passive.dispatchEvent('click');
    await expect.poll(() => page.evaluate(() => window.portSettingsTest.saves)).toEqual([]);
    if (platform === 'pending') {
      await page.evaluate(() => window.portSettingsTest.resolvePlatform('linux'));
      await expect(passive).toBeEnabled();
    }
  });
}

test('saved Passive on Windows stays selected and can switch to Active', async ({ page }) => {
  await openSettings(page, { platform: 'win32', saved: 'passive' });
  await expect(page.getByRole('radio', { name: 'Passive', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Passive', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Active', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('a failed save retains Active and shows the error', async ({ page }) => {
  await openSettings(page, { platform: 'darwin', fail: 'true' });
  await page.getByRole('radio', { name: 'Passive', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save port discovery');
  await expect(page.getByRole('radio', { name: 'Active', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('describes probes, explicit opening and independent instance settings', async ({ page }) => {
  await openSettings(page, { platform: 'linux' });
  await expect(page.getByText(/Active sends requests to identify web servers/)).toBeVisible();
  await expect(page.getByText(/Opening a port still contacts it/)).toBeVisible();
  await expect(page.getByText(/Each Pane instance has its own setting/)).toBeVisible();
});

for (const [local, remote, enabled] of [['win32', 'linux', false], ['linux', 'win32', true]] as const) {
  test(`local ${local} decides Passive support while viewing remote ${remote}`, async ({ page }) => {
    await openSettings(page, { platform: local, remote });
    const passive = page.getByRole('radio', { name: 'Passive', exact: true });
    if (enabled) {
      await expect(passive).toBeEnabled();
      await passive.click();
      await expect.poll(() => page.evaluate(() => window.portSettingsTest.saves)).toEqual([{ portDiscoveryMode: 'passive' }]);
    } else {
      await expect(passive).toBeDisabled();
    }
  });
}
