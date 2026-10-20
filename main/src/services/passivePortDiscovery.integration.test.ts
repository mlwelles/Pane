import fs from 'fs/promises';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPortTunnel } from '../daemon/client/portTunnel';
import { ConfigManager } from './configManager';
import { createListeningPortMonitor } from './listeningPorts';
import type { SocketRead } from './listeningSockets';
import { bindPortDiscoveryMode } from './portDiscoveryMode';

const servers: net.Server[] = [];
const tunnels: Array<ReturnType<typeof createPortTunnel>> = [];
const monitors: Array<ReturnType<typeof createListeningPortMonitor>> = [];
const directories: string[] = [];
let previousPaneDir: string | undefined;

beforeEach(() => { previousPaneDir = process.env.PANE_DIR; });

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  await Promise.all(tunnels.splice(0).map(tunnel => tunnel.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
  if (previousPaneDir === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = previousPaneDir;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  // SAFETY: this server has completed a TCP listen.
  return (server.address() as net.AddressInfo).port;
}

const socketFor = (port: number, address = '127.0.0.1') => ({
  port, address, family: 'ipv4' as const, pid: process.pid, process: 'test-once',
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('native passive discovery and forwarding', { timeout: 30_000 }, () => {
  it('leaves a one-shot listener untouched through startup, polling, refresh and forwarding', async () => {
    let accepted = 0;
    const requests: string[] = [];
    const oneShot = net.createServer(socket => {
      accepted++;
      oneShot.close();
      socket.once('data', data => { requests.push(data.toString()); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); });
    });
    const port = await listen(oneShot);
    const readSockets = vi.fn(async (): Promise<SocketRead> => ({ complete: true, sockets: [socketFor(port)] }));
    const monitor = createListeningPortMonitor({
      mode: 'passive', panePid: process.pid, terminalPanes: () => [], readSockets,
      readProcessTable: async () => [],
    });
    monitors.push(monitor);
    vi.useFakeTimers();
    monitor.start();
    await monitor.refresh();
    const initialReads = readSockets.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_150);
    expect(readSockets.mock.calls.length).toBeGreaterThan(initialReads);
    await monitor.refresh();
    await monitor.refresh();
    expect(readSockets.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(monitor.snapshot().ports).toMatchObject([{
      port, process: 'test-once', pid: process.pid, group: 'pane', kind: 'tcp', probeStatus: 'unchecked',
    }]);
    expect(accepted, JSON.stringify(requests)).toBe(0);
    vi.useRealTimers();
    const bound: net.Server[] = [];
    const createServer = net.createServer;
    vi.spyOn(net, 'createServer').mockImplementation((...args: Parameters<typeof net.createServer>) => {
      const server = createServer(...args);
      bound.push(server);
      return server;
    });
    const connect = vi.spyOn(net, 'connect');
    const readOccupancy = async (): Promise<SocketRead> => ({
      complete: true,
      sockets: [socketFor(port), ...bound.flatMap(server => {
        // SAFETY: the tunnel creates TCP servers, so bound addresses are AddressInfo.
        const address = server.address() as net.AddressInfo | null;
        return address ? [{
          port: address.port, address: address.address,
          family: address.family === 'IPv4' ? 'ipv4' as const : 'ipv6' as const,
          pid: process.pid, process: 'node',
        }] : [];
      })],
    });
    const tunnel = createPortTunnel(() => { throw new Error('A stream requires explicit navigation.'); }, {
      mode: 'passive', readOccupancy,
    });
    tunnels.push(tunnel);
    const forwarding = await tunnel.sync([port]);
    expect(forwarding.errors.size).toBe(0);
    expect(forwarding.localPorts.get(port)).toBeDefined();
    expect(forwarding.localPorts.get(port)).not.toBe(port);
    expect(connect).not.toHaveBeenCalled();
    expect(accepted, JSON.stringify(requests)).toBe(0);

    monitor.stop();
    connect.mockRestore();
    const response = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, result => {
        let body = '';
        result.setEncoding('utf8');
        result.on('data', chunk => { body += chunk; });
        result.on('end', () => resolve(body));
      }).once('error', reject);
    });
    expect(response).toBe('ok');
    expect(accepted).toBe(1);
  });

  it('still classifies a controlled Active listener with a HEAD request', async () => {
    const methods: string[] = [];
    const server = http.createServer((request, response) => {
      methods.push(request.method ?? '');
      response.writeHead(200);
      response.end();
    });
    const port = await listen(server);
    const monitor = createListeningPortMonitor({
      mode: 'active', panePid: process.pid, terminalPanes: () => [],
      readSockets: async () => ({ complete: true, sockets: [socketFor(port)] }),
      readProcessTable: async () => [],
    });
    monitors.push(monitor);
    expect((await monitor.refresh()).ports).toMatchObject([{ port, kind: 'web' }]);
    expect(methods).toContain('HEAD');
  });
});

