import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type RequestLogResult = "completed" | "failed" | "canceled";

export interface RequestLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  streaming?: boolean;
  clientKeyId?: string;
  clientKeyLabel?: string;
  clientKeyHint?: string;
  credentialId?: string;
  credentialLabel?: string;
  credentialHint?: string;
  statusCode: number;
  result: RequestLogResult;
  durationMs: number;
  firstByteMs?: number;
  errorCode?: string;
}

export interface RequestLogQuery {
  limit?: number;
  result?: RequestLogResult | "";
  path?: string;
  model?: string;
  clientKeyId?: string;
  credentialId?: string;
}

export interface RequestLogStorageStats {
  enabled: boolean;
  directory: string;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  lastCleanupAt: string | null;
}

export interface CredentialUsageSummary {
  credentialId: string;
  credentialLabel: string;
  credentialHint: string;
  requests: number;
  completed: number;
  failed: number;
  canceled: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastRequestAt: string | null;
  models: string[];
}

export interface GatewayUsageSummary {
  retainedRequests: number;
  completed: number;
  failed: number;
  canceled: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastRequestAt: string | null;
  sampled: boolean;
  byCredential: CredentialUsageSummary[];
}

export interface RequestLogOptions {
  enabled?: boolean;
  directory: string;
  retentionDays?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  current: boolean;
}

const CURRENT_FILE = "requests.jsonl";
const LOG_FILE_PATTERN = /^requests(?:-\d+-\d+)?\.jsonl$/;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;
const USAGE_SAMPLE_LIMIT = 50_000;

