import childProcess from 'child_process';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseLsofResult, parseDarwinNetstatResult, parseSsResult, parseWindowsNetstatResult,
  readListeningSockets, readLocalPortOccupancy,
} from './listeningSockets';

const result = (stdout: string, stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode });
const header = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address Foreign Address (state)\n';
const lsof = 'p42\ncnode\nf10\ntIPv4\nn127.0.0.1:3000\n';
const row = (local: string, proto = 'tcp4', state = 'LISTEN', remote = '*.*') => `${proto} 0 0 ${local} ${remote} ${state}\n`;
afterEach(() => vi.restoreAllMocks());

describe('socket fixtures', () => {
  it('retains every endpoint and owner on the same port', () => {
    expect(parseLsofResult(result(lsof + 'f11\ntIPv6\nn[::1]:3000\np43\ncother\nf9\ntIPv4\nn*:3000\n'))).toEqual({
      complete: true, sockets: [
        { address: '127.0.0.1', family: 'ipv4', port: 3000, pid: 42, process: 'node' },
        { address: '::1', family: 'ipv6', port: 3000, pid: 42, process: 'node' },
        { address: '*', family: 'ipv4', port: 3000, pid: 43, process: 'other' },
      ],
    });
  });
  it('keeps ambiguous empty lsof output unavailable', () => {
    expect(parseLsofResult(result('', '', 1))).toMatchObject({ complete: false, sockets: [] });
  });
  it.each(['n127.0.0.1:bad', 'n127.0.0.1:65536', 'ninvalid:3000', 'n127.0.0.1:3000junk', 'n[::bad::]:3000', ''])('rejects malformed or truncated lsof socket %s', endpoint => {
    expect(parseLsofResult(result('p42\ncnode\nf10\ntIPv4\n' + endpoint + '\n')).complete).toBe(false);
  });
  it.each([result(lsof, 'warning'), result(lsof, '', 1)])('retains evidence but rejects unsuccessful lsof reads', input => {
    expect(parseLsofResult(input)).toMatchObject({ complete: false, sockets: [{ port: 3000 }] });
  });
  it.each([lsof + 'p43\ncother\n', lsof + 'p43\n'])('rejects truncated lsof process records', stdout => {
    expect(parseLsofResult(result(stdout)).complete).toBe(false);
  });
  it('keeps all Linux users and unowned listeners', () => {
    const parsed = parseSsResult(result('LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=42,fd=1),("other",pid=43,fd=2))\nLISTEN 0 128 [::]:3000 [::]:*\n'));
    expect(parsed.complete).toBe(true);
    expect(parsed.sockets.map(socket => socket.pid)).toEqual([42, 43, null]);
    expect(parsed.sockets.map(socket => socket.family)).toEqual(['ipv4', 'ipv4', 'ipv6']);
  });
  it('normalizes an interface-scoped IPv4 listener reported by Linux', () => {
    expect(parseSsResult(result('LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*\n'))).toEqual({
      complete: true,
      sockets: [{ address: '127.0.0.53', family: 'ipv4', port: 53, pid: null, process: '' }],
    });
  });
  it.each(['LISTEN 0 128 bad:3000 *:*', 'LISTEN 0', 'unexpected output', 'LISTEN 0 128 127.0.0.53%lo!:53 *:*', 'LISTEN 0 128 *:3000 *:* users:(("node",pid=bad,fd=1))'])('rejects unknown Linux rows: %s', line => {
    expect(parseSsResult(result(line)).complete).toBe(false);
  });
  it('accepts a successful empty Linux socket table', () => {
    expect(parseSsResult(result(''))).toEqual({ complete: true, sockets: [] });
  });
  it('validates Windows rows before filtering listeners', () => {
    expect(parseWindowsNetstatResult(result('Active Connections\nProto Local Address Foreign Address State PID\nTCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 42\nTCP [::]:3000 [::]:0 LISTENING 43\nTCP 127.0.0.1:5000 127.0.0.1:3000 ESTABLISHED 44\n')).sockets.map(socket => socket.pid)).toEqual([42, 43]);
    expect(parseWindowsNetstatResult(result('TCP 127.0.0.1:3000')).complete).toBe(false);
    expect(parseWindowsNetstatResult(result('TCP bad:3000 127.0.0.1:3000 ESTABLISHED 44')).complete).toBe(false);
  });
  it('accepts a recognized empty Windows table but rejects arbitrary or truncated output', () => {
    const heading = 'Active Connections\nProto Local Address Foreign Address State PID\n';
    expect(parseWindowsNetstatResult(result(heading))).toEqual({ complete: true, sockets: [] });
    for (const stdout of ['', 'The syntax of this command is incorrect.\n', 'Active Connections\n', heading + 'TCP 127.0.0.1:3000\n', heading + 'Active Connections\n']) {
      expect(parseWindowsNetstatResult(result(stdout)).complete, stdout).toBe(false);
    }
  });
  it('parses localized Windows table headings without using the translated TCP state', () => {
    const heading = 'Aktive Verbindungen\nProto Lokale Adresse Remoteadresse Status PID\n';
    expect(parseWindowsNetstatResult(result(heading))).toEqual({ complete: true, sockets: [] });
    expect(parseWindowsNetstatResult(result(heading + 'TCP 0.0.0.0:3000 0.0.0.0:0 ABHÖREN 42\n'))).toEqual({
      complete: true,
      sockets: [{ address: '0.0.0.0', family: 'ipv4', port: 3000, pid: 42, process: '' }],
    });
  });
  it('accepts a Unicode protocol heading with validated TCP rows', () => {
    const heading = '活动连接\n协议 本地地址 外部地址 状态 PID\n';
    expect(parseWindowsNetstatResult(result(heading + 'TCP 0.0.0.0:3000 0.0.0.0:0 LISTENING 42\n'))).toEqual({
      complete: true,
      sockets: [{ address: '0.0.0.0', family: 'ipv4', port: 3000, pid: 42, process: '' }],
    });
    expect(parseWindowsNetstatResult(result(heading)).complete).toBe(false);
    expect(parseWindowsNetstatResult(result('活动连接\n协议  本地地址  外部地址  状态  PID\n'))).toEqual({ complete: true, sockets: [] });
    expect(parseWindowsNetstatResult(result('Active Connections\nSomething went wrong while reading PID\n')).complete).toBe(false);
  });
  it('retains Darwin wildcard, IPv4, IPv6 and dual-stack endpoints', () => {
    const parsed = parseDarwinNetstatResult(result(header + row('*.3000') + row('127.0.0.1.3000') + row('::1.3000', 'tcp6') + row('*.3000', 'tcp46')));
    expect(parsed.complete).toBe(true);
    expect(parsed.sockets.map(socket => [socket.address, socket.family])).toEqual([['*', 'ipv4'], ['127.0.0.1', 'ipv4'], ['::1', 'ipv6'], ['*', 'ipv6']]);
  });
  it('accepts a recognized empty table and validates non-listening rows', () => {
    expect(parseDarwinNetstatResult(result(header + row('127.0.0.1.5000', 'tcp4', 'ESTABLISHED', '127.0.0.1.3000')))).toEqual({ complete: true, sockets: [] });
    expect(parseDarwinNetstatResult(result(header))).toEqual({ complete: true, sockets: [] });
    expect(parseDarwinNetstatResult(result('')).complete).toBe(false);
    expect(parseDarwinNetstatResult(result(header + row('invalid.5000', 'tcp4', 'ESTABLISHED'))).complete).toBe(false);
  });
  it.each(['Some tcp sockets may have been deleted.', 'Some tcp sockets may have been created.', 'Some tcp sockets may have been created or deleted', 'tcp4 0 0 *.3000', 'tcp7 0 0 *.3000 *.* LISTEN', 'unexpected output'])('rejects unstable or unsupported Darwin output: %s', notice => {
    expect(parseDarwinNetstatResult(result(header + notice)).complete).toBe(false);
  });
  it.each([result(header, 'warning'), result(header, '', 1)])('rejects unsuccessful Darwin commands', input => {
    expect(parseDarwinNetstatResult(input).complete).toBe(false);
  });
});

