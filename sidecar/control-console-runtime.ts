import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { fetchCursorAdminUsage, type CursorAdminUsageSnapshot } from "./cursor-admin";
import { createAccountUsageFetcher, type AccountUsageSummary } from "./cursor-usage";
import type { Deps, Env } from "../worker/types";
import { LocalAuthStore, sessionTokenFromCookie } from "./auth";
import { RequestLogStore, type RequestLogEntry, type RequestLogQuery } from "./request-log";
import { canonicalModelId, CursorCredentialPool, parseCursorCredentialEnv, type PoolCredential } from "./router";

interface RuntimeRequestContext {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  model?: string;
  reasoningEffort?: string;
  streaming?: boolean;
  clientKeyId?: string;
  clientKeyLabel?: string;
  clientKeyHint?: string;
  credentialId?: string;
  credentialLabel?: string;
  credentialHint?: string;
  firstByteAt?: number;
  responsePreview: string;
  terminalFailure?: boolean;
  terminalErrorCode?: string;
  finalized: boolean;
}

interface CachedModels {
  expiresAt: number;
  models: Array<{ id: string; displayName?: string }>;
}

const runtimeContext = new AsyncLocalStorage<RuntimeRequestContext>();
const installMarker = Symbol.for("cursor2api.controlConsoleRuntime");
const MAX_METADATA_BODY_BYTES = 256 * 1024;
const MAX_ERROR_PREVIEW_BYTES = 4096;
const MODEL_CACHE_TTL_MS = 60_000;
const ADMIN_USAGE_CACHE_TTL_MS = 5 * 60_000;

export interface ControlConsoleRuntime {
  authStore: LocalAuthStore;
  credentialPool: CursorCredentialPool;
  requestLogs: RequestLogStore;
}

