import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writePrivateJsonAtomic } from "./secure-state";

export interface PoolCatalogModel {
  id: string;
  aliases?: string[];
}

export interface PoolCredential {
  id: string;
  label: string;
  apiKey: string;
  hint: string;
  disabledModels: Set<string>;
  status: "active" | "disabled";
  disabledReason?: string;
  managed: boolean;
  environment: boolean;
}

interface RouterState {
  version: 2;
  disabledModels: Record<string, string[]>;
  disabledCredentials: Record<string, string>;
  credentials: Array<{ id: string; label: string; secret: EncryptedValue }>;
}

interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

interface SharedPoolState {
  credentials: PoolCredential[];
  encryptionKeyDigest: string;
}

const sharedPools = new Map<string, SharedPoolState>();

export class CursorRouterStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorRouterStateError";
  }
}

export type DeleteCredentialResult = "deleted" | "not_found" | "unmanaged";

export class CursorCredentialPool {
  readonly credentials: PoolCredential[];
  private readonly statePath?: string;
  private readonly encryptionKey?: Buffer;

  constructor(keys: Array<{ apiKey: string; label?: string }>, statePath?: string, encryptionSecret?: string) {
    this.statePath = statePath;
    this.encryptionKey = encryptionSecret?.trim()
      ? createHash("sha256").update(encryptionSecret.trim()).digest()
      : undefined;

    const existing = statePath ? sharedPools.get(statePath) : undefined;
    if (existing) {
      if (existing.credentials.some((credential) => credential.managed) && !this.encryptionKey) {
        throw new CursorRouterStateError("ENCRYPTION_KEY is required to load managed Cursor credentials");
      }
      if (
        existing.encryptionKeyDigest
        && this.encryptionKey
        && existing.encryptionKeyDigest !== encryptionKeyDigest(this.encryptionKey)
      ) {
        throw new CursorRouterStateError("ENCRYPTION_KEY does not match the already loaded managed Cursor credential store");
      }
      mergeConfiguredCredentials(existing.credentials, keys, readRouterState(statePath));
      this.credentials = existing.credentials;
      return;
    }

    const state = readRouterState(statePath);
    if (state.credentials.length && !this.encryptionKey) {
      throw new CursorRouterStateError("ENCRYPTION_KEY is required to load managed Cursor credentials");
    }

    const storedKeys = this.encryptionKey
      ? state.credentials.map((item) => {
          try {
            return {
              apiKey: decryptValue(item.secret, this.encryptionKey!),
              label: item.label,
              managed: true,
              environment: false
            };
          } catch (error) {
            throw new CursorRouterStateError(`Could not decrypt managed Cursor credential ${item.id}`, { cause: error });
          }
        })
      : [];

    const unique = new Map<string, { apiKey: string; label?: string; managed: boolean; environment: boolean }>();
    for (const item of keys) {
      const apiKey = item.apiKey.trim();
      if (!apiKey || unique.has(apiKey)) continue;
      unique.set(apiKey, { apiKey, label: item.label, managed: false, environment: true });
    }
    for (const item of storedKeys) {
      const existingItem = unique.get(item.apiKey);
      if (existingItem) {
        existingItem.managed = true;
      } else {
        unique.set(item.apiKey, item);
      }
    }

    this.credentials = [...unique.values()].map((item, index) => credentialFrom(item, index, state));
    if (statePath) {
      sharedPools.set(statePath, {
        credentials: this.credentials,
        encryptionKeyDigest: this.encryptionKey ? encryptionKeyDigest(this.encryptionKey) : ""
      });
    }
  }

  async intersectModels<T extends PoolCatalogModel>(load: (apiKey: string) => Promise<T[]>): Promise<T[]> {
    const active = this.credentials.filter((credential) => credential.status === "active");
    if (!active.length) return [];
    const catalogs = await Promise.all(active.map(async (credential) => ({
      credential,
      models: await load(credential.apiKey)
    })));
    const first = catalogs[0];
    const shared = new Map(first.models.map((model) => [canonicalModelId(model.id), model]));
    for (const entry of catalogs.slice(1)) {
      const available = new Set(entry.models.map((model) => canonicalModelId(model.id)));
      for (const modelId of shared.keys()) if (!available.has(modelId)) shared.delete(modelId);
    }
    return [...shared].flatMap(([modelId, model]) => (
      catalogs.some(({ credential }) => !credential.disabledModels.has(modelId)) ? [model] : []
    ));
  }

  async candidates<T extends PoolCatalogModel>(
    requestedModel: string,
    affinity: string,
    load: (apiKey: string) => Promise<T[]>
  ): Promise<PoolCredential[]> {
    const modelId = canonicalModelId(requestedModel);
    const catalogs = await Promise.all(this.credentials.filter((credential) => credential.status === "active").map(async (credential) => {
      try {
        return { credential, models: await load(credential.apiKey) };
      } catch {
        return { credential, models: [] as T[] };
      }
    }));
    const eligible = catalogs
      .filter(({ credential, models }) => (
        !credential.disabledModels.has(modelId)
        && models.some((model) => modelSupports(model, modelId))
      ))
      .map(({ credential }) => credential);
    if (eligible.length <= 1) return eligible;

    const key = `${modelId}:${affinity}`;
    const start = stableIndex(key, eligible.length);
    return [...eligible.slice(start), ...eligible.slice(0, start)];
  }

