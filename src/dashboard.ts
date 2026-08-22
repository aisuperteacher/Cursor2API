import "./dashboard-observability.css";
import { escapeHtml, icon, hydrateIcons } from "./ui";

interface CredentialUsage {
  requests: number;
  completed: number;
  failed: number;
  canceled: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastRequestAt: string | null;
  models: string[];
}

interface Credential {
  id: string;
  label: string;
  hint: string;
  status: "active" | "disabled";
  disabledReason?: string | null;
  managed: boolean;
  source: "console" | "environment";
  models: string[];
  usage?: CredentialUsage | null;
}

interface ClientKey {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
}

interface Settings {
  publicBaseUrl: string;
  baseUrl: string;
}

interface RequestLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  streaming?: boolean;
  clientKeyLabel?: string;
  clientKeyHint?: string;
  credentialLabel?: string;
  credentialHint?: string;
  statusCode: number;
  result: "completed" | "failed" | "canceled";
  durationMs: number;
  firstByteMs?: number;
  errorCode?: string;
}

interface StorageStats {
  enabled: boolean;
  directory: string;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  lastCleanupAt: string | null;
}

interface GatewayUsage {
  retainedRequests: number;
  completed: number;
  failed: number;
  canceled: number;
  averageDurationMs: number;
  p95DurationMs: number;
  lastRequestAt: string | null;
  sampled: boolean;
  byCredential: CredentialUsage[];
}

interface UsageResponse {
  gateway: GatewayUsage;
  storage: StorageStats;
  official: {
    configured: boolean;
    fetchedAt?: string;
    range?: { startDate: number; endDate: number };
    spend?: unknown;
    usageEvents?: unknown;
    error?: string;
  };
}

interface DashboardState {
  credentials: Credential[];
  clientKeys: ClientKey[];
  settings: Settings;
  logs: RequestLogEntry[];
  logsHaveMore: boolean;
  usage: UsageResponse | null;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) }
  });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

export function mountDashboard(root: HTMLElement): void {
  void boot(root);
}

async function boot(root: HTMLElement): Promise<void> {
  try {
    const status = await requestJson<{ configured: boolean; authenticated: boolean }>("/api/auth/status");
    if (!status.authenticated) {
      mountSignIn(root, status.configured);
      return;
    }
    mountConsole(root);
  } catch (error) {
    root.innerHTML = `<main class="dashboard-shell"><div class="dashboard-error">${escapeHtml(error instanceof Error ? error.message : "后台暂时不可用")}</div></main>`;
  }
}

function mountSignIn(root: HTMLElement, configured: boolean): void {
  const title = configured ? "登录控制台" : "设置管理员密码";
  const description = configured
    ? "使用管理员密码进入网关控制台。"
    : "首次使用请设置管理员密码，保护账号池和客户端 API Keys。";
  root.innerHTML = `
    <div class="dashboard-shell dashboard-auth-shell">
      <header class="dashboard-header">
        <a class="brand" href="/"><img class="brand-icon" src="/api-for-cursor-icon.png" width="36" height="36" alt=""/><span class="brand-text">Cursor Gateway</span></a>
        <a class="back-link" href="/">返回首页</a>
      </header>
      <main class="dashboard-auth-main">
        <section class="dashboard-auth-panel">
          <p class="dashboard-kicker">GATEWAY CONSOLE</p>
          <h1>${title}</h1>
          <p>${description}</p>
          <form id="auth-form">
            <label>管理员密码<input id="auth-password" type="password" minlength="8" autocomplete="${configured ? "current-password" : "new-password"}" required autofocus/></label>
            <div id="auth-error" class="dashboard-notice error" hidden></div>
            <button class="btn btn-primary auth-submit" type="submit">${title}</button>
          </form>
        </section>
      </main>
    </div>`;
  root.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = root.querySelector<HTMLInputElement>("#auth-password")?.value || "";
    const errorBox = root.querySelector<HTMLElement>("#auth-error");
    const submit = root.querySelector<HTMLButtonElement>(".auth-submit");
    if (submit) submit.disabled = true;
    void requestJson(configured ? "/api/auth/login" : "/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password })
    }).then(() => boot(root)).catch((error) => {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = error instanceof Error ? error.message : "操作失败";
      }
    }).finally(() => {
      if (submit) submit.disabled = false;
    });
  });
}

