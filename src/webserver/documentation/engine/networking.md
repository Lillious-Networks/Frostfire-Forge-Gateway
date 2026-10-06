---
title: Networking
description: WebTransport over HTTP/3, TLS and certificate pinning, the frame format, movement datagrams, the HTTP API and the connection handshake.
order: 20
---

Game clients talk to the engine over WebTransport (HTTP/3 over QUIC), not WebSockets. This page covers the listeners, the mandatory TLS certificate, how packets are framed and batched, the small HTTP API and how a connection is authenticated.

## Listeners and ports

One port number carries two protocols.

| Listener | Bind | Port | Purpose |
|----------|------|------|---------|
| WebTransport | `0.0.0.0`, UDP | `WEBSRV_PORTSSL` (default `3000`) | Game traffic: one reliable stream plus datagrams per player |
| Public HTTP proxy | `0.0.0.0`, TCP | `WEBSRV_PORTSSL` with `HTTP_USE_SSL=true`, otherwise `WEBSRV_PORT` | Forwards every request to the internal API |
| HTTP to HTTPS redirect | `0.0.0.0`, TCP | `WEBSRV_PORT` (only with `HTTP_USE_SSL=true`) | Answers `301` to the HTTPS port |
| Internal HTTP API | `127.0.0.1`, TCP | `WEBSRV_INTERNAL_PORT` (default `3002`) | `/status`, `/ping`, `/wt-cert-hash`, plugin routes |

The files involved:

| File | Role |
|------|------|
| `src/socket/server.ts` | Process entry point. Starts every listener and wires the handlers. |
| `src/socket/transport.ts` | WebTransport server, `TransportConnection`, datagram and stream sending |
| `src/socket/framing.ts` | Frame encoding and the `FrameDecoder` |
| `src/socket/receiver.ts` | Packet dispatch: one `switch` over the packet type |
| `src/socket/packet_manager.ts` | Builders for every outgoing packet |
| `src/socket/topics.ts` | `topicBus`, the publish and subscribe fan out |
| `src/modules/https_servers.ts` | The public HTTP proxy and redirect |
| `src/modules/gateway-client.ts` | Registration and heartbeats to the gateway |

Connection handles are called `wt` everywhere (`player.wt`, `sendPacket(wt, ...)`).

:::warning HTTP/3 is off for the HTTP API
The WebTransport listener owns the UDP side of the game port, so `server.ts` always starts the public HTTP proxy with `http3: false`. `WEBSRV_HTTP3` has no effect on the engine.
:::

## TLS is mandatory

WebTransport runs over QUIC, and QUIC always uses TLS, so there is no unencrypted mode, not even on localhost. `server.ts` stops with an error when it cannot load a certificate and key:

```ts title="src/socket/server.ts"
if (!webTransportTls) {
  log.error(`Attempted to locate certificate and key but failed`);
  throw new Error("WebTransport requires a TLS certificate and key. Set TLS_CERT_PATH and TLS_KEY_PATH to your certificate files, or run `bun generate-local-cert` to create a local certificate");
}
```

It also refuses to start with an expired or unreadable certificate, logs how many days remain, and warns when fewer than 3 days are left or when the certificate does not cover `PUBLIC_HOST` or `SERVER_HOST`.

## Automatic local certificate

Before loading the certificate, `server.ts` calls `ensureLocalCertificate` (`src/utility/local_cert.ts`) with the paths from `TLS_CERT_PATH`, `TLS_KEY_PATH` and `TLS_CA_PATH`. A new certificate is generated when:

- the certificate or key file is missing, or
- the existing certificate is self-signed and expired, not suitable for pinning, or missing one of the hostnames.

A certificate signed by a CA is never replaced. Renewing it is up to you.

| Property | Value |
|----------|-------|
| Key | ECDSA P-256 |
| Validity | 13 days (a pinned certificate may be valid for at most 14) |
| Hostnames | `localhost`, `127.0.0.1`, `::1`, plus `PUBLIC_HOST` and `SERVER_HOST` |
| Trust | On Windows the certificate is added to the current user's root store with `certutil`, unless `SKIP_CERT_TRUST=true`. On other systems you import it yourself. |

