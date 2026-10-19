import net from 'net';
import { pipeline } from 'stream';
import { createWebSocketStream, type WebSocket } from 'ws';
import { supportsPassivePortDiscovery, type ListeningPort, type PortDiscoveryMode } from '../../../../shared/types/listeningPorts';
import { PaneError } from '../../../../shared/paneError';
import { readLocalPortOccupancy } from '../../services/listeningSockets';

type ForwardingError = NonNullable<ListeningPort['forwardingError']>;

export interface PortTunnelSyncResult {
  localPorts: ReadonlyMap<number, number>;
  errors: ReadonlyMap<number, ForwardingError>;
}

export interface PortTunnel {
  sync(hostPorts: readonly number[]): Promise<PortTunnelSyncResult>;
  setMode(mode: PortDiscoveryMode): void;
  close(): Promise<void>;
}

export interface PortTunnelOptions {
  mode?: PortDiscoveryMode;
  readOccupancy?: typeof readLocalPortOccupancy;
  platform?: string;
}

/** Opens one authenticated stream to a host port. */
export type OpenPortStream = (hostPort: number) => WebSocket;

interface PortListener {
  localPort: number;
  servers: net.Server[];
  sockets: Set<net.Socket>;
  ready: boolean;
  closing?: Promise<void>;
}

type Allocation = PortListener | ForwardingError | null;
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
const MAX_PORT_ATTEMPTS = 20;
const PASSIVE_ZERO_ATTEMPTS = 8;
const ANSWER_PROBE_TIMEOUT_MS = 300;
const MAX_PORT = 65_535;

