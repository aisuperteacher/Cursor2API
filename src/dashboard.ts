import "./dashboard-observability.css";
// Polish must cascade after the observability base styles; importing it here (in
// the same lazy chunk) guarantees its overrides win the cascade.
import "./dashboard-polish.css";
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

interface AccountUsageSummary {
  totalPercent?: number;
  autoPercent?: number;
  apiPercent?: number;
  membershipType?: string;
  rawFallback?: boolean;
  error?: string;
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
  accountUsage?: AccountUsageSummary | null;
}

interface ClientKey {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
}

interface RateLimitConfig {
  enabled: boolean;
  windowSeconds: number;
  maxFailuresPerIp: number;
  maxRequestsPerKey: number;
  blockSeconds: number;
}

interface Settings {
  publicBaseUrl: string;
  baseUrl: string;
  rateLimit?: RateLimitConfig;
}

interface RequestLogEntry {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  reasoningEffort?: string;
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

interface OfficialUsageSummary {
  totalSpend?: number;
  currency?: string;
  membershipType?: string;
  byModel: Array<{ model: string; requests: number; percent: number }>;
  byDay: Array<{ date: string; requests: number }>;
  rawFallback?: boolean;
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
    summary?: OfficialUsageSummary;
    error?: string;
  };
}

interface DashboardState {
  credentials: Credential[];
  clientKeys: ClientKey[];
  settings: Settings;
  logs: RequestLogEntry[];
  logsHaveMore: boolean;
  logCursor: string;
  logNextCursor: string;
  logCursorHistory: string[];
  logPage: number;
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
      <div class="dashboard-auth-backdrop"></div>
      <header class="dashboard-header">
        <a class="brand" href="/"><img class="brand-icon" src="/api-for-cursor-icon.png" width="36" height="36" alt=""/><span class="brand-text">Cursor Gateway</span></a>
        <a class="back-link" href="/">返回首页</a>
      </header>
      <main class="dashboard-auth-main">
        <section class="dashboard-auth-panel">
          <div class="auth-product-mark">${icon("ShieldCheck", { width: 24, height: 24 })}</div>
          <p class="dashboard-kicker">GATEWAY CONTROL PLANE</p>
          <h1>${title}</h1>
          <p>${description}</p>
          <form id="auth-form">
            <label>管理员密码<input id="auth-password" type="password" minlength="8" autocomplete="${configured ? "current-password" : "new-password"}" required autofocus/></label>
            <div id="auth-error" class="dashboard-notice error" hidden></div>
            <button class="btn btn-primary auth-submit" type="submit">${icon("Lock", { width: 16, height: 16 })}${title}</button>
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
    logCursor: "",
    logNextCursor: "",
    logCursorHistory: [],
    logPage: 1,
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

  const resetLogPaging = (): void => {
    state.logCursor = "";
    state.logNextCursor = "";
    state.logCursorHistory = [];
    state.logPage = 1;
  };

  // In-flight log requests are superseded by newer ones so a slow response can
  // never overwrite the page the user has navigated to meanwhile.
  let refreshLogsSeq = 0;

  const refreshLogs = async (reset = false): Promise<void> => {
    const token = ++refreshLogsSeq;
    if (reset) resetLogPaging();
    const params = new URLSearchParams();
    params.set("limit", root.querySelector<HTMLSelectElement>("#log-limit")?.value || "10");
    if (state.logCursor) params.set("cursor", state.logCursor);
    const result = root.querySelector<HTMLSelectElement>("#log-result")?.value || "";
    const model = root.querySelector<HTMLInputElement>("#log-model")?.value.trim() || "";
    const path = root.querySelector<HTMLInputElement>("#log-path")?.value.trim() || "";
    if (result) params.set("result", result);
    if (model) params.set("model", model);
    if (path) params.set("path", path);
    const response = await requestJson<{ data: RequestLogEntry[]; hasMore: boolean; nextCursor?: string }>(`/api/request-logs?${params}`);
    if (token !== refreshLogsSeq) return;
    state.logs = response.data;
    state.logsHaveMore = response.hasMore;
    state.logNextCursor = response.nextCursor || "";
    renderLogs(root, state, () => {
      if (state.logPage <= 1) return;
      state.logCursor = state.logCursorHistory.pop() || "";
      state.logPage = Math.max(1, state.logPage - 1);
      loadLogs();
    }, () => {
      if (!state.logsHaveMore || !state.logNextCursor) return;
      state.logCursorHistory.push(state.logCursor);
      state.logCursor = state.logNextCursor;
      state.logPage += 1;
      loadLogs();
    });
  };

