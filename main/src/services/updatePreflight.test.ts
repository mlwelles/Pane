import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUpdateDirectoryWritable } from '../../../packages/runpane/src/updatePreflight';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
describe('update directory permissions', () => {
  it('proves create, write, rename and cleanup without leaving a probe', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-preflight-'));
    directories.push(directory);
    assertUpdateDirectoryWritable(directory);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
  it('rejects a Windows-style ACL denial even when access would report writable', () => {
    vi.spyOn(fs, 'accessSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw Object.assign(new Error('Access is denied'), { code: 'EACCES' }); });
    expect(() => assertUpdateDirectoryWritable('owned-install')).toThrow(expect.objectContaining({
      code: 'ERR_UPDATE_PREFLIGHT',
      next: expect.stringContaining('Pane has not been stopped'),
    }));
  });
});

describe('snapshot capacity before downtime', () => {
  it('counts exclusively locked live Windows profile files but refuses ACL denial', async () => {
    const { assertUpdateCapacity } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const profile = path.join(directory, 'profile');
    const data = path.join(directory, 'data');
    const install = path.join(directory, 'install');
    for (const folder of [profile, data, install]) fs.mkdirSync(folder);
    const cookies = path.join(profile, 'Cookies');
    fs.writeFileSync(cookies, 'live database');
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const open = fs.openSync;
    let code = 'EBUSY';
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (args[0] === cookies) throw Object.assign(new Error('File unavailable'), { code });
      return open(...args);
    });
    expect(() => assertUpdateCapacity(data, { paneDir: data, userData: profile }, install)).not.toThrow();
    code = 'EACCES';
    expect(() => assertUpdateCapacity(data, { paneDir: data, userData: profile }, install)).toThrow('File unavailable');
    code = 'EBUSY';
    expect(() => assertUpdateCapacity(profile, { paneDir: profile, userData: data }, install)).toThrow('File unavailable');
  });

  it('rejects a snapshot that exceeds actual available capacity', async () => {
    const { assertUpdateCapacity } = await import('../../../packages/runpane/src/updateCapacity');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-capacity-'));
    directories.push(directory);
    const disk = fs.statfsSync(directory);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...disk, bavail: 1, bsize: 4096 });
    expect(() => assertUpdateCapacity(directory, { paneDir: directory, userData: directory }, directory)).toThrow(expect.objectContaining({ code: 'ERR_UPDATE_DISK_SPACE' }));
  });
});
