import http from 'http';
import os from 'os';
import path from 'path';
import { PaneError } from '../../../shared/paneError';
import { readListeningSockets, type ListeningSocket } from './listeningSockets';
import { readProcessTable, type ProcessTableRow } from '../utils/processTree';
import {
  LISTENING_PORT_GROUP_ORDER,
  type ListeningPort,
  type ListeningPortGroup,
  type ListeningPortKind,
  type ListeningPortsSnapshot,
  type PortDiscoveryMode,
} from '../../../shared/types/listeningPorts';

const POLL_INTERVAL_MS = 2_000;
/** A socket read slower than this share of the interval stretches the interval, so polling stays cheap. */
const MAX_POLL_DUTY = 0.1;
const WEB_PROBE_TIMEOUT_MS = 500;
/**
 * A port that accepts but does not answer in time may be a dev server busy
 * with its first request (next dev compiles the page), so it is asked again
 * on later polls, this many times.
 */
const SILENT_PORT_RETRIES = 10;
/** Relays that exit after their first connection; probing one would end it. */
const ONE_SHOT_LISTENERS = new Set(['nc', 'ncat', 'netcat', 'socat']);

interface TerminalPane {
  /** The terminal's PTY process; everything it starts descends from it. */
  pid: number;
  sessionId: string;
  paneName: string;
}

export interface ListeningPortMonitorOptions {
  /** Root of Pane's own process tree. */
  panePid?: number;
  mode?: PortDiscoveryMode;
  readSockets?: typeof readListeningSockets;
  readProcessTable?: typeof readProcessTable;
  terminalPanes(): TerminalPane[];
  onChange?(snapshot: ListeningPortsSnapshot): void;
}

export interface ListeningPortMonitor {
  /** Reads the host's listening ports now and returns the new list. */
  refresh(): Promise<ListeningPortsSnapshot>;
  /** The list from the last read, without reading again. */
  snapshot(): ListeningPortsSnapshot;
  /** Refreshes every 2 s, or less often when a read is slow, until `stop`. */
  start(): void;
  setMode(mode: PortDiscoveryMode): void;
  stop(): void;
}

interface Owner {
  group: ListeningPortGroup;
  /** Set when the socket table did not name the program (Windows `netstat`). */
  process?: string;
  sessionId?: string;
  paneName?: string;
}

/**
 * Lists every listening TCP port on this machine with the process that owns it,
 * which group that process belongs to, and whether the port speaks HTTP.
 */