export class RequestLogStore {
  readonly enabled: boolean;
  readonly directory: string;
  readonly retentionDays: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly cleanupIntervalMs: number;

  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCleanupAt = 0;
  private rotateSequence = 0;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: RequestLogOptions) {
    this.enabled = options.enabled !== false;
    this.directory = options.directory;
    this.retentionDays = positiveInteger(options.retentionDays, 7);
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, 100 * 1024 * 1024);
    this.maxFileBytes = Math.min(
      positiveInteger(options.maxFileBytes, 10 * 1024 * 1024),
      this.maxTotalBytes
    );
    this.maxFiles = positiveInteger(options.maxFiles, 10);
    this.cleanupIntervalMs = positiveInteger(options.cleanupIntervalMs, 60 * 60 * 1000);
    this.now = options.now || (() => Date.now());
    if (this.enabled) {
      void this.schedule(() => this.cleanupInternal()).catch(() => undefined);
      this.cleanupTimer = setInterval(() => {
        void this.cleanup().catch((error) => {
          console.warn(JSON.stringify({
            event: "request_log_cleanup_failed",
            message: error instanceof Error ? error.message : String(error)
          }));
        });
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  append(entry: RequestLogEntry): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const sanitized = sanitizeEntry(entry);
    const line = `${JSON.stringify(sanitized)}\n`;
    return this.schedule(async () => {
      await this.ensureDirectory();
      const rotated = await this.rotateIfNeeded(Buffer.byteLength(line));
      const path = join(this.directory, CURRENT_FILE);
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
      if (rotated || this.now() - this.lastCleanupAt >= this.cleanupIntervalMs) await this.cleanupInternal();
    });
  }

  async list(query: RequestLogQuery = {}): Promise<{ data: RequestLogEntry[]; hasMore: boolean }> {
    if (!this.enabled) return { data: [], hasMore: false };
    await this.queue;
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.trunc(query.limit || DEFAULT_QUERY_LIMIT)));
    const data: RequestLogEntry[] = [];
    let hasMore = false;
    const files = (await this.logFiles()).sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const file of files) {
      const text = await readFile(file.path, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseEntry(lines[index]);
        if (!entry || !matchesQuery(entry, query)) continue;
        if (data.length < limit) data.push(entry);
        else {
          hasMore = true;
          return { data, hasMore };
        }
      }
    }
    return { data, hasMore };
  }

  async usageSummary(): Promise<GatewayUsageSummary> {
    if (!this.enabled) return emptyUsageSummary(false);
    await this.queue;
    const entries: RequestLogEntry[] = [];
    let sampled = false;
    const files = (await this.logFiles()).sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const file of files) {
      const text = await readFile(file.path, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const entry = parseEntry(lines[index]);
        if (!entry) continue;
        if (entries.length >= USAGE_SAMPLE_LIMIT) {
          sampled = true;
          break;
        }
        entries.push(entry);
      }
      if (sampled) break;
    }

    if (!entries.length) return emptyUsageSummary(sampled);
    const durations = entries.map((entry) => entry.durationMs);
    const byCredential = new Map<string, RequestLogEntry[]>();
    for (const entry of entries) {
      if (!entry.credentialId) continue;
      const bucket = byCredential.get(entry.credentialId) || [];
      bucket.push(entry);
      byCredential.set(entry.credentialId, bucket);
    }

    return {
      retainedRequests: entries.length,
      completed: entries.filter((entry) => entry.result === "completed").length,
      failed: entries.filter((entry) => entry.result === "failed").length,
      canceled: entries.filter((entry) => entry.result === "canceled").length,
      averageDurationMs: average(durations),
      p95DurationMs: percentile(durations, 0.95),
      lastRequestAt: entries[0]?.timestamp || null,
      sampled,
      byCredential: [...byCredential.entries()].map(([credentialId, values]) => {
        const credentialDurations = values.map((entry) => entry.durationMs);
        return {
          credentialId,
          credentialLabel: values.find((entry) => entry.credentialLabel)?.credentialLabel || credentialId,
          credentialHint: values.find((entry) => entry.credentialHint)?.credentialHint || "",
          requests: values.length,
          completed: values.filter((entry) => entry.result === "completed").length,
          failed: values.filter((entry) => entry.result === "failed").length,
          canceled: values.filter((entry) => entry.result === "canceled").length,
          averageDurationMs: average(credentialDurations),
          p95DurationMs: percentile(credentialDurations, 0.95),
          lastRequestAt: values[0]?.timestamp || null,
          models: [...new Set(values.map((entry) => entry.model).filter((value): value is string => Boolean(value)))].sort()
        };
      }).sort((left, right) => right.requests - left.requests)
    };
  }

  async stats(): Promise<RequestLogStorageStats> {
    if (!this.enabled) {
      return {
        enabled: false,
        directory: this.directory,
        fileCount: 0,
        totalBytes: 0,
        retentionDays: this.retentionDays,
        maxFileBytes: this.maxFileBytes,
        maxFiles: this.maxFiles,
        maxTotalBytes: this.maxTotalBytes,
        lastCleanupAt: this.lastCleanupAt ? new Date(this.lastCleanupAt).toISOString() : null
      };
    }
    await this.queue;
    const files = await this.logFiles();
    return {
      enabled: true,
      directory: this.directory,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      retentionDays: this.retentionDays,
      maxFileBytes: this.maxFileBytes,
      maxFiles: this.maxFiles,
      maxTotalBytes: this.maxTotalBytes,
      lastCleanupAt: this.lastCleanupAt ? new Date(this.lastCleanupAt).toISOString() : null
    };
  }

  clear(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.schedule(async () => {
      const files = await this.logFiles();
      await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
      this.lastCleanupAt = this.now();
    });
  }

  cleanup(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.schedule(() => this.cleanupInternal());
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<boolean> {
    const currentPath = join(this.directory, CURRENT_FILE);
    const current = await stat(currentPath).catch(() => null);
    if (!current || current.size === 0 || current.size + incomingBytes <= this.maxFileBytes) return false;
    const rotated = join(this.directory, `requests-${this.now()}-${this.rotateSequence += 1}.jsonl`);
    await rename(currentPath, rotated);
    await chmod(rotated, 0o600).catch(() => undefined);
    return true;
  }

  private async cleanupInternal(): Promise<void> {
    await this.ensureDirectory();
    const now = this.now();
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    let files = await this.logFiles();

    for (const file of files) {
      if (file.mtimeMs < cutoff) await unlink(file.path).catch(() => undefined);
    }

    files = await this.logFiles();
    const removable = files.filter((file) => !file.current).sort((left, right) => left.mtimeMs - right.mtimeMs);
    while (files.length > this.maxFiles && removable.length) {
      const oldest = removable.shift()!;
      await unlink(oldest.path).catch(() => undefined);
      files = files.filter((file) => file.path !== oldest.path);
    }

    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const byAge = files.filter((file) => !file.current).sort((left, right) => left.mtimeMs - right.mtimeMs);
    while (totalBytes > this.maxTotalBytes && byAge.length) {
      const oldest = byAge.shift()!;
      await unlink(oldest.path).catch(() => undefined);
      totalBytes -= oldest.size;
    }

    this.lastCleanupAt = now;
  }

  private async logFiles(): Promise<LogFileInfo[]> {
    await this.ensureDirectory();
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const files = await Promise.all(names.filter((name) => LOG_FILE_PATTERN.test(name)).map(async (name) => {
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => null);
      return info ? { name, path, size: info.size, mtimeMs: info.mtimeMs, current: name === CURRENT_FILE } : null;
    }));
    return files.filter((file): file is LogFileInfo => Boolean(file));
  }
}

