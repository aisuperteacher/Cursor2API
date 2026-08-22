export {};

declare global {
  interface HTMLElement {
    /**
     * Cloudflare Workers and lib.dom both expose a global Element type with
     * incompatible remove() return types. Keep these two dashboard selectors
     * precise without widening querySelector across the application.
     */
    querySelector<T>(selectors: "#log-limit" | "#log-result"): T | null;
  }
}
