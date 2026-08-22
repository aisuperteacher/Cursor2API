import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAuthStore, sessionTokenFromCookie } from "./auth";
import { fetchCursorAdminUsage } from "./cursor-admin";
import { RequestLogStore, type RequestLogEntry } from "./request-log";
import { CursorCredentialPool } from "./router";

function requestEntry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: overrides.id || crypto.randomUUID(),
    timestamp: overrides.timestamp || new Date().toISOString(),
    method: overrides.method || "POST",
    path: overrides.path || "/v1/responses",
    model: overrides.model || "grok-4.6",
    streaming: overrides.streaming ?? true,
    clientKeyId: overrides.clientKeyId || "key_1",
    clientKeyLabel: overrides.clientKeyLabel || "client",
    clientKeyHint: overrides.clientKeyHint || "abc123",
    credentialId: overrides.credentialId || "cred_1",
    credentialLabel: overrides.credentialLabel || "team",
    credentialHint: overrides.credentialHint || "db54",
    statusCode: overrides.statusCode ?? 200,
    result: overrides.result || "completed",
    durationMs: overrides.durationMs ?? 120,
    firstByteMs: overrides.firstByteMs ?? 20,
    ...overrides
  };
}

describe("control console credential management", () => {
  test("separates disable, enable, and permanent deletion", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-manage-")), "router.json");
    const pool = new CursorCredentialPool([{ apiKey: "env-key", label: "env" }], statePath, "secret");
    const managed = pool.addCredential("managed-key", "managed");

    expect(pool.disableCredential(managed.id)).toBe(true);
    expect(managed.status).toBe("disabled");
    expect(pool.enableCredential(managed.id)).toBe(true);
    expect(managed.status).toBe("active");
    expect(pool.deleteCredential(managed.id)).toBe("deleted");
    expect(pool.credentials.some((item) => item.id === managed.id)).toBe(false);
    expect(readFileSync(statePath, "utf8")).not.toContain("managed-key");
  });

  test("does not pretend to delete environment-backed credentials", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-env-")), "router.json");
    const pool = new CursorCredentialPool([{ apiKey: "env-key", label: "env" }], statePath, "secret");
    expect(pool.credentials[0].environment).toBe(true);
    expect(pool.deleteCredential(pool.credentials[0].id)).toBe("unmanaged");

    pool.addCredential("env-key", "persisted duplicate");
    expect(pool.credentials[0].managed).toBe(true);
    expect(pool.credentials[0].environment).toBe(true);
    expect(pool.deleteCredential(pool.credentials[0].id)).toBe("unmanaged");
  });

  test("shares live mutations between runtime and server pool instances", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "cursor2api-shared-pool-")), "router.json");
    const first = new CursorCredentialPool([{ apiKey: "one" }], statePath, "secret");
    const second = new CursorCredentialPool([{ apiKey: "one" }], statePath, "secret");
    const managed = first.addCredential("managed", "managed");
    expect(second.credentials.some((item) => item.id === managed.id)).toBe(true);
    second.disableCredential(managed.id);
    expect(first.credentials.find((item) => item.id === managed.id)?.status).toBe("disabled");
  });
});

describe("shared local authentication state", () => {
  test("shares sessions and client-key mutations across store instances", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cursor2api-auth-shared-")), "auth.json");
    const first = new LocalAuthStore(path);
    const session = first.setup("administrator-password")!;
    const second = new LocalAuthStore(path);
    expect(second.isSessionValid(session)).toBe(true);

    const created = second.createClientKey("runtime");
    expect(first.resolveClientKey(created.token)?.label).toBe("runtime");
    expect(first.revokeClientKey(created.info.id)).toBe(true);
    expect(second.resolveClientKey(created.token)).toBeNull();
  });

  test("parses administrator cookies without constructing a Web Request", () => {
    expect(sessionTokenFromCookie("a=1; cursor2api_session=hello%20world; b=2")).toBe("hello world");
    expect(sessionTokenFromCookie("a=1")).toBe("");
  });
});

describe("bounded request logs", () => {
  test("appends, filters, and summarizes metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-logs-"));
    const store = new RequestLogStore({ directory, cleanupIntervalMs: 60_000 });
    await store.append(requestEntry({ id: "one", result: "completed", durationMs: 100 }));
    await store.append(requestEntry({ id: "two", result: "failed", statusCode: 502, durationMs: 500, model: "claude-4.6-sonnet" }));
    await store.append(requestEntry({ id: "three", result: "canceled", statusCode: 499, credentialId: "cred_2", credentialLabel: "backup" }));

    expect((await store.list({ result: "failed", limit: 10 })).data.map((item) => item.id)).toEqual(["two"]);
    const summary = await store.usageSummary();
    expect(summary.retainedRequests).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.canceled).toBe(1);
    expect(summary.byCredential.find((item) => item.credentialId === "cred_1")?.requests).toBe(2);
    store.close();
  });

  test("rotates files, enforces hard limits, and clears retained logs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-rotate-"));
    const store = new RequestLogStore({
      directory,
      maxFileBytes: 220,
      maxFiles: 3,
      maxTotalBytes: 2_000,
      cleanupIntervalMs: 60_000
    });
    for (let index = 0; index < 12; index += 1) {
      await store.append(requestEntry({ id: `request-${index}`, model: `model-${index}`, durationMs: index }));
    }
    await store.cleanup();
    const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(3);
    expect((await store.stats()).totalBytes).toBeLessThanOrEqual(2_000);
    await store.clear();
    expect((await store.list()).data).toHaveLength(0);
    store.close();
  });

  test("runs retention cleanup periodically even without new requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-periodic-cleanup-"));
    let now = Date.now();
    const store = new RequestLogStore({
      directory,
      retentionDays: 1,
      maxFileBytes: 220,
      maxFiles: 10,
      maxTotalBytes: 10_000,
      cleanupIntervalMs: 20,
      now: () => now
    });
    for (let index = 0; index < 4; index += 1) {
      await store.append(requestEntry({ id: `periodic-${index}`, model: `model-${index}` }));
    }
    expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length).toBeGreaterThan(1);
    now += 2 * 24 * 60 * 60 * 1000;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    store.close();
  });
});

describe("Cursor Admin API usage integration", () => {
  test("reports an unconfigured state without making requests", async () => {
    let calls = 0;
    const result = await fetchCursorAdminUsage({
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch
    });
    expect(result).toEqual({ configured: false });
    expect(calls).toBe(0);
  });

  test("uses Basic auth and returns spending plus usage events", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      return new Response(JSON.stringify(input.toString().endsWith("/teams/spend")
        ? { total: 42 }
        : { usageEvents: [{ model: "grok-4.6" }] }), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCursorAdminUsage({ apiKey: "key_secret", fetchImpl, now: () => 1_800_000_000_000 });
    expect(result.spend).toEqual({ total: 42 });
    expect(result.usageEvents).toEqual({ usageEvents: [{ model: "grok-4.6" }] });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("authorization"))
        .toBe(`Basic ${Buffer.from("key_secret:").toString("base64")}`);
      expect(String(request.init?.body)).not.toContain("key_secret");
    }
  });

  test("returns safe errors without exposing the admin key", async () => {
    const result = await fetchCursorAdminUsage({
      apiKey: "key_do_not_leak",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })) as typeof fetch
    });
    expect(result.error).toContain("forbidden");
    expect(result.error).not.toContain("key_do_not_leak");
  });
});
