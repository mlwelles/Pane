import fs from 'fs/promises';
import type { FSWatcher } from 'fs';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';

function captureFileWatcher() {
  let onChange: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  // SAFETY: ConfigManager only uses the watcher's error event and close method.
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() }) as FSWatcher;
  const watchDirectory = vi.fn((_directory: string, listener: (eventType: string, filename: string | Buffer | null) => void): FSWatcher => {
    onChange = listener;
    return watcher;
  });
  return {
    watchDirectory,
    change() {
      if (!onChange) throw new Error('Config file watcher was not started');
      onChange('rename', 'config.json');
    },
    watcher,
  };
}

function nextWatcherError(): Promise<void> {
  return new Promise(resolve => {
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      original(...args);
      if (args[0] === '[ConfigManager] Error reloading config after file change:') resolve();
    });
  });
}

function nextConfigUpdate(manager: ConfigManager): Promise<void> {
  return new Promise(resolve => manager.once('config-updated', () => resolve()));
}

describe('port discovery configuration', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-mode-'));
    configPath = path.join(dir, 'config.json');
    process.env.PANE_DIR = dir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.PANE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('defaults to Active and persists Passive across managers', async () => {
    const first = new ConfigManager();
    await first.initialize();
    expect(first.getConfig().portDiscoveryMode).toBe('active');
    await first.updateConfig({ portDiscoveryMode: 'passive' });
    const second = new ConfigManager();
    await second.initialize();
    expect(second.getConfig().portDiscoveryMode).toBe('passive');
  });

  it('rejects invalid updates without changing the effective mode or file', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const before = await fs.readFile(configPath, 'utf8');
    const changes = vi.fn();
    manager.on('config-updated', changes);
    // SAFETY: This deliberately invalid value exercises runtime validation beyond the typed caller.
    await expect(manager.updateConfig({ portDiscoveryMode: 'invalid' as 'active' })).rejects.toMatchObject({ code: 'INVALID_PORT_DISCOVERY_MODE' });
    expect(manager.getConfig().portDiscoveryMode).toBe('active');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    expect(changes).not.toHaveBeenCalled();
  });

  it('keeps the previous mode if a save fails', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const changes = vi.fn();
    manager.on('config-updated', changes);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failed'));
    await expect(manager.updateConfig({ portDiscoveryMode: 'passive' })).rejects.toThrow('disk failed');
    expect(manager.getConfig().portDiscoveryMode).toBe('active');
    expect(changes).not.toHaveBeenCalled();
  });

  it('keeps a bad startup file and disables probes', async () => {
    const raw = '{"portDiscoveryMode":"other"}';
    await fs.writeFile(configPath, raw);
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    expect(await fs.readFile(configPath, 'utf8')).toBe(raw);
    await expect(manager.reloadFromDisk()).rejects.toMatchObject({ code: 'INVALID_PORT_DISCOVERY_MODE' });
  });

  it('keeps corrupt startup JSON intact and defaults to Passive', async () => {
    const raw = '{"portDiscoveryMode":';
    await fs.writeFile(configPath, raw);
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    expect(await fs.readFile(configPath, 'utf8')).toBe(raw);
  });

  it('defaults to Passive when startup configuration is unreadable', async () => {
    const raw = '{"portDiscoveryMode":"active"}';
    await fs.writeFile(configPath, raw);
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    expect(await fs.readFile(configPath, 'utf8')).toBe(raw);
  });

  it('observes a correction immediately after rejecting an atomic replacement', async () => {
    const fileWatcher = captureFileWatcher();
    const manager = new ConfigManager(undefined, fileWatcher.watchDirectory);
    await manager.initialize();
    const changes = vi.fn();
    manager.on('config-updated', changes);
    manager.startWatching();
    try {
      const replacement = path.join(dir, 'replacement.json');
      await fs.writeFile(replacement, '{"portDiscoveryMode":"invalid"}');
      await fs.rename(replacement, configPath);
      const invalidReported = nextWatcherError();
      fileWatcher.change();
      await invalidReported;
      expect(console.error).toHaveBeenCalledWith(
        '[ConfigManager] Error reloading config after file change:', expect.anything(),
      );
      expect(manager.getConfig().portDiscoveryMode).toBe('active');
      expect(changes).not.toHaveBeenCalled();
      const corrected = nextConfigUpdate(manager);
      await fs.writeFile(configPath, '{"portDiscoveryMode":"passive"}');
      fileWatcher.change();
      await corrected;
      expect(manager.getConfig().portDiscoveryMode).toBe('passive');
      expect(changes).toHaveBeenCalledTimes(1);
      expect(fileWatcher.watcher.close).not.toHaveBeenCalled();
    } finally {
      manager.stopWatching();
    }
    expect(fileWatcher.watcher.close).toHaveBeenCalledTimes(1);
  });

  it('keeps watching while the config is absent and reloads its replacement', async () => {
    const fileWatcher = captureFileWatcher();
    const manager = new ConfigManager(undefined, fileWatcher.watchDirectory);
    await manager.initialize();
    manager.startWatching();
    try {
      const missingReported = nextWatcherError();
      await fs.unlink(configPath);
      fileWatcher.change();
      await missingReported;
      expect(manager.getConfig().portDiscoveryMode).toBe('active');
      const restored = nextConfigUpdate(manager);
      await fs.writeFile(configPath, '{"portDiscoveryMode":"passive"}');
      fileWatcher.change();
      await restored;
      expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    } finally {
      manager.stopWatching();
    }
  });

  it('reloads a valid edit once and restores Active when the mode is removed', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const changes = vi.fn();
    manager.on('config-updated', changes);
    await fs.writeFile(configPath, '{"portDiscoveryMode":"passive"}');
    await manager.reloadFromDisk();
    expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    expect(changes).toHaveBeenCalledTimes(1);
    await fs.writeFile(configPath, '{}');
    await manager.reloadFromDisk();
    expect(manager.getConfig().portDiscoveryMode).toBe('active');
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid reload without an event, then accepts correction', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ portDiscoveryMode: 'passive' });
    const changes = vi.fn();
    manager.on('config-updated', changes);
    await fs.writeFile(configPath, '{"portDiscoveryMode":null}');
    await expect(manager.reloadFromDisk()).rejects.toMatchObject({ code: 'INVALID_PORT_DISCOVERY_MODE' });
    expect(manager.getConfig().portDiscoveryMode).toBe('passive');
    expect(changes).not.toHaveBeenCalled();
    await fs.writeFile(configPath, '{"portDiscoveryMode":"active"}');
    await manager.reloadFromDisk();
    expect(manager.getConfig().portDiscoveryMode).toBe('active');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('isolates independent data directories', async () => {
    const first = new ConfigManager();
    await first.initialize();
    const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-mode-'));
    try {
      process.env.PANE_DIR = secondDir;
      const second = new ConfigManager();
      await second.initialize();
      await second.updateConfig({ portDiscoveryMode: 'passive' });
      expect(first.getConfig().portDiscoveryMode).toBe('active');
      expect(second.getConfig().portDiscoveryMode).toBe('passive');
    } finally {
      await fs.rm(secondDir, { recursive: true, force: true });
    }
  });

  it('reloads an external atomic replacement through the native file watcher', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const changes = vi.fn();
    manager.on('config-updated', changes);
    manager.startWatching();
    try {
      const replacement = path.join(dir, 'replacement.json');
      await fs.writeFile(replacement, '{"portDiscoveryMode":"passive"}');
      const reloaded = nextConfigUpdate(manager);
      await fs.rename(replacement, configPath);
      await reloaded;
      expect(manager.getConfig().portDiscoveryMode).toBe('passive');
      expect(changes).toHaveBeenCalledTimes(1);
    } finally {
      manager.stopWatching();
    }
  });
});
