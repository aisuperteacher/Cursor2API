import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

import {
  bindDownstreamAbort,
  installDownstreamAwareFetch,
  runWithDownstreamSignal
} from "./downstream-abort";

installDownstreamAwareFetch();

const originalCreateServer = http.createServer.bind(http);

http.createServer = ((optionsOrListener?: unknown, maybeListener?: unknown) => {
  const hasOptions = typeof optionsOrListener !== "function";
  const listener = (hasOptions ? maybeListener : optionsOrListener) as
    | ((request: http.IncomingMessage, response: http.ServerResponse) => void)
    | undefined;

  const wrappedListener = listener
    ? (request: http.IncomingMessage, response: http.ServerResponse) => {
        const controller = new AbortController();
        bindDownstreamAbort(request, response, controller, (reason) => {
          console.info(JSON.stringify({
            event: "downstream_disconnect",
            reason,
            method: request.method || "",
            path: request.url || ""
          }));
        });
        runWithDownstreamSignal(controller.signal, () => listener(request, response));
      }
    : undefined;

  if (hasOptions) {
    return originalCreateServer(optionsOrListener as http.ServerOptions, wrappedListener);
  }
  return originalCreateServer(wrappedListener);
}) as typeof http.createServer;

syncBuiltinESMExports();

await import("./server");
