import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestLogStore } from "./request-log";
import { CursorCredentialPool, encryptValue } from "./router";
import { writePrivateJsonAtomic } from "./secure-state";

function makeEntry(overrides: Partial<{
  id: string;
  timestamp: string;
  model: string;
  credentialId: string;
  credentialLabel: string;
  result: "completed" | "failed" | "canceled";
  durationMs: number;
}> = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    timestamp: overrides.timestamp || new Date().toISOString(),
    method: "POST",
    path: "/v1/responses",
    model: overrides.model || "grok-4.6",
    streaming: true,
    clientKeyId: "key_1",
    clientKeyLabel: "client",
    clientKeyHint: "abc123",
    credentialId: overrides.credentialId || "cred_1",
    credentialLabel: overrides.credentialLabel || "团队账号",
    credentialHint: "db54",
    statusCode: 200,
    result: overrides.result || "completed",
    durationMs: overrides.durationMs ?? 120,
    firstByteMs: 20
  };
}

describe("chunked reverse log reader", () => {
  test("parses multi-byte lines correctly across 256KB chunk boundaries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-chunked-"));
    const store = new RequestLogStore({ directory, cleanupIntervalMs: 60_000 });
    const base = Date.UTC(2026, 7, 22, 0, 0, 0);
    // ~250 bytes per line with CJK labels; 3000 lines ≈ 750KB spans several
    // 256KB chunks. The file is written directly: the read path is what's tested.
    const lines: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      lines.push(JSON.stringify(makeEntry({
        id: `chunked-${index}`,
        timestamp: new Date(base + index * 1000).toISOString(),
        model: index % 3 === 0 ? "claude-4.6-sonnet" : "grok-4.6",
        durationMs: index
      })));
    }
    writeFileSync(join(directory, "requests.jsonl"), `${lines.join("\n")}\n`);

    const first = await store.list({ limit: 10 });
    expect(first.data.map((item) => item.id)).toEqual([
      "chunked-2999", "chunked-2998", "chunked-2997", "chunked-2996", "chunked-2995",
      "chunked-2994", "chunked-2993", "chunked-2992", "chunked-2991", "chunked-2990"
    ]);
    expect(first.hasMore).toBe(true);
    // Multi-byte label must survive chunk reassembly intact.
    expect(first.data[0].credentialLabel).toBe("团队账号");

    const filtered = await store.list({ limit: 50, model: "claude-4.6-sonnet" });
    expect(filtered.data).toHaveLength(50);
    expect(filtered.data.every((item) => item.model === "claude-4.6-sonnet")).toBe(true);
    expect(filtered.data[0].id).toBe("chunked-2997");
    expect(filtered.hasMore).toBe(true);

    const summary = await store.usageSummary();
    expect(summary.retainedRequests).toBe(3000);
    expect(summary.completed).toBe(3000);
    expect(summary.lastRequestAt).toBe(new Date(base + 2999 * 1000).toISOString());
    const perCredential = summary.byCredential.find((item) => item.credentialId === "cred_1");
    expect(perCredential?.requests).toBe(3000);
    expect(perCredential?.credentialLabel).toBe("团队账号");
    store.close();
  });
});

describe("cross-process credential pool mutations", () => {
  test("a mutation written behind our back is visible and preserved by later local mutations", () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-xproc-"));
    const statePath = join(directory, "router.json");
    const key = createHash("sha256").update("secret").digest();

    const parent = new CursorCredentialPool([], statePath, "secret");

    // Simulate a second OS process persisting its own credential to the shared
    // state file (the exact byte layout persist() produces).
    writePrivateJsonAtomic(statePath, {
      version: 2,
      disabledModels: {},
      disabledCredentials: {},
      credentials: [{ id: "cred_child", label: "child", secret: encryptValue("child-key-0000000001", key) }]
    });

    // The file changed behind our back; any local mutation must first reload
    // it, keeping the foreign credential instead of overwriting the file with
    // our stale (empty) snapshot.
    parent.addCredential("parent-key-000000001", "parent");

    expect(parent.credentials.some((item) => item.label === "parent")).toBe(true);
    expect(parent.credentials.some((item) => item.label === "child")).toBe(true);

    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { credentials: unknown[] };
    expect(onDisk.credentials).toHaveLength(2);

    parent.disableCredential(parent.credentials.find((item) => item.label === "child")!.id);
    const afterDisable = JSON.parse(readFileSync(statePath, "utf8")) as { credentials: unknown[]; disabledCredentials: Record<string, string> };
    expect(afterDisable.credentials).toHaveLength(2);
    expect(Object.keys(afterDisable.disabledCredentials)).toHaveLength(1);
  });
});
