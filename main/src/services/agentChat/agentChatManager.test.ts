import { randomUUID } from 'crypto';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { describe, expect, it, vi } from 'vitest';
import { databaseService } from '../database';
import { panelManager } from '../panelManager';
import { AgentChatManager } from './agentChatManager';
import type { TerminalPanelState } from '../../../../shared/types/panels';

describe('agent chat host commands', () => {
  it('keeps an unsupported shared-daemon Codex tab native and rejects raw input only for an actual chat owner', async () => {
    const id = randomUUID();
    databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
    const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', title: 'Codex', initialState: { customState: { agentType: 'codex', initialCommand: 'codex --yolo' } } });
    const manager = new AgentChatManager();
    expect(manager.view(panel.id)).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/shared.daemon/i) });
    expect(() => manager.guardNativeInput(panel.id, 'hello')).not.toThrow();
    await expect(manager.switchTo(panel.id, 'chat', 0)).rejects.toMatchObject({ code: 'CHAT_PROFILE_UNSUPPORTED' });
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    expect((panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat).toBeUndefined();
  });
});

// These integration fixtures execute a POSIX fake CLI; Windows profiles remain unsupported.
it.skipIf(process.platform === 'win32')('keeps a supported native conversation usable when its adapter setup is missing and persists the checkpoint identity', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { recordNativeHook } = await import('./nativeHookJournal');
  const directory = mkdtempSync(join(tmpdir(), 'pane-native-launch-'));
  const executable = join(directory, 'claude');
  writeFileSync(executable, '#!/bin/sh\necho "2.1.309 (Claude Code)"\n', { mode: 0o700 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  await once(child, 'spawn');
  const id = randomUUID();
  const nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true, supportsNativeHost: () => true });
  const { getPaneEventSink } = await import('../../core/runtime');
  const events = vi.spyOn(getPaneEventSink(), 'send');
  try {
    manager.attachNative({ pid: () => child.pid, writeControl: () => undefined, destroy: async () => undefined, initialize: async () => undefined });
    const command = await manager.prepareNativeLaunch(panel, directory, process.env, `${executable} --session-id ${nativeId}`, 'bash', false);
    expect(command).toContain('--settings');
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    const saved = (panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat!;
    expect(saved.conversation).toMatchObject({ active: 'terminal', nativeSessionId: nativeId, generation: 1 });
    recordNativeHook(saved.launch.journalFile, { session_id: nativeId, hook_event_name: 'SessionStart', cwd: directory, source: 'startup' });
    recordNativeHook(saved.launch.journalFile, { session_id: nativeId, hook_event_name: 'Stop', permission_mode: 'default', background_tasks: [], session_crons: [] });
    await expect.poll(() => events.mock.calls.some(([channel, payload]) => channel === 'agent-chat:state' && decodeOptionalBoundary(payload, boundary.object({ running: boundary.boolean }))?.running === false)).toBe(true);
    expect(manager.view(panel.id)).toMatchObject({ available: true, setupRequired: true });
    await expect(manager.switchTo(panel.id, 'chat', 1)).rejects.toMatchObject({ code: 'CHAT_ADAPTER_MISSING' });
    expect(manager.view(panel.id).conversation?.active).toBe('terminal');
    expect(() => manager.guardNativeInput(panel.id, 'New prompt\r')).not.toThrow();
    events.mockClear();
    await expect.poll(() => events.mock.calls.some(([channel, payload]) => channel === 'agent-chat:state' && decodeOptionalBoundary(payload, boundary.object({ running: boundary.boolean }))?.running === true)).toBe(true);
  } finally { events.mockRestore(); child.kill(); await exit; manager.detachObservers(); rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('switches one exact conversation through native, ACP and native while all viewers share the durable generation', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');
  const { once } = await import('events');
  const { recordNativeHook } = await import('./nativeHookJournal');
  const { CLAUDE_ADAPTER_VERSION } = await import('./adapterSetup');
  const { getAppDirectory } = await import('../../utils/appDirectory');
  const adapter = join(getAppDirectory(), 'agent-adapters', `claude-${CLAUDE_ADAPTER_VERSION}`, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
  mkdirSync(join(adapter, 'dist'), { recursive: true });
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({ version: CLAUDE_ADAPTER_VERSION }));
  writeFileSync(join(adapter, 'dist', 'index.js'), `let buffer='';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let mode='default', effort='medium';
const config = () => [{id:'mode',name:'Mode',type:'select',currentValue:mode,options:[{value:'default',name:'Default'},{value:'plan',name:'Plan'}]},{id:'effort',name:'Effort',type:'select',currentValue:effort,options:[{value:'medium',name:'Medium'},{value:'high',name:'High'}]}];
process.stdin.on('data', chunk => { buffer += chunk; let end; while ((end=buffer.indexOf('\\n'))>=0) {
 const m=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1); if (m.id===undefined) continue;
 let result={}; if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}}};
 if(m.method==='session/load') { send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'user_message_chunk',messageId:'history-a',content:{type:'text',text:'Preserved native history'}}}}); result={modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},configOptions:config()}; }
 if(m.method==='session/new') result={sessionId:'fresh-native-a',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]}};
 if(m.method==='session/prompt' && m.params.prompt[0]?.text==='Fail this turn') { send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Provider authentication expired'}}); continue; }
 if(m.method==='session/set_config_option') { if(m.params.configId==='mode')mode=m.params.value;if(m.params.configId==='effort')effort=m.params.value;result={configOptions:config()}; }
 if(m.method==='session/prompt') { send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',messageId:'new-answer',content:{type:'text',text:'Only one new answer'}}}}); result={stopReason:'end_turn'}; }
 send({jsonrpc:'2.0',id:m.id,result});
}}); process.stdin.on('end',()=>process.exit(0));`);
  const directory = mkdtempSync(join(tmpdir(), 'pane-native-handoff-'));
  const executable = join(directory, 'claude');
  writeFileSync(executable, '#!/bin/sh\necho "2.1.309 (Claude Code)"\n', { mode: 0o700 });
  let child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let exited = once(child, 'exit');
  await once(child, 'spawn');
  const id = randomUUID(), nativeId = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: directory, project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, agentSessionId: nativeId } });
  const manager = new AgentChatManager({ enabled: () => true, supportsNativeHost: () => true });
  // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
  const state = () => (panelManager.getPanel(panel.id)!.state.customState as TerminalPanelState).agentChat!;
  const hook = (name: string, extra = {}) => recordNativeHook(state().launch.journalFile, { session_id: nativeId, hook_event_name: name, cwd: directory, ...extra });
  try {
    manager.attachNative({
      pid: () => child.pid,
      writeControl: (_panel, input) => { expect(input).toBe('/exit\r'); hook('SessionEnd'); child.kill(); },
      destroy: async () => { await exited; },
      initialize: async () => {
        expect(state().processes.chat).toEqual([]);
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        exited = once(child, 'exit');
        await once(child, 'spawn');
        const command = await manager.prepareNativeLaunch(panelManager.getPanel(panel.id)!, directory, process.env, `${executable} --resume ${nativeId}`, 'bash', false);
        expect(command).toContain(`--resume ${nativeId}`);
        hook('SessionStart', { source: 'resume' });
      },
    });
    await manager.prepareNativeLaunch(panel, directory, process.env, `${executable} --session-id ${nativeId}`, 'bash', false);
    hook('SessionStart', { source: 'startup' });
    hook('Stop', { permission_mode: 'default', background_tasks: [], session_crons: [] });
    await manager.switchTo(panel.id, 'chat', 1);
    const firstViewer = manager.view(panel.id);
    const secondViewer = manager.view(panel.id);
    expect(firstViewer).toEqual(secondViewer);
    expect(firstViewer.conversation).toMatchObject({ active: 'chat', nativeSessionId: nativeId, generation: 2 });
    expect(firstViewer.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Preserved native history' }]);
    expect(() => manager.guardNativeInput(panel.id, 'raw bytes')).toThrow(/raw terminal input/i);
    const request = { generation: 2, operationId: 'send-once', text: 'One follow-up' };
    const receipt = manager.send(panel.id, request);
    expect(manager.send(panel.id, request)).toEqual(receipt);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(manager.receipt(panel.id, request.operationId)?.state).toBe('completed');
    expect(manager.view(panel.id).transcript?.messages.filter(message => message.id === 'new-answer')).toHaveLength(1);
    expect(manager.view(panel.id).transcript?.messages.filter(message => message.role === 'user').map(message => message.parts)).toEqual([
      [{ type: 'text', text: 'Preserved native history' }], [{ type: 'text', text: 'One follow-up' }],
    ]);
    expect(() => manager.send(panel.id, { ...request, text: 'Changed retry' })).toThrow(/different content/i);

    const { getPaneEventSink } = await import('../../core/runtime');
    const statusSpy = vi.spyOn(getPaneEventSink(), 'send');
    manager.send(panel.id, { ...request, operationId: 'failed-turn', text: 'Fail this turn' });
    await expect.poll(() => manager.receipt(panel.id, 'failed-turn')?.state).toBe('failed');
    expect(manager.view(panel.id).error).toContain('Provider authentication expired');
    expect(manager.status(panel.id)).toBe('blocked');
    const { chatLastMessage, waitForChat } = await import('../../ipc/runpaneChat');
    const { agentChatManager } = await import('./agentChatManager');
    const viewSpy = vi.spyOn(agentChatManager, 'view').mockImplementation(() => manager.view(panel.id));
    try {
      expect(() => chatLastMessage(panel, 100)).toThrow(/authentication expired/);
      await expect(waitForChat(panel, { panelId: panel.id, condition: 'idle' })).rejects.toMatchObject({ code: 'CHAT_TURN_FAILED' });
    } finally { viewSpy.mockRestore(); }
    expect(statusSpy.mock.calls.filter(([channel]) => channel === 'panel:agentStatus').map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ state: 'working' }), expect.objectContaining({ state: 'blocked' }),
    ]);
    statusSpy.mockClear();
    manager.send(panel.id, { ...request, operationId: 'after-failure', text: 'Continue successfully' });
    await expect.poll(() => manager.receipt(panel.id, 'after-failure')?.state).toBe('completed');
    expect(manager.view(panel.id).error).toBeUndefined();
    expect(statusSpy.mock.calls.filter(([channel]) => channel === 'panel:agentStatus').map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ state: 'working' }), expect.objectContaining({ state: 'idle', workedVisibly: true }),
    ]);
    statusSpy.mockRestore();

    hook('Stop', { permission_mode: 'default', effort: { level: 'medium' }, background_tasks: [], session_crons: [] });
    await manager.configure(panel.id, 2, 'mode', 'plan');
    await manager.configure(panel.id, 2, 'effort', 'high');
    await manager.switchTo(panel.id, 'terminal', 2);
    expect(state().launch).toMatchObject({ permissionMode: 'plan', effort: 'high' });
    expect(manager.view(panel.id).conversation).toMatchObject({ active: 'terminal', nativeSessionId: nativeId, generation: 3 });
    expect(manager.verifyNativeResume(panel.id, nativeId)).toEqual({ pid: child.pid });
    expect(() => manager.verifyNativeResume(panel.id, 'different-conversation')).toThrow(/exact saved conversation/);
    const fresh = await panelManager.createPanel({ sessionId: id, type: 'terminal', initialState: { agentType: 'claude', initialCommand: executable, initialInput: 'Fresh first turn' } });
    expect(await manager.prepareFreshChat(fresh, directory, process.env, 'bash', false, 'chat')).toBe(true);
    expect(manager.view(fresh.id).conversation).toMatchObject({ active: 'chat', nativeSessionId: 'fresh-native-a', generation: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(manager.view(fresh.id).transcript?.messages.filter(message => message.role === 'user')).toHaveLength(1);
    // SAFETY: This fixture creates a terminal panel and reads its typed custom state.
    expect((panelManager.getPanel(fresh.id)!.state.customState as TerminalPanelState).initialInputSentAt).toBeTruthy();
    child.kill(); await exited;
    await manager.stop(fresh.id);

  } finally {
    child.kill(); await exited; manager.detachObservers();
    try { await manager.stop(panel.id); } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(adapter, { recursive: true, force: true });
    }
  }
});

it('restores saved native ownership as stopped without starting a replacement process', async () => {
  const id = randomUUID();
  databaseService.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: process.cwd(), project_id: null, tool_type: 'none' });
  const panel = await panelManager.createPanel({ sessionId: id, type: 'terminal' });
  panelManager.commitAgentChat(panel.id, {
    conversation: { panelId: panel.id, workspaceId: id, provider: 'claude', nativeSessionId: 'exact-saved-id', active: 'terminal', preferred: 'terminal', generation: 4 },
    launch: { command: 'claude', cwd: process.cwd(), shellType: 'bash', executable: 'claude', version: '2.1.309', strictMcpConfig: true, journalFile: '/unused', settingsFile: '/unused' },
    processes: { terminal: [], chat: [] },
  });
  const restarted = new AgentChatManager();
  expect(restarted.view(panel.id).conversation).toMatchObject({ active: 'stopped', nativeSessionId: 'exact-saved-id', generation: 4 });
  expect(() => restarted.guardNativeInput(panel.id, 'submit\r')).toThrow(/stopped/i);
  expect(() => restarted.assertNativeInitialize(panel.id)).toThrow(/already has a conversation owner/i);
});
