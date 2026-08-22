import { installControlConsoleRuntime } from "./control-console-runtime";
import { installDownstreamAwareFetch } from "./downstream-abort";

// Install request-scoped cancellation first, then the control-console runtime.
// The runtime patches `http.createServer` before server.ts is imported, and
// server.ts resolves `http.createServer` through the module object at call time,
// so the patched listener wraps the real server on both Node and Bun. This adds
// the authenticated management routes and request metadata logging without
// duplicating the main API router.
installDownstreamAwareFetch();
installControlConsoleRuntime();

await import("./server");
