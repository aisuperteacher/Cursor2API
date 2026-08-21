import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAuthStore, sessionCookie } from "./auth";

describe("local auth store", () => {
  test("persists client key hashes and revokes keys", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-auth-")), "auth.json");
    const store = new LocalAuthStore(statePath);
    const session = store.setup("administrator-password");
    expect(session).toBeTruthy();
    expect(store.isSessionValid(session!)).toBe(true);

    const created = store.createClientKey("verification");
    expect(created.token).toStartWith("sk-");
    expect(store.clientKey(created.token)).toBe(true);

    const restored = new LocalAuthStore(statePath);
    expect(restored.isConfigured()).toBe(true);
    expect(restored.clientKey(created.token)).toBe(true);
    expect(restored.revokeClientKey(created.info.id)).toBe(true);
    expect(restored.clientKey(created.token)).toBe(false);
  });

  test("fails closed when an existing auth state file is corrupted", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-auth-corrupt-")), "auth.json");
    writeFileSync(statePath, "{not-json", "utf8");
    expect(() => new LocalAuthStore(statePath)).toThrow("not valid JSON");
  });

  test("adds Secure to administrator cookies when TLS is active", () => {
    expect(sessionCookie("token", 60, true)).toContain("; Secure");
    expect(sessionCookie("token", 60, false)).not.toContain("; Secure");
  });

});
