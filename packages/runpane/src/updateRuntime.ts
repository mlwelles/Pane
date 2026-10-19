import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RunpaneError } from './errors';

/** Stage a standalone Node runtime, including macOS relative dylibs, outside both installations. */
export function stageUpdateRuntime(source: string, directory: string): string {
  const original = fs.realpathSync(source);
  if (!/^node(?:\.exe)?$/i.test(path.basename(original))) {
    throw new RunpaneError('ERR_UPDATE_RUNTIME', 'The update helper requires a standalone Node executable. Nothing was changed.', 'Install Node 22 or newer and retry.');
  }
  // An Electron executable is not a standalone Node runtime. Copying it leaves
  // framework dependencies behind (and pins the Windows app being replaced).
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const probe = execFileSync(original, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], {
    encoding: 'utf8', env: environment, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.includes('electron')) throw new RunpaneError('ERR_UPDATE_RUNTIME', 'The updater requires standalone Node. Electron cannot supervise its own replacement. Nothing was changed.', 'Install Node 22 or newer on this host, then retry.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(original, executable, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(executable, 0o700);
  if (process.platform === 'darwin') {
    const pending = [original];
    const copied = new Set<string>();
    while (pending.length) {
      const binary = pending.pop()!;
      const libraries = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8', timeout: 10_000 });
      for (const line of libraries.split('\n').slice(1)) {
        const reference = line.trim().split(' (')[0];
        if (!reference.startsWith('@rpath/') && !reference.startsWith('@loader_path/')) continue;
        const name = path.basename(reference);
        if (copied.has(name)) continue;
        const candidates = [path.join(path.dirname(binary), name), path.join(path.dirname(binary), '..', 'lib', name)];
        const found = candidates.find(file => fs.existsSync(file));
        if (!found) throw new RunpaneError('ERR_UPDATE_RUNTIME', `Could not stage runtime library ${name}. Nothing was changed.`, 'Use a standalone Node distribution, then retry.');
        fs.copyFileSync(found, path.join(directory, name), fs.constants.COPYFILE_EXCL);
        copied.add(name);
        pending.push(found);
      }
    }
  }
  // This is a real execution check, with no inherited Electron runtime flag.
  const actual = execFileSync(executable, ['-p', 'JSON.stringify({node:process.versions.node,electron:process.versions.electron})'], {
    encoding: 'utf8', env: environment, cwd: directory, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (actual.trim() !== probe.trim()) throw new RunpaneError('ERR_UPDATE_RUNTIME', 'The staged runtime did not pass its execution check. Nothing was changed.', 'Use a standalone Node distribution, then retry.');
  return executable;
}
