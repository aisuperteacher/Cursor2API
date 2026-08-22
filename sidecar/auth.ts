import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writePrivateJsonAtomic } from "./secure-state";

interface ClientKeyRecord {
  id: string;
  label: string;
  hint: string;
  hash: string;
  createdAt: string;
}

interface AuthState {
  version: 1;
  adminPasswordHash?: string;
  sessionSecret: string;
  clientKeys: ClientKeyRecord[];
  publicBaseUrl?: string;
}

export interface ClientKeyInfo {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
}

export class LocalAuthStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalAuthStateError";
  }
}

export class LocalAuthStore {
  private readonly statePath: string;
  private readonly configuredClientKeyHash: string;
  private state: AuthState;
  private readonly sessions = new Map<string, number>();

  constructor(statePath: string, configuredAdminPassword = "", configuredClientKey = "") {
    this.statePath = statePath;
    this.configuredClientKeyHash = configuredClientKey.trim() ? hashToken(configuredClientKey.trim()) : "";
    this.state = readState(statePath);
    if (configuredAdminPassword.trim() && !this.state.adminPasswordHash) {
      this.state.adminPasswordHash = hashPassword(configuredAdminPassword.trim());
      this.persist();
    }
  }

  isConfigured(): boolean {
    return Boolean(this.state.adminPasswordHash);
  }

  setup(password: string): string | null {
    if (this.isConfigured() || !validPassword(password)) return null;
    this.state.adminPasswordHash = hashPassword(password);
    this.persist();
    return this.createSession();
  }

  login(password: string): string | null {
    if (!this.state.adminPasswordHash || !verifyPassword(password, this.state.adminPasswordHash)) return null;
    return this.createSession();
  }

  createSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + 1000 * 60 * 60 * 24 * 7);
    return token;
  }

  isSessionValid(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (!expiresAt || expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  clientKey(token: string): boolean {
    const candidate = token.trim();
    if (!candidate) return false;
    const digest = hashToken(candidate);
    if (this.configuredClientKeyHash && safeHexEqual(digest, this.configuredClientKeyHash)) return true;
    return this.state.clientKeys.some((item) => safeHexEqual(item.hash, digest));
  }

  listClientKeys(): ClientKeyInfo[] {
    return this.state.clientKeys.map(({ id, label, hint, createdAt }) => ({ id, label, hint, createdAt }));
  }

  createClientKey(label = "Default"): { token: string; info: ClientKeyInfo } {
    const token = `sk-${randomBytes(24).toString("base64url")}`;
    const info: ClientKeyInfo = {
      id: `key_${randomBytes(8).toString("hex")}`,
      label: label.trim() || "Default",
      hint: token.slice(-6),
      createdAt: new Date().toISOString()
    };
    this.state.clientKeys.push({ ...info, hash: hashToken(token) });
    this.persist();
    return { token, info };
  }

  revokeClientKey(id: string): boolean {
    const before = this.state.clientKeys.length;
    this.state.clientKeys = this.state.clientKeys.filter((item) => item.id !== id);
    if (this.state.clientKeys.length === before) return false;
    this.persist();
    return true;
  }

  publicBaseUrl(): string {
    return this.state.publicBaseUrl || "";
  }

  setPublicBaseUrl(value: string): string {
    const normalized = value.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    this.state.publicBaseUrl = normalized;
    this.persist();
    return normalized;
  }

  private persist(): void {
    try {
      writePrivateJsonAtomic(this.statePath, this.state);
    } catch (error) {
      throw new LocalAuthStateError(`Could not persist local auth state at ${this.statePath}`, { cause: error });
    }
  }
}

export function sessionCookie(token: string, maxAge = 60 * 60 * 24 * 7, secure = false): string {
  return `cursor2api_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function sessionToken(request: Request): string {
  const raw = request.headers.get("cookie") || "";
  const match = /(?:^|;\s*)cursor2api_session=([^;]+)/.exec(raw);
  return match ? decodeURIComponent(match[1]) : "";
}

function readState(path: string): AuthState {
  const fallback: AuthState = { version: 1, sessionSecret: randomBytes(32).toString("hex"), clientKeys: [] };
  if (!existsSync(path)) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LocalAuthStateError(`Local auth state at ${path} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new LocalAuthStateError(`Local auth state at ${path} has an unsupported or missing version`);
  }
  if (typeof parsed.sessionSecret !== "string" || !parsed.sessionSecret) {
    throw new LocalAuthStateError(`Local auth state at ${path} is missing sessionSecret`);
  }
  if (parsed.adminPasswordHash !== undefined && typeof parsed.adminPasswordHash !== "string") {
    throw new LocalAuthStateError(`Local auth state at ${path} has an invalid adminPasswordHash`);
  }
  if (!Array.isArray(parsed.clientKeys)) {
    throw new LocalAuthStateError(`Local auth state at ${path} has an invalid clientKeys collection`);
  }
  const clientKeys = parsed.clientKeys.map((item, index) => parseClientKey(item, path, index));
  if (parsed.publicBaseUrl !== undefined && typeof parsed.publicBaseUrl !== "string") {
    throw new LocalAuthStateError(`Local auth state at ${path} has an invalid publicBaseUrl`);
  }

  return {
    version: 1,
    adminPasswordHash: parsed.adminPasswordHash as string | undefined,
    sessionSecret: parsed.sessionSecret,
    clientKeys,
    publicBaseUrl: parsed.publicBaseUrl as string | undefined
  };
}

function parseClientKey(value: unknown, path: string, index: number): ClientKeyRecord {
  if (!isRecord(value)) throw new LocalAuthStateError(`Local auth state at ${path} has an invalid clientKeys[${index}]`);
  for (const field of ["id", "label", "hint", "hash", "createdAt"] as const) {
    if (typeof value[field] !== "string") {
      throw new LocalAuthStateError(`Local auth state at ${path} has an invalid clientKeys[${index}].${field}`);
    }
  }
  return value as unknown as ClientKeyRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPassword(password: string): boolean {
  return password.trim().length >= 8;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, expected] = encoded.split("$");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32);
  const target = Buffer.from(expected, "hex");
  return target.length === actual.length && timingSafeEqual(target, actual);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