export function installControlConsoleRuntime(): ControlConsoleRuntime {
  const globalRecord = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const installed = globalRecord[installMarker] as ControlConsoleRuntime | undefined;
  if (installed) return installed;

  const authStatePath = process.env.LOCAL_AUTH_STATE_PATH?.trim()
    || (process.env.CURSOR_ROUTER_STATE_PATH?.trim() || ".cursor2api/router-state.json") + ".auth";
  const authStore = new LocalAuthStore(authStatePath, process.env.ADMIN_PASSWORD || "");
  const credentialPool = new CursorCredentialPool(
    parseCursorCredentialEnv(process.env.CURSOR_API_KEY || "", process.env.CURSOR_API_KEYS || ""),
    process.env.CURSOR_ROUTER_STATE_PATH?.trim() || undefined,
    process.env.ENCRYPTION_KEY
  );
  const requestLogs = new RequestLogStore({
    enabled: envBoolean("REQUEST_LOG_ENABLED", true),
    directory: process.env.REQUEST_LOG_DIR?.trim() || "/var/lib/api-for-cursor/logs",
    retentionDays: envInteger("REQUEST_LOG_RETENTION_DAYS", 7),
    maxFileBytes: envInteger("REQUEST_LOG_MAX_FILE_BYTES", 10 * 1024 * 1024),
    maxFiles: envInteger("REQUEST_LOG_MAX_FILES", 10),
    maxTotalBytes: envInteger("REQUEST_LOG_MAX_TOTAL_BYTES", 100 * 1024 * 1024),
    cleanupIntervalMs: envInteger("REQUEST_LOG_CLEANUP_INTERVAL_MS", 60 * 60 * 1000)
  });
  const runtime = { authStore, credentialPool, requestLogs };
  globalRecord[installMarker] = runtime;

  const modelCache = new Map<string, CachedModels>();
  let adminUsageCache: { expiresAt: number; value?: CursorAdminUsageSnapshot; promise?: Promise<CursorAdminUsageSnapshot> } = {
    expiresAt: 0
  };
  const downstreamAwareFetch = globalThis.fetch.bind(globalThis);

  // Per-account official quota: exchange the crsr_ key for an access token, then
  // call cursor.com/api/usage-summary. Read-only admin data; cached 60s.
  const usageEnv: Env = {
    ASSETS: undefined,
    DB: undefined,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "api-for-cursor",
    CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: undefined,
    CURSOR_CHAT_ENDPOINT: undefined,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "2.6.22",
    CURSOR_SDK_BRIDGE_URL: undefined,
    CURSOR_SDK_BRIDGE_TOKEN: undefined,
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: undefined
  } as unknown as Env;
  const usageDeps: Deps = {
    fetch: downstreamAwareFetch,
    now: () => new Date(),
    randomUUID: () => crypto.randomUUID()
  };
  const accountUsageFetcher = createAccountUsageFetcher(usageEnv, usageDeps);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    inspectBridgeRequest(runtimeContext.getStore(), input, init, credentialPool);
    return downstreamAwareFetch(input, init);
  }) as typeof globalThis.fetch;

  const nativeCreateServer = http.createServer.bind(http) as (...args: any[]) => ReturnType<typeof http.createServer>;
  const mutableHttp = http as typeof http & { createServer: typeof http.createServer };
  mutableHttp.createServer = ((...args: any[]) => {
    const first = args[0] as unknown;
    const listener = (typeof first === "function" ? first : args[1]) as RequestListener | undefined;
    if (!listener) return nativeCreateServer(...args);
    const options = typeof first === "function" ? undefined : first;
    const wrapped: RequestListener = (request, response) => {
      const url = requestUrl(request);
      if (shouldHandleControlRoute(request.method || "GET", url.pathname)) {
        void handleControlRoute({
          request,
          response,
          url,
          authStore,
          credentialPool,
          requestLogs,
          modelCache,
          fetchImpl: downstreamAwareFetch,
          getAdminUsage: async () => {
            const now = Date.now();
            if (adminUsageCache.value && adminUsageCache.expiresAt > now) return adminUsageCache.value;
            if (adminUsageCache.promise) return adminUsageCache.promise;
            const promise = fetchCursorAdminUsage({
              apiKey: process.env.CURSOR_ADMIN_API_KEY,
              baseUrl: process.env.CURSOR_ADMIN_API_BASE_URL,
              lookbackDays: envInteger("CURSOR_ADMIN_USAGE_LOOKBACK_DAYS", 30),
              timeoutMs: envInteger("CURSOR_ADMIN_API_TIMEOUT_MS", 10_000),
              fetchImpl: downstreamAwareFetch
            }).then((value) => {
              adminUsageCache = { value, expiresAt: Date.now() + ADMIN_USAGE_CACHE_TTL_MS };
              return value;
            }).finally(() => {
              adminUsageCache.promise = undefined;
            });
            adminUsageCache.promise = promise;
            return promise;
          },
          getAccountUsage: (apiKey) => accountUsageFetcher(apiKey)
        }).catch((error) => writeError(response, error));
        return;
      }

      if (!url.pathname.startsWith("/v1")) {
        listener(request, response);
        return;
      }

      const context = createRequestContext(request, response, url.pathname, authStore, requestLogs);
      runtimeContext.run(context, () => listener(request, response));
    };
    return options === undefined
      ? nativeCreateServer(wrapped)
      : nativeCreateServer(options, wrapped);
  }) as typeof http.createServer;
  syncBuiltinESMExports();

  return runtime;
}

interface ControlRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  authStore: LocalAuthStore;
  credentialPool: CursorCredentialPool;
  requestLogs: RequestLogStore;
  modelCache: Map<string, CachedModels>;
  fetchImpl: typeof fetch;
  getAdminUsage: () => Promise<CursorAdminUsageSnapshot>;
  getAccountUsage: (apiKey: string) => Promise<AccountUsageSummary>;
}

