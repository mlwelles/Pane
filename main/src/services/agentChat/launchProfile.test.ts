import { describe, expect, it } from 'vitest';
import { claudeChatProfile } from './launchProfile';

describe('switchable native launch capability', () => {
  it('preserves explicit Claude model, effort, permission and MCP choices while declining opaque launchers', () => {
    expect(claudeChatProfile('claude --model sonnet --effort high --permission-mode acceptEdits --strict-mcp-config')).toEqual({ executable: 'claude', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', strictMcpConfig: true });
    expect(claudeChatProfile('claude --dangerously-skip-permissions')).toMatchObject({ permissionMode: 'bypassPermissions' });
    expect(claudeChatProfile('env KEY=value claude')).toBeUndefined();
    expect(claudeChatProfile('claude --mcp-config custom.json')).toBeUndefined();
    expect(claudeChatProfile('claude --resume latest')).toBeUndefined();
    expect(claudeChatProfile('claude; echo surprise')).toBeUndefined();
    expect(claudeChatProfile('codex --no-daemon')).toBeUndefined();
  });
});