  const loadLogs = (reset = false): void => {
    void refreshLogs(reset).catch((error) => {
      renderPanelError(root, "#request-log-list", "请求日志加载失败", error);
      notice(error instanceof Error ? error.message : "日志加载失败", true);
    });
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
      // Logs and usage are observability extras: a failure there (e.g. an older
      // server build without these endpoints) must not wedge the panels on
      // "loading", and must not hide the core account/key data either.
      const [logsResult, usageResult] = await Promise.allSettled([refreshLogs(true), refreshUsage()]);
      if (logsResult.status === "rejected") renderPanelError(root, "#request-log-list", "请求日志加载失败", logsResult.reason);
      if (usageResult.status === "rejected") renderPanelError(root, "#usage-panel", "用量数据加载失败", usageResult.reason);
      if (logsResult.status === "rejected") {
        notice(logsResult.reason instanceof Error ? logsResult.reason.message : "日志加载失败", true);
      } else if (usageResult.status === "rejected") {
        notice(usageResult.reason instanceof Error ? usageResult.reason.message : "用量加载失败", true);
      } else {
        notice("");
      }
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
  root.querySelector("#add-account")?.addEventListener("click", () => {
    dialogError(root, "account-dialog", "");
    accountDialog.showModal();
  });
  root.querySelector("#import-accounts")?.addEventListener("click", () => {
    dialogError(root, "account-dialog", "");
    accountDialog.showModal();
  });
  root.querySelector("#cancel-account")?.addEventListener("click", () => accountDialog.close());
  root.querySelector("#refresh-all")?.addEventListener("click", () => void refresh());
  root.querySelector("#refresh-logs")?.addEventListener("click", () => loadLogs(true));
  root.querySelector("#refresh-usage")?.addEventListener("click", () => void refreshUsage().catch((error) => {
    renderPanelError(root, "#usage-panel", "用量数据加载失败", error);
    notice(error instanceof Error ? error.message : "用量刷新失败", true);
  }));
  root.querySelector("#log-result")?.addEventListener("change", () => loadLogs(true));
  root.querySelector("#log-limit")?.addEventListener("change", () => loadLogs(true));
  root.querySelector("#log-model")?.addEventListener("change", () => loadLogs(true));
  root.querySelector("#log-path")?.addEventListener("change", () => loadLogs(true));
  ["#log-model", "#log-path"].forEach((selector) => {
    root.querySelector<HTMLInputElement>(selector)?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loadLogs(true);
    });
  });
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

  root.querySelector("#rate-limit-enabled")?.addEventListener("change", (event) => {
    updateRateLimitDisabledState(root, (event.target as HTMLInputElement).checked);
  });

  root.querySelector("#save-rate-limit")?.addEventListener("click", () => {
    const button = root.querySelector<HTMLButtonElement>("#save-rate-limit");
    if (button) button.disabled = true;
    void requestJson<Settings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ rateLimit: readRateLimitForm(root) })
    }).then((value) => {
      state.settings = value;
      // The server clamps out-of-range values; re-render so the form shows what
      // is actually in force rather than what was typed.
      renderRateLimit(root, value.rateLimit);
      notice(value.rateLimit?.enabled ? "限流规则已启用" : "限流已关闭");
    }).catch((error) => notice(error instanceof Error ? error.message : "保存失败", true))
      .finally(() => { if (button) button.disabled = false; });
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
        .then(() => Promise.all([refreshLogs(true), refreshUsage()]))
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
      dialogError(root, "account-dialog", "请输入至少一把 Cursor API Key（每行一把，支持“名称,Key”格式）");
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
      .catch((error) => dialogError(root, "account-dialog", error instanceof Error ? error.message : "导入失败"));
  });

  root.querySelector("#create-client-key")?.addEventListener("click", () => {
    root.querySelector<HTMLElement>("#client-key-fields")!.hidden = false;
    root.querySelector<HTMLElement>("#client-key-result")!.hidden = true;
    dialogError(root, "client-key-dialog", "");
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
    }).catch((error) => dialogError(root, "client-key-dialog", error instanceof Error ? error.message : "创建失败"));
  });

  hydrateIcons(root);
  void refresh();
}

