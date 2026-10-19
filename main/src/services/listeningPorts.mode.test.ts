import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ConfigManager } from './configManager';
import { EventEmitter } from 'events';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListeningPortMonitor } from './listeningPorts';
import type { SocketRead } from './listeningSockets';

const socketRead = (): Promise<SocketRead> => Promise.resolve({ complete: true, sockets: [
  { port: 5147, address: '127.0.0.1', family: 'ipv4', pid: null, process: 'callback' },
] });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('listening port discovery mode', () => {
  it('lists unchecked ports without creating HTTP requests in Passive', async () => {
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected probe'); });
    const monitor = createListeningPortMonitor({ mode: 'passive', terminalPanes: () => [], readSockets: socketRead, readProcessTable: async () => [] });
    const snapshot = await monitor.refresh();
    expect(snapshot).toMatchObject({ discoveryMode: 'passive', ports: [
      { port: 5147, kind: 'tcp', probeStatus: 'unchecked' },
    ] });
    expect(request).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('leaves the current classification untouched when the effective mode is unchanged', async () => {
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected probe'); });
    const monitor = createListeningPortMonitor({ mode: 'passive', terminalPanes: () => [], readSockets: socketRead, readProcessTable: async () => [] });
    const snapshot = await monitor.refresh();
    monitor.setMode('passive');
    expect(monitor.snapshot()).toBe(snapshot);
    expect(request).not.toHaveBeenCalled();
    monitor.stop();
  });

  it.each(['web', 'silent'] as const)('preserves Active %s classification and retries across unrelated saves and reloads', async (answer) => {
    const previousDir = process.env.PANE_DIR;
    const dir = await fs.mkdtemp(path.join(previousDir ?? os.tmpdir(), 'mode-events-'));
    process.env.PANE_DIR = dir;
    const manager = new ConfigManager();
    await manager.initialize();
    const monitor = createListeningPortMonitor({ terminalPanes: () => [], readSockets: socketRead, readProcessTable: async () => [] });
    const onConfig = vi.fn(() => monitor.setMode(manager.getConfig().portDiscoveryMode ?? 'active'));
    manager.on('config-updated', onConfig);
    const requests = vi.spyOn(http, 'request').mockImplementation((_options, callback) => {
      const request = Object.assign(new EventEmitter(), {
        end: () => {
          if (answer === 'web') queueMicrotask(() => {
            // SAFETY: Classification does not inspect the response object.
            callback?.({} as never);
          });
        },
        destroy: vi.fn(),
      });
      // SAFETY: Probes use only the EventEmitter methods, end and destroy.
      return request as ReturnType<typeof http.request>;
    });
    vi.useFakeTimers();
    try {
      for (let attempt = 0; attempt < 13; attempt++) {
        if (attempt === 3) {
          const before = monitor.snapshot();
          await manager.updateConfig({ verbose: true });
          expect(onConfig).toHaveBeenCalledTimes(1);
          expect(monitor.snapshot()).toBe(before);
        }
        if (attempt === 6) {
          const before = monitor.snapshot();
          await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ ...manager.getConfig(), verbose: false }));
          await manager.reloadFromDisk();
          expect(onConfig).toHaveBeenCalledTimes(2);
          expect(monitor.snapshot()).toBe(before);
        }
        const refresh = monitor.refresh();
        await vi.advanceTimersByTimeAsync(501);
        expect((await refresh).ports[0]?.kind).toBe(answer === 'web' ? 'web' : 'tcp');
      }
      expect(requests).toHaveBeenCalledTimes(answer === 'web' ? 1 : 11);
    } finally {
      monitor.stop();
      manager.removeListener('config-updated', onConfig);
      vi.useRealTimers();
      if (previousDir === undefined) delete process.env.PANE_DIR;
      else process.env.PANE_DIR = previousDir;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks probes from an enumeration that completes after switching to Passive', async () => {
    let release: ((read: SocketRead) => void) | undefined;
    const readSockets = vi.fn()
      .mockImplementationOnce(() => new Promise<SocketRead>(resolve => { release = resolve; }))
      .mockImplementation(() => socketRead());
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected probe'); });
    const monitor = createListeningPortMonitor({ terminalPanes: () => [], readSockets, readProcessTable: async () => [] });
    const pending = monitor.refresh();
    monitor.setMode('passive');
    release?.(await socketRead());
    await pending;
    await monitor.refresh();
    expect(request).not.toHaveBeenCalled();
    expect(monitor.snapshot()).toMatchObject({ discoveryMode: 'passive', ports: [
      { port: 5147, kind: 'tcp', probeStatus: 'unchecked' },
    ] });
    monitor.stop();
  });

  it('destroys an in-flight request and ignores its late response', async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    // SAFETY: The probe only calls end, destroy and EventEmitter methods on this request fixture.
    const httpRequest = vi.spyOn(http, 'request').mockImplementation(() => request as ReturnType<typeof http.request>);
    const monitor = createListeningPortMonitor({ terminalPanes: () => [], readSockets: socketRead, readProcessTable: async () => [] });
    const pending = monitor.refresh();
    await vi.waitFor(() => expect(httpRequest).toHaveBeenCalledTimes(1));
    monitor.setMode('passive');
    expect(request.destroy).toHaveBeenCalled();
    await monitor.refresh();
    // SAFETY: The fake response callback does not inspect the response object.
    httpRequest.mock.calls[0]?.[1]?.({} as never);
    await pending;
    expect(monitor.snapshot()).toMatchObject({ discoveryMode: 'passive', ports: [
      { port: 5147, kind: 'tcp', probeStatus: 'unchecked' },
    ] });
    expect(httpRequest).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('destroys an in-flight request on stop', async () => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    // SAFETY: The probe only calls end, destroy and EventEmitter methods on this request fixture.
    const httpRequest = vi.spyOn(http, 'request').mockImplementation(() => request as ReturnType<typeof http.request>);
    const monitor = createListeningPortMonitor({ terminalPanes: () => [], readSockets: socketRead, readProcessTable: async () => [] });
    const pending = monitor.refresh();
    await vi.waitFor(() => expect(httpRequest).toHaveBeenCalledTimes(1));
    monitor.stop();
    expect(request.destroy).toHaveBeenCalled();
    await pending;
  });

  it('does not clear a newer refresh when an obsolete read finishes', async () => {
    let releaseOld: ((read: SocketRead) => void) | undefined;
    let releaseNew: ((read: SocketRead) => void) | undefined;
    const readSockets = vi.fn()
      .mockImplementationOnce(() => new Promise<SocketRead>(resolve => { releaseOld = resolve; }))
      .mockImplementationOnce(() => new Promise<SocketRead>(resolve => { releaseNew = resolve; }));
    const monitor = createListeningPortMonitor({ mode: 'passive', terminalPanes: () => [], readSockets, readProcessTable: async () => [] });
    const oldRefresh = monitor.refresh();
    monitor.stop();
    monitor.start();
    const newRefresh = monitor.refresh();
    releaseOld?.(await socketRead());
    await oldRefresh;
    expect(monitor.refresh()).toBe(newRefresh);
    releaseNew?.(await socketRead());
    await newRefresh;
    monitor.stop();
  });

  it('classifies afresh after returning to Active', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: A successfully listening TCP server has an AddressInfo here.
    const address = server.address() as net.AddressInfo;
    const readSockets = async (): Promise<SocketRead> => ({ complete: true, sockets: [
      { port: address.port, address: '127.0.0.1', family: 'ipv4', pid: null, process: 'test-server' },
    ] });
    const monitor = createListeningPortMonitor({ mode: 'passive', terminalPanes: () => [], readSockets, readProcessTable: async () => [] });
    try {
      expect((await monitor.refresh()).ports[0]?.probeStatus).toBe('unchecked');
      monitor.setMode('active');
      const active = await monitor.refresh();
      expect(active).toMatchObject({ discoveryMode: 'active', ports: [
        { port: address.port, kind: 'web' },
      ] });
      expect(active.ports[0]?.probeStatus).toBeUndefined();
    } finally {
      monitor.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('polls in Passive without probes and stops polling when stopped', async () => {
    vi.useFakeTimers();
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected probe'); });
    const readSockets = vi.fn(socketRead);
    const monitor = createListeningPortMonitor({ mode: 'passive', terminalPanes: () => [], readSockets, readProcessTable: async () => [] });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(readSockets.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(request).not.toHaveBeenCalled();
    const reads = readSockets.mock.calls.length;
    monitor.stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(readSockets).toHaveBeenCalledTimes(reads);
  });
});
