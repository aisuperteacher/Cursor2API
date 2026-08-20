export class AsyncStaleCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now()
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
        if (cached) return cached.value;
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
