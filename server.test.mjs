import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("local server bridge timeout defaults", () => {
  it("uses explicit idle and hard deadlines instead of the legacy 180 second default", () => {
    const source = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");
    expect(source).toContain("CURSOR_SDK_BRIDGE_IDLE_TIMEOUT_MS:");
    expect(source).toContain('process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS || "300000"');
    expect(source).toContain('CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_HARD_TIMEOUT_MS || "600000"');
    expect(source).not.toContain('CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: "180000"');
  });
});
