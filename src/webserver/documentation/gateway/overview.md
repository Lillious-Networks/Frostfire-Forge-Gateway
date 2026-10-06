---
title: Overview
description: What the gateway does, the three processes it runs, and the ports each one listens on.
order: 10
---

The gateway is the front door of a Frostfire Forge deployment. It serves the website and the browser game client, owns player accounts and logins, keeps the list of running game servers (realms), and hands out the signed tokens a client needs to connect to one of them.

It does not run any game logic and it never carries game traffic. Once a player has picked a realm, the browser talks to that game server directly over WebTransport. See [Architecture](#/getting-started/architecture) for how the three servers fit together.

## The three processes

`bun development` and `bun production` both run `src/start.ts`. That script first transpiles the account page scripts, then spawns three independent Bun processes. Stopping the parent with Ctrl+C stops all three.

| Process | Source file | Listens on | Reachable from |
| --- | --- | --- | --- |
| Reverse proxy | `src/webserver/proxy.ts` | `WEBSRV_PORT` (80), or `WEBSRV_PORTSSL` (443) when TLS is on | The internet |
| Webserver | `src/webserver/server.ts` | `127.0.0.1:WEBSRV_INTERNAL_PORT` (8080) | Loopback only |
| Gateway server | `src/gateway/server.ts` | `GATEWAY_PORT` (9999), or `GATEWAY_PORTSSL` (9443) when TLS is on. The application itself sits on `127.0.0.1:GATEWAY_INTERNAL_PORT` (9998) | Game servers, admins |

```text title="Request flow"
Browser
  |  HTTP 80 or HTTPS 443
  v
Reverse proxy   (TLS, IP lists, security.cfg rules, host check)
  |  127.0.0.1:8080
  v
Webserver       (pages, accounts, login, 2FA, connection tokens)
  |  127.0.0.1:9998  (GET /status, for the realm list)
  v
Gateway server  (realm registry, heartbeats, dashboard)
  ^
  |  9999 or 9443  (POST /register, /heartbeat, /unregister)
Game servers
```

Both public listeners are built by the same module, `src/modules/https_servers.ts`. Each one is an edge proxy in front of an application bound to `127.0.0.1`. When TLS is on, the edge proxy terminates TLS, and a second small server on the plain HTTP port answers every request with a `301` redirect to HTTPS.

:::note The gateway port has no edge filtering
The `security.cfg` rules, the IP lists and the host check described in [Reverse Proxy](#/gateway/reverse-proxy) run only on the website ports (80 and 443). The gateway server ports (9999 and 9443) have no such filter, so restrict them with a firewall if game servers and admins are the only ones that need them.
:::

## Reverse proxy

The only process bound to the public website ports. Everything a browser sends passes through it first.

- Terminates TLS (HTTP/1.1, HTTP/2 and HTTP/3) and redirects HTTP to HTTPS when `HTTP_USE_SSL=true`.
- Rejects blacklisted IP addresses.
- Matches each path segment against `src/webserver/config/security.cfg` and blacklists the sender on a match.
- Checks that the request host matches `DOMAIN`.
- Forwards what is left to the webserver and adds the `X-Real-Client-IP`, `X-Forwarded-For` and `X-Forwarded-Proto` headers.

Details: [Reverse Proxy](#/gateway/reverse-proxy).

## Webserver

Serves everything a player sees in the browser and owns the account database tables.

- The login, registration, password reset, realm selection, profile and 2FA challenge pages.
- The game client at `/game` and the editor windows such as `/map-editor` and `/control-panel` (see [Tools Overview](#/tools/overview)).
- Registration with email verification, login, guest accounts, password reset.
- Two-factor authentication: authenticator apps (TOTP), email codes and security keys or passkeys (WebAuthn).
- The realm list for the client (`GET /api/gateway/servers`) and signed connection tokens (`GET /api/gateway/connection-token`).
- Images and fonts under `/img/` and `/fonts/`, read from disk on each request.
- A log sink for browser errors from logged-in players (`POST /api/client-log`).

Details: [Authentication](#/gateway/authentication).

## Gateway server

Keeps the registry of game servers in memory and shows it to admins.

- Game servers register with `POST /register`, report in with `POST /heartbeat` and leave with `POST /unregister`. Each call carries `GATEWAY_AUTH_KEY`.
- A server that misses heartbeats for `SERVER_TIMEOUT` milliseconds is dropped and its HTTP sessions are moved to the remaining servers.
- `GET /status` is the public realm list: id, description, address, player counts, whitelist flag and state.
- The monitoring dashboard at `/dashboard`, open to admin accounts that hold `server.gateway` or `server.*`.
- Any other path is proxied over HTTP to one of the registered game servers.

Details: [Game Servers](#/gateway/game-servers) and [Dashboard](#/gateway/dashboard).

## Features

| Feature | Where it lives |
| --- | --- |
| Accounts, login, email verification, password reset | [Authentication](#/gateway/authentication) |
| TOTP, email codes and WebAuthn security keys | [Authentication](#/gateway/authentication/two-factor-authentication) |
| Guest accounts (`GUEST_MODE_ENABLED`) | [Authentication](#/gateway/authentication/guest-mode) |
| Realm registry, heartbeats, failover | [Game Servers](#/gateway/game-servers) |
| Signed connection tokens | [Game Servers](#/gateway/game-servers/connection-tokens) |
| Edge filtering and automatic IP blacklisting | [Reverse Proxy](#/gateway/reverse-proxy) |
| Monitoring dashboard with recording and replay | [Dashboard](#/gateway/dashboard) |
| TLS for the website and the gateway port | [TLS](#/gateway/tls) |
| Browser editors and the server control panel | [Tools Overview](#/tools/overview) |

## Data and logs

- The gateway uses the same database as the game engine. Its own setup script adds the `allowed_ips` and `blocked_ips` tables and the two-factor columns on `accounts`. See [Configuration](#/gateway/configuration/scripts).
- Database queries run on a pool of 4 worker threads (`src/controllers/sqldatabase.ts`).
- The reverse proxy and the webserver write a log file per day to `src/logs/`. `LOG_LEVEL` decides whether `debug` and `trace` lines are written. The gateway server logs to the terminal only.

:::tip Start order
Start the gateway before the game servers. A game server keeps retrying until the gateway answers, so a late gateway only costs time. For the order of the two database setup scripts, see [Configuration](#/gateway/configuration/scripts).
:::
