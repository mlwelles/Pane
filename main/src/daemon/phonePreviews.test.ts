import childProcess from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneWorkspaceHostController } from './workspaceHost';
import { PhonePreviewHost } from './phonePreviews';
import { createListeningPortMonitor } from '../services/listeningPorts';
import { createFakeTailscale, TAILNET_B } from './__fixtures__/fakeTailscale';
import { hashWorkspacePassword } from './workspacePassword';
import type { RemoteSetupCommandRunner } from './remote-setup-command';
import type { WorkspaceAccessConfig } from '../../../shared/types/workspaceAccess';
import type { ListeningPort, ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const NO_FILES = {
  readBundleFile: async () => { throw new Error('no bundles'); },
  resolveMediaPath: async () => { throw new Error('no media'); },
};

function port(number: number, kind: ListeningPort['kind'] = 'web'): ListeningPort {
  return { port: number, pid: 100 + number, process: 'node', group: 'pane-terminal', kind };
}

function snapshot(ports: ListeningPort[]): ListeningPortsSnapshot {
  return { host: 'parsa-devbox', ports };
}

async function startHost(
  tailscale: ReturnType<typeof createFakeTailscale>,
  options: { paneDir?: string; enabled?: boolean; workspaces?: WorkspaceAccessConfig; onChange?: () => void; run?: RemoteSetupCommandRunner } = {},
) {
  const workspace = new PaneWorkspaceHostController(
    new PaneCommandRegistry(),
    { getConfig: () => ({ workspaces: options.workspaces ?? { enabled: options.enabled ?? true } }), on: () => ({}), off: () => ({}) },
    true,
    tailscale.run,
  );
  const previews = new PhonePreviewHost({
    workspace,
    paneDir: options.paneDir ?? '/Users/owner/.pane',
    files: NO_FILES,
    run: options.run ?? tailscale.run,
    onChange: options.onChange,
  });
  await workspace.start();
  await previews.start();
  const stop = async () => {
    await previews.shutdown();
    await workspace.shutdown();
  };
  cleanups.push(stop);
  return { workspace, previews, stop };
}

/** The `Proxy` target of every web handler in the fake Serve config, by HTTPS port. */
async function serveTargets(tailscale: ReturnType<typeof createFakeTailscale>): Promise<Record<string, string>> {
  const status = await tailscale.run('tailscale', ['serve', 'status', '--json']);
  // SAFETY: the fake Tailscale writes its Serve config in this shape.
  const web = (JSON.parse(status.stdout) as { Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }> }).Web ?? {};
  return Object.fromEntries(Object.entries(web).map(([key, value]) => [key.split(':').pop(), value.Handlers['/'].Proxy]));
}

/**
 * Requests a phone address the way Serve does: the visitor's path appended to the handler's
 * target, with the visitor's login signed in.
 */
