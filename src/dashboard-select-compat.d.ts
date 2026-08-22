export {};

declare global {
  interface HTMLSelectElement {
    /**
     * The project intentionally typechecks both lib.dom and Cloudflare Workers
     * globals. Their Element.remove() return types differ, which otherwise
     * prevents HTMLSelectElement from satisfying querySelector's Element
     * constraint. This overload is type-only and restores compatibility.
     */
    remove(): Element;
  }
}
