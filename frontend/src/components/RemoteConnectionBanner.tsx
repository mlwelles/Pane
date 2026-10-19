import { useEffect, useState } from 'react';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { API } from '../utils/api';

export function RemoteConnectionBanner({ onSettings }: { onSettings: () => void }) {
  const { connectionState: state } = useRemoteRuntimeState();
  const [retrying, setRetrying] = useState(false);
  const [unknownDelivery, setUnknownDelivery] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => setUnknownDelivery(event instanceof CustomEvent ? String(event.detail) : 'Delivery unknown: check the original host before resubmitting.');
    window.addEventListener('remote-delivery-unknown', listener);
    return () => window.removeEventListener('remote-delivery-unknown', listener);
  }, []);
  if (!unknownDelivery && (state.mode !== 'remote' || state.status === 'connected')) return null;
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try { await API.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: state.activeProfileId }); }
    catch (error) { console.warn('Remote retry failed:', error); }
    finally { setRetrying(false); }
  };
  return (
    <div role="status" className="flex shrink-0 items-center justify-between gap-4 border-b border-border-primary bg-surface-secondary px-4 py-2 text-sm text-text-primary">
      <div>
        <strong>{unknownDelivery ? 'Delivery unknown' : state.updateIntent ? 'Updating remote Pane. Your Session is saved; reconnecting automatically.' : state.status === 'restoring' ? 'Restoring your workspace…' : state.status === 'error' ? 'Could not reconnect' : 'Connection lost. Reconnecting…'}</strong>
        <p className="text-xs text-text-secondary">{unknownDelivery
          ? unknownDelivery
          : state.status === 'error' ? state.lastError : state.updateIntent ? `Operation ${state.updateIntent.id}. Last confirmed: checkpoint saved.` : 'Your workspace is kept. Pane will retry automatically for up to five minutes.'}</p>
      </div>
      <div className="flex shrink-0 gap-3">
        {unknownDelivery && <button type="button" onClick={() => setUnknownDelivery(null)}>Dismiss</button>}
        {state.mode === 'remote' && state.status !== 'connected' && <button type="button" disabled={retrying || state.status === 'restoring'} onClick={() => void retry()}>Retry now</button>}
        <button type="button" onClick={onSettings}>Connection settings</button>
      </div>
    </div>
  );
}