```bash title="Certificate commands"
# Check the certificate at TLS_CERT_PATH and create one when needed
bun --env-file=.env.development ./src/utility/generate_local_cert.ts

# Replace it even when it is still valid
bun --env-file=.env.development ./src/utility/generate_local_cert.ts --force

# Renew a certificate signed by a local CA (for example mkcert), adding a LAN address
bun --env-file=.env.development ./src/utility/renew_lan_cert.ts --host your-lan-address
```

:::note
`bun generate-local-cert` loads no environment file by itself. Pass `--env-file` as above so it reads the paths of the environment you mean.
:::

`renew_lan_cert.ts` accepts `--cert`, `--key`, `--ca`, `--ca-key`, `--days` (default `13`) and `--host` (repeatable).

## The /wt-cert-hash endpoint

Chrome does not accept a locally installed root CA for WebTransport. It accepts a publicly trusted certificate, or a short lived one whose SHA-256 hash the page supplies up front (`serverCertificateHashes`). The engine publishes that hash so the client can pin it.

```json title="GET /wt-cert-hash"
{
  "algorithm": "sha-256",
  "value": "<base64 SHA-256 of the certificate>"
}
```

The endpoint answers `404` with `{"error": "Certificate is not suitable for pinning"}` when the certificate cannot be pinned (expired, valid for more than 14 days, not an EC key, or missing `localhost` or `127.0.0.1` among its names). The browser then has to trust the certificate the normal way.

The game client fetches the hash before it opens the session:

```ts title="Client side pinning (gateway: public/js/core/socket.ts)"
const hash = await fetchServerCertHash(server); // GET /wt-cert-hash
const options = hash
  ? { serverCertificateHashes: [{ algorithm: "sha-256", value: base64ToBytes(hash) }] }
  : undefined;

const gameTransport = new WebTransport(gameServerUrl, options);
```

The server pins the same way when it probes its own listener at startup, which is why no "skip verification" switch is needed.

## Connection and auth handshake

A connection goes through two stages: the transport handshake (is this a client the gateway sent?) and the login (which account is it?).

### 1. Get a connection token from the gateway

The client asks the gateway for a short lived token. The gateway signs it with `GATEWAY_GAME_SERVER_SECRET`, the secret both servers share.

```json title="GET /api/gateway/connection-token (gateway)"
{
  "token": "<64 hex characters>",
  "timestamp": 1760000000000,
  "expiresAt": 1760000060000,
  "signature": "<hex HMAC-SHA256 of token:timestamp:expiresAt>"
}
```

### 2. Open the session and send AUTH_CONNECT

The client opens a WebTransport session, opens one bidirectional stream, and sends its first frame:

```json title="First frame on the stream"
{
  "type": "AUTH_CONNECT",
  "data": {
    "token": "...",
    "timestamp": 1760000000000,
    "expiresAt": 1760000060000,
    "signature": "...",
    "useragent": "Mozilla/5.0 ...",
    "origin": "https://play.example.com"
  }
}
```

The engine checks it in `validateConnectionToken`:

```ts title="src/socket/server.ts"
const expectedSignature = crypto
  .createHmac("sha256", sharedSecret)
  .update(`${token}:${timestamp}:${expiresAt}`)
  .digest("hex");

if (signature !== expectedSignature) return false;
if (Date.now() > parseInt(expiresAt)) return false;

if (ALLOWED_ORIGINS.length > 0) {
  if (!origin || !ALLOWED_ORIGINS.some(o => o.trim() === origin)) return false;
}
```

| Outcome | What the engine does |
|---------|----------------------|
| Valid | Assigns a random numeric connection id, calls `onOpen`, replies `{"type":"AUTH_CONNECT_SUCCESS","data":null}` |
| First frame is not a valid `AUTH_CONNECT` | Closes with code `1008`, reason `Unauthorized: Invalid token` |
| No valid frame within `webtransport.authTimeoutMs` (10 seconds) | Closes with `1008`, reason `Authentication timeout` |
| No stream opened | Closes with `1008`, reason `No control stream received` |

