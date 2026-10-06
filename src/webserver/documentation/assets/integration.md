---
title: Integration
description: How the engine, the browser client and the editors talk to the asset server: the auth key, every HTTP endpoint, the sync on startup and editor saves.
order: 50
---

The asset server has one interface: HTTP. This page lists every endpoint with its method, parameters and purpose, explains which calls need the auth key, and walks through the two flows that matter most: the engine's sync on startup and a save from the map editor.

## Who calls the asset server

| Caller | What it does | Authenticated |
| --- | --- | --- |
| Browser client | Downloads tilesets, map chunks, map images, sprites, icons, sprite sheets and audio with `GET` requests. | No |
| Game engine | Syncs maps and worlds at startup, forwards editor saves, and fetches asset lists for the editors. | Yes, for sync and saves |
| Editors | The in-game editors run in the browser. They read images directly and save through the engine. | Through the engine |

The browser finds the asset server in two ways. The gateway builds its own `ASSET_SERVER_URL` into the client when it starts, and the engine sends its `ASSET_SERVER_URL` along with every map. Both must be an address the player's browser can reach.

## Addresses and the auth key

```env title="Engine environment"
# Sent to browsers, and used for the engine's own calls unless the next line is set
ASSET_SERVER_URL=https://assets.example.com:8443

# Optional: a private address for the engine's own calls
ASSET_SERVER_INTERNAL_URL=https://127.0.0.1:8083

# Must equal ASSET_SERVER_AUTH_KEY on the asset server
ASSET_SERVER_AUTH_KEY=change-me
```

The key is a shared secret. It is sent as the `authKey` field of the JSON body, not as a header:

```bash title="An authenticated request"
curl -X POST http://localhost:8000/world-list \
  -H "Content-Type: application/json" \
  -d '{"authKey":"change-me","serverId":"server-1"}'
```

A wrong or missing key is answered with:

```json title="401"
{ "error": "Invalid authentication key" }
```

- On the asset server the key is `ASSET_SERVER_AUTH_KEY`, with `GATEWAY_AUTH_KEY` as a fallback. The engine applies the same fallback when it sends the key.
- Every `POST` endpoint needs the key. No `GET` endpoint does: everything a `GET` returns is public.
- The key never reaches the browser. Editor saves travel from the browser to the engine over the game connection, and the engine adds the key.

:::danger Use HTTPS or a private address for authenticated calls
The key travels in the request body. Over plain HTTP on a public network it can be read in transit. Use TLS on the asset server, or point `ASSET_SERVER_INTERNAL_URL` at a loopback or private address.
:::

## Endpoints

### Public endpoints

| Method | Path | Parameters | Purpose |
| --- | --- | --- | --- |
| GET | `/status` | None | Health check. Returns `{"status":"OK"}`. |
| GET | `/tileset` | `name`: file name with extension | One tileset file as JSON: `{ "name", "data" }`, where `data` is the file gzipped and base64 encoded. Revalidated with an `ETag`. |
| GET | `/map-chunk` | `map`, `x`, `y`, `size` (default 25) | One chunk of a map or world as JSON. Gzipped when the client accepts it. |
| GET | `/worldmap` | `name`, optional `rx` and `ry` | The baked map image as PNG. With `rx` and `ry`, one full detail region of a world. |
| GET | `/sprite` | `name`: with or without `.png` | A sprite as PNG. Falls back to the `missing_icon` image. |
| GET | `/sprites` | None | Names of all sprites: `{ "sprites": [{ "name" }] }`. |
| GET | `/icon` | `name`: with or without `.png` | An icon as PNG. Falls back to the `missing_icon` image. |
| GET | `/icons` | None | Names of all icons: `{ "icons": [{ "name" }] }`. |
| GET | `/sprite-sheet-image` | `name` | The PNG of a sprite sheet. |
| GET | `/sprite-sheet-template` | `name` | The animation template JSON of a sprite sheet. |
| GET | `/sprite-sheets` | None | All sprite sheets: `{ "spriteSheets": [{ "name", "slot", "icon", "hasTemplate", "hasImage" }] }`. |
| GET, HEAD | `/audio` | `name`: with or without extension | An audio file. Supports `Range` requests and `ETag`. |
| GET | `/audios` | None | All audio files: `{ "audio": [{ "name", "mime" }] }`. |