  disableModel(credential: PoolCredential, model: string): void {
    credential.disabledModels.add(canonicalModelId(model));
    this.persist();
  }

  addCredential(apiKey: string, label = "Imported"): PoolCredential {
    const normalized = apiKey.trim();
    const existing = this.credentials.find((credential) => credential.apiKey === normalized);
    if (existing) {
      existing.label = label.trim() || existing.label;
      existing.status = "active";
      existing.disabledReason = undefined;
      existing.managed = true;
      this.persist();
      return existing;
    }
    const credential: PoolCredential = {
      id: credentialId(normalized),
      label: label.trim() || `cursor-${this.credentials.length + 1}`,
      apiKey: normalized,
      hint: normalized.slice(-4),
      disabledModels: new Set(),
      status: "active",
      managed: true,
      environment: false
    };
    this.credentials.push(credential);
    this.persist();
    return credential;
  }

  disableCredential(id: string, reason = "disabled by gateway owner"): boolean {
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) return false;
    credential.status = "disabled";
    credential.disabledReason = reason;
    this.persist();
    return true;
  }

  enableCredential(id: string): boolean {
    const credential = this.credentials.find((item) => item.id === id);
    if (!credential) return false;
    credential.status = "active";
    credential.disabledReason = undefined;
    this.persist();
    return true;
  }

  deleteCredential(id: string): DeleteCredentialResult {
    const index = this.credentials.findIndex((item) => item.id === id);
    if (index < 0) return "not_found";
    if (this.credentials[index].environment || !this.credentials[index].managed) return "unmanaged";
    this.credentials.splice(index, 1);
    this.persist();
    return "deleted";
  }

  credentialForApiKey(apiKey: string): PoolCredential | undefined {
    return this.credentials.find((credential) => credential.apiKey === apiKey);
  }

  private persist(): void {
    if (!this.statePath) return;
    const managed = this.credentials.filter((credential) => credential.managed);
    if (managed.length && !this.encryptionKey) {
      throw new CursorRouterStateError("ENCRYPTION_KEY is required to persist managed Cursor credentials");
    }
    const state: RouterState = {
      version: 2,
      disabledModels: Object.fromEntries(
        this.credentials
          .filter((credential) => credential.disabledModels.size > 0)
          .map((credential) => [credential.id, [...credential.disabledModels].sort()])
      ),
      disabledCredentials: Object.fromEntries(
        this.credentials
          .filter((credential) => credential.status === "disabled")
          .map((credential) => [credential.id, credential.disabledReason || "disabled"])
      ),
      credentials: this.encryptionKey
        ? managed.map((credential) => ({
            id: credential.id,
            label: credential.label,
            secret: encryptValue(credential.apiKey, this.encryptionKey!)
          }))
        : []
    };
    try {
      writePrivateJsonAtomic(this.statePath, state);
    } catch (error) {
      throw new CursorRouterStateError(`Could not persist Cursor router state at ${this.statePath}`, { cause: error });
    }
  }
}

export function parseCursorCredentialEnv(primary = "", multiple = ""): Array<{ apiKey: string; label?: string }> {
  const parsed: Array<{ apiKey: string; label?: string }> = [];
  const trimmed = multiple.trim();
  if (trimmed.startsWith("[")) {
    try {
      const values = JSON.parse(trimmed) as unknown;
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string") parsed.push({ apiKey: value });
          else if (value && typeof value === "object") {
            const item = value as { key?: unknown; apiKey?: unknown; label?: unknown };
            const apiKey = typeof item.apiKey === "string" ? item.apiKey : typeof item.key === "string" ? item.key : "";
            if (apiKey) parsed.push({ apiKey, label: typeof item.label === "string" ? item.label : undefined });
          }
        }
      }
    } catch {
      // Fall back to the delimiter format below.
    }
  }
  if (!parsed.length && trimmed) {
    for (const entry of trimmed.split(/[\r\n,;]+/)) {
      const value = entry.trim();
      if (!value) continue;
      const separator = value.indexOf("=");
      parsed.push(separator > 0
        ? { label: value.slice(0, separator).trim(), apiKey: value.slice(separator + 1).trim() }
        : { apiKey: value });
    }
  }
  if (primary.trim()) parsed.unshift({ apiKey: primary.trim(), label: "default" });
  return parsed;
}

export function canonicalModelId(value: string): string {
  const base = value.trim().replace(/\[.*\]$/, "").split("/").filter(Boolean).at(-1) || "auto";
  const normalized = base.toLowerCase();
  if (normalized === "default") return "auto";
  if (normalized === "composer-2-5" || normalized === "composer-2.5-sdk" || normalized === "composer-latest") return "composer-2.5";
  if (normalized === "composer-2-5-fast") return "composer-2.5-fast";
  return normalized;
}

