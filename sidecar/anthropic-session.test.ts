import { describe, expect, test } from "bun:test";
import { AnthropicSessionLinkStore, anthropicToolResultIds, preferCredential } from "./anthropic-session";
import { CursorCredentialPool } from "./router";

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

  test("pins tool_result continuation to its originating credential even when router affinity rotates", async () => {
    const pool = new CursorCredentialPool([
      { apiKey: "test-key-a", label: "A" },
      { apiKey: "test-key-b", label: "B" }
    ]);
    const loadModels = async () => [{ id: "auto" }];

    const freshCandidates = await pool.candidates("auto", "affinity-0", loadModels);
    expect(freshCandidates).toHaveLength(2);

    let rotatedCandidates: typeof freshCandidates | undefined;
    for (let index = 1; index < 128; index += 1) {
      const candidates = await pool.candidates("auto", `affinity-${index}`, loadModels);
      if (candidates[0]?.id !== freshCandidates[0]?.id) {
        rotatedCandidates = candidates;
        break;
      }
    }

    expect(rotatedCandidates).toBeDefined();
    const origin = freshCandidates[0]!;
    const rotated = rotatedCandidates!;
    expect(rotated[0]!.id).not.toBe(origin.id);

    const store = new AnthropicSessionLinkStore();
    store.remember("toolu_pin", {
      sessionKey: "session-pinned",
      credentialId: origin.id
    });

    const continuation = store.findFromBody({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_pin",
          content: "ok"
        }]
      }]
    });

    expect(continuation).toMatchObject({
      toolUseId: "toolu_pin",
      link: {
        sessionKey: "session-pinned",
        credentialId: origin.id
      }
    });

    const pinned = preferCredential(rotated, continuation?.link.credentialId);
    expect(pinned[0]!.id).toBe(origin.id);
    expect(pinned.map((credential) => credential.id).sort())
      .toEqual(rotated.map((credential) => credential.id).sort());
    expect(continuation?.link.sessionKey).toBe("session-pinned");
  });
});
