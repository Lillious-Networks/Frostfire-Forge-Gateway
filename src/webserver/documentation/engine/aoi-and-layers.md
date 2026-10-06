---
title: AOI and Layers
description: How the engine decides who sees whom: area of interest, the spatial grid, layers, automatic condensing, party layer sync and every aoi.json setting.
order: 30
---

A player only receives updates about players close to them. This page explains the area of interest (AOI) system that decides who is "close", the layers that split a busy map into instances, and the settings in `src/config/aoi.json`.

## The pieces

| File | What it holds |
|------|---------------|
| `src/socket/aoi.ts` | AOI state per player, enter and exit logic, AOI broadcasts, party layer sync, layer condensing |
| `src/services/layermanager.ts` | `layerManager`: which layer each player is on |
| `src/services/spatialgrid.ts` | `spatialGrid`: players bucketed into square cells per map |
| `src/services/mapindex.ts` | `mapIndex`: which players are on which map |
| `src/services/aoiReverseIndex.ts` | The reverse lookup: who can see a given player |
| `src/config/aoi.json` | Tuning values |

## Area of interest

Each online player carries an `aoi` object, created at login by `initializePlayerAOI`:

```ts title="src/socket/aoi.ts"
player.aoi = {
  playersInAOI: new Set<string>(),
  gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
  gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
  aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
  lastAOIUpdatePosition: { x: pos.x, y: pos.y },
  updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
  mapChangeSequence: 0,
  layerId: layerId,
  revision: 0,
};
```

`playersInAOI` is the set of player ids this player can currently see. Two players see each other when they are on the same map, on the same layer, and within `aoiRadius` pixels of each other.

### When the AOI is recalculated

Recalculating on every step would be wasteful, so two conditions must both hold while a player walks:

1. The player's tick counter is a multiple of 10, which happens on every tenth game loop tick while they move (`aoiUpdateCounter % 10 === 0`).
2. The player has moved more than `UPDATE_THRESHOLD` pixels since the last recalculation (`shouldUpdateAOI`).

```ts title="src/socket/receiver.ts"
const aoiUpdateCounter = gameLoop.getAOIUpdateCounter(currentPlayer.id);
if (aoiUpdateCounter % 10 === 0 && shouldUpdateAOI(currentPlayer)) {
  await updatePlayerAOI(currentPlayer, spawnBatchQueue, despawnBatchQueue);
}
```

Map changes and layer changes recalculate straight away, without waiting for the counter.

### Entering and leaving

`updatePlayerAOI` compares the new set of nearby players with the old one.

| Change | Result |
|--------|--------|
| A player came within the radius | Both sides get a spawn queued for the other, and each is added to the other's `playersInAOI` |
| A player went beyond the radius times 1.25 | Both sides get a despawn (reason `distance`) |
| A player is between 1.0 and 1.25 times the radius | Nothing: they stay visible |

The 1.25 band is the exit hysteresis. Without it, two players walking along the edge of each other's radius would spawn and despawn over and over. The factor can be changed with an optional `EXIT_HYSTERESIS` key in `aoi.json` (it is not part of the generated file).

Spawns and despawns are not sent one by one. They are collected in batch queues and flushed every 50 ms, despawns first, with at most 10 spawns per player per flush.

### Who is hidden

Being in range is not always enough. A player in stealth or vanished is only spawned for viewers who are admins, who are in the same party, or who are linked to them through a `forceVisibleTo` set.

### Sending to an AOI

Most gameplay packets go to "everyone who can see this player". The helpers in `aoi.ts`:

| Function | Sends to |
|----------|----------|
| `broadcastToAOI(sourcePlayer, packetData, includeSelf = true)` | The source's `playersInAOI` on the reliable stream. For a hidden source, only admins and party members. |
| `broadcastToAOIBestEffort(sourcePlayer, packetData, includeSelf = true)` | The same players, as datagrams. Only for packets where the newest one wins. |
| `broadcastToAOIBestEffortAtPosition(x, y, map, packetData, layerId?)` | Every player on the map whose own radius covers the point, optionally on one layer |
| `findPlayersWithTargetInAOI(targetId)` | Returns the players who can see `targetId`, using the reverse index |

```ts title="Sending to everyone who can see a player"
import { broadcastToAOI } from "@engine/socket/aoi";
import { packetManager } from "@engine/socket/packet_manager";

broadcastToAOI(player, packetManager.notify({ message: "A cold wind blows" }));
```

