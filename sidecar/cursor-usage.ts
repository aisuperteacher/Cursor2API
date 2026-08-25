import { createHash } from "node:crypto";

/**
 * 每个 Cursor 账号的官方用量。
 *
 * 网关里存的是 crsr_ API key，它不能直接查用量，但可以换成 access_token：
 *   POST api2.cursor.sh/auth/exchange_user_api_key  →  { accessToken }
 *
 * 换来的 token 类型是 api_key_token，实测可用的端点（均已用真实 key 验证）：
 *   GET  /auth/full_stripe_profile                              → 订阅类型
 *   GET  /auth/usage                                            → 请求数 / 配额上限 / 周期起始
 *   POST /aiserver.v1.DashboardService/GetAggregatedUsageEvents  → 本月花费与 token 消耗
 *
 * 注意 cursor.com/api/usage-summary 需要网页 session cookie，用 api_key_token
 * 访问返回 401，因此这里不使用它。
 */
export interface AccountUsageSummary {
  membershipType?: string;
  /** 本月累计花费（美元）。 */
  spendUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  requests?: number;
  /** 有配额上限的套餐才有值；free 版为空，此时不渲染百分比。 */
  requestLimit?: number;
  percentUsed?: number;
  periodStart?: string;
  fetchedAt?: string;
  error?: string;
}

const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const PROFILE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";
const USAGE_URL = "https://api2.cursor.sh/auth/usage";
const AGGREGATED_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetAggregatedUsageEvents";
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AccountUsageOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createAccountUsageFetcher(options: AccountUsageOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const cache = new Map<string, { expiresAt: number; value: AccountUsageSummary }>();

  return async (apiKey: string): Promise<AccountUsageSummary> => {
    const cacheKey = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;

    let value: AccountUsageSummary;
    try {
      value = await fetchAccountUsage(apiKey, fetchImpl);
      value.fetchedAt = new Date(now()).toISOString();
    } catch (error) {
      value = {
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: new Date(now()).toISOString()
      };
    }

    cache.set(cacheKey, { expiresAt: now() + CACHE_TTL_MS, value });
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  };
}

async function fetchAccountUsage(apiKey: string, fetchImpl: typeof fetch): Promise<AccountUsageSummary> {
  const accessToken = await exchangeApiKey(apiKey, fetchImpl);
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

  // 三个端点互不依赖：任一失败不应让整个额度区块消失。
  const [profile, usage, aggregated] = await Promise.all([
    requestJson(fetchImpl, PROFILE_URL, { headers }).catch(() => null),
    requestJson(fetchImpl, USAGE_URL, { headers }).catch(() => null),
    requestJson(fetchImpl, AGGREGATED_URL, { method: "POST", headers, body: "{}" }).catch(() => null)
  ]);

  const summary: AccountUsageSummary = {};

  const profileObj = toRecord(profile);
  const membership = pickString(profileObj, ["membershipType", "individualMembershipType", "teamMembershipType"]);
  if (membership) summary.membershipType = membership;

  const aggObj = toRecord(aggregated);
  const cents = pickNumber(aggObj, ["totalCostCents"]);
  if (cents !== undefined) summary.spendUsd = cents / 100;
  const inputTokens = pickNumber(aggObj, ["totalInputTokens"]);
  const outputTokens = pickNumber(aggObj, ["totalOutputTokens"]);
  const cacheTokens = pickNumber(aggObj, ["totalCacheReadTokens"]);
  if (inputTokens !== undefined) summary.inputTokens = inputTokens;
  if (outputTokens !== undefined) summary.outputTokens = outputTokens;
  if (cacheTokens !== undefined) summary.cacheReadTokens = cacheTokens;

  // /auth/usage 形如 { "gpt-4": { numRequests, maxRequestUsage, ... }, startOfMonth }
  const usageObj = toRecord(usage);
  const periodStart = pickString(usageObj, ["startOfMonth"]);
  if (periodStart) summary.periodStart = periodStart;
  let requests = 0;
  let limit: number | undefined;
  let sawBucket = false;
  for (const [key, bucket] of Object.entries(usageObj)) {
    if (key === "startOfMonth") continue;
    const record = toRecord(bucket);
    const used = pickNumber(record, ["numRequests", "numRequestsTotal"]);
    if (used === undefined) continue;
    sawBucket = true;
    requests += used;
    const max = pickNumber(record, ["maxRequestUsage"]);
    if (max !== undefined && max > 0) limit = (limit ?? 0) + max;
  }
  if (sawBucket) summary.requests = requests;
  if (limit !== undefined && limit > 0) {
    summary.requestLimit = limit;
    summary.percentUsed = Math.min(100, Math.max(0, Math.round((requests / limit) * 100)));
  }

  return summary;
}

async function exchangeApiKey(apiKey: string, fetchImpl: typeof fetch): Promise<string> {
  const payload = await requestJson(fetchImpl, EXCHANGE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "{}"
  });
  const token = pickString(toRecord(payload), ["accessToken", "access_token"]);
  if (!token) throw new Error("Cursor 未返回 accessToken");
  return token;
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${new URL(url).pathname} 返回 ${response.status}`);
    }
    return text.trim() ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Cursor 的 token 计数是字符串（proto int64），所以字符串也要按数字解析。 */
function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
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

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
