---
title: Docker
description: Run the asset server, the gateway and the game engine in containers with the Dockerfiles, compose files and scripts that ship in each repository.
order: 60
---

All three repositories ship Docker files in `src/docker` and matching `bun` scripts in `package.json`. This page explains what each compose file starts, how to run the three together, and what to change in the environment files so the containers can find each other.

## What ships in each repository

Every repository has the same four files:

```text title="src/docker/"
Dockerfile.dev             development image, runs the development script
Dockerfile.prod            production image, installs production dependencies only
docker-compose.dev.yml     bridge network, published ports
docker-compose.prod.yml    host networking
```

All images build on `oven/bun:canary-slim` and declare a health check that requests `/status`.

| Repository | Development container | Production container | What the container runs |
| --- | --- | --- | --- |
| `Frostfire-Forge-Assets` | `frostfire-assets-dev` | `frostfire-assets-prod` | `bun run development` or `bun run production` |
| `Frostfire-Forge-Gateway` | `frostfire-gateway-dev`, plus `frostfire-mysql-dev` | `frostfire-gateway-prod` | The database setup, then the server |
| `Frostfire-Forge` | `frostfire-forge-dev` | `frostfire-forge-prod` | Config generation, the database setup, then the server |

## Scripts

The scripts are the same in the three repositories, with small differences noted below.

:::tabs
```bash title="Development"
bun run docker:dev            # build if needed and start in the background
bun run docker:dev:logs       # follow the logs
bun run docker:dev:rebuild    # rebuild the image and recreate the container
bun run docker:dev:down       # stop and remove
```
```bash title="Production"
bun run docker:prod
bun run docker:prod:logs
bun run docker:prod:rebuild
bun run docker:prod:down
```
:::

- The asset server and the engine also have `docker:dev:build` and `docker:prod:build`, which build without starting.
- The asset server's scripts pass `--env-file=.env.development` or `--env-file=.env.production` to Compose, because its compose files read `ASSETS_PATH` from there.
- The gateway's `docker:prod:down` and `docker:prod:logs` call the older `docker-compose` binary instead of `docker compose`. If you only have the Compose plugin, run the command by hand:

```bash title="Gateway, production, with the Compose plugin"
docker compose -f src/docker/docker-compose.prod.yml logs -f
docker compose -f src/docker/docker-compose.prod.yml down
```

## Development compose files

### Asset server

```yaml title="Frostfire-Forge-Assets/src/docker/docker-compose.dev.yml (summary)"
services:
  frostfire-assets-dev:
    env_file: ../../.env.development
    ports:
      - "8000:8000"
    volumes:
      - ${ASSETS_PATH}:/app/assets
    environment:
      - ASSETS_PATH=/app/assets
    networks:
      - frostfire-network-dev
```

