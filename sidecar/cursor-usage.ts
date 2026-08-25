import { createHash } from "node:crypto";
import { exchangeCursorApiKey } from "../worker/cursor";
import type { Deps, Env } from "../worker/types";

/**
 * 每个 Cursor 账号的官方额度（usage-summary 端点）。
 *
 * 网关里存的是 crsr_ API key，它本身不能直接查 usage，但可以通过
 * /auth/exchange_user_api_key 换成 access_token，再用 token 调
 * cursor.com/api/usage-summary。这段链路已经由 worker/cursor.ts 的
 * exchangeCursorApiKey 实现，这里复用它。
 */
export interface AccountUsageSummary {
  totalPercent?: number;
  autoPercent?: number;
  apiPercent?: number;
  membershipType?: string;
  rawFallback?: boolean;
  fetchedAt?: string;
  error?: string;
}

const DEFAULT_USAGE_URL = "https://cursor.com/api/usage-summary";
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;

type UsageFetcher = (apiKey: string) => Promise<AccountUsageSummary>;

export function createAccountUsageFetcher(env: Env, deps: Deps, usageUrl = DEFAULT_USAGE_URL): UsageFetcher {
  const cache = new Map<string, { expiresAt: number; value: AccountUsageSummary }>();

  return async (apiKey: string): Promise<AccountUsageSummary> => {
    const key = createHash("sha256").update(apiKey).digest("hex").slice(0, 32);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: AccountUsageSummary;
    try {
      const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
      const response = await deps.fetch(usageUrl, {
        headers: { authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) throw new Error(`usage-summary 返回 ${response.status}`);
      const raw = await response.json().catch(() => null);
      value = summarizeAccountUsage(raw);
      value.fetchedAt = new Date().toISOString();
    } catch (error) {
      value = {
        rawFallback: false,
        error: error instanceof Error ? error.message : String(error),
        fetchedAt: new Date().toISOString()
      };
    }

    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    if (cache.size > MAX_CACHE_ENTRIES) {
      // 容量兜底：淘汰最早的一条即可，避免 API key 高基时无限增长。
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  };
}

/** 从 usage-summary 响应里提取额度百分比，字段多候选、识别不出置 rawFallback。 */
export function summarizeAccountUsage(raw: unknown): AccountUsageSummary {
  const root = toRecord(raw);
  const summary: AccountUsageSummary = { rawFallback: true };

  const membershipType = pickString(root, ["membershipType", "membership_type"]);
  if (membershipType) {
    summary.membershipType = membershipType;
    summary.rawFallback = false;
  }

  const individual = pickRecord(root, ["individualUsage", "individual_usage"]);
  const plan = (individual && pickRecord(individual, ["plan"]))
    || pickRecord(root, ["planUsage", "plan_usage"])
    || pickRecord(root, ["plan"]);

  const total = pickNumber(plan, ["totalPercentUsed", "total_percent_used"])
    ?? percentFromRatio(plan);
  const auto = pickNumber(plan, ["autoPercentUsed", "auto_percent_used"]);
  const api = pickNumber(plan, ["apiPercentUsed", "api_percent_used"]);

  if (total !== undefined) {
    summary.totalPercent = clamp(total);
    summary.rawFallback = false;
  }
  if (auto !== undefined) {
    summary.autoPercent = clamp(auto);
    summary.rawFallback = false;
  }
  if (api !== undefined) {
    summary.apiPercent = clamp(api);
    summary.rawFallback = false;
  }

  return summary;
}

function percentFromRatio(plan: Record<string, unknown> | undefined): number | undefined {
  if (!plan) return undefined;
  const used = pickNumber(plan, ["used", "totalSpend", "total_spend"]);
  const limit = pickNumber(plan, ["limit"]);
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return (used / limit) * 100;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!record) return undefined;
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