export function createPortTunnel(openStream: OpenPortStream, options: PortTunnelOptions = {}): PortTunnel {
  const listeners = new Map<number, PortListener>();
  const provisional = new Set<PortListener>();
  const readOccupancy = options.readOccupancy ?? readLocalPortOccupancy;
  const platform = options.platform ?? process.platform;
  let mode = options.mode ?? 'active';
  let allocation = new AbortController();
  let closed = false;

  const ownLocalPorts = () => new Set([...listeners.values()].map(listener => listener.localPort));
  const unavailable = (hostPort: number, reason: string): ForwardingError => {
    const next = 'Retry this port in the Ports list. If Passive is unsupported on this platform, select Active in local Settings.';
    const error = new PaneError('PORT_FORWARDING_UNAVAILABLE',
      `Local forwarding for host port ${hostPort} is unavailable: "${reason}". No local forwarding address was made available.`,
      next);
    return { code: error.code, message: error.message, next };
  };

  const shut = (listener: PortListener): Promise<void> => {
    listener.ready = false;
    for (const socket of listener.sockets) socket.destroy();
    listener.closing ??= Promise.all(listener.servers.map(server =>
      new Promise<void>(resolve => server.close(() => resolve())))).then(() => undefined);
    return listener.closing;
  };

  const listenFor = async (hostPort: number, localPort: number, signal: AbortSignal): Promise<PortListener | null> => {
    const listener: PortListener = { localPort, servers: [], sockets: new Set(), ready: false };
    const bound = await listenOnLoopback(localPort, socket => {
      if (!listener.ready) { socket.destroy(); return; }
      listener.sockets.add(socket);
      socket.once('close', () => listener.sockets.delete(socket));
      const webSocket = openStream(hostPort);
      const stream = createWebSocketStream(webSocket);
      pipeline(socket, stream, socket, () => {
        socket.destroy();
        webSocket.terminate();
      });
    }, signal);
    if (!bound) return null;
    listener.localPort = bound.port;
    listener.servers = bound.servers;
    if (signal.aborted) { await shut(listener); return null; }
    provisional.add(listener);
    return listener;
  };

  const openActive = async (hostPort: number, signal: AbortSignal): Promise<Allocation> => {
    const taken = ownLocalPorts();
    for (let candidate = hostPort; candidate < hostPort + MAX_PORT_ATTEMPTS && candidate <= MAX_PORT; candidate += 1) {
      if (signal.aborted) return null;
      if (taken.has(candidate) || await answersHere(candidate, signal)) continue;
      if (signal.aborted) return null;
      try {
        const listener = await listenFor(hostPort, candidate, signal);
        if (listener) return listener;
      } catch { continue; }
    }
    if (signal.aborted) return null;
    return await listenFor(hostPort, 0, signal) ?? unavailable(hostPort, 'No local listener could be bound.');
  };

  const openPassive = async (hostPort: number, signal: AbortSignal): Promise<Allocation> => {
    if (!supportsPassivePortDiscovery(platform)) {
      return unavailable(hostPort, `Passive forwarding is not supported on local platform ${platform}`);
    }
    let bindFailure: string | undefined;
    for (let attempt = 0; attempt <= PASSIVE_ZERO_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return null;
      const before = await readOccupancy();
      if (signal.aborted) return null;
      if (!before.complete) return unavailable(hostPort, before.reason);
      const candidate = attempt === 0 ? hostPort : 0;
      const taken = ownLocalPorts();
      if (taken.has(candidate) || before.sockets.some(socket => socket.port === candidate)) continue;
      let listener: PortListener | null;
      try { listener = await listenFor(hostPort, candidate, signal); }
      catch (error) { bindFailure = error instanceof Error ? error.message : String(error); continue; }
      if (signal.aborted) { if (listener) await shut(listener); return null; }
      if (!listener) continue;
      let accepted = false;
      try {
        if (taken.has(listener.localPort) || before.sockets.some(socket => socket.port === listener.localPort)) continue;
        const after = await readOccupancy();
        if (signal.aborted) return null;
        if (!after.complete) return unavailable(hostPort, after.reason);
        const remaining = after.sockets.filter(socket => socket.port === listener.localPort);
        for (const server of listener.servers) {
          // SAFETY: this server binds only TCP loopback, never a Unix socket.
          const address = server.address() as net.AddressInfo | null;
          if (!address) return unavailable(hostPort, 'The provisional listener disappeared.');
          const index = remaining.findIndex(socket => socket.address === address.address &&
            socket.family === (address.family === 'IPv4' ? 'ipv4' : 'ipv6') && socket.pid === process.pid);
          if (index === -1) return unavailable(hostPort, 'The socket table could not attribute our listener.');
          remaining.splice(index, 1);
        }
        if (remaining.length) continue;
        accepted = true;
        return listener;
      } finally {
        if (!accepted) { provisional.delete(listener); await shut(listener); }
      }
    }
    return unavailable(hostPort, bindFailure ?? 'No candidate passed the post-bind availability check.');
  };

  return {
    setMode(next) {
      if (mode === next) return;
      mode = next;
      allocation.abort();
      allocation = new AbortController();
      for (const listener of provisional) void shut(listener);
      provisional.clear();
    },
    async sync(hostPorts) {
      const errors = new Map<number, ForwardingError>();
      const wanted = new Set(hostPorts);
      for (const [hostPort, listener] of [...listeners]) {
        if (wanted.has(hostPort)) continue;
        listeners.delete(hostPort);
        await shut(listener);
      }
      for (const hostPort of wanted) {
        while (!closed && !listeners.has(hostPort)) {
          const signal = allocation.signal;
          let result: Allocation;
          try { result = await (mode === 'passive' ? openPassive : openActive)(hostPort, signal); }
          catch (error) { result = unavailable(hostPort, error instanceof Error ? error.message : String(error)); }
          if (result && 'servers' in result) provisional.delete(result);
          if (signal.aborted || closed) {
            if (result && 'servers' in result) await shut(result);
            continue;
          }
          if (result && 'servers' in result) {
            result.ready = true;
            listeners.set(hostPort, result);
          } else if (result) errors.set(hostPort, result);
          break;
        }
      }
      return { localPorts: new Map([...listeners].map(([hostPort, listener]) => [hostPort, listener.localPort])), errors };
    },
    async close() {
      closed = true;
      allocation.abort();
      const all = [...listeners.values(), ...provisional];
      listeners.clear();
      provisional.clear();
      await Promise.all(all.map(shut));
    },
  };
}

/** macOS can bind loopback over another app's wildcard listener, so Active checks both addresses. */
async function answersHere(port: number, signal: AbortSignal): Promise<boolean> {
  const answers = await Promise.all(LOOPBACK_HOSTS.map(host => new Promise<boolean>(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const socket = net.connect({ host, port });
    const finish = (result: boolean) => {
      signal.removeEventListener('abort', abort);
      socket.setTimeout(0);
      socket.destroy();
      resolve(result);
    };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(ANSWER_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  })));
  return answers.some(Boolean);
}

/** Bind both loopbacks, accepting IPv4 alone only when IPv6 is unavailable. */
async function listenOnLoopback(
  requestedPort: number,
  onConnection: (socket: net.Socket) => void,
  signal: AbortSignal,
): Promise<{ port: number; servers: net.Server[] } | null> {
  const servers: net.Server[] = [];
  let port = requestedPort;
  let failure: NodeJS.ErrnoException | null = null;
  for (const host of LOOPBACK_HOSTS) {
    if (signal.aborted) break;
    const server = net.createServer(onConnection);
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      server.once('error', resolve);
      server.listen(port, host, () => resolve(null));
    });
    if (!error) {
      servers.push(server);
      // SAFETY: a listening TCP server reports an AddressInfo.
      port = (server.address() as net.AddressInfo).port;
      continue;
    }
    if (host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) continue;
    failure = error;
    break;
  }
  if (signal.aborted || failure || servers.length === 0) {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    if (failure && !signal.aborted) throw failure;
    return null;
  }
  return { port, servers };
}
