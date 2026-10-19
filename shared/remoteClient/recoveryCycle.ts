/** One outage budget. A handshake never resets it; only completed restoration does. */
export class RecoveryCycle {
  private deadline: number | null = null;
  private attempt = 0;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly durationMs = 300_000,
    private readonly initialDelayMs = 1_000,
    private readonly maxDelayMs = 30_000,
  ) {}

  get remainingMs(): number {
    this.deadline ??= Date.now() + this.durationMs;
    return Math.max(0, this.deadline - Date.now());
  }

  nextDelay(): number | null {
    const remaining = this.remainingMs;
    if (!remaining) return null;
    const base = Math.min(this.initialDelayMs * 2 ** this.attempt++, this.maxDelayMs);
    return Math.min(remaining, this.maxDelayMs, Math.round(base * (0.8 + this.random() * 0.4)));
  }

  reset(): void {
    this.deadline = null;
    this.attempt = 0;
  }
}