On open, the connection is subscribed to the `CONNECTION_COUNT`, `BROADCAST` and `DISCONNECT_PLAYER` topics and the `onConnection` event is emitted.

### 3. Log in

| Step | Client sends | Engine answers |
|------|--------------|----------------|
| 1 | `PING` | `PONG` |
| 2 | `LOGIN` | `LOGIN_SUCCESS` with the connection id and the public chat key |
| 3 | `AUTH` with the account's session token and a language code | The login worker loads the account. On failure: `LOGIN_FAILED` and close `1008`. |

```ts title="src/socket/receiver.ts"
case "AUTH": {
  const token = data?.toString() as string;

  if (authentication_queue.has(token)) {
    sendPacket(wt, packetManager.loginFailed());
    wt.close(1008, "Authentication already in progress");
    break;
  }

  authentication_queue.add(token);
  authentication_session_queue.add(wt.data.id);
  pendingAuthentications.set(wt.data.id, { wt, token, language: parsedMessage?.language || "en" });

  authWorker.postMessage({ token, id: wt.data.id });
  break;
}
```

The worker (`src/socket/authentication.ts`) binds the session token to the connection id, loads the player's data, inventory, collectables and learned spells, and posts the result back. The main thread then checks the [realm whitelist](#/engine/realm-whitelist), closes any older session of the same account, emits `onPlayerAuthComplete`, reloads the player's cached rows and adds the player to `playerCache`.

