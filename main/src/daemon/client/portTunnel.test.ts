import http from 'http';
import net from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { createDefaultRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { readLocalPortOccupancy, type ListeningSocket, type SocketRead } from '../../services/listeningSockets';
import { createPortTunnel, type PortTunnel } from './portTunnel';

const realConnect = net.connect;
const realCreateServer = net.createServer;
const createdServers: net.Server[] = [];
const allowedConnections = new Set<number>();

beforeEach(() => {
  vi.spyOn(net, 'createServer').mockImplementation((...args: Parameters<typeof net.createServer>) => {
    const server = realCreateServer(...args);
    createdServers.push(server);
    return server;
  });
  vi.spyOn(net, 'connect').mockImplementation((...args: Parameters<typeof net.connect>) => {
    const options = decodeOptionalBoundary(args[0], boundary.object({ port: boundary.union(boundary.number, boundary.string) }));
    const port = Number(options?.port ?? decodeOptionalBoundary(args[0], boundary.number));
    if (Number.isInteger(port) && (allowedConnections.has(port) || createdServers.some(server => {
      // SAFETY: these test servers bind only TCP endpoints.
      const address = server.address() as net.AddressInfo | null;
      return address?.port === port;
    }))) return realConnect(...args);
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit('error', new Error('isolated availability result')));
    return socket;
  });
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  createdServers.length = 0;
  allowedConnections.clear();
  vi.restoreAllMocks();
});

function track(tunnel: PortTunnel): PortTunnel {
  cleanups.push(() => tunnel.close());
  return tunnel;
}

/** Stands in for the host: every stream echoes its bytes back and records which port it asked for. */
async function startEchoHost(): Promise<{ openStream(port: number): WebSocket; requestedPorts: number[] }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  wss.on('connection', socket => socket.on('message', data => socket.send(data)));
  cleanups.push(() => new Promise<void>(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
  }));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  const { port } = wss.address() as net.AddressInfo;
  allowedConnections.add(port);
  const requestedPorts: number[] = [];
  return {
    requestedPorts,
    openStream(hostPort) {
      requestedPorts.push(hostPort);
      return new WebSocket(`ws://127.0.0.1:${port}/ports/${hostPort}`);
    },
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function listen(server: net.Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  const boundPort = (server.address() as net.AddressInfo).port;
  allowedConnections.add(boundPort);
  return boundPort;
}

function echoThrough(host: string, port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = realConnect({ host, port });
    let received = '';
    socket.on('data', chunk => {
      received += chunk.toString('utf8');
      if (received.length >= text.length) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

function refuses(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = realConnect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

describe('port tunnel', () => {
  it('listens on the host port number when it is free here, on IPv4 and IPv6 loopback', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = track(createPortTunnel(host.openStream));

    expect((await tunnel.sync([port])).localPorts).toEqual(new Map([[port, port]]));
    expect(await echoThrough('127.0.0.1', port, 'v4 bytes')).toBe('v4 bytes');
    expect(await echoThrough('::1', port, 'v6 bytes')).toBe('v6 bytes');
    expect(host.requestedPorts).toEqual([port, port]);
  });

  it('moves to another port when something here already answers on the host port', async () => {
    const host = await startEchoHost();
    // A wildcard listener, as `python3 -m http.server` makes: macOS would still let 127.0.0.1 bind over it.
    const taken = await listen(net.createServer(socket => {
      socket.on('error', () => {});
      socket.end('local app');
    }), '0.0.0.0');
    const tunnel = track(createPortTunnel(host.openStream));

    const local = (await tunnel.sync([taken])).localPorts.get(taken);
    expect(local).toBeDefined();
    expect(local).not.toBe(taken);
    expect(await echoThrough('127.0.0.1', local!, 'to the host')).toBe('to the host');
    expect(host.requestedPorts).toEqual([taken]);
  });

  it('falls back to any free port when the host port and the next 19 are all taken here', async () => {
    const host = await startEchoHost();
    // Find 20 consecutive free ports and hold them all.
    let base = 0;
    for (let attempt = 0; attempt < 20 && !base; attempt += 1) {
      const candidate = 20_000 + Math.floor(Math.random() * 30_000);
      const held: net.Server[] = [];
      for (let port = candidate; port < candidate + 20; port += 1) {
        const server = net.createServer();
        const ok = await new Promise<boolean>(resolve => {
          server.once('error', () => resolve(false));
          server.listen(port, '127.0.0.1', () => resolve(true));
        });
        if (!ok) break;
        held.push(server);
      }
      if (held.length === 20) base = candidate;
      for (const server of held) {
        if (base) cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
        else server.close();
      }
    }
    expect(base).toBeGreaterThan(0);
    const tunnel = track(createPortTunnel(host.openStream));

    const local = (await tunnel.sync([base])).localPorts.get(base);
    expect(local).toBeDefined();
    expect(local! < base || local! >= base + 20).toBe(true);
    expect(await echoThrough('127.0.0.1', local!, 'still reachable')).toBe('still reachable');
  });

  it('closes a port\'s listener once the host stops listing it', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = track(createPortTunnel(host.openStream));

    await tunnel.sync([port]);
    expect((await tunnel.sync([])).localPorts).toEqual(new Map());
    expect(await refuses(port)).toBe(true);
  });

  it('tunnels a host port whose number another host port moved to here', async () => {
    const host = await startEchoHost();
    // The host serves A and A+1; this computer already uses A, so A moves up and A+1 must still get a listener.
    const taken = await listen(net.createServer(), '127.0.0.1');
    const tunnel = track(createPortTunnel(host.openStream));

    const { localPorts } = await tunnel.sync([taken, taken + 1]);
    expect([...localPorts.keys()].sort()).toEqual([taken, taken + 1]);
    expect(new Set(localPorts.values()).size).toBe(2);
    expect(await echoThrough('127.0.0.1', localPorts.get(taken + 1)!, 'second app')).toBe('second app');
    expect(host.requestedPorts).toEqual([taken + 1]);
  });

  it('closes every listener on close', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = createPortTunnel(host.openStream);

    await tunnel.sync([port]);
    await tunnel.close();
    expect(await refuses(port)).toBe(true);
  });

  it('loads a host web server through the host\'s port stream route', async () => {
    const page = http.createServer((_request, response) => response.end('host page'));
    const pagePort = await listen(page, '127.0.0.1');
    const config = createDefaultRemoteDaemonConfig();
    config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    config.host.clients = [{
      id: 'client-1',
      label: 'Laptop',
      createdAt: new Date('2026-10-09T00:00:00.000Z').toISOString(),
      tokenHash: hashRemoteDaemonToken('secret-token'),
    }];
    const server = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), { getConfig: () => ({ remoteDaemon: config }) }, {
      isForwardedPort: port => port === pagePort,
    });
    await server.start();
    cleanups.push(() => server.stop());
    allowedConnections.add(server.getAddress()!.port);
    const tunnel = track(createPortTunnel(port => new WebSocket(`ws://127.0.0.1:${server.getAddress()!.port}/ports/${port}`, {
      headers: { Authorization: 'Bearer secret-token' },
    })));

    // Host and client share this machine, so the page's own port is taken here and the tunnel moves.
    const local = (await tunnel.sync([pagePort])).localPorts.get(pagePort)!;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: local, path: '/', agent: false }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('host page');
  });
});

