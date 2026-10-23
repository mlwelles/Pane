import { describe, expect, it, vi } from 'vitest';
import { SessionController, type ConversationRecord, type RuntimeDriver } from './sessionController';

const original: ConversationRecord = {
  panelId: 'panel-a', workspaceId: 'workspace-a', provider: 'claude',
  nativeSessionId: 'conversation-a', generation: 1, active: 'terminal', preferred: 'terminal',
};

/** Test provider: the external agent can delay release independently of Pane. */
function provider() {
  const owners = new Set(['terminal']);
  let release: (() => void) | undefined;
  const driver: RuntimeDriver = {
    preflight: async () => undefined,
    checkpoint: async () => ({ ready: true }),
    release: async () => new Promise<void>(resolve => {
      release = () => { owners.delete('terminal'); resolve(); };
    }),
    acquire: async (_record, mode) => {
      if (owners.size) throw new Error('Conversation already has a writer');
      owners.add(mode);
      return { nativeSessionId: 'conversation-a', historyVerified: true };
    },
  };
  return { driver, owners, release: () => release?.() };
}

function storage() {
  let saved = structuredClone(original);
  return { read: () => structuredClone(saved), write: (record: ConversationRecord) => { saved = structuredClone(record); } };
}

describe('conversation runtime handoff', () => {
  it('requires explicit recovery after a host restart and verifies both possible owners before resuming the exact id', async () => {
    const store = storage();
    store.write({ ...original, active: 'chat', preferred: 'chat' });
    const owners = new Set<string>();
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: true }),
      release: async (_record, mode) => { if (owners.has(mode)) throw new Error('Previous owner still alive'); },
      acquire: async record => {
        expect(owners.size).toBe(0);
        owners.add('chat');
        return { nativeSessionId: record.nativeSessionId, historyVerified: true };
      },
    };
    const controller = new SessionController(store, driver);
    expect(controller.snapshot().active).toBe('stopped');
    expect(owners.size).toBe(0);
    await controller.recover('chat', 1);
    expect(controller.snapshot()).toMatchObject({ active: 'chat', generation: 2, nativeSessionId: 'conversation-a' });
    expect([...owners]).toEqual(['chat']);
  });
  it('rechecks work after freezing input and leaves the source usable when new work raced preflight', async () => {
    const runtime = provider();
    let checks = 0;
    runtime.driver.checkpoint = async () => ++checks === 1 ? { ready: true } : { ready: false, reason: 'A new turn arrived' };
    const controller = new SessionController(storage(), runtime.driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_CHECKPOINT_UNAVAILABLE' });
    expect(controller.snapshot()).toEqual(original);
    expect([...runtime.owners]).toEqual(['terminal']);
    expect(() => controller.assertWritable(1)).not.toThrow();
  });
  it('leaves the source usable when preflight fails or the feature is disabled', async () => {
    const runtime = provider();
    runtime.driver.preflight = async () => { throw new Error('Adapter missing'); };
    const controller = new SessionController(storage(), runtime.driver);
    await expect(controller.switchTo('chat', 1)).rejects.toThrow('Adapter missing');
    expect(controller.snapshot()).toEqual(original);
    expect(() => controller.assertWritable(1)).not.toThrow();
    const disabled = new SessionController(storage(), runtime.driver, () => false);
    await expect(disabled.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_DISABLED' });
    expect(disabled.snapshot()).toEqual(original);
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('does not resume another writer after an ambiguous release, including after host restart', async () => {
    const store = storage();
    const runtime = provider();
    runtime.driver.release = async () => { throw new Error('Agent child still alive'); };
    const controller = new SessionController(store, runtime.driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_OWNERSHIP_UNCERTAIN' });
    expect([...runtime.owners]).toEqual(['terminal']);
    expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'conversation-a' });
    const restarted = new SessionController(store, runtime.driver);
    await expect(restarted.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('leaves a crash during target loading in recovery without automatically acquiring anything', () => {
    const store = storage();
    store.write({ ...original, transition: { source: 'terminal', target: 'chat', phase: 'loading' } });
    const runtime = provider();
    const restarted = new SessionController(store, runtime.driver);
    expect(restarted.snapshot()).toMatchObject({ active: 'stopped' });
    expect(restarted.snapshot().recovery).toMatch(/interrupted/i);
    expect([...runtime.owners]).toEqual(['terminal']);
  });

  it('recovers the exact source after a failed load only when the target has released ownership', async () => {
    const store = storage();
    const owners = new Set(['terminal']);
    const driver: RuntimeDriver = {
      preflight: async () => undefined,
      checkpoint: async () => ({ ready: true }),
      release: async (_record, mode) => { owners.delete(mode); },
      acquire: async (record, mode) => {
        if (owners.size) throw new Error('Duplicate writer');
        owners.add(mode);
        if (mode === 'chat') throw new Error('Adapter failed during history replay');
        expect(record.nativeSessionId).toBe('conversation-a');
        return { nativeSessionId: record.nativeSessionId, historyVerified: true };
      },
    };
    const controller = new SessionController(store, driver);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_HANDOFF_FAILED' });
    expect([...owners]).toEqual(['terminal']);
    expect(controller.snapshot()).toMatchObject({ active: 'terminal', preferred: 'chat', generation: 2 });
    expect(controller.snapshot().transition).toBeUndefined();
  });

  it('keeps all callers frozen until the source has released the exact conversation', async () => {
    const runtime = provider();
    const controller = new SessionController(storage(), runtime.driver);
    const pending = controller.switchTo('chat', 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.snapshot()).toMatchObject({ active: 'terminal', transition: { phase: 'releasing', target: 'chat' } });
    expect(() => controller.assertWritable(1)).toThrow(/switch/i);
    await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
    expect([...runtime.owners]).toEqual(['terminal']);
    runtime.release();
    await pending;
    expect(controller.snapshot()).toMatchObject({ active: 'chat', generation: 2, nativeSessionId: 'conversation-a' });
    expect(controller.snapshot().transition).toBeUndefined();
    expect(() => controller.assertWritable(1)).toThrow(/changed/i);
    expect(() => controller.assertWritable(2)).not.toThrow();
  });
});

it('freezes all senders before stop and refuses a concurrent switch until cleanup finishes', async () => {
  const runtime = provider();
  const controller = new SessionController(storage(), runtime.driver);
  let finish: (() => void) | undefined;
  const stopped = controller.stop(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(() => controller.assertWritable(1)).toThrow();
  await expect(controller.switchTo('chat', 1)).rejects.toMatchObject({ code: 'CHAT_TRANSITION_IN_PROGRESS' });
  finish?.();
  await stopped;
  expect(controller.snapshot()).toMatchObject({ active: 'stopped', generation: 2 });
  expect(controller.snapshot().recovery).toBeUndefined();
});

it('releases a failed recovery target before leaving the exact conversation stopped', async () => {
  const store = storage();
  store.write({ ...original, active: 'stopped' });
  const owners = new Set<string>();
  const driver: RuntimeDriver = {
    preflight: async () => undefined, checkpoint: async () => ({ ready: true }),
    release: async (_record, mode) => { owners.delete(mode); },
    acquire: async () => { owners.add('chat'); throw new Error('History replay failed'); },
  };
  const controller = new SessionController(store, driver);
  await expect(controller.recover('chat', 1)).rejects.toMatchObject({ code: 'CHAT_RECOVERY_FAILED' });
  expect(owners.size).toBe(0);
  expect(controller.snapshot()).toMatchObject({ active: 'stopped', nativeSessionId: 'conversation-a' });
});


it('keeps the active runtime interactive while a switch waits, supports cancellation, and transfers only at a verified checkpoint', async () => {
  vi.useFakeTimers();
  const store = storage();
  let ready = false;
  const owners = new Set(['terminal']);
  const driver: RuntimeDriver = {
    preflight: async () => undefined,
    checkpoint: async () => ready ? { ready: true } : { ready: false, reason: 'A tool is still running' },
    release: async (_record, mode) => { owners.delete(mode); },
    acquire: async record => { expect(owners.size).toBe(0); owners.add('chat'); return { nativeSessionId: record.nativeSessionId, historyVerified: true }; },
  };
  try {
    const controller = new SessionController(store, driver);
    await controller.switchTo('chat', 1);
    expect(controller.snapshot().pendingSwitch?.target).toBe('chat');
    expect(() => controller.assertWritable(1)).not.toThrow();
    await controller.switchTo('terminal', 1);
    ready = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect([...owners]).toEqual(['terminal']);
    ready = false;
    await controller.switchTo('chat', 1);
    await vi.advanceTimersByTimeAsync(500);
    expect([...owners]).toEqual(['terminal']);
    ready = true;
    await vi.advanceTimersByTimeAsync(500);
    expect([...owners]).toEqual(['chat']);
    expect(controller.snapshot()).toMatchObject({ active: 'chat', generation: 2, nativeSessionId: original.nativeSessionId });
    expect(controller.snapshot().pendingSwitch).toBeUndefined();
  } finally { vi.useRealTimers(); }
});
