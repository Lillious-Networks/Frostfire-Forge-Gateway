---
title: Configuration
description: Every environment variable the gateway reads, the config.json file, and the package.json scripts.
order: 20
---

The gateway is configured through an environment file. `bun development` loads `.env.development` and `bun production` loads `.env.production`. Copy `.env.example` to start a new one. This page lists every variable the code reads, with the default that applies when the variable is missing.

:::warning Keep secrets out of version control
`.env.production` holds database passwords and shared secrets. It is ignored by git on purpose. Never commit it, and use long random values in place of every `change-me` below.
:::

## Example file

:::tabs
```env title="Development"
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_NAME=frostfire_forge
DATABASE_USER=gateway_user
DATABASE_PASSWORD=change-me
DATABASE_PORT=3306
SQL_SSL_MODE=DISABLED

WEBSRV_PORT=80
WEBSRV_PORTSSL=443
WEBSRV_INTERNAL_PORT=8080
HTTP_USE_SSL=false

GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
GATEWAY_INTERNAL_PORT=9998
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me

DOMAIN=http://localhost
GAME_NAME=Frostfire Forge
LOG_LEVEL=debug
GUEST_MODE_ENABLED=true
ASSET_SERVER_URL=http://localhost:8000
```
```env title="Production"
DATABASE_ENGINE=mysql
DATABASE_HOST=db.example.com
DATABASE_NAME=frostfire_forge
DATABASE_USER=gateway_user
DATABASE_PASSWORD=change-me
DATABASE_PORT=3306
SQL_SSL_MODE=DISABLED

EMAIL_SERVICE=smtp.example.com
EMAIL_USER=no-reply@example.com
EMAIL_PASSWORD=change-me

WEBSRV_PORT=80
WEBSRV_PORTSSL=443
WEBSRV_INTERNAL_PORT=8080
HTTP_USE_SSL=true
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
GATEWAY_INTERNAL_PORT=9998
GATEWAY_AUTH_KEY=change-me
GATEWAY_GAME_SERVER_SECRET=change-me

DOMAIN=https://play.example.com
GAME_NAME=Frostfire Forge
LOG_LEVEL=info
GUEST_MODE_ENABLED=false
ASSET_SERVER_URL=https://assets.example.com
```
:::

## Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_ENGINE` | `mysql` | `mysql`, `postgres` or `sqlite`. |
| `DATABASE_HOST` | none | Database host. Required for `mysql` and `postgres`. |
| `DATABASE_NAME` | none | Database name. Required for `mysql` and `postgres`. With `sqlite` it names the file: `<tmp>/frostfire_forge/<DATABASE_NAME>.sqlite`. |
| `DATABASE_USER` | none | Database user. Required for `mysql` and `postgres`. |
| `DATABASE_PASSWORD` | none | Database password. Required for `mysql` and `postgres`. |
| `DATABASE_PORT` | `3306` (`5432` for `postgres`) | Database port. |
| `SQL_SSL_MODE` | `DISABLED` | Any other value makes the database connection use TLS with the certificate at `src/certs/db.crt`. |

The gateway must point at the same database as the game engine. It reads and writes the `accounts` table and the per-player tables the engine creates.

## Website ports and protocols

| Variable | Default | Purpose |
| --- | --- | --- |
| `HTTP_USE_SSL` | `false` | `true` turns TLS on for the website port and the gateway port. Needs the certificate files below. |
| `WEBSRV_PORT` | `80` | Public plain HTTP port. When TLS is on, this port only redirects to HTTPS. |
| `WEBSRV_PORTSSL` | `443` | Public HTTPS port, used when TLS is on. |
| `WEBSRV_INTERNAL_PORT` | `8080` | Loopback port of the webserver behind the reverse proxy. |
| `WEBSRV_HTTP1` | on | `false` turns HTTP/1.1 off on every listener. |
| `WEBSRV_HTTP2` | on | `false` turns HTTP/2 off on every listener. |
| `WEBSRV_HTTP3` | on | `false` turns HTTP/3 off. HTTP/3 only runs when TLS is on. |

## TLS certificates

| Variable | Default | Purpose |
| --- | --- | --- |
| `TLS_CERT_PATH` | none | Path to the PEM certificate. `.env.example` uses `./src/certs/cert.pem`. |
| `TLS_KEY_PATH` | none | Path to the PEM private key. `.env.example` uses `./src/certs/key.pem`. |
| `TLS_CA_PATH` | none | Optional CA bundle. When the file exists it is appended to the certificate to form the chain. |

