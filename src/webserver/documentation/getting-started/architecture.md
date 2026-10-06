---
title: Architecture
description: How the engine, the gateway and the asset server connect, which ports and protocols they use, and how a player gets from the login page into the game.
order: 20
---

This page shows how the three servers fit together: the processes each one runs, the ports and protocols between them, the order to start them in, and the full path a player takes from the login page to the game world.

## Overview

```text title="Processes, default ports and protocols"
                         Browser client (Chromium based)
        |                          |                            |
        | HTTP(S)                  | WebTransport               | HTTP(S)
        | 80 / 443                 | HTTP/3 over UDP 3000       | asset port
        v                          | plus HTTP API on TCP 3000  v
+------------------------+         |                 +------------------------+
| GATEWAY                |         |                 | ASSET SERVER           |
|                        |         |                 |                        |
| reverse proxy  80/443  |         |                 | edge proxy  (public)   |
|   -> webserver 8080    |         |                 |   -> app    (loopback) |
|      (loopback only)   |         |                 |                        |
|                        |         |                 | assets folder on disk  |
| gateway server         |         |                 +------------------------+
|   9999 / 9443          |         |                            ^
|   -> app 9998          |         |                            |
+------------------------+         |                            |
        ^        |                 v                            |
        |        |        +------------------------+            |
        |        |        | GAME ENGINE            |            |
        |        +------> | (one per realm)        | -----------+
        |  realm list     |                        |  POST /map-checksums
        +---------------- | WebTransport  UDP 3000 |  POST /world-list, /world-file
   POST /register         | HTTP API      TCP 3000 |  POST /save-map-chunks
   POST /heartbeat        |   -> app 3002          |  POST /save-map-properties
                          +------------------------+
                                      |
                              MySQL (or SQLite)
                          shared with the gateway
```

## The servers and their processes

### Gateway

`bun development` or `bun production` in the gateway repository runs `src/start.ts`. It first transpiles the browser client, then starts three child processes:

| Process | File | Listens on | Purpose |
| --- | --- | --- | --- |
| Reverse proxy | `src/webserver/proxy.ts` | `WEBSRV_PORT` (80) or `WEBSRV_PORTSSL` (443) | The only public web listener. Terminates TLS, filters requests, forwards to the webserver. |
| Webserver | `src/webserver/server.ts` | `127.0.0.1:WEBSRV_INTERNAL_PORT` (8080) | Pages, the game client, login, profile and two-factor routes, the realm list and connection tokens. |
| Gateway server | `src/gateway/server.ts` | `GATEWAY_PORT` (9999) or `GATEWAY_PORTSSL` (9443), app on `127.0.0.1:GATEWAY_INTERNAL_PORT` (9998) | Game server registration, heartbeats, status API and the dashboard. |