function mockCommands(outputs: Record<string, { stdout: string; stderr: string; exitCode: number } | Error>) {
  vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
    const command = String(args[0]);
    // SAFETY: the reader calls execFile with its completion callback last.
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    const output = outputs[command];
    if (!output) throw new Error(`Unexpected command: ${command}`);
    if (output instanceof Error) callback(output, '', '');
    else callback(output.exitCode ? Object.assign(new Error('exit'), { code: output.exitCode }) : null, output.stdout, output.stderr);
    return new childProcess.ChildProcess();
  });
}

describe('command failures', () => {
  it.each(['ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT'])('does not treat %s as an empty table', async code => {
    const failure = Object.assign(new Error(code), { code });
    mockCommands({ lsof: failure, ss: failure, netstat: failure, '/usr/sbin/netstat': failure });
    expect((await readListeningSockets()).complete).toBe(false);
    expect((await readLocalPortOccupancy()).complete).toBe(false);
  });
  it('requires both Windows address-family reads', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    let count = 0;
    vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      // SAFETY: the reader calls execFile with its completion callback last.
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(count++ === 0 ? null : new Error('unavailable'), 'TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 42', '');
      return new childProcess.ChildProcess();
    });
    expect((await readListeningSockets()).complete).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('Linux live socket reads', () => {
  it('attributes controlled IPv4 and IPv6 listeners without contacting them', async () => {
    const servers: net.Server[] = [];
    let connections = 0;
    try {
      for (const host of ['0.0.0.0', '::', '127.0.0.1', '::1']) {
        const server = net.createServer(socket => { connections++; socket.destroy(); });
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port: 0, host, ipv6Only: true }, resolve);
        });
      }
      const discovery = await readListeningSockets();
      const occupancy = await readLocalPortOccupancy();
      expect(discovery.complete, !discovery.complete ? discovery.reason : '').toBe(true);
      expect(occupancy.complete, !occupancy.complete ? occupancy.reason : '').toBe(true);
      for (const server of servers) {
        // SAFETY: each server completed TCP listen, so its address is an AddressInfo.
        const address = server.address() as net.AddressInfo;
        const expected = { address: address.address, family: address.family === 'IPv4' ? 'ipv4' : 'ipv6', port: address.port, pid: process.pid };
        const matches = (socket: { port: number; address: string; family: string }) => socket.port === address.port && socket.address === address.address && socket.family === expected.family;
        expect(discovery.sockets.filter(matches)).toEqual([expect.objectContaining(expected)]);
        expect(occupancy.sockets.filter(matches)).toEqual([expect.objectContaining(expected)]);
      }
      expect(connections).toBe(0);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });

  it('does not accept a partial socket table after a command warning', async () => {
    mockCommands({ ss: result('LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=42,fd=1))\n', 'warning') });
    expect(await readLocalPortOccupancy()).toMatchObject({ complete: false, sockets: [{ port: 3000 }] });
  });
});

