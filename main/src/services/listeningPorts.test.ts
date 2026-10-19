import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListeningPortMonitor } from './listeningPorts';
import { readListeningSockets, readLocalPortOccupancy, type SocketRead } from './listeningSockets';

const HTTP_SERVER = `require('http').createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port, process.pid); });`;
// Accepts connections and never answers, like a database waiting for its own protocol.
const SILENT_TCP_SERVER = `require('net').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port, process.pid); });`;
// Accepts one connection and stops listening, like `nc -l`.
const ONE_SHOT_SERVER = `const server = require('net').createServer(socket => { socket.destroy(); server.close(); }).listen(0, '127.0.0.1', function () { console.log(this.address().port, process.pid); });`;
// Starts an HTTP answer and sends one more header byte every 100 ms without finishing it.
const TRICKLING_SERVER = `require('net').createServer(socket => { socket.write('HTTP/1.1 200 OK\\r\\nX-Slow: '); setInterval(() => socket.write('a'), 100).unref(); socket.on('error', () => {}); }).listen(0, '127.0.0.1', function () { console.log(this.address().port, process.pid); });`;
const NOT_PANE = 2_147_483_000;

const children: ChildProcess[] = [];
const testListeners = new Map<number, { pid: number; address?: string; family?: 'ipv4' | 'ipv6' }>();
async function readTestSockets(
  readDiscovery: typeof readListeningSockets = readListeningSockets,
  readOccupancy: typeof readLocalPortOccupancy = readLocalPortOccupancy,
): Promise<SocketRead> {
  const result = await readDiscovery();
  if (!result.complete) return result;
  const occupancy = await readOccupancy();
  if (!occupancy.complete) return occupancy;
  const sockets = result.sockets.filter(socket => testListeners.has(socket.port));
  for (const [port, expected] of testListeners) {
    const observed = sockets.filter(socket => socket.port === port);
    const occupied = occupancy.sockets.filter(socket => socket.port === port);
    if (observed.length === 0 && occupied.length === 0) continue;
    if (observed.length !== 1 || occupied.length !== 1 ||
        observed[0].pid !== expected.pid || occupied[0].pid !== expected.pid ||
        observed[0].address !== occupied[0].address || observed[0].family !== occupied[0].family ||
        (expected.address && (observed[0].address !== expected.address || observed[0].family !== expected.family))) {
      return { complete: false, sockets: [], reason: `Port ${port} has a listener outside this test.` };
    }
  }
  return { complete: true, sockets };
}
const grandchildren: number[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  testListeners.clear();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of grandchildren.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

async function startListener(source: string, stdin: 'ignore' | 'pipe' = 'ignore', executable = process.execPath): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(executable, ['-e', source], { stdio: [stdin, 'pipe', 'inherit'] });
  children.push(child);
  const { port, pid } = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => {
      const match = /^(\d+) (\d+)/u.exec(chunk.toString());
      if (!match) reject(new Error(`Listener did not report its port and owner.`));
      else resolve({ port: Number(match[1]), pid: Number(match[2]) });
    });
  });
  testListeners.set(port, { pid, address: '127.0.0.1', family: 'ipv4' });
  return { child, port };
}

/**
 * `nc -l`, or on Windows, which ships no nc, node copied to ncat.exe: there
 * netstat names no program and the process table supplies the name.
 */
async function startOneShotListener(): Promise<{ child: ChildProcess; port: number; name: string }> {
  if (process.platform === 'win32') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ports-'));
    const ncat = path.join(dir, 'ncat.exe');
    await fs.copyFile(process.execPath, ncat);
    const listener = await startListener(ONE_SHOT_SERVER, 'ignore', ncat);
    listener.child.once('exit', () => void fs.rm(dir, { recursive: true, force: true }));
    return { ...listener, name: 'ncat' };
  }
  const port = await freePort();
  const child = spawn('nc', ['-l', String(port)], { stdio: 'ignore' });
  children.push(child);
  testListeners.set(port, { pid: child.pid ?? -1 });
  return { child, port, name: 'nc' };
}

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  // SAFETY: a TCP server listening on a port reports an AddressInfo.
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

