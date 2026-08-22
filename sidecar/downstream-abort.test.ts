import { afterEach, describe, expect, test } from "bun:test";

import {
  combineAbortSignals,
  installDownstreamAwareFetch,
  runWithDownstreamSignal
} from "./downstream-abort";

const originalFetch = globalThis.fetch;
const marker = Symbol.for("cursor2api.downstreamAwareFetch");

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[marker];
});

describe("downstream abort propagation", () => {
  test("combined signal aborts when either source aborts", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals(first.signal, second.signal);

    expect(combined?.aborted).toBe(false);
    second.abort(new Error("downstream closed"));
    expect(combined?.aborted).toBe(true);
  });

  test("fetch started in a downstream context inherits the disconnect signal", async () => {
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response("ok");
    }) as typeof globalThis.fetch;

    installDownstreamAwareFetch();

    const downstream = new AbortController();
    await runWithDownstreamSignal(downstream.signal, () => fetch("http://example.test"));

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    downstream.abort(new Error("client disconnected"));
    expect(observedSignal?.aborted).toBe(true);
  });

  test("preserves an existing fetch abort signal", async () => {
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response("ok");
    }) as typeof globalThis.fetch;

    installDownstreamAwareFetch();

    const downstream = new AbortController();
    const timeout = new AbortController();
    await runWithDownstreamSignal(downstream.signal, () =>
      fetch("http://example.test", { signal: timeout.signal })
    );

    timeout.abort(new Error("timeout"));
    expect(observedSignal?.aborted).toBe(true);
  });
});