describe.skipIf(process.platform !== 'darwin')('Darwin occupancy attribution', () => {
  it('publishes an empty discovery table only when netstat corroborates a bare lsof no-match', async () => {
    mockCommands({ lsof: result('', '', 1), '/usr/sbin/netstat': result(header) });
    expect(await readListeningSockets()).toEqual({ complete: true, sockets: [] });
  });
  it('retains the previous discovery snapshot when netstat still sees a listener', async () => {
    mockCommands({ lsof: result('', '', 1), '/usr/sbin/netstat': result(header + row('*.3000')) });
    expect(await readListeningSockets()).toMatchObject({ complete: false, sockets: [] });
  });
  it('retains the previous discovery snapshot when netstat cannot verify an empty table', async () => {
    mockCommands({ lsof: result('', '', 1), '/usr/sbin/netstat': result(header, 'warning') });
    expect(await readListeningSockets()).toMatchObject({ complete: false, sockets: [] });
  });
  it.each([result('', 'warning', 1), result(lsof, '', 1)])('does not corroborate other failed lsof reads', async output => {
    mockCommands({ lsof: output });
    expect((await readListeningSockets()).complete).toBe(false);
  });
  it('keeps lsof-invisible listeners occupied', async () => {
    mockCommands({ '/usr/sbin/netstat': result(header + row('*.3000')), lsof: result('', '', 1) });
    expect(await readLocalPortOccupancy()).toEqual({ complete: true, sockets: [{ address: '*', family: 'ipv4', port: 3000, pid: null, process: '' }] });
  });
  it('attributes only an unambiguous exact endpoint', async () => {
    mockCommands({ '/usr/sbin/netstat': result(header + row('127.0.0.1.3000') + row('*.3000', 'tcp6')), lsof: result(lsof) });
    expect((await readLocalPortOccupancy()).sockets.map(socket => socket.pid)).toEqual([42, null]);
  });
  it.each([lsof + lsof.replace('p42', 'p43'), lsof + lsof, lsof.replace('127.0.0.1', '*')])('does not attribute ambiguous or non-exact owners', async owners => {
    mockCommands({ '/usr/sbin/netstat': result(header + row('127.0.0.1.3000')), lsof: result(owners) });
    expect((await readLocalPortOccupancy()).sockets.find(socket => socket.address === '127.0.0.1')?.pid).toBeNull();
  });
  it('does not attribute from incomplete lsof output', async () => {
    mockCommands({ '/usr/sbin/netstat': result(header + row('127.0.0.1.3000')), lsof: result(lsof, 'warning') });
    expect((await readLocalPortOccupancy()).sockets[0].pid).toBeNull();
  });
  it('retains lsof-only evidence of a listener created between reads', async () => {
    mockCommands({ '/usr/sbin/netstat': result(header), lsof: result(lsof) });
    expect((await readLocalPortOccupancy()).sockets).toEqual([{ address: '127.0.0.1', family: 'ipv4', port: 3000, pid: null, process: '' }]);
  });
  it('reads controlled wildcard and IPv6 listeners without contacting them', async () => {
    const servers: net.Server[] = [];
    let connections = 0;
    try {
      for (const host of ['0.0.0.0', '::', '127.0.0.1', '::1']) {
        const server = net.createServer(socket => { connections++; socket.destroy(); });
        servers.push(server);
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host, ipv6Only: true }, resolve); });
      }
      const occupancy = await readLocalPortOccupancy();
      expect(occupancy.complete, !occupancy.complete ? occupancy.reason : '').toBe(true);
      for (const server of servers) {
        // SAFETY: these servers have completed TCP listen, so address is an AddressInfo.
        const address = server.address() as net.AddressInfo;
        expect(occupancy.sockets.filter(socket => socket.port === address.port)).toEqual([
          expect.objectContaining({ pid: process.pid, address: address.address === '0.0.0.0' || address.address === '::' ? '*' : address.address }),
        ]);
      }
      expect(connections).toBe(0);
    } finally {
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
});
