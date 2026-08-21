interface LoginAttemptState {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export class LoginAttemptLimiter {
  private readonly attempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockoutMs = 15 * 60 * 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  retryAfterSeconds(identity: string): number {
    const state = this.attempts.get(identity);
    if (!state) return 0;
    const now = this.now();
    if (state.blockedUntil > now) return Math.max(1, Math.ceil((state.blockedUntil - now) / 1000));
    if (state.blockedUntil > 0 || now - state.windowStartedAt >= this.windowMs) {
      this.attempts.delete(identity);
    }
    return 0;
  }

  recordFailure(identity: string): number {
    const now = this.now();
    const current = this.attempts.get(identity);
    const state = !current || now - current.windowStartedAt >= this.windowMs
      ? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
      : current;
    state.failures += 1;
    if (state.failures >= this.maxFailures) state.blockedUntil = now + this.lockoutMs;
    this.attempts.set(identity, state);
    return this.retryAfterSeconds(identity);
  }

  reset(identity: string): void {
    this.attempts.delete(identity);
  }
}