function mountConsole(root: HTMLElement): void {
  root.innerHTML = consoleMarkup();
  const state: DashboardState = {
    credentials: [],
    clientKeys: [],
    settings: { publicBaseUrl: "", baseUrl: `${window.location.origin}/v1` },
    logs: [],
    logsHaveMore: false,
    usage: null
  };
  const notice = (message: string, error = false): void => {
    const element = root.querySelector<HTMLElement>("#dashboard-notice");
    if (!element) return;
    element.hidden = !message;
    element.textContent = message;
    element.classList.toggle("error", error);
    element.classList.toggle("success", Boolean(message) && !error);
  };

  const refreshLogs = async (): Promise<void> => {
    const params = new URLSearchParams();
    params.set("limit", root.querySelector<HTMLSelectElement>("#log-limit")?.value || "100");
    const result = root.querySelector<HTMLSelectElement>("#log-result")?.value || "";
    const model = root.querySelector<HTMLInputElement>("#log-model")?.value.trim() || "";
    const path = root.querySelector<HTMLInputElement>("#log-path")?.value.trim() || "";
    if (result) params.set("result", result);
    if (model) params.set("model", model);
    if (path) params.set("path", path);
    const response = await requestJson<{ data: RequestLogEntry[]; hasMore: boolean }>(`/api/request-logs?${params}`);
    state.logs = response.data;
    state.logsHaveMore = response.hasMore;
    renderLogs(root, state.logs, state.logsHaveMore);
  };

  const refreshUsage = async (): Promise<void> => {
    state.usage = await requestJson<UsageResponse>("/api/usage");
    renderUsage(root, state.usage);
  };

  const refresh = async (): Promise<void> => {
    try {
      const [accounts, keys, settings] = await Promise.all([
        requestJson<{ data?: Credential[] }>("/api/credentials"),
        requestJson<{ data?: ClientKey[] }>("/api/keys"),
        requestJson<Settings>("/api/settings")
      ]);
      state.credentials = accounts.data || [];
      state.clientKeys = keys.data || [];
      state.settings = settings;
      renderCore(root, state, refresh, notice);
      await Promise.all([refreshLogs(), refreshUsage()]);
      notice("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载失败";
      if (/401|unauthor/i.test(message)) {
        void boot(root);
        return;
      }
      notice(message, true);
    }
  };

  const accountDialog = root.querySelector<HTMLDialogElement>("#account-dialog")!;
  const keyDialog = root.querySelector<HTMLDialogElement>("#client-key-dialog")!;
  root.querySelector("#add-account")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#import-accounts")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#cancel-account")?.addEventListener("click", () => accountDialog.close());
  root.querySelector("#refresh-all")?.addEventListener("click", () => void refresh());
  root.querySelector("#refresh-logs")?.addEventListener("click", () => void refreshLogs().catch((error) => notice(error instanceof Error ? error.message : "日志刷新失败", true)));
  root.querySelector("#refresh-usage")?.addEventListener("click", () => void refreshUsage().catch((error) => notice(error instanceof Error ? error.message : "用量刷新失败", true)));
  root.querySelector("#log-result")?.addEventListener("change", () => void refreshLogs());
  root.querySelector("#log-limit")?.addEventListener("change", () => void refreshLogs());
  root.querySelector("#logout")?.addEventListener("click", () => {
    void requestJson("/api/auth/logout", { method: "POST" }).finally(() => boot(root));
  });
  root.querySelector("#save-public-url")?.addEventListener("click", () => {
    const publicBaseUrl = root.querySelector<HTMLInputElement>("#public-base-url")?.value || "";
    void requestJson<Settings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ publicBaseUrl })
    }).then((value) => {
      state.settings = value;
      renderConnection(root, state.settings);
      notice("对外地址已保存");
    }).catch((error) => notice(error instanceof Error ? error.message : "保存失败", true));
  });

  root.querySelectorAll<HTMLElement>("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = root.querySelector<HTMLInputElement>(`#${button.dataset.copyTarget || ""}`);
      if (input) void copyInput(input, notice);
    });
  });

  root.querySelector("#clear-logs")?.addEventListener("click", () => {
    void confirmDanger(root, {
      title: "清空请求日志",
      message: "将永久删除当前保留的全部请求日志。此操作不会影响服务运行，但无法撤销。",
      confirmText: "清空日志"
    }).then((confirmed) => {
      if (!confirmed) return;
      return requestJson("/api/request-logs", { method: "DELETE" })
        .then(() => Promise.all([refreshLogs(), refreshUsage()]))
        .then(() => notice("请求日志已清空"));
    }).catch((error) => notice(error instanceof Error ? error.message : "清空失败", true));
  });

  root.querySelector<HTMLFormElement>("#account-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = root.querySelector<HTMLTextAreaElement>("#account-value")?.value || "";
    const label = (root.querySelector<HTMLInputElement>("#account-label")?.value || "Imported").trim() || "Imported";
    const entries = raw.split(/[\r\n]+/).map((line, index) => {
      const separator = line.indexOf(",");
      return separator >= 0
        ? { label: line.slice(0, separator).trim() || `${label} ${index + 1}`, cursorApiKey: line.slice(separator + 1).trim() }
        : { label: raw.includes("\n") ? `${label} ${index + 1}` : label, cursorApiKey: line.trim() };
    }).filter((item) => item.cursorApiKey);
    if (!entries.length) {
      notice("请输入至少一把 Cursor API Key", true);
      return;
    }
    void Promise.all(entries.map((entry) => requestJson("/api/credentials", {
      method: "POST",
      body: JSON.stringify(entry)
    }))).then(() => {
      accountDialog.close();
      root.querySelector<HTMLFormElement>("#account-form")?.reset();
      return refresh();
    }).then(() => notice("账号已导入"))
      .catch((error) => notice(error instanceof Error ? error.message : "导入失败", true));
  });

  root.querySelector("#create-client-key")?.addEventListener("click", () => {
    root.querySelector<HTMLElement>("#client-key-fields")!.hidden = false;
    root.querySelector<HTMLElement>("#client-key-result")!.hidden = true;
    keyDialog.showModal();
  });
  root.querySelector("#cancel-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector("#close-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector<HTMLFormElement>("#client-key-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = root.querySelector<HTMLInputElement>("#client-key-label")?.value || "Default";
    void requestJson<{ token: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ label })
    }).then((created) => {
      root.querySelector<HTMLElement>("#client-key-fields")!.hidden = true;
      root.querySelector<HTMLElement>("#client-key-result")!.hidden = false;
      root.querySelector<HTMLInputElement>("#new-client-key")!.value = created.token;
      return refresh();
    }).catch((error) => notice(error instanceof Error ? error.message : "创建失败", true));
  });

  hydrateIcons(root);
  void refresh();
}

