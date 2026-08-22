import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeWebResponse } from "./node-response";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  status = 0;
  headers: Record<string, string> = {};
  writes: Buffer[] = [];
  onWrite?: () => void;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: Buffer) {
    this.writes.push(chunk);
    this.onWrite?.();
    return true;
  }

  end() {
    this.writableEnded = true;
    return this;
  }
}

describe("sidecar node response streaming", () => {
  test("cancels the Web response body when the downstream socket closes", async () => {
    let cancelled = false;
    let firstWrite!: () => void;
    const wrote = new Promise<void>((resolve) => { firstWrite = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel() {
        cancelled = true;
      }
    });
    const res = new FakeResponse();
    res.onWrite = firstWrite;

    const piping = writeWebResponse(res as any, new Response(body, { status: 200 }));
    await wrote;
    res.destroyed = true;
    res.emit("close");
    await piping;

    expect(cancelled).toBe(true);
    expect(Buffer.concat(res.writes).toString("utf8")).toBe("first");
  });

  test("adds conservative browser security headers", async () => {
    const res = new FakeResponse();
    await writeWebResponse(res as any, new Response(null, { status: 204 }));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

});