export function isBillingError(error: unknown): boolean {
  const status = numericFields(error, ["status", "statusCode", "httpStatus"]);
  if (status.includes(402)) return true;
  const text = errorText(error).toLowerCase();
  if (["rate limit", "too many requests", "temporarily unavailable", "timeout", "timed out"].some((marker) => text.includes(marker))) return false;
  return [
    "billing", "payment required", "payment_required", "insufficient credit", "insufficient_credit",
    "insufficient balance", "insufficient_balance", "spending limit", "spending_limit", "usage limit",
    "usage_limit", "quota exceeded", "quota_exceeded", "out of credits", "out_of_credits",
    "credit exhausted", "credit_exhausted", "plan limit", "plan_limit", "subscription required",
    "subscription_required"
  ].some((marker) => text.includes(marker));
}

function mergeConfiguredCredentials(
  target: PoolCredential[],
  keys: Array<{ apiKey: string; label?: string }>,
  state: RouterState
): void {
  for (const item of keys) {
    const apiKey = item.apiKey.trim();
    if (!apiKey || target.some((credential) => credential.apiKey === apiKey)) continue;
    target.push(credentialFrom({ apiKey, label: item.label, managed: false, environment: true }, target.length, state));
  }
}

function credentialFrom(
  item: { apiKey: string; label?: string; managed: boolean; environment: boolean },
  index: number,
  state: RouterState
): PoolCredential {
  const id = credentialId(item.apiKey);
  return {
    id,
    label: item.label?.trim() || `cursor-${index + 1}`,
    apiKey: item.apiKey,
    hint: item.apiKey.slice(-4),
    disabledModels: new Set((state.disabledModels[id] || []).map(canonicalModelId)),
    status: state.disabledCredentials[id] ? "disabled" : "active",
    disabledReason: state.disabledCredentials[id],
    managed: item.managed,
    environment: item.environment
  };
}

function modelSupports(model: PoolCatalogModel, requestedModel: string): boolean {
  return [model.id, ...(model.aliases || [])].map(canonicalModelId).includes(requestedModel);
}

function credentialId(apiKey: string): string {
  return `cred_${createHash("sha256").update(apiKey).digest("hex").slice(0, 24)}`;
}

function encryptionKeyDigest(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex");
}

function readRouterState(statePath?: string): RouterState {
  const empty = (): RouterState => ({ version: 2, disabledModels: {}, disabledCredentials: {}, credentials: [] });
  if (!statePath || !existsSync(statePath)) return empty();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new CursorRouterStateError(`Cursor router state at ${statePath} is not valid JSON`, { cause: error });
  }
  if (!isPlainRecord(parsed) || parsed.version !== 2) {
    throw new CursorRouterStateError(`Cursor router state at ${statePath} has an unsupported or missing version`);
  }
  if (!isStringArrayRecord(parsed.disabledModels)) {
    throw new CursorRouterStateError(`Cursor router state at ${statePath} has invalid disabledModels`);
  }
  if (!isStringRecord(parsed.disabledCredentials)) {
    throw new CursorRouterStateError(`Cursor router state at ${statePath} has invalid disabledCredentials`);
  }
  if (!Array.isArray(parsed.credentials) || !parsed.credentials.every(isStoredCredential)) {
    throw new CursorRouterStateError(`Cursor router state at ${statePath} has invalid credentials`);
  }
  return {
    version: 2,
    disabledModels: parsed.disabledModels,
    disabledCredentials: parsed.disabledCredentials,
    credentials: parsed.credentials
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isPlainRecord(value) && Object.values(value).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStoredCredential(value: unknown): value is RouterState["credentials"][number] {
  if (!isPlainRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isPlainRecord(value.secret)) {
    return false;
  }
  return [value.secret.ciphertext, value.secret.iv, value.secret.tag].every((field) => typeof field === "string");
}

function encryptValue(value: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptValue(value: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string" || typeof error === "number" || typeof error === "boolean") return String(error);
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (Array.isArray(error)) return error.map((item) => errorText(item, depth + 1)).join(" ");
  if (typeof error === "object") return Object.entries(error as Record<string, unknown>).map(([key, value]) => `${key} ${errorText(value, depth + 1)}`).join(" ");
  return "";
}

function numericFields(error: unknown, names: string[], depth = 0): number[] {
  if (depth > 5 || error === null || typeof error !== "object") return [];
  if (Array.isArray(error)) return error.flatMap((item) => numericFields(item, names, depth + 1));
  const record = error as Record<string, unknown>;
  const values = names.flatMap((name) => {
    const value = record[name];
    if (typeof value === "number") return [value];
    if (typeof value === "string" && /^\d+$/.test(value)) return [Number(value)];
    return [];
  });
  return [...values, ...Object.values(record).flatMap((value) => numericFields(value, names, depth + 1))];
}

function stableIndex(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}
