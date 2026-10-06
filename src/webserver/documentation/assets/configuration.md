---
title: Configuration
description: Every environment variable the asset server reads, with its default and purpose, and an example environment file.
order: 20
---

The asset server is configured entirely through environment variables. `bun development` loads `.env.development` and `bun production` loads `.env.production`. This page lists every variable the code reads.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `ASSETS_PATH` | `src/assets` inside the repository | Folder the assets are loaded from. Absolute, or relative to the folder the server is started in. The server exits if the folder does not exist. See [Asset paths](#/assets/asset-paths). |
| `ASSET_SERVER_AUTH_KEY` | Falls back to `GATEWAY_AUTH_KEY`, then to a built in placeholder | Shared secret the engine sends with every sync and save request. Must equal the engine's `ASSET_SERVER_AUTH_KEY`. |
| `GATEWAY_AUTH_KEY` | None | Only used as the auth key when `ASSET_SERVER_AUTH_KEY` is not set. |
| `WEBSRV_PORT` | `80` | Public HTTP port. With TLS on, this port only redirects to HTTPS. |
| `WEBSRV_PORTSSL` | `443` | Public HTTPS port, used when TLS is on. |
| `WEBSRV_INTERNAL_PORT` | `8082` | Port of the application itself, bound to `127.0.0.1`. The public listener forwards to it. |
| `HTTP_USE_SSL` | Off | Set to `true` to serve HTTPS. Needs the certificate files below. |
| `TLS_CERT_PATH` | None | Path to the certificate (PEM). |
| `TLS_KEY_PATH` | None | Path to the private key (PEM). |
| `TLS_CA_PATH` | None | Optional CA bundle, appended to the certificate chain when the file exists. |
| `WEBSRV_HTTP1` | On | Set to `false` to turn HTTP/1.1 off. |
| `WEBSRV_HTTP2` | On | Set to `false` to turn HTTP/2 off. |
| `WEBSRV_HTTP3` | On, with TLS only | Set to `false` to turn HTTP/3 off. Has no effect without TLS. |
| `DOMAIN` | None | Optional host check. When set to anything other than `http://localhost`, a request whose host differs from this value (scheme removed) is answered with 403. |
| `LOG_LEVEL` | `info` | Log detail, for example `info` or `debug`. With `debug` the server logs every file it loads. |
| `CACHE` | `memory` | Where loaded assets are kept: `memory`, or `redis` for Bun's Redis client. |

:::danger Always set the auth key
When neither `ASSET_SERVER_AUTH_KEY` nor `GATEWAY_AUTH_KEY` is set, the server falls back to a placeholder key that is written in the source code. Anyone who knows it could download your maps and overwrite them through the save endpoints. Set a long random value.
:::

:::note CORS_ALLOWED_ORIGINS is not used here
The development file in the repository contains a `CORS_ALLOWED_ORIGINS` line. The asset server does not read it: it answers every origin with `Access-Control-Allow-Origin: *`. That variable only matters on the engine, see [engine configuration](#/engine/configuration).
:::

## Example

```env title=".env.development"
# Assets
ASSETS_PATH=./src/assets

# Ports
WEBSRV_PORT=8000
WEBSRV_PORTSSL=8082
WEBSRV_INTERNAL_PORT=8083
HTTP_USE_SSL=false

# HTTP protocol versions
WEBSRV_HTTP1=true
WEBSRV_HTTP2=true
WEBSRV_HTTP3=true

# TLS (used when HTTP_USE_SSL=true)
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

# Shared with the engine
ASSET_SERVER_AUTH_KEY=change-me

LOG_LEVEL=info
```

## Ports and listeners

The server opens two or three listeners:

| Listener | Address | When |
| --- | --- | --- |
| Application | `127.0.0.1:WEBSRV_INTERNAL_PORT` | Always. |
| Public proxy | `0.0.0.0:WEBSRV_PORT` | When TLS is off. |
| Public proxy | `0.0.0.0:WEBSRV_PORTSSL` | When TLS is on. |
| HTTP to HTTPS redirect | `0.0.0.0:WEBSRV_PORT` | When TLS is on. |

The startup log tells you which one is active:

```text title="Startup log"
[Asset Server] HTTP proxy started on port 8000 forwarding to http://127.0.0.1:8083
```

:::warning Keep the three ports different
The defaults in code are 80, 443 and 8082 for the internal port. The example file uses 8082 as the HTTPS port, so if you copy that value and leave `WEBSRV_INTERNAL_PORT` unset, the two collide. Set all three explicitly.
:::

Which port is the "asset server port" for everyone else depends on TLS:

:::tabs
```env title="TLS off"
# Asset server
WEBSRV_PORT=8000
HTTP_USE_SSL=false

# Engine and gateway
ASSET_SERVER_URL=http://localhost:8000
```
```env title="TLS on"
# Asset server
WEBSRV_PORT=8000
WEBSRV_PORTSSL=8443
HTTP_USE_SSL=true

# Engine and gateway
ASSET_SERVER_URL=https://assets.example.com:8443
```
:::

## TLS

Set `HTTP_USE_SSL=true` and point the three `TLS_` variables at your certificate files.

- If the certificate or the key cannot be found, the server logs `SSL requested but certificates not found` and serves plain HTTP on `WEBSRV_PORT` instead of stopping.
- The application listener on `127.0.0.1` also uses the certificate whenever the files exist, even with `HTTP_USE_SSL=false`. Its address then starts with `https://`, which matters if you point the engine's `ASSET_SERVER_INTERNAL_URL` at it.
- HTTP/3 is offered on the HTTPS port unless `WEBSRV_HTTP3=false`. It uses UDP on the same port number, so open UDP in your firewall if you want it.

See [Production](#/getting-started/production) for the certificate layout shared by all three servers.

## Using the asset server from the other servers

The asset server's address and key appear in the other two environment files:

| Server | Variable | Value |
| --- | --- | --- |
| Engine | `ASSET_SERVER_URL` | The public address. Also sent to the player's browser. |
| Engine | `ASSET_SERVER_INTERNAL_URL` | Optional address for the engine's own calls. |
| Engine | `ASSET_SERVER_AUTH_KEY` | The same value as on the asset server. |
| Gateway | `ASSET_SERVER_URL` | The public address. Built into the browser client when the gateway starts. |

Those variables are documented with their own servers: [engine configuration](#/engine/configuration) and [gateway configuration](#/gateway/configuration). How they are used is covered in [Integration](#/assets/integration).
