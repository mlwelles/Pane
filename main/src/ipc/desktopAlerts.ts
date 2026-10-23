import type { IpcMain } from 'electron';
import type { WorkspaceWatchLeases } from '../services/workspaceWatchLeases';
import type { AppServices } from './types';

/**
 * Dictate shows Pane's "needs your input" and "finished" alerts on its pill. It follows
 * Pane with `runpane watch --follow --as dictate`; while that watcher is attached, Pane
 * skips its own desktop notification so each event alerts once.
 */
const DESKTOP_ALERT_CONSUMER = 'dictate';
// Covers the gap between a follow watcher's polls; after it, Pane's own alerts return.
const DESKTOP_ALERT_CONSUMER_GRACE_MS = 30_000;

export function isDesktopAlertHandedOff(leases: WorkspaceWatchLeases | undefined): boolean {
  return leases?.isAttached(DESKTOP_ALERT_CONSUMER, DESKTOP_ALERT_CONSUMER_GRACE_MS) ?? false;
}

export function registerDesktopAlertHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle('notifications:handed-off', () => isDesktopAlertHandedOff(services.workspaceWatchLeases));
}