async function handleControlRoute(deps: ControlRouteDeps): Promise<void> {
  const { request, response, url, authStore } = deps;
  if (!authStore.isSessionValid(sessionTokenFromCookie(request.headers.cookie || ""))) {
    writeJson(response, { error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" } }, 401);
    return;
  }

  if (url.pathname === "/api/credentials" && request.method === "GET") {
    await handleCredentialList(deps);
    return;
  }

  const credentialMatch = /^\/api\/credentials\/([^/]+)$/.exec(url.pathname);
  if (credentialMatch && request.method === "PATCH") {
    const id = decodeURIComponent(credentialMatch[1]);
    const body = await readJsonBody(request);
    const status = body.status;
    if (status !== "active" && status !== "disabled") {
      writeJson(response, { error: { message: "status must be active or disabled", type: "invalid_request_error", code: "invalid_request_error" } }, 400);
      return;
    }
    const changed = status === "active"
      ? deps.credentialPool.enableCredential(id)
      : deps.credentialPool.disableCredential(id);
    if (!changed) {
      writeJson(response, { error: { message: "Credential not found", type: "not_found", code: "not_found" } }, 404);
      return;
    }
    deps.modelCache.delete(id);
    writeJson(response, { id, status });
    return;
  }

  if (credentialMatch && request.method === "DELETE") {
    const id = decodeURIComponent(credentialMatch[1]);
    const result = deps.credentialPool.deleteCredential(id);
    if (result === "not_found") {
      writeJson(response, { error: { message: "Credential not found", type: "not_found", code: "not_found" } }, 404);
      return;
    }
    if (result === "unmanaged") {
      writeJson(response, {
        error: {
          message: "This credential comes from the process environment. Remove it from CURSOR_API_KEY/CURSOR_API_KEYS and restart the service.",
          type: "conflict",
          code: "environment_credential"
        }
      }, 409);
      return;
    }
    deps.modelCache.delete(id);
    writeJson(response, { id, deleted: true });
    return;
  }

  if (url.pathname === "/api/request-logs" && request.method === "GET") {
    const query: RequestLogQuery = {
      limit: queryInteger(url, "limit", 10),
      cursor: url.searchParams.get("cursor") || "",
      result: requestLogResult(url.searchParams.get("result")),
      path: url.searchParams.get("path") || "",
      model: url.searchParams.get("model") || "",
      clientKeyId: url.searchParams.get("clientKeyId") || "",
      credentialId: url.searchParams.get("credentialId") || ""
    };
    const result = await deps.requestLogs.list(query);
    writeJson(response, result);
    return;
  }

  if (url.pathname === "/api/request-logs" && request.method === "DELETE") {
    await deps.requestLogs.clear();
    writeJson(response, { cleared: true });
    return;
  }

  if (url.pathname === "/api/request-logs/stats" && request.method === "GET") {
    writeJson(response, await deps.requestLogs.stats());
    return;
  }

  if (url.pathname === "/api/usage" && request.method === "GET") {
    const [gateway, storage, official] = await Promise.all([
      deps.requestLogs.usageSummary(),
      deps.requestLogs.stats(),
      deps.getAdminUsage()
    ]);
    writeJson(response, { gateway, storage, official });
    return;
  }

  writeJson(response, { error: { message: "Not found", type: "not_found", code: "not_found" } }, 404);
}

async function handleCredentialList(deps: ControlRouteDeps): Promise<void> {
  const usage = await deps.requestLogs.usageSummary();
  const usageByCredential = new Map(usage.byCredential.map((item) => [item.credentialId, item]));
  // 并发拉每个账号的官方额度（exchange crsr_ → usage-summary），单个失败不阻塞列表。
  const accountUsages = await Promise.all(
    deps.credentialPool.credentials.map(async (credential) => {
      try {
        return await deps.getAccountUsage(credential.apiKey);
      } catch {
        return { rawFallback: false, error: "额度查询失败" } as AccountUsageSummary;
      }
    })
  );
  const data = await Promise.all(deps.credentialPool.credentials.map(async (credential, index) => {
    let models: string[] = [];
    if (credential.status === "active") {
      try {
        models = (await bridgeModels(credential, deps.modelCache, deps.fetchImpl))
          .map((model) => model.id)
          .filter((model) => !credential.disabledModels.has(canonicalModelId(model)));
      } catch {
        models = [];
      }
    }
    return {
      id: credential.id,
      label: credential.label,
      hint: credential.hint,
      status: credential.status,
      disabledReason: credential.disabledReason || null,
      managed: credential.managed && !credential.environment,
      source: credential.environment ? "environment" : "console",
      models,
      disabledModels: [...credential.disabledModels],
      usage: usageByCredential.get(credential.id) || null,
      accountUsage: accountUsages[index]
    };
  }));
  writeJson(deps.response, { data });
}

async function bridgeModels(
  credential: PoolCredential,
  cache: Map<string, CachedModels>,
  fetchImpl: typeof fetch
): Promise<Array<{ id: string; displayName?: string }>> {
  const cached = cache.get(credential.id);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const bridgeUrl = process.env.CURSOR_SDK_BRIDGE_URL?.trim();
  if (!bridgeUrl) return [];
  const url = new URL(bridgeUrl);
  url.pathname = "/models";
  url.search = "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = process.env.CURSOR_SDK_BRIDGE_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ apiKey: credential.apiKey })
  });
  if (!response.ok) throw new Error(`Cursor model discovery failed with status ${response.status}`);
  const payload = await response.json() as { models?: Array<{ id?: unknown; displayName?: unknown }> };
  const models = Array.isArray(payload.models)
    ? payload.models.flatMap((model) => typeof model?.id === "string"
        ? [{ id: model.id, ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}) }]
        : [])
    : [];
  cache.set(credential.id, { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
  return models;
}

function shouldHandleControlRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/credentials" && method === "GET") return true;
  if (/^\/api\/credentials\/[^/]+$/.test(pathname) && (method === "PATCH" || method === "DELETE")) return true;
  if (pathname === "/api/request-logs" && (method === "GET" || method === "DELETE")) return true;
  if (pathname === "/api/request-logs/stats" && method === "GET") return true;
  if (pathname === "/api/usage" && method === "GET") return true;
  return false;
}

