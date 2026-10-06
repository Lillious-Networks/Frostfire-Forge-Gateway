---
title: Game Servers and Realms
description: How game servers register with the gateway, heartbeats, realm selection, the whitelist flag, failover, connection tokens, and the gateway server HTTP API.
order: 50
---

The gateway server (`src/gateway/server.ts`) keeps an in-memory list of every running game server. Players see that list as realms. This page covers how a game server joins the list, how it stays on it, how a player ends up connected to one, and the HTTP API behind it all.

## The two shared values

Two values tie a game server to a gateway. Both must be identical on each side.

| Variable | Used for | Sent over the wire |
| --- | --- | --- |
| `GATEWAY_AUTH_KEY` | Proves a game server may register, send heartbeats and unregister. | Yes, in the JSON body of each call |
| `GATEWAY_GAME_SERVER_SECRET` | Signs the connection tokens players present to a game server. | No, only signatures made with it |

:::tabs
```env title="Gateway"
GATEWAY_PORT=9999
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me-too
```
```env title="Game server"
GATEWAY_URL=http://localhost:9999
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me-too
SERVER_ID=realm-one
SERVER_DESCRIPTION=The first realm
SERVER_HOST=localhost
PUBLIC_HOST=localhost
```
:::

The game server side of these settings is described in [Engine Configuration](#/engine/configuration).

:::danger Use TLS between hosts
`GATEWAY_AUTH_KEY` travels in the request body. If a game server reaches the gateway over the public internet, turn TLS on for the gateway port and point `GATEWAY_URL` at the HTTPS address. See [TLS](#/gateway/tls).
:::

## Registration

On startup a game server calls `POST /register` on the gateway and keeps retrying until it succeeds. The delay doubles from 1 second up to a cap of 30 seconds.

```json title="POST /register"
{
  "id": "realm-one",
  "description": "The first realm",
  "host": "localhost",
  "publicHost": "play.example.com",
  "port": 3000,
  "wtPort": 3000,
  "wtEnabled": true,
  "useSSL": true,
  "maxConnections": 2000,
  "whitelisted": false,
  "authKey": "change-me"
}
```

| Field | Meaning |
| --- | --- |
| `id` | The realm name. Players see it in the realm list. Required. From `SERVER_ID`. |
| `description` | Shown beside the realm when it is selected. From `SERVER_DESCRIPTION`. |
| `host` | Address the gateway uses to reach the game server. Required. From `SERVER_HOST`. |
| `publicHost` | Address browsers use to reach the game server. Defaults to `host`. From `PUBLIC_HOST`. |
| `port` | The game server's HTTP API port. Required. |
| `wtPort` | The WebTransport port. The engine sends the same number as `port`. |
| `wtEnabled` | Whether WebTransport is available. True when `wtPort` is a number. |
| `useSSL` | Whether the game server's HTTP API is served over TLS. |
| `maxConnections` | Player capacity. The gateway assumes 1000 when it is missing. |
| `whitelisted` | Whether the realm whitelist is on. |
| `authKey` | Must equal the gateway's `GATEWAY_AUTH_KEY`. |

The gateway answers `{"success": true, "serverId": "realm-one"}`. A wrong key gets `401`, a missing `id`, `host` or `port` gets `400`.

Registering an id that already exists replaces the entry and keeps its player count. That is how a game server rejoins after the gateway restarted.

:::warning Give every realm its own SERVER_ID
Two game servers with the same id overwrite each other in the list. Without `SERVER_ID` the engine invents a random id at every start, which changes the realm name players see.
:::

## Heartbeats

After registering, the game server sends `POST /heartbeat` on a timer. The interval is a game server setting and defaults to 5 seconds.

```json title="POST /heartbeat"
{
  "id": "realm-one",
  "activeConnections": 42,
  "cpuUsage": 12,
  "ramUsage": 310.5,
  "rtt": 4,
  "whitelisted": false,
  "authKey": "change-me"
}
```

The gateway records the time of the heartbeat, the player count, CPU percentage, memory in megabytes and the whitelist flag. It stores half of `rtt` (the round trip time of the previous heartbeat) as the realm's latency.

If the gateway does not know the id it answers `404`. The game server treats that, or any network error, as a lost connection and registers again with the same backoff as at startup.

Two gateway settings decide when a silent server is dropped:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEARTBEAT_INTERVAL` | `30000` | How often the gateway sweeps the list for dead servers. |
| `SERVER_TIMEOUT` | `90000` | Age of the last heartbeat after which a server counts as dead. |

A clean shutdown calls `POST /unregister`, which removes the realm at once.

## Realm states

`GET /status` reports one of three states per realm. The same data reaches the browser through `GET /api/gateway/servers` on the website.

| State | Condition | In the realm list |
| --- | --- | --- |
| `online` | A heartbeat arrived within `SERVER_TIMEOUT` and there is room | Online, selectable |
| `full` | `activeConnections` has reached `maxConnections` | Full, still selectable |
| `offline` | No heartbeat within `SERVER_TIMEOUT` | Offline, greyed out and not selectable |

## Realm selection

After login the player lands on `/realm-selection`.

- The page loads the realm list and refreshes it every 5 seconds while the tab is visible.
- Each card shows the realm id, `Players: active/max`, a state badge and a `whitelist` badge when the flag is set.
- The latency shown is measured by the browser itself: it times a `GET /ping` request sent straight to each game server at `publicHost:port`.
- Selecting a card shows the realm description. "Enter Realm" stores the id in the browser's local storage as `selectedServerId` and opens `/game`.

When the game client starts it:

1. Fetches a connection token from `GET /api/gateway/connection-token`.
2. Fetches the realm list and looks up the stored realm id.
3. Opens a WebTransport session to `https://<publicHost>:<wtPort>`.
4. If the stored realm is gone or the connection fails, it forgets the choice and connects to the first realm whose state is `online`.

:::note localhost becomes 127.0.0.1
The client rewrites a `publicHost` of `localhost` to `127.0.0.1` before connecting. The game server's local certificate must therefore be valid for `127.0.0.1`. The certificate the engine generates for development is.
:::

## Whitelist flag

A realm can be restricted to a list of accounts. The game server reports the state of that switch in `whitelisted` when it registers and again in every heartbeat. When an admin flips the whitelist at runtime, the game server sends an extra heartbeat immediately so the badge in the realm list updates without waiting for the timer.

The gateway only displays the flag. Whether a player may enter is decided by the game server. See [Realm Whitelist](#/engine/realm-whitelist).

## Connection tokens

A game server only accepts WebTransport sessions that present a token signed with `GATEWAY_GAME_SERVER_SECRET`. The webserver issues them.

```json title="GET /api/gateway/connection-token"
{
  "token": "<64 hex characters>",
  "timestamp": 1760000000000,
  "expiresAt": 1760000060000,
  "signature": "<hex HMAC>"
}
```

- `expiresAt` is 60 seconds after `timestamp`.
- `signature` is the HMAC SHA-256 of the string `token:timestamp:expiresAt` with the shared secret, in hexadecimal.
- If the caller's account has an open two-factor challenge the route answers `403` and no token is issued.
- If `GATEWAY_GAME_SERVER_SECRET` is not set the route answers `500`.

The client sends the four values, plus its page origin, in an `AUTH_CONNECT` frame as the first thing on the new session. The game server recomputes the signature, checks the expiry and, when its `CORS_ALLOWED_ORIGINS` is set, checks the origin. It then answers `AUTH_CONNECT_SUCCESS` and the normal login handshake begins. See [Networking](#/engine/networking).

```ts title="How the signature is made"
const signature = crypto
  .createHmac("sha256", process.env.GATEWAY_GAME_SERVER_SECRET)
  .update(`${token}:${timestamp}:${expiresAt}`)
  .digest("hex");
```

:::note What the token proves
The token shows that the client came through this gateway within the last minute. It does not identify the player and it is not tied to one realm. The player is identified afterwards with the session token from [Authentication](#/gateway/authentication/session-token).
:::

## Failover

Two separate mechanisms deal with a game server that disappears.

### In the game client

When the session to a game server closes unexpectedly and `GATEWAY_ENABLED` is `true`, the client tries to reconnect up to 5 times, 2 seconds apart. Each attempt runs the connection steps above again: a fresh token, a fresh realm list, the chosen realm first and otherwise the first `online` realm. On success the page reloads. After 5 failures the player is asked to refresh the page.

### In the gateway server

The gateway server proxies any path it does not handle itself to a registered game server over HTTP. It picks a server at random and remembers the choice in a `gateway_http_session` cookie for one hour, so later requests go to the same server.

When the sweep removes a dead server, these proxy sessions are moved to the remaining servers that still have room, in round robin order. If no server has room they are dropped. The dashboard API reports the number of moved sessions and the last 10 migrations. A proxy session idle for longer than `SESSION_TIMEOUT` is forgotten.

:::note Sessions here are HTTP proxy sessions
The migration in the gateway server concerns its own HTTP proxy sessions. It does not move a player's WebTransport connection, which runs directly between browser and game server. That part is handled by the reconnect logic in the client.
:::

## Gateway server HTTP API

Served on `GATEWAY_PORT` (9999), or `GATEWAY_PORTSSL` (9443) with TLS. `OPTIONS` requests get a `204` with permissive CORS headers.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/register` | `authKey` in body | Add or replace a game server |
| POST | `/heartbeat` | `authKey` in body | Report load and keep the server alive |
| POST | `/unregister` | `authKey` in body | Remove a game server |
| GET | `/status` | None | Public realm list with state, player counts and whitelist flag |
| GET | `/debug/sessions` | None | The HTTP proxy sessions and which server each is bound to |
| GET | `/` | None | Dashboard login page |
| GET | `/api/session` | Website `token` cookie | Whether the caller is logged in and may open the dashboard |
| POST | `/api/login` | Website `token` cookie of an admin with `server.gateway` or `server.*` | Start a dashboard session, sets the `dashboard_session` cookie |
| POST | `/api/logout` | None | End the dashboard session |
| GET | `/api/stats` | Dashboard cookie | Servers with CPU, memory, latency and health, plus migration history |
| GET | `/dashboard` | Dashboard cookie | The dashboard page. Redirects to `/` without a valid session. |
| GET | `/css/...`, `/js/...`, `/images/...` | None | Static files for the two pages above |
| Any | Anything else | None | Proxied to a registered game server, `503` when there is none |

```bash title="Check the realm list"
curl http://localhost:9999/status
```

```json title="GET /status"
{
  "totalServers": 1,
  "servers": [
    {
      "id": "realm-one",
      "description": "The first realm",
      "publicHost": "localhost",
      "port": 3000,
      "wtPort": 3000,
      "wtEnabled": true,
      "useSSL": true,
      "activeConnections": 42,
      "maxConnections": 2000,
      "latency": 2,
      "whitelisted": false,
      "status": "online"
    }
  ]
}
```

:::warning Protect the gateway port
`/status` and `/debug/sessions` need no key, and the request filter of the [Reverse Proxy](#/gateway/reverse-proxy) does not run on this port. Limit access to the gateway port with a firewall where you can. Browsers never need it: the website fetches the realm list for them over loopback.
:::

The dashboard routes are described in [Dashboard](#/gateway/dashboard).