function consoleMarkup(): string {
  const copy = icon("Copy", { width: 16, height: 16 });
  return `
    <div class="dashboard-shell">
      <header class="dashboard-header">
        <a class="brand" href="/"><img class="brand-icon" src="/api-for-cursor-icon.png" width="36" height="36" alt=""/><span class="brand-text">Cursor Gateway</span></a>
        <div class="dashboard-header-right"><span class="dashboard-product">Control Console</span><button class="icon-button" id="logout" title="退出登录" aria-label="退出登录">${icon("LogOut", { width: 16, height: 16 })}</button></div>
      </header>
      <main class="dashboard-main">
        <div class="dashboard-toolbar">
          <div><p class="dashboard-kicker">OPERATIONS</p><h1>网关控制台</h1><p class="dashboard-subtitle">管理 Cursor 账号池、客户端密钥、用量和请求日志。</p></div>
          <div class="toolbar-actions"><button class="icon-button" id="refresh-all" title="刷新全部数据" aria-label="刷新全部数据">${icon("RefreshCw", { width: 17, height: 17 })}</button><button class="btn btn-primary" id="add-account" type="button">${icon("Plus", { width: 16, height: 16 })} 添加账号</button></div>
        </div>

        <section class="dashboard-summary">
          <div class="summary-item"><span>账号</span><strong id="account-count">0</strong></div>
          <div class="summary-item"><span>可用</span><strong id="healthy-count">0</strong></div>
          <div class="summary-item"><span>共同模型</span><strong id="model-count">0</strong></div>
          <div class="summary-item"><span>客户端 Key</span><strong id="client-key-count">0</strong></div>
        </section>

        <section class="dashboard-section connection-section">
          <div class="section-bar"><div><h2>客户端接入</h2><p class="section-note">客户端使用后台创建的独立 <code>sk-...</code> Key，不会接触 Cursor 凭据。</p></div></div>
          <div class="connection-grid endpoint-grid">
            <label>API Base URL<span class="gateway-input"><input id="api-base-url" readonly/><button class="icon-button" type="button" data-copy-target="api-base-url" title="复制 API 地址" aria-label="复制 API 地址">${copy}</button></span></label>
            <label>对外地址<span class="endpoint-editor"><input id="public-base-url" placeholder="https://api.example.com"/><button class="btn btn-secondary" id="save-public-url" type="button">保存</button></span></label>
          </div>
        </section>

        <div id="dashboard-notice" class="dashboard-notice" hidden></div>

        <section class="dashboard-section credentials-section">
          <div class="section-bar"><div><h2>Cursor 账号</h2><p class="section-note">禁用只停止路由；永久删除仅适用于控制台导入的账号。</p></div><button class="btn btn-secondary" id="import-accounts" type="button">批量导入</button></div>
          <div class="credential-table-head"><span>账号</span><span>模型与网关用量</span><span>状态</span><span>操作</span></div>
          <div id="account-list"></div>
        </section>

        <section class="dashboard-section usage-section">
          <div class="section-bar"><div><h2>用量与额度</h2><p class="section-note">网关统计只覆盖本服务流量；配置 Cursor Admin API Key 后可查看官方团队用量。</p></div><button class="icon-button" id="refresh-usage" title="刷新用量" aria-label="刷新用量">${icon("RefreshCw", { width: 16, height: 16 })}</button></div>
          <div id="usage-panel" class="usage-panel"><div class="empty-state"><span>正在加载用量数据...</span></div></div>
        </section>

        <section class="dashboard-section request-logs-section">
          <div class="section-bar"><div><h2>API 请求日志</h2><p class="section-note">仅记录路由元数据，不记录 prompt、消息正文、工具参数或任何完整密钥。</p></div><div class="toolbar-actions"><button class="btn btn-secondary" id="clear-logs" type="button">清空日志</button><button class="icon-button" id="refresh-logs" title="刷新日志" aria-label="刷新日志">${icon("RefreshCw", { width: 16, height: 16 })}</button></div></div>
          <div class="log-filters">
            <label>结果<select id="log-result"><option value="">全部</option><option value="completed">成功</option><option value="failed">失败</option><option value="canceled">已取消</option></select></label>
            <label>模型<input id="log-model" placeholder="例如 grok-4.6"/></label>
            <label>路径<input id="log-path" placeholder="例如 /responses"/></label>
            <label>条数<select id="log-limit"><option>50</option><option selected>100</option><option>200</option><option>500</option></select></label>
          </div>
          <div id="request-log-list" class="request-log-list"><div class="empty-state"><span>正在加载请求日志...</span></div></div>
        </section>

        <section class="dashboard-section client-keys-section">
          <div class="section-bar"><div><h2>客户端 API Keys</h2><p class="section-note">Key 仅在创建时显示一次，撤销后立即失效。</p></div><button class="btn btn-primary" id="create-client-key" type="button">${icon("KeyRound", { width: 16, height: 16 })} 创建 Key</button></div>
          <div class="client-key-head"><span>名称</span><span>密钥标识</span><span>创建时间</span><span>操作</span></div>
          <div id="client-key-list"></div>
        </section>
      </main>

      <dialog id="account-dialog"><form id="account-form"><h2>添加 Cursor 账号</h2><p class="section-note account-key-guide">从 <a href="https://cursor.com/dashboard" target="_blank" rel="noreferrer">cursor.com/dashboard</a> 左侧打开 API KEY，点击新建后复制页面显示的 <code>crsr_...</code> 密钥。</p><label>名称<input id="account-label" placeholder="例如：工作账号"/></label><label>Cursor API Key<textarea id="account-value" rows="7" placeholder="支持多行；批量格式为 名称,Key"></textarea></label><div class="dialog-actions"><button class="btn btn-secondary" id="cancel-account" type="button">取消</button><button class="btn btn-primary" type="submit">保存并校验</button></div></form></dialog>

      <dialog id="client-key-dialog"><form id="client-key-form"><div id="client-key-fields"><h2>创建客户端 API Key</h2><label>名称<input id="client-key-label" placeholder="例如：OpenCode 本机" required/></label><div class="dialog-actions"><button class="btn btn-secondary" id="cancel-client-key" type="button">取消</button><button class="btn btn-primary" type="submit">创建 Key</button></div></div><div id="client-key-result" hidden><h2>保存此 API Key</h2><p class="section-note">关闭窗口后不能再次查看完整 Key。</p><span class="gateway-input"><input id="new-client-key" readonly/><button class="icon-button" type="button" data-copy-target="new-client-key" title="复制 API Key" aria-label="复制 API Key">${copy}</button></span><div class="dialog-actions"><button class="btn btn-primary" id="close-client-key" type="button">完成</button></div></div></form></dialog>

      <dialog id="confirm-dialog" class="confirm-dialog"><form method="dialog"><div class="confirm-icon">${icon("TriangleAlert", { width: 24, height: 24 })}</div><h2 id="confirm-title">确认操作</h2><p id="confirm-message"></p><div class="dialog-actions"><button class="btn btn-secondary" value="cancel">取消</button><button class="btn btn-danger" id="confirm-danger" value="confirm">确认</button></div></form></dialog>
    </div>`;
}

