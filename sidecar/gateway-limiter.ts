import { createHash } from "node:crypto";

/**
 * Owner-tunable rate limiting for the public `/v1` surface.
 *
 * Two independent guards, both optional:
 *   - `maxFailuresPerIp`: throttles anonymous probing (repeated 401s) per client IP.
 *   - `maxRequestsPerKey`: caps how much traffic a single client key may push.
 *
 * Defaults are deliberately permissive and `enabled` is false, so upgrading an
 * existing deployment never starts rejecting traffic until the owner opts in from
 * the control console.
 */
export interface RateLimitConfig {
  enabled: boolean;
  /** Rolling window length for both counters. */
  windowSeconds: number;
  /** Failed-authentication attempts per IP per window. 0 disables this guard. */
  maxFailuresPerIp: number;
  /** Successful requests per client key per window. 0 disables this guard. */
  maxRequestsPerKey: number;
  /** How long a tripped counter keeps returning 429. */
  blockSeconds: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: false,
  windowSeconds: 60,
  maxFailuresPerIp: 30,
  maxRequestsPerKey: 0,
  blockSeconds: 300
};

const LIMITS = {
  windowSeconds: { min: 1, max: 3_600 },
  maxFailuresPerIp: { min: 0, max: 100_000 },
  maxRequestsPerKey: { min: 0, max: 10_000_000 },
  blockSeconds: { min: 0, max: 86_400 }
} as const;

/** Bound on tracked identities: the IP key is attacker-influenced, so it cannot grow freely. */
const MAX_TRACKED_ENTRIES = 20_000;

export type RateLimitReason = "ip_failures" | "key_quota";

export interface RateLimitDecision {
  retryAfterSeconds: number;
  reason?: RateLimitReason;
}

interface CounterState {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
  touchedAt: number;
}

/** A counter map plus the amortization counter that paces its cleanup sweeps. */
interface CounterBucket {
  entries: Map<string, CounterState>;
  opsSincePrune: number;
}

/** Sweep at most once every N accounted requests, so cleanup stays amortized O(1). */
const PRUNE_INTERVAL_OPS = 512;

function createBucket(): CounterBucket {
  return { entries: new Map<string, CounterState>(), opsSincePrune: 0 };
}

function clampInteger(value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

/** Normalize untrusted input (console form, persisted state) into a usable config. */
export function normalizeRateLimitConfig(value: unknown): RateLimitConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof RateLimitConfig, unknown>>;
  return {
    enabled: raw.enabled === true || raw.enabled === "true",
    windowSeconds: clampInteger(raw.windowSeconds, LIMITS.windowSeconds, DEFAULT_RATE_LIMIT.windowSeconds),
    maxFailuresPerIp: clampInteger(raw.maxFailuresPerIp, LIMITS.maxFailuresPerIp, DEFAULT_RATE_LIMIT.maxFailuresPerIp),
    maxRequestsPerKey: clampInteger(raw.maxRequestsPerKey, LIMITS.maxRequestsPerKey, DEFAULT_RATE_LIMIT.maxRequestsPerKey),
    blockSeconds: clampInteger(raw.blockSeconds, LIMITS.blockSeconds, DEFAULT_RATE_LIMIT.blockSeconds)
  };
}

function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
}

export class GatewayRateLimiter {
  private readonly failures = createBucket();
  private readonly keyUsage = createBucket();

  /**
   * @param config read lazily so console edits apply to the next request without
   *   restarting the server or re-creating the limiter.
   */
  constructor(
    private readonly config: () => RateLimitConfig,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Account for one `/v1` request and report whether it must be rejected.
   * Authorized requests count against the key quota; unauthorized ones count as
   * probing against the IP.
   */
  evaluate(input: { identity: string; apiKey: string; authorized: boolean }): RateLimitDecision {
    const config = this.config();
    if (!config.enabled) return { retryAfterSeconds: 0 };
    const windowMs = config.windowSeconds * 1000;
    const blockMs = config.blockSeconds * 1000;

    if (!input.authorized) {
      if (config.maxFailuresPerIp <= 0) return { retryAfterSeconds: 0 };
      const identity = input.identity || "unknown";
      const retryAfterSeconds = this.record(this.failures, identity, config.maxFailuresPerIp, windowMs, blockMs);
      return retryAfterSeconds > 0 ? { retryAfterSeconds, reason: "ip_failures" } : { retryAfterSeconds: 0 };
    }

    if (config.maxRequestsPerKey <= 0 || !input.apiKey) return { retryAfterSeconds: 0 };
    const retryAfterSeconds = this.record(
      this.keyUsage,
      keyFingerprint(input.apiKey),
      config.maxRequestsPerKey,
      windowMs,
      blockMs
    );
    return retryAfterSeconds > 0 ? { retryAfterSeconds, reason: "key_quota" } : { retryAfterSeconds: 0 };
  }

  /** Drop counters for one identity (e.g. after the owner raises a limit). */
  reset(): void {
    this.failures.entries.clear();
    this.failures.opsSincePrune = 0;
    this.keyUsage.entries.clear();
    this.keyUsage.opsSincePrune = 0;
  }

  private record(
    bucket: CounterBucket,
    identity: string,
    max: number,
    windowMs: number,
    blockMs: number
  ): number {
    const store = bucket.entries;
    const now = this.now();
    const existing = store.get(identity);

    if (existing && existing.blockedUntil > now) {
      existing.touchedAt = now;
      return Math.max(1, Math.ceil((existing.blockedUntil - now) / 1000));
    }

    const state: CounterState = !existing || existing.blockedUntil > 0 || now - existing.windowStartedAt >= windowMs
      ? { count: 0, windowStartedAt: now, blockedUntil: 0, touchedAt: now }
      : existing;
    state.count += 1;
    state.touchedAt = now;
    if (state.count > max) {
      // blockSeconds may be 0: then rejection lasts only for the rest of the window.
      state.blockedUntil = now + (blockMs > 0 ? blockMs : Math.max(0, windowMs - (now - state.windowStartedAt)));
    }
    store.set(identity, state);
    this.prune(bucket, now, windowMs);
    return state.blockedUntil > now ? Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)) : 0;
  }

  private prune(bucket: CounterBucket, now: number, windowMs: number): void {
    bucket.opsSincePrune += 1;
    if (bucket.opsSincePrune < PRUNE_INTERVAL_OPS) return;
    bucket.opsSincePrune = 0;

    const store = bucket.entries;
    for (const [identity, state] of store) {
      if (state.blockedUntil <= now && now - state.windowStartedAt >= windowMs) store.delete(identity);
    }
    if (store.size <= MAX_TRACKED_ENTRIES) return;
    // Still oversized (sustained distributed probing): evict least recently touched.
    const ordered = [...store.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [identity] of ordered.slice(0, store.size - MAX_TRACKED_ENTRIES)) store.delete(identity);
  }
}
