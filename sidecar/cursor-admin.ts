export interface CursorAdminUsageOptions {
  apiKey?: string;
  baseUrl?: string;
  lookbackDays?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface CursorAdminUsageSnapshot {
  configured: boolean;
  fetchedAt?: string;
  range?: { startDate: number; endDate: number };
  spend?: unknown;
  usageEvents?: unknown;
  error?: string;
}

export async function fetchCursorAdminUsage(options: CursorAdminUsageOptions = {}): Promise<CursorAdminUsageSnapshot> {
  const apiKey = options.apiKey?.trim() || "";
  if (!apiKey) return { configured: false };

  const baseUrl = (options.baseUrl?.trim() || "https://api.cursor.com").replace(/\/+$/, "");
  const lookbackDays = positiveInteger(options.lookbackDays, 30);
  const timeoutMs = positiveInteger(options.timeoutMs, 10_000);
  const now = options.now || (() => Date.now());
  const endDate = now();
  const startDate = endDate - lookbackDays * 24 * 60 * 60 * 1000;
  const fetchImpl = options.fetchImpl || fetch;
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Cursor Admin API request timed out")), timeoutMs);

  try {
    const headers = {
      authorization,
      "content-type": "application/json"
    };
    const [spendResponse, eventsResponse] = await Promise.all([
      fetchImpl(`${baseUrl}/teams/spend`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: controller.signal
      }),
      fetchImpl(`${baseUrl}/teams/filtered-usage-events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ startDate, endDate, page: 1, pageSize: 100 }),
        signal: controller.signal
      })
    ]);

    const spend = await parseJsonResponse(spendResponse, "spending data");
    const usageEvents = await parseJsonResponse(eventsResponse, "usage events");
    return {
      configured: true,
      fetchedAt: new Date(endDate).toISOString(),
      range: { startDate, endDate },
      spend,
      usageEvents,
      summary: summarizeOfficialUsage(spend, usageEvents)
    };
  } catch (error) {
    return {
      configured: true,
      fetchedAt: new Date(endDate).toISOString(),
      range: { startDate, endDate },
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn the raw Cursor Admin API response into a stable, frontend-friendly
 * summary. Cursor's payload shapes vary over time, so every value is looked up
 * across several likely field names; if nothing recognisable is present we leave
 * the summary empty and set `rawFallback` so the caller can fall back to the raw
 * JSON instead of rendering a misleading zero.
 */
export function summarizeOfficialUsage(spend: unknown, usageEvents: unknown): OfficialUsageSummary {
  const summary: OfficialUsageSummary = { byModel: [], byDay: [] };
  const spendObj = toRecord(spend);
  const total = pickNumberValue(spendObj, ["total", "totalSpend", "total_spend", "amount", "spend", "cost"]);
  const currency = pickStringValue(spendObj, ["currency", "currencyCode", "unit"]);
  const membershipType = pickStringValue(spendObj, ["membershipType", "membership_type"]);
  if (total !== undefined) summary.totalSpend = total;
  if (currency) summary.currency = currency;
  if (membershipType) summary.membershipType = membershipType;

  const events = usageEventArray(usageEvents);
  const byModel = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const item of events) {
    const itemObj = toRecord(item);
    const model = pickStringValue(itemObj, ["model", "modelName", "name", "id"]);
    const count = Math.max(0, pickNumberValue(itemObj, ["requests", "count", "requestCount", "usage", "calls", "tokens"]) ?? 1);
    const date = pickStringValue(itemObj, ["date", "timestamp", "createdAt", "day"]);
    if (model) byModel.set(model, (byModel.get(model) ?? 0) + count);
    if (date) {
      const normalized = normalizeDay(date);
      if (normalized) byDay.set(normalized, (byDay.get(normalized) ?? 0) + count);
    }
  }

  const totalRequests = [...byModel.values()].reduce((sum, value) => sum + value, 0);
  summary.byModel = [...byModel.entries()]
    .map(([model, requests]) => ({ model, requests, percent: totalRequests > 0 ? Math.round((requests / totalRequests) * 100) : 0 }))
    .sort((left, right) => right.requests - left.requests)
    .slice(0, 10);
  summary.byDay = [...byDay.entries()]
    .map(([date, requests]) => ({ date, requests }))
    .sort((left, right) => left.date.localeCompare(right.date));

  if (summary.totalSpend === undefined && summary.byModel.length === 0 && summary.byDay.length === 0) {
    summary.rawFallback = true;
  }
  return summary;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Unwrap a possibly-array usageEvents payload from its container object. */
function usageEventArray(value: unknown): unknown[] {
  const record = toRecord(value);
  const direct = record.usageEvents ?? record.usage_events;
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(value)) return value;
  for (const key of ["data", "items", "events", "results"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function pickNumberValue(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickStringValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Normalize a date-ish value (ISO string, date string, or epoch ms) to YYYY-MM-DD. */
function normalizeDay(value: string): string | undefined {
  const trimmed = value.replace(/^["']|["']$/g, "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = Number.parseFloat(trimmed);
  if (Number.isFinite(parsed) && parsed > 1_000_000_000) {
    const date = new Date(parsed);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const time = Date.parse(trimmed);
  if (!Number.isNaN(time)) return new Date(time).toISOString().slice(0, 10);
  return undefined;
}

async function parseJsonResponse(response: Response, description: string): Promise<unknown> {
  const text = await response.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(`Cursor Admin API ${description} failed with status ${response.status}`);
      throw new Error(`Cursor Admin API returned invalid JSON for ${description}`);
    }
  }
  if (!response.ok) {
    const message = errorMessage(body) || `Cursor Admin API ${description} failed with status ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nested = errorMessage(candidate);
      if (nested) return nested;
    }
  }
  return "";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}
