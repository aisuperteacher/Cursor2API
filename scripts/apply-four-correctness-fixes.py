from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one match in {path}, got {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


def append_before_last(path: str, marker: str, addition: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    index = text.rfind(marker)
    if index < 0:
        raise RuntimeError(f"marker not found in {path}: {marker!r}")
    target.write_text(text[:index] + addition + text[index:], encoding="utf-8")


# 1) Local CLI: stop forcing the legacy 180s timeout. Preserve a legacy user
# override, but default to the same idle/hard policy as Docker.
replace_once(
    "server.mjs",
    '''  const bridgeEnv = {\n    CURSOR_SDK_BRIDGE_HOST: host,\n    CURSOR_SDK_BRIDGE_PORT: String(bridgePort),\n    CURSOR_SDK_BRIDGE_TOKEN: bridgeToken,\n    CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: "180000"\n  };''',
    '''  const bridgeEnv = {\n    CURSOR_SDK_BRIDGE_HOST: host,\n    CURSOR_SDK_BRIDGE_PORT: String(bridgePort),\n    CURSOR_SDK_BRIDGE_TOKEN: bridgeToken,\n    CURSOR_SDK_BRIDGE_IDLE_TIMEOUT_MS:\n      process.env.CURSOR_SDK_BRIDGE_IDLE_TIMEOUT_MS || process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS || "300000",\n    CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS || "600000"\n  };'''
)

Path("server.test.mjs").write_text('''import { describe, expect, it } from "vitest";\nimport { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n\ndescribe("local server bridge timeout defaults", () => {\n  it("uses explicit idle and hard deadlines instead of the legacy 180 second default", () => {\n    const source = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");\n    expect(source).toContain("CURSOR_SDK_BRIDGE_IDLE_TIMEOUT_MS:");\n    expect(source).toContain('process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS || "300000"');\n    expect(source).toContain('CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS || "600000"');\n    expect(source).not.toContain('CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: "180000"');\n  });\n});\n''', encoding="utf-8")


# 2) Credential routing: a stable client/session affinity must remain pinned to
# the same first-choice credential rather than rotating on every turn.
replace_once(
    "sidecar/router.ts",
    '  private readonly rotation = new Map<string, number>();\n',
    ''
)
replace_once(
    "sidecar/router.ts",
    '''    const key = `${modelId}:${affinity}`;\n    const start = this.rotation.get(key) ?? stableIndex(key, eligible.length);\n    this.rotation.set(key, (start + 1) % eligible.length);\n    return [...eligible.slice(start), ...eligible.slice(0, start)];''',
    '''    const key = `${modelId}:${affinity}`;\n    const start = stableIndex(key, eligible.length);\n    return [...eligible.slice(start), ...eligible.slice(0, start)];'''
)
append_before_last(
    "sidecar/router.test.ts",
    "\n});",
    '''\n\n  test("keeps the same session affinity pinned to the same first-choice credential", async () => {\n    const pool = new CursorCredentialPool([{ apiKey: "one" }, { apiKey: "two" }]);\n    const load = async (key: string) => catalogs[key];\n    const first = await pool.candidates("composer-2.5", "sticky-session", load);\n    expect(first).toHaveLength(2);\n    const pinnedId = first[0].id;\n\n    for (let turn = 0; turn < 6; turn += 1) {\n      const candidates = await pool.candidates("composer-2.5", "sticky-session", load);\n      expect(candidates[0].id).toBe(pinnedId);\n    }\n  });\n'''
)


# 3) Model cache: stale-on-error is useful for transient outages, but never for
# authentication failures. Invalidate the stale entry on 401/403.
Path("sidecar/async-stale-cache.ts").write_text('''type StaleErrorPolicy = (error: unknown) => boolean;\n\nfunction defaultCanServeStale(error: unknown): boolean {\n  if (!error || typeof error !== "object") return true;\n  const record = error as Record<string, unknown>;\n  const rawStatus = record.status ?? record.statusCode ?? record.httpStatus;\n  const status = typeof rawStatus === "number"\n    ? rawStatus\n    : typeof rawStatus === "string" && /^\\d+$/.test(rawStatus)\n      ? Number(rawStatus)\n      : undefined;\n  return status !== 401 && status !== 403;\n}\n\nexport class AsyncStaleCache<T> {\n  private readonly values = new Map<string, { value: T; expiresAt: number }>();\n  private readonly inflight = new Map<string, Promise<T>>();\n\n  constructor(\n    private readonly ttlMs: number,\n    private readonly now: () => number = () => Date.now(),\n    private readonly canServeStale: StaleErrorPolicy = defaultCanServeStale\n  ) {}\n\n  async get(key: string, load: () => Promise<T>): Promise<T> {\n    const cached = this.values.get(key);\n    if (cached && cached.expiresAt > this.now()) return cached.value;\n\n    const active = this.inflight.get(key);\n    if (active) return active;\n\n    const refresh = (async () => {\n      try {\n        const value = await load();\n        this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });\n        return value;\n      } catch (error) {\n        if (cached && this.canServeStale(error)) return cached.value;\n        if (cached) this.values.delete(key);\n        throw error;\n      } finally {\n        this.inflight.delete(key);\n      }\n    })();\n    this.inflight.set(key, refresh);\n    return refresh;\n  }\n\n  clear(): void {\n    this.values.clear();\n    this.inflight.clear();\n  }\n}\n''', encoding="utf-8")
append_before_last(
    "sidecar/async-stale-cache.test.ts",
    "\n});",
    '''\n\n  test("does not serve or retain stale data after an authentication failure", async () => {\n    let now = 0;\n    let loads = 0;\n    const cache = new AsyncStaleCache<string[]>(60_000, () => now);\n\n    await expect(cache.get("credential-a", async () => {\n      loads += 1;\n      return ["cached-model"];\n    })).resolves.toEqual(["cached-model"]);\n\n    now = 60_001;\n    const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 });\n    await expect(cache.get("credential-a", async () => {\n      loads += 1;\n      throw unauthorized;\n    })).rejects.toBe(unauthorized);\n    expect(loads).toBe(2);\n\n    await expect(cache.get("credential-a", async () => {\n      loads += 1;\n      return ["fresh-model"];\n    })).resolves.toEqual(["fresh-model"]);\n    expect(loads).toBe(3);\n  });\n'''
)
replace_once(
    "sidecar/server.ts",
    '''      const status = response.status === 401 ? 401 : response.status === 429 ? 429 : 502;\n      throw new HttpError(message, status, response.status === 401 ? "cursor_unauthorized" : "cursor_models_error");''',
    '''      const authenticationFailure = response.status === 401 || response.status === 403;\n      const status = authenticationFailure ? response.status : response.status === 429 ? 429 : 502;\n      throw new HttpError(message, status, authenticationFailure ? "cursor_unauthorized" : "cursor_models_error");'''
)


# 4) Downstream disconnect cancellation. Sidecar stops consuming its Web stream
# on socket close; NDJSON parser cancels the bridge response body; bridge aborts
# queued/running SDK work and calls run.cancel() when available.
replace_once(
    "sidecar/server.ts",
    'import { createServer, type IncomingMessage, type ServerResponse } from "node:http";',
    'import { createServer, type IncomingMessage } from "node:http";'
)
replace_once(
    "sidecar/server.ts",
    'import { LocalAuthStore, sessionCookie, sessionToken } from "./auth";\n',
    'import { LocalAuthStore, sessionCookie, sessionToken } from "./auth";\nimport { writeWebResponse } from "./node-response";\n'
)
replace_once(
    "sidecar/server.ts",
    '''async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {\n  const headers: Record<string, string> = {};\n  response.headers.forEach((value, key) => {\n    headers[key] = value;\n  });\n  res.writeHead(response.status, headers);\n\n  if (!response.body) {\n    res.end();\n    return;\n  }\n\n  const reader = response.body.getReader();\n  try {\n    for (;;) {\n      const { value, done } = await reader.read();\n      if (done) break;\n      if (value) res.write(Buffer.from(value));\n    }\n  } finally {\n    reader.releaseLock();\n    res.end();\n  }\n}\n\n''',
    ''
)

Path("sidecar/node-response.ts").write_text('''import type { ServerResponse } from "node:http";\n\nfunction waitForDrainOrClose(res: ServerResponse): Promise<void> {\n  if (res.destroyed) return Promise.resolve();\n  return new Promise((resolve) => {\n    const finish = () => {\n      res.off("drain", finish);\n      res.off("close", finish);\n      resolve();\n    };\n    res.once("drain", finish);\n    res.once("close", finish);\n  });\n}\n\nexport async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {\n  const headers: Record<string, string> = {};\n  response.headers.forEach((value, key) => {\n    headers[key] = value;\n  });\n  res.writeHead(response.status, headers);\n\n  if (!response.body) {\n    res.end();\n    return;\n  }\n\n  const reader = response.body.getReader();\n  let clientClosed = res.destroyed;\n  const onClose = () => {\n    clientClosed = true;\n    void reader.cancel("downstream client disconnected").catch(() => undefined);\n  };\n  res.on("close", onClose);\n\n  try {\n    for (;;) {\n      if (clientClosed) break;\n      const { value, done } = await reader.read();\n      if (done || clientClosed) break;\n      if (value && !res.write(Buffer.from(value))) {\n        await waitForDrainOrClose(res);\n      }\n    }\n  } catch (error) {\n    if (!clientClosed) throw error;\n  } finally {\n    res.off("close", onClose);\n    if (clientClosed) {\n      await reader.cancel("downstream client disconnected").catch(() => undefined);\n    }\n    reader.releaseLock();\n    if (!res.writableEnded && !res.destroyed) res.end();\n  }\n}\n''', encoding="utf-8")

Path("sidecar/node-response.test.ts").write_text('''import { describe, expect, test } from "bun:test";\nimport { EventEmitter } from "node:events";\nimport { writeWebResponse } from "./node-response";\n\nclass FakeResponse extends EventEmitter {\n  destroyed = false;\n  writableEnded = false;\n  status = 0;\n  headers: Record<string, string> = {};\n  writes: Buffer[] = [];\n  onWrite?: () => void;\n\n  writeHead(status: number, headers: Record<string, string>) {\n    this.status = status;\n    this.headers = headers;\n    return this;\n  }\n\n  write(chunk: Buffer) {\n    this.writes.push(chunk);\n    this.onWrite?.();\n    return true;\n  }\n\n  end() {\n    this.writableEnded = true;\n    return this;\n  }\n}\n\ndescribe("sidecar node response streaming", () => {\n  test("cancels the Web response body when the downstream socket closes", async () => {\n    let cancelled = false;\n    let firstWrite!: () => void;\n    const wrote = new Promise<void>((resolve) => { firstWrite = resolve; });\n    const body = new ReadableStream<Uint8Array>({\n      start(controller) {\n        controller.enqueue(new TextEncoder().encode("first"));\n      },\n      cancel() {\n        cancelled = true;\n      }\n    });\n    const res = new FakeResponse();\n    res.onWrite = firstWrite;\n\n    const piping = writeWebResponse(res as any, new Response(body, { status: 200 }));\n    await wrote;\n    res.destroyed = true;\n    res.emit("close");\n    await piping;\n\n    expect(cancelled).toBe(true);\n    expect(Buffer.concat(res.writes).toString("utf8")).toBe("first");\n  });\n});\n''', encoding="utf-8")

replace_once(
    "worker/cursor-sdk.ts",
    '''  try {\n    for (;;) {\n      const { value, done } = await reader.read();\n      if (done) break;\n      buffer += decoder.decode(value, { stream: true });\n      for (;;) {\n        const newline = buffer.indexOf("\\n");\n        if (newline < 0) break;\n        const line = buffer.slice(0, newline);\n        buffer = buffer.slice(newline + 1);\n        const parsed = parseLine(line);\n        if (parsed) yield parsed;\n      }\n    }\n    buffer += decoder.decode();\n    const parsed = parseLine(buffer);\n    if (parsed) yield parsed;\n  } finally {\n    reader.releaseLock();\n  }''',
    '''  let completed = false;\n  try {\n    for (;;) {\n      const { value, done } = await reader.read();\n      if (done) {\n        completed = true;\n        break;\n      }\n      buffer += decoder.decode(value, { stream: true });\n      for (;;) {\n        const newline = buffer.indexOf("\\n");\n        if (newline < 0) break;\n        const line = buffer.slice(0, newline);\n        buffer = buffer.slice(newline + 1);\n        const parsed = parseLine(line);\n        if (parsed) yield parsed;\n      }\n    }\n    buffer += decoder.decode();\n    const parsed = parseLine(buffer);\n    if (parsed) yield parsed;\n  } finally {\n    if (!completed) {\n      await reader.cancel("cursor_sdk_bridge_consumer_closed").catch(() => undefined);\n    }\n    reader.releaseLock();\n  }'''
)
replace_once(
    "worker/cursor-sdk.test.ts",
    '''\n});\n\nfunction protoMessage(parts: Uint8Array[]): Uint8Array {''',
    '''\n  it("cancels the NDJSON bridge body when its consumer stops early", async () => {\n    let cancelled = false;\n    const encoder = new TextEncoder();\n    const body = new ReadableStream<Uint8Array>({\n      start(controller) {\n        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "text", text: "first" })}\\n`));\n      },\n      cancel() {\n        cancelled = true;\n      }\n    });\n\n    const iterator = cursorSdkTestExports.parseCursorLocalSdkBridgeNdjson(body);\n    await expect(iterator.next()).resolves.toMatchObject({\n      done: false,\n      value: { type: "text", text: "first" }\n    });\n    await iterator.return(undefined as never);\n    expect(cancelled).toBe(true);\n  });\n\n});\n\nfunction protoMessage(parts: Uint8Array[]): Uint8Array {'''
)

replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''  composerToolCallFromText,\n  createRunTimeoutController,\n  normalizeSDKToolCall,''',
    '''  composerToolCallFromText,\n  createRunAbortController,\n  createRunTimeoutController,\n  normalizeSDKToolCall,'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''async function streamLocalAgent(input, response) {\n  let closed = false;\n  const markClosed = () => {\n    closed = true;\n  };\n  const socket = response.socket;\n  response.on("close", markClosed);\n  response.on("error", markClosed);\n  socket?.on?.("error", markClosed);''',
    '''async function streamLocalAgent(input, response) {\n  let closed = false;\n  const abortController = new AbortController();\n  const markClosed = () => {\n    closed = true;\n    if (!abortController.signal.aborted) {\n      abortController.abort(new Error("Cursor SDK bridge client disconnected."));\n    }\n  };\n  const socket = response.socket;\n  response.on("close", markClosed);\n  response.on("error", markClosed);\n  socket?.on?.("error", markClosed);'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''  const emit = (event) => {\n    if (closed) return false;\n    const wrote = writeNdjson(response, event);\n    if (!wrote) closed = true;\n    return wrote;\n  };\n  try {\n    const output = await runLocalAgent(input, emit);''',
    '''  const emit = (event) => {\n    if (closed) return false;\n    const wrote = writeNdjson(response, event);\n    if (!wrote) markClosed();\n    return wrote;\n  };\n  try {\n    const output = await runLocalAgent({ ...input, signal: abortController.signal }, emit);'''
)

# Insert abort helper between timeout controller and unlocked run.
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''}\n\nasync function runLocalAgentUnlocked(input, onEvent) {''',
    '''}\n\nfunction abortError(reason) {\n  const message = reason instanceof Error && reason.message\n    ? reason.message\n    : "Cursor SDK bridge client disconnected.";\n  const error = new Error(message);\n  error.name = "AbortError";\n  error.code = "ABORT_ERR";\n  return error;\n}\n\nfunction createRunAbortController(signal, onAbort) {\n  let stopped = false;\n  let rejectAbort;\n  const promise = new Promise((_resolve, reject) => {\n    rejectAbort = reject;\n  });\n  const abort = () => {\n    if (stopped) return;\n    stopped = true;\n    try {\n      onAbort?.();\n    } catch {}\n    rejectAbort(abortError(signal?.reason));\n  };\n\n  if (signal) {\n    if (signal.aborted) queueMicrotask(abort);\n    else signal.addEventListener("abort", abort, { once: true });\n  }\n\n  return {\n    promise,\n    stop() {\n      if (stopped) return;\n      stopped = true;\n      signal?.removeEventListener("abort", abort);\n    }\n  };\n}\n\nasync function runLocalAgentUnlocked(input, onEvent) {\n  if (input.signal?.aborted) throw abortError(input.signal.reason);'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''    const timeoutControl = createRunTimeoutController({\n      requestId: input.requestId,\n      onTimeout: () => {\n        if (activeRun) activeRun.cancel().catch(() => {});\n      }\n    });''',
    '''    const timeoutControl = createRunTimeoutController({\n      requestId: input.requestId,\n      onTimeout: () => {\n        if (activeRun) activeRun.cancel().catch(() => {});\n      }\n    });\n    const abortControl = createRunAbortController(input.signal, () => {\n      if (activeRun) activeRun.cancel().catch(() => {});\n    });'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''    const work = runLocalAgentBody(input, (run) => {\n      activeRun = run;\n      progress("run_ready");\n    }, emit, progress);\n\n    try {\n      return await Promise.race([work, timeoutControl.promise]);''',
    '''    const work = runLocalAgentBody(input, (run) => {\n      activeRun = run;\n      if (input.signal?.aborted) run.cancel().catch(() => {});\n      progress("run_ready");\n    }, emit, progress);\n\n    try {\n      return await Promise.race([work, timeoutControl.promise, abortControl.promise]);'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''    } finally {\n      timeoutControl.stop();\n    }\n  }\n}\n\nasync function runExclusiveForAgent(input, work) {''',
    '''    } finally {\n      abortControl.stop();\n      timeoutControl.stop();\n    }\n  }\n}\n\nasync function runExclusiveForAgent(input, work) {'''
)
replace_once(
    "scripts/cursor-sdk-local-agent-bridge.mjs",
    '''  agentRunQueues.set(cacheKey, current);\n\n  try {\n    await previous.catch(() => {});\n    return await work();\n  } finally {\n    release();''',
    '''  agentRunQueues.set(cacheKey, current);\n  const abortControl = createRunAbortController(input.signal);\n\n  try {\n    await Promise.race([previous.catch(() => {}), abortControl.promise]);\n    if (input.signal?.aborted) throw abortError(input.signal.reason);\n    return await work();\n  } finally {\n    abortControl.stop();\n    release();'''
)

