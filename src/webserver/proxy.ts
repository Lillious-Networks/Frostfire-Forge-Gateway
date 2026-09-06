const now = performance.now();
import log from "../modules/logger";
import path from "path";
import fs from "fs";
import { w_ips, b_ips, blacklistAdd } from "../systems/security";
import { startHttpsServers } from "../modules/https_servers";

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

    return null;
  },
});

const readyTimeMs = performance.now() - now;
log.success(`Reverse proxy ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
