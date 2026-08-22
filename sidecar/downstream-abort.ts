import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

const downstreamSignalContext = new AsyncLocalStorage<AbortSignal>();

export type DownstreamDisconnectReason = "response_close" | "request_aborted" | "socket_close";

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

/**
 * Bind a request-scoped AbortController to every reliable downstream disconnect
 * signal exposed by node:http. `ServerResponse.close` is not emitted consistently
 * when a client disconnects before response headers are flushed, so the underlying
 * socket close is the authoritative fallback. Listeners are removed on normal
 * response completion to avoid leaking onto keep-alive sockets.
 */
export function bindDownstreamAbort(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
  onDisconnect?: (reason: DownstreamDisconnectReason) => void
): () => void {
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    response.off("close", onResponseClose);
    response.off("finish", onResponseFinish);
    request.off("aborted", onRequestAborted);
    request.socket.off("close", onSocketClose);
  };

  const abortDownstream = (reason: DownstreamDisconnectReason) => {
    // A keep-alive socket may close after a response completed normally. That is
    // not a cancellation signal for the already-finished request.
    if (response.writableEnded) {
      cleanup();
      return;
    }

    if (!controller.signal.aborted) {
      controller.abort(new Error("downstream client disconnected"));
      onDisconnect?.(reason);
    }
    cleanup();
  };

  const onResponseClose = () => abortDownstream("response_close");
  const onResponseFinish = () => cleanup();
  const onRequestAborted = () => abortDownstream("request_aborted");
  const onSocketClose = () => abortDownstream("socket_close");

  response.once("close", onResponseClose);
  response.once("finish", onResponseFinish);
  request.once("aborted", onRequestAborted);
  request.socket.once("close", onSocketClose);

  return cleanup;
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
