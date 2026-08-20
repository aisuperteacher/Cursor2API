export interface AnthropicSessionLink {
  sessionKey: string;
  credentialId: string;
  createdAt: number;
}

export interface AnthropicContinuation {
  toolUseId: string;
  link: AnthropicSessionLink;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function anthropicToolResultIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const ids: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      if (typeof block.tool_use_id === "string" && block.tool_use_id.trim()) ids.push(block.tool_use_id.trim());
    }
  }
  return [...new Set(ids)];
}

export function preferCredential<T extends { id: string }>(candidates: T[], preferredId?: string): T[] {
  if (!preferredId) return candidates;
  const index = candidates.findIndex((candidate) => candidate.id === preferredId);
  if (index <= 0) return candidates;
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

export class AnthropicSessionLinkStore {
  private readonly links = new Map<string, AnthropicSessionLink>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxEntries = 4096,
    private readonly now: () => number = () => Date.now()
  ) {}

  remember(toolUseId: string, link: Omit<AnthropicSessionLink, "createdAt">): void {
    const id = toolUseId.trim();
    if (!id) return;
    this.prune();
    this.links.set(id, { ...link, createdAt: this.now() });
    while (this.links.size > this.maxEntries) {
      const oldest = this.links.keys().next().value as string | undefined;
      if (!oldest) break;
      this.links.delete(oldest);
    }
  }

  findFromBody(body: unknown): AnthropicContinuation | undefined {
    this.prune();
    for (const toolUseId of anthropicToolResultIds(body).reverse()) {
      const link = this.links.get(toolUseId);
      if (link) return { toolUseId, link };
    }
    return undefined;
  }

  clearSession(sessionKey: string): void {
    for (const [toolUseId, link] of this.links) {
      if (link.sessionKey === sessionKey) this.links.delete(toolUseId);
    }
  }

  clear(): void {
    this.links.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [toolUseId, link] of this.links) {
      if (link.createdAt <= cutoff) this.links.delete(toolUseId);
    }
  }
}
