import "./dashboard-polish.css";
import { hydrateIcons, wireCopyButtons } from "./ui";

const isChatRoute = (): boolean => window.location.pathname.replace(/\/+$/, "") === "/chat";
const isDashboardRoute = (): boolean => window.location.pathname.replace(/\/+$/, "") === "/dashboard";
const dashboardHashes = new Set(["#overview", "#connection", "#credentials", "#usage", "#request-logs", "#client-keys"]);
let dashboardNavObserver: MutationObserver | null = null;

function syncDashboardNav(hash = window.location.hash): void {
  if (!isDashboardRoute()) return;
  const activeHash = dashboardHashes.has(hash) ? hash : "#overview";
  document.querySelectorAll<HTMLAnchorElement>(".console-nav a[href^='#']").forEach((anchor) => {
    const active = anchor.getAttribute("href") === activeHash;
    anchor.classList.toggle("is-active", active);
    if (active) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  });
}

function watchDashboardNav(root: HTMLElement): void {
  dashboardNavObserver?.disconnect();
  dashboardNavObserver = null;
  if (root.querySelector(".console-nav")) {
    syncDashboardNav();
    return;
  }
  dashboardNavObserver = new MutationObserver(() => {
    if (!isDashboardRoute()) {
      dashboardNavObserver?.disconnect();
      dashboardNavObserver = null;
      return;
    }
    if (!root.querySelector(".console-nav")) return;
    syncDashboardNav();
    dashboardNavObserver?.disconnect();
    dashboardNavObserver = null;
  });
  dashboardNavObserver.observe(root, { childList: true, subtree: true });
}

async function route(): Promise<void> {
  const landing = document.getElementById("landing");
  const chatRoot = document.getElementById("chat-root");
  if (!landing || !chatRoot) return;

  dashboardNavObserver?.disconnect();
  dashboardNavObserver = null;

  if (isDashboardRoute()) {
    landing.hidden = true;
    chatRoot.hidden = false;
    document.title = "Dashboard - API for Cursor";
    const { mountDashboard } = await import("./dashboard");
    mountDashboard(chatRoot);
    watchDashboardNav(chatRoot);
    return;
  }

  if (isChatRoute()) {
    landing.hidden = true;
    chatRoot.hidden = false;
    document.title = "Cursor Chat - API for Cursor";
    const { mountChat } = await import("./chat");
    mountChat(chatRoot);
    return;
  }

  chatRoot.hidden = true;
  landing.hidden = false;
  document.title = "API for Cursor";
  mountLanding();
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const anchor = (event.target as HTMLElement | null)?.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";

  if (isDashboardRoute() && anchor.closest(".console-nav") && dashboardHashes.has(href)) {
    syncDashboardNav(href);
    return;
  }

  if (href !== "/" && href !== "/chat" && href !== "/dashboard") return;
  if (anchor.target === "_blank") return;
  event.preventDefault();
  if (window.location.pathname !== href) {
    window.history.pushState({}, "", href);
    void route();
  }
});

window.addEventListener("hashchange", () => syncDashboardNav());
window.addEventListener("popstate", () => void route());

let landingReady = false;

function mountLanding(): void {
  const baseUrl = `${window.location.origin}/v1`;
  document.querySelectorAll<HTMLElement>("[data-base-url]").forEach((element) => {
    element.textContent = baseUrl;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-base-url]").forEach((button) => {
    button.dataset.copy = baseUrl;
  });
  hydrateIcons(document);
  wireCopyButtons(document);
  if (landingReady) return;
  landingReady = true;
  bindHeaderScroll();
  bindScrollReveal();
}

/** Toggle a shadow on the floating header once the page scrolls. */
function bindHeaderScroll(): void {
  const header = document.querySelector<HTMLElement>(".site-header");
  if (!header) return;
  const update = (): void => {
    header.classList.toggle("scrolled", window.scrollY > 8);
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
}

/** Fade content in as it enters the viewport. */
function bindScrollReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>("[data-reveal]");
  if (!targets.length) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof IntersectionObserver === "undefined") {
    for (const el of targets) el.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.1 }
  );

  for (const el of targets) observer.observe(el);
}

void route();