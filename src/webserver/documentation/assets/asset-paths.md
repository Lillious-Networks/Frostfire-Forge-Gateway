---
title: Asset Paths
description: How ASSETS_PATH is resolved, the layout of the assets folder, how to keep assets in an external or shared location, and how the folder is mounted in Docker.
order: 30
---

The asset server loads everything from one folder. This page explains how that folder is chosen with `ASSETS_PATH`, what has to be inside it, and how to point the server at assets that live outside the repository, including under Docker.

## How ASSETS_PATH is resolved

| `ASSETS_PATH` | Folder used |
| --- | --- |
| Not set | `src/assets` inside the asset server repository. |
| Absolute path | That path, as written. |
| Relative path | Resolved from the working directory, which is the repository root when you start the server with `bun development` or `bun production`. |

If the resulting folder does not exist, the server logs the path it tried and exits with code 1. The chosen folder is logged at startup:

```text title="Startup log"
Using external assets directory: /srv/game/assets
```

:::tabs
```env title="Default folder"
# Leave ASSETS_PATH out, or:
ASSETS_PATH=./src/assets
```
```env title="Absolute path (Linux)"
ASSETS_PATH=/srv/game/assets
```
```env title="Absolute path (Windows)"
ASSETS_PATH=C:/Games/my-game/assets
```
```env title="Relative path"
# A folder next to the repository
ASSETS_PATH=../my-game-assets
```
:::

:::warning The value in the repository is written for Docker
`.env.development` and `.env.example` ship with `ASSETS_PATH=../../src/assets`. That path is relative to the compose file in `src/docker` and is correct for Docker Compose. When you run from source it is resolved from the repository root instead, points two folders above it, and the server exits. Use `./src/assets` for a run from source.
:::

## Folder layout

```text title="The assets folder"
assets/
  tilesets/                 required
    environment.png           tileset images: .png .jpg .jpeg .webp
    environment.json          Tiled tileset definitions: .json
  maps/                     required, with at least one .json map
    overworld.json            Tiled maps
    continent.world/          large worlds, one folder each
    overworld.worldmap.png    optional hand made map image
  animations/               optional
    player_body_base.json     animation templates
  spritesheets/             optional, searched in all sub folders
    player/bodies/*.png
    player/heads/*.png
    armor/helmet/*.png
    armor/chestplate/*.png
    mounts/*.png
  sprites/                  optional
    frost_bolt.png            .png only, no sub folders
  icons/                    optional
    bronze_helmet.png         .png only, no sub folders
    missing_icon.png          fallback image
  audio/                    optional
    theme.mp3                 .mp3 .wav .ogg .oga .m4a .webm .flac .opus
```

`tilesets` and `maps` must exist, and `maps` must contain at least one `.json` file, or the server does not start. The other folders are optional: a missing one produces a warning and an empty list.

### Tilesets

Every `.json`, `.png`, `.jpg`, `.jpeg` and `.webp` file directly in `tilesets` is loaded and served by its file name, extension included:

```bash title="Fetch a tileset"
curl "http://localhost:8000/tileset?name=environment.png"
```

### Maps

