import childProcess from 'child_process';
import { isIP } from 'net';

export interface ListeningSocket {
  port: number;
  address: string;
  family: 'ipv4' | 'ipv6';
  pid: number | null;
  process: string;
}

export type SocketRead =
  | { complete: true; sockets: ListeningSocket[] }
  | { complete: false; sockets: ListeningSocket[]; reason: string };

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type Endpoint = Pick<ListeningSocket, 'address' | 'port' | 'family'>;
const READ_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LSOF_ARGS = ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-F', 'pcftn'];

function incomplete(reason: string, sockets: ListeningSocket[] = []): SocketRead {
  return { complete: false, sockets, reason };
}

function finish(result: CommandResult, sockets: ListeningSocket[], valid: boolean): SocketRead {
  if (result.exitCode !== 0) return incomplete(`Socket command exited with status ${result.exitCode}.`, sockets);
  if (result.stderr.trim()) return incomplete(`Socket command reported: ${result.stderr.trim()}`, sockets);
  if (!valid) return incomplete('Socket output was incomplete or unrecognized.', sockets);
  return { complete: true, sockets };
}

function endpoint(value: string, separator: ':' | '.', family?: Endpoint['family'], allowZero = false, allowScopedIpv4 = false): Endpoint | null {
  const boundary = value.lastIndexOf(separator);
  if (boundary < 0) return null;
  const rawAddress = value.slice(0, boundary).replace(/^\[(.*)\]$/u, '$1');
  const scopedIpv4 = allowScopedIpv4 ? rawAddress.match(/^(.+)%[A-Za-z0-9_.-]+$/u) : null;
  const address = scopedIpv4 && isIP(scopedIpv4[1]) === 4 ? scopedIpv4[1] : rawAddress;
  const portText = value.slice(boundary + 1);
  if (!/^\d+$/u.test(portText)) return null;
  const port = Number(portText);
  if (port < (allowZero ? 0 : 1) || port > 65535) return null;
  const version = isIP(address);
  if (address !== '*' && version === 0) return null;
  if (family === 'ipv4' && version === 6) return null;
  return { address, port, family: family ?? (version === 4 ? 'ipv4' : 'ipv6') };
}

function unknownOwner(value: Endpoint): ListeningSocket {
  return { ...value, pid: null, process: '' };
}

export function parseLsofResult(result: CommandResult): SocketRead {
  const sockets: ListeningSocket[] = [];
  let valid = true;
  let pid: number | null = null;
  let command = '';
  let hasFile = false;
  let file: { family?: Endpoint['family']; endpoint?: Endpoint } | null = null;
  const flush = () => {
    if (!file) return;
    if (pid === null || !command || !file.family || !file.endpoint) valid = false;
    else sockets.push({ ...file.endpoint, pid, process: command });
    file = null;
  };
  for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        flush();
        if (pid !== null && (!command || !hasFile)) valid = false;
        pid = /^\d+$/u.test(value) && Number(value) > 0 ? Number(value) : null;
        command = '';
        hasFile = false;
        if (pid === null) valid = false;
        break;
      case 'c':
        if (pid === null || command || file) valid = false;
        command = value;
        break;
      case 'f':
        flush();
        if (!/^\d+$/u.test(value)) valid = false;
        file = {};
        hasFile = true;
        break;
      case 't':
        if (!file || file.family || (value !== 'IPv4' && value !== 'IPv6')) valid = false;
        else file.family = value === 'IPv4' ? 'ipv4' : 'ipv6';
        break;
      case 'n': {
        const parsed = endpoint(value, ':', file?.family);
        if (!file || !file.family || file.endpoint || !parsed) valid = false;
        else file.endpoint = parsed;
        break;
      }
      default: valid = false;
    }
  }
  flush();
  if (pid !== null && (!command || !hasFile)) valid = false;
  if (result.stdout.trim() && sockets.length === 0) valid = false;
  return finish(result, sockets, valid);
}