function ownTable(): SocketRead {
  const sockets: ListeningSocket[] = [];
  for (const server of createdServers) {
    // SAFETY: these test servers bind only TCP endpoints.
    const address = server.address() as net.AddressInfo | null;
    if (address) sockets.push({
      port: address.port, address: address.address,
      family: address.family === 'IPv4' ? 'ipv4' : 'ipv6', pid: process.pid, process: 'node',
    });
  }
  return { complete: true, sockets };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const noStream = () => { throw new Error('provisional listeners must not open streams'); };
const incomplete: SocketRead = { complete: false, sockets: [], reason: 'socket table unavailable' };

describe('passive port tunnel', () => {
  it.each(['win32', 'plan9', 'unknown'])('refuses unsupported local %s without reads, binds or probes', async platform => {
    const readOccupancy = vi.fn(async () => ownTable());
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', platform, readOccupancy }));
    const result = await tunnel.sync([31001, 31002]);
    expect(result.localPorts.size).toBe(0);
    expect([...result.errors.keys()]).toEqual([31001, 31002]);
    expect(result.errors.get(31001)).toMatchObject({ code: 'PORT_FORWARDING_UNAVAILABLE', next: expect.stringContaining('Retry') });
    expect(result.errors.get(31001)?.message).toContain(platform);
    expect(readOccupancy).not.toHaveBeenCalled();
    expect(net.createServer).not.toHaveBeenCalled();
    expect(net.connect).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'])('validates each exact bound endpoint on supported local %s without probes', async platform => {
    const port = await freePort();
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', platform, readOccupancy: async () => ownTable() }));
    const result = await tunnel.sync([port]);
    expect(result.localPorts.get(port)).toBe(port);
    expect(result.errors.size).toBe(0);
    expect(net.connect).not.toHaveBeenCalled();
    await tunnel.sync([]);
    expect(await refuses(port)).toBe(true);
  });

  it.each([
    { address: '0.0.0.0', family: 'ipv4' as const },
    { address: '::', family: 'ipv6' as const },
    { address: '::1', family: 'ipv6' as const },
  ])('skips occupied $address straight to port zero with fresh reads', async endpoint => {
    const port = await freePort();
    const readOccupancy = vi.fn(async () => ({ complete: true as const, sockets: [
      ...ownTable().sockets, { ...endpoint, port, pid: null, process: '' },
    ] }));
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy }));
    const result = await tunnel.sync([port]);
    expect(result.localPorts.get(port)).toBeDefined();
    expect(result.localPorts.get(port)).not.toBe(port);
    expect(listenSpy.mock.calls[0][0]).toBe(0);
    expect(readOccupancy).toHaveBeenCalledTimes(3);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('excludes an established forward even when the next table omits it', async () => {
    const port = await freePort();
    const omittedPorts = new Set<number>();
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => ({
      complete: true, sockets: [
        ...ownTable().sockets.filter(row => !omittedPorts.has(row.port)),
        { port, address: '0.0.0.0', family: 'ipv4', pid: null, process: '' },
      ],
    }) }));
    const established = (await tunnel.sync([port])).localPorts.get(port);
    expect(established).toBeDefined();
    omittedPorts.add(established!);
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    const result = await tunnel.sync([port, established!]);
    expect(result.localPorts.size).toBe(2);
    expect(result.localPorts.get(port)).toBe(established);
    expect(result.localPorts.get(established!)).not.toBe(established);
    expect(listenSpy.mock.calls[0][0]).toBe(0);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it.each(['pre', 'post'])('fails immediately on an incomplete %s-bind read, closes listeners, and retries a missing forward', async stage => {
    const port = await freePort();
    let fail = true;
    let reads = 0;
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
      reads += 1;
      return fail && (stage === 'pre' || reads === 2) ? incomplete : ownTable();
    } }));
    const failed = await tunnel.sync([port]);
    expect(failed.errors.get(port)?.message).toContain('socket table unavailable');
    expect(failed.localPorts.size).toBe(0);
    expect(reads).toBe(stage === 'pre' ? 1 : 2);
    expect(await refuses(port)).toBe(true);
    fail = false;
    const retried = await tunnel.sync([port]);
    expect(retried.localPorts.get(port)).toBe(port);
    expect(retried.errors.size).toBe(0);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unknown', 'wrong pid', 'wrong address', 'wrong family', 'duplicate'])('rejects %s self ownership and never exposes a forward', async ownership => {
    const port = await freePort();
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
      const table = ownTable();
      if (!table.sockets.length) return table;
      const row = table.sockets[0];
      if (ownership === 'missing') table.sockets.shift();
      if (ownership === 'unknown') row.pid = null;
      if (ownership === 'wrong pid') row.pid = process.pid + 1;
      if (ownership === 'wrong address') row.address = '0.0.0.0';
      if (ownership === 'wrong family') row.family = row.family === 'ipv4' ? 'ipv6' : 'ipv4';
      if (ownership === 'duplicate') table.sockets.push({ ...row });
      return table;
    } }));
    const result = await tunnel.sync([port]);
    expect(result.localPorts.size).toBe(0);
    expect(result.errors.get(port)?.code).toBe('PORT_FORWARDING_UNAVAILABLE');
    expect(createdServers.every(server => !server.listening)).toBe(true);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('closes competing candidates and bounds retries at eight port-zero attempts', async () => {
    const port = await freePort();
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
      const table = ownTable();
      if (table.sockets.length) table.sockets.push({ ...table.sockets[0], address: '::', family: 'ipv6', pid: null });
      return table;
    } }));
    const result = await tunnel.sync([port]);
    expect(result.errors.get(port)?.message).toContain('No candidate passed');
    expect(listenSpy.mock.calls.filter(call => call[1] === '127.0.0.1').map(call => call[0])).toEqual([port, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(createdServers.every(server => !server.listening)).toBe(true);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('retries a binding failure without exposing its partially bound listener', async () => {
    const occupied = await listen(net.createServer(), '::1');
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => ({
      ...ownTable(), sockets: ownTable().sockets.filter(row => row.port !== occupied || row.address !== '::1'),
    }) }));
    const result = await tunnel.sync([occupied]);
    expect(result.localPorts.get(occupied)).toBeDefined();
    expect(result.localPorts.get(occupied)).not.toBe(occupied);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('keeps a successful forward when another fails, and removes it on disappearance', async () => {
    const port = await freePort();
    let reads = 0;
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => ++reads === 3 ? incomplete : ownTable() }));
    const result = await tunnel.sync([port, port + 1]);
    expect(result.localPorts.get(port)).toBe(port);
    expect(result.errors.has(port + 1)).toBe(true);
    await tunnel.sync([]);
    expect(await refuses(port)).toBe(true);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('refuses provisional connections and closes immediately while a post-bind read is pending', async () => {
    const port = await freePort();
    const post = deferred<SocketRead>();
    const entered = deferred<void>();
    let reads = 0;
    const openStream = vi.fn(noStream);
    const tunnel = track(createPortTunnel(openStream, { mode: 'passive', readOccupancy: async () => {
      if (++reads === 2) { entered.resolve(); return post.promise; }
      return ownTable();
    } }));
    const pending = tunnel.sync([port]);
    await entered.promise;
    const socket = realConnect({ host: '127.0.0.1', port });
    await new Promise<void>(resolve => { socket.on('error', () => {}); socket.once('close', () => resolve()); });
    expect(openStream).not.toHaveBeenCalled();
    await tunnel.close();
    expect(await refuses(port)).toBe(true);
    post.resolve({ complete: true, sockets: [] });
    expect((await pending).localPorts.size).toBe(0);
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('treats unchanged mode as a no-op and invalidates an outstanding read on a real change', async () => {
    const port = await freePort();
    const read = deferred<SocketRead>();
    const entered = deferred<void>();
    const reader = vi.fn(async () => { entered.resolve(); return read.promise; });
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: reader }));
    const pending = tunnel.sync([port]);
    await entered.promise;
    tunnel.setMode('passive');
    read.resolve({ complete: true, sockets: [] });
    await pending;
    expect(reader).toHaveBeenCalledTimes(2);
    const next = deferred<SocketRead>();
    reader.mockImplementation(async () => next.promise);
    const work = tunnel.sync([port]);
    await Promise.resolve();
    tunnel.setMode('active');
    next.resolve(incomplete);
    expect((await work).localPorts.get(port)).toBeDefined();
  });
});

