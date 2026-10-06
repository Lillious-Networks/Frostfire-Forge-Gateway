---
title: Overview
description: What the asset server stores and serves, how assets are loaded and cached, and how map edits are saved back to disk.
order: 10
---

The asset server is the file store of a Frostfire Forge game. It reads a folder of maps, tilesets, sprites, icons and audio at startup, serves them to browsers over HTTP, hands maps to the game engine, and writes map editor changes back to disk. This page explains what it holds and how it works.

## What it serves

| Asset | Source folder | Served by | Used for |
| --- | --- | --- | --- |
| Maps | `maps/*.json` | `/map-chunk`, `/map-checksums` | Tile maps in Tiled JSON format, sent to the client in chunks and to the engine whole. |
| Worlds | `maps/<id>.world/` | `/map-chunk`, `/world-list`, `/world-file` | Maps too large for one file. See [World maps](#/assets/world-maps). |
| World map images | Baked at startup | `/worldmap` | The full map view in the game. |
| Tilesets | `tilesets/` | `/tileset` | Tileset images and Tiled tileset definitions. |
| Sprite sheets and animation templates | `spritesheets/`, `animations/` | `/sprite-sheet-image`, `/sprite-sheet-template`, `/sprite-sheets` | Players, armor, mounts and NPCs. |
| Sprites | `sprites/` | `/sprite`, `/sprites` | Spell and particle images. |
| Icons | `icons/` | `/icon`, `/icons` | Item, equipment and spell icons. |
| Audio | `audio/` | `/audio`, `/audios` | Music and sound effects. |

The folder layout is described in [Asset paths](#/assets/asset-paths) and every endpoint in [Integration](#/assets/integration).

:::note What is not here
Game data such as items, spells, quests, NPCs, creatures and particle definitions lives in the engine's database, not on the asset server. The asset server only holds files.
:::

## How it runs

The server is a single Bun process, `src/index.ts`:

```bash title="In Frostfire-Forge-Assets"
bun development     # uses .env.development
bun production      # uses .env.production
```

It has no database and no build step. On start it resolves the assets folder, loads everything, then begins answering requests. The variables it reads are listed in [Configuration](#/assets/configuration).

## Loading at startup

Assets are loaded once, in this order:

1. Tilesets
2. Animation templates and sprite sheets
3. Sprites
4. Icons
5. Audio
6. Maps, then worlds
7. World map images

What happens when something is missing:

| Folder | If it is missing |
| --- | --- |
| `tilesets/` | Startup fails. |
| `maps/` | Startup fails. It also fails when the folder holds no `.json` map. |
| `animations/` or `spritesheets/` | A warning is logged and no sprite sheets are loaded. Both folders are needed. |
| `sprites/`, `icons/`, `audio/` | A warning is logged and that list is empty. |

:::warning Restart to pick up new files
Files are read at startup only. There is no file watcher and no reload endpoint, so a new sprite, icon, tileset or audio file appears after the next restart. Maps are the exception: they change through the save endpoints while the server runs.
:::

## The in-memory cache

Everything that was loaded is kept in a cache and served from there. No request reads an asset file from disk, with one exception: the tiles of a world.

| Cache key | Contents |
| --- | --- |
| `tilesets` | Each file gzipped and base64 encoded, with a content hash used as its version. |
| `spriteSheetTemplates` | One entry per sprite sheet: name, slot, the animation template JSON and the PNG image. |
| `sprites`, `icons` | Each PNG, compressed. |
| `audio` | Each audio file, compressed. |
| `maps` | Each map: parsed data, a gzipped copy and a SHA-256 checksum. |
| `worldmaps` | One PNG per map and per world. |

The cache is in memory by default. `CACHE=redis` switches it to Bun's Redis client.

Worlds are handled differently. Only a world's manifest and the index of each pack file that has been touched stay in memory. Tiles are read from the pack files chunk by chunk when a client asks for them.

## How responses are cached

The server sets caching headers per asset type, so browsers do not download the same data twice:

| Endpoint | Caching behaviour |
| --- | --- |
| `/tileset` | `Cache-Control: no-cache` with an `ETag` (the file's content hash). The browser revalidates on every load and gets a 304 when nothing changed. |
| `/sprite`, `/icon` | `public, max-age=31536000`. |
| The fallback icon | `public, max-age=300`. Sent when a sprite or icon does not exist, with the header `X-Asset-Fallback: missing_icon`. |
| `/audio` | `public, max-age=31536000, immutable`, with an `ETag` and support for `Range` requests so players can seek. |
| `/worldmap` | `public, max-age=0, must-revalidate` with an `ETag`. |
| `/map-chunk` | Gzipped. Each built chunk is kept in a server side cache of up to 10000 entries, keyed by map, map checksum, chunk position and chunk size. |

:::tip Replacing an image under the same name
Sprites and icons are cached by browsers for a year. If you replace one without renaming it, players keep the old image until their cache is cleared. Give changed sprites and icons a new file name. Tilesets do not have this problem because they are revalidated.
:::

## Maps and checksums

Each `.json` map in the `maps` folder is parsed at startup. Maps saved by Tiled in "infinite" mode are flattened into ordinary fixed size layers on load, so the rest of the system only ever sees flat layers.

The SHA-256 checksum of the map's JSON identifies its version. The engine sends its own checksums to `/map-checksums` when it starts and receives every map that differs. See [Integration](#/assets/integration/sync-on-startup).

The client never downloads a whole map. It asks for chunks:

```bash title="One chunk of a map"
curl --compressed "http://localhost:8000/map-chunk?map=overworld&x=0&y=0&size=32"
```

```json title="Response"
{
  "chunkX": 0,
  "chunkY": 0,
  "width": 32,
  "height": 32,
  "layers": [
    { "name": "Ground", "zIndex": 0, "data": [1, 1, 2], "width": 32, "height": 32 }
  ]
}
```

`data` holds `width * height` tile ids per layer (shortened above). Only tile layers are included. Tiles outside the map are 0.

## Map data persistence

Edits made in the [map editor](#/tools/map-editor) reach the asset server through the engine and are saved in two steps: the cache is updated first, then the file.

| Endpoint | What is saved | On disk |
| --- | --- | --- |
| `POST /save-map-chunks` | The edited chunks are merged into the map's layers. Infinite maps grow to fit the edit and are trimmed back to their content. | `maps/<name>.json` is rewritten as minified JSON. |
| `POST /save-map-properties` | Graveyards and warps. They are stored on the map and mirrored into its `Graveyards` and `Warps` object layers. | `maps/<name>.json` is rewritten as formatted JSON. |
| `POST /update-map` | The whole map is replaced. | Nothing. The change lives in the cache only and is lost on restart. |

After each save the map gets a new checksum and its cached chunks are dropped, so the next `/map-chunk` request returns the new tiles.

:::warning A failed disk write is only a warning
If the map file cannot be written, the server logs a warning and still answers with success, because the cache was updated. Watch the log for `Failed to persist map to disk`, otherwise the edit disappears at the next restart.
:::

Worlds are saved differently: only the pack files that contain the edited chunks are rewritten. See [World maps](#/assets/world-maps/saving-edits).

## World map images

For every map and world the server bakes an overview image at startup, coloured with the average colour of each tile. Layers whose name contains `collision`, `nopvp` or `no-pvp` are left out. The game shows these images in its full map view.

- Images of ordinary maps are baked in memory on every start, at one pixel per tile.
- Images of worlds are baked at a reduced scale (several tiles per pixel for a large world). A bake takes seconds, so the result is kept between starts in the system temp folder under `frostfire-forge-assets/worldmaps`. Nothing is written to the assets folder.
- A file named `maps/<map>.worldmap.png` is used only for a map that has no baked image.

## Logs

The server writes its log to the console and to a file per day in `src/logs`. Set the detail with `LOG_LEVEL`.

## Related pages

- [Configuration](#/assets/configuration): every environment variable.
- [Asset paths](#/assets/asset-paths): the folder layout and how to keep assets outside the repository.
- [World maps](#/assets/world-maps): the `.world` format.
- [Integration](#/assets/integration): the HTTP API and how the engine and the editors use it.
