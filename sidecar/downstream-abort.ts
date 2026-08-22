import { AsyncLocalStorage } from "node:async_hooks";

const downstreamSignalContext = new AsyncLocalStorage<AbortSignal>();

export function combineAbortSignals(
  first?: AbortSignal | null,
  second?: AbortSignal | null
): AbortSignal | undefined {
  if (!first) return second ?? undefined;
  if (!second) return first;
  if (first === second) return first;

  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === "function") return any([first, second]);

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (first.aborted) abortFrom(first);
  else first.addEventListener("abort", () => abortFrom(first), { once: true });
  if (second.aborted) abortFrom(second);
  else second.addEventListener("abort", () => abortFrom(second), { once: true });
  return controller.signal;
}

export function runWithDownstreamSignal<T>(signal: AbortSignal, run: () => T): T {
  return downstreamSignalContext.run(signal, run);
}

export function installDownstreamAwareFetch(): void {
  const marker = Symbol.for("cursor2api.downstreamAwareFetch");
  const globalRecord = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  if (globalRecord[marker]) return;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const downstreamSignal = downstreamSignalContext.getStore();
    if (!downstreamSignal) return nativeFetch(input, init);
    return nativeFetch(input, {
      ...init,
      signal: combineAbortSignals(init?.signal, downstreamSignal)
    });
  }) as typeof globalThis.fetch;
  globalRecord[marker] = true;
}