export function parseSsResult(result: CommandResult): SocketRead {
  const sockets: ListeningSocket[] = [];
  let valid = true;
  for (const line of result.stdout.split(/\r?\n/u).map(row => row.trim()).filter(Boolean)) {
    const fields = line.split(/\s+/u);
    const local = endpoint(fields[3] ?? '', ':', undefined, false, true);
    const remote = fields[4]?.replace(/:\*$/u, ':0');
    if (fields[0] !== 'LISTEN' || !/^\d+$/u.test(fields[1] ?? '') || !/^\d+$/u.test(fields[2] ?? '') || !local || !remote || !endpoint(remote, ':', undefined, true)) {
      valid = false;
      continue;
    }
    const owners = fields.slice(5).join(' ');
    if (!owners) {
      sockets.push(unknownOwner(local));
      continue;
    }
    const ownerPattern = /\("([^"\\]*(?:\\.[^"\\]*)*)",pid=(\d+),fd=(\d+)\)/gu;
    const matches = [...owners.matchAll(ownerPattern)];
    const remainder = owners.replace(ownerPattern, '').replace(/,/gu, '');
    if (!matches.length || remainder !== 'users:()') valid = false;
    for (const owner of matches) {
      const pid = Number(owner[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0) valid = false;
      else sockets.push({ ...local, pid, process: owner[1] });
    }
    if (!matches.length) sockets.push(unknownOwner(local));
  }
  return finish(result, sockets, valid);
}

export function parseWindowsNetstatResult(result: CommandResult): SocketRead {
  const sockets: ListeningSocket[] = [];
  let valid = true;
  let title = false;
  let header = false;
  let verifiedEmptyHeader = false;
  let sawTcpRow = false;
  for (const line of result.stdout.split(/\r?\n/u).map(row => row.trim()).filter(Boolean)) {
    if (!title) {
      if (!/^[\p{L}\p{M}\s]+$/u.test(line)) valid = false;
      else title = true;
      continue;
    }
    if (!header) {
      const fields = line.split(/\s+/u);
      if (fields.at(-1) !== 'PID' || fields.length < 5 ||
          !fields.slice(0, -1).every(field => /^[\p{L}\p{M}]+$/u.test(field))) valid = false;
      else {
        header = true;
        const columns = line.split(/\s{2,}/u);
        verifiedEmptyHeader = fields[0] === 'Proto' || (columns.length === 5 && columns.at(-1) === 'PID');
      }
      continue;
    }
    const [proto, localText, remoteText, state, pidText, extra] = line.split(/\s+/u);
    if (proto !== 'TCP') {
      valid = false;
      continue;
    }
    const local = endpoint(localText ?? '', ':');
    const remote = endpoint(remoteText ?? '', ':', undefined, true);
    const pid = /^\d+$/u.test(pidText ?? '') ? Number(pidText) : NaN;
    if (!local || !remote || !state || !Number.isSafeInteger(pid) || pid < 0 || extra) {
      valid = false;
      continue;
    }
    sawTcpRow = true;
    if (remote.port === 0 && (remote.address === '0.0.0.0' || remote.address === '::')) {
      sockets.push({ ...local, pid, process: '' });
    }
  }
  return finish(result, sockets, valid && title && header && (verifiedEmptyHeader || sawTcpRow));
}

export function parseDarwinNetstatResult(result: CommandResult): SocketRead {
  const sockets: ListeningSocket[] = [];
  let valid = true;
  let header = false;
  const states = new Set(['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT_2', 'TIME_WAIT']);
  for (const line of result.stdout.split(/\r?\n/u).map(row => row.trim()).filter(Boolean)) {
    if (line === 'Active Internet connections (including servers)') continue;
    if (/^Proto\s+Recv-Q\s+Send-Q\s+Local Address\s+Foreign Address\s+\(state\)$/u.test(line)) {
      header = true;
      continue;
    }
    const [proto, recv, send, localText, remoteText, state, extra] = line.split(/\s+/u);
    const family = proto === 'tcp4' ? 'ipv4' : 'ipv6';
    const local = endpoint(localText ?? '', '.', family, true);
    const remote = remoteText === '*.*' ? true : endpoint(remoteText ?? '', '.', family, true);
    if (!header || !['tcp4', 'tcp6', 'tcp46'].includes(proto) || !/^\d+$/u.test(recv ?? '') || !/^\d+$/u.test(send ?? '') || !local || !remote || !states.has(state) || extra) {
      valid = false;
      continue;
    }
    if (state === 'LISTEN') {
      if (local.port === 0) valid = false;
      else sockets.push(unknownOwner(local));
    }
  }
  return finish(result, sockets, valid && header);
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { encoding: 'utf8', timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      const exitCode = error ? Number(error.code) : 0;
      if (error && (error.killed || error.signal || !Number.isInteger(exitCode))) reject(error);
      else resolve({ stdout, stderr, exitCode });
    });
  });
}

async function read(command: string, args: string[], parse: (result: CommandResult) => SocketRead | Promise<SocketRead>): Promise<SocketRead> {
  try {
    return await parse(await run(command, args));
  } catch (error) {
    return incomplete(`Could not read sockets: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readLsof(): Promise<SocketRead> {
  return read('lsof', LSOF_ARGS, parseLsofResult);
}

export async function readListeningSockets(): Promise<SocketRead> {
  if (process.platform === 'darwin') return read('lsof', LSOF_ARGS, async result => {
    const parsed = parseLsofResult(result);
    if (result.exitCode !== 1 || result.stdout !== '' || result.stderr !== '') return parsed;
    const table = await read('/usr/sbin/netstat', ['-anlW', '-p', 'tcp'], parseDarwinNetstatResult);
    return table.complete && table.sockets.length === 0 ? { complete: true, sockets: [] } : parsed;
  });
  if (process.platform === 'linux') return read('ss', ['-Hltnp'], parseSsResult);
  if (process.platform !== 'win32') return incomplete(`Socket enumeration is unsupported on ${process.platform}.`);
  const reads = await Promise.all(['TCP', 'TCPv6'].map(family => read('netstat', ['-ano', '-p', family], parseWindowsNetstatResult)));
  const sockets = reads.flatMap(result => result.sockets);
  const failed = reads.find(result => !result.complete);
  return failed && !failed.complete ? incomplete(failed.reason, sockets) : { complete: true, sockets };
}

export async function readLocalPortOccupancy(): Promise<SocketRead> {
  if (process.platform !== 'darwin') return readListeningSockets();
  const table = await read('/usr/sbin/netstat', ['-anlW', '-p', 'tcp'], parseDarwinNetstatResult);
  if (!table.complete) return table;
  const owners = await readLsof();
  const key = (socket: ListeningSocket) => `${socket.family}:${socket.address}:${socket.port}`;
  const sockets = table.sockets.map(socket => {
    const matches = owners.sockets.filter(owner => key(owner) === key(socket));
    const tableMatches = table.sockets.filter(other => key(other) === key(socket));
    // Only a unique exact match may later be excluded as our own new binding.
    return owners.complete && matches.length === 1 && tableMatches.length === 1 ? { ...socket, pid: matches[0].pid, process: matches[0].process } : socket;
  });
  const endpoints = new Set(table.sockets.map(key));
  for (const owner of owners.sockets) {
    if (!endpoints.has(key(owner))) sockets.push(unknownOwner(owner));
  }
  return { complete: true, sockets };
}
