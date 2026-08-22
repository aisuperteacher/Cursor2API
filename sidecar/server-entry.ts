import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

import {
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
        const abortDownstream = () => {
          if (!controller.signal.aborted) {
            controller.abort(new Error("downstream client disconnected"));
          }
          if (!response.writableEnded) {
            console.info(JSON.stringify({
              event: "downstream_disconnect",
              method: request.method || "",
              path: request.url || ""
            }));
          }
        };
        response.once("close", abortDownstream);
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
