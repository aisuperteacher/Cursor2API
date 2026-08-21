import { describe, expect, it, vi } from "vitest";
import { streamOpenAiEvents } from "./openai-stream";
import type { CursorTextEvent } from "./cursor";

async function* events(values: CursorTextEvent[]): AsyncGenerator<CursorTextEvent> {
  for (const value of values) yield value;
}

describe("shared OpenAI streaming core", () => {
  it("emits chat deltas, usage, and the terminal DONE marker", async () => {
    const onDone = vi.fn();
    const response = streamOpenAiEvents("chat", events([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "done", finalText: "hello", toolCalls: [] }
    ]), {
      id: "chatcmpl_test",
      created: 1,
      model: "composer-2.5",
      promptChars: 40,
      includeUsage: true,
      tools: [],
      onDone
    });

    const body = await response.text();
    expect(body).toContain('"content":"hel"');
    expect(body).toContain('"content":"lo"');
    expect(body).toContain('"usage"');
    expect(body).toContain("data: [DONE]");
    expect(onDone).toHaveBeenCalledWith("hello", 5, []);
  });

  it("does not append a failure terminal after a completion callback throws", async () => {
    const response = streamOpenAiEvents("responses", events([
      { type: "done", finalText: "ok", toolCalls: [] }
    ]), {
      id: "resp_callback",
      created: 1,
      model: "composer-2.5",
      promptChars: 20,
      includeUsage: false,
      tools: [],
      onDone: () => { throw new Error("persistence failed"); }
    });
    const body = await response.text();
    expect(body).toContain("event: response.completed");
    expect(body).not.toContain("event: response.failed");
  });

  it("always terminates failed Responses streams with response.failed", async () => {
    async function* failing(): AsyncGenerator<CursorTextEvent> {
      yield { type: "text", text: "partial" };
      throw new Error("bridge disconnected");
    }

    const response = streamOpenAiEvents("responses", failing(), {
      id: "resp_test",
      created: 1,
      model: "composer-2.5",
      promptChars: 20,
      includeUsage: false,
      tools: []
    });
    const body = await response.text();
    expect(body).toContain("event: response.failed");
    expect(body).toContain('"status":"failed"');
    expect(body).toContain("bridge disconnected");
  });
});
