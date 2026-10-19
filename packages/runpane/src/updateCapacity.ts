import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { RunpaneError } from './errors';

// Electron virtualizes app.asar as a directory. Capacity and snapshots concern
// physical files; the staged standalone Node helper has these semantics too.
// SAFETY: Electron's built-in original-fs exposes the unchanged Node fs API.
const fs: typeof nodeFs = process.versions.electron
  ? createRequire(__filename)('original-fs') as typeof nodeFs
  : nodeFs;

/** Live Chromium files may be exclusively locked until clean shutdown on Windows. */
function updateSnapshotBytes(source: string, excludeUpdates = false, liveProfile = false): number {
  let total = 0;
  for (const entry of fs.readdirSync(source)) {
    if ((excludeUpdates && entry === 'updates') || entry.startsWith('Singleton')) continue;
    const file = path.join(source, entry);
    const stat = fs.lstatSync(file);
    if (stat.isSocket()) continue;
    if (stat.isDirectory()) total += updateSnapshotBytes(file, false, liveProfile);
    else if (stat.isSymbolicLink()) { fs.readlinkSync(file); total += stat.size; }
    else if (stat.isFile()) {
      try { const fd = fs.openSync(file, 'r'); fs.closeSync(fd); }
      catch (error) {
        // A sharing violation is not an ACL denial. Count the physical size
        // now; the post-quiescence snapshot must read/copy it before install.
        if (!(liveProfile && process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EBUSY')) throw error;
      }
      total += stat.size;
    } else throw new RunpaneError('ERR_UPDATE_SNAPSHOT_ENTRY', `The recovery snapshot cannot copy ${file}. Pane remains running.`, 'Move the unsupported special file outside Pane data and retry.');
  }
  return total;
}

export function assertUpdateCapacity(paneDir: string, host: { paneDir: string; userData: string } | null, install: string, cliPrefix?: string): void {
  const GiB = 1024 ** 3;
  const installBytes = host ? (fs.statSync(install).isDirectory() ? updateSnapshotBytes(install) : fs.statSync(install).size) : 0;
  const snapshotBytes = host ? updateSnapshotBytes(host.paneDir, true) + updateSnapshotBytes(host.userData, false, true) : 0;
  const requirements = [
    { directory: paneDir, bytes: snapshotBytes * 1.2 + (host ? installBytes * 3 : 0) + 2 * GiB },
    ...(host ? [{ directory: path.dirname(install), bytes: installBytes * 2 }] : []),
    ...(cliPrefix ? [{ directory: cliPrefix, bytes: GiB }] : []),
  ];
  const volumes = new Map<number, { directory: string; bytes: number }>();
  for (const requirement of requirements) {
    const device = fs.statSync(requirement.directory).dev;
    const prior = volumes.get(device);
    volumes.set(device, { directory: requirement.directory, bytes: (prior?.bytes ?? 0) + requirement.bytes });
  }
  for (const { directory, bytes } of volumes.values()) {
    const disk = fs.statfsSync(directory);
    if (disk.bavail * disk.bsize < bytes) throw new RunpaneError('ERR_UPDATE_DISK_SPACE', `The volume containing ${directory} needs at least ${(bytes / GiB).toFixed(1)} GiB free for staging, replacement and recovery. Pane remains running.`, 'Free space on that volume and retry.');
  }
}