Details are in the [gateway overview](#/gateway/overview) and [Reverse proxy](#/gateway/reverse-proxy).

### Game engine

The engine is one process (`src/socket/server.ts`) with worker threads. It opens two listeners on the same port number:

| Listener | Transport | Port | Purpose |
| --- | --- | --- | --- |
| WebTransport | UDP (QUIC, HTTP/3) | `WEBSRV_PORTSSL`, default 3000 | The game connection. |
| HTTP API | TCP | Same number, app on `127.0.0.1:WEBSRV_INTERNAL_PORT` (3002) | `/status`, `/ping`, `/wt-cert-hash` and routes added by plugins. |

Because the WebTransport listener owns the UDP side of the port, HTTP/3 is always off for the engine's HTTP API. See [Networking](#/engine/networking).

### Asset server

The asset server is one process (`src/index.ts`). Like the other two it runs an edge proxy on the public port in front of an application server bound to `127.0.0.1`. Its ports are listed in [asset server configuration](#/assets/configuration).

### The shared HTTP stack

All three repositories carry the same `src/modules/https_servers.ts`, so they behave the same way:

- The application listens on `127.0.0.1` on its internal port.
- An edge proxy listens on `0.0.0.0` on the public port and forwards to it, adding `X-Real-Client-IP`, `X-Forwarded-For` and `X-Forwarded-Proto`.
- With `HTTP_USE_SSL=true` and readable certificate files, the proxy serves HTTPS on the SSL port and a second listener on the plain port answers every request with a 301 redirect to HTTPS.
- `WEBSRV_HTTP1`, `WEBSRV_HTTP2` and `WEBSRV_HTTP3` switch protocol versions on and off. HTTP/3 only applies when TLS is on.

## Ports and protocols

| Server | Port (default) | Transport | Used by |
| --- | --- | --- | --- |
| Gateway web | 80, or 443 with TLS | TCP, plus UDP for HTTP/3 with TLS | Browsers |
| Gateway server | 9999, or 9443 with TLS | TCP, plus UDP for HTTP/3 with TLS | Game engines, the dashboard |
| Engine WebTransport | 3000 | UDP | Browsers |
| Engine HTTP API | 3000 | TCP | Browsers (certificate hash, ping), monitoring |
| Asset server | 80, or 443 with TLS, when unset | TCP, plus UDP for HTTP/3 with TLS | Browsers, game engines |
| MySQL | 3306 | TCP | Gateway and engine |

:::note Asset server port
The code falls back to 80 and 443, which collide with the gateway on a single machine. The example environment file uses 8081, the development file uses 8000. Pick a port and use the same value in every `ASSET_SERVER_URL`.
:::

The game itself runs over **WebTransport on HTTP/3**. Everything else (pages, login, the realm list, assets, and all server to server calls) is plain HTTP or HTTPS.

## Startup order

Start the servers in this order:

1. **Database.** The gateway and the engine both need it.
2. **Asset server.** The engine syncs its maps from it while it starts.
3. **Gateway.** The engine registers with it.
4. **Game engine.**

The engine tolerates a late gateway: it retries registration with a growing delay (up to 30 seconds between attempts) until the gateway answers. A missing asset server is only a warning, but the engine then starts with whatever maps it already has on disk, and it cannot start at all if it has none.

## How the engine joins the gateway

On startup the engine sends its details to the gateway:

```json title="POST {GATEWAY_URL}/register"
{
  "id": "server-1",
  "description": "My Realm",
  "host": "localhost",
  "publicHost": "localhost",
  "port": 3000,
  "wtPort": 3000,
  "wtEnabled": true,
  "useSSL": false,
  "maxConnections": 2000,
  "authKey": "change-me-gateway-key",
  "whitelisted": false
}
```

- `id`, `description`, `host` and `publicHost` come from `SERVER_ID`, `SERVER_DESCRIPTION`, `SERVER_HOST` and `PUBLIC_HOST`.
- `authKey` must equal the gateway's `GATEWAY_AUTH_KEY`, otherwise the gateway answers 401.
- If `GATEWAY_INTERNAL_URL` is set, the engine uses it instead of `GATEWAY_URL` for these calls.

After a successful registration the engine sends `POST /heartbeat` on a timer (every 5 seconds by default, from `gateway.heartbeatInterval` in `src/config/settings.json`). Each heartbeat carries the connection count, CPU and RAM usage, and whether the realm whitelist is on. On shutdown it sends `POST /unregister`.

The gateway keeps the list of realms in memory and exposes it at `GET /status`. See [Game servers](#/gateway/game-servers).

## How the engine syncs from the asset server

While it starts, and before it loads any map, the engine does two things:

1. **Maps.** It computes a checksum for every map in `src/assets/maps` and sends the list to `POST /map-checksums`. The asset server answers with the full data of every map whose checksum differs, and the engine writes those files to disk.
2. **Worlds.** It asks `POST /world-list` for the large worlds the asset server has, then fetches each outdated file with `POST /world-file`. Only the manifest and the collision and no-PvP data are copied. The tiles stay on the asset server.

Both calls carry `ASSET_SERVER_AUTH_KEY`. The same map sync runs once more right after the engine registers with the gateway. The full list of endpoints is in [asset server integration](#/assets/integration).

## From login page to in-game

1. **The browser loads the site** from the gateway's reverse proxy (`/`). The proxy checks the request and forwards it to the webserver.
2. **The player logs in** (the form posts to `/login`). If two-factor login is enabled for the account, the player completes it on `/2fa-challenge`. See [Authentication](#/gateway/authentication).
3. **The player picks a realm** on `/realm-selection`. The page calls `GET /api/gateway/servers`; the webserver fetches the list from the gateway server's `/status` endpoint and returns each realm's `publicHost`, `port`, `wtPort`, connection counts and status (`online`, `full` or `offline`).
4. **The game page loads** (`/game`) and asks for a connection token at `GET /api/gateway/connection-token`. The webserver returns a random token, a timestamp, an expiry 60 seconds later, and an HMAC-SHA256 signature made with `GATEWAY_GAME_SERVER_SECRET`.
5. **The client prepares the WebTransport connection.** It needs the engine's certificate hash unless the certificate is publicly trusted:
   - If the gateway was started with `GAME_WT_CERT_HASH`, that value is used (`off` disables pinning).
   - Otherwise the client fetches `/wt-cert-hash` from the engine's HTTP API at `publicHost:port`.
6. **The client opens WebTransport** to `https://{publicHost}:{wtPort}` and sends the token in an `AUTH_CONNECT` frame. The engine checks the signature with its own copy of `GATEWAY_GAME_SERVER_SECRET` and the expiry time, then continues with the normal login handshake.
7. **The engine sends the map metadata**, which includes the public asset server URL. The client then downloads tilesets (`/tileset`) and the map chunks around the player (`/map-chunk`) straight from the asset server, and the world appears.

:::warning Three values must match
`GATEWAY_AUTH_KEY` must be the same on the gateway and the engine. `GATEWAY_GAME_SERVER_SECRET` must be the same on the gateway and the engine. `ASSET_SERVER_AUTH_KEY` must be the same on the engine and the asset server. A mismatch shows up as a 401 at registration, a rejected connection token, or a failed map sync.
:::

## What the browser reaches directly

A player's browser needs a route to all three servers:

| Target | Address the browser uses | Where it comes from |
| --- | --- | --- |
| Gateway | The site URL | `DOMAIN` on the gateway |
| Engine | `https://{publicHost}:{wtPort}` and `{publicHost}:{port}/wt-cert-hash` | `PUBLIC_HOST` and the port on the engine, passed through the gateway |
| Asset server | `ASSET_SERVER_URL` | The gateway injects its own `ASSET_SERVER_URL` into the client when it starts, and the engine sends its `ASSET_SERVER_URL` with each map |

Server to server calls can use a different address: the engine prefers `GATEWAY_INTERNAL_URL` and `ASSET_SERVER_INTERNAL_URL` when they are set. The engine's own variables are documented in [engine configuration](#/engine/configuration), the gateway's in [gateway configuration](#/gateway/configuration).

:::note Cross-origin requests
The game page is served by the gateway but calls the engine's HTTP API from the browser, so the engine's `CORS_ALLOWED_ORIGINS` must contain the gateway's origin. An empty value blocks every cross-origin request.
:::
