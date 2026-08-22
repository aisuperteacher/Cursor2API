import { hydrateIcons, wireCopyButtons } from "./ui";

const isChatRoute = (): boolean => window.location.pathname.replace(/\/+$/, "") === "/chat";
const isDashboardRoute = (): boolean => window.location.pathname.replace(/\/+$/, "") === "/dashboard";
const dashboardHashes = new Set(["#overview", "#connection", "#credentials", "#usage", "#request-logs", "#client-keys"]);
let dashboardNavObserver: MutationObserver | null = null;
// Every console-nav element that already received an explicit active state. The
// console can be re-mounted (sign-in -> sign-in, 401 -> re-auth), which creates a
// brand new nav element; tracking instances makes sure each one is synced exactly
// once instead of relying on a one-shot observer that disconnected long ago.
const syncedDashboardNavs = new WeakSet<HTMLElement>();

function normalizedDashboardHash(hash = window.location.hash): string {
  return dashboardHashes.has(hash) ? hash : "#overview";
}

function syncDashboardNav(hash = window.location.hash): void {
  if (!isDashboardRoute()) return;
  const activeHash = normalizedDashboardHash(hash);
  const navigation = document.querySelector<HTMLElement>(".console-nav");
  navigation?.setAttribute("data-active-section", activeHash.slice(1));

  document.querySelectorAll<HTMLAnchorElement>(".console-nav a[href^='#']").forEach((anchor) => {
    const active = anchor.getAttribute("href") === activeHash;
    anchor.classList.toggle("is-active", active);
    if (active) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");

    // Inline important styles are intentional here. They make the selected state
    // deterministic even when a browser still has an older dashboard stylesheet in
    // memory while a newly deployed, fingerprinted JavaScript bundle is loading.
    // Only the active item is pinned: inactive items must stay free to pick up
    // their hover / focus-visible feedback from the stylesheet.
    if (active) {
      anchor.style.setProperty("background", "rgba(99, 102, 241, 0.18)", "important");
      anchor.style.setProperty("color", "#fff", "important");
    } else {
      anchor.style.removeProperty("background");
      anchor.style.removeProperty("color");
    }
  });
}

function scrollToDashboardHash(hash = window.location.hash): void {
  const target = document.querySelector<HTMLElement>(normalizedDashboardHash(hash));
  target?.scrollIntoView({ block: "start" });
}

function syncDashboardNavInstance(navigation: HTMLElement): void {
  if (syncedDashboardNavs.has(navigation)) return;
  syncedDashboardNavs.add(navigation);
  syncDashboardNav();
  // Initial loads (or re-mounts) that carry a section hash should land on that
  // section, not stay pinned to the top of the page. The console fetches its data
  // right after mounting and the panels above the target grow while it arrives, so
  // re-apply the scroll a couple of times once the layout has settled.
  const hash = window.location.hash;
  if (dashboardHashes.has(hash) && hash !== "#overview") {
    scrollToDashboardHash(hash);
    for (const delay of [300, 900]) {
      window.setTimeout(() => {
        if (isDashboardRoute() && window.location.hash === hash) scrollToDashboardHash(hash);
      }, delay);
    }
  }
}

function watchDashboardNav(root: HTMLElement): void {
  dashboardNavObserver?.disconnect();
  dashboardNavObserver = new MutationObserver(() => {
    if (!isDashboardRoute()) {
      dashboardNavObserver?.disconnect();
      dashboardNavObserver = null;
      return;
    }
    const navigation = root.querySelector<HTMLElement>(".console-nav");
    if (navigation) syncDashboardNavInstance(navigation);
  });
  dashboardNavObserver.observe(root, { childList: true, subtree: true });
  // The console may already be mounted by the time we start watching.
  const navigation = root.querySelector<HTMLElement>(".console-nav");
  if (navigation) syncDashboardNavInstance(navigation);
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
    event.preventDefault();
    if (window.location.hash !== href) window.history.pushState({}, "", href);
    syncDashboardNav(href);
    scrollToDashboardHash(href);
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

window.addEventListener("hashchange", () => {
  syncDashboardNav();
  scrollToDashboardHash();
});
window.addEventListener("popstate", () => {
  if (isDashboardRoute()) {
    syncDashboardNav();
    scrollToDashboardHash();
    return;
  }
  void route();
});

let landingReady = false;

function mountLanding(): void {
  const baseUrl = `${window.location.origin}/v1`;
  document.querySelectorAll<HTMLElement>("[data-base-url]").forEach((element) => {
    element.textContent = baseUrl;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-base-url]").forEach((button) => {
    button.dataset.copy = baseUrl;
  });
  if (landingReady) return;
  landingReady = true;
  // The landing DOM is static and never destroyed, so these must bind exactly
  // once; rebinding on every route change would stack duplicate listeners.
  hydrateIcons(document);
  wireCopyButtons(document);
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