it('aborts Active availability synchronously, treats the same mode as a no-op, and retries in Passive', async () => {
  const port = await freePort();
  const probes: net.Socket[] = [];
  vi.mocked(net.connect).mockImplementation(() => {
    const socket = new net.Socket();
    probes.push(socket);
    return socket;
  });
  const tunnel = track(createPortTunnel(noStream, { readOccupancy: async () => ownTable() }));
  const pending = tunnel.sync([port]);
  expect(probes).toHaveLength(2);
  tunnel.setMode('active');
  expect(probes.every(socket => !socket.destroyed)).toBe(true);
  tunnel.setMode('passive');
  expect(probes.every(socket => socket.destroyed)).toBe(true);
  expect((await pending).localPorts.get(port)).toBe(port);
  expect(net.connect).toHaveBeenCalledTimes(2);
});

it('preserves established listeners and accepted streams across mode changes', async () => {
  const host = await startEchoHost();
  const port = await freePort();
  const tunnel = track(createPortTunnel(host.openStream, { mode: 'passive', readOccupancy: async () => ownTable() }));
  await tunnel.sync([port]);
  const socket = realConnect({ host: '127.0.0.1', port });
  cleanups.push(() => { socket.destroy(); });
  const response = (text: string) => new Promise<string>((resolve, reject) => {
    socket.once('data', data => resolve(data.toString()));
    socket.once('error', reject);
    socket.write(text);
  });
  expect(await response('before')).toBe('before');
  tunnel.setMode('active');
  tunnel.setMode('passive');
  expect(await response('after')).toBe('after');
  expect((await tunnel.sync([port])).localPorts.get(port)).toBe(port);
  expect(host.requestedPorts).toEqual([port]);
});