export function createListeningPortMonitor(options: ListeningPortMonitorOptions): ListeningPortMonitor {
  const panePid = options.panePid ?? process.pid;
  // Ownership never changes for a running process, and a port keeps its kind
  // once it answers, so both are remembered while the listener lives.
  const owners = new Map<string, Owner>();
  const kinds = new Map<string, { kind: ListeningPortKind; retriesLeft: number }>();
  let mode: PortDiscoveryMode = options.mode ?? 'active';
  let revision = 0;
  let controller = new AbortController();
  let current: ListeningPortsSnapshot = { host: os.hostname(), ports: [], discoveryMode: mode };
  let inFlight: { revision: number; promise: Promise<ListeningPortsSnapshot> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pollEpoch = 0;
  // Only the socket read paces polling: probes wait on other programs, and
  // the process table is read only when a new owner appears.
  let socketReadMs = 0;

  const read = async (readRevision: number, signal: AbortSignal): Promise<ListeningPortsSnapshot> => {
    const readStartedAt = Date.now();
    const result = await (options.readSockets ?? readListeningSockets)();
    if (readRevision !== revision || signal.aborted) return current;
    if (!result.complete) {
      throw new PaneError('listening_ports_read_failed', `Could not refresh listening ports: ${result.reason} The previous list was retained.`, 'Retry refreshing the port list.');
    }
    const byPort = new Map<number, ListeningSocket[]>();
    for (const socket of result.sockets) {
      const rows = byPort.get(socket.port) ?? [];
      rows.push(socket);
      byPort.set(socket.port, rows);
    }
    // A numeric port with uncertain ownership cannot be forwarded to a known process.
    const sockets = [...byPort.values()].flatMap(rows => rows.length === 1 ||
      (rows[0].pid !== null && rows.every(row => row.pid === rows[0].pid && row.process === rows[0].process))
      ? [rows[0]] : []);
    socketReadMs = Date.now() - readStartedAt;
    const key = (socket: ListeningSocket) => `${socket.port}:${socket.pid ?? ''}:${socket.process}`;
    const unknownOwners = sockets.filter(socket => !owners.has(key(socket)));
    const provisional = new Map<string, Owner>();
    const terminalPanes = options.terminalPanes();
    if (unknownOwners.length > 0) {
      const table = await (options.readProcessTable ?? readProcessTable)();
      if (readRevision !== revision || signal.aborted) return current;
      const terminals = new Map(terminalPanes.map(terminal => [terminal.pid, terminal]));
      // An empty table means the read failed: use the answer once and ask again next poll.
      const target = table.length > 0 ? owners : provisional;
      for (const socket of unknownOwners) target.set(key(socket), classify(socket, table, terminals, panePid));
    }
    // SAFETY: every live socket was classified above.
    const ownerOf = (socket: ListeningSocket) => (owners.get(key(socket)) ?? provisional.get(key(socket)))!;
    if (mode === 'active') await Promise.all(sockets.filter(socket => (kinds.get(key(socket))?.retriesLeft ?? 1) > 0).map(async socket => {
      if (readRevision !== revision || signal.aborted) return;
      if (ONE_SHOT_LISTENERS.has(ownerOf(socket).process ?? socket.process)) {
        kinds.set(key(socket), { kind: 'tcp', retriesLeft: 0 });
        return;
      }
      const answer = await probe(socket.port, signal);
      if (readRevision !== revision || signal.aborted || answer === 'aborted') return;
      const previous = kinds.get(key(socket));
      const retriesLeft = answer !== 'silent' ? 0 : previous ? previous.retriesLeft - 1 : SILENT_PORT_RETRIES;
      kinds.set(key(socket), { kind: answer === 'web' ? 'web' : 'tcp', retriesLeft });
    }));
    if (readRevision !== revision || signal.aborted) return current;

    const live = new Set(sockets.map(key));
    for (const cached of [...owners.keys()]) if (!live.has(cached)) owners.delete(cached);
    for (const cached of [...kinds.keys()]) if (!live.has(cached)) kinds.delete(cached);

    // Pane names can change while a server runs, so they are read every poll;
    // a Pane whose terminals are gone keeps the name it had.
    const paneNames = new Map(terminalPanes.map(terminal => [terminal.sessionId, terminal.paneName]));
    const ports = sockets.map((socket): ListeningPort => {
      const owner = ownerOf(socket);
      const port: ListeningPort = {
        port: socket.port, pid: socket.pid, process: socket.process, ...owner,
        kind: mode === 'passive' ? 'tcp' : kinds.get(key(socket))!.kind,
      };
      if (mode === 'passive') port.probeStatus = 'unchecked';
      const currentName = owner.sessionId === undefined ? undefined : paneNames.get(owner.sessionId);
      if (currentName !== undefined) port.paneName = currentName;
      return port;
    });
    ports.sort((a, b) =>
      LISTENING_PORT_GROUP_ORDER.indexOf(a.group) - LISTENING_PORT_GROUP_ORDER.indexOf(b.group) || a.port - b.port);
    return { host: os.hostname(), ports, discoveryMode: mode };
  };

  const refresh = (): Promise<ListeningPortsSnapshot> => {
    if (inFlight?.revision === revision) return inFlight.promise;
    const readRevision = revision;
    const signal = controller.signal;
    const active = { revision: readRevision, promise: Promise.resolve(current) };
    active.promise = read(readRevision, signal).then(next => {
      if (readRevision !== revision || signal.aborted) return current;
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next;
        options.onChange?.(current);
      }
      return current;
    }).finally(() => { if (inFlight === active) inFlight = null; });
    inFlight = active;
    return active.promise;
  };

  const schedule = (delayMs: number) => {
    const scheduledEpoch = pollEpoch;
    timer = setTimeout(() => {
      void refresh().catch(error => {
        console.warn('[ListeningPorts] refresh_failed:', error);
      }).finally(() => {
        if (running && scheduledEpoch === pollEpoch) schedule(Math.max(POLL_INTERVAL_MS, socketReadMs / MAX_POLL_DUTY));
      });
    }, delayMs);
    timer.unref?.();
  };

  return {
    refresh,
    snapshot: () => current,
    setMode(nextMode) {
      if (nextMode === mode) return;
      controller.abort();
      revision++;
      controller = new AbortController();
      inFlight = null;
      mode = nextMode;
      owners.clear();
      kinds.clear();
      current = {
        ...current,
        discoveryMode: mode,
        ports: current.ports.map(port => mode === 'passive'
          ? { ...port, kind: 'tcp', probeStatus: 'unchecked' }
          : { ...port, kind: 'tcp', probeStatus: undefined }),
      };
      options.onChange?.(current);
      void refresh().catch(error => console.warn('[ListeningPorts] refresh_failed:', error));
    },
    start() {
      if (running) return;
      running = true;
      pollEpoch++;
      schedule(0);
    },
    stop() {
      running = false;
      pollEpoch++;
      revision++;
      controller.abort();
      controller = new AbortController();
      inFlight = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function classify(
  socket: ListeningSocket,
  table: ProcessTableRow[],
  terminals: Map<number, TerminalPane>,
  panePid: number,
): Owner {
  if (socket.pid === null) return { group: 'system' };
  const rows = new Map(table.map(row => [row.pid, row]));
  const row = rows.get(socket.pid);
  const named = socket.process || !row ? {} : { process: path.win32.basename(row.executable).replace(/\.exe$/iu, '') };
  // Walk up from the owner: the nearest terminal or Pane ancestor decides.
  // Terminals descend from Pane, so a terminal is always reached first.
  const seen = new Set<number>();
  for (let pid: number | undefined = socket.pid; pid !== undefined && pid > 0 && !seen.has(pid); pid = rows.get(pid)?.parentPid) {
    seen.add(pid);
    const terminal = terminals.get(pid);
    if (terminal) return { ...named, group: 'pane-terminal', sessionId: terminal.sessionId, paneName: terminal.paneName };
    if (pid === panePid) return { ...named, group: 'pane' };
  }
  return { ...named, group: row && isSystemProcess(row) ? 'system' : 'other' };
}

/** An OS service: another user's process, or a program shipped with the OS. */
function isSystemProcess(row: ProcessTableRow): boolean {
  if (row.uid !== null && row.uid !== process.getuid?.()) return true;
  if (process.platform === 'darwin') return row.executable.startsWith('/System/') || row.executable.startsWith('/usr/libexec/');
  if (process.platform === 'win32') {
    const systemRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + path.win32.sep;
    return row.pid <= 4 || !path.win32.isAbsolute(row.executable) || row.executable.toLowerCase().startsWith(systemRoot);
  }
  return false;
}

/**
 * `web` when the port answers an HTTP request with any status within 500 ms,
 * `silent` when it accepts and says nothing in that time, else `tcp`.
 */
function probe(port: number, signal: AbortSignal): Promise<ListeningPortKind | 'silent' | 'aborted'> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('aborted'); return; }
    // `localhost` by name: a dev server may bind only IPv6 loopback, and
    // Node tries both address families.
    let settled = false;
    const request = http.request({ method: 'HEAD', host: 'localhost', port, path: '/' }, () => finish(signal.aborted ? 'aborted' : 'web'));
    // An absolute deadline: a socket timeout restarts on every byte, so a
    // port that trickles bytes would hold the poll open forever.
    const deadline = setTimeout(() => finish('silent'), WEB_PROBE_TIMEOUT_MS);
    const onAbort = () => finish('aborted');
    const onError = () => finish(signal.aborted ? 'aborted' : 'tcp');
    const finish = (answer: ListeningPortKind | 'silent' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', onAbort);
      resolve(answer);
      request.destroy();
    };
    request.on('error', onError);
    request.once('close', () => request.off('error', onError));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    request.end();
  });
}
