---
title: Requirements
description: The runtime, databases, operating systems, browsers and ports you need to run Frostfire Forge.
order: 30
---

This page lists everything that has to be in place before you install Frostfire Forge: the runtime, the database, the supported platforms and browsers, and the ports that must be free.

## Runtime

All three servers run on [Bun](https://bun.sh). There is no Node.js fallback and no build step: Bun executes the TypeScript sources directly.

| Requirement | Detail |
| --- | --- |
| Bun | 1.4 or newer. The engine's WebTransport package (`@lillious-networks/webtransport-bun`) declares `bun >= 1.4.0`. |
| Docker images | Every Dockerfile in the three repositories builds on `oven/bun:canary-slim`. |

```bash title="Check or update Bun"
bun --version
bun upgrade
```

:::tip Matching the Docker images
If something works in the Docker images but not on your machine, switch to the same channel with `bun upgrade --canary`.
:::

## Database

The gateway and the engine use the **same** database: the engine creates the game tables and the `accounts` table, and the gateway reads and writes accounts in it.

| Engine | Use | Notes |
| --- | --- | --- |
| MySQL | Development and production | The default (`DATABASE_ENGINE=mysql`). The gateway's development compose file uses the `mysql:9.0` image. |
| SQLite | Local development of the engine | `DATABASE_ENGINE=sqlite`, set up with `bun setup-localdb` in the engine repository. The file is created in the system temp folder as `frostfire_forge/<DATABASE_NAME>.sqlite`. |

:::warning SQLite and the gateway
The gateway's `bun setup` script issues MySQL statements. The engine's SQLite setup creates the tables the gateway needs (`accounts`, `allowed_ips`, `blocked_ips`), but MySQL is the path this documentation covers end to end.
:::

The asset server needs no database.

## Operating system

The asset server and the gateway are plain Bun programs. The engine loads a native WebTransport library, which ships prebuilt for these platforms:

| OS | Architectures |
| --- | --- |
| Linux (glibc and musl) | x64, arm64 |
| macOS | x64, arm64 |
| Windows | x64 |

Other platforms have to build the library from source and need a Rust toolchain.

:::note Windows and local certificates
On Windows the engine adds the local certificate it generates to the current user's trusted root store with `certutil`. Set `SKIP_CERT_TRUST=true` in the engine's environment to skip that.
:::

## Browser

The game client connects to the engine over **WebTransport**, and the project supports **Chromium based browsers only** (Chrome, Edge and others built on Chromium).

In local development the engine uses a self signed certificate that the browser pins by hash. That certificate is short lived on purpose (13 days by default, always under 14) and is generated again when the engine starts with an expired one. See [TLS](#/gateway/tls) and [Networking](#/engine/networking).

## Ports

These are the defaults. Every port can be changed in the environment files.

| Server | Port | Transport | Open to players |
| --- | --- | --- | --- |
| Gateway web | 80 (HTTP), 443 (HTTPS) | TCP, and UDP 443 for HTTP/3 | Yes |
| Gateway web, internal | 8080 | TCP on `127.0.0.1` | No |
| Gateway server | 9999 (HTTP), 9443 (HTTPS) | TCP, and UDP 9443 for HTTP/3 | Only if engines or the dashboard connect from outside |
| Gateway server, internal | 9998 | TCP on `127.0.0.1` | No |
| Engine | 3000 | UDP (WebTransport) and TCP (HTTP API) | Yes, both |
| Engine, internal | 3002 | TCP on `127.0.0.1` | No |
| Asset server | 8000 in the development file (code default: 80 and 443) | TCP, and UDP for HTTP/3 with TLS | Yes |
| Asset server, internal | 8082 in code, 8083 in the example file | TCP on `127.0.0.1` | No |
| MySQL | 3306 | TCP | No |

:::warning Open UDP for the game port
A firewall rule that only allows TCP 3000 lets the certificate hash request through but blocks the game connection itself. The engine needs UDP on the same port.
:::

## Optional services

| Service | Needed for |
| --- | --- |
| Docker and Docker Compose | Running the servers in containers. See [Docker](#/getting-started/docker). |
| An SMTP account | Email verification, password reset and email two-factor codes on the gateway. See [gateway configuration](#/gateway/configuration). |
| Redis | `CACHE=redis`. See [Caching](#/engine/caching). |
| An OpenWeatherMap API key | Real weather. See [Weather](#/engine/weather). |
| A TLS certificate for your domain | Production. See [Production](#/getting-started/production). |

## Next step

Continue with the [Quick start](#/getting-started/quick-start).
