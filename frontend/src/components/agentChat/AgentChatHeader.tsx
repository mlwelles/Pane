import { useMemo, useState, useSyncExternalStore } from 'react';
import { MessageSquare, MoreHorizontal, TerminalSquare } from 'lucide-react';
import type { AgentChatClient, AgentInterface } from '../../../../shared/types/agentChat';
import { agentChatViewer } from '../../services/agentChatViewer';
import './agentChat.css';

/** A view choice on the existing host conversation, never a second agent. */
export function AgentChatHeader({ panelId, client, connected = true }: { panelId: string; client: AgentChatClient; connected?: boolean }) {
  const viewer = useMemo(() => agentChatViewer(client, panelId), [client, panelId]);
  const { view } = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const [busy, setBusy] = useState(false);
  const conversation = view?.conversation;
  const transitioning = !!conversation?.transition && conversation.active !== 'stopped';
  const focusMode = conversation?.active === 'stopped' ? 'terminal' : conversation?.active ?? 'chat';
  const change = async (mode: AgentInterface) => {
    if (!conversation) return;
    setBusy(true);
    try {
      if (conversation.active === 'stopped') await client.recover(panelId, mode, conversation.generation);
      else await client.switch(panelId, mode, conversation.generation);
      await viewer.refresh();
    } catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const status = conversation?.active === 'stopped' ? 'Conversation stopped' : transitioning ? 'Switching interface…' : !connected ? 'Reconnecting…' : conversation?.pendingSwitch ? `Switch to ${conversation.pendingSwitch.target === 'chat' ? 'Chat' : 'Terminal'} after this turn` : view?.permissions.length ? 'Waiting for you' : view?.running ? 'Agent is working' : '';
  return <div className="agent-chat chat-header">
    <div className="chat-switch" role="radiogroup" aria-label="View this conversation as" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!options.length) return;
      event.preventDefault();
      const current = options.findIndex(option => option === document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length;
      options[index].focus();
      options[index].click();
    }}>
      {(['chat', 'terminal'] as const).map(mode => <button key={mode} type="button" role="radio" tabIndex={focusMode === mode ? 0 : -1} aria-checked={conversation?.active === mode} disabled={!connected || busy || !view?.available || transitioning || (mode === 'chat' && view.setupRequired)} onClick={() => void change(mode)}>
        {mode === 'chat' ? <MessageSquare className="h-3.5 w-3.5" /> : <TerminalSquare className="h-3.5 w-3.5" />}{mode === 'chat' ? 'Chat' : 'Terminal'}
      </button>)}
    </div>
    {(status || conversation?.pendingSwitch) && <div className="chat-header-state">
      <span role="status" className="chat-status">{status}</span>
      {conversation?.pendingSwitch && <button type="button" className="chat-button" disabled={busy || !connected} onClick={() => void change(conversation.active === 'chat' ? 'chat' : 'terminal')}>Cancel pending switch</button>}
    </div>}
    <details className="chat-menu">
      <summary className="chat-icon" aria-label="Conversation options" title="Conversation options"><MoreHorizontal className="h-4 w-4" /></summary>
      <div className="chat-menu-popover">
        <button type="button" className="chat-button" onClick={() => void viewer.refresh()}>Refresh</button>
        <details className="chat-diagnostics"><summary className="chat-button">Diagnostics</summary><pre>{JSON.stringify({ conversation, configuration: view?.configuration, updates: view?.transcript?.messages.filter(message => message.id.startsWith('update:')) }, null, 2)}</pre></details>
      </div>
    </details>
  </div>;
}