function sanitizeEntry(entry: RequestLogEntry): RequestLogEntry {
  return {
    id: stringValue(entry.id, 120),
    timestamp: validTimestamp(entry.timestamp),
    method: stringValue(entry.method, 16).toUpperCase(),
    path: stringValue(entry.path, 500),
    ...(entry.model ? { model: stringValue(entry.model, 160) } : {}),
    ...(entry.streaming !== undefined ? { streaming: Boolean(entry.streaming) } : {}),
    ...(entry.clientKeyId ? { clientKeyId: stringValue(entry.clientKeyId, 120) } : {}),
    ...(entry.clientKeyLabel ? { clientKeyLabel: stringValue(entry.clientKeyLabel, 160) } : {}),
    ...(entry.clientKeyHint ? { clientKeyHint: stringValue(entry.clientKeyHint, 16) } : {}),
    ...(entry.credentialId ? { credentialId: stringValue(entry.credentialId, 120) } : {}),
    ...(entry.credentialLabel ? { credentialLabel: stringValue(entry.credentialLabel, 160) } : {}),
    ...(entry.credentialHint ? { credentialHint: stringValue(entry.credentialHint, 16) } : {}),
    statusCode: nonNegativeInteger(entry.statusCode),
    result: entry.result,
    durationMs: nonNegativeInteger(entry.durationMs),
    ...(entry.firstByteMs !== undefined ? { firstByteMs: nonNegativeInteger(entry.firstByteMs) } : {}),
    ...(entry.errorCode ? { errorCode: stringValue(entry.errorCode, 120) } : {})
  };
}

function parseEntry(line: string): RequestLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Partial<RequestLogEntry>;
    if (
      typeof value.id !== "string"
      || typeof value.timestamp !== "string"
      || typeof value.method !== "string"
      || typeof value.path !== "string"
      || typeof value.statusCode !== "number"
      || typeof value.durationMs !== "number"
      || !["completed", "failed", "canceled"].includes(String(value.result))
    ) return null;
    return value as RequestLogEntry;
  } catch {
    return null;
  }
}

function matchesQuery(entry: RequestLogEntry, query: RequestLogQuery): boolean {
  if (query.result && entry.result !== query.result) return false;
  if (query.path && !entry.path.toLowerCase().includes(query.path.toLowerCase())) return false;
  if (query.model && !(entry.model || "").toLowerCase().includes(query.model.toLowerCase())) return false;
  if (query.clientKeyId && entry.clientKeyId !== query.clientKeyId) return false;
  if (query.credentialId && entry.credentialId !== query.credentialId) return false;
  return true;
}

function emptyUsageSummary(sampled: boolean): GatewayUsageSummary {
  return {
    retainedRequests: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    averageDurationMs: 0,
    p95DurationMs: 0,
    lastRequestAt: null,
    sampled,
    byCredential: []
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function stringValue(value: unknown, maxLength: number): string {
  return String(value ?? "").slice(0, maxLength);
}

function validTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index]);
}