// Each read runs lsof, ss or PowerShell, which takes seconds on a busy CI runner.
describe('listening port monitor', { timeout: 30_000 }, () => {
  it('lists a web server started from a Pane terminal under that Pane, and drops it once it stops', async () => {
    // The terminal's shell starts the server, as a user typing `npm run dev` would.
    const { child: shell, port } = await startListener(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HTTP_SERVER)}], { stdio: 'inherit' });`);
    const monitor = createListeningPortMonitor({
      readSockets: readTestSockets,
      // Pane is an ancestor too; the nearer terminal decides.
      panePid: process.pid,
      terminalPanes: () => [{ pid: shell.pid ?? -1, sessionId: 'session-1', paneName: 'quick wins' }],
    });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    if (listed?.pid) grandchildren.push(listed.pid);
    expect(listed).toMatchObject({
      port,
      process: 'node',
      group: 'pane-terminal',
      kind: 'web',
      sessionId: 'session-1',
      paneName: 'quick wins',
    });
    expect(listed?.pid).not.toBe(shell.pid);

    process.kill(listed?.pid ?? -1, 'SIGKILL');
    await exited(shell);
    expect((await monitor.refresh()).ports.some(entry => entry.port === port)).toBe(false);
  });

  it('relabels a slow server as web once it answers in time', async () => {
    // Holds every answer until told to go, like a dev server compiling its first page.
    const { child, port } = await startListener(`let ready = false; const waiting = []; process.stdin.once('data', () => { ready = true; waiting.splice(0).forEach(res => res.end('ok')); }); require('http').createServer((_, res) => ready ? res.end('ok') : waiting.push(res)).listen(0, '127.0.0.1', function () { console.log(this.address().port, process.pid); });`, 'pipe');
    const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: NOT_PANE, terminalPanes: () => [] });

    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('tcp');
    child.stdin?.write('go\n');
    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('web');
  });

  it('shows a renamed Pane under its new name', async () => {
    const { child, port } = await startListener(HTTP_SERVER);
    let paneName = 'quick wins';
    const monitor = createListeningPortMonitor({
      readSockets: readTestSockets,
      panePid: NOT_PANE,
      terminalPanes: () => [{ pid: child.pid ?? -1, sessionId: 'session-1', paneName }],
    });
    await monitor.refresh();

    paneName = 'docs pass';
    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.paneName).toBe('docs pass');
  });

  it('labels a port that does not answer HTTP as tcp, under Other apps', async () => {
    const { port } = await startListener(SILENT_TCP_SERVER);
    const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: NOT_PANE, terminalPanes: () => [] });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toMatchObject({ port, group: 'other', kind: 'tcp', process: 'node' });
  });

  it('lists a one-shot listener like nc as tcp without connecting to it', async () => {
    const { child, port, name } = await startOneShotListener();
    const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: NOT_PANE, terminalPanes: () => [] });

    let listed;
    for (let attempt = 0; attempt < 20 && !listed; attempt++) {
      listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
      if (!listed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(listed).toMatchObject({ port, kind: 'tcp', process: name });
    // The listener exits after its first connection, so a probe would end it.
    expect(child.exitCode).toBeNull();
    expect((await monitor.refresh()).ports.some(entry => entry.port === port)).toBe(true);
  });

  it('labels a port that trickles an unfinished answer as tcp within the probe deadline', async () => {
    const { port } = await startListener(TRICKLING_SERVER);
    const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: NOT_PANE, terminalPanes: () => [] });

    expect((await monitor.refresh()).ports.find(entry => entry.port === port)?.kind).toBe('tcp');
  });

  it("puts ports opened by Pane's own process tree under Pane", async () => {
    const { port } = await startListener(HTTP_SERVER);
    const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: process.pid, terminalPanes: () => [] });

    const listed = (await monitor.refresh()).ports.find(entry => entry.port === port);
    expect(listed).toMatchObject({ port, group: 'pane', kind: 'web' });
  });

  it('tells listeners when a port appears', async () => {
    const seen: number[][] = [];
    const monitor = createListeningPortMonitor({
      readSockets: readTestSockets,
      panePid: NOT_PANE,
      terminalPanes: () => [],
      onChange: snapshot => seen.push(snapshot.ports.map(entry => entry.port)),
    });
    await monitor.refresh();

    const { port } = await startListener(HTTP_SERVER);
    await monitor.refresh();

    expect(seen.at(-1)).toContain(port);
  });
});

describe('socket read results', () => {
  it.each([
    { occupied: [{ port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: null, process: '' }] },
    { occupied: [{ port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: 43, process: 'other' }] },
    { occupied: [
      { port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: 42, process: 'node' },
      { port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: null, process: '' },
    ] },
    { occupied: [
      { port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: 42, process: 'node' },
      { port: 3000, address: '127.0.0.1', family: 'ipv4' as const, pid: 42, process: 'node' },
    ] },
  ])('refuses to probe a controlled endpoint with unknown or duplicate occupancy', async ({ occupied }) => {
    vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Unexpected probe'); });
    testListeners.set(3000, { pid: 42, address: '127.0.0.1', family: 'ipv4' });
    const monitor = createListeningPortMonitor({
      terminalPanes: () => [],
      readSockets: () => readTestSockets(
        async () => ({ complete: true, sockets: [{ port: 3000, address: '127.0.0.1', family: 'ipv4', pid: 42, process: 'node' }] }),
        async () => ({ complete: true, sockets: occupied }),
      ),
    });
    await expect(monitor.refresh()).rejects.toThrow('outside this test');
  });
  it('refuses to probe a same-port listener owned by another process on the other loopback family', async () => {
    const { port } = await startListener(HTTP_SERVER);
    let foreignConnections = 0;
    const foreign = net.createServer(socket => { foreignConnections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen({ port, host: '::1', ipv6Only: true }, resolve);
    });
    try {
      const monitor = createListeningPortMonitor({ readSockets: readTestSockets, panePid: NOT_PANE, terminalPanes: () => [] });
      await expect(monitor.refresh()).rejects.toThrow();
      expect(foreignConnections).toBe(0);
    } finally {
      await new Promise<void>(resolve => foreign.close(() => resolve()));
    }
  });
  it('deduplicates display ports after the reader preserves all rows', async () => {
    const monitor = createListeningPortMonitor({
      terminalPanes: () => [],
      readSockets: async () => ({ complete: true, sockets: [
        { port: 3000, address: '*', family: 'ipv4', pid: null, process: 'nc' },
        { port: 3000, address: '::1', family: 'ipv6', pid: null, process: 'ncat' },
      ] }),
    });
    const snapshot = await monitor.refresh();
    expect(snapshot.ports).toEqual([{ port: 3000, pid: null, process: 'nc', group: 'system', kind: 'tcp' }]);
  });
  it('rejects an incomplete read and retains the previous snapshot', async () => {
    let result: SocketRead = { complete: true, sockets: [
      { port: 3000, address: '*', family: 'ipv4', pid: null, process: 'nc' },
    ] };
    const monitor = createListeningPortMonitor({ terminalPanes: () => [], readSockets: async () => result });
    const snapshot = await monitor.refresh();
    result = { complete: false, sockets: [], reason: 'table changed during read' };
    await expect(monitor.refresh()).rejects.toThrow('table changed during read');
    expect(monitor.snapshot()).toEqual(snapshot);
  });
});
