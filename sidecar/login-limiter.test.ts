import { describe, expect, test } from "bun:test";
import { LoginAttemptLimiter } from "./login-limiter";

describe("administrator login limiter", () => {
  test("locks an identity after repeated failures and resets on success", () => {
    let now = 0;
    const limiter = new LoginAttemptLimiter(3, 60_000, 30_000, () => now);
    expect(limiter.recordFailure("client")).toBe(0);
    expect(limiter.recordFailure("client")).toBe(0);
    expect(limiter.recordFailure("client")).toBe(30);
    expect(limiter.retryAfterSeconds("client")).toBe(30);
    now = 30_001;
    expect(limiter.retryAfterSeconds("client")).toBe(0);
    expect(limiter.recordFailure("client")).toBe(0);
    limiter.reset("client");
    expect(limiter.retryAfterSeconds("client")).toBe(0);
  });
});
