type StaleErrorPolicy = (error: unknown) => boolean;

function defaultCanServeStale(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const record = error as Record<string, unknown>;
  const rawStatus = record.status ?? record.statusCode ?? record.httpStatus;
  const status = typeof rawStatus === "number"
    ? rawStatus
    : typeof rawStatus === "string" && /^\d+$/.test(rawStatus)
      ? Number(rawStatus)
      : undefined;
  return status !== 401 && status !== 403;
}

export class AsyncStaleCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly canServeStale: StaleErrorPolicy = defaultCanServeStale
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const active = this.inflight.get(key);
    if (active) return active;

    const refresh = (async () => {
      try {
        const value = await load();
        this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      } catch (error) {
        if (cached && this.canServeStale(error)) return cached.value;
        if (cached) this.values.delete(key);
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, refresh);
    return refresh;
  }

  clear(): void {
    this.values.clear();
    this.inflight.clear();
  }
}