function consoleMarkup(): string {
  const copy = icon("Copy", { width: 16, height: 16 });
  return `
    <div class="dashboard-shell console-shell">
      <aside class="console-sidebar">
        <a class="console-brand" href="/" aria-label="Cursor Gateway 控制台首页">
          <span class="console-brand-mark"><img src="/api-for-cursor-icon.png" width="34" height="34" alt=""/></span>
          <span><strong>Cursor Gateway</strong><small>Control Console</small></span>
        </a>
        <!-- The label + title stay available to assistive tech and tooltips even
             when the sidebar collapses to icons and the visible span is hidden. -->
        <nav class="console-nav" aria-label="控制台导航">
          <a href="#overview" aria-label="概览" title="概览">${icon("MonitorDot", { width: 17, height: 17 })}<span>概览</span></a>
          <a href="#connection" aria-label="客户端接入" title="客户端接入">${icon("Server", { width: 17, height: 17 })}<span>客户端接入</span></a>
          <a href="#credentials" aria-label="Cursor 账号" title="Cursor 账号">${icon("User", { width: 17, height: 17 })}<span>Cursor 账号</span></a>
          <a href="#usage" aria-label="用量与额度" title="用量与额度">${icon("Zap", { width: 17, height: 17 })}<span>用量与额度</span></a>
          <a href="#request-logs" aria-label="请求日志" title="请求日志">${icon("Terminal", { width: 17, height: 17 })}<span>请求日志</span></a>
          <a href="#client-keys" aria-label="客户端 Keys" title="客户端 Keys">${icon("KeyRound", { width: 17, height: 17 })}<span>客户端 Keys</span></a>
          <a href="#rate-limit" aria-label="限流与防护" title="限流与防护">${icon("ShieldCheck", { width: 17, height: 17 })}<span>限流与防护</span></a>
        </nav>
        <div class="console-sidebar-note">
          <span class="console-status-dot"></span>
          <div><strong>元数据安全日志</strong><small>不保存 prompt、消息正文或完整密钥</small></div>
        </div>
      </aside>

      <div class="console-workspace">
        <header class="console-topbar">
          <div class="console-breadcrumb"><span>Operations</span><strong>Gateway</strong></div>
          <div class="console-topbar-actions">
            <div class="gateway-health" id="gateway-status"><span></span><strong id="gateway-status-text">正在检查</strong></div>
            <button class="icon-button" id="refresh-all" title="刷新全部数据" aria-label="刷新全部数据">${icon("RefreshCw", { width: 17, height: 17 })}</button>
            <button class="btn btn-primary" id="add-account" type="button">${icon("Plus", { width: 16, height: 16 })} 添加账号</button>
            <button class="icon-button" id="logout" title="退出登录" aria-label="退出登录">${icon("LogOut", { width: 16, height: 16 })}</button>
          </div>
        </header>

        <main class="dashboard-main">
          <section id="overview" class="console-hero">
            <div class="console-hero-copy">
              <p class="dashboard-kicker">CONTROL PLANE</p>
              <h1>网关运行中心</h1>
              <p class="dashboard-subtitle">统一管理账号池、访问密钥、官方用量和可审计的请求元数据。</p>
            </div>
            <div class="dashboard-summary">
              <div class="summary-item"><span class="summary-icon">${icon("User", { width: 18, height: 18 })}</span><div><small>账号总数</small><strong id="account-count">0</strong></div></div>
              <div class="summary-item"><span class="summary-icon success">${icon("ShieldCheck", { width: 18, height: 18 })}</span><div><small>可用账号</small><strong id="healthy-count">0</strong></div></div>
              <div class="summary-item"><span class="summary-icon violet">${icon("Sparkles", { width: 18, height: 18 })}</span><div><small>共同模型</small><strong id="model-count">0</strong></div></div>
              <div class="summary-item"><span class="summary-icon amber">${icon("KeyRound", { width: 18, height: 18 })}</span><div><small>客户端 Keys</small><strong id="client-key-count">0</strong></div></div>
            </div>
          </section>

          <div id="dashboard-notice" class="dashboard-notice" hidden></div>

          <div class="console-grid console-grid-primary">
            <section id="connection" class="dashboard-section console-card connection-section">
              <div class="section-bar">
                <div class="section-title"><span class="section-icon">${icon("Server", { width: 18, height: 18 })}</span><div><h2>客户端接入</h2><p class="section-note">为 OpenAI、Anthropic 和 Responses 客户端提供统一入口。</p></div></div>
                <span class="section-badge" id="connection-state">当前来源</span>
              </div>
              <div class="connection-grid endpoint-grid">
                <label>API Base URL<span class="gateway-input"><input id="api-base-url" readonly/><button class="icon-button" type="button" data-copy-target="api-base-url" title="复制 API 地址" aria-label="复制 API 地址">${copy}</button></span></label>
                <label>对外地址<span class="endpoint-editor"><input id="public-base-url" placeholder="https://api.example.com"/><button class="btn btn-secondary" id="save-public-url" type="button">保存</button></span></label>
              </div>
              <div class="connection-footnote">客户端仅使用后台生成的 <code>sk-...</code> Key，不会接触 Cursor 凭据。<a class="connection-playground-link" href="/playground">${icon("Terminal", { width: 14, height: 14 })} 打开 API 测试页</a></div>
            </section>

            <section id="usage" class="dashboard-section console-card usage-section">
              <div class="section-bar">
                <div class="section-title"><span class="section-icon violet">${icon("Zap", { width: 18, height: 18 })}</span><div><h2>用量与额度</h2><p class="section-note">区分本网关观测数据与 Cursor 官方团队用量。</p></div></div>
                <button class="icon-button" id="refresh-usage" title="刷新用量" aria-label="刷新用量">${icon("RefreshCw", { width: 16, height: 16 })}</button>
              </div>
              <div id="usage-panel" class="usage-panel"><div class="empty-state compact"><span>正在加载用量数据...</span></div></div>
            </section>
          </div>

          <section id="credentials" class="dashboard-section console-card credentials-section">
            <div class="section-bar">
              <div class="section-title"><span class="section-icon success">${icon("User", { width: 18, height: 18 })}</span><div><h2>Cursor 账号池</h2><p class="section-note">禁用仅停止路由；控制台导入账号可以永久删除；环境变量账号需修改部署配置。</p></div></div>
              <button class="btn btn-secondary" id="import-accounts" type="button">${icon("Plus", { width: 15, height: 15 })} 批量导入</button>
            </div>
            <div class="credential-table-wrap">
              <div class="credential-table-head"><span>账号</span><span>模型与网关用量</span><span>状态</span><span>操作</span></div>
              <div id="account-list"></div>
            </div>
          </section>

          <section id="request-logs" class="dashboard-section console-card request-logs-section">
            <div class="section-bar">
              <div class="section-title"><span class="section-icon dark">${icon("Terminal", { width: 18, height: 18 })}</span><div><h2>API 请求日志</h2><p class="section-note">只记录路由元数据；推理级别仅展示请求显式传入的值。</p></div></div>
              <div class="toolbar-actions"><button class="btn btn-ghost danger-text" id="clear-logs" type="button">清空日志</button><button class="icon-button" id="refresh-logs" title="刷新日志" aria-label="刷新日志">${icon("RefreshCw", { width: 16, height: 16 })}</button></div>
            </div>
            <div class="log-filter-panel">
              <div class="log-filters">
                <label>结果<select id="log-result"><option value="">全部</option><option value="completed">成功</option><option value="failed">失败</option><option value="canceled">已取消</option></select></label>
                <label>模型<input id="log-model" placeholder="例如 grok-4.6"/></label>
                <label>路径<input id="log-path" placeholder="例如 /responses"/></label>
                <label>每页<select id="log-limit"><option selected>10</option><option>20</option><option>50</option></select></label>
              </div>
              <p class="log-filter-help"><strong>已取消</strong>表示客户端在响应完成前主动停止或连接中断，例如点击停止、CLI Ctrl+C、客户端超时、浏览器关闭或网络断开。</p>
            </div>
            <div id="request-log-list" class="request-log-list"><div class="empty-state"><span>正在加载请求日志...</span></div></div>
          </section>

          <section id="client-keys" class="dashboard-section console-card client-keys-section">
            <div class="section-bar">
              <div class="section-title"><span class="section-icon amber">${icon("KeyRound", { width: 18, height: 18 })}</span><div><h2>客户端 API Keys</h2><p class="section-note">Key 仅在创建时完整显示一次；撤销后立即失效。</p></div></div>
              <button class="btn btn-primary" id="create-client-key" type="button">${icon("KeyRound", { width: 16, height: 16 })} 创建 Key</button>
            </div>
            <div class="client-key-table-wrap">
              <div class="client-key-head"><span>名称</span><span>密钥标识</span><span>创建时间</span><span>操作</span></div>
              <div id="client-key-list"></div>
            </div>
          </section>

          <section id="rate-limit" class="dashboard-section console-card rate-limit-section">
            <div class="section-bar">
              <div class="section-title"><span class="section-icon success">${icon("ShieldCheck", { width: 18, height: 18 })}</span><div><h2>限流与防护</h2><p class="section-note">按你的实际流量自定义 <code>/v1</code> 的限流规则；关闭时网关不做任何节流。</p></div></div>
              <span class="section-badge" id="rate-limit-state">已关闭</span>
            </div>
            <label class="rate-limit-toggle">
              <input id="rate-limit-enabled" type="checkbox"/>
              <span><strong>启用限流</strong><small>只影响 <code>/v1</code> 接口；管理后台与登录不受此处配置影响。</small></span>
            </label>
            <div class="rate-limit-grid">
              <label>统计窗口（秒）<input id="rate-limit-window" type="number" min="1" max="3600" step="1"/><small>两个计数器共用的滚动窗口，1–3600。</small></label>
              <label>每 IP 鉴权失败上限<input id="rate-limit-failures" type="number" min="0" max="100000" step="1"/><small>窗口内同一 IP 的 401 次数上限，防止匿名扫描；0 = 不限制。</small></label>
              <label>每 Key 请求上限<input id="rate-limit-key-quota" type="number" min="0" max="10000000" step="1"/><small>窗口内单个客户端 Key 的请求上限；0 = 不限制。</small></label>
              <label>触发后封禁（秒）<input id="rate-limit-block" type="number" min="0" max="86400" step="1"/><small>超限后持续返回 429 的时长；0 = 仅拒绝到本窗口结束。</small></label>
            </div>
            <div class="rate-limit-actions">
              <p class="section-note" id="rate-limit-summary"></p>
              <button class="btn btn-primary" id="save-rate-limit" type="button">保存限流规则</button>
            </div>
          </section>
        </main>
      </div>

      <dialog id="account-dialog"><form id="account-form"><div class="dialog-heading"><span class="dialog-mark">${icon("User", { width: 20, height: 20 })}</span><div><h2>添加 Cursor 账号</h2><p>导入后会立即校验模型目录。</p></div></div><p class="section-note account-key-guide">从 <a href="https://cursor.com/dashboard" target="_blank" rel="noreferrer">cursor.com/dashboard</a> 左侧打开 API KEY，点击新建后复制页面显示的 <code>crsr_...</code> 密钥。</p><label>名称<input id="account-label" placeholder="例如：工作账号"/></label><label>Cursor API Key<textarea id="account-value" rows="7" placeholder="支持多行；批量格式为 名称,Key"></textarea></label><p class="dialog-error" hidden></p><div class="dialog-actions"><button class="btn btn-secondary" id="cancel-account" type="button">取消</button><button class="btn btn-primary" type="submit">保存并校验</button></div></form></dialog>

      <dialog id="client-key-dialog"><form id="client-key-form"><div id="client-key-fields"><div class="dialog-heading"><span class="dialog-mark amber">${icon("KeyRound", { width: 20, height: 20 })}</span><div><h2>创建客户端 API Key</h2><p>用于客户端访问网关，不会暴露 Cursor 凭据。</p></div></div><label>名称<input id="client-key-label" placeholder="例如：OpenCode 本机" required/></label><p class="dialog-error" hidden></p><div class="dialog-actions"><button class="btn btn-secondary" id="cancel-client-key" type="button">取消</button><button class="btn btn-primary" type="submit">创建 Key</button></div></div><div id="client-key-result" hidden><h2>保存此 API Key</h2><p class="section-note">关闭窗口后不能再次查看完整 Key。</p><span class="gateway-input"><input id="new-client-key" readonly/><button class="icon-button" type="button" data-copy-target="new-client-key" title="复制 API Key" aria-label="复制 API Key">${copy}</button></span><div class="dialog-actions"><button class="btn btn-primary" id="close-client-key" type="button">完成</button></div></div></form></dialog>

      <dialog id="confirm-dialog" class="confirm-dialog"><form method="dialog"><div class="confirm-icon">${icon("TriangleAlert", { width: 24, height: 24 })}</div><h2 id="confirm-title">确认操作</h2><p id="confirm-message"></p><div class="dialog-actions"><button class="btn btn-secondary" value="cancel">取消</button><button class="btn btn-danger" id="confirm-danger" value="confirm">确认</button></div></form></dialog>

      <dialog id="info-dialog" class="info-dialog"><form method="dialog"><div class="dialog-heading"><span class="dialog-mark">${icon("Server", { width: 20, height: 20 })}</span><div><h2 id="info-title">操作说明</h2><p id="info-message"></p></div></div><pre id="info-command"></pre><div class="dialog-actions"><button class="btn btn-primary" value="close">知道了</button></div></form></dialog>
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
  const gatewayStatus = root.querySelector<HTMLElement>("#gateway-status");
  const gatewayStatusText = root.querySelector<HTMLElement>("#gateway-status-text");
  if (gatewayStatus && gatewayStatusText) {
    const ready = active.length > 0;
    gatewayStatus.classList.toggle("warning", !ready);
    gatewayStatusText.textContent = ready ? "运行就绪" : "无可用账号";
  }
  renderConnection(root, state.settings);
  renderRateLimit(root, state.settings.rateLimit);
  renderCredentials(root, state.credentials, refresh, notice);
  renderClientKeys(root, state.clientKeys, refresh, notice);
}

function renderConnection(root: HTMLElement, settings: Settings): void {
  root.querySelector<HTMLInputElement>("#api-base-url")!.value = settings.baseUrl;
  const publicUrl = root.querySelector<HTMLInputElement>("#public-base-url");
  if (publicUrl && document.activeElement !== publicUrl) publicUrl.value = settings.publicBaseUrl || window.location.origin;
  const state = root.querySelector<HTMLElement>("#connection-state");
  if (state) state.textContent = settings.publicBaseUrl ? "自定义地址" : "当前来源";
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  enabled: false,
  windowSeconds: 60,
  maxFailuresPerIp: 30,
  maxRequestsPerKey: 0,
  blockSeconds: 300
};

function rateLimitInputs(root: HTMLElement) {
  return {
    enabled: root.querySelector<HTMLInputElement>("#rate-limit-enabled"),
    window: root.querySelector<HTMLInputElement>("#rate-limit-window"),
    failures: root.querySelector<HTMLInputElement>("#rate-limit-failures"),
    keyQuota: root.querySelector<HTMLInputElement>("#rate-limit-key-quota"),
    block: root.querySelector<HTMLInputElement>("#rate-limit-block")
  };
}

function renderRateLimit(root: HTMLElement, config: RateLimitConfig = DEFAULT_RATE_LIMIT): void {
  const inputs = rateLimitInputs(root);
  // Never clobber a field the owner is typing into.
  const set = (input: HTMLInputElement | null, value: number): void => {
    if (input && document.activeElement !== input) input.value = String(value);
  };
  if (inputs.enabled && document.activeElement !== inputs.enabled) inputs.enabled.checked = config.enabled;
  set(inputs.window, config.windowSeconds);
  set(inputs.failures, config.maxFailuresPerIp);
  set(inputs.keyQuota, config.maxRequestsPerKey);
  set(inputs.block, config.blockSeconds);

  const badge = root.querySelector<HTMLElement>("#rate-limit-state");
  if (badge) {
    badge.textContent = config.enabled ? "已启用" : "已关闭";
    badge.classList.toggle("ok", config.enabled);
  }
  const summary = root.querySelector<HTMLElement>("#rate-limit-summary");
  if (summary) summary.textContent = rateLimitSummary(config);
  updateRateLimitDisabledState(root, config.enabled);
}

function updateRateLimitDisabledState(root: HTMLElement, enabled: boolean): void {
  const inputs = rateLimitInputs(root);
  for (const input of [inputs.window, inputs.failures, inputs.keyQuota, inputs.block]) {
    if (input) input.disabled = !enabled;
  }
  root.querySelector<HTMLElement>(".rate-limit-grid")?.classList.toggle("is-disabled", !enabled);
}

function rateLimitSummary(config: RateLimitConfig): string {
  if (!config.enabled) return "当前不限流：任何来源都可以按任意速率请求 /v1（未授权请求仍然返回 401）。";
  const parts: string[] = [];
  parts.push(config.maxFailuresPerIp > 0
    ? `同一 IP 在 ${config.windowSeconds} 秒内鉴权失败超过 ${config.maxFailuresPerIp} 次即拒绝`
    : "不限制单 IP 的鉴权失败次数");
  parts.push(config.maxRequestsPerKey > 0
    ? `单个 Key 在 ${config.windowSeconds} 秒内超过 ${config.maxRequestsPerKey} 次请求即拒绝`
    : "不限制单个 Key 的请求量");
  parts.push(config.blockSeconds > 0 ? `触发后封禁 ${config.blockSeconds} 秒` : "触发后仅拒绝到本窗口结束");
  return `${parts.join("；")}。超限返回 429 并带 Retry-After。`;
}

function readRateLimitForm(root: HTMLElement): RateLimitConfig {
  const inputs = rateLimitInputs(root);
  const number = (input: HTMLInputElement | null, fallback: number): number => {
    const parsed = Number.parseInt(input?.value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: Boolean(inputs.enabled?.checked),
    windowSeconds: number(inputs.window, DEFAULT_RATE_LIMIT.windowSeconds),
    maxFailuresPerIp: number(inputs.failures, DEFAULT_RATE_LIMIT.maxFailuresPerIp),
    maxRequestsPerKey: number(inputs.keyQuota, DEFAULT_RATE_LIMIT.maxRequestsPerKey),
    blockSeconds: number(inputs.block, DEFAULT_RATE_LIMIT.blockSeconds)
  };
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
          ? `本网关 ${usage.requests} 次 · 成功 ${usage.completed} · 失败 ${usage.failed} · 取消 ${usage.canceled} · P95 ${formatDuration(usage.p95DurationMs)}`
          : "本网关暂无请求记录";
        const source = item.managed ? "控制台导入" : "环境变量";
        const statusAction = item.status === "active"
          ? `<button class="btn btn-compact btn-secondary" data-account-status="disabled" data-account-id="${escapeHtml(item.id)}">${icon("X", { width: 14, height: 14 })} 禁用</button>`
          : `<button class="btn btn-compact btn-secondary" data-account-status="active" data-account-id="${escapeHtml(item.id)}">${icon("Check", { width: 14, height: 14 })} 启用</button>`;
        const deleteAction = item.managed
          ? `<button class="icon-button danger" data-delete-account="${escapeHtml(item.id)}" title="永久删除账号" aria-label="永久删除账号">${icon("Trash2", { width: 16, height: 16 })}</button>`
          : `<button class="btn btn-compact btn-ghost" data-env-help="${escapeHtml(item.id)}" type="button">移除方法</button>`;
        return `<div class="credential-row"><div class="credential-identity"><div class="credential-avatar">${escapeHtml(item.label.slice(0, 1).toUpperCase() || "C")}</div><div><strong>${escapeHtml(item.label)}</strong><code>••••${escapeHtml(item.hint)}</code><span class="source-badge ${item.managed ? "managed" : "environment"}">${source}</span></div></div><div class="credential-models">${modelPills(item.models)}<small>${escapeHtml(usageText)}</small>${accountUsageMarkup(item.accountUsage)}</div><div><span class="credential-status ${item.status === "active" ? "ok" : "disabled"}">${item.status === "active" ? "可用" : "已禁用"}</span>${item.disabledReason ? `<small>${escapeHtml(item.disabledReason)}</small>` : ""}</div><div class="credential-actions">${statusAction}${deleteAction}</div></div>`;
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

  accounts.querySelectorAll<HTMLButtonElement>("[data-env-help]").forEach((button) => {
    button.addEventListener("click", () => {
      const credential = credentials.find((item) => item.id === (button.dataset.envHelp || ""));
      if (!credential) return;
      showInfoDialog(root, {
        title: "移除环境变量账号",
        message: `“${credential.label}”（尾号 ${credential.hint}）来自部署环境，控制台无法修改 .env。删除对应配置并重建 API 容器后，该账号才会消失。`,
        command: "# 删除 CURSOR_API_KEY 对应行，或从 CURSOR_API_KEYS 中移除该项\ndocker compose up -d --no-deps --force-recreate api"
      });
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
    ? clientKeys.map((item) => `<div class="client-key-row"><div class="client-key-name"><span>${icon("KeyRound", { width: 15, height: 15 })}</span><strong>${escapeHtml(item.label)}</strong></div><code>sk-••••${escapeHtml(item.hint)}</code><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time><button class="icon-button danger" data-revoke-key="${escapeHtml(item.id)}" title="撤销 API Key" aria-label="撤销 API Key">${icon("Trash2", { width: 16, height: 16 })}</button></div>`).join("")
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

/** Replace a panel's loading state with an inline error instead of leaving it spinning forever. */
function renderPanelError(root: HTMLElement, selector: string, title: string, error: unknown): void {
  const panel = root.querySelector<HTMLElement>(selector);
  if (!panel) return;
  const message = error instanceof Error ? error.message : "加载失败";
  const hint = /not found/i.test(message)
    ? "当前服务未提供该接口；请升级到包含可观测功能的版本，或检查部署配置。"
    : "请稍后重试，或检查服务运行状态。";
  const compact = selector === "#usage-panel" ? " compact" : "";
  panel.innerHTML = `<div class="empty-state${compact}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}。${escapeHtml(hint)}</span></div>`;
}

