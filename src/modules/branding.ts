// Custom branding: the product name players see. Nothing here runs unless
// BRAND_NAME is set; it replaces "Frostfire Forge" in the web pages (not the
// docs). Unset, every response is exactly what it was before. Importing this
// file has no side effects: it reads one environment variable and nothing else.
//
// The logo and the favicon need no code: replace public/img/logo.png and
// public/img/icons/favicon.ico before the gateway starts.
//
// How the name reaches the browser:
//   - The webserver's pages are Bun HTML bundles, which cannot be rewritten
//     inside the webserver. The reverse proxy (webserver/proxy.ts) fetches those
//     pages itself and passes them through brandHtml() before answering.
//   - The gateway server's own pages (login.html, dashboard.html) are plain
//     files and go through brandHtmlText().

export const DEFAULT_BRAND_NAME = "Frostfire Forge";
const BRAND_NAME_MAX = 40;

// The paths of the webserver pages that carry the product name. /docs is left
// out on purpose: the documentation is about the engine itself.
export const BRANDED_PAGES: ReadonlySet<string> = new Set([
  "/",
  "/registration",
  "/game",
  "/forgot-password",
  "/realm-selection",
  "/manage-profile",
  "/2fa-challenge",
  "/map-editor",
  "/particle-editor",
  "/npc-editor",
  "/creature-editor",
  "/item-editor",
  "/spell-editor",
  "/weather-editor",
  "/player-editor",
  "/control-panel",
  "/quest-editor",
  "/loot-editor",
  "/animator",
]);

// Customer input: control characters become spaces, the result is trimmed and
// capped at 40 characters (counted as characters, not UTF-16 units).
export function cleanBrandName(raw: string | null | undefined): string {
  if (!raw) return "";
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return Array.from(flat).slice(0, BRAND_NAME_MAX).join("").trim();
}

// For attribute values: HTMLRewriter escapes text content, but only the quote
// character in attributes, so "&amp;" typed by a customer would read back as "&".
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Read once, when the process starts.
export const BRAND_NAME = cleanBrandName(process.env.BRAND_NAME);

// Collects a text node (it may arrive in pieces) and writes it back with the
// product name swapped. Replacement text is escaped by the rewriter.
function nameSwap(name: string) {
  let pending = "";
  return {
    text(chunk: HTMLRewriterTypes.Text) {
      pending += chunk.text;
      if (chunk.lastInTextNode) {
        chunk.replace(pending.split(DEFAULT_BRAND_NAME).join(name));
        pending = "";
      } else {
        chunk.remove();
      }
    },
  };
}

// Rewrites an HTML response: the product name in the title and the brand
// elements, and <html data-brand-name> for the client scripts. Text is escaped
// by HTMLRewriter, attribute values here.
export function brandHtml(source: Response, name: string): Response {
  if (!name) return source;
  const attribute = escapeHtml(name);
  return new HTMLRewriter()
    .on("html", {
      element(el) {
        el.setAttribute("data-brand-name", attribute);
      },
    })
    .on("title, .site-brand-name, .tl-brand-name, .register-subtitle, .loading-brand span", nameSwap(name))
    .on("[aria-label]", {
      element(el) {
        const label = el.getAttribute("aria-label");
        if (label && label.includes(DEFAULT_BRAND_NAME)) el.setAttribute("aria-label", label.split(DEFAULT_BRAND_NAME).join(attribute));
      },
    })
    .transform(source);
}

export async function brandHtmlText(html: string): Promise<string> {
  if (!BRAND_NAME) return html;
  return await brandHtml(new Response(html), BRAND_NAME).text();
}