async function visit(targets: Record<string, string>, phoneUrl: string, path = '/', login = 'owner@example.com') {
  const target = new URL(`${targets[new URL(phoneUrl).port]}${path}`);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { host: new URL(phoneUrl).host, 'tailscale-user-login': login },
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('phone previews', () => {
  it.skipIf(process.platform !== 'darwin')('revokes an explicit grant when discovery publishes an empty listener snapshot', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((_request, response) => response.end('opened'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let listening = true;
    cleanups.push(async () => {
      if (listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    // SAFETY: this server has completed a TCP listen.
    const address = upstream.address() as AddressInfo;
    let lsofReads = 0;
    const commands = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: unknown[]) => {
      const command = String(args[0]);
      // SAFETY: the socket reader passes the completion callback last.
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      if (command === 'lsof') {
        lsofReads++;
        if (lsofReads === 1) callback(null, `p${process.pid}\ncnode\nf10\ntIPv4\nn127.0.0.1:${address.port}\n`, '');
        else callback(Object.assign(new Error('no matches'), { code: 1 }), '', '');
      } else if (command === '/usr/sbin/netstat') {
        callback(null, 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address Foreign Address (state)\n', '');
      } else throw new Error(`Unexpected socket command: ${command}`);
      return new childProcess.ChildProcess();
    });
    cleanups.push(async () => { commands.mockRestore(); });
    const { previews } = await startHost(tailscale);
    const published: ListeningPortsSnapshot[] = [];
    const updates: Promise<void>[] = [];
    const monitor = createListeningPortMonitor({
      mode: 'passive', terminalPanes: () => [], readProcessTable: async () => [],
      onChange(current) {
        published.push(current);
        updates.push(previews.update(current));
      },
    });
    cleanups.push(async () => { monitor.stop(); });

    await monitor.refresh();
    await Promise.all(updates);
    expect(monitor.snapshot().ports).toMatchObject([{ port: address.port, probeStatus: 'unchecked' }]);
    await previews.request(address.port);
    const phoneUrl = previews.decorate(monitor.snapshot()).ports[0].phoneUrl ?? '';
    const targets = await serveTargets(tailscale);
    expect((await visit(targets, phoneUrl)).body).toBe('opened');

    await new Promise<void>(resolve => upstream.close(() => resolve()));
    listening = false;
    await monitor.refresh();
    await Promise.all(updates);
    expect(published.at(-1)?.ports).toEqual([]);
    expect(monitor.snapshot().ports).toEqual([]);
    expect((await visit(targets, phoneUrl)).status).toBe(404);
    expect(Object.values(await serveTargets(tailscale)).some(target => target.endsWith(`/${address.port}`))).toBe(false);
  });

  it('creates no mapping or probe until an unchecked port is explicitly requested', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((_request, response) => response.end('opened'));
    let connections = 0;
    upstream.on('connection', () => { connections += 1; });
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a listening TCP server reports an AddressInfo.
    const address = upstream.address() as AddressInfo;
    const unchecked = { ...port(address.port, 'tcp'), probeStatus: 'unchecked' as const };
    const { previews } = await startHost(tailscale);
    const before = await serveTargets(tailscale);
    const writes = tailscale.serveCalls().length;

    await previews.update(snapshot([unchecked]));

    expect(previews.decorate(snapshot([unchecked])).ports[0].phoneUrl).toBeUndefined();
    expect(await serveTargets(tailscale)).toEqual(before);
    expect(tailscale.serveCalls()).toHaveLength(writes);
    expect(connections).toBe(0);
    await previews.request(address.port);
    const phoneUrl = previews.decorate(snapshot([unchecked])).ports[0].phoneUrl ?? '';
    expect(phoneUrl).toMatch(/^https:/u);
    expect(connections).toBe(0);
    expect((await visit(await serveTargets(tailscale), phoneUrl)).body).toBe('opened');
    expect(connections).toBe(1);
  });

  it('retains a web grant through unchecked and TCP classification and revokes it on disappearance', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((_request, response) => response.end('retained'));
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a listening TCP server reports an AddressInfo.
    const address = upstream.address() as AddressInfo;
    const web = port(address.port);
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([web]));
    await previews.request(web.port);
    const phoneUrl = previews.decorate(snapshot([web])).ports[0].phoneUrl;
    const targets = await serveTargets(tailscale);
    for (const entry of [{ ...web, kind: 'tcp' as const, probeStatus: 'unchecked' as const }, { ...web, kind: 'tcp' as const }]) {
      await previews.update(snapshot([entry]));
      expect(previews.decorate(snapshot([entry])).ports[0].phoneUrl).toBe(phoneUrl);
      expect((await visit(targets, phoneUrl ?? '')).body).toBe('retained');
    }
    await previews.update(snapshot([]));
    expect((await visit(targets, phoneUrl ?? '')).status).toBe(404);
    expect(Object.values(await serveTargets(tailscale)).some(target => target.endsWith(`/${web.port}`))).toBe(false);
    await previews.update(snapshot([web]));
    expect(previews.decorate(snapshot([web])).ports[0].phoneUrl).toBeUndefined();
    await previews.request(web.port);
    expect(previews.decorate(snapshot([web])).ports[0].phoneUrl).toMatch(/^https:/u);
  });

  it('revokes a phone preview when another process takes over the same port', async () => {
    const tailscale = createFakeTailscale();
    const web = port(5173);
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([web]));
    await previews.request(web.port);
    const phoneUrl = previews.decorate(snapshot([web])).ports[0].phoneUrl ?? '';
    const targets = await serveTargets(tailscale);

    const replacement = { ...web, pid: 9999, process: 'replacement', kind: 'tcp' as const, probeStatus: 'unchecked' as const };
    await previews.update(snapshot([replacement]));
    expect(previews.decorate(snapshot([replacement])).ports[0].phoneUrl).toBeUndefined();
    expect((await visit(targets, phoneUrl)).status).toBe(404);

    await previews.request(web.port);
    expect(previews.decorate(snapshot([replacement])).ports[0].phoneUrl).toMatch(/^https:/u);
  });

  it.each(['password', 'disabled'] as const)('revokes grants on %s denial and requires a fresh request after access returns', async denial => {
    const tailscale = createFakeTailscale();
    const workspaces: WorkspaceAccessConfig = { enabled: true };
    const { workspace, previews } = await startHost(tailscale, { workspaces });
    const current = snapshot([port(5173)]);
    await previews.update(current);
    await previews.request(5173);
    const phoneUrl = previews.decorate(current).ports[0].phoneUrl ?? '';
    const targets = await serveTargets(tailscale);
    expect((await visit(targets, phoneUrl, '/', 'stranger@example.com')).status).toBe(403);

    if (denial === 'password') workspaces.password = hashWorkspacePassword('test password');
    else workspaces.enabled = false;
    expect((await visit(targets, phoneUrl)).status).toBe(403);
    expect(previews.decorate(current).ports[0].phoneUrl).toBeUndefined();
    await workspace.sync();
    await previews.update(current);
    expect(Object.values(await serveTargets(tailscale)).some(target => target.endsWith('/5173'))).toBe(false);
    await previews.request(5173);
    delete workspaces.password;
    workspaces.enabled = true;
    await workspace.sync();
    await previews.update(current);
    expect(previews.decorate(current).ports[0].phoneUrl).toBeUndefined();
    await previews.request(5173);
    expect(previews.decorate(current).ports[0].phoneUrl).toMatch(/^https:/u);
  });

  it.each(['removed', 'password', 'disabled'] as const)('does not publish a handler if %s while Serve creation is pending', async denial => {
    const tailscale = createFakeTailscale();
    const workspaces: WorkspaceAccessConfig = { enabled: true };
    let entered!: () => void;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    const run: RemoteSetupCommandRunner = async (command, args, options) => {
      const result = await tailscale.run(command, args, options);
      if (args[0] === 'serve' && args.includes('--bg') && args.at(-1)?.endsWith('/5173')) {
        entered();
        await resumed;
      }
      return result;
    };
    const published: Array<string | undefined> = [];
    const current = snapshot([port(5173)]);
    const onChange = vi.fn();
    const { previews } = await startHost(tailscale, { workspaces, run, onChange });
    onChange.mockImplementation(() => { published.push(previews.decorate(current).ports[0].phoneUrl); });
    await previews.update(current);
    const opening = previews.request(5173);
    await pending;
    let removing: Promise<void> | undefined;
    if (denial === 'removed') removing = previews.update(snapshot([]));
    else if (denial === 'password') workspaces.password = hashWorkspacePassword('test password');
    else workspaces.enabled = false;
    release();
    await opening;
    await removing;
    expect(published.filter(Boolean)).toEqual([]);
    expect(previews.decorate(current).ports[0].phoneUrl).toBeUndefined();
    expect(Object.values(await serveTargets(tailscale)).some(target => target.endsWith('/5173'))).toBe(false);
  });

  it('preserves discovery, forwarding and phone metadata when decorating unchecked ports', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    const current: ListeningPortsSnapshot = {
      ...snapshot([{ ...port(5173, 'tcp'), probeStatus: 'unchecked', localPort: 55173,
        forwardingError: { code: 'PORT_FORWARDING_UNAVAILABLE', message: 'No local address', next: 'Retry' } }]),
      discoveryMode: 'passive',
    };
    await previews.update(current);
    await previews.request(5173);
    const decorated = previews.decorate(current);
    expect(decorated).toMatchObject(current);
    expect(decorated.phone).toMatchObject({ state: 'on', filesUrl: expect.stringMatching(/^https:/u) });
    expect(decorated.ports[0].phoneUrl).toMatch(/^https:/u);
    expect(previews.decorate(decorated)).toEqual(decorated);
  });

  it('gives a web port a phone address on this machine\'s tailnet name once a phone asks, and tcp ports none', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173), port(5432, 'tcp')]));
    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toBeUndefined();

    await previews.request(5173);
    await previews.request(5432);
    const decorated = previews.decorate(snapshot([port(5173), port(5432, 'tcp')]));

    const [web, tcp] = decorated.ports;
    expect(web.phoneUrl).toMatch(/^https:\/\/parsa-devbox\.taila5e94c\.ts\.net:\d+$/u);
    expect(tcp.phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'on', filesUrl: expect.stringMatching(/^https:\/\/parsa-devbox\.taila5e94c\.ts\.net:\d+$/u) });
    const servePort = new URL(web.phoneUrl ?? '').port;
    expect(servePort).not.toBe('5173');
    expect((await serveTargets(tailscale))[servePort]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pane-[0-9a-f]{8}\/[0-9a-f]+\/5173$/u);
  });

  it('routes a phone address through to the dev server', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((request, response) => response.end(`dev server saw ${request.url}`));
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a TCP server that is listening reports an AddressInfo.
    const devPort = (upstream.address() as AddressInfo).port;
    const { previews } = await startHost(tailscale);

    await previews.update(snapshot([port(devPort)]));
    await previews.request(devPort);
    const phoneUrl = previews.decorate(snapshot([port(devPort)])).ports[0].phoneUrl ?? '';
    const page = await visit(await serveTargets(tailscale), phoneUrl, '/app?x=1');

    expect(page.body).toBe('dev server saw /app?x=1');
  });

  it('removes a port\'s handler when the port stops listening', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173), port(3000)]));
    await previews.request(5173);
    await previews.request(3000);
    const before = await serveTargets(tailscale);

    await previews.update(snapshot([port(3000)]));

    const after = await serveTargets(tailscale);
    expect(Object.values(after).some(target => target.endsWith('/5173'))).toBe(false);
    expect(Object.values(after).filter(target => target.endsWith('/3000'))).toEqual(Object.values(before).filter(target => target.endsWith('/3000')));
    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toBeUndefined();
  });

  it('removes its own handlers on quit, and an earlier run\'s leftovers at launch, but no one else\'s', async () => {
    const tailscale = createFakeTailscale();
    await tailscale.run('tailscale', ['serve', '--bg', '--https=9999', 'http://127.0.0.1:9']);
    const other = await startHost(tailscale, { paneDir: '/Users/owner/.pane_test' });
    await other.previews.update(snapshot([port(4000)]));
    await other.previews.request(4000);
    const crashed = await startHost(tailscale);
    await crashed.previews.update(snapshot([port(5173)]));
    await crashed.previews.request(5173);
    const crashedTargets = Object.values(await serveTargets(tailscale)).filter(target => target.endsWith('/5173'));
    expect(crashedTargets).toHaveLength(1);
    cleanups.pop(); // Killed with kill -9: no shutdown.

    const relaunched = await startHost(tailscale);
    const afterLaunch = Object.values(await serveTargets(tailscale));
    expect(afterLaunch).not.toContain(crashedTargets[0]);
    expect(afterLaunch).toContain('http://127.0.0.1:9');
    expect(afterLaunch.some(target => target.endsWith('/4000'))).toBe(true);

    await relaunched.previews.update(snapshot([port(5173)]));
    await relaunched.previews.request(5173);
    await relaunched.stop();
    cleanups.pop();

    const afterQuit = await serveTargets(tailscale);
    expect(Object.values(afterQuit).some(target => target.endsWith('/5173'))).toBe(false);
    expect(afterQuit['9999']).toBe('http://127.0.0.1:9');
    expect(Object.values(afterQuit).some(target => target.endsWith('/4000'))).toBe(true);
  });

  it('retries a Serve change that another client\'s write rejected', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);

    await previews.update(snapshot([port(5173)]));
    tailscale.busyServe(2);
    await previews.request(5173);

    const phoneUrl = previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '';
    expect((await serveTargets(tailscale))[new URL(phoneUrl).port]).toMatch(/\/5173$/u);
  });

  it('publishes the new phone addresses after the host switches tailnets', async () => {
    const tailscale = createFakeTailscale();
    let published = 0;
    const { workspace, previews } = await startHost(tailscale, { onChange: () => { published += 1; } });
    await previews.update(snapshot([port(5173)]));
    await previews.request(5173);
    const before = published;

    tailscale.switchTailnet(TAILNET_B);
    await workspace.sync();
    await previews.update(snapshot([port(5173)]));

    expect(published).toBeGreaterThan(before);
    expect(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl).toContain('.tail3c2c57.ts.net:');
  });

  it('stops forwarding a port the moment it stops listening, even when Serve cannot be updated', async () => {
    const tailscale = createFakeTailscale();
    const upstream = http.createServer((_request, response) => response.end('still here'));
    await new Promise<void>(resolve => upstream.listen(0, 'localhost', resolve));
    cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    // SAFETY: a TCP server that is listening reports an AddressInfo.
    const devPort = (upstream.address() as AddressInfo).port;
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(devPort)]));
    await previews.request(devPort);
    const phoneUrl = previews.decorate(snapshot([port(devPort)])).ports[0].phoneUrl ?? '';

    const targets = await serveTargets(tailscale);

    tailscale.failServeStatus('tailscaled is restarting');
    await previews.update(snapshot([]));

    expect((await visit(targets, phoneUrl)).status).toBe(404);
  });

  it('opens no phone pages on a password-protected machine, since a frame cannot send the password', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale, { workspaces: { enabled: true, password: hashWorkspacePassword('correct horse') } });

    await previews.update(snapshot([port(5173)]));
    await previews.request(5173);

    const decorated = previews.decorate(snapshot([port(5173)]));
    expect(decorated.ports[0].phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'off', reason: expect.stringContaining('password') });
    expect(Object.values(await serveTargets(tailscale)).some(target => target.includes('/pane-'))).toBe(false);
  });

  it('removes only its own mount when someone added another route on the same Serve port', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173)]));
    await previews.request(5173);
    const servePort = new URL(previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '').port;
    await tailscale.run('tailscale', ['serve', '--bg', `--https=${servePort}`, '--set-path=/docs', 'http://127.0.0.1:8']);

    await previews.update(snapshot([]));

    // SAFETY: the fake Tailscale writes its Serve config in this shape.
    const status = JSON.parse((await tailscale.run('tailscale', ['serve', 'status', '--json'])).stdout) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
    expect(status.Web[`${tailscale.dnsName()}:${servePort}`].Handlers).toEqual({ '/docs': { Proxy: 'http://127.0.0.1:8' } });
  });

  it('gives two Pane instances asking at once different Serve ports', async () => {
    const tailscale = createFakeTailscale();
    const installed = await startHost(tailscale, { paneDir: '/Users/owner/.pane' });
    const dev = await startHost(tailscale, { paneDir: '/Users/owner/.pane_dev' });

    await installed.previews.update(snapshot([port(5173)]));
    await dev.previews.update(snapshot([port(3000)]));

    await Promise.all([installed.previews.request(5173), dev.previews.request(3000)]);

    const installedUrl = installed.previews.decorate(snapshot([port(5173)])).ports[0].phoneUrl ?? '';
    const devUrl = dev.previews.decorate(snapshot([port(3000)])).ports[0].phoneUrl ?? '';
    const targets = await serveTargets(tailscale);
    expect(installedUrl).not.toBe(devUrl);
    expect(targets[new URL(installedUrl).port]).toMatch(/\/5173$/u);
    expect(targets[new URL(devUrl).port]).toMatch(/\/3000$/u);
  });

  it('quits within its budget while another Pane holds the Serve lock', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5173)]));
    await previews.request(5173);
    // Another Pane (this test process stands in for it) holds the machine-wide lock.
    const lock = path.join(os.tmpdir(), 'pane-tailscale-serve.lock');
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
    cleanups.push(() => fs.rm(lock, { recursive: true, force: true }));
    void previews.update(snapshot([port(5173), port(3000)]));
    await new Promise(resolve => setTimeout(resolve, 200)); // that update is now waiting for the lock

    const started = Date.now();
    await previews.shutdown();

    expect(Date.now() - started).toBeLessThan(7_000);
  }, 15_000);

  it('adds no handler for a port a phone asks about that is not a detected web port', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale);
    await previews.update(snapshot([port(5432, 'tcp')]));

    await previews.request(5432);
    await previews.request(8080);

    expect(Object.values(await serveTargets(tailscale)).filter(target => target.includes('/pane-') && !target.endsWith('/files'))).toEqual([]);
  });

  it('says why phones cannot open pages while workspaces are off', async () => {
    const tailscale = createFakeTailscale();
    const { previews } = await startHost(tailscale, { enabled: false });

    await previews.update(snapshot([port(5173)]));
    await previews.request(5173);

    const decorated = previews.decorate(snapshot([port(5173)]));
    expect(decorated.ports[0].phoneUrl).toBeUndefined();
    expect(decorated.phone).toEqual({ state: 'off', reason: expect.stringContaining('turned off') });
    expect(await serveTargets(tailscale)).toEqual({});
  });
});