The assets folder on the host is mounted at `/app/assets`, and `ASSETS_PATH` is overridden inside the container to point there. How the host path is resolved is explained in [Asset paths](#/assets/asset-paths).

:::note The published port is fixed at 8000
The compose file maps `8000:8000`, so keep `WEBSRV_PORT=8000` in `.env.development` when you use it.
:::

### Gateway

The gateway's development file starts two services:

| Service | Image | Ports | Notes |
| --- | --- | --- | --- |
| `mysql-dev` | `mysql:9.0` | `127.0.0.1:3307` to 3306 in the container | Database and root password are set in the compose file. Data lives in the `mysql-data-dev` volume. |
| `gateway-dev` | Built from `Dockerfile.dev` | 80, 443 (TCP and UDP), 9999, 9443 (TCP and UDP) | Waits for MySQL to be healthy. `DATABASE_HOST` and `DATABASE_PORT` are overridden to `mysql-dev` and `3306`. |

The container runs `bun setup-development` and then `bun run development` every time it starts, so the gateway's tables are always up to date.

### Engine

```yaml title="Frostfire-Forge/src/docker/docker-compose.dev.yml (summary)"
services:
  frostfire-forge-dev:
    env_file: ../../.env.development
    ports:
      - "3000:3000"
      - "3000:3000/udp"
    volumes:
      - ../../src/certs:/app/src/certs
      - ../../src/logs:/app/src/logs
      - ../../src/config:/app/src/config
    ulimits:
      nofile: { soft: 1048576, hard: 1048576 }
    networks:
      - frostfire-network-dev
```

The container generates the config files, runs the MySQL setup script with `.env.development`, then starts the server. Certificates, logs and config are kept on the host through the three volumes, so the generated WebTransport certificate and `settings.json` survive a rebuild.

:::warning Publish UDP as well as TCP
The engine's game traffic is WebTransport over UDP. The compose file publishes `3000/udp`; keep that line if you change the port.
:::

## Running the three together in development

Each development compose file declares a bridge network called `frostfire-network-dev`. Compose prefixes network names with the project name, so the three stacks only share a network when they run under the **same project name**. The engine's own release workflow does exactly that by passing `-p` to every command.

Start them in the usual order: asset server, gateway (with MySQL), engine.

```bash title="From a folder that contains the three repositories"
docker compose -p frostfire \
  -f Frostfire-Forge-Assets/src/docker/docker-compose.dev.yml \
  --env-file Frostfire-Forge-Assets/.env.development up -d

docker compose -p frostfire \
  -f Frostfire-Forge-Gateway/src/docker/docker-compose.dev.yml up -d

docker compose -p frostfire \
  -f Frostfire-Forge/src/docker/docker-compose.dev.yml \
  --env-file Frostfire-Forge/.env.development up -d
```

:::note About the bun scripts
The `docker:dev` scripts do not pass a project name. Compose then derives it from the folder that holds the compose file, which is `docker` in all three repositories, so the stacks end up in one project as well. Passing `-p` yourself makes that explicit.
:::

### Addresses inside and outside the containers

Inside the shared network a container reaches another one by its container name. `localhost` inside a container is the container itself, so the server to server addresses in the environment files have to change. The player's browser, on the other hand, runs on the host and uses the published ports.

```env title="Frostfire-Forge/.env.development, for the compose setup"
# Database: the MySQL service from the gateway compose file
DATABASE_HOST=frostfire-mysql-dev
DATABASE_PORT=3306

# Server to server
GATEWAY_URL=http://frostfire-gateway-dev:9999
ASSET_SERVER_INTERNAL_URL=http://frostfire-assets-dev:8000

# Sent to the browser
ASSET_SERVER_URL=http://localhost:8000
SERVER_HOST=localhost
PUBLIC_HOST=localhost
CORS_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
```

```env title="Frostfire-Forge-Gateway/.env.development, for the compose setup"
# Built into the browser client at startup
ASSET_SERVER_URL=http://localhost:8000
DOMAIN=http://localhost
```

The database name, user and password in the engine's file must match the MySQL service in the gateway's compose file, and the three shared keys must match as described in the [Quick start](#/getting-started/quick-start).

:::warning The two-factor columns
On a fresh database the gateway container runs its setup before the engine has created the `accounts` table, so the gateway's two-factor columns are skipped. Restart the gateway container once after the engine's first start: its setup runs again and adds them.
:::

```bash title="Restart the gateway once after the first engine start"
docker restart frostfire-gateway-dev
```

Then open `http://localhost` in a Chromium based browser.

## Production compose files

All three production files use `network_mode: "host"`: the containers bind the host's ports directly, no ports are published, and the servers reach each other exactly as they would without Docker. Host networking is built for Linux hosts, so plan production containers for Linux.

| Repository | Environment | Volumes |
| --- | --- | --- |
| Asset server | `.env.production` | `${ASSETS_PATH}` to `/app/assets`, and `src/certs` to `/app/src/certs` (read only) |
| Gateway | `.env.production` | `src/certs` to `/app/src/certs` (read only), `src/logs` to `/app/logs`, `config` to `/app/config` |
| Engine | `.env.production` | `src/certs`, `src/logs` and `src/config` to the same paths under `/app` |

The engine's production file also raises the open file limit to 1048576.

What each production container runs on start:

| Repository | Command |
| --- | --- |
| Asset server | `bun run production` |
| Gateway | `bun setup && bun run production` |
| Engine | `bun setup-production && bun run production` |

Write the `.env.production` files and place the certificates as described in [Production](#/getting-started/production), then start the stacks in order:

```bash title="Production start"
# In Frostfire-Forge-Assets
bun run docker:prod

# In Frostfire-Forge-Gateway
bun run docker:prod

# In Frostfire-Forge
bun run docker:prod
```

As in development, restart the gateway container once after the engine has created its tables for the first time.

## Published images

Each repository's release workflow builds its **development** image and pushes it to the GitHub container registry.

| Server | Image name used by the workflow |
| --- | --- |
| Engine | `ghcr.io/lillious-networks/frostfire-forge-dev:latest` |
| Gateway | `ghcr.io/lillious-networks/frostfire-forge-gateway:latest` |
| Asset server | `ghcr.io/lillious-networks/frostfire-forge-assets:latest` |

The asset server image can run on its own, with the assets that are baked into it. This is the command its workflow uses to test the image. Run it from the asset server repository so that `.env.development` is found:

```bash title="Asset server from the published image"
docker run -d --name frostfire-assets \
  --env-file=.env.development \
  -e ASSETS_PATH=/app/src/assets \
  -p 8000:8000 \
  ghcr.io/lillious-networks/frostfire-forge-assets:latest
```

The gateway and the engine images need a database and each other, so use the compose files for those.

## Useful commands

```bash title="Inspect a running stack"
docker ps --filter "name=frostfire"
docker logs -f frostfire-forge-dev
docker network ls --filter "name=frostfire-network-dev"
```
