import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryCycle } from '../../../shared/remoteClient/recoveryCycle';

afterEach(() => vi.useRealTimers());

describe('remote recovery deadline', () => {
  it('keeps one five-minute budget through failed restoration and stops after sleep', () => {
    vi.useFakeTimers();
    const cycle = new RecoveryCycle(() => 0.5);
    expect(cycle.nextDelay()).toBe(1000);
    vi.advanceTimersByTime(45_000);
    expect(cycle.nextDelay()).toBe(2000);
    vi.advanceTimersByTime(254_000);
    expect(cycle.nextDelay()).toBe(1000);
    vi.advanceTimersByTime(1000);
    expect(cycle.nextDelay()).toBeNull();
    cycle.reset();
    expect(cycle.nextDelay()).toBe(1000);
  });

  it('caps exponential delays at thirty seconds and bounds jitter by the deadline', () => {
    vi.useFakeTimers();
    const cycle = new RecoveryCycle(() => 0.5);
    expect(Array.from({ length: 7 }, () => cycle.nextDelay())).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