function createRequestContext(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  authStore: LocalAuthStore,
  requestLogs: RequestLogStore
): RuntimeRequestContext {
  const startedAt = Date.now();
  const client = authStore.resolveClientKey(requestApiKey(request));
  const context: RuntimeRequestContext = {
    id: headerValue(request, "x-request-id") || randomUUID(),
    startedAt,
    method: request.method || "GET",
    path: pathname,
    ...(client ? {
      clientKeyId: client.id,
      clientKeyLabel: client.label,
      clientKeyHint: client.hint
    } : {}),
    responsePreview: "",
    finalized: false
  };

  if (!response.headersSent) response.setHeader("x-request-id", context.id);
  captureRequestMetadata(request, context);
  wrapResponseWrites(response, context);
  const finish = () => finalizeRequestLog(context, response.statusCode, false, requestLogs);
  const close = () => {
    if (!response.writableEnded) finalizeRequestLog(context, 499, true, requestLogs);
  };
  response.once("finish", finish);
  response.once("close", close);
  return context;
}

function captureRequestMetadata(request: IncomingMessage, context: RuntimeRequestContext): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  request.on("data", (chunk) => {
    if (overflow) return;
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_METADATA_BODY_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(value);
  });
  request.once("end", () => {
    if (overflow || !chunks.length) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as Record<string, unknown>;
      if (typeof body.model === "string") context.model = body.model.slice(0, 160);
      const reasoningEffort = reasoningEffortFromBody(body);
      if (reasoningEffort) context.reasoningEffort = reasoningEffort;
      if (typeof body.stream === "boolean") context.streaming = body.stream;
    } catch {
      // Request parsing and validation remains owned by the main server.
    } finally {
      chunks.length = 0;
    }
  });
}

function wrapResponseWrites(response: ServerResponse, context: RuntimeRequestContext): void {
  const nativeWrite = response.write.bind(response);
  const nativeEnd = response.end.bind(response);
  response.write = ((chunk: unknown, ...args: unknown[]) => {
    observeResponseChunk(context, response, chunk);
    return (nativeWrite as (...values: unknown[]) => boolean)(chunk, ...args);
  }) as typeof response.write;
  response.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined) observeResponseChunk(context, response, chunk);
    return (nativeEnd as (...values: unknown[]) => ServerResponse)(chunk, ...args);
  }) as typeof response.end;
}

function observeResponseChunk(context: RuntimeRequestContext, response: ServerResponse, chunk: unknown): void {
  if (!context.firstByteAt) context.firstByteAt = Date.now();
  const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
    ? Buffer.from(chunk).toString("utf8")
    : typeof chunk === "string" ? chunk : "";
  if (!text) return;
  if (/event:\s*(?:response\.failed|error)\b/.test(text) || /"type"\s*:\s*"response\.failed"/.test(text)) {
    context.terminalFailure = true;
    const code = /"code"\s*:\s*"([^"\r\n]+)"/.exec(text)?.[1];
    if (code) context.terminalErrorCode = code.slice(0, 120);
  }
  if (response.statusCode < 400 || context.responsePreview.length >= MAX_ERROR_PREVIEW_BYTES) return;
  context.responsePreview += text.slice(0, MAX_ERROR_PREVIEW_BYTES - context.responsePreview.length);
}

