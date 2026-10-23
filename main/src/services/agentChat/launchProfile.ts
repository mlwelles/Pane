import { tokenizeShellCommand } from '../agents/agentIdentity';

export interface ClaudeChatProfile {
  executable: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  additionalDirectories?: string[];
  strictMcpConfig: boolean;
}

/** Only options whose semantics have a verified ACP mapping are eligible.
 * Unknown flags, wrappers and shell programs retain their native behavior. */
export function claudeChatProfile(command: string): ClaudeChatProfile | undefined {
  const tokens = tokenizeShellCommand(command, process.platform);
  if (!tokens?.length || !/(?:^|\/)claude$/.test(tokens[0])) return;
  const result: ClaudeChatProfile = { executable: tokens[0], strictMcpConfig: false };
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--dangerously-skip-permissions') result.permissionMode = 'bypassPermissions';
    else if (token === '--strict-mcp-config') result.strictMcpConfig = true;
    else if (['--model', '--effort', '--permission-mode', '--add-dir'].includes(token)) {
      const value = tokens[++index];
      if (!value || value.startsWith('-')) return;
      if (token === '--add-dir') (result.additionalDirectories ??= []).push(value);
      if (token === '--model') result.model = value;
      if (token === '--effort') result.effort = value;
      if (token === '--permission-mode') result.permissionMode = value;
    } else return;
  }
  return result;
}
