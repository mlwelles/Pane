import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { NativeCheckpointState } from './nativeCheckpoint';

import type { AgentConversationRecord, AgentInterface } from '../../../../shared/types/agentChat';
export type { AgentInterface } from '../../../../shared/types/agentChat';
export type ConversationRecord = AgentConversationRecord;

/** Process/protocol boundary. Preflight must never load the conversation;
 * release resolves only when the owned runtime and its writers have exited. */
export interface RuntimeDriver {
  preflight(record: ConversationRecord, target: AgentInterface): Promise<void>;
  checkpoint(record: ConversationRecord): Promise<NativeCheckpointState>;
  release(record: ConversationRecord, mode: AgentInterface): Promise<void>;
  acquire(record: ConversationRecord, mode: AgentInterface): Promise<{ nativeSessionId: string; historyVerified: boolean }>;
}

export interface ConversationStorage {
  read(): ConversationRecord;
  /** Must commit durably before returning. */
  write(record: ConversationRecord): void;
}

/** One controller per panel on the owning host, shared by all local and remote
 * callers. Its lifetime is independent of any renderer or transport viewer. */
export class SessionController {
  private switching = false;
  private pendingTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly storage: ConversationStorage,
    private readonly runtime: RuntimeDriver,
    private readonly enabled: () => boolean = () => true,
  ) {
    const saved = storage.read();
    if (saved.pendingSwitch) { saved.pendingSwitch = undefined; storage.write(saved); }
    if (saved.transition || saved.active === 'chat') {
      storage.write({ ...saved, active: 'stopped', recovery: saved.recovery ?? 'The interface switch was interrupted. Runtime ownership must be verified before recovery.' });
    }
  }

  snapshot(): ConversationRecord {
    return structuredClone(this.storage.read());
  }

  assertWritable(generation: number): void {
    const record = this.snapshot();
    if (record.transition) throw new PaneError('CHAT_TRANSITION_IN_PROGRESS', 'The conversation is switching interfaces. No input was sent.', 'Wait for the switch to finish.');
    if (record.generation !== generation) throw new PaneError('CHAT_STALE_GENERATION', 'The conversation runtime changed. No input was sent.', 'Refresh the conversation and retry explicitly.');
    if (record.active === 'stopped') throw new PaneError('CHAT_STOPPED', 'The conversation is stopped. No input was sent.', 'Recover the exact conversation before sending input.');
  }

  private schedulePending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => { void this.advancePending(); }, 500);
    this.pendingTimer.unref();
  }

  private async advancePending(): Promise<void> {
    const before = this.snapshot();
    const pending = before.pendingSwitch;
    if (!pending || before.active === 'stopped' || before.transition) return;
    try {
      const checkpoint = await this.runtime.checkpoint(before);
      // Cancellation or another viewer may have changed the request while checking.
      const current = this.snapshot();
      if (current.pendingSwitch?.target !== pending.target || current.generation !== before.generation) return;
      if (!checkpoint.ready) { this.schedulePending(); return; }
      await this.switchTo(pending.target, before.generation);
    } catch (error) {
      const current = this.snapshot();
      this.storage.write({ ...current, pendingSwitch: undefined, recovery: reasonOf(error) });
    }
  }

  async stop(cleanup: () => Promise<void>): Promise<void> {
    if (this.switching) throw new PaneError('CHAT_TRANSITION_IN_PROGRESS', 'The conversation is switching interfaces. Stop has not started.', 'Wait for the handoff to settle, then stop the active owner.');
    this.switching = true;
    const before = this.snapshot();
    this.storage.write({ ...before, pendingSwitch: undefined, active: 'stopped', generation: before.generation + 1, recovery: 'Stopping the owned runtime…' });
    try {
      await cleanup();
      this.storage.write({ ...this.snapshot(), transition: undefined, recovery: undefined });
    } catch (error) {
      this.storage.write({ ...this.snapshot(), recovery: `Stop could not verify release: ${reasonOf(error)}.` });
      throw error;
    } finally { this.switching = false; }
  }

  async recover(target: AgentInterface, generation: number): Promise<ConversationRecord> {
    const before = this.snapshot();
    if (this.switching || before.active !== 'stopped') throw new PaneError('CHAT_RECOVERY_UNAVAILABLE', 'The conversation is not stopped or is already switching.', 'Use its active interface or wait for the current operation.');
    if (generation !== before.generation) throw new PaneError('CHAT_STALE_GENERATION', 'The runtime changed. Recovery did not start.', 'Refresh the recovery state.');
    if (target === 'chat' && !this.enabled() && before.preferred !== 'chat') throw new PaneError('CHAT_DISABLED', 'New Chat transitions are disabled.', 'Recover in Terminal or enable Chat.');
    this.switching = true;
    let acquiring = false;
    try {
      await this.runtime.preflight(before, target);
      // Both sides may have existed when a host died between durable phases.
      // A driver without a live handle must verify recorded process lifetimes;
      // missing transport state alone can never count as release.
      await this.runtime.release(before, 'terminal');
      await this.runtime.release(before, 'chat');
      const transition = { source: before.transition?.source ?? before.preferred, target, phase: 'loading' as const };
      this.storage.write({ ...before, transition, recovery: undefined });
      acquiring = true;
      const loaded = await this.runtime.acquire(before, target);
      if (loaded.nativeSessionId !== before.nativeSessionId || !loaded.historyVerified) throw new Error('Exact conversation identity or history was not verified');
      this.storage.write({ ...before, active: target, preferred: target, generation: before.generation + 1, transition: undefined, recovery: undefined });
      return this.snapshot();
    } catch (error) {
      let cleanupError = '';
      if (acquiring) {
        try { await this.runtime.release(before, target); }
        catch (releaseError) { cleanupError = ` Target release remains unverified: ${reasonOf(releaseError)}.`; }
      }
      this.storage.write({ ...this.snapshot(), active: 'stopped', recovery: `Recovery could not verify the exact conversation: ${reasonOf(error)}.${cleanupError}` });
      throw new PaneError('CHAT_RECOVERY_FAILED', this.snapshot().recovery!, 'Release the recorded runtime before trying explicit recovery again.');
    } finally { this.switching = false; }
  }

  async switchTo(target: AgentInterface, generation: number): Promise<ConversationRecord> {
    if (target === 'chat' && !this.enabled()) throw new PaneError('CHAT_DISABLED', 'New Chat transitions are disabled. The current runtime remains available.', 'Enable Chat before switching into it.');
    if (this.switching) throw new PaneError('CHAT_TRANSITION_IN_PROGRESS', 'The conversation is already switching interfaces.', 'Wait for the switch to finish.');
    this.assertWritable(generation);
    const before = this.snapshot();
    if (before.active === target) {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.storage.write({ ...before, pendingSwitch: undefined, preferred: target });
      return this.snapshot();
    }
    if (before.active === 'stopped') throw new PaneError('CHAT_STOPPED', 'The conversation is stopped.', 'Recover it before switching.');
    this.switching = true;
    let sourceReleased = false;
    try {
      await this.runtime.preflight(before, target);
      const checkpoint = await this.runtime.checkpoint(before);
      if (!checkpoint.ready) {
        this.storage.write({ ...before, preferred: target, pendingSwitch: { target, reason: checkpoint.reason } });
        this.schedulePending();
        return this.snapshot();
      }
      before.pendingSwitch = undefined;
      const transition = { source: before.active, target, phase: 'releasing' as const };
      this.storage.write({ ...before, preferred: target, transition });
      const frozenCheckpoint = await this.runtime.checkpoint(before);
      if (!frozenCheckpoint.ready) {
        this.storage.write(before);
        throw new PaneError('CHAT_CHECKPOINT_UNAVAILABLE', frozenCheckpoint.reason, 'Wait for the current work to finish, then switch again.');
      }
      await this.runtime.release(before, before.active);
      sourceReleased = true;
      this.storage.write({ ...before, preferred: target, active: 'stopped', transition: { ...transition, phase: 'loading' } });
      const loaded = await this.runtime.acquire(before, target);
      if (loaded.nativeSessionId !== before.nativeSessionId || !loaded.historyVerified) {
        throw new PaneError('CHAT_IDENTITY_MISMATCH', 'The target did not verify the exact saved conversation and its history.', 'Leave the conversation stopped and inspect its recovery state.');
      }
      this.storage.write({ ...before, active: target, preferred: target, generation: before.generation + 1, transition: undefined });
      return this.snapshot();
    } catch (error) {
      if (!this.snapshot().transition) throw error;
      if (sourceReleased) {
        try {
          await this.runtime.release(before, target);
          const restored = await this.runtime.acquire(before, before.active);
          if (restored.nativeSessionId !== before.nativeSessionId || !restored.historyVerified) {
            throw new Error('The previous runtime did not verify the exact conversation');
          }
          this.storage.write({ ...before, preferred: target, generation: before.generation + 1, transition: undefined });
          throw new PaneError('CHAT_HANDOFF_FAILED', `Switching failed because ${reasonOf(error)}. The exact conversation is restored in its previous interface.`, 'Continue there or fix the target configuration and try again.');
        } catch (recoveryError) {
          if (recoveryError instanceof PaneError && recoveryError.code === 'CHAT_HANDOFF_FAILED') throw recoveryError;
          this.storage.write({ ...this.snapshot(), active: 'stopped', recovery: `Switching failed: ${reasonOf(error)}. Recovery could not verify ownership: ${reasonOf(recoveryError)}.` });
        }
      } else {
        this.storage.write({ ...this.snapshot(), active: 'stopped', recovery: `The source did not confirm release: ${reasonOf(error)}.` });
      }
      throw new PaneError('CHAT_OWNERSHIP_UNCERTAIN', this.snapshot().recovery ?? 'Conversation ownership could not be verified.', 'Inspect and release the owned runtime before explicitly recovering this exact conversation.');
    } finally {
      this.switching = false;
    }
  }
}
