import { installDownstreamAwareFetch } from "./downstream-abort";

// Install the request-context-aware fetch wrapper before loading the server.
// The actual downstream disconnect binding lives directly in server.ts so it
// cannot be bypassed by Bun's compile-time handling of node:http imports.
installDownstreamAwareFetch();

await import("./server");
