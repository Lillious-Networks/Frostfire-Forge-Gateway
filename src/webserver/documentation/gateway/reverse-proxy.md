---
title: Reverse Proxy
description: How the edge proxy terminates TLS, filters requests with security.cfg, and blacklists IP addresses automatically.
order: 30
---

The reverse proxy (`src/webserver/proxy.ts`) is the only process bound to the public website ports. This page covers what it checks on every request, how `security.cfg` rules match, how the IP lists work, and how to add rules of your own.

## What it does

- Listens on `WEBSRV_PORT` (80), or on `WEBSRV_PORTSSL` (443) when `HTTP_USE_SSL=true` and the certificate files exist.
- Terminates TLS and serves HTTP/1.1, HTTP/2 and HTTP/3. Each protocol can be switched off with `WEBSRV_HTTP1`, `WEBSRV_HTTP2` and `WEBSRV_HTTP3`.
- With TLS on, a second listener on `WEBSRV_PORT` answers every request with a `301` redirect to the HTTPS address.
- Runs the request filter below.
- Forwards what passes to the webserver on `127.0.0.1:WEBSRV_INTERNAL_PORT`.

If `HTTP_USE_SSL=true` but a certificate file is missing, the proxy logs an error with both paths and falls back to plain HTTP on `WEBSRV_PORT`. See [TLS](#/gateway/tls).

## Request pipeline

The filter runs in this order. The first check that fails ends the request.

| Step | Check | Result when it fails |
| --- | --- | --- |
| 1 | The URL can be parsed and the client address is known | `400` |
| 2 | Method is `OPTIONS` | Answered here with `204` and CORS headers, never forwarded |
| 3 | Method is `CONNECT`, `TRACE` or `TRACK` | `403 Forbidden` |
| 4 | Client IP is on the blacklist | `403` |
| 5 | A path segment matches a `security.cfg` rule (skipped for whitelisted IPs) | IP is blacklisted, then `403` |
| 6 | The request host matches `DOMAIN` | `403` |
| 7 | Forward to the webserver | `502` if the webserver cannot be reached |

Every rejection in steps 4 to 6 has the same body, `{"message":"Invalid request"}`, so a scanner cannot tell which rule it hit.

## CORS preflight

`OPTIONS` requests never reach the webserver. The proxy answers them itself:

```text title="Preflight response"
HTTP 204
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

:::note
The repository README says `OPTIONS` is blocked. The code answers it as shown above. Only `CONNECT`, `TRACE` and `TRACK` are rejected by method.
:::

## security.cfg rules

`src/webserver/config/security.cfg` is a plain text file with one rule per line. Empty lines and lines starting with `#` are ignored. The file is read once when the proxy starts.

```text title="src/webserver/config/security.cfg"
# One rule per line. A rule is a whole path segment.
.env
wp-admin
credentials
.aws
wlwmanifest.xml
```

### How a path segment match works

The proxy splits the request path on `/`, drops empty parts, and compares each segment with each rule. The comparison ignores case and the segment must equal the rule exactly.

| Request path | Rule | Match | Why |
| --- | --- | --- | --- |
| `/wp-admin/setup.php` | `wp-admin` | Yes | The first segment equals the rule |
| `/blog/WP-Admin` | `wp-admin` | Yes | Case is ignored, any position counts |
| `/wp-admin-old` | `wp-admin` | No | A segment must equal the rule, not just start with it |
| `/index.php` | `.php` | No | Rules are not file extension or substring matches |
| `/.env` | `.env` | Yes | Exact match |
| `/.env.production` | `.env` | Yes | The `.env` rule also matches any segment starting with `.env.` |
| `/game?file=.env` | `.env` | No | Only the path is checked, never the query string |

The `.env` rule is the one special case in the code. Every other rule is an exact, case insensitive segment match.

### Automatic blacklisting

When a segment matches and the client is not whitelisted, the proxy:

1. Inserts the client IP into the `blocked_ips` table.
2. Adds it to the in-memory blacklist of the running proxy.
3. Answers `403`.

From then on every request from that address stops at step 4 of the pipeline, whatever the path.

:::warning A rule can lock out real users
A match blacklists the address permanently, not just the one request. Do not add a rule that equals a segment of a real route such as `login`, `game` or `api`. For the same reason, never publish a link on your site whose path contains a segment listed in `security.cfg`: everyone who clicks it gets banned.
:::

## IP whitelist and blacklist

The lists live in two database tables, created by `bun setup`:

| Table | Effect |
| --- | --- |
| `allowed_ips` | Whitelist. These addresses skip the `security.cfg` rule check. Setup inserts `127.0.0.1` and `::1`. |
| `blocked_ips` | Blacklist. Every request from these addresses gets `403`. Filled automatically by rule matches. |

Things to know:

- Both tables are loaded into memory when the proxy starts. A manual change to either table takes effect after a restart.
- The blacklist is checked before the whitelist. An address in both tables is blocked.
- Whitelisting does not skip the host check or the blacklist. It only stops rule matches from banning that address.
- The client address is the one that opened the connection to the proxy. If you place another proxy or CDN in front of the gateway, every request appears to come from that proxy, and a single rule match would ban it.

```sql title="Whitelist an address and lift a ban"
INSERT INTO allowed_ips (ip) VALUES ('203.0.113.10');
DELETE FROM blocked_ips WHERE ip = '203.0.113.10';
```

Restart the gateway afterwards so the proxy reloads both lists.

## Host check

`DOMAIN` is the public origin of the site, for example `https://play.example.com`. The proxy strips the scheme and compares the rest with the host of each request. A request for any other host name gets `403`. This stops scanners that reach the server by IP address or through a stray DNS name.

The check is skipped when:

- `DOMAIN` is not set.
- `DOMAIN` is `localhost` or `127.0.0.1`.
- The request itself is for `localhost` or `127.0.0.1`.

:::warning Include the port when it is not the default one
The comparison uses host and port together. With `DOMAIN=https://play.example.com` a request to `play.example.com:8443` is rejected. If you serve the site on a non standard port, put that port in `DOMAIN`.
:::

## Forwarding

A request that passes the filter is sent to the webserver with these changes:

| Header | Value |
| --- | --- |
| `X-Real-Client-IP` | The client address. Any value the client sent for this header is removed first. |
| `X-Forwarded-For` | The client address. |
| `X-Forwarded-Proto` | `https` when the proxy serves TLS, otherwise `http`. |
| `Accept-Encoding` | `identity`, so the response is passed through uncompressed. |

Redirects from the webserver are passed back to the browser unchanged. The webserver uses `X-Real-Client-IP` as the player's address when it records logins.

The hop to the webserver uses HTTPS when the certificate files exist and plain HTTP when they do not. This depends only on the files, not on `HTTP_USE_SSL`.

## Adding rules

1. Open `src/webserver/config/security.cfg`.
2. Add one segment per line. Write it exactly as it appears between two slashes in the URL you want to trap.
3. Check that no real route, asset folder or documentation link contains that segment.
4. Restart the gateway. The proxy logs `Loaded N security rules` on start.

```text title="Adding a rule"
# Traps /phpmyadmin and /tools/phpmyadmin/index.php
phpmyadmin
```

:::tip Whitelist yourself first
Before testing a new rule from your own machine, add your address to `allowed_ips` and restart. Otherwise the first test request bans you.
:::

To see what the proxy decides for each request, set `LOG_LEVEL=debug`. It then logs every request, every blocked segment and every host mismatch to `src/logs/`.

:::note The gateway port is not filtered
These checks protect the website ports only. The gateway server ports (`GATEWAY_PORT`, `GATEWAY_PORTSSL`) use the same proxy module without a request filter. See [Game Servers](#/gateway/game-servers).
:::
