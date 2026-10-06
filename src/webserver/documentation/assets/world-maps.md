---
title: World Maps
description: The .world directory format, and how the asset server stores, serves and saves worlds of up to 10240 x 10240 tiles.
order: 40
---

A map that is too large to keep as one Tiled JSON file is stored as a **world**: a directory of binary files that the asset server reads chunk by chunk. This page documents the format on disk and how a world is loaded, served, synced to the engine and saved. How the engine uses a world once it has it is covered in [engine world maps](#/engine/world-maps).

## Why worlds exist

An ordinary map is parsed into memory whole, sent to the engine whole, and rewritten whole on every save. That stops working at continent size. A 10240 x 10240 world has over 100 million tiles per layer.

A world solves this in three ways:

- **Tiles stay on disk.** The asset server keeps only the manifest and the index of each pack file it has opened. A chunk is read from its pack when a client asks for it.
- **The engine never receives tiles.** It copies the manifest and two bitsets (collision and no-PvP, one bit per tile). For a 10240 x 10240 world that is about 25 MB.
- **Saves touch only what changed.** An edit rewrites the pack files that contain the edited chunks.

To the rest of the system a world looks like any other map. `continent.world` is known everywhere as `continent.json`, and `/map-chunk` returns the same JSON for it as for a Tiled map.

## Directory layout

A world is a folder in `maps` whose name ends in `.world`:

```text title="maps/continent.world/"
manifest.json        size, tile size, tilesets, layers, objects, pack list
collision.bits       one bit per tile: blocked or not
nopvp.bits           one bit per tile: no-PvP zone or not
packs/
  r0_0.ffp           the tiles, packChunks x packChunks chunks per file
  r1_0.ffp
  r0_1.ffp
  ...
```

Worlds are written by the project's map generator. The asset server reads them, serves them and applies editor saves to them.

:::warning A world and a map cannot share a name
If `maps/continent.json` and `maps/continent.world` both exist, the world is skipped at startup and an error is logged. Remove one of the two.
:::

## Sizes and terms

| Term | Meaning | Example |
| --- | --- | --- |
| `width`, `height` | World size in tiles. Both must be a multiple of `chunkSize`. | 10240 x 10240 |
| `chunkSize` | Tiles per chunk side. Must be a multiple of 8. Use a power of two: the engine's bitset lookup depends on it. | 64 |
| `chunksX`, `chunksY` | `width / chunkSize`, `height / chunkSize`. | 160 x 160 |
| `packChunks` | Chunks per pack side. One pack file holds `packChunks * packChunks` chunks. | 16 |
| `packsX`, `packsY` | Number of pack files along each axis, rounded up. | 10 x 10 |

With the example values each pack covers 1024 x 1024 tiles, and the world has 100 pack files.

## manifest.json

```json title="manifest.json (shortened)"
{
  "format": "ffworld",
  "formatVersion": 1,
  "id": "continent",
  "worldRev": 0,
  "width": 10240,
  "height": 10240,
  "tilewidth": 16,
  "tileheight": 16,
  "chunkSize": 64,
  "packChunks": 16,
  "chunksX": 160,
  "chunksY": 160,
  "packsX": 10,
  "packsY": 10,
  "layers": [
    { "id": 1, "name": "Ground", "type": "tilelayer", "tileIndex": 0, "zIndex": 0, "role": "tiles", "visible": true },
    { "id": 7, "name": "nopvpzone", "type": "tilelayer", "tileIndex": 6, "zIndex": 6, "role": "nopvp", "visible": true },
    { "id": 8, "name": "Collisions", "type": "tilelayer", "tileIndex": 7, "zIndex": 7, "role": "collision", "visible": true },
    { "id": 9, "name": "Warps", "type": "objectgroup" },
    { "id": 10, "name": "Graveyards", "type": "objectgroup" }
  ],
  "tilesets": [
    { "name": "environment", "firstgid": 1, "image": "../tilesets/environment.png", "tilewidth": 16, "tileheight": 16, "columns": 64, "tilecount": 4096 }
  ],
  "bitsets": {
    "collision": { "file": "collision.bits", "hash": "0123456789abcdef" },
    "nopvp": { "file": "nopvp.bits", "hash": "0123456789abcdef" }
  },
  "packs": [
    { "px": 0, "py": 0, "file": "packs/r0_0.ffp", "packHash": "0123456789abcdef", "packRev": 0 }
  ],
  "spawn": { "x": 81920, "y": 81920 },
  "nextObjectId": 2,
  "objects": [
    {
      "id": 1, "layer": "Warps", "name": "Warp_1", "type": "warp",
      "x": 80000, "y": 24000, "width": 64, "height": 48,
      "properties": [
        { "name": "map", "type": "string", "value": "underworld" },
        { "name": "x", "type": "int", "value": 80032 },
        { "name": "y", "type": "int", "value": 24096 }
      ]
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `format`, `formatVersion` | Must be `"ffworld"` and `1`. Anything else is rejected. |
| `id` | The world's name. |
| `worldRev` | Counter raised by one on every save. |
| `width`, `height`, `tilewidth`, `tileheight` | Size in tiles and tile size in pixels. |
| `chunkSize`, `packChunks` | See the table above. |
| `layers` | The layer list in drawing order, like a Tiled map's, without tile data. |
| `layers[].tileIndex` | Tile layers only. The position of the layer's tiles inside a chunk record. The values must be `0` to `n - 1` with no gaps. A world has 1 to 16 tile layers. |
| `layers[].role` | `tiles` for art, `collision` or `nopvp` for the layers the bitsets are built from. |
| `layers[].zIndex` | Draw order sent to the client. Defaults to the layer's position in the list. |
| `tilesets` | Tiled tileset entries. The image is looked up by file name in the `tilesets` folder. |
| `bitsets` | File name and content hash of the two bitset files. |
| `packs` | One entry per pack file with its hash and revision. Every pack of the grid must exist on disk. |
| `spawn` | Where new players start, in pixels. |
| `objects` | Every object of the object layers. `layer` names the layer it belongs to. Warps and graveyards live here. |
| `nextObjectId` | The next free object id. |
| `backgroundcolor` | Optional. Used as the background of the baked map image. |

The generator may write further keys. The asset server keeps keys it does not use untouched when it rewrites the manifest.

## Pack files

A pack file (`packs/r<px>_<py>.ffp`) holds the tiles of `packChunks * packChunks` chunks. All numbers are little endian.

```text title="Pack file layout"
+---------------------------+
| header          64 bytes  |
+---------------------------+
| chunk table               |   packChunks * packChunks entries, 32 bytes each
+---------------------------+
| chunk records             |   one per chunk that has tiles, any order
+---------------------------+
```

### Header

| Offset | Type | Content |
| --- | --- | --- |
| 0 | u32 | Magic number `0x50574646`, the bytes `FFWP` |
| 4 | u16 | Format version, `1` |
| 6 | u16 | Header size, `64` |
| 8 | u16 | `px`, the pack's column |
| 10 | u16 | `py`, the pack's row |
| 12 | u16 | `chunkSize` |
| 14 | u16 | `packChunks` |
| 16 | u16 | Number of tile layers |
| 20 | u32 | Pack revision |
| 32 | u64 | Pack hash |

The asset server checks the magic number, version, header size, position, chunk size, pack size and layer count against the manifest before it trusts a pack.

### Chunk table

The entry for a chunk is at index `localY * packChunks + localX`, where `localX = chunkX - px * packChunks` and `localY = chunkY - py * packChunks`.

| Offset | Type | Content |
| --- | --- | --- |
| 0 | u32 | Offset of the chunk record in the file. `0` means the chunk is empty and has no record. |
| 4 | u32 | Stored length of the record |
| 8 | u32 | Length after decompression |
| 12 | u8 | Codec: `0` none, `1` zlib |
| 14 | u16 | Layer mask: bit `i` is set when tile layer `i` has tiles in this chunk |
| 24 | u32 | Revision of this chunk |

### Chunk records

A record holds one block for each layer set in the layer mask, in `tileIndex` order. Each block starts with an 8 byte header: the encoding in byte 0 and a 32 bit value at offset 4.

| Encoding | Name | Data after the header | Meaning |
| --- | --- | --- | --- |
| 1 | Fill | None | Every tile of the layer in this chunk is the header value. |
| 2 | Bit | `chunkSize * chunkSize / 8` bytes | A bitmap. Tiles with a set bit are the header value, the rest are 0. |
| 3 | 16 bit | `chunkSize * chunkSize * 2` bytes | One u16 tile id per tile. |
| 4 | 32 bit | `chunkSize * chunkSize * 4` bytes | One u32 tile id per tile. |

Tiles are stored row by row. When the server writes a record it picks the smallest encoding that fits, then compresses the record with zlib.

## Bitset files

`collision.bits` and `nopvp.bits` answer one question per tile: is there anything on a layer with that role? They are what the engine uses for movement, pathfinding and PvP rules.

| Offset | Type | Content |
| --- | --- | --- |
| 0 | u32 | Magic number `0x42574646`, the bytes `FFWB` |
| 4 | u16 | Format version, `1` |
| 6 | u16 | Header size, `32` |
| 8 | u16 | `chunkSize` |
| 10 | u16 | `chunksX` |
| 12 | u16 | `chunksY` |
| 14 | u16 | Role: `1` collision, `2` no-PvP |
| 16 | u64 | xxHash64 of everything after the header |

After the 32 byte header comes one block per chunk, `chunkSize * chunkSize / 8` bytes each, in the order `chunkY * chunksX + chunkX`. Inside a block, the bit for a tile is number `localY * chunkSize + localX`, lowest bit of each byte first.

The file size is therefore fixed: `32 + chunksX * chunksY * chunkSize * chunkSize / 8` bytes. For a 10240 x 10240 world that is 13,107,232 bytes per file.

## Loading

At startup, after the ordinary maps, the asset server opens every `*.world` folder in `maps`:

1. It reads and validates `manifest.json` (format, sizes, layers, that every pack file exists).
2. It hashes the manifest and the two bitset files with SHA-256. These hashes drive the engine's sync.
3. It checks each pack's header against the manifest and repairs the world if a save was interrupted (see [Saving edits](#/assets/world-maps/saving-edits)).

A world that fails any check is skipped with an error in the log. The other maps and worlds are not affected.

```text title="Startup log"
Loaded 2 world(s) in 476.64ms
Baked 5 world map image(s) in 3509.60ms
```

## Serving chunks

Clients request chunks of a world exactly as they do for a map:

```bash title="One chunk of a world"
curl --compressed "http://localhost:8000/map-chunk?map=continent&x=80&y=91&size=64"
```

The response has the same shape as for a Tiled map: `chunkX`, `chunkY`, `width`, `height`, and one entry per tile layer with `name`, `zIndex` and `data`.

:::warning The size must be the world's chunk size
A world only has chunks of its own `chunkSize`. Any other `size` value is answered with `400 Invalid chunk parameters`.
:::

Each chunk that has been built is kept gzipped in the server's chunk cache. The cache key contains the world's checksum, so a save makes the old entries unreachable. A chunk outside the world, or one nothing was painted on, comes back as all zeros.

## Map images

The game's full map view uses images baked by the asset server:

| Request | Result |
| --- | --- |
| `GET /worldmap?name=continent` | The whole world as a PNG. The scale doubles until the longest edge is 4096 pixels or less, so a 10240 x 10240 world becomes a 2560 x 2560 image at 4 tiles per pixel. |
| `GET /worldmap?name=continent&rx=3&ry=5` | One region of 1024 x 1024 tiles at one pixel per tile, for the zoomed in view. `rx` and `ry` count regions from the top left. |

The whole world image is baked at startup and kept in the system temp folder between starts, keyed by the world's manifest and its tileset images. Region images are baked on first request and up to 64 of them are kept in memory.

## Sync to the engine

The engine keeps a local copy of three files per world and never the packs:

```text title="Files the engine copies"
manifest.json
collision.bits
nopvp.bits
```

1. The engine calls `POST /world-list`. The answer lists every world with the SHA-256 hash of each of the three files.
2. For each file whose local hash differs, the engine calls `POST /world-file` and writes the result into its own `src/assets/maps/<id>.world/` folder. The manifest is written last, so an interrupted copy is never mistaken for a complete one.
3. The engine verifies each bitset: magic number, sizes against the manifest, its xxHash64, and that the hash matches the one the manifest names.

Request and response formats are in [Integration](#/assets/integration/world-sync).

## Saving edits

Worlds are edited in the [map editor](#/tools/map-editor) like any map, and the save reaches the asset server through the same two endpoints.

### Tiles

`POST /save-map-chunks` with a world's name does this:

1. **Check everything first.** Each chunk must lie inside the world, be exactly `chunkSize` wide and high, and every layer sent must hold a full chunk of valid tile ids. One bad chunk rejects the whole save with a 400 and nothing is written.
2. **Merge.** The layers that were sent replace those layers in the chunk. The chunk's other layers are kept. Layers the world does not have are ignored.
3. **Drop what did not change.** A chunk that comes out identical to what is on disk is not written.
4. **Write the packs.** Each affected pack file is rebuilt with the new records, written to a `.tmp` file, and renamed over the old one.
5. **Write the bitsets**, with the blocks of the changed chunks rebuilt from their collision and no-PvP layers.
6. **Write the manifest** with the new pack hashes and revisions and a raised `worldRev`.

The response lists the chunks that really changed:

```json title="Response"
{
  "success": true,
  "checksum": "<sha256 of the new manifest>",
  "changed": [{ "chunkX": 80, "chunkY": 91 }],
  "message": "Saved 1 chunk(s) for map continent"
}
```

The engine then fetches the new bitsets, so collision changes apply without a restart, and tells the other players on the map to fetch the changed chunks again.

### Warps and graveyards

`POST /save-map-properties` writes the editor's warps and graveyards into the manifest as the objects of the `Warps` and `Graveyards` layers. Each list sent replaces the whole list. A list that is left out is kept. A bad entry, such as a warp without a target map, rejects the save.

### Interrupted saves

Packs are written before the bitsets and the manifest. If the server stops in between, the packs on disk are newer than the manifest says. The next start detects this by comparing each pack's own header with the manifest, takes the packs as they are, rebuilds the bitset blocks from their tiles, and rewrites the manifest. The log shows:

```text title="Startup log after an interrupted save"
World continent.world: a save had been cut short. 1 pack(s) were taken as they are and the collision data rebuilt from them.
```

### What cannot be done to a world

- A world cannot be replaced whole: `POST /update-map` with a world's name is answered with `400 A world cannot be replaced whole`.
- A world has a fixed size. Chunks outside it are rejected, and it does not grow like an infinite Tiled map.