### Authenticated endpoints

All of these take a JSON body that includes `authKey`.

| Method | Path | Body fields | Purpose |
| --- | --- | --- | --- |
| POST | `/map-checksums` | `checksums`, `serverId` | Map sync. Returns every map whose checksum differs from the one sent. |
| POST | `/world-list` | `serverId` | Lists the worlds with the hashes of their sync files. |
| POST | `/world-file` | `id`, `file` | Returns one sync file of a world as binary. |
| POST | `/save-map-chunks` | `mapName`, `chunks`, optional `bounds`, `serverId` | Saves edited chunks of a map or world to disk. |
| POST | `/save-map-properties` | `mapName`, optional `graveyards`, `warps` | Saves the graveyards and warps of a map or world to disk. |
| POST | `/update-map` | `mapName`, `mapData`, `serverId` | Replaces a whole map in the cache. Not written to disk. Refused for worlds. |

### General behaviour

- `OPTIONS` requests are answered with `204` and permissive CORS headers. Responses carry `Access-Control-Allow-Origin: *`.
- `HEAD` is answered by the `GET` handler of the same path.
- `CONNECT`, `TRACE` and `TRACK` are answered with `403`.
- Names passed in `name` cannot contain `/`, `\` or `..`. Such a request is rejected.
- There is no static file serving. A file that is in the assets folder but not reachable through an endpoint above cannot be downloaded.

## Sync on startup

The engine keeps its own copy of every map so that it can run collision, warps and spawns without asking the asset server during play. It refreshes that copy each time it starts, before it loads any map.

### Map sync

```json title="POST /map-checksums, request"
{
  "authKey": "change-me",
  "serverId": "server-1",
  "checksums": {
    "overworld.json": "<sha256>",
    "inside.json": "<sha256>"
  }
}
```

```json title="Response"
{
  "success": true,
  "outdatedMaps": [
    { "name": "overworld.json", "checksum": "<sha256>", "data": { "width": 100, "height": 100, "layers": [] } }
  ]
}
```

- The asset server compares each of its maps with the checksum the engine sent. A map the engine does not have, or has in a different version, is returned in full.
- The engine writes each returned map into its `src/assets/maps` folder, then loads its maps from there.
- The response can be several megabytes and is gzipped.
- An engine that sends an empty `checksums` object receives every map.

The sync runs twice: once before the maps are loaded, and once more after the engine has registered with the gateway. The second run retries up to 30 times with a growing delay if the asset server does not answer.

:::warning Start the asset server first
If the first sync fails, the engine logs a warning and loads whatever maps it already has. On a fresh install it has none, and it cannot start without at least one map.
:::

### World sync

Worlds are too large for `/map-checksums`, so they have their own two calls.

```json title="POST /world-list, response"
{
  "success": true,
  "worlds": [
    {
      "id": "continent",
      "name": "continent.json",
      "files": {
        "manifest.json": "<sha256>",
        "collision.bits": "<sha256>",
        "nopvp.bits": "<sha256>"
      }
    }
  ]
}
```

For every file whose hash differs from the engine's local copy:

```json title="POST /world-file, request"
{ "authKey": "change-me", "id": "continent", "file": "collision.bits" }
```

The answer is the raw file with the content type `application/octet-stream`, gzipped when the client accepts it. Only `manifest.json`, `collision.bits` and `nopvp.bits` can be requested. Any other file name is answered with `400 Unknown world file`, and the pack files are never sent.

The engine never deletes a local world, and it skips the world sync quietly when the asset server has no worlds or cannot be reached. The format of these files is described in [World maps](#/assets/world-maps).

## What the browser downloads

Once a player is in the game, the client loads what it needs directly from the asset server:

| Moment | Requests |
| --- | --- |
| Entering a map | `/tileset?name=...` for each tileset image of the map. |
| Moving around | `/map-chunk?map=...&x=...&y=...&size=...` for the chunks near the player. |
| Opening the full map | `/worldmap?name=...`, and `/worldmap?name=...&rx=...&ry=...` when zooming into a world. |
| Drawing characters | `/sprite-sheet-template?name=...` and `/sprite-sheet-image?name=...` for bodies, heads, armor and mounts. |
| Drawing items and spells | `/icon?name=...` and `/sprite?name=...`. |
| Music and sound | `/audio?name=...`. |

The engine builds many of these URLs itself from its `ASSET_SERVER_URL` and sends them to the client with the data they belong to, for example the icon of an item or the sprite sheets of a player.

## Editor saves

### The map editor

A save in the [map editor](#/tools/map-editor) takes this path:

```text title="Map editor save"
Browser (map editor)
   |  SAVE_MAP packet over the game connection
   v
