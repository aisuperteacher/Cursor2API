import "./playground.css";
import { escapeHtml, hydrateIcons, icon } from "./ui";

type Endpoint = "models" | "chat/completions" | "responses" | "messages";

interface PlaygroundRefs {
  baseUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  endpoint: HTMLSelectElement;
  model: HTMLInputElement;
  prompt: HTMLTextAreaElement;
  maxTokens: HTMLInputElement;
  send: HTMLButtonElement;
  status: HTMLElement;
  response: HTMLElement;
  form: HTMLFormElement;
}

const ENDPOINTS: Array<{ value: Endpoint; label: string; method: "GET" | "POST" }> = [
  { value: "models", label: "GET /models", method: "GET" },
  { value: "chat/completions", label: "POST /chat/completions", method: "POST" },
  { value: "responses", label: "POST /responses", method: "POST" },
  { value: "messages", label: "POST /messages", method: "POST" }
];

function lockedMarkup(): string {
  return `
  <div class="pg-app">
    ${headerMarkup()}
    <main class="pg-main">
      <section class="pg-locked">
        <span class="pg-locked-mark">${icon("Lock", { width: 22, height: 22 })}</span>
        <h1>需要管理员登录</h1>
        <p>API 测试页是网关维护者的工具，只在管理员登录后可用。请先登录管理后台，再回到这里。</p>
        <a class="pg-locked-action" href="/dashboard">${icon("KeyRound", { width: 16, height: 16 })} 前往管理后台登录</a>
      </section>
    </main>
  </div>`;
}

function headerMarkup(): string {
  return `
    <header class="pg-header">
      <a class="pg-brand" href="/">
        <span class="pg-brand-mark">${icon("Terminal", { width: 18, height: 18 })}</span>
        <strong>API Playground</strong>
        <span class="pg-sub">/v1 endpoints</span>
      </a>
      <a class="pg-back" href="/dashboard">管理后台</a>
    </header>`;
}

function markup(baseUrl: string): string {
  return `
  <div class="pg-app">
    ${headerMarkup()}

    <main class="pg-main">
      <form class="pg-form" id="pg-form">
        <div class="pg-row">
          <label class="pg-field pg-field-grow">
            <span>Base URL</span>
            <input id="pg-base-url" value="${escapeAttr(baseUrl)}" spellcheck="false" />
          </label>
          <label class="pg-field pg-field-grow">
            <span>Client API Key</span>
            <input id="pg-api-key" type="password" placeholder="sk-..." autocomplete="off" />
          </label>
        </div>

        <div class="pg-row">
          <label class="pg-field">
            <span>Endpoint</span>
            <select id="pg-endpoint">
              ${ENDPOINTS.map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join("")}
            </select>
          </label>
          <label class="pg-field" id="pg-model-field">
            <span>Model</span>
            <input id="pg-model" value="composer-2.5" spellcheck="false" />
          </label>
          <label class="pg-field" id="pg-max-tokens-field">
            <span>Max tokens</span>
            <input id="pg-max-tokens" type="number" value="1024" min="1" />
          </label>
        </div>

        <label class="pg-field" id="pg-prompt-field">
          <span>Prompt / request body</span>
          <textarea id="pg-prompt" rows="5" spellcheck="false"></textarea>
        </label>

        <div class="pg-actions">
          <p class="pg-hint">Key 仅在浏览器内存中使用，和直接用 curl 一样；不会发送到网关之外的任何地方。</p>
          <button class="pg-send" id="pg-send" type="submit">${icon("SendHorizontal", { width: 16, height: 16 })} 发送请求</button>
        </div>
      </form>

      <section class="pg-response" id="pg-response" hidden>
        <div class="pg-response-head">
          <span class="pg-status" id="pg-status"></span>
          <span class="pg-latency" id="pg-latency"></span>
        </div>
        <pre class="pg-body" id="pg-body"></pre>
      </section>
    </main>
  </div>`;
}

function clearError(refs: PlaygroundRefs): void {
  refs.status.textContent = "";
  refs.status.className = "pg-status";
  refs.response.hidden = true;
}

function endpointFor(endpoint: Endpoint): string {
  return `/${endpoint}`;
}