function accountUsageMarkup(usage?: AccountUsageSummary | null): string {
  if (!usage) return "";
  if (usage.error) return `<small class="account-usage-error">额度查询失败：${escapeHtml(usage.error)}</small>`;
  const hasAny = typeof usage.totalPercent === "number" || typeof usage.autoPercent === "number" || typeof usage.apiPercent === "number";
  if (usage.rawFallback || !hasAny) return "";
  const row = (label: string, value?: number): string => {
    if (typeof value !== "number") return "";
    const pct = Math.min(100, Math.max(0, Math.round(value)));
    return `<span class="au-row"><em>${label}</em><span class="au-track"><span class="au-fill" style="width:${pct}%"></span></span><b>${pct}%</b></span>`;
  };
  const bars = row("Total", usage.totalPercent) + row("Auto", usage.autoPercent) + row("API", usage.apiPercent);
  if (!bars) return "";
  const type = usage.membershipType ? `<span class="au-type">${escapeHtml(usage.membershipType)}</span>` : "";
  return `<div class="account-usage">${type}<div class="au-bars">${bars}</div></div>`;
}

function formatCurrency(value: number, currency?: string): string {
  const symbol = currency?.toLowerCase() === "usd" ? "$"
    : (currency?.toLowerCase() === "cny" || currency?.toLowerCase() === "rmb") ? "¥"
    : currency ?? "";
  return `${symbol}${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

/** Visualize the official Cursor usage summary: spend card, model bars, day trend. */
function officialSummaryMarkup(summary: OfficialUsageSummary): string {
  const hasSpend = typeof summary.totalSpend === "number";
  const hasModels = summary.byModel.length > 0;
  const hasDays = summary.byDay.length > 0;
  if (!hasSpend && !hasModels && !hasDays) return "";

  const maxDayRequests = Math.max(1, ...summary.byDay.map((item) => item.requests));
  const bars = summary.byModel.map((item) => `
    <div class="official-bar">
      <span class="official-bar-label" title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</span>
      <span class="official-bar-track"><span class="official-bar-fill" style="width:${Math.min(100, item.percent)}%"></span></span>
      <span class="official-bar-value">${item.requests} · ${item.percent}%</span>
    </div>`).join("");

  const trend = hasDays ? `
    <div class="official-trend">
      ${summary.byDay.map((item) => {
        const height = Math.round((item.requests / maxDayRequests) * 100);
        return `<span class="official-trend-col" title="${escapeHtml(item.date)} · ${item.requests}">
            <span class="official-trend-fill" style="height:${Math.max(3, height)}%"></span>
            <em>${escapeHtml(item.date.slice(5))}</em>
          </span>`;
      }).join("")}
    </div>` : "";

  const spendCard = hasSpend ? `
    <div class="official-spend-card">
      <span>总花费</span>
      <strong>${formatCurrency(summary.totalSpend!, summary.currency)}</strong>
      ${summary.currency ? `<em>${escapeHtml(summary.currency.toUpperCase())}</em>` : ""}
    </div>` : "";

  return `
    <div class="official-summary">
      ${spendCard}
      ${hasModels ? `<div class="official-panel"><div class="official-panel-title">模型用量</div><div class="official-bars">${bars}</div></div>` : ""}
      ${trend ? `<div class="official-panel"><div class="official-panel-title">用量趋势（近 ${summary.byDay.length} 天）</div>${trend}</div>` : ""}
    </div>`;
}

function renderUsage(root: HTMLElement, usage: UsageResponse): void {
  const panel = root.querySelector<HTMLElement>("#usage-panel")!;
  const gateway = usage.gateway;
  const storage = usage.storage;
  const official = usage.official;
  const summaryMarkup = official.configured && !official.error && official.summary && !official.summary.rawFallback
    ? officialSummaryMarkup(official.summary)
    : "";
  const rawDetails = `<details class="official-usage-details"${summaryMarkup ? "" : " open"}><summary>查看 Cursor 官方团队用量原始数据</summary><div class="official-meta">更新时间 ${escapeHtml(formatDate(official.fetchedAt || ""))}</div><pre>${escapeHtml(JSON.stringify({ spend: official.spend, usageEvents: official.usageEvents }, null, 2))}</pre></details>`;
  const officialMarkup = !official.configured
    ? `<div class="official-usage-note"><span class="official-icon">${icon("ShieldCheck", { width: 17, height: 17 })}</span><div><strong>Cursor 官方用量未配置</strong><span>设置 <code>CURSOR_ADMIN_API_KEY</code> 后，可读取团队 spending 和 usage events。当前只显示经过本网关的请求。</span></div></div>`
    : official.error
      ? `<div class="official-usage-note error"><span class="official-icon">${icon("TriangleAlert", { width: 17, height: 17 })}</span><div><strong>Cursor 官方用量查询失败</strong><span>${escapeHtml(official.error)}</span></div></div>`
      : `${summaryMarkup}${rawDetails}`;
  panel.innerHTML = `
    <div class="usage-cards">
      <div class="usage-card"><span>保留请求</span><strong>${gateway.retainedRequests}</strong><small>${gateway.lastRequestAt ? `最近 ${escapeHtml(formatDate(gateway.lastRequestAt))}` : "暂无请求"}</small></div>
      <div class="usage-card success"><span>成功</span><strong>${gateway.completed}</strong><small>平均 ${formatDuration(gateway.averageDurationMs)}</small></div>
      <div class="usage-card warning"><span>失败 / 取消</span><strong>${gateway.failed} / ${gateway.canceled}</strong><small>取消表示客户端提前断开</small></div>
      <div class="usage-card violet"><span>P95 耗时</span><strong>${formatDuration(gateway.p95DurationMs)}</strong><small>${gateway.sampled ? "基于采样记录" : "基于全部保留记录"}</small></div>
    </div>
    <div class="log-storage-note"><span>${icon("Server", { width: 15, height: 15 })}</span><div>日志占用 <strong>${formatBytes(storage.totalBytes)}</strong> / ${formatBytes(storage.maxTotalBytes)} · ${storage.fileCount}/${storage.maxFiles} 个文件 · 保留 ${storage.retentionDays} 天</div></div>
    ${officialMarkup}`;
}

function renderLogs(
  root: HTMLElement,
  state: DashboardState,
  previousPage: () => void,
  nextPage: () => void
): void {
  const list = root.querySelector<HTMLElement>("#request-log-list")!;
  if (!state.logs.length) {
    list.innerHTML = `<div class="empty-state"><strong>暂无匹配日志</strong><span>新请求完成后会在这里显示。</span></div>${logPagerMarkup(state)}`;
  } else {
    list.innerHTML = `
      <div class="request-log-head"><span>时间</span><span>接口</span><span>模型 / Cursor 账号</span><span>结果</span><span>耗时</span></div>
      ${state.logs.map((entry) => `<div class="request-log-row"><time>${escapeHtml(formatDate(entry.timestamp))}</time><div class="log-endpoint"><strong>${escapeHtml(entry.method)}</strong><code>${escapeHtml(entry.path)}</code>${entry.streaming ? `<span class="mini-badge">stream</span>` : ""}</div><div class="log-model"><strong>${escapeHtml(entry.model || "-")}</strong><div class="log-model-meta"><span class="reasoning-badge">推理 ${escapeHtml(entry.reasoningEffort || "默认")}</span><span>${escapeHtml(entry.credentialLabel ? `${entry.credentialLabel} · ••••${entry.credentialHint || ""}` : "未解析账号")}</span></div></div><div><span class="log-result ${entry.result}" title="${entry.result === "canceled" ? "客户端在响应完成前主动停止或连接中断" : ""}">${logResultText(entry.result)}</span><small>HTTP ${entry.statusCode}${entry.errorCode ? ` · ${escapeHtml(entry.errorCode)}` : ""}</small></div><div class="log-duration"><strong>${formatDuration(entry.durationMs)}</strong><small>${entry.firstByteMs !== undefined ? `首字节 ${formatDuration(entry.firstByteMs)}` : ""}</small></div></div>`).join("")}
      ${logPagerMarkup(state)}`;
  }
  list.querySelector<HTMLButtonElement>("#log-prev")?.addEventListener("click", previousPage);
  list.querySelector<HTMLButtonElement>("#log-next")?.addEventListener("click", nextPage);
}

function logPagerMarkup(state: DashboardState): string {
  return `<div class="log-pagination"><span>第 ${state.logPage} 页 · 当前 ${state.logs.length} 条</span><div><button class="btn btn-compact btn-secondary" id="log-prev" type="button" ${state.logPage <= 1 ? "disabled" : ""}>上一页</button><span class="log-page-number">${state.logPage}</span><button class="btn btn-compact btn-secondary" id="log-next" type="button" ${!state.logsHaveMore || !state.logNextCursor ? "disabled" : ""}>下一页</button></div></div>`;
}

function modelPills(models: string[]): string {
  if (!models.length) return `<div class="model-pills"><span class="model-pill empty">暂无模型</span></div>`;
  const visible = models.slice(0, 4);
  const remaining = models.length - visible.length;
  return `<div class="model-pills">${visible.map((model) => `<span class="model-pill">${escapeHtml(model)}</span>`).join("")}${remaining > 0 ? `<span class="model-pill more">+${remaining}</span>` : ""}</div>`;
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

/**
 * Show an error inside an open <dialog>. The global toast (#dashboard-notice)
 * lives in a fixed layer that a modal dialog covers (dialogs render in the
 * browser "top layer", above any z-index), so while a dialog is open its
 * failures must be shown inside the dialog itself or the user sees nothing
 * until they close it.
 */
function dialogError(root: HTMLElement, dialogId: string, message: string): void {
  const dialog = root.querySelector<HTMLDialogElement>(`#${dialogId}`);
  if (!dialog) return;
  const box = dialog.querySelector<HTMLElement>(".dialog-error");
  if (!box) return;
  box.hidden = !message;
  box.textContent = message;
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

function showInfoDialog(
  root: HTMLElement,
  options: { title: string; message: string; command: string }
): void {
  const dialog = root.querySelector<HTMLDialogElement>("#info-dialog")!;
  root.querySelector<HTMLElement>("#info-title")!.textContent = options.title;
  root.querySelector<HTMLElement>("#info-message")!.textContent = options.message;
  root.querySelector<HTMLElement>("#info-command")!.textContent = options.command;
  dialog.showModal();
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