replace_once(
    "scripts/cursor-sdk-local-agent-bridge.test.mjs",
    '''  composerToolCallFromText,\n  createRunTimeoutController,\n  localAgentCreateOptions,''',
    '''  composerToolCallFromText,\n  createRunAbortController,\n  createRunTimeoutController,\n  localAgentCreateOptions,'''
)
append_before_last(
    "scripts/cursor-sdk-local-agent-bridge.test.mjs",
    "\n});",
    '''\n\n  it("rejects an aborted bridge run and invokes its cancellation callback", async () => {\n    const controller = new AbortController();\n    let cancellations = 0;\n    const abort = createRunAbortController(controller.signal, () => {\n      cancellations += 1;\n    });\n\n    controller.abort(new Error("client disconnected"));\n    await expect(abort.promise).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });\n    expect(cancellations).toBe(1);\n    abort.stop();\n  });\n\n  it("removes an aborted queued run without starting work for that client", async () => {\n    const input = {\n      apiKey: "test-key",\n      model: "default",\n      workingDirectory: "/tmp/project",\n      sessionKey: "abort-queue-session",\n      clientTools: []\n    };\n    let releaseFirst;\n    let firstStarted;\n    const started = new Promise((resolve) => { firstStarted = resolve; });\n    const first = runExclusiveForAgent(input, async () => {\n      firstStarted();\n      await new Promise((resolve) => { releaseFirst = resolve; });\n      return "first";\n    });\n    await started;\n\n    const controller = new AbortController();\n    let secondStarted = false;\n    const second = runExclusiveForAgent({ ...input, signal: controller.signal }, async () => {\n      secondStarted = true;\n      return "second";\n    });\n    controller.abort(new Error("client disconnected"));\n\n    await expect(second).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });\n    expect(secondStarted).toBe(false);\n    releaseFirst();\n    await expect(first).resolves.toBe("first");\n  });\n'''
)

print("Applied four correctness fixes and regression tests.")
