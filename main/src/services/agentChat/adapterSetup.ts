import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAppDirectory } from '../../utils/appDirectory';
import { findExecutableInPath, getShellPath } from '../../utils/shellPath';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';

const execFileAsync = promisify(execFile);
export const CLAUDE_ADAPTER_VERSION = '0.94.0';
export const CLAUDE_NATIVE_VERSION = '2.1.309';
const packageName = '@agentclientprotocol/claude-agent-acp';
let installation: Promise<void> | undefined;

function directory(): string { return path.join(getAppDirectory(), 'agent-adapters', `claude-${CLAUDE_ADAPTER_VERSION}`); }

export function claudeAdapterEntry(): string | undefined {
  const root = path.join(directory(), 'node_modules', packageName);
  if (!existsSync(path.join(root, 'package.json'))) return;
  let metadata;
  try { metadata = decodeOptionalBoundary(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ version: boundary.string })); }
  catch { return; }
  const entry = path.join(root, 'dist', 'index.js');
  return metadata?.version === CLAUDE_ADAPTER_VERSION && existsSync(entry) ? entry : undefined;
}

/** Explicit setup action. No global installation or provider configuration changes. */
export async function installClaudeAdapter(): Promise<void> {
  installation ??= (async () => {
    const npm = findExecutableInPath('npm');
    if (!npm) throw new PaneError('CHAT_NPM_MISSING', 'Chat setup needs npm to install the pinned upstream adapter.', 'Install Node.js with npm, then run Chat setup again.');
    const cwd = directory();
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    try { await execFileAsync(npm, ['install', '--prefix', cwd, '--no-audit', '--no-fund', '--ignore-scripts', '--save-exact', `${packageName}@${CLAUDE_ADAPTER_VERSION}`], {
      cwd, env: { ...process.env, PATH: getShellPath() }, timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }); } catch (error) {
      throw new PaneError('CHAT_ADAPTER_INSTALL_FAILED', `Chat setup could not install the pinned adapter: ${error instanceof Error ? error.message : String(error)}`, 'Check npm and network access, then retry Chat setup. The terminal remains available.');
    }
    if (!claudeAdapterEntry()) throw new PaneError('CHAT_ADAPTER_INSTALL_FAILED', 'The pinned adapter was not present after setup.', 'Inspect the npm installation error and retry setup.');
  })().finally(() => { installation = undefined; });
  return installation;
}