One certificate serves both the website and the gateway port. See [TLS](#/gateway/tls).

## Gateway server

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_PORT` | `9999` | Public plain HTTP port of the gateway server. Redirects to HTTPS when TLS is on. Also injected into the client. |
| `GATEWAY_PORTSSL` | `9443` | Public HTTPS port of the gateway server, used when TLS is on. |
| `GATEWAY_INTERNAL_PORT` | `9998` | Loopback port of the gateway server application. The webserver reads the realm list from here. |
| `GATEWAY_AUTH_KEY` | none | Shared key. Game servers send it with every register, heartbeat and unregister call. It does not open the dashboard. |
| `GATEWAY_GAME_SERVER_SECRET` | none | Shared secret used to sign connection tokens (HMAC SHA-256). Must be the same value on every game server. Also guards `POST /guest-bulk`. |
| `HEARTBEAT_INTERVAL` | `30000` | How often, in milliseconds, the gateway looks for dead game servers. |
| `SERVER_TIMEOUT` | `90000` | A game server with no heartbeat for this long, in milliseconds, is removed. |
| `SESSION_TIMEOUT` | `300000` | An HTTP proxy session idle for this long, in milliseconds, is forgotten. |

:::danger An empty auth key is not a locked door
If `GATEWAY_AUTH_KEY` is not set, the gateway compares incoming keys against `null`. Always set it, and set the same value in each game server's environment.
:::

## Application

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOMAIN` | none | Public origin of the website, with scheme, for example `https://play.example.com`. Used for the reverse proxy host check, password reset links, guest email addresses and as the WebAuthn fallback host. |
| `GAME_NAME` | `Frostfire Forge` | Shown in emails and used as the issuer name in authenticator apps and the relying party name for security keys. |
| `GUEST_MODE_ENABLED` | off | `true` or `1` allows `POST /guest-login` and `POST /guest-bulk`. |
| `LOG_LEVEL` | `info` | `debug` also writes debug lines, `trace` writes everything. |
| `CACHE` | `memory` | `redis` switches the asset cache service to Redis. |
| `NODE_ENV` | none | `development` only changes the banner printed at startup. |

## Email

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_SERVICE` | none | SMTP host name, for example `smtp.example.com`. The gateway connects to it on port 587. |
| `EMAIL_USER` | none | SMTP user name. Also the sender address. |
| `EMAIL_PASSWORD` | none | SMTP password. |

:::warning Email is required for real accounts
Registration, the first login of an unverified account and password reset all send an email and fail when it cannot be sent. Without a working SMTP account only guest logins work.
:::

## Client configuration

These values are baked into the browser client when the gateway starts. `src/utility/transpiler.ts` replaces the `__VAR.NAME__` placeholders in `src/webserver/public/js/web/global.ts`, so a change needs a restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_ENABLED` | `true` | When `true` the client tries to reconnect by itself after an unexpected disconnect. |
| `GATEWAY_URL` | `http://localhost:9999` | Public URL of the gateway server, injected into the client. |
| `ASSET_SERVER_URL` | `http://localhost:8000` | Public URL of the asset server. The client loads icons, sprites and maps from it. See [Asset Server](#/assets/overview). |
| `GAME_WT_CERT_HASH` | empty | Pins the game server certificate. Empty fetches the hash from the game server, `off` disables pinning. See [TLS](#/gateway/tls/webtransport-certificate-pinning). |
| `PLAYER_Z_INDEX` | `4` | Draw order of the player relative to map layers. |
| `VERSION` | empty | Version string made available to the client. |

:::note Variables in the example file that the gateway does not read
`.env.example` also lists `ASSET_SERVER_AUTH_KEY`. No gateway code reads it: the key belongs to the game engine and the asset server. The older names `WEBSRV_USESSL` and `GATEWAY_USESSL` found in the repository README are not read either. `HTTP_USE_SSL` is the one switch.
:::

## config.json

The repository root holds a `config.json` with a `gateway` block (`port`, `heartbeatInterval`, `serverTimeout`, `sessionTimeout`, `authKey`, `enabled`, `url`).

```json title="config.json"
{
  "gateway": {
    "port": 9999,
    "heartbeatInterval": 30000,
    "serverTimeout": 90000,
    "sessionTimeout": 300000,
    "authKey": "change-me",
    "enabled": true,
    "url": "http://127.0.0.1:9999"
  }
}
```

:::note This file is not loaded
Nothing under `src/` imports `config.json`. The gateway server takes the same settings from `GATEWAY_PORT`, `HEARTBEAT_INTERVAL`, `SERVER_TIMEOUT`, `SESSION_TIMEOUT` and `GATEWAY_AUTH_KEY`. Change the environment file, not this one.
:::

## Scripts

| Script | What it does |
| --- | --- |
| `bun development` | Loads `.env.development` and runs `src/start.ts`. |
| `bun production` | Loads `.env.production` and runs `src/start.ts`. |
| `bun setup-development` | Runs `src/utility/database_setup.ts` with `.env.development`. |
| `bun setup` | Runs `src/utility/database_setup.ts` with `.env.production`. |
| `bun docker:dev` | Starts `src/docker/docker-compose.dev.yml` in the background. |
| `bun docker:dev:rebuild` | The same, forcing a rebuild and recreate. |
| `bun docker:dev:down` | Stops the development containers. |
| `bun docker:dev:logs` | Follows the development container logs. |
| `bun docker:prod` | Starts `src/docker/docker-compose.prod.yml` in the background. |
| `bun docker:prod:rebuild` | The same, forcing a rebuild and recreate. |
| `bun docker:prod:down` | Stops the production containers. |
| `bun docker:prod:logs` | Follows the production container logs. |

Two checks are not package.json scripts but are run by the pre-commit hook, in this order:

```bash title="Checks"
bun eslint
bun run --bun tsc --noEmit
```

The setup script creates the database if it is missing, creates the `allowed_ips` and `blocked_ips` tables, whitelists `127.0.0.1` and `::1`, and adds the two-factor columns to `accounts` (`totp_secret`, `totp_enabled`, `webauthn_credentials`, `webauthn_enabled`, `twofa_pending`, `pending_email`, `require_webauthn`, `require_totp`, `require_email_2fa`, `email_verified`).

:::warning Run the gateway setup again after the engine setup
The two-factor columns are added with `ALTER TABLE accounts`. The `accounts` table itself is created by the game engine's setup. If it does not exist yet, each column is skipped with only a debug log line. Running the gateway setup once more after the engine setup is safe: existing columns are skipped the same way.
:::

For containers, see [Docker](#/getting-started/docker). For a full walk through, see [Quick Start](#/getting-started/quick-start) and [Production](#/getting-started/production).
