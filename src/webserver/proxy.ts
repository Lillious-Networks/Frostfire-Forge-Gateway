const now = performance.now();
import log from "../modules/logger";
import path from "path";
import fs from "fs";
import { w_ips, b_ips, blacklistAdd } from "../systems/security";

const security = fs.existsSync(path.join(import.meta.dir, "./config/security.cfg"))
  ? fs.readFileSync(path.join(import.meta.dir, "./config/security.cfg"), "utf8").split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#"))
  : [];

if (security.length > 0) {
  log.success(`Loaded ${security.length} security rules`);
} else {
  log.warn("No security rules found");
}

const _cert = process.env.WEBSRV_CERT_PATH || path.join(import.meta.dir, "../certs/webserver/cert.pem");
const _key = process.env.WEBSRV_KEY_PATH || path.join(import.meta.dir, "../certs/webserver/key.pem");
const _ca = process.env.WEBSRV_CA_PATH || path.join(import.meta.dir, "../certs/webserver/cert.ca-bundle");
const _https = process.env.WEBSRV_USESSL === "true" && fs.existsSync(_cert) && fs.existsSync(_key);

const publicPort = _https ? (parseInt(process.env.WEBSRV_PORTSSL || "") || 443) : (parseInt(process.env.WEBSRV_PORT || "") || 80);
const internalPort = parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8080;
const upstream = `http://127.0.0.1:${internalPort}`;

function tryParseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

Bun.serve({
  hostname: "0.0.0.0",
  port: publicPort,
  development: false,
  reusePort: false,
  async fetch(req: Request, server: any) {
    const ip = server.requestIP(req)?.address;
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    if (!ip) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    log.debug(`Received request: ${req.method} ${req.url} from ${ip}`);

    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK" || req.method === "OPTIONS") {
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

    const domainHost = process.env.DOMAIN?.replace(/https?:\/\//, "") || "";
    const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || domainHost === "localhost" || domainHost === "127.0.0.1";
    if (!isLocalhost && domainHost && url.host !== domainHost) {
      log.debug(`Domain mismatch: expected "${domainHost}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const headers = new Headers(req.headers);
    headers.delete("X-Real-Client-IP");
    headers.set("X-Real-Client-IP", ip);
    headers.set("X-Forwarded-For", ip);
    headers.set("X-Forwarded-Proto", _https ? "https" : "http");

    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      return await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        redirect: "manual",
      });
    } catch (error) {
      log.error(`Failed to proxy request: ${error}`);
      return new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502 });
    }
  },
  ...(_https ? {
      tls: {
        cert: fs.existsSync(_ca)
          ? fs.readFileSync(_cert) + "\n" + fs.readFileSync(_ca)
          : fs.readFileSync(_cert),
        key: fs.readFileSync(_key),
      }
    }
  : {}),
});

if (_https) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: process.env.WEBSRV_PORT || 80,
    development: false,
    fetch(req: Request) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }

      const port = process.env.WEBSRV_PORTSSL === "443" ? "" : `:${process.env.WEBSRV_PORTSSL || 443}`;
      return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
    }
  });
}

const readyTimeMs = performance.now() - now;
log.success(`Reverse proxy started on port ${publicPort} (${_https ? "HTTPS" : "HTTP"}) forwarding to ${upstream} - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);
