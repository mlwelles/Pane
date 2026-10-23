import { useEffect, useState } from 'react';
import { MessageSquare, MoreHorizontal, TerminalSquare } from 'lucide-react';
import type { AgentChatClient, AgentChatView, AgentInterface } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';

/** The same menu is used by local tabs and remote viewers. All changes run on the host. */
export function AgentViewMenu({ panelId, title, client, className }: { panelId: string; title: string; client: AgentChatClient; className?: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AgentChatView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const transitioning = !!view?.conversation?.transition && view.conversation.active !== 'stopped';
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void client.get(panelId).then(result => { if (!disposed) { setView(result); setError(undefined); } }, reason => { if (!disposed) setError(`Chat is unavailable on this host: ${String(reason)}`); });
    const detach = client.onState(result => { if (result.panelId === panelId) setView(result); });
    return () => { disposed = true; detach(); };
  }, [client, open, panelId]);
  const change = async (mode: AgentInterface) => {
    if (!view?.conversation) return;
    setBusy(true); setError(undefined);
    try {
      if (view.conversation.active === 'stopped') await client.recover(panelId, mode, view.conversation.generation);
      else await client.switch(panelId, mode, view.conversation.generation);
      setView(await client.get(panelId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <Dropdown className={className} width="lg" closeOnSelect={false} onOpenChange={setOpen} selectedId={view?.conversation?.active}
    trigger={<button type="button" data-agent-view-menu aria-label={`View ${title} as`} className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"><MoreHorizontal className="h-4 w-4" /></button>}
    items={[
      { id: 'terminal', label: view?.running && view.conversation?.active === 'chat' ? 'Switch to Terminal after this turn' : 'View as Terminal', icon: TerminalSquare, disabled: busy || !view?.available || transitioning, onClick: () => void change('terminal') },
      { id: 'chat', label: view?.running && view.conversation?.active === 'terminal' ? 'Switch to Chat after this turn' : 'View as Chat', icon: MessageSquare, disabled: busy || !view?.available || view.setupRequired || transitioning, onClick: () => void change('chat') },
    ]}
    footer={<div className="max-w-64 whitespace-normal px-3 py-2 text-xs text-text-secondary">
      {busy ? <p role="status">Updating this conversation…</p> : !view && !error ? <p>Checking host capabilities…</p> : null}
      {view?.conversation?.pendingSwitch && <div role="status"><p>Switch to {view.conversation.pendingSwitch.target === 'chat' ? 'Chat' : 'Terminal'} after this turn. {view.conversation.pendingSwitch.reason}</p><button type="button" className="mt-2 rounded border border-border-primary px-2 py-1" onClick={() => void change(view.conversation!.active === 'chat' ? 'chat' : 'terminal')}>Cancel pending switch</button></div>}
      {view?.conversation?.recovery && <p role="status">{view.conversation.recovery}</p>}
      {view?.unavailableReason && <p>{view.unavailableReason}</p>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {view?.setupRequired && <><p>Install the pinned Claude ACP adapter on this workspace’s host to enable Chat.</p><button type="button" disabled={busy} className="mt-2 rounded border border-border-primary px-2 py-1 disabled:opacity-50" onClick={() => {
        setBusy(true); setError(undefined);
        void client.setup().then(() => client.get(panelId)).then(setView).catch(reason => setError(String(reason))).finally(() => setBusy(false));
      }}>Set up Chat</button></>}
    </div>} />;
}
