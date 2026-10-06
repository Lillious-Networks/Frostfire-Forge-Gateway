---
title: World Maps
description: Large .world maps in the engine: the file layout, loading and sync from the asset server, collision and no-PvP bitsets, creature pathing, the world spawn, underworld sections and editor saves.
order: 130
---

A normal map is one Tiled JSON file that the engine reads completely. A continent of 10240 by 10240 tiles is far too large for that, so large maps are stored as a `.world` directory. This page explains what the engine keeps of a world and how the rest of the server works with it. The code is in `src/modules/worldmaps.ts`.

## The idea

The game server never needs a world's tiles. Drawing is the client's job, and the client fetches tile chunks from the asset server. The engine only needs to answer three questions:

1. How big is the map and what is on it (warps, graveyards, objects)? That is the **manifest**.
2. Can a character stand on this tile? That is the **collision bitset**.
3. Is PvP allowed on this tile? That is the **no-PvP bitset**.

A bitset stores one bit per tile. For 10240 by 10240 tiles that is 12.5 MB per bitset, about 25 MB for both, held in memory.

| | Tiled map | World |
|---|-----------|-------|
| On disk | `src/assets/maps/<name>.json` | `src/assets/maps/<id>.world/` |
| Tiles in the engine | Yes | No |
| Collision and no-PvP | Run length encoded lists in `assetCache` | Bitsets, one bit per tile |
| Name in the engine | `<name>.json` | `<id>.json` |

Everywhere else in the engine a world looks like any other map: it is known as `<id>.json`, and it has an entry in the `maps` and `mapProperties` caches. Its tile layers simply carry no data.

