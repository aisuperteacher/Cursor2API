import { installControlConsoleRuntime } from "./control-console-runtime";
import { installDownstreamAwareFetch } from "./downstream-abort";

// Install request-scoped cancellation first, then the control-console runtime.
// The runtime patches node:http before server.ts imports its named createServer
// binding, allowing authenticated management routes and request metadata logging
// without duplicating the main API router.
installDownstreamAwareFetch();
installControlConsoleRuntime();

await import("./server");
