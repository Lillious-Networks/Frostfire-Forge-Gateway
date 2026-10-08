---
title: Quick Start
description: Set up the asset server, the gateway and the game engine on one machine for local development, in the right order, with every command.
order: 40
---

This page takes you from three empty folders to a running game on `http://localhost`. It covers a local development setup from source with MySQL. For containers see [Docker](#/getting-started/docker), and for a real deployment see [Production](#/getting-started/production).

Check the [Requirements](#/getting-started/requirements) first: you need Bun, MySQL and a Chromium based browser.

## 1. Get the code

Clone the three repositories next to each other and install their dependencies.

```bash title="Clone and install"
git clone https://github.com/Lillious-Networks/Frostfire-Forge-Assets.git
git clone https://github.com/Lillious-Networks/Frostfire-Forge-Gateway.git
git clone https://github.com/Lillious-Networks/Frostfire-Forge.git

cd Frostfire-Forge-Assets && bun install && cd ..
cd Frostfire-Forge-Gateway && bun install && cd ..
cd Frostfire-Forge && bun install && cd ..
```

## 2. Choose three shared secrets

The servers authenticate each other with three values. Generate them once and reuse them in the steps below.

```bash title="Generate a random value (run it three times)"
bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Value | Set on | Purpose |
| --- | --- | --- |
| `GATEWAY_AUTH_KEY` | Gateway and engine | Lets the engine register with the gateway. |
| `GATEWAY_GAME_SERVER_SECRET` | Gateway and engine | Signs the connection token a player presents to the engine. |
| `ASSET_SERVER_AUTH_KEY` | Asset server and engine | Lets the engine sync maps and save editor changes. |

:::warning Do not reuse the values that ship in the repositories
Each repository has a development environment file checked in. Replace the keys in it with your own before you expose anything beyond your own machine.
:::

## 3. Prepare the database

The gateway and the engine share one MySQL database. Use a server you already have, or start the one defined in the gateway's development compose file.

:::tabs
```sql title="Existing MySQL server"
CREATE DATABASE frostfire_forge_development;
CREATE USER 'frostfire'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON frostfire_forge_development.* TO 'frostfire'@'localhost';
FLUSH PRIVILEGES;
```
```bash title="MySQL from the gateway compose file"
# Run in the Frostfire-Forge-Gateway folder.
# Starts only the database service: MySQL 9.0 on 127.0.0.1:3307.
# The root password and database name are set in the compose file.
docker compose -f src/docker/docker-compose.dev.yml up -d mysql-dev
```
:::

Both setup scripts also run `CREATE DATABASE IF NOT EXISTS`, so a user that is allowed to create databases does not need the first statement.

## 4. Asset server

Edit `.env.development` in `Frostfire-Forge-Assets`:

```env title="Frostfire-Forge-Assets/.env.development"
ASSETS_PATH=./src/assets

WEBSRV_PORT=8000
WEBSRV_PORTSSL=8082
WEBSRV_INTERNAL_PORT=8083
HTTP_USE_SSL=false

TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

ASSET_SERVER_AUTH_KEY=change-me-asset-key
```

:::warning Fix ASSETS_PATH before the first start
The file in the repository sets `ASSETS_PATH=../../src/assets`. That value is written for Docker Compose. When you run from source, a relative path is resolved from the project folder, so it points outside the repository and the server exits with `Assets directory not found`. Use `./src/assets`, or remove the line to use the default. See [Asset paths](#/assets/asset-paths).
:::

Start it:

```bash title="In Frostfire-Forge-Assets"
bun development
```

```bash title="Check"
curl http://localhost:8000/status
# {"status":"OK"}
```

## 5. Gateway

Edit `.env.development` in `Frostfire-Forge-Gateway`. The values that matter for a first run:

```env title="Frostfire-Forge-Gateway/.env.development"
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=frostfire_forge_development
DATABASE_USER=frostfire
DATABASE_PASSWORD=change-me
SQL_SSL_MODE=DISABLED

WEBSRV_PORT=80
WEBSRV_PORTSSL=443
WEBSRV_INTERNAL_PORT=8080
HTTP_USE_SSL=false

GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
GATEWAY_INTERNAL_PORT=9998
GATEWAY_AUTH_KEY=change-me-gateway-key
GATEWAY_GAME_SERVER_SECRET=change-me-shared-secret

DOMAIN=http://localhost
GAME_NAME=Frostfire Forge Development
LOG_LEVEL=debug

ASSET_SERVER_URL=http://localhost:8000
GUEST_MODE_ENABLED=true
PLAYER_Z_INDEX=4
```

Use `DATABASE_PORT=3307` if you started MySQL from the compose file. Every variable is explained in [gateway configuration](#/gateway/configuration).

Create the gateway's tables, then start it:

```bash title="In Frostfire-Forge-Gateway"
bun setup-development
bun development
```

`bun development` transpiles the browser client and then starts the reverse proxy, the webserver and the gateway server.

```bash title="Check"
curl http://localhost:9999/status
# {"totalServers":0,"servers":[], ...}
```

:::note Port 80
The reverse proxy binds port 80. If your system does not let you bind it, or something else is using it, change `WEBSRV_PORT`, and use the same port in `DOMAIN` and in the engine's `CORS_ALLOWED_ORIGINS`.
:::

## 6. Game engine

Edit `.env.development` in `Frostfire-Forge`. The database settings must point at the **same database** as the gateway.

```env title="Frostfire-Forge/.env.development"
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=frostfire_forge_development
DATABASE_USER=frostfire
DATABASE_PASSWORD=change-me
SQL_SSL_MODE=DISABLED

WEBSRV_PORT=3000
WEBSRV_PORTSSL=3000
WEBSRV_INTERNAL_PORT=3002
HTTP_USE_SSL=false
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle

GAME_NAME=Frostfire Forge
LOG_LEVEL=debug
CORS_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1

SERVER_ID=server-1
SERVER_DESCRIPTION=Development Server
SERVER_HOST=localhost
PUBLIC_HOST=localhost
WHITELIST=false

GATEWAY_URL=http://localhost:9999
GATEWAY_AUTH_KEY=change-me-gateway-key
GATEWAY_GAME_SERVER_SECRET=change-me-shared-secret

ASSET_SERVER_URL=http://localhost:8000
ASSET_SERVER_AUTH_KEY=change-me-asset-key

CACHE=memory
```

Every variable is explained in [engine configuration](#/engine/configuration).

:::warning The engine refuses to start with an incomplete database block
`DATABASE_ENGINE`, `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` and `GAME_NAME` must all be set and not empty, including the password.
:::

Create the game tables and the demo data:

```bash title="In Frostfire-Forge"
bun --env-file=.env.development ./src/utility/database_setup.ts
```

The engine setup creates the `accounts` table. The gateway setup adds its two-factor columns to that table and skips them quietly when the table does not exist yet, so run it one more time now. It is safe to repeat.

```bash title="In Frostfire-Forge-Gateway"
bun setup-development
```

Now start the engine:

```bash title="In Frostfire-Forge"
bun development
```

`bun development` first runs `bun create-config --environment development`, which creates `src/config/settings.json`, `src/config/aoi.json` and `src/config/security.cfg` when they are missing, then starts the server.

On first start the engine also generates a local TLS certificate at `TLS_CERT_PATH` and `TLS_KEY_PATH`, because WebTransport needs one even on localhost.

```bash title="Check"
curl http://localhost:3000/status
# {"status":"ok"}

curl http://localhost:9999/status
# "totalServers":1 and a server with "id":"server-1" and "status":"online"
```

In the engine log you should see the map sync, `Successfully registered with gateway as server-1` and `WebTransport listening on UDP port 3000`.

## 7. Log in

The engine setup creates no accounts, so make your admin account first:

```bash title="In Frostfire-Forge-Gateway"
bun create-admin-development <username> <email>
```

The script creates a verified account with the admin role and the `admin.*`, `server.*` and `permission.*` permissions, then prints a one-time link. Open the link in a Chromium based browser and set the password. No mail server is needed for this.

Open `http://localhost`, log in, pick the realm, and you are in the game. The gateway's monitoring dashboard is at `http://localhost:9999/dashboard`, see [Dashboard](#/gateway/dashboard).

## Starting everything again later

Once set up, a normal session is three commands in three terminals, in this order:

```bash title="Daily start"
# Terminal 1, Frostfire-Forge-Assets
bun development

# Terminal 2, Frostfire-Forge-Gateway
bun development

# Terminal 3, Frostfire-Forge
bun development
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Asset server exits with `Assets directory not found` | `ASSETS_PATH` is relative and resolves outside the project. See step 4. |
| Engine logs `Gateway registration failed with status 401` | `GATEWAY_AUTH_KEY` differs between the gateway and the engine. |
| Engine keeps logging `Failed to connect to gateway. Retrying...` | The gateway is not running, or `GATEWAY_URL` is wrong. The engine keeps retrying. |
| Engine logs `Map sync request failed with status 401` | `ASSET_SERVER_AUTH_KEY` differs between the engine and the asset server. |
| The realm list is empty | The engine has not registered. Check `http://localhost:9999/status`. |
| The game page cannot connect and the browser reports a failed fetch of `/wt-cert-hash` | The page's origin is missing from the engine's `CORS_ALLOWED_ORIGINS`, or TCP 3000 is blocked. |
| The certificate hash loads but the connection fails | UDP 3000 is blocked, or you are not using a Chromium based browser. |
| You are in the game but the map does not load | The browser cannot reach `ASSET_SERVER_URL`. Restart the gateway after changing it: the value is built into the client at startup. |
| The gateway logs a database error about a missing `accounts` column | Run `bun setup-development` in the gateway again, after the engine setup. |

## Next steps

- Understand what you just started: [Architecture](#/getting-started/architecture).
- Tune the servers: [engine configuration](#/engine/configuration), [gateway configuration](#/gateway/configuration), [asset server configuration](#/assets/configuration).
- Give yourself permissions and try the tools: [Permissions](#/engine/permissions) and the [tools overview](#/tools/overview).
- Write your first plugin: [Plugins](#/engine/plugins).