Game engine
   |  checks the player's permission: server.admin or server.*
   |  POST /save-map-chunks        (edited chunks)
   |  POST /save-map-properties    (graveyards and warps, when present)
   v
Asset server
   |  updates its cache, writes the map file or the world's packs
   v
Game engine
      applies the new collision data, updates warps and graveyards
```

```json title="POST /save-map-chunks, request"
{
  "authKey": "change-me",
  "serverId": "server-1",
  "mapName": "overworld",
  "chunks": [
    {
      "chunkX": 3,
      "chunkY": 5,
      "width": 32,
      "height": 32,
      "layers": [
        { "name": "Ground", "data": [1, 1, 2] }
      ]
    }
  ],
  "bounds": null
}
```

`data` holds `width * height` tile ids (shortened above). `mapName` may be given with or without `.json`. `bounds` is only used for infinite maps: it tells the server how far the editor grew the map.

```json title="Response"
{
  "success": true,
  "checksum": "<sha256>",
  "message": "Saved 1 chunk(s) for map overworld"
}
```

| Status | Meaning |
| --- | --- |
| 200 | Saved. The new checksum is returned. For a world, `changed` lists the chunks that differ from what was on disk. |
| 400 | `mapName` or `chunks` is missing, or a world rejected the chunks (outside the world, wrong chunk size, invalid tile). |
| 401 | Wrong auth key. |
| 404 | No map with that name. |
| 500 | The save failed. |

```json title="POST /save-map-properties, request"
{
  "authKey": "change-me",
  "mapName": "overworld",
  "graveyards": [
    { "name": "Town", "position": { "x": 320, "y": 480 } }
  ],
  "warps": [
    {
      "name": "Cave entrance",
      "map": "cave",
      "x": 64,
      "y": 96,
      "position": { "x": 1200, "y": 800 },
      "size": { "width": 32, "height": 32 }
    }
  ]
}
```

For a warp, `position` and `size` describe the warp area on this map, and `map`, `x`, `y` are the destination. A list that is left out is not changed.

What is written, and what happens when the disk write fails, is described in [Overview](#/assets/overview/map-data-persistence). For worlds see [World maps](#/assets/world-maps/saving-edits).

### The other editors

The [spell](#/tools/spell-editor), [item](#/tools/item-editor), [NPC](#/tools/npc-editor), [creature](#/tools/creature-editor), [quest](#/tools/quest-editor), [particle](#/tools/particle-editor) and [player](#/tools/player-editor) editors save their data to the engine's database, not to the asset server. They only read from the asset server, to let you pick images:

| Endpoint | Used for |
| --- | --- |
| `/icons` | The list of icons to choose from. |
| `/sprites` | The list of sprites, for example for spells and particles. |
| `/sprite-sheets` | The list of sprite sheets, each with its slot and matching icon. |
| `/icon`, `/sprite`, `/sprite-sheet-image` | The preview images themselves. |

Some lists are fetched by the engine and handed to the editor, others are fetched by the browser directly. Either way the editors show what the asset server loaded at its last start. Add a new image to the assets folder, restart the asset server, and it appears in the pickers.

## Testing the connection

```bash title="Is the server up?"
curl http://localhost:8000/status
```

```bash title="Is the auth key right?"
curl -X POST http://localhost:8000/map-checksums \
  -H "Content-Type: application/json" \
  -d '{"authKey":"change-me","serverId":"test","checksums":{}}' \
  --compressed -o maps.json -w "%{http_code}\n"
```

A `200` with a `maps.json` file means the key is accepted. A `401` means it is not.

On the asset server, a successful sync from the engine is logged like this:

```text title="Asset server log"
[AssetServer] Map sync for server-1: 0 outdated maps
[AssetServer] World sync for server-1: 2 world(s)
```