function renderCore(
  root: HTMLElement,
  state: DashboardState,
  refresh: () => Promise<void>,
  notice: (message: string, error?: boolean) => void
): void {
  const active = state.credentials.filter((item) => item.status === "active");
  const common = active.length
    ? active.slice(1).reduce(
        (shared, item) => new Set([...shared].filter((model) => item.models.includes(model))),
        new Set(active[0].models)
      )
    : new Set<string>();
  root.querySelector("#account-count")!.textContent = String(state.credentials.length);
  root.querySelector("#healthy-count")!.textContent = String(active.length);
  root.querySelector("#model-count")!.textContent = String(common.size);
  root.querySelector("#client-key-count")!.textContent = String(state.clientKeys.length);
  renderConnection(root, state.settings);
  renderCredentials(root, state.credentials, refresh, notice);
  renderClientKeys(root, state.clientKeys, refresh, notice);
}

function renderConnection(root: HTMLElement, settings: Settings): void {
  root.querySelector<HTMLInputElement>("#api-base-url")!.value = settings.baseUrl;
  const publicUrl = root.querySelector<HTMLInputElement>("#public-base-url");
  if (publicUrl && document.activeElement !== publicUrl) publicUrl.value = settings.publicBaseUrl || window.location.origin;
}

function renderCredentials(
  root: HTMLElement,
  credentials: Credential[],
  refresh: () => Promise<void>,
  notice: (message: string, error?: boolean) => void
): void {
  const accounts = root.querySelector<HTMLElement>("#account-list")!;
  accounts.innerHTML = credentials.length
    ? credentials.map((item) => {
        const usage = item.usage;
        const usageText = usage
          ? `本网关 ${usage.requests} 次 · 成功 ${usage.completed} · 失败 ${usage.failed} · P95 ${formatDuration(usage.p95DurationMs)}`
          : "本网关暂无请求记录";
        const source = item.managed ? "控制台导入" : "环境变量";
        const statusAction = item.status === "active"
          ? `<button class="btn btn-compact btn-secondary" data-account-status="disabled" data-account-id="${escapeHtml(item.id)}">${icon("X", { width: 14, height: 14 })} 禁用</button>`
          : `<button class="btn btn-compact btn-secondary" data-account-status="active" data-account-id="${escapeHtml(item.id)}">${icon("Check", { width: 14, height: 14 })} 启用</button>`;
        const deleteAction = item.managed
          ? `<button class="icon-button danger" data-delete-account="${escapeHtml(item.id)}" title="永久删除账号" aria-label="永久删除账号">${icon("Trash2", { width: 16, height: 16 })}</button>`
          : `<span class="action-note" title="环境变量账号需从 .env 中移除">由 .env 管理</span>`;
        return `<div class="credential-row"><div class="credential-identity"><strong>${escapeHtml(item.label)}</strong><code>••••${escapeHtml(item.hint)}</code><small>${source}</small></div><div class="credential-models"><div>${escapeHtml(item.models.length ? item.models.join(", ") : "暂无模型")}</div><small>${escapeHtml(usageText)}</small></div><div><span class="credential-status ${item.status === "active" ? "ok" : "disabled"}">${item.status === "active" ? "可用" : "已禁用"}</span>${item.disabledReason ? `<small>${escapeHtml(item.disabledReason)}</small>` : ""}</div><div class="credential-actions">${statusAction}${deleteAction}</div></div>`;
      }).join("")
    : `<div class="empty-state"><strong>还没有 Cursor 账号</strong><span>添加第一把账号 Key，开始建立账号池。</span></div>`;

  accounts.querySelectorAll<HTMLButtonElement>("[data-account-status]").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      const id = button.dataset.accountId || "";
      const status = button.dataset.accountStatus || "";
      void requestJson(`/api/credentials/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      }).then(() => refresh()).then(() => notice(status === "active" ? "账号已启用" : "账号已禁用"))
        .catch((error) => notice(error instanceof Error ? error.message : "操作失败", true))
        .finally(() => { button.disabled = false; });
    });
  });

  accounts.querySelectorAll<HTMLButtonElement>("[data-delete-account]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteAccount || "";
      const credential = credentials.find((item) => item.id === id);
      if (!credential) return;
      void confirmDanger(root, {
        title: "永久删除 Cursor 账号",
        message: `将永久删除“${credential.label}”（尾号 ${credential.hint}）及其加密凭据。此操作无法撤销。`,
        confirmText: "永久删除"
      }).then((confirmed) => {
        if (!confirmed) return;
        button.disabled = true;
        return requestJson(`/api/credentials/${encodeURIComponent(id)}`, { method: "DELETE" })
          .then(() => refresh())
          .then(() => notice("Cursor 账号已永久删除"));
      }).catch((error) => notice(error instanceof Error ? error.message : "删除失败", true))
        .finally(() => { button.disabled = false; });
    });
  });
}

function renderClientKeys(
  root: HTMLElement,
  clientKeys: ClientKey[],
  refresh: () => Promise<void>,
  notice: (message: string, error?: boolean) => void
): void {
  const keys = root.querySelector<HTMLElement>("#client-key-list")!;
  keys.innerHTML = clientKeys.length
    ? clientKeys.map((item) => `<div class="client-key-row"><strong>${escapeHtml(item.label)}</strong><code>sk-••••${escapeHtml(item.hint)}</code><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time><button class="icon-button danger" data-revoke-key="${escapeHtml(item.id)}" title="撤销 API Key" aria-label="撤销 API Key">${icon("Trash2", { width: 16, height: 16 })}</button></div>`).join("")
    : `<div class="empty-state"><strong>还没有客户端 API Key</strong><span>创建 Key 后即可接入 OpenAI、Anthropic 或 Responses 客户端。</span></div>`;

  keys.querySelectorAll<HTMLButtonElement>("[data-revoke-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.revokeKey || "";
      const key = clientKeys.find((item) => item.id === id);
      if (!key) return;
      void confirmDanger(root, {
        title: "撤销客户端 API Key",
        message: `撤销“${key.label}”（尾号 ${key.hint}）后，使用该 Key 的客户端会立即失去访问权限。`,
        confirmText: "确认撤销"
      }).then((confirmed) => {
        if (!confirmed) return;
        button.disabled = true;
        return requestJson(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" })
          .then(() => refresh())
          .then(() => notice("客户端 API Key 已撤销"));
      }).catch((error) => notice(error instanceof Error ? error.message : "撤销失败", true))
        .finally(() => { button.disabled = false; });
    });
  });
}

function renderUsage(root: HTMLElement, usage: UsageResponse): void {
  const panel = root.querySelector<HTMLElement>("#usage-panel")!;
  const gateway = usage.gateway;
  const storage = usage.storage;
  const official = usage.official;
  const officialMarkup = !official.configured
    ? `<div class="official-usage-note"><strong>Cursor 官方用量未配置</strong><span>设置 <code>CURSOR_ADMIN_API_KEY</code> 后，可读取团队 spending 和 usage events。当前账号行仅显示本网关观测到的请求。</span></div>`
    : official.error
      ? `<div class="official-usage-note error"><strong>Cursor 官方用量查询失败</strong><span>${escapeHtml(official.error)}</span></div>`
      : `<details class="official-usage-details"><summary>查看 Cursor 官方团队用量原始数据</summary><div class="official-meta">更新时间 ${escapeHtml(formatDate(official.fetchedAt || ""))}</div><pre>${escapeHtml(JSON.stringify({ spend: official.spend, usageEvents: official.usageEvents }, null, 2))}</pre></details>`;
  panel.innerHTML = `
    <div class="usage-cards">
      <div class="usage-card"><span>保留请求</span><strong>${gateway.retainedRequests}</strong></div>
      <div class="usage-card"><span>成功</span><strong>${gateway.completed}</strong></div>
      <div class="usage-card"><span>失败 / 取消</span><strong>${gateway.failed} / ${gateway.canceled}</strong></div>
      <div class="usage-card"><span>P95 耗时</span><strong>${formatDuration(gateway.p95DurationMs)}</strong></div>
    </div>
    <div class="log-storage-note">日志占用 ${formatBytes(storage.totalBytes)} / ${formatBytes(storage.maxTotalBytes)} · ${storage.fileCount}/${storage.maxFiles} 个文件 · 保留 ${storage.retentionDays} 天${gateway.sampled ? " · 用量统计已采样" : ""}</div>
    ${officialMarkup}`;
}

function renderLogs(root: HTMLElement, logs: RequestLogEntry[], hasMore: boolean): void {
  const list = root.querySelector<HTMLElement>("#request-log-list")!;
  if (!logs.length) {
    list.innerHTML = `<div class="empty-state"><strong>暂无匹配日志</strong><span>新请求完成后会在这里显示。</span></div>`;
    return;
  }
  list.innerHTML = `
    <div class="request-log-head"><span>时间</span><span>接口</span><span>模型 / Cursor 账号</span><span>结果</span><span>耗时</span></div>
    ${logs.map((entry) => `<div class="request-log-row"><time>${escapeHtml(formatDate(entry.timestamp))}</time><div><strong>${escapeHtml(entry.method)}</strong> <code>${escapeHtml(entry.path)}</code>${entry.streaming ? `<small>stream</small>` : ""}</div><div><strong>${escapeHtml(entry.model || "-")}</strong><small>${escapeHtml(entry.credentialLabel ? `${entry.credentialLabel} · ••••${entry.credentialHint || ""}` : "未解析账号")}</small></div><div><span class="log-result ${entry.result}">${logResultText(entry.result)}</span><small>HTTP ${entry.statusCode}${entry.errorCode ? ` · ${escapeHtml(entry.errorCode)}` : ""}</small></div><div><strong>${formatDuration(entry.durationMs)}</strong><small>${entry.firstByteMs !== undefined ? `首字节 ${formatDuration(entry.firstByteMs)}` : ""}</small></div></div>`).join("")}
    ${hasMore ? `<div class="log-more-note">还有更多匹配记录，请缩小筛选范围或提高条数。</div>` : ""}`;
}

async function copyInput(input: HTMLInputElement, notice: (message: string, error?: boolean) => void): Promise<void> {
  const value = input.value;
  if (!value) return;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      notice("已复制到剪贴板");
      return;
    }
  } catch {
    // Fall through to the legacy selection-based copy path.
  }

  input.focus();
  input.select();
  input.setSelectionRange(0, value.length);
  try {
    if (document.execCommand("copy")) {
      notice("已复制到剪贴板");
      input.setSelectionRange(value.length, value.length);
      return;
    }
  } catch {
    // The browser may block execCommand on non-secure origins.
  }
  notice("浏览器阻止了自动复制，内容已选中，请按 Ctrl+C", true);
}

function confirmDanger(
  root: HTMLElement,
  options: { title: string; message: string; confirmText: string }
): Promise<boolean> {
  const dialog = root.querySelector<HTMLDialogElement>("#confirm-dialog")!;
  root.querySelector<HTMLElement>("#confirm-title")!.textContent = options.title;
  root.querySelector<HTMLElement>("#confirm-message")!.textContent = options.message;
  root.querySelector<HTMLButtonElement>("#confirm-danger")!.textContent = options.confirmText;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "-";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function logResultText(result: RequestLogEntry["result"]): string {
  if (result === "completed") return "成功";
  if (result === "canceled") return "已取消";
  return "失败";
}