- Every `.json` file in `maps` is loaded as a Tiled map and is known by its file name, for example `overworld.json`.
- Every sub folder whose name ends in `.world` is loaded as a large world. `continent.world` is served under the name `continent.json`. See [World maps](#/assets/world-maps).
- A world and a map must not share a name. If both `continent.json` and `continent.world` exist, the world is skipped and an error is logged.

### Animations and sprite sheets

The two folders work as a pair, and both must exist for sprite sheets to load.

- Each `.json` file in `animations` is an animation template. Its `imageSource` field names a PNG in `spritesheets`. The sprite sheet is known by the template's file name without `.json`.
- Every other PNG found anywhere under `spritesheets` is loaded as a sprite sheet named after the file, without `.png`.
- The folder a PNG sits in decides its slot and which shared template it uses:

| Folder | Slot | Template used |
| --- | --- | --- |
| `armor/helmet` | `helmet` | `armor_head_base` |
| `armor/shoulderguards` | `shoulderguards` | `armor_body_base` |
| `armor/chestplate` | `chest` | `armor_body_base` |
| `armor/gloves` | `hands` | `armor_body_base` |
| `armor/pants` | `legs` | `armor_body_base` |
| `armor/boots` | `feet` | `armor_body_base` |
| `armor/weapon` | `weapon` | `armor_body_base` |
| `armor/necklace` or `armor/neck` | `neck` | `armor_body_base` |
| `player/bodies` | `body` | None, unless a template in `animations` names the image |
| `player/heads` | `head` | None, unless a template in `animations` names the image |
| `mounts` | `mount` | `player_mount_base` |

A PNG in any other folder gets the slot `body` or `head` when its name contains that word, and `other` otherwise.

:::note Mount names get a prefix
A PNG in `mounts` is registered as `mount_<file name>`. `mounts/unicorn.png` is requested as `mount_unicorn`.
:::

### Sprites and icons

Only `.png` files directly in `sprites` and `icons` are loaded. Each is known by its file name without the extension. Requests may include `.png` or leave it out:

```bash title="Both forms work"
curl -o bolt.png "http://localhost:8000/sprite?name=frost_bolt"
curl -o helmet.png "http://localhost:8000/icon?name=bronze_helmet.png"
```

If the requested sprite or icon does not exist, the server answers with the icon named `missing_icon` and the header `X-Asset-Fallback: missing_icon`. Keep a `missing_icon.png` in `icons`, otherwise missing images are answered with 404.

### Audio

Audio files are served by name, with or without the extension, and the match ignores case:

```bash title="Fetch audio"
curl -o theme.mp3 "http://localhost:8000/audio?name=theme"
```

:::warning Names must be flat
Asset names in requests cannot contain `/`, `\` or `..`. Sub folders are only meaningful inside `spritesheets`, where they pick the slot. Everywhere else, put files directly in the folder.
:::

## External and shared assets

Keeping the game's assets outside the asset server repository lets you update the server code without touching your art, and lets several tools work on the same files.

```env title="Assets in their own folder"
ASSETS_PATH=/srv/game/assets
```

Things to know before you share the folder:

- **The server writes to it.** Map editor saves rewrite `maps/<name>.json`, and world saves rewrite files inside `maps/<id>.world/`. The process needs write access to `maps`. The other folders are only read.
- **One writer.** Each asset server keeps its maps in memory and writes them out on save. Two asset servers pointed at the same `maps` folder would overwrite each other's edits.
- **Restart after changing files by hand.** New or changed files are picked up at the next start. See [Overview](#/assets/overview/loading-at-startup).
- **The engine has its own copy of the maps.** It keeps them in its own `src/assets/maps` folder and updates them from the asset server at startup. Do not edit the engine's copy by hand: a map that differs from the asset server's version is overwritten at the next sync.

## Docker volume mapping

Both compose files mount the host's assets folder into the container at `/app/assets` and override `ASSETS_PATH` inside the container:

```yaml title="src/docker/docker-compose.dev.yml"
services:
  frostfire-assets-dev:
    env_file:
      - ../../.env.development
    volumes:
      - ${ASSETS_PATH}:/app/assets
    environment:
      - ASSETS_PATH=/app/assets
```

So under Docker, `ASSETS_PATH` in your environment file means **the folder on the host**, and Compose reads it when it builds the volume. That is why the `docker:` scripts pass the environment file to Compose itself:

```bash title="package.json scripts"
bun run docker:dev     # docker compose --env-file=.env.development -f src/docker/docker-compose.dev.yml up -d
bun run docker:prod    # docker compose --env-file=.env.production  -f src/docker/docker-compose.prod.yml up -d
```

How to write the host path:

:::tabs
```env title="Assets inside the repository"
# Relative to the compose file in src/docker
ASSETS_PATH=../../src/assets
```
```env title="External folder (Linux)"
ASSETS_PATH=/srv/game/assets
```
```env title="External folder (Windows)"
ASSETS_PATH=C:/Games/my-game/assets
```
:::

:::warning One value cannot serve both ways of running
`../../src/assets` is right for Compose and wrong for a run from source. `./src/assets` is right for a run from source and wrong for Compose. An absolute path works for both.
:::

The production compose file also mounts the certificates read only:

```yaml title="src/docker/docker-compose.prod.yml"
    volumes:
      - ${ASSETS_PATH}:/app/assets
      - ../../src/certs:/app/src/certs:ro
```

The mount must be writable, because map saves are written into it. More about running the containers is in [Docker](#/getting-started/docker).