:::note Two meanings of "world"
A **world map** is a `.world` directory, described here. A row of the `worlds` database table gives a map of the same name a weather (see [Weather](#/engine/weather)). A world map usually also has such a row, but they are separate things.
:::

## Files the engine keeps

```text title="src/assets/maps/overworld.world/"
manifest.json     size, tile size, tilesets, layers, objects, warps, graveyards, spawn
collision.bits    one bit per tile: 1 = blocked
nopvp.bits        one bit per tile: 1 = no PvP
```

The asset server holds more files for the same world (the tile data the client downloads). See the asset server's [World maps](#/assets/world-maps) page.

### manifest.json

The fields the engine reads:

| Field | Meaning |
|-------|---------|
| `format` | Must be `"ffworld"` |
| `formatVersion` | Must be `1` |
| `width`, `height` | Size in tiles |
| `tilewidth`, `tileheight` | Tile size in pixels |
| `chunkSize` | Tiles per chunk edge. A power of two, at least 8. `width` and `height` must be multiples of it. |
| `layers` | The layer list, in order. Tile layers have no data here. |
| `objects` | Every object, each with the name of its object layer in `layer` |
| `tilesets` | Tileset list, passed on to the client |
| `warps`, `graveyards` | Optional, as on a Tiled map |
| `spawn` | Optional `{ x, y }` in pixels: where new characters start |
| `sections` | Optional list of rectangles in tiles. See [Underworld sections](#/engine/world-maps/underworld-sections). |
| `bitsets.collision.hash`, `bitsets.nopvp.hash` | The hash each bitset file must have |

### The bitset files

Each `.bits` file has a 32 byte header followed by the bits, chunk by chunk. All numbers are little endian.

| Offset | Type | Content |
|--------|------|---------|
| 0 | u32 | Magic number `0x42574646` |
| 4 | u16 | Format version, `1` |
| 6 | u16 | Header size, `32` |
| 8 | u16 | Chunk size in tiles |
| 10 | u16 | Chunks across |
| 12 | u16 | Chunks down |
| 14 | u16 | Role: `1` collision, `2` no-PvP |
| 16 | u64 | xxHash64 of everything after the header |
| 32 | bytes | One block of `chunkSize * chunkSize / 8` bytes per chunk, row by row |

Reading one tile is a few shifts and one array access:

```ts title="src/modules/worldmaps.ts"
/** 1 when the tile is set, 0 when it is not or lies outside the world. */
isSet(tileX: number, tileY: number): number {
  if (!(tileX >= 0 && tileY >= 0 && tileX < this.width && tileY < this.height)) return 0;
  const k = ((tileY & this.mask) << this.shift) | (tileX & this.mask);
  const byte = BITS_HEADER_BYTES + ((tileY >> this.shift) * this.chunksX + (tileX >> this.shift)) * this.blockBytes + (k >> 3);
  return (this.bytes[byte]! >> (k & 7)) & 1;
}
```

When a file is opened the engine checks the magic number, the version, that the size matches the manifest, the role, the exact file length, the hash in the header, and that this hash equals the one in the manifest. A file that fails any check makes the whole world be skipped.

## Loading at startup

Worlds are handled by the asset loader, right after the Tiled maps are synced:

```ts title="src/modules/assetloader.ts"
await syncMapsBeforeLoading();
await syncWorldMaps(mapDir);
loadAllMaps();
```

`loadAllMaps` first reads every Tiled map, then calls `loadWorldMaps` for every `<id>.world` directory in `src/assets/maps`. For each world it:

1. Reads and checks the manifest and both bitsets.
2. Adds the world to the `maps` cache as `<id>.json` with `world: true`.
3. Adds a `mapProperties` entry with the size, tile size, a version (the modification time of `manifest.json`) and the spawn point.
4. Reads warps, graveyards and particle objects the same way as for a Tiled map. Particle objects become NPCs.

```text title="Startup log"
Loaded world overworld (10240 x 10240 tiles)
```

Things that make a world be skipped, each with an error in the log:

| Problem | Log message contains |
|---------|----------------------|
| A Tiled map with the same name exists | `<id>.json is already a map. Remove one of the two.` |
| Wrong `format` or `formatVersion` | `is not a world manifest`, `unsupported world format version` |
| Size is not a whole number of chunks | `the world size is not a whole number of chunks` |
| A bitset is cut short, damaged or the wrong size | `is cut short`, `is damaged`, `has the wrong length` |
| A bitset is from another build than the manifest | `belongs to another build of the world than manifest.json` |

A skipped world never affects the Tiled maps or other worlds.

## Sync from the asset server

The asset server is the source of truth. Before loading, `syncWorldMaps` brings the local copy of every world up to date.

```ts title="src/modules/worldmaps.ts"
const response = await post("/world-list", { serverId: process.env.SERVER_ID || "game-server" });
// ...
const outdated = WORLD_FILES.filter(file => fileHash(path.join(dir, file)) !== world.files?.[file]);
```

1. The engine posts to `/world-list` on the asset server with its `serverId` and auth key (`ASSET_SERVER_AUTH_KEY`, or `GATEWAY_AUTH_KEY` when that is unset).
2. The answer lists each world's id and the SHA-256 hash of its three files.
3. For each file whose local hash differs, the engine posts to `/world-file` with the world id and file name and downloads it.
4. A downloaded file is checked against its hash, written to a `.tmp` file and renamed into place.

Files are fetched in a fixed order, `collision.bits`, `nopvp.bits`, then `manifest.json`. The manifest comes last so that an interrupted sync never looks like a complete world: the bitsets would not match the old manifest's hashes, and the world would be skipped, not loaded half updated.

| Situation | Result |
|-----------|--------|
| No asset server URL configured | Sync is skipped silently |
| The asset server has no world support or cannot be reached | Sync is skipped, local worlds are loaded as they are |
| A world exists locally but not on the asset server | It is kept. Sync never deletes a world. |
| A world id with unusual characters | Skipped with a warning |

The address used is `ASSET_SERVER_INTERNAL_URL` if set, otherwise `ASSET_SERVER_URL`. See [Integration](#/assets/integration).

## Using a world as the starting map

Point `default_map` in `src/config/settings.json` at the world:

```json title="src/config/settings.json"
{
  "world": "overworld",
  "default_map": "overworld.json",
  "spawn_x": null,
  "spawn_y": null
}
```

Here `overworld.json` resolves to `src/assets/maps/overworld.world/`.

### World spawn

The centre of a generated continent may well be a lake, so a world names its own spawn point in the manifest (the map generator picks a town square). A new character's start position is chosen in this order:

1. `spawn_x` and `spawn_y` from `settings.json`, when they are not `null`.
2. The world's `spawn` from its manifest.
3. The centre of the map.

```ts title="src/socket/receiver.ts"
// A world names its own spawn (a town square): its centre may well be a lake
const worldSpawn = default_map_properties?.spawn;
const default_map_spawnpoint_x = spawnX != null
  ? spawnX
  : worldSpawn ? worldSpawn.x
  : default_map_properties ? (default_map_properties.width * default_map_properties.tileWidth) / 2 : 0;
```

## Collision and no-PvP

Movement keeps a small cache entry per map. For a Tiled map it holds the run length encoded collision list. For a world it holds the bitset itself:

```ts title="src/systems/player.ts"
const tileValue = collisionBits ? collisionBits.isSet(tileX, tileY) : collisionRLE ? queryRLE(collisionRLE, tileIndex) : 0;
```

A run length list has to be scanned from the start to find one tile, which does not work for a hundred million tiles. A bitset lookup costs the same for any tile.

No-PvP zones work the same way. `player.isInPvPZone` reads the world's `nopvp` bitset when the map is a world, and the encoded list from `assetCache` otherwise:

```ts title="src/systems/player.ts"
// A world's no-pvp zones are a bitset (modules/worldmaps.ts), a Tiled map's are run lengths
const worldNoPvp = getWorldMap(mapKey)?.nopvp;
const pvpData = worldNoPvp ? null : await assetCache.getNested(mapKey, "nopvp");
```

You can read the bitsets yourself:

```ts title="Checking a tile on a world"
import { getWorldMap } from "@engine/modules/worldmaps";

const world = getWorldMap("overworld"); // with or without ".json"
if (world) {
  const tileX = Math.floor(x / world.tileWidth);
  const tileY = Math.floor(y / world.tileHeight);
  const blocked = world.collision.isSet(tileX, tileY) === 1;
  const noPvp = world.nopvp.isSet(tileX, tileY) === 1;
}
```

`getWorldMap` returns `undefined` for a Tiled map. Tiles outside the world read as `0`.

:::note Positions are 32 bit
A world of 10240 tiles is 327680 pixels wide at 32 pixels per tile, well past what 16 bits can hold. The binary movement packets carry `x` and `y` as signed 32 bit integers for that reason. See [Networking](#/engine/networking/datagrams-and-movement-batching).
:::

## Creature pathing

Creatures find their way with a navigation grid per map. For a Tiled map the grid holds one byte per tile plus search scratch space. For a 10240 by 10240 world that would be more than 2 GB, so a world gets a `WorldNavGrid` (`src/systems/creatures/navgrid.ts`):

```ts title="src/systems/creatures/index.ts"
// A world (modules/worldmaps.ts) has a collision bitset, not run lengths: its grid searches inside a window
const world = getWorldMap(map);
if (world) {
  if (navGrids.useBits(map, world.collision, world.width, world.height, world.tileWidth, world.tileHeight)) log.debug(`Creature nav grid built for world ${map}`);
  continue;
}
```

- Collision is read straight from the world's bitset.
- A path search works inside a square window of 256 by 256 tiles (`WORLD_NAV_WINDOW`), centred between the start and the goal.
- Tiles outside the window count as walls for that search.
- If the start and the goal do not both fit in one window, there is no path.

In practice this means a creature on a world can path around obstacles within roughly 256 tiles, which covers wandering, patrols and chasing. Everything else (line of sight, path smoothing, footprints) behaves as on a Tiled map.

## Underworld sections

An underworld is one world that contains many separate cave systems. Its manifest lists them under `sections` as rectangles in tiles. The engine does not interpret them. It passes the list to the client with the map:

```ts title="src/socket/receiver.ts"
// Rectangles in tiles a map is made of, when it says so (the cave systems of a world's underworld,
// modules/worldmaps.ts): the client's world map shows only the one the player is in
sections: Array.isArray(map?.data?.sections) ? map.data.sections : null,
```

The client uses the sections so that its world map shows only the cave system the player is standing in. A map without sections sends `null`.

## Editor saves

A world can be edited in the [Map editor](#/tools/map-editor) like any map. Saving needs the `server.admin` or `server.*` permission. Because the engine holds no tiles, the save goes through the asset server:

1. The client sends `SAVE_MAP` with the edited chunks and, optionally, graveyards and warps.
2. The engine posts the chunks to `/save-map-chunks` on the asset server, which writes them into the world's files and answers with the list of chunks that changed.
3. If graveyards or warps were sent, the engine posts them to `/save-map-properties` and updates its own `mapProperties` entry and movement cache.
4. The engine calls `refreshWorldMap`, which syncs the changed files and swaps the new collision and no-PvP bits in.
5. Every other player on the map is sent `UPDATE_CHUNKS` with the changed chunks so their client fetches them again.

```ts title="src/modules/worldmaps.ts"
export async function refreshWorldMap(mapName: string): Promise<void> {
  const world = getWorldMap(mapName);
  if (!world || !worldsDir) throw new Error(`${mapName} is not a loaded world`);
  await syncWorldMaps(worldsDir);
  const dir = path.join(worldsDir, `${world.id}.world`);
  const fresh = openWorld(dir, world.id);
  world.collision.adopt(fresh.collision);
  world.nopvp.adopt(fresh.nopvp);
  // a new version has clients drop the chunks they kept of the old one
  if (world.properties) world.properties.version = String(fs.statSync(path.join(dir, "manifest.json")).mtimeMs);
}
```

`adopt` replaces the bytes inside the existing `WorldBits` object. Movement and the creature navigation grid hold that same object, so they see the new collision at once, without a restart.

| Limit | Detail |
|-------|--------|
| Size | A save cannot change a world's size. `adopt` throws `the world changed size` if it differs. |
| Objects | A save changes tiles, graveyards and warps. The world keeps its other objects. |
| Nothing to save | A save with no chunks, graveyards or warps answers `Nothing to save.` |

:::note
The comment at the top of `worldmaps.ts` still says worlds are read only. The code below it (`refreshWorldMap`) and the `SAVE_MAP` handler in `receiver.ts` implement saving as described here.
:::

## Reference

| Export of `src/modules/worldmaps.ts` | Purpose |
|--------------------------------------|---------|
| `getWorldMap(mapName)` | The loaded world, or `undefined`. Accepts the name with or without `.json`. |
| `loadWorldMaps(mapDir, tiledMapNames)` | Reads every `.world` directory. Called by the asset loader. |
| `syncWorldMaps(mapDir)` | Downloads outdated world files from the asset server |
| `refreshWorldMap(mapName)` | Re-syncs one world after an editor save and swaps its bitsets |
| `WorldBits` | A bitset with `isSet(tileX, tileY)`, `width`, `height` and `adopt(newer)` |
| `WorldMap` | `id`, `name`, `width`, `height`, `tileWidth`, `tileHeight`, `collision`, `nopvp`, `spawn`, `map`, `properties` |