it('closes a listener that finishes binding after close', async () => {
  const port = await freePort();
  const originalListen = net.Server.prototype.listen;
  const binding = deferred<void>();
  let release!: () => void;
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: Parameters<net.Server['listen']>) {
    release = () => { originalListen.apply(this, args); };
    binding.resolve();
    return this;
  });
  const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => ownTable() }));
  const pending = tunnel.sync([port]);
  await binding.promise;
  await tunnel.close();
  release();
  expect((await pending).localPorts.size).toBe(0);
  expect(await refuses(port)).toBe(true);
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('native passive forwarding post-bind', () => {
  it('attributes every actual bound loopback endpoint and opens without availability connections', async () => {
    const port = await freePort();
    const tables: SocketRead[] = [];
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
      const table = await readLocalPortOccupancy();
      tables.push(table);
      return table;
    } }));
    const result = await tunnel.sync([port]);
    expect(result.errors).toEqual(new Map());
    expect(result.localPorts.get(port)).toBe(port);
    expect(tables).toHaveLength(2);
    for (const server of createdServers.filter(server => server.listening)) {
      // SAFETY: a listening TCP server reports an AddressInfo.
      const address = server.address() as net.AddressInfo;
      expect(tables[1].sockets.filter(row => row.port === address.port && row.address === address.address &&
        row.family === (address.family === 'IPv4' ? 'ipv4' : 'ipv6') && row.pid === process.pid)).toHaveLength(1);
    }
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('avoids a real wildcard listener without contacting it', async () => {
    const accepted = vi.fn((socket: net.Socket) => socket.destroy());
    const port = await listen(net.createServer(accepted), '0.0.0.0');
    const tunnel = track(createPortTunnel(noStream, { mode: 'passive' }));
    const result = await tunnel.sync([port]);
    expect(result.errors).toEqual(new Map());
    expect(result.localPorts.get(port)).toBeDefined();
    expect(result.localPorts.get(port)).not.toBe(port);
    expect(accepted).not.toHaveBeenCalled();
    expect(net.connect).not.toHaveBeenCalled();
  });
});

