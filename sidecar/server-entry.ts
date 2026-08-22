import http from "node:http";

import {
  bindDownstreamAbort,
  installDownstreamAwareFetch,
  runWithDownstreamSignal
} from "./downstream-abort";

installDownstreamAwareFetch();

// `server.ts` imports `createServer` as a named builtin binding. Replacing
// `http.createServer` from this entry module is not reliable once Bun has bundled
// that import, so bind cancellation at the stable boundary instead: the HTTP
// server's request-event dispatch. This runs before any request handler code and
// therefore propagates the request-scoped AbortSignal through the full async
// chain via AsyncLocalStorage.
const originalServerEmit = http.Server.prototype.emit;

http.Server.prototype.emit = function patchedServerEmit(
  event: string | symbol,
  ...args: unknown[]
): boolean {
  if (event !== "request") {
    return originalServerEmit.call(this, event, ...args);
  }

  const request = args[0] as http.IncomingMessage | undefined;
  const response = args[1] as http.ServerResponse | undefined;
  if (!request || !response) {
    return originalServerEmit.call(this, event, ...args);
  }

  const controller = new AbortController();
  bindDownstreamAbort(request, response, controller, (reason) => {
    console.info(JSON.stringify({
      event: "downstream_disconnect",
      reason,
      method: request.method || "",
      path: request.url || ""
    }));
  });

  return runWithDownstreamSignal(controller.signal, () =>
    originalServerEmit.call(this, event, ...args)
  );
};

await import("./server");
