---
title: Introduction
description: What Frostfire Forge is, what it can do, and the three servers that make it up.
order: 10
---

Frostfire Forge is a 2D MMO engine platform written in TypeScript and run on [Bun](https://bun.sh). This page explains what you get, which servers you have to run, and where to go next.

## What Frostfire Forge is

A running Frostfire Forge game is three separate servers that work together:

| Server | Repository | What it does |
| --- | --- | --- |
| Game engine | `Frostfire-Forge` | Runs the game world. Players connect to it over WebTransport. It owns the game loop, combat, quests, the database of game data, and the plugin system. |
| Gateway | `Frostfire-Forge-Gateway` | Serves the website and the browser game client, handles accounts and login, lists the available realms, and issues the connection tokens that let a logged in player join a game server. |
| Asset server | `Frostfire-Forge-Assets` | Stores and serves maps, large worlds, tilesets, sprites, icons and audio. It also saves the changes made in the map editor. |

None of them runs alone. The engine registers itself with the gateway and syncs its maps from the asset server, and the browser client talks to all three.

:::note Beta software
The project is a work in progress. Expect configuration and file formats to change between versions.
:::

## Feature set

### Engine

- **WebTransport networking** over HTTP/3 (QUIC), with unreliable datagrams for movement and a reliable stream for everything else. See [Networking](#/engine/networking).
- **Area of interest and layers**: players only receive updates about nearby entities, and busy maps are split into layers. See [AOI and layers](#/engine/aoi-and-layers).
- **Game loop and worker pools** for movement, database queries and authentication. See [Game loop](#/engine/game-loop) and [Database](#/engine/database).
- **In-memory caches**, optionally backed by Redis. See [Caching](#/engine/caching).
- **Data driven gameplay**: [spells](#/engine/spells), [quests](#/engine/quests), items, loot tables, creatures with AI and pathfinding, NPCs, mounts, particles and [weather](#/engine/weather).
- **Social systems**: parties, guilds, friends, chat and currency.
- **Large worlds** of up to 10240 x 10240 tiles, loaded as `.world` directories. See [World maps](#/engine/world-maps).
- **Plugins** that add packets, HTTP routes, spells and event listeners without touching engine code. See [Plugins](#/engine/plugins), [Engine API](#/engine/engine-api) and [Listener events](#/engine/listener-events).
- **Admin tooling**: [admin commands](#/engine/admin-commands), a [permission system](#/engine/permissions) and a per realm [whitelist](#/engine/realm-whitelist).
- **Load testing** tools for connections and simulated players. See [Benchmarking](#/engine/benchmarking).

### Gateway

- Account registration, login, password reset and email verification.
- Two-factor login with authenticator apps, passkeys and email codes. See [Authentication](#/gateway/authentication).
- Optional guest accounts.
- Realm selection and game server registration with heartbeats. See [Game servers](#/gateway/game-servers).
- A reverse proxy that terminates TLS and filters requests before they reach the webserver. See [Reverse proxy](#/gateway/reverse-proxy).
- A monitoring [dashboard](#/gateway/dashboard).

### Asset server

- Loads every asset into memory at startup and serves it over HTTP.
- Serves maps in chunks, so the client only downloads what is near the player.
- Stores large worlds on disk in packs and reads them chunk by chunk.
- Persists map editor saves back to disk.

See the [asset server overview](#/assets/overview).

### Live editors

The game client ships with in-game tools for people with the right permissions: a [control panel](#/tools/control-panel), a [map editor](#/tools/map-editor), and editors for [spells](#/tools/spell-editor), [weather](#/tools/weather-editor), [players](#/tools/player-editor), [quests](#/tools/quest-editor), [NPCs](#/tools/npc-editor), [creatures](#/tools/creature-editor), [items](#/tools/item-editor), [loot](#/tools/loot-editor), [particles](#/tools/particle-editor) and [animations](#/tools/animator). Start at the [tools overview](#/tools/overview).

## The three servers at a glance

```text title="Who talks to whom"
                 +--------------------+
                 |  Browser client    |
                 |  (Chromium based)  |
                 +--+------+-------+--+
        HTTP(S)     |      |       |     HTTP(S)
   pages, login,    |      |       |   tilesets, map chunks,
   realm list       |      |       |   sprites, icons, audio
                    v      |       v
          +-----------+    |    +--------------+
          |  Gateway  |    |    | Asset server |
          +-----------+    |    +--------------+
                ^          |           ^
   register,    |          | WebTransport        map and world sync,
   heartbeat    |          | (HTTP/3, UDP)       editor saves
                |          v           |
              +-------------------------+
              |       Game engine       |
              +-------------------------+
                          |
                     MySQL / SQLite
```

The gateway and the engine share one database. The asset server has no database: its data is the files in its assets folder.

## Where to go next

1. Read [Architecture](#/getting-started/architecture) to see how the servers connect, which ports they use, and what happens when a player logs in.
2. Check [Requirements](#/getting-started/requirements) for the runtime, database and browser you need.
3. Follow the [Quick start](#/getting-started/quick-start) to run all three servers on your own machine.
4. When you are ready to host a game, read [Production](#/getting-started/production) or [Docker](#/getting-started/docker).

If you only want to play, the [player guide](#/player-guide/getting-started) is the place to start.
