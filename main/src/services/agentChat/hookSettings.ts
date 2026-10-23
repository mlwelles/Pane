import path from 'path';
import { quoteShellWord } from '../agents/shellWord';

/** Construct settings from the current journal path on every acquisition. */
export function nativeChatHookSettings(journalFile: string, shellType: string) {
  const command = `ELECTRON_RUN_AS_NODE=1 ${quoteShellWord(process.execPath, shellType)} ${quoteShellWord(path.join(__dirname, 'hookWriter.js'), shellType)} ${quoteShellWord(journalFile, shellType)}`;
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'].map(name => [name, [{ hooks: [{ type: 'command', command, timeout: 5 }] }]])) };
}
