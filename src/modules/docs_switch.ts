// The documentation site (/docs) can be switched off with DOCS_ENABLED=false.
// Unset or anything else, it is served as before. Importing this file has no
// side effects: it reads one environment variable and nothing else.
//
// Off means: /docs and /api/docs answer 404 (webserver/server.ts and the
// reverse proxy), and the "Docs" link is taken out of the pages' headers. The
// webserver's pages are Bun HTML bundles that cannot be rewritten inside the
// webserver, so the reverse proxy (webserver/proxy.ts) does that, the same way
// it writes a custom product name (modules/branding.ts).

// Read once, when the process starts.
export const DOCS_ENABLED = process.env.DOCS_ENABLED !== "false";

// The paths that are the documentation site.
export function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/") || pathname === "/api/docs";
}

export function docsNotFound(): Response {
  return new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

// Takes every link to /docs out of an HTML response.
export function withoutDocsLinks(source: Response): Response {
  return new HTMLRewriter()
    .on('a[href="/docs"]', {
      element(el) {
        el.remove();
      },
    })
    .transform(source);
}
