import { describe, expect, test } from "bun:test";
import { AsyncStaleCache } from "./async-stale-cache";

describe("AsyncStaleCache", () => {
  test("deduplicates concurrent refreshes per key", async () => {
    let now = 0;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new AsyncStaleCache<string[]>(60_000, () => now);
    const load = async () => {
      loads += 1;
      await gate;
      return ["composer-2.5"];
    };

    const first = cache.get("credential-a", load);
    const second = cache.get("credential-a", load);
    expect(loads).toBe(1);
    release();
    await expect(first).resolves.toEqual(["composer-2.5"]);
    await expect(second).resolves.toEqual(["composer-2.5"]);

    now = 1_000;
    await expect(cache.get("credential-a", load)).resolves.toEqual(["composer-2.5"]);
    expect(loads).toBe(1);
  });

  test("returns stale data when an expired refresh fails", async () => {
    let now = 0;
    const cache = new AsyncStaleCache<string[]>(60_000, () => now);
    await expect(cache.get("credential-a", async () => ["cached-model"])).resolves.toEqual(["cached-model"]);
    now = 60_001;
    await expect(cache.get("credential-a", async () => { throw new Error("429"); })).resolves.toEqual(["cached-model"]);
  });

  test("does not serve or retain stale data after an authentication failure", async () => {
    let now = 0;
    let loads = 0;
    const cache = new AsyncStaleCache<string[]>(60_000, () => now);

    await expect(cache.get("credential-a", async () => {
      loads += 1;
      return ["cached-model"];
    })).resolves.toEqual(["cached-model"]);

    now = 60_001;
    const unauthorized = Object.assign(new Error("unauthorized"), { status: 401 });
    await expect(cache.get("credential-a", async () => {
      loads += 1;
      throw unauthorized;
    })).rejects.toBe(unauthorized);
    expect(loads).toBe(2);

    await expect(cache.get("credential-a", async () => {
      loads += 1;
      return ["fresh-model"];
    })).resolves.toEqual(["fresh-model"]);
    expect(loads).toBe(3);
  });

});
