import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJsonAtomic } from "./secure-state";

describe("private state persistence", () => {
  test("writes atomically with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor2api-private-state-"));
    const statePath = join(directory, "state.json");
    writePrivateJsonAtomic(statePath, { secret: "value" });

    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ secret: "value" });
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });
});
