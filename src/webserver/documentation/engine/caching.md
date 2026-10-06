---
title: Caching
description: The in-memory caches the engine reads from while it runs: assetCache, playerCache, the creature registry, cooldown and effect managers, the row caches in datacache, and the Redis option.
order: 50
---

While the server runs, almost nothing is read from the database on demand. Static game data, online players and copies of database rows all live in memory. This page describes each cache, when to use it, and what `CACHE=redis` changes.

## Overview

| Cache | File | Holds | Lifetime |
|-------|------|-------|----------|
| `assetCache` | `src/services/assetCache.ts` | Static game data: items, spells, maps, NPCs and more | Loaded at startup, updated by the editors |
| `playerCache` | `src/services/playermanager.ts` | One live object per online player | Login to disconnect |
| Creature registry | `src/systems/creatures/registry.ts` | Every live creature, bucketed by map and cell | Spawn to despawn |
| `cooldownManager` | `src/services/cooldownmanager.ts` | Spell cooldowns and lockouts per username | Until they expire or the player disconnects |
| `effectManager` | `src/services/effectmanager.ts` | Active spell effects of players who logged out | Disconnect to next login |
| Row and table caches | `src/services/datacache.ts` | Copies of database rows | See [below](#/engine/caching/datacache-copies-of-database-rows) |

:::note
Older notes mention `src/services/entityCache.ts`. That file no longer exists: creatures are kept by the creature system's own registry.
:::

## assetCache

`assetCache` is a key and value store for game data that rarely changes. `src/modules/assetloader.ts` fills it at startup from the database and the asset server.

| Method | Purpose |
|--------|---------|
| `get(key)` | The value, or `null` |
| `add(key, value)` / `set(key, value)` | Store a value (the two are the same) |
| `remove(key)` | Delete a value and its nested values |
| `getNested(key, nestedKey)` | One field of a hash, or `undefined` |
| `addNested(key, nestedKey, value)` / `setNested(...)` | Store one field of a hash |
| `removeNested(key, nestedKey)` | Delete one field |
| `list()` / `getAll()` | Every plain key and value |
| `clear()` | Delete everything |

Every method returns a promise.

### Keys

| Key | Content |
|-----|---------|
| `items` | Every item definition |
| `spells` | Every spell, including spells added by plugins |
| `mounts` | Every mount |
| `npcs` | NPCs from the database plus particle NPCs read from maps |
| `particles` | Particle definitions |
| `quests` | Quest definitions |
| `weather` | Rows of the `weather` table |
| `worlds` | Rows of the `worlds` table, with live player counts |
| `maps` | Map data (worlds are held without tile data) |
| `mapProperties` | Size, tile size, warps, graveyards and version of each map |
| `creatureTemplates` | Creature templates |
| `<map name>` with nested `collision` or `nopvp` | Run length encoded collision and no-PvP data of a Tiled map |

### Examples

```ts title="Reading game data"
import assetCache from "@engine/services/assetCache";

const items = await assetCache.get("items") as Item[];
const sword = items.find((item) => item.name === "iron_sword");

// Nested data: the collision of one map
const rle = await assetCache.getNested("overworld", "collision");
```

Writing follows one pattern: read the list, change it, store it again. This is how a plugin spell is registered:

```ts title="src/socket/server.ts"
const existingSpells = await assetCache.get("spells") as SpellData[] || [];
if (existingSpells.some((s: SpellData) => s.name === spell.name)) {
  log.warn(`Plugin tried to register duplicate spell "${spell.name}" -- skipping`);
  return;
}

existingSpells.unshift(spell);
await assetCache.set("spells", existingSpells);
```

:::warning Always store after changing
With `CACHE=memory`, `get` returns the stored object itself, so a change to it is visible at once. With `CACHE=redis`, `get` returns a fresh copy parsed from JSON, and a change is lost unless you call `set`. Calling `set` after every change works in both modes.
:::

## playerCache

`playerCache` holds the live state of every online player, keyed by connection id (`wt.data.id`). It is a plain in-process object: reads and writes are synchronous and cost nothing.

| Method | Purpose |
|--------|---------|
| `add(key, value)` | Add a player at login. Takes over the username index for that name. |
| `get(key)` | The player with this connection id |
| `getByUsername(username)` | The online player with this username, any case, without touching the database |
| `set(key, value)` | Replace a player object |
| `setNested(key, nestedKey, value)` / `addNested(...)` | Set one property |
| `remove(key)` | Remove a player |
| `list()` | The whole cache as an object of `id -> player` |
| `clear()` | Remove everyone |

```ts title="src/socket/server.ts"
// Any inbound packet proves the client is alive
const activePlayer = playerCache.get(connection.data.id);
if (activePlayer) {
  activePlayer.lastUpdated = performance.now();
}
```

```ts title="Finding players"
import playerCache from "@engine/services/playermanager";
import { packetManager } from "@engine/socket/packet_manager";

// By username, for example the target of a whisper
const target = playerCache.getByUsername("Alice");
if (target?.wt?.readyState === 1) {
  target.wt.send(packetManager.notify({ message: "Hello" })[0]);
}

// Everyone online
for (const player of Object.values(playerCache.list())) {
  // player.username, player.location, player.stats, player.wt ...
}
```

A player object carries, among other things, `id`, `username`, `location` (`map` and `position`), `stats`, `wt` (the connection), `aoi` (see [AOI and layers](#/engine/aoi-and-layers)), `permissions`, `party` and `friends`.

:::warning playerCache is not saved by itself
Changing `player.stats` only changes memory. Stats and location are written to the database every 60 seconds (`onSave`) and at disconnect. Everything else that must survive (inventory, currency, quests) is written by its own system at the moment it changes.
:::

`list()` scans every player. To find the players on one map or near one player, use `mapIndex.getPlayersOnMap(map)` or the AOI helpers instead.

## Creature registry

Live creatures are stored in `CreatureRegistry` (`src/systems/creatures/registry.ts`). Like the player grid, it buckets creatures per map into 512 pixel cells so that visibility and aggro checks only look at nearby cells.

| Method | Purpose |
|--------|---------|
| `add(instance)` / `remove(id)` | Add or remove a creature |
| `get(id)` | One creature |
| `all()` | Iterator over every creature |
| `move(instance, x, y)` | Update the position and re-bucket when the cell changed |
| `queryRadius(map, x, y, radius)` | Creatures within a radius on a map |
| `size` | Number of live creatures |

Creature templates, spawns and patrol paths are read from the database at startup. Editing them is described in the [Creature editor](#/tools/creature-editor).

## cooldownManager

Spell cooldowns are kept per username and spell id. End times are `performance.now()` values, not wall clock times.

| Method | Purpose |
|--------|---------|
| `setCooldown(username, spellId, endTime)` | Start a cooldown |
| `hasCooldown(username, spellId)` | Whether it is still running (expired entries are removed) |
| `deleteCooldown(username, spellId)` | Clear one |
| `getActiveCooldowns(username)` | `{ spellId: endTime }` for the running ones |
| `setLockout(username, endTime)` / `getLockout(username)` | A lockout over all spells |
| `removePlayer(username)` | Forget everything for a player (done at disconnect) |

```ts title="src/socket/receiver.ts"
cooldownManager.setCooldown(freshPlayerForMana.username, spell_id, performance.now() + spellCooldownTime);
```

At login the active cooldowns and the lockout are sent to the client with the rest of the player's data.

## effectManager

When a player disconnects in the middle of a fight, their damage over time effects, barriers, stuns and slows should not vanish. `effectManager` parks them by username until the player returns.

```ts title="src/socket/server.ts (on disconnect)"
effectManager.saveDots(username, dots.getPlayerDots(String(playerData.id)) || []);
effectManager.saveBarriers(username, playerData.barriers || []);
effectManager.saveStuns(username, getStunsForPlayer(String(playerData.id)) || []);
effectManager.saveSlows(username, getSlowsForPlayer(String(playerData.id)) || []);
```

At the next login `loadDots`, `loadBarriers`, `loadStuns` and `loadSlows` return only the entries that have not expired yet (`expiresAt` is a `Date.now()` time, and a barrier with `expiresAt` 0 is permanent), and `clearAll(username)` empties the parking spot. Guests are not saved.

Both managers live in the server process only. A restart clears them.

## datacache: copies of database rows

`src/services/datacache.ts` is the layer between the game systems and the database. The rule it enforces:

:::danger Client requests never read the database
A handler for a client packet reads from a cache. Whatever changes a row writes the database first and then tells the cache. The only place a cache reads the database is its own `load` function.
:::

There are two kinds of cache.

### Rows by key: rowCache

A row cache loads one key the first time it is asked for and keeps it.

```ts title="src/systems/currency.ts"
import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";

// Each player's balance (null: they have no row).
const rows = rowCache<Currency>("currency", async (username) => {
  const response = await query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Currency[];
  return response[0] ?? null;
}, { perPlayer: true });
```

| Method | Purpose |
|--------|---------|
| `get(key)` | The cached value, loaded on first use. Always a copy: changing it changes nothing. |
| `set(key, value)` | After a database write: what is now held (`null` means "no row") |
| `patch(key, columns)` | After writing some columns: the same columns on the row held |
| `drop(key)` | Forget one key, so the next `get` loads it again |
| `clear()` | Forget every key |

With `{ perPlayer: true }` the key is a username in any case. Those caches are reloaded when the player logs in (`refreshPlayer`) and emptied when they leave (`forgetPlayer`). An answer of "no such row" is believed for 60 seconds, then the database is asked again.

### Whole tables: tableCache

A table cache holds every row of a small table. All of them are read once at startup by `loadTables()`.

```ts title="src/systems/parties.ts"
const rows = tableCache<PartyRow>("parties", async () => {
  const result = await query("SELECT id, leader, members FROM parties", []) as any[];
  return (result || []).map((row: any) => ({ id: row.id, leader: row.leader, members: row.members }));
});
```

| Method | Purpose |
|--------|---------|
| `all()` | Every row (copies) |
| `find(match)` | The first row that matches, or `null` |
| `filter(match)` | Every row that matches |
| `put(row, same)` | After a database write: add the row, replacing the one `same` accepts |
| `remove(match)` | After a database write: take out matching rows |
| `reload()` | Read the whole table again |
| `drop()` | Forget the rows, so the next read loads the table |

### Write the database first, then the cache

This is the write path of the currency system, slightly shortened:

```ts title="src/systems/currency.ts (shortened)"
async function write(username: string, currencyData: Currency) {
  const { copper, silver, gold } = currencyData;
  try {
    await query(
      "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE copper = ?, silver = ?, gold = ?",
      [username, copper, silver, gold, copper, silver, gold]
    );
  } catch (error) {
    // A write that threw may still have been made (one that timed out, say):
    // the balance held is forgotten and the next read loads it.
    await rows.drop(username);
    throw error;
  }
  await rows.set(username, { copper, silver, gold });
}
```

Three things to copy from it:

1. The database is written before the cache.
2. If the write throws, the cached value is dropped, not kept. A statement that timed out may still have been applied.
3. Reads (`currency.get`) only call `rows.get`.

### One change at a time: turns

"Read the balance, add 5, write it back" breaks when two such changes run side by side: both read the same balance and one addition is lost. `turns()` returns a queue per key that runs one piece of work at a time, in order, while other keys go ahead.

```ts title="src/systems/currency.ts (shortened)"
const oneAtATime = turns();

async add(username: string, amount: Currency): Promise<Currency> {
  return oneAtATime(username, async () => {
    const currentCurrency = await this.get(username);
    // ... work out the new balance ...
    await write(username, currentCurrency);
    return currentCurrency;
  });
}
```

### Writers that do not own the cache

Some code changes rows that another system caches. The gateway creates accounts, a party change sets `accounts.party_id`, the guest cleanup deletes from many tables. Those writers tell the cache by name:

| Function | Effect |
|----------|--------|
| `dropRows(name, key)` | The row cache `name` forgets one key |
| `dropAllRows(name)` | The row cache `name` forgets everything |
| `reloadTable(name)` | The table cache `name` reads its table again |
| `refreshPlayer(username)` | Every per player cache reloads this player (login) |
| `forgetPlayer(username)` | Every per player cache drops this player (disconnect) |
| `loadTables()` | Read every table cache (startup) |
| `clearCaches()` | Empty everything (tests) |

```ts title="src/systems/parties.ts"
for (const username of new Set(accounts)) {
  if (username) await dropRows("accounts", username);
}
```

### What is cached this way

| Kind | Names |
|------|-------|
| Per player rows | `accounts`, `stats`, `inventory`, `equipment`, `bags`, `currency`, `collectables`, `friends`, `permissions`, `learned_spells`, `quest_log`, `quest_progress` |
| Other rows | `account_ids`, `spell_usage` |
| Tables | `parties`, `guilds`, `loot_tables`, `permission_types`, `account_names`, `stored_spells` |

:::note Worker threads do not cache
The login workers import the same systems on their own threads, where a write on the main thread could never reach them. `datacache` checks `Bun.isMainThread`: off the main thread every read goes straight to the database.
:::

## The Redis option

By default every cache lives in the server process (`CACHE=memory`). With `CACHE=redis` two of them move to Redis:

| Cache | With `CACHE=redis` |
|-------|--------------------|
| `assetCache` | Stored in Redis under the key prefix `asset:` |
| Row and table caches (`datacache`) | Stored through `assetCache`, as `asset:rows:<name>` |
| `playerCache`, creature registry, `cooldownManager`, `effectManager` | Unchanged: always in process |

```env title=".env.production"
CACHE=redis
REDIS_URL=redis://change-me:6379
```

```ts title="src/services/assetCache.ts"
const cacheType = process.env.CACHE?.toLowerCase() || "memory";
const assetCache: CacheService = cacheType === "redis"
  ? new RedisCacheService()
  : new MemoryCacheService();
```

The engine uses Bun's built in Redis client (`redis` from the `bun` module), which takes its address from `REDIS_URL`. Values are stored as JSON, plain keys as strings and nested keys as Redis hashes. Buffers are restored to `Buffer` objects when read.

Why use it: several game servers that share one database then also share one copy of the cached rows, so a write on one server is seen by the others.

:::warning
If `CACHE=redis` is set but `REDIS_URL` is empty, startup logs a warning and continues with the in-memory cache.
:::

## Choosing the right cache

| You want to | Use |
|-------------|-----|
| Look up an item, spell, NPC or map | `assetCache.get(...)` |
| Read or change an online player's live state | `playerCache.get(id)` or `playerCache.getByUsername(name)` |
| Read a player's inventory, currency or permissions | The system module (`inventory`, `currency`, `permissions`), which reads its row cache |
| Store new persistent data | A new `rowCache` or `tableCache` beside your `query` calls |
| Find who is near a player | `player.aoi.playersInAOI`, see [AOI and layers](#/engine/aoi-and-layers) |

The database side of this is covered on the [Database](#/engine/database) page.
