const now = performance.now();
import log from "../modules/logger";
import path from "path";
import fs from "fs";
import { w_ips, b_ips, blacklistAdd } from "../systems/security";
import { startHttpsServers, getInternalBaseUrl, serverFetch } from "../modules/https_servers";
import { BRANDED_PAGES, BRAND_NAME, brandHtml } from "../modules/branding";

const security = fs.existsSync(path.join(import.meta.dir, "./config/security.cfg"))
  ? fs.readFileSync(path.join(import.meta.dir, "./config/security.cfg"), "utf8").split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#"))
  : [];

if (security.length > 0) {
  log.success(`Loaded ${security.length} security rules`);
} else {
  log.warn("No security rules found");
}

function tryParseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const domainHost = process.env.DOMAIN?.replace(/https?:\/\//, "") || "";

// The webserver's pages are Bun HTML bundles that cannot be rewritten inside the
// webserver, so with a custom product name (BRAND_NAME, see
// modules/branding.ts) the proxy fetches the page itself, rewrites the name,
// and answers with that. Without one it returns
// null and the request takes the ordinary proxy path, unchanged.
async function fetchBrandedPage(url: URL, req: Request, ip: string): Promise<Response | null> {
  if (!BRAND_NAME) return null;

  const internalUrl = getInternalBaseUrl(
    parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8080,
    process.env.TLS_CERT_PATH,
    process.env.TLS_KEY_PATH
  );
  const headers = new Headers(req.headers);
  headers.set("X-Real-Client-IP", ip);
  headers.set("X-Forwarded-For", ip);
  headers.set("X-Forwarded-Proto", process.env.HTTP_USE_SSL === "true" ? "https" : "http");
  headers.set("Accept-Encoding", "identity");
  // A 304 for the unbranded page must not be answered to a branded request.
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");

  let upstream: Response;
  try {
    upstream = await serverFetch(`${internalUrl}${url.pathname}${url.search}`, { method: "GET", headers, redirect: "manual" });
  } catch {
    return null;
  }

  if (upstream.status !== 200 || !(upstream.headers.get("Content-Type") || "").includes("text/html")) return upstream;

  const out = new Headers(upstream.headers);
  for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) out.delete(name);
  out.set("Cache-Control", "no-cache");
  return new Response(brandHtml(upstream, BRAND_NAME).body, { status: 200, headers: out });
}

startHttpsServers({
  name: "Gateway Proxy",
  sslEnabled: process.env.HTTP_USE_SSL === "true",
  httpPort: parseInt(process.env.WEBSRV_PORT || "") || 80,
  httpsPort: parseInt(process.env.WEBSRV_PORTSSL || "") || 443,
  internalPort: parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8080,
  certPath: process.env.TLS_CERT_PATH,
  keyPath: process.env.TLS_KEY_PATH,
  caPath: process.env.TLS_CA_PATH,
  log,
  filterRequest: async (req: Request, ip: string) => {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    log.debug(`Received request: ${req.method} ${req.url} from ${ip}`);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK") {
      return new Response("Forbidden", { status: 403 });
    }

    if (b_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    if (!w_ips.includes(ip)) {
      const segments = url.pathname.split("/").filter(s => s !== "");
      const matched = segments.find(segment => {
        const lower = segment.toLowerCase();
        return security.some(rule => {
          const ruleLower = rule.toLowerCase();
          if (ruleLower === ".env") return lower === ".env" || lower.startsWith(".env.");
          return lower === ruleLower;
        });
      });
      if (matched) {
        log.debug(`Blocked ${ip} for accessing ${matched}`);
        await blacklistAdd(ip);
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
      }
    }

    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || domainHost === "localhost" || domainHost === "127.0.0.1";
    if (!isLocalhost && domainHost && url.host !== domainHost) {
      log.debug(`Domain mismatch: expected "${domainHost}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    if (req.method === "GET" && BRANDED_PAGES.has(url.pathname)) {
      const branded = await fetchBrandedPage(url, req, ip);
      if (branded) return branded;
    }

    return null;
  },
});

const readyTimeMs = performance.now() - now;
log.success(`Reverse proxy ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
