import { describe, expect, test } from "bun:test";
import { AnthropicSessionLinkStore, anthropicToolResultIds, preferCredential } from "./anthropic-session";

describe("AnthropicSessionLinkStore", () => {
  test("extracts tool_result ids and resolves the SDK continuation", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "continue" },
          { type: "tool_result", tool_use_id: "toolu_a", content: "ok" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "ok" }
        ]
      }]
    };
    expect(anthropicToolResultIds(body)).toEqual(["toolu_a", "toolu_b"]);

    const store = new AnthropicSessionLinkStore();
    store.remember("toolu_b", { sessionKey: "session-1", credentialId: "cred-b" });
    expect(store.findFromBody(body)).toMatchObject({
      toolUseId: "toolu_b",
      link: { sessionKey: "session-1", credentialId: "cred-b" }
    });
  });

  test("clears invalid links by SDK session", () => {
    const store = new AnthropicSessionLinkStore();
    store.remember("toolu_a", { sessionKey: "session-1", credentialId: "cred-a" });
    store.remember("toolu_b", { sessionKey: "session-2", credentialId: "cred-b" });
    store.clearSession("session-1");
    expect(store.findFromBody({ messages: [{ content: [{ type: "tool_result", tool_use_id: "toolu_a" }] }] })).toBeUndefined();
    expect(store.findFromBody({ messages: [{ content: [{ type: "tool_result", tool_use_id: "toolu_b" }] }] })?.link.sessionKey).toBe("session-2");
  });

  test("pins a continuation credential ahead of router rotation while keeping fallbacks", () => {
    expect(preferCredential([{ id: "a" }, { id: "b" }, { id: "c" }], "c").map((item) => item.id))
      .toEqual(["c", "a", "b"]);
  });
});
