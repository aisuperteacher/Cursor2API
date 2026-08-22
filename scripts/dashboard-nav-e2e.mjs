import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPort = Number.parseInt(process.env.DASHBOARD_E2E_PORT || "6799", 10);
const cdpPort = Number.parseInt(process.env.DASHBOARD_E2E_CDP_PORT || "9223", 10);
const baseUrl = `http://127.0.0.1:${serverPort}`;
const password = "dashboard-nav-test-password";
const temporaryDir = mkdtempSync(join(tmpdir(), "cursor2api-dashboard-nav-"));
const serverLogs = [];
const chromeLogs = [];
let serverProcess;
let chromeProcess;
let cdp;

function executable(name) {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
}

function findChrome() {
  const configured = process.env.CHROME_BIN?.trim();
  if (configured) return configured;
  const windowsCandidates = [
    join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe")
  ];
  for (const candidate of windowsCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const candidate of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
    const found = executable(candidate);
    if (found) return found;
  }
  throw new Error("No Chromium/Chrome executable was found for dashboard navigation E2E testing");
}

function capture(stream, target) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    target.push(chunk);
    if (target.length > 80) target.splice(0, target.length - 80);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { return; }
  }
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))
  ]);
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already stopped */ }
  }
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  ]);
}

async function waitFor(description, callback, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening the Chrome DevTools websocket")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome DevTools websocket failed to open"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message || "CDP error"}`));
    else waiter.resolve(message.result || {});
  });

  const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "Runtime evaluation failed";
      throw new Error(description);
    }
    return response.result?.value;
  };

  return {
    close: () => socket.close(),
    evaluate,
    send
  };
}

async function navSnapshot() {
  return cdp.evaluate(`(() => {
    const links = [...document.querySelectorAll('.console-nav a[href^="#"]')].map((anchor) => ({
      href: anchor.getAttribute('href'),
      active: anchor.classList.contains('is-active'),
      ariaCurrent: anchor.getAttribute('aria-current'),
      background: getComputedStyle(anchor).backgroundColor,
      color: getComputedStyle(anchor).color
    }));
    return {
      hash: window.location.hash,
      activeSection: document.querySelector('.console-nav')?.getAttribute('data-active-section') || '',
      links
    };
  })()`);
}

function assertNavSnapshot(snapshot, expectedHash) {
  if (snapshot.hash !== expectedHash) {
    throw new Error(`Expected hash ${expectedHash || "<empty>"}, received ${snapshot.hash || "<empty>"}`);
  }
  const expectedHref = expectedHash || "#overview";
  const expectedSection = expectedHref.slice(1);
  if (snapshot.activeSection && snapshot.activeSection !== expectedSection) {
    throw new Error(`Expected data-active-section=${expectedSection}, received ${snapshot.activeSection}`);
  }
  const explicitActive = snapshot.links.filter((item) => item.active || item.ariaCurrent === "page");
  if (explicitActive.length !== 1 || explicitActive[0].href !== expectedHref) {
    throw new Error(`Expected exactly one explicit active item (${expectedHref}), received ${JSON.stringify(explicitActive)}`);
  }
  for (const item of snapshot.links) {
    const highlighted = item.background !== "rgba(0, 0, 0, 0)" && item.background !== "transparent";
    if (item.href === expectedHref && !highlighted) {
      throw new Error(`Expected ${expectedHref} to be visibly highlighted, received ${JSON.stringify(item)}`);
    }
    if (item.href !== expectedHref && highlighted) {
      throw new Error(`Expected ${item.href} to remain unhighlighted, received ${JSON.stringify(item)}`);
    }
  }
}

async function main() {
  const bundlePath = resolve(process.env.SIDECAR_BUNDLE || "/tmp/api-for-cursor.mjs");
  const chromePath = findChrome();
  const authStatePath = join(temporaryDir, "auth-state.json");
  const routerStatePath = join(temporaryDir, "router-state.json");

  serverProcess = spawn(process.execPath, [bundlePath], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      ADMIN_PASSWORD: password,
      ENCRYPTION_KEY: "dashboard-nav-test-encryption-key",
      HOST: "127.0.0.1",
      LOCAL_AUTH_STATE_PATH: authStatePath,
      PORT: String(serverPort),
      REQUEST_LOG_ENABLED: "false",
      STATIC_DIR: resolve(rootDir, "dist/client"),
      CURSOR_ROUTER_STATE_PATH: routerStatePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  capture(serverProcess.stdout, serverLogs);
  capture(serverProcess.stderr, serverLogs);

  await waitFor("the sidecar health endpoint", async () => {
    const response = await fetch(`${baseUrl}/health`).catch(() => null);
    return response?.ok;
  });

  chromeProcess = spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(temporaryDir, "chrome-profile")}`,
    "about:blank"
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  capture(chromeProcess.stdout, chromeLogs);
  capture(chromeProcess.stderr, chromeLogs);

  await waitFor("Chrome DevTools", async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
    return response?.ok;
  });

  const targetResponse = await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(`${baseUrl}/dashboard`)}`,
    { method: "PUT" }
  );
  if (!targetResponse.ok) throw new Error(`Unable to create a Chrome target (${targetResponse.status})`);
  const target = await targetResponse.json();
  cdp = await createCdpClient(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  await waitFor("the dashboard sign-in page", () => cdp.evaluate(
    `document.querySelector('#auth-password') instanceof HTMLInputElement`
  ));
  const loginStatus = await cdp.evaluate(`fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ${JSON.stringify(password)} })
  }).then((response) => response.status)`);
  if (loginStatus !== 200) throw new Error(`Dashboard login failed with HTTP ${loginStatus}`);

  await cdp.send("Page.navigate", { url: `${baseUrl}/dashboard` });
  await waitFor("the dashboard sidebar", () => cdp.evaluate(
    `document.querySelectorAll('.console-nav a[href^="#"]').length === 6`
  ));

  await waitFor("the default overview active state", async () => {
    const snapshot = await navSnapshot();
    try {
      assertNavSnapshot(snapshot, "");
      return true;
    } catch {
      return false;
    }
  });

  for (const hash of ["#connection", "#credentials", "#usage", "#request-logs", "#client-keys", "#overview"]) {
    await cdp.evaluate(`document.querySelector('.console-nav a[href=${JSON.stringify(hash)}]').click()`);
    await waitFor(`${hash} to become the only active sidebar item`, async () => {
      const snapshot = await navSnapshot();
      try {
        assertNavSnapshot(snapshot, hash);
        return true;
      } catch {
        return false;
      }
    });
    assertNavSnapshot(await navSnapshot(), hash);
  }

  // Regression: logging out and back in re-mounts the console, creating a brand
  // new .console-nav element. The active state must be re-synced to the current
  // hash instead of silently falling back to 概览.
  await cdp.evaluate(`document.querySelector('.console-nav a[href="#client-keys"]').click()`);
  await waitFor("#client-keys to become the only active sidebar item", async () => {
    try {
      assertNavSnapshot(await navSnapshot(), "#client-keys");
      return true;
    } catch {
      return false;
    }
  });
  await cdp.evaluate(`document.querySelector('#logout')?.click()`);
  await waitFor("the sign-in form after logout", () => cdp.evaluate(
    `document.querySelector('#auth-password') instanceof HTMLInputElement`
  ));
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#auth-password');
    input.value = ${JSON.stringify(password)};
    document.querySelector('#auth-form')?.requestSubmit();
  })()`);
  await waitFor("the re-mounted sidebar to keep #client-keys active without any click", async () => {
    const snapshot = await navSnapshot();
    if (!snapshot.links.length) return false;
    try {
      assertNavSnapshot(snapshot, "#client-keys");
      return true;
    } catch {
      return false;
    }
  });

  // Regression: an initial load that already carries a section hash must land on that
  // section (scroll position), not stay pinned to the top of the page.
  await cdp.send("Page.navigate", { url: `${baseUrl}/dashboard#request-logs` });
  await waitFor("the sidebar to mark #request-logs active on initial load", async () => {
    const snapshot = await navSnapshot();
    if (!snapshot.links.length) return false;
    try {
      assertNavSnapshot(snapshot, "#request-logs");
      return true;
    } catch {
      return false;
    }
  });
  // Panels above the target keep growing while dashboard data loads; the scroll is
  // re-applied until the layout settles, so poll instead of asserting immediately.
  const sectionTop = await waitFor("#request-logs to be scrolled into view on initial load", async () => {
    const top = await cdp.evaluate(
      `document.querySelector('#request-logs')?.getBoundingClientRect().top ?? Number.NaN`
    );
    return Number.isFinite(top) && Math.abs(top) <= 120 ? top : false;
  }, 8_000);
  if (sectionTop === false) throw new Error("Expected #request-logs to be scrolled into view on initial load");

  console.log("Dashboard sidebar navigation E2E: PASS");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (serverLogs.length) console.error(`\nSidecar logs:\n${serverLogs.join("")}`);
  if (chromeLogs.length) console.error(`\nChrome logs:\n${chromeLogs.join("")}`);
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* ignore cleanup errors */ }
  await stopProcess(chromeProcess);
  await stopProcess(serverProcess);
  rmSync(temporaryDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });
}