it('retains the operating-system bind error when all candidates fail', async () => {
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('controlled permission failure'), { code: 'EACCES' })));
    return this;
  });
  const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => ownTable() }));
  const result = await tunnel.sync([31004]);
  expect(result.errors.get(31004)?.message).toContain('controlled permission failure');
  expect(net.connect).not.toHaveBeenCalled();
});

it('rejects a port-zero assignment already present in its fresh pre-bind table', async () => {
  const port = await freePort();
  const assigned = await freePort();
  const originalListen = net.Server.prototype.listen;
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: Parameters<net.Server['listen']>) {
    if (args[0] === 0) args[0] = assigned;
    return originalListen.apply(this, args);
  });
  const readOccupancy = vi.fn(async (): Promise<SocketRead> => ({ complete: true, sockets: [
    { port, address: '0.0.0.0', family: 'ipv4', pid: null, process: '' },
    { port: assigned, address: '::', family: 'ipv6', pid: null, process: '' },
  ] }));
  const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy }));
  const result = await tunnel.sync([port]);
  expect(result.errors.has(port)).toBe(true);
  expect(result.localPorts.size).toBe(0);
  expect(readOccupancy).toHaveBeenCalledTimes(9);
  expect(createdServers.every(server => !server.listening)).toBe(true);
  expect(net.connect).not.toHaveBeenCalled();
});

it.each(['win32', 'unknown'])('keeps Active available on local %s', async platform => {
  const port = await freePort();
  const readOccupancy = vi.fn(async () => incomplete);
  const tunnel = track(createPortTunnel(noStream, { platform, readOccupancy }));
  expect((await tunnel.sync([port])).localPorts.get(port)).toBe(port);
  expect(net.connect).toHaveBeenCalled();
  expect(readOccupancy).not.toHaveBeenCalled();
});

it('invalidates an outstanding pre-bind read on close without binding', async () => {
  const read = deferred<SocketRead>();
  const entered = deferred<void>();
  const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
    entered.resolve();
    return read.promise;
  } }));
  const pending = tunnel.sync([31008]);
  await entered.promise;
  await tunnel.close();
  read.resolve({ complete: true, sockets: [] });
  expect((await pending).localPorts.size).toBe(0);
  expect(net.createServer).not.toHaveBeenCalled();
  expect(net.connect).not.toHaveBeenCalled();
});

it('reports unavailable if a provisional listener disappears before verification', async () => {
  const port = await freePort();
  let reads = 0;
  const tunnel = track(createPortTunnel(noStream, { mode: 'passive', readOccupancy: async () => {
    if (++reads === 2) for (const server of createdServers.filter(server => server.listening)) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    return ownTable();
  } }));
  const result = await tunnel.sync([port]);
  expect(result.localPorts.size).toBe(0);
  expect(result.errors.get(port)?.message).toContain('disappeared');
  expect(await refuses(port)).toBe(true);
  expect(net.connect).not.toHaveBeenCalled();
});