The packet names themselves are listed on the [Packet types](#/engine/packet-types) page.

## Frame format

Everything on the reliable stream is length prefixed. A frame is a 4 byte little endian length followed by the payload. The payload of a normal packet is UTF-8 JSON with a `type` and a `data` field.

| Offset | Size | Content |
|--------|------|---------|
| 0 | 4 bytes | Payload length, unsigned 32 bit, little endian |
| 4 | N bytes | Payload |

```ts title="src/socket/framing.ts"
export function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}
```

`FrameDecoder.push(chunk)` collects stream chunks and returns every complete frame. A frame longer than the limit (`webtransport.maxPayloadMB`, in megabytes) marks the decoder as overflowed, and the connection is closed with code `1009`, reason `Frame too large`.

Packets are built by `packetManager` and encoded with `packet.encode`:

```ts title="Building and sending a packet"
import { packetManager } from "@engine/socket/packet_manager";

// A builder returns an array of encoded packets
player.wt.send(packetManager.notify({ message: "Hello" })[0]);
```

### Close reasons

WebTransport close codes carry less than WebSocket ones did, so the engine keeps its own code in the reason text as `code|reason`:

```ts title="src/socket/framing.ts"
export function encodeCloseReason(code: number, reason: string): string {
  return `${code}|${reason || ""}`;
}
```

`connection.close(1000, ...)` is sent as WebTransport close code `0` (normal). Any other code is sent as `1`.

## Datagrams and movement batching

`TransportConnection.send(payload)` looks at the first byte to choose a path:

| First byte | Path |
|------------|------|
| `0x01`, `0x02` or `0x03` | Movement: sent as an unreliable datagram |
| Anything else | A frame on the reliable stream |

Movement is loss tolerant (the next update replaces the last one), so it does not wait in the ordered stream queue.

### Single position: header 0x02

Sent to the moving player on every tick as their own position echo. 21 bytes:

| Offset | Type | Content |
|--------|------|---------|
| 0 | u8 | `0x02` |
| 1 | u32 | Player id |
| 5 | i32 | x in pixels |
| 9 | i32 | y in pixels |
| 13 | u8 | Direction in the low 4 bits, stealth flag in bit 4 |
| 14 | u8 | Padding |
| 15 | u32 + u16 | Server send time: seconds, then milliseconds |

### Batch of positions: header 0x01

Everyone else learns about movers through batches (`src/socket/movement_batch.ts`):

| Offset | Type | Content |
|--------|------|---------|
| 0 | u8 | `0x01` |
| 1 | u16 | Number of entries |
| 3 | 13 bytes each | `[u32 id][i32 x][i32 y][u8 direction and stealth]` |
| end | 10 bytes | Latency probe: `[u32 sequence][u32 seconds][u16 ms]` |

All multi byte values are little endian. Directions are numbered `up` 0, `down` 1, `left` 2, `right` 3, `upleft` 4, `upright` 5, `downleft` 6, `downright` 7.

The encoder fills each datagram up to `MAX_DATAGRAM_SIZE` (1200 bytes) and starts a new one when it is full. If a `0x01` payload larger than `webtransport.maxDatagramSize` still reaches the connection, `sendSplitBatch` cuts it into several datagrams. Other movement payloads that are too large fall back to the stream.

:::warning Keep the two sizes equal
`MAX_DATAGRAM_SIZE` in `movement_batch.ts` is a constant and `webtransport.maxDatagramSize` comes from `settings.json`. Both are 1200 by default. Raising them risks packets being dropped on the path between client and server.
:::

### The flush

Moving players queue their position per layer. A timer in `receiver.ts` flushes the queue at an adaptive interval:

| Condition | Interval |
|-----------|----------|
| Event loop lag above 120 ms | 150 ms |
| Event loop lag above 60 ms | 100 ms |
| Event loop lag above 30 ms | 66 ms |
| Healthy, fewer than 8000 movement datagrams per second | 33 ms |
| Healthy, 8000 or more per second | 50 ms |
| Flush latency 15 ms or more | 66 to 120 ms, growing with latency |

A layer with more than 20 receivers hands the encoding to a movement worker thread (see [Game loop](#/engine/game-loop/worker-pools)). Smaller layers are encoded inline.

### Best effort packets

`sendBestEffort(payload)` sends any packet as a datagram when it fits, and on the stream when it does not. The engine uses it for repeating status updates such as health and stamina regeneration and the connection count.

```ts title="src/socket/server.ts"
const statsFrame = packetManager.updateStats(updateStatsData)[0];
playerData.wt.sendBestEffort(statsFrame);
```

### Slow clients

Stream writes wait on QUIC flow control. Once a connection has more than 48 MB queued, new stream frames for it are dropped and a warning is logged at most every 10 seconds. The server also samples every connection's queue every 10 seconds and logs, at most once a minute, the ones with more than 256 KB queued.

## HTTP API

The API is tiny. It is served by `Bun.serve` on `127.0.0.1:WEBSRV_INTERNAL_PORT` and reached from outside through the public proxy, which adds `X-Real-Client-IP`, `X-Forwarded-For` and `X-Forwarded-Proto`.

| Route | Method | Response |
|-------|--------|----------|
| `/status` | GET | `{"status":"ok"}` |
| `/ping` | GET | `{"pong": <server time in ms>}` |
| `/wt-cert-hash` | GET | The certificate hash, or `404` |
| `/creature-stats` | GET | Creature system counters and tick timings. `?reset=1` starts a new measuring window. |
| any | OPTIONS | `204` with CORS headers for an allowed origin, `403` otherwise |
| Plugin routes | as registered | Whatever the plugin returns |
| Anything else | any | `404 Not found` |

```bash title="Checking a running server"
curl http://localhost:3000/status
curl http://localhost:3000/ping
curl http://localhost:3000/wt-cert-hash
```

Plugins add routes with `engine.addHttpRoute(method, route, handler)`. Routes are matched on the exact `METHOD:path` pair. See [Engine API](#/engine/engine-api).

```ts title="A plugin HTTP route"
export function register(engine: EngineAPI) {
  engine.addHttpRoute("GET", "/my-plugin/health", async () => {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  });
}
```

## CORS

`CORS_ALLOWED_ORIGINS` is a comma separated list. The request's `Origin` header must match one entry exactly, or the list must contain `*`.

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | The request's origin, when allowed |
| `Access-Control-Allow-Methods` | `GET,POST` |
| `Access-Control-Allow-Headers` | `Content-Type,Authorization` |
| `Access-Control-Max-Age` | `3600` |

CORS headers are added to `/ping`, `/wt-cert-hash` and `OPTIONS` answers. With an empty list no headers are sent, so browsers block every cross origin request, and the server logs a warning at startup.

:::warning The origin list also guards WebTransport
When `CORS_ALLOWED_ORIGINS` is not empty, the `origin` field of `AUTH_CONNECT` must be in the list (an exact match, `*` does not count here). Add the address players load the game from.
:::

## Rate limiting

| Limit | Where | Rule |
|-------|-------|------|
| Packets per connection | `server.ts`, `packetRatelimit` in `settings.json` | When a connection's counter reaches `maxRequests`, it receives one `RATE_LIMITED` packet and its packets are ignored for `time` milliseconds |
| Chat | `receiver.ts` | 5 messages per 3 seconds per connection, at most 500 characters each |
| NPC and quest packets | `receiver.ts` | 5 per 3 seconds per connection |
| Login | `receiver.ts` | One `AUTH` in progress per session token and per connection |
| Unauthenticated sessions | `transport.ts` | Closed after `webtransport.authTimeoutMs` |
| Sessions in total | `transport.ts` | `webtransport.maxSessions` |

```ts title="src/socket/server.ts"
client.requests++;
if (client.requests >= RateLimitOptions.maxRequests) {
  client.rateLimited = true;
  client.time = Date.now();
  connection.send(
    packet.encode(JSON.stringify({ type: "RATE_LIMITED", data: "Rate limited" }))
  );
  return;
}
```

The public HTTP proxy has no request rate limit of its own in the engine. The handshake, stream and datagram limits under `webtransport.rateLimits` are described in [Configuration](#/engine/configuration/settingsjson).

## Inbound dispatch

Every inbound frame and datagram reaches `onTransportMessage` as text. It parses the JSON once, applies the packet rate limit, refreshes the player's `lastUpdated` time, and passes the packet to `packetReceiver`. `MOVEXY`, `STATS`, `SERVER_TIME` and `ANIMATION` are handled immediately. Everything else goes through a per connection queue.

`packetReceiver` rejects empty messages (`1008`), messages that are not JSON or have no type (`1007`), and messages larger than `maxPayloadMB` (`1009`). Plugin packet interceptors run before the built in handlers. See [Plugins](#/engine/plugins).

## topicBus

`topicBus` (`src/socket/topics.ts`) is a small publish and subscribe hub: a map from topic name to a set of connections.

| Method | Effect |
|--------|--------|
| `subscribe(topic, connection)` | Adds the connection to the topic |
| `unsubscribe(topic, connection)` | Removes it |
| `publish(topic, payload)` | Calls `connection.send(payload)` for every subscriber |
| `publishBestEffort(topic, payload)` | Sends as a datagram where the connection supports it |
| `clear(connection)` | Removes the connection from every topic (done on close) |

A connection can also subscribe through its own methods, `connection.subscribe(topic)` and `connection.unsubscribe(topic)`.

```ts title="src/socket/server.ts"
topicBus.publishBestEffort(
  "CONNECTION_COUNT",
  packet.encode(JSON.stringify({
    type: "CONNECTION_COUNT",
    data: connections.size,
  }))
);
```

The built in topics are `CONNECTION_COUNT` (sent at most every 500 ms), `BROADCAST` (used by `events.Broadcast`) and `DISCONNECT_PLAYER`. Most game traffic does not use topics: it is sent to the players in a player's area of interest, described in [AOI and layers](#/engine/aoi-and-layers).

## Gateway registration

After the listeners are up, `GatewayClient` registers the realm with the gateway (`POST /register`) and keeps retrying with a growing delay (1 second up to 30 seconds) until it succeeds. Then it sends a heartbeat (`POST /heartbeat`) every `gateway.heartbeatInterval` milliseconds with the connection count, CPU and RAM usage, round trip time and the whitelist state. A failed heartbeat starts the registration again. On `SIGINT` or `SIGTERM` the server unregisters (`POST /unregister`) before it stops.

The gateway side is described in [Game servers](#/gateway/game-servers).