### The reverse index

`playersInAOI` answers "who can this player see". Regeneration and similar updates need the opposite question, "who can see this player", once per player every second. Scanning all players for that is quadratic, so `aoiReverseIndex.ts` keeps a second map from a viewed player to its viewers. Every change to a `playersInAOI` set in `aoi.ts` is mirrored there (`addViewer`, `removeViewer`, `replaceVisibleSet`).

:::warning
If you ever change a `playersInAOI` set outside `aoi.ts`, the reverse index goes out of step. Use the functions in `aoi.ts`.
:::

## The spatial grid

`spatialGrid` divides every map into square cells and remembers which players stand in each cell, keyed as `map:cellX:cellY`. A radius query only looks at the cells the circle touches.

```ts title="src/services/spatialgrid.ts"
private getCellKey(x: number, y: number, map: string): string {
  const cellX = Math.floor(x / this.cellSize);
  const cellY = Math.floor(y / this.cellSize);
  return `${map}:${cellX}:${cellY}`;
}
```

| Method | Purpose |
|--------|---------|
| `addPlayer(playerId, x, y, map)` | Put a player into their cell |
| `updatePlayer(playerId, x, y, map)` | Move them. Returns `true` when the cell changed. |
| `removePlayer(playerId)` | Take them out |
| `getPlayersInRadius(x, y, radius, map)` | Ids of everyone in the cells that the circle touches (candidates, not yet distance checked) |
| `getPlayersInCell(x, y, map)` | Ids in one cell |

The grid is kept up to date when `USE_SPATIAL_GRID` is `true`: on login, on every AOI recalculation and on map changes.

Two details are worth knowing:

- Player to player visibility does not query the grid. Candidates are always on the same layer, and a layer holds at most `MAX_PLAYERS_PER_LAYER` players, so `aoi.ts` simply walks the layer's members. At a crowded spawn point a grid query would return thousands of players on other layers only to discard them.
- The creature system does query the grid, to find players near a creature for aggro. Because a player's cell is only refreshed after they moved `UPDATE_THRESHOLD` pixels, the creature code pads its radius by that distance.

:::note Cell size
The shared grid is created as `new SpatialGrid(512)`. `GRID_CELL_SIZE` in `aoi.json` sets the `gridX` and `gridY` values stored on each player's `aoi` object, not the size of the shared grid's cells. Keep it at 512 so both agree.
:::

## Layers

A layer is an instance of a map. Players on different layers of the same map never see each other, which keeps a crowded map playable and bounds the cost of every AOI calculation.

Layer ids look like `overworld:layer_1`, `overworld:layer_2` and so on. `layerManager` assigns them:

```ts title="src/services/layermanager.ts"
assignPlayerToLayer(playerId: string, mapName: string, preferredLayerId?: string): string
```

1. The player is removed from their current layer.
2. If a preferred layer is given, exists on that map and has room, the player joins it.
3. Otherwise the player joins the first layer of that map with fewer than `MAX_PLAYERS_PER_LAYER` players.
4. If every layer is full, a new one is created.

A layer that becomes empty is deleted.

| Method | Returns |
|--------|---------|
| `getPlayerLayer(playerId)` | The player's layer id, or `null` |
| `getPlayersInLayer(layerId)` | Player ids on that layer |
| `getPlayersInSameLayer(playerId)` | Player ids sharing the player's layer |
| `getLayersForMap(mapName)` | Every layer of a map with its player count |
| `getLayerInfo(layerId)` | One layer, or `null` |
| `getStats()` | Total layers, total players and layers per map |

```ts title="Reading layer information"
import layerManager from "@engine/services/layermanager";

const layerId = layerManager.getPlayerLayer(player.id);
const neighbours = layerId ? layerManager.getPlayersInLayer(layerId) : [];
```

Changing map always assigns a fresh layer on the new map (`handleMapChangeAOI`). The player is despawned for everyone on the old map first.

Movement batches are grouped by layer too: each layer's movers are flushed together, and a layer with more than 20 receivers is encoded on a movement worker thread. See [Networking](#/engine/networking/datagrams-and-movement-batching).

## Party layer sync

Party members should be able to see each other, so the engine tries to keep a party on one layer.

### At login

`initializePlayerAOI` looks for online party members on the same map:

- The party leader joins the layer where most of their party already is, if it has room.
- Any other member joins the leader's layer, if the leader is online on that map and the layer has room.
- Otherwise the player gets a normal layer.

### When the party changes

The party handlers in `receiver.ts` call `syncPartyLayers` after a change such as a member joining, and the player editor does the same.

```ts title="src/socket/aoi.ts"
export async function syncPartyLayers(
  partyLeaderUsername: string,
  partyMemberUsernames: string[],
  playerCache: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void>
```

It moves every online member on the leader's map to the leader's layer, one by one, until that layer is full. Each moved member is despawned for the players on their old layer, gets their AOI recalculated on the new one, and receives the players there together with their current animations.

### Every 15 seconds

`startAutoPartyLayerSync` runs on a 15 second timer. It walks every party and calls `syncPartyLayers` for any party that has a member on the leader's map but on a different layer. This catches members who arrived on the map after the party was formed.

:::note
A layer never grows past `MAX_PLAYERS_PER_LAYER`. When the leader's layer is full, the remaining members stay where they are and the next pass tries again.
:::

## Auto condensing

Players leave, and a map can end up with several half empty layers. `startAutoLayerCondensation` merges them every 5 minutes (300000 ms).

For each map with more than one layer:

1. Layers are sorted by player count, smallest first.
2. If no layer has fewer than 25 players, nothing happens.
3. Each layer with fewer than 25 players looks for a larger layer that can take all of its players without passing `MAX_PLAYERS_PER_LAYER`.
4. If one is found, every player of the small layer moves there. They are despawned for their old neighbours, their AOI is recalculated, and the new neighbours are sent to them.

A layer is only ever moved as a whole, so a group standing together is never split by condensing.

Both timers are started once, from `server.ts`:

```ts title="src/socket/server.ts"
gameLoop.start();
await creatures.init();
startAutoPartyLayerSync(sendAnimationTo);
startAutoLayerCondensation(sendAnimationTo);
```

## aoi.json settings

`src/config/aoi.json` is written by `bun create-config`. On later runs missing keys are added and `USE_SPATIAL_GRID` is set back to `true`. The file is imported as a module, so changes need a restart.

```json title="src/config/aoi.json"
{
  "DEFAULT_RADIUS": 1000,
  "UPDATE_THRESHOLD": 100,
  "GRID_CELL_SIZE": 512,
  "USE_SPATIAL_GRID": true,
  "SPATIAL_GRID_THRESHOLD": 50,
  "MAX_PLAYERS_PER_LAYER": 50,
  "DEBUG": false
}
```

| Key | Default | What it does |
|-----|---------|--------------|
| `DEFAULT_RADIUS` | `1000` | View distance in pixels. Players within this distance on the same layer see each other. Also used for position based broadcasts. |
| `UPDATE_THRESHOLD` | `100` | Pixels a player must move before their AOI is recalculated |
| `GRID_CELL_SIZE` | `512` | Divisor for the `gridX` and `gridY` values on a player's `aoi` object |
| `USE_SPATIAL_GRID` | `true` | Keeps `spatialGrid` up to date. Forced to `true` by `create-config`, because creature aggro depends on it. When it is `false` the creature system falls back to scanning every player on the map. |
| `MAX_PLAYERS_PER_LAYER` | `50` | Capacity of a layer. A new layer is created when all layers of a map are full. |
| `SPATIAL_GRID_THRESHOLD` | `50` | Generated, but nothing in `src/` reads it |
| `DEBUG` | `false` | Generated, but nothing in `src/` reads it |
| `EXIT_HYSTERESIS` | `1.25` (optional) | Not generated. Multiplier on the radius before a visible player is dropped. |

:::tip Choosing values
A larger `DEFAULT_RADIUS` means more players per AOI and more spawn and movement traffic. A larger `MAX_PLAYERS_PER_LAYER` makes maps feel busier but raises the cost of every AOI recalculation, which walks the whole layer. The condensing threshold of 25 players is a constant in `aoi.ts` and does not follow `MAX_PLAYERS_PER_LAYER`.
:::

## Related pages

- [Networking](#/engine/networking): how spawns, despawns and movement reach the client
- [Game loop](#/engine/game-loop): the tick that drives movement and the AOI counter
- [Benchmarking](#/engine/benchmarking): measuring the effect of these settings under load
