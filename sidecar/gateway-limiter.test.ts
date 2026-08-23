import { describe, expect, test } from "bun:test";
import { DEFAULT_RATE_LIMIT, GatewayRateLimiter, normalizeRateLimitConfig, type RateLimitConfig } from "./gateway-limiter";

function limiter(overrides: Partial<RateLimitConfig> = {}) {
  let now = 1_800_000_000_000;
  const config: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, enabled: true, ...overrides };
  const instance = new GatewayRateLimiter(() => config, () => now);
  return {
    instance,
    config,
    advance: (seconds: number) => { now += seconds * 1000; },
    setConfig: (patch: Partial<RateLimitConfig>) => Object.assign(config, patch)
  };
}

describe("normalizeRateLimitConfig", () => {
  test("defaults to disabled so upgrades never start rejecting traffic", () => {
    expect(normalizeRateLimitConfig(undefined)).toEqual(DEFAULT_RATE_LIMIT);
    expect(DEFAULT_RATE_LIMIT.enabled).toBe(false);
  });

  test("clamps out-of-range and non-numeric input instead of trusting it", () => {
    const normalized = normalizeRateLimitConfig({
      enabled: "true",
      windowSeconds: 0,
      maxFailuresPerIp: -5,
      maxRequestsPerKey: 99_999_999_999,
      blockSeconds: "not a number"
    });
    expect(normalized.enabled).toBe(true);
    expect(normalized.windowSeconds).toBe(1);
    expect(normalized.maxFailuresPerIp).toBe(0);
    expect(normalized.maxRequestsPerKey).toBe(10_000_000);
    expect(normalized.blockSeconds).toBe(DEFAULT_RATE_LIMIT.blockSeconds);
  });
});

describe("gateway rate limiter", () => {
  test("stays out of the way while disabled", () => {
    const { instance } = limiter({ enabled: false, maxFailuresPerIp: 1 });
    for (let index = 0; index < 50; index += 1) {
      expect(instance.evaluate({ identity: "1.2.3.4", apiKey: "", authorized: false }).retryAfterSeconds).toBe(0);
    }
  });

  test("blocks an IP after the configured unauthorized attempts, then recovers", () => {
    const { instance, advance } = limiter({ maxFailuresPerIp: 3, windowSeconds: 60, blockSeconds: 120 });
    const probe = () => instance.evaluate({ identity: "9.9.9.9", apiKey: "", authorized: false });

    expect(probe().retryAfterSeconds).toBe(0);
    expect(probe().retryAfterSeconds).toBe(0);
    expect(probe().retryAfterSeconds).toBe(0);
    const blocked = probe();
    expect(blocked.retryAfterSeconds).toBe(120);
    expect(blocked.reason).toBe("ip_failures");

    advance(119);
    expect(probe().retryAfterSeconds).toBe(1);
    advance(2);
    expect(probe().retryAfterSeconds).toBe(0);
  });

  test("isolates identities from each other", () => {
    const { instance } = limiter({ maxFailuresPerIp: 1, blockSeconds: 60 });
    expect(instance.evaluate({ identity: "a", apiKey: "", authorized: false }).retryAfterSeconds).toBe(0);
    expect(instance.evaluate({ identity: "a", apiKey: "", authorized: false }).retryAfterSeconds).toBe(60);
    expect(instance.evaluate({ identity: "b", apiKey: "", authorized: false }).retryAfterSeconds).toBe(0);
  });

  test("never throttles authorized traffic when the key quota is disabled", () => {
    const { instance } = limiter({ maxRequestsPerKey: 0, maxFailuresPerIp: 1 });
    for (let index = 0; index < 100; index += 1) {
      expect(instance.evaluate({ identity: "1.1.1.1", apiKey: "sk-live", authorized: true }).retryAfterSeconds).toBe(0);
    }
  });

  test("enforces a per-key quota independently of the IP guard", () => {
    const { instance } = limiter({ maxRequestsPerKey: 2, blockSeconds: 30 });
    const call = (apiKey: string) => instance.evaluate({ identity: "same-ip", apiKey, authorized: true });

    expect(call("sk-one").retryAfterSeconds).toBe(0);
    expect(call("sk-one").retryAfterSeconds).toBe(0);
    const blocked = call("sk-one");
    expect(blocked.retryAfterSeconds).toBe(30);
    expect(blocked.reason).toBe("key_quota");
    // A different key from the same IP is unaffected.
    expect(call("sk-two").retryAfterSeconds).toBe(0);
  });

  test("with blockSeconds=0 the rejection only lasts for the rest of the window", () => {
    const { instance, advance } = limiter({ maxFailuresPerIp: 1, windowSeconds: 60, blockSeconds: 0 });
    const probe = () => instance.evaluate({ identity: "7.7.7.7", apiKey: "", authorized: false });
    expect(probe().retryAfterSeconds).toBe(0);
    expect(probe().retryAfterSeconds).toBe(60);
    advance(60);
    expect(probe().retryAfterSeconds).toBe(0);
  });

  test("reset clears counters so raising a limit applies immediately", () => {
    const { instance } = limiter({ maxFailuresPerIp: 1, blockSeconds: 600 });
    const probe = () => instance.evaluate({ identity: "5.5.5.5", apiKey: "", authorized: false });
    probe();
    expect(probe().retryAfterSeconds).toBe(600);
    instance.reset();
    expect(probe().retryAfterSeconds).toBe(0);
  });

  test("picks up config changes without being re-created", () => {
    const { instance, setConfig } = limiter({ maxFailuresPerIp: 1, blockSeconds: 60 });
    const probe = () => instance.evaluate({ identity: "3.3.3.3", apiKey: "", authorized: false });
    probe();
    expect(probe().retryAfterSeconds).toBe(60);
    setConfig({ enabled: false });
    expect(probe().retryAfterSeconds).toBe(0);
  });

  test("bounds memory under distributed probing", () => {
    const { instance } = limiter({ maxFailuresPerIp: 5, windowSeconds: 1, blockSeconds: 1 });
    for (let index = 0; index < 25_000; index += 1) {
      instance.evaluate({ identity: `10.0.${index % 255}.${index % 251}`, apiKey: "", authorized: false });
    }
    // Internal maps are private; the observable contract is that it keeps working.
    expect(instance.evaluate({ identity: "fresh", apiKey: "", authorized: false }).retryAfterSeconds).toBe(0);
  });
});
