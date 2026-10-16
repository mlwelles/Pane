import { expect, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from '../../electronApiMock';

export const project = {
  id: 381, name: 'Terminal input fixture', path: '/test-fixtures/terminal-input',
  active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};
export const session = {
  id: 'terminal-input-session', name: 'Terminal input pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};
export const panels = ['Bottom Terminal', 'Input Terminal'].map((title, index) => ({
  id: `input-terminal-${index}`, sessionId: session.id, type: 'terminal', title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: {
    createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(),
    position: index, permanent: index === 0,
  },
}));

declare global {
  interface Window {
    __terminalInputMessages: string[];
    __terminalCalls: Array<{ channel: string; args: unknown[] }>;
  }
}

export async function installTerminalFixture(page: Page, options: ElectronApiMockOptions = {}) {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    activeProjectId: project.id, ...options,
  });
  await page.addInitScript(() => {
    window.__terminalInputMessages = [];
    window.__terminalCalls = [];
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      window.__terminalCalls.push({ channel, args });
      if (channel === 'terminal:input') window.__terminalInputMessages.push(String(args[1]));
      if (channel === 'panels:agent-statuses') return Promise.resolve({ success: true, data: [] });
      return invoke(channel, ...args);
    };
  });
}

export async function openTerminalFixture(page: Page) {
  await page.getByRole('button', { name: 'Expand project Terminal input fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const terminal = page.getByRole('tabpanel');
  const input = terminal.locator('.xterm-helper-textarea').first();
  await expect(input).toBeAttached();
  await expect(terminal.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await input.focus();
  await resetTerminalCapture(page);
  return input;
}

export async function resetTerminalCapture(page: Page) {
  await page.evaluate(() => {
    window.__terminalInputMessages.length = 0;
    window.__terminalCalls.length = 0;
  });
}

export async function inputMessages(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__terminalInputMessages);
}

export async function paneActions(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__terminalCalls
    .filter(({ channel }) => /^(terminal:clearScrollback|terminal:create|panels:(close|create|remove)|sessions:(create|delete))$/.test(channel))
    .map(({ channel }) => channel));
}