function requestFor(endpoint: Endpoint, model: string, prompt: string, maxTokens: number):
  { method: "GET" | "POST"; body?: Record<string, unknown> } {
  if (endpoint === "models") return { method: "GET" };
  const messages = [{ role: "user", content: prompt }];
  if (endpoint === "chat/completions") return { method: "POST", body: { model, messages, stream: false } };
  if (endpoint === "responses") return { method: "POST", body: { model, input: prompt, stream: false } };
  return { method: "POST", body: { model, messages, max_tokens: maxTokens } };
}

function baseFor(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * The playground is a maintainer tool, not a public page: it is only rendered for
 * an authenticated administrator. This does not gate `/v1` itself (every endpoint
 * already requires a client `sk-` key) - it keeps the tool from being an open
 * invitation to probe the gateway from a browser.
 */
export function mountPlayground(root: HTMLElement): void {
  void boot(root);
}

async function boot(root: HTMLElement): Promise<void> {
  let authenticated = false;
  try {
    const response = await fetch("/api/auth/status", { credentials: "same-origin" });
    const status = await response.json() as { authenticated?: boolean };
    authenticated = Boolean(status.authenticated);
  } catch {
    authenticated = false;
  }

  if (!authenticated) {
    root.innerHTML = lockedMarkup();
    hydrateIcons(root);
    return;
  }
  renderTool(root);
}

function renderTool(root: HTMLElement): void {
  root.innerHTML = markup(`${window.location.origin}/v1`);
  hydrateIcons(root);

  const byId = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const refs: PlaygroundRefs = {
    baseUrl: byId<HTMLInputElement>("pg-base-url"),
    apiKey: byId<HTMLInputElement>("pg-api-key"),
    endpoint: byId<HTMLSelectElement>("pg-endpoint"),
    model: byId<HTMLInputElement>("pg-model"),
    prompt: byId<HTMLTextAreaElement>("pg-prompt"),
    maxTokens: byId<HTMLInputElement>("pg-max-tokens"),
    send: byId<HTMLButtonElement>("pg-send"),
    status: byId<HTMLElement>("pg-status"),
    response: byId<HTMLElement>("pg-response"),
    form: byId<HTMLFormElement>("pg-form")
  };
  const body = byId<HTMLElement>("pg-body");
  const latency = byId<HTMLElement>("pg-latency");

  const toggleFields = (): void => {
    const isModels = refs.endpoint.value === "models";
    refs.model.closest<HTMLElement>(".pg-field")!.hidden = isModels;
    refs.maxTokens.closest<HTMLElement>(".pg-field")!.hidden = isModels || refs.endpoint.value === "responses";
    refs.prompt.closest<HTMLElement>(".pg-field")!.hidden = isModels;
    const needsKey = refs.apiKey.value.trim().startsWith("sk-");
    const endpoint = refs.endpoint.value;
    const usable = endpoint === "models" || needsKey;
    refs.send.disabled = !usable;
    refs.send.title = usable ? "" : "需要先填写客户端 Key（sk-...）";
  };

  refs.endpoint.addEventListener("change", toggleFields);
  refs.apiKey.addEventListener("input", toggleFields);
  toggleFields();

  refs.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });

  const send = async (): Promise<void> => {
    const endpoint = refs.endpoint.value as Endpoint;
    const base = baseFor(refs.baseUrl.value);
    const apiKey = refs.apiKey.value.trim();
    const model = refs.model.value.trim() || "composer-2.5";
    const prompt = refs.prompt.value;
    const maxTokens = Number(refs.maxTokens.value) || 1024;

    clearError(refs);
    refs.response.hidden = false;
    refs.status.textContent = "请求中…";
    refs.status.className = "pg-status pg-loading";
    refs.send.disabled = true;

    const startedAt = performance.now();
    try {
      const { method, body: requestBody } = requestFor(endpoint, model, prompt, maxTokens);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${base}${endpointFor(endpoint)}`, {
        method,
        headers,
        ...(requestBody ? { body: JSON.stringify(requestBody) } : {})
      });
      const text = await response.text();
      latency.textContent = `${Math.round(performance.now() - startedAt)} ms`;
      refs.status.textContent = `${response.status} ${response.statusText}`.trim();
      refs.status.className = `pg-status ${response.ok ? "pg-ok" : "pg-error"}`;
      body.textContent = formatBody(text);
    } catch (error) {
      latency.textContent = `${Math.round(performance.now() - startedAt)} ms`;
      refs.status.textContent = "请求失败";
      refs.status.className = "pg-status pg-error";
      body.textContent = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
    } finally {
      refs.send.disabled = false;
      toggleFields();
    }
  };
}

function formatBody(text: string): string {
  if (!text) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
