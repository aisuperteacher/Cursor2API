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
      usageEvents
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