function finalizeRequestLog(
  context: RuntimeRequestContext,
  statusCode: number,
  canceled: boolean,
  requestLogs: RequestLogStore
): void {
  if (context.finalized) return;
  context.finalized = true;
  const endedAt = Date.now();
  const result = canceled ? "canceled" : context.terminalFailure || statusCode < 200 || statusCode >= 400 ? "failed" : "completed";
  const entry: RequestLogEntry = {
    id: context.id,
    timestamp: new Date(context.startedAt).toISOString(),
    method: context.method,
    path: context.path,
    ...(context.model ? { model: context.model } : {}),
    ...(context.reasoningEffort ? { reasoningEffort: context.reasoningEffort } : {}),
    ...(context.streaming !== undefined ? { streaming: context.streaming } : {}),
    ...(context.clientKeyId ? { clientKeyId: context.clientKeyId } : {}),
    ...(context.clientKeyLabel ? { clientKeyLabel: context.clientKeyLabel } : {}),
    ...(context.clientKeyHint ? { clientKeyHint: context.clientKeyHint } : {}),
    ...(context.credentialId ? { credentialId: context.credentialId } : {}),
    ...(context.credentialLabel ? { credentialLabel: context.credentialLabel } : {}),
    ...(context.credentialHint ? { credentialHint: context.credentialHint } : {}),
    statusCode,
    result,
    durationMs: endedAt - context.startedAt,
    ...(context.firstByteAt ? { firstByteMs: context.firstByteAt - context.startedAt } : {}),
    ...(result === "failed"
      ? context.terminalErrorCode ? { errorCode: context.terminalErrorCode } : errorCodeFromPreview(context.responsePreview)
      : {})
  };
  void requestLogs.append(entry).catch((error) => {
    console.warn(JSON.stringify({
      event: "request_log_write_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
  });
}

function inspectBridgeRequest(
  context: RuntimeRequestContext | undefined,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  credentialPool: CursorCredentialPool
): void {
  if (!context || typeof init?.body !== "string") return;
  let url: URL;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  } catch {
    return;
  }
  if (url.pathname !== "/sdk") return;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const credential = credentialPool.credentialForApiKey(apiKey);
    if (credential) {
      context.credentialId = credential.id;
      context.credentialLabel = credential.label;
      context.credentialHint = credential.hint;
    }
    const model = body.model;
    if (!context.model && typeof model === "string") context.model = model.slice(0, 160);
    if (!context.model && model && typeof model === "object" && !Array.isArray(model)) {
      const id = (model as Record<string, unknown>).id;
      if (typeof id === "string") context.model = id.slice(0, 160);
    }
    if (!context.reasoningEffort) {
      const reasoningEffort = reasoningEffortFromBody(body);
      if (reasoningEffort) context.reasoningEffort = reasoningEffort;
    }
  } catch {
    // Never interfere with the bridge call because observability parsing failed.
  }
}

function reasoningEffortFromBody(body: Record<string, unknown>): string {
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim().slice(0, 64);
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && effort.trim()) return effort.trim().slice(0, 64);
  }
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
    const record = thinking as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const budget = typeof record.budget_tokens === "number" && Number.isFinite(record.budget_tokens)
      ? Math.max(0, Math.round(record.budget_tokens))
      : null;
    if (type === "enabled" && budget !== null) return `thinking ${budget} tokens`;
    if (type) return type.slice(0, 64);
  }
  return "";
}

function errorCodeFromPreview(preview: string): { errorCode?: string } {
  const trimmed = preview.trim();
  if (!trimmed) return {};
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    const error = body.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code;
      if (typeof code === "string" && code) return { errorCode: code };
    }
  } catch {
    // Streaming/error bodies are not always a single JSON object.
  }
  return {};
}

function requestApiKey(request: IncomingMessage): string {
  const apiKey = headerValue(request, "x-api-key");
  if (apiKey) return apiKey;
  const authorization = headerValue(request, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] || "" : typeof value === "string" ? value.trim() : "";
}

function requestUrl(request: IncomingMessage): URL {
  const host = headerValue(request, "host") || "127.0.0.1";
  return new URL(request.url || "/", `http://${host}`);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) throw new Error("Request body too large");
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    throw new Error("Invalid JSON");
  }
}

function writeJson(response: ServerResponse, body: unknown, status = 200): void {
  if (response.writableEnded || response.destroyed) return;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(data);
}

function writeError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /invalid|too large/i.test(message) ? 400 : 500;
  writeJson(response, { error: { message, type: "server_error", code: "server_error" } }, status);
}

function queryInteger(url: URL, name: string, fallback: number): number {
  const value = Number.parseInt(url.searchParams.get(name) || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function requestLogResult(value: string | null): RequestLogQuery["result"] {
  return value === "completed" || value === "failed" || value === "canceled" ? value : "";
}

function envInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.trim().toLowerCase() !== "false";
}