describe('configuration drives both port consumers', () => {
  it('cancels an in-flight Active HTTP probe and tunnel availability check before Passive refresh', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-port-switch-'));
    directories.push(directory);
    process.env.PANE_DIR = directory;
    const manager = new ConfigManager();
    await manager.initialize();

    let releaseFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
    let answerRequests = false;
    const methods: string[] = [];
    const server = http.createServer((request, response) => {
      methods.push(request.method ?? '');
      if (answerRequests) response.end('ready');
      else releaseFirstRequest?.();
    });
    const port = await listen(server);
    const request = vi.spyOn(http, 'request');
    const monitor = createListeningPortMonitor({
      mode: 'active', panePid: process.pid, terminalPanes: () => [],
      readSockets: async () => ({ complete: true, sockets: [socketFor(port)] }),
      readProcessTable: async () => [],
    });
    monitors.push(monitor);
    const tunnel = createPortTunnel(() => { throw new Error('No stream was requested.'); }, { platform: 'win32' });
    tunnels.push(tunnel);
    const unbindMonitor = bindPortDiscoveryMode(manager, monitor);
    const unbindTunnel = bindPortDiscoveryMode(manager, tunnel);
    try {
      const activeRead = monitor.refresh();
      await firstRequest;
      expect(methods).toEqual(['HEAD']);
      expect(request).toHaveBeenCalledTimes(1);

      const availabilitySockets: net.Socket[] = [];
      const connect = vi.spyOn(net, 'connect').mockImplementation(() => {
        const socket = new net.Socket();
        availabilitySockets.push(socket);
        return socket;
      });
      const activeForward = tunnel.sync([65_535]);
      expect(availabilitySockets).toHaveLength(2);
      await manager.updateConfig({ portDiscoveryMode: 'passive' });
      expect(availabilitySockets.every(socket => socket.destroyed)).toBe(true);
      expect((await activeForward).errors.get(65_535)?.code).toBe('PORT_FORWARDING_UNAVAILABLE');
      connect.mockRestore();
      await activeRead;
      await monitor.refresh();
      expect(monitor.snapshot()).toMatchObject({
        discoveryMode: 'passive', ports: [{ port, kind: 'tcp', probeStatus: 'unchecked' }],
      });
      expect(request.mock.results[0]?.value.destroyed).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);

      answerRequests = true;
      await manager.updateConfig({ portDiscoveryMode: 'active' });
      await monitor.refresh();
      expect(monitor.snapshot()).toMatchObject({ discoveryMode: 'active', ports: [{ port, kind: 'web' }] });
      expect(methods).toEqual(['HEAD', 'HEAD']);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      unbindMonitor();
      unbindTunnel();
    }
  });

  it('applies a valid file reload synchronously and rejects failed mode changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-passive-integration-'));
    directories.push(directory);
    process.env.PANE_DIR = directory;
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ portDiscoveryMode: 'passive' });
    const restarted = new ConfigManager();
    await restarted.initialize();
    expect(restarted.getConfig().portDiscoveryMode).toBe('passive');

    const pendingReads: Array<(value: SocketRead) => void> = [];
    const readSockets = vi.fn(() => new Promise<SocketRead>(resolve => { pendingReads.push(resolve); }));
    const monitor = createListeningPortMonitor({ mode: restarted.getConfig().portDiscoveryMode,
      terminalPanes: () => [], readSockets });
    monitors.push(monitor);
    const tunnel = createPortTunnel(() => { throw new Error('No stream was requested.'); }, {
      mode: restarted.getConfig().portDiscoveryMode, platform: 'win32',
    });
    tunnels.push(tunnel);
    expect((await tunnel.sync([31_001])).errors.get(31_001)?.code).toBe('PORT_FORWARDING_UNAVAILABLE');
    const setTunnelMode = vi.spyOn(tunnel, 'setMode');
    const unbindMonitor = bindPortDiscoveryMode(restarted, monitor);
    const unbindTunnel = bindPortDiscoveryMode(restarted, tunnel);
    try {
      const oldRead = monitor.refresh();
      expect(readSockets).toHaveBeenCalledTimes(1);
      const methods: string[] = [];
      const activeServer = http.createServer((request, response) => {
        methods.push(request.method ?? '');
        response.writeHead(200);
        response.end();
      });
      const activePort = await listen(activeServer);
      const configPath = path.join(directory, 'config.json');
      const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
      await fs.writeFile(configPath, JSON.stringify({ ...saved, portDiscoveryMode: 'active' }));
      await restarted.reloadFromDisk();
      expect(monitor.snapshot().discoveryMode).toBe('active');
      expect(setTunnelMode).toHaveBeenCalledTimes(1);
      expect(setTunnelMode).toHaveBeenLastCalledWith('active');
      expect(readSockets).toHaveBeenCalledTimes(2);
      pendingReads[1]?.({ complete: true, sockets: [socketFor(activePort)] });
      await monitor.refresh();
      expect(monitor.snapshot().ports).toMatchObject([{ port: activePort, kind: 'web' }]);
      expect(methods).toContain('HEAD');
      pendingReads[0]?.({ complete: true, sockets: [socketFor(31_001)] });
      await oldRead;
      expect(monitor.snapshot().discoveryMode).toBe('active');
      expect(monitor.snapshot().ports).toMatchObject([{ port: activePort, kind: 'web' }]);

      // SAFETY: deliberately bypass the static mode type to test the runtime boundary.
      await expect(restarted.updateConfig({ portDiscoveryMode: 'invalid' as never })).rejects.toMatchObject({ code: 'INVALID_PORT_DISCOVERY_MODE' });
      await fs.writeFile(configPath, JSON.stringify({ ...saved, portDiscoveryMode: 'invalid' }));
      await expect(restarted.reloadFromDisk()).rejects.toMatchObject({ code: 'INVALID_PORT_DISCOVERY_MODE' });
      expect(monitor.snapshot().discoveryMode).toBe('active');
      expect(restarted.getConfig().portDiscoveryMode).toBe('active');
      expect(setTunnelMode).toHaveBeenCalledTimes(1);

      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('isolated save failure'));
      await expect(restarted.updateConfig({ portDiscoveryMode: 'passive' })).rejects.toThrow('isolated save failure');
      expect(monitor.snapshot().discoveryMode).toBe('active');
      expect(setTunnelMode).toHaveBeenCalledTimes(1);
      rename.mockRestore();
      await restarted.updateConfig({ portDiscoveryMode: 'passive' });
      expect(monitor.snapshot().discoveryMode).toBe('passive');
      expect(setTunnelMode).toHaveBeenNthCalledWith(2, 'passive');
      expect(setTunnelMode).toHaveBeenCalledTimes(2);
      expect(monitor.snapshot().ports).toMatchObject([{ port: activePort, kind: 'tcp', probeStatus: 'unchecked' }]);
      const unavailable = await tunnel.sync([31_001]);
      expect(unavailable.errors.get(31_001)?.code).toBe('PORT_FORWARDING_UNAVAILABLE');
      expect(unavailable.localPorts.size).toBe(0);
    } finally {
      unbindMonitor();
      unbindTunnel();
    }
  });
});
