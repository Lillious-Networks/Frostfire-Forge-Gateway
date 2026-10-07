---
title: Database
description: MySQL and SQLite, the setup scripts, the query function and its worker pool, transactions, the rule that reads come from caches, and the main tables.
order: 60
---

The engine stores accounts, characters and game data in a SQL database and reaches it through one function, `query`, that runs on a pool of worker threads. This page covers the supported engines, how the schema is created, how to run queries, and the rule that keeps the database out of the hot path.

## MySQL and SQLite

`DATABASE_ENGINE` selects the engine. MySQL is the one meant for real servers. SQLite needs no database server and is handy for local development.

:::tabs
```env title="MySQL"
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=frostfire_forge
DATABASE_USER=root
DATABASE_PASSWORD=change-me
SQL_SSL_MODE=DISABLED
```
```env title="SQLite"
DATABASE_ENGINE=sqlite
DATABASE_NAME=frostfire_forge
# Still required by startup validation, although SQLite does not use them:
DATABASE_HOST=localhost
DATABASE_USER=local
DATABASE_PASSWORD=change-me
SQL_SSL_MODE=DISABLED
```
:::

| | MySQL | SQLite |
|---|-------|--------|
| Setup script | `bun setup` (uses `.env.production`) | `bun setup-localdb` (uses `.env.development`) |
| Where the data lives | Your MySQL server | `<system temp dir>/frostfire_forge/<DATABASE_NAME>.sqlite` |
| Connection | TLS optional (`SQL_SSL_MODE`) | A local file, opened in WAL mode with foreign keys on |
| Text comparison in `WHERE` | Case insensitive | Case sensitive |

:::warning SQLite data sits in the temp directory
The SQLite file is created under the operating system's temporary directory (`os.tmpdir()`). Cleaning that directory deletes your local database. Do not use SQLite for data you want to keep.
:::

:::note
The query worker also contains a `postgres` branch, but there is no PostgreSQL setup script and parts of the engine write MySQL specific SQL. Treat it as unsupported.
:::

### Statements are written for MySQL

The systems write MySQL's SQL. SQLite does not read two of its forms, so `sqlWrapper` (`src/controllers/sqlescape.ts`) rewrites them when the engine is SQLite. Single queries and transactions both pass through it.

| Written in a system | Sent to SQLite |
|---------------------|----------------|
| `INSERT IGNORE INTO ...` | `INSERT OR IGNORE INTO ...` |
| `... ON DUPLICATE KEY UPDATE a = ?` | `... ON CONFLICT DO UPDATE SET a = ?` |
| `VALUES(a)` inside that update | `excluded.a` |

Only the statement's own words are rewritten. A value that happens to contain them, or a quoted part of the statement, is left as it is. Nothing else is translated: a statement that uses another MySQL-only function or type will fail on SQLite, so write new statements with SQL both engines read.

:::note Rows changed by an upsert
MySQL counts an upsert as 1 row when it inserts, 2 when it updates, and 0 when the row already held the same values. SQLite counts 1 for both. Do not put `mustChange` (see Transactions below) on an upsert that may write the same values back.
:::

Several systems compare names the way the database would, so that a cached list and a `WHERE name = ?` agree:

```ts title="src/systems/weather.ts"
// The weathers a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
  (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
```

## Setup scripts

The scripts create every table with `CREATE TABLE IF NOT EXISTS` and insert seed rows only when they are missing, so they can be run again safely.

:::tabs
```bash title="MySQL (production)"
# Writes the config files if missing, then creates the schema
bun setup-production

# Or only the schema, using .env.production
bun setup
```
```bash title="SQLite (local)"
# Set DATABASE_ENGINE=sqlite in .env.development first
bun setup-localdb
```
:::

| Script | File | Environment file |
|--------|------|------------------|
| `bun setup` | `src/utility/database_setup.ts` | `.env.production` |
| `bun setup-production` | `create-config --environment production`, then `bun setup` | `.env.production` |
| `bun setup-localdb` | `src/utility/database_setup_sqlite.ts` | `.env.development` |

The MySQL script first runs `CREATE DATABASE IF NOT EXISTS` and `USE` for `DATABASE_NAME`. To run it against your development database, call it with the other environment file:

```bash title="MySQL schema for development"
bun --env-file=.env.development ./src/utility/database_setup.ts
```

Besides the tables, the scripts seed:

- The permission types (`admin.*`, `server.*`, `tools.*` and so on). See [Permissions](#/engine/permissions).
- A default spell, a default mount and demo quests.
- The weathers `clear`, `thunderstorm`, `darkness`, `rainy` and `snowy`.
- The world `overworld` with the weather `rainy` (the SQLite script also adds a world named `default`).
- A demo account named `demo_user` with stats, client settings and permissions.
- Indexes.

:::danger Change the demo account
The seeded `demo_user` account has a publicly known default password and admin permissions. Change its password or remove it before you let anyone else reach the server. See [Quick start](#/getting-started/quick-start).
:::

:::note The gateway shares this database
Accounts are created by the gateway, and the gateway's own setup adds columns the engine reads (for example `twofa_pending` on `accounts`). Run the gateway's setup as well. See the gateway's [Configuration](#/gateway/configuration) page.
:::

## The query function

All database access goes through the default export of `src/controllers/sqldatabase.ts`. Never open a connection yourself.

```ts title="src/controllers/sqldatabase.ts"
export default async function query<T>(sql: string, values?: any[]): Promise<T[]>
```

```ts title="Running queries"
import query from "@engine/controllers/sqldatabase";

// SELECT returns an array of rows
const rows = await query<{ copper: number; silver: number; gold: number }>(
  "SELECT copper, silver, gold FROM currency WHERE username = ?",
  [username]
);
const balance = rows[0] ?? null;

// An array value expands to a list, for IN (...)
const sessions = await query(
  "SELECT id, session_id FROM accounts WHERE id IN (?)",
  [[1, 2, 3]]
);

// INSERT, UPDATE and DELETE take values the same way
await query("INSERT INTO whitelist (realm, username) VALUES (?, ?)", [realm, username]);
```

### Placeholders

Each `?` is replaced by one value, escaped for the configured engine, before the statement is sent (`src/controllers/sqlescape.ts`).

| JavaScript value | Written as |
|------------------|-----------|
| `null`, `undefined` | `NULL` |
| string | A quoted string, quotes doubled. On MySQL backslashes are escaped too. |
| number | The number |
| boolean | `1` or `0` |
| `Date` | `'YYYY-MM-DD HH:MM:SS'` (UTC) |
| array | Its values, comma separated. An empty array throws. |
| anything else | `String(value)`, quoted |

The number of `?` must equal the number of values, or the call throws `Number of placeholders does not match number of parameters`.

:::warning Only values are escaped
Table and column names are not placeholders. Never build them from user input. Always pass user supplied data as values.
:::

### The worker pool

`query` does not talk to the database on the main thread. It posts the statement to a worker and resolves when the worker answers.

```ts title="src/controllers/sqldatabase.ts"
export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const queryId = `query_${++queryIdCounter}_${Date.now()}`;
    const worker = getNextWorker();
    // ... a 30 second timeout is armed, then:
    worker.postMessage({ id: queryId, sql, values: values || [] });
  });
}
```

| Property | Value |
|----------|-------|
| Pool size | `DB_WORKER_POOL_SIZE`, default 8, at most 64 |
| Worker choice | Round robin |
| Connections | Each worker opens its own (MySQL: a pool of up to 10 per worker) |
| Startup | The module waits for every worker to connect. A worker retries for 30 seconds, and the pool gives up after 60 seconds. |
| Timeout in the worker | 15 seconds per attempt |
| Retries in the worker | Up to 3 attempts, 1 second apart, only for connection errors and timeouts |
| Timeout on the main thread | 30 seconds, then the promise rejects with `Query timeout after 30 seconds` |

Because statements are spread over workers, two statements sent one after the other without `await` may reach the database in either order. When order matters, `await` the first, or run both through a `turns()` queue (see [Caching](#/engine/caching/one-change-at-a-time-turns)).

:::warning A timed out write may still have happened
A rejected `query` does not prove the statement was not applied. Code that keeps a cached copy drops that copy when a write throws, so the next read loads the truth. Follow the same pattern.
:::

`drainQueries()` (a named export of the same module) resolves once every statement sent so far has been answered or has timed out.

## Transactions

Statements sent with `query` are separate: each may land on another worker and another connection. When several writes must all be kept or all be undone, send them together with `transaction`, a named export of the same module.

```ts title="src/controllers/sqldatabase.ts"
export async function transaction(statements: TransactionStatement[]): Promise<any[]>

interface TransactionStatement {
  sql: string;
  values?: any[];
  mustChange?: boolean;
}
```

```ts title="All or nothing"
import { transaction, GuardError } from "@engine/controllers/sqldatabase";

try {
  await transaction([
    {
      sql: "UPDATE my_plugin_scores SET points = points - ? WHERE username = ? AND points >= ?",
      values: [cost, username, cost],
      mustChange: true,
    },
    { sql: "INSERT INTO my_plugin_unlocks (username, unlock) VALUES (?, ?)", values: [username, unlock] },
  ]);
} catch (error) {
  if (error instanceof GuardError) {
    // Statement number error.statement changed no rows: not enough points. Nothing was written.
  }
}
```

| Behaviour | Detail |
|-----------|--------|
| Where it runs | The whole list goes to one worker and runs on one connection, in order |
| Result | One result per statement, as `query` would give it |
| A statement fails | Everything is undone and the call throws the database's error |
| `mustChange: true` | Everything is undone and the call throws a `GuardError` when that statement changes no rows |
| Timeout | 15 seconds for the whole list, then it is undone |
| Retries | Only when the transaction never opened. One that opened is never sent a second time. |

:::warning mustChange counts rows that changed
MySQL does not count a row that already held the values written. Use `mustChange` on statements that change what they find (`points = points - ?`), not on ones that may write the same value back.
:::

A `mustChange` statement puts a check and a write in one step that no other write can come between. That is what keeps coins from being spent twice and an item from being given away twice.

### Changes that span systems

The inventory, the currency, the stats and the quest log each hold their own cached rows and queue their own writes. A change made of several of them (a quest hand-in gives items, experience and coins and completes the quest) goes through a batch from `src/services/batch.ts`:

```ts title="One change, several systems"
import { atomically } from "@engine/services/batch";
import currency from "@engine/systems/currency";
import inventory from "@engine/systems/inventory";

await atomically([buyer], async (batch) => {
  await currency.remove(buyer, price, batch);
  await inventory.add(buyer, { name: "Health Potion", quantity: 1 }, batch);
});
```

A system call that is handed the batch adds its statement to it instead of sending it. When the function returns, the batch sends everything as one `transaction`. Only then does each system update the rows it holds. If the transaction is not kept, each system drops the rows it holds for those players and the call throws.

| Rule | Why |
|------|-----|
| Name every player whose rows change | A batch waits for any other batch of the same players, so two of them never work from the same rows |
| Hand the batch to every system call inside it | A call without it would wait for a turn the batch holds until it ends |
| Do not start a batch inside another for the same player | The inner one would wait for the outer one |
| Throw inside the function to cancel | Nothing is sent and no cached row changes |
| Read what you need before or inside the function | Reads see the rows as they were until the transaction is kept |

These calls accept a batch today:

| Call | Notes |
|------|-------|
| `inventory.add(name, item, batch)` | Resolves to `true` when a statement was added |
| `inventory.remove(name, item, batch)` | Resolves to `undefined` when the player holds none of the item |
| `currency.add(username, amount, batch)` | Resolves to the balance after |
| `currency.remove(username, amount, batch)` | Resolves to the balance after |
| `player.increaseXp(username, xp, batch)` | Resolves to the experience and level after |
| `writeQuestRowsIn(batch, username, write)` | From `src/systems/quests/log.ts`, for quest log rows |

Quest hand-ins, corpse loot, chest loot and saving inventory slots use this, so each of them is kept whole or not at all.

## Reads come from caches

This is the most important rule for engine and plugin code:

:::danger The rule
Requests from clients never read the database. They read from a cache. A change writes the database first, then updates the cache.
:::

The caches are described on the [Caching](#/engine/caching) page. In short:

- Static game data (items, spells, NPCs, maps) is in `assetCache`, loaded at startup.
- Online players are in `playerCache`.
- Rows that belong to a player or to a small table are held by `rowCache` and `tableCache` from `src/services/datacache.ts`.

A system therefore has exactly one place that selects, the `load` function of its cache:

```ts title="src/systems/currency.ts"
const rows = rowCache<Currency>("currency", async (username) => {
  const response = await query("SELECT copper, silver, gold FROM currency WHERE username = ?", [username]) as Currency[];
  return response[0] ?? null;
}, { perPlayer: true });

const currency = {
  async get(username: string): Promise<Currency> {
    if (!username) return { copper: 0, silver: 0, gold: 0 };
    return (await rows.get(username)) ?? { copper: 0, silver: 0, gold: 0 };
  },
  // ...
};
```

And every write goes database first, cache second:

```ts title="Write order"
await query("UPDATE worlds SET name = ?, weather = ? WHERE name = ?", [name, weather, name]); // 1. database
await assetCache.set("worlds", updatedList);                                                  // 2. cache
```

Where the database is still read directly:

| Where | Why |
|-------|-----|
| A cache's `load` function | To fill the cache |
| The login worker threads | Caches are off there, a login reads fresh rows |
| Startup (`assetloader.ts`, `loadTables()`) | To fill the caches |
| The once a minute session check and save | Server side housekeeping, not a client request |

## Main tables

Created by `src/utility/database_setup.ts`. Column lists are shortened to the ones you are most likely to need.

### Accounts and characters

| Table | Holds | Key columns |
|-------|-------|-------------|
| `accounts` | One row per account and character | `id`, `username`, `email`, `password_hash`, `role`, `banned`, `map`, `position`, `direction`, `session_id`, `party_id`, `guild_id`, `guest_mode`, `is_dead` |
| `stats` | Health, stamina, level and stat bonuses | `username`, `health`, `max_health`, `stamina`, `max_stamina`, `xp`, `max_xp`, `level` |
| `clientconfig` | Per player client settings | `username`, `fps`, `music_volume`, `effects_volume`, `muted`, `hotbar_config`, `inventory_config` |
| `permissions` | Permissions of a user, comma separated | `username`, `permissions` |
| `permission_types` | Every permission name that exists | `name` |
| `whitelist` | Usernames allowed on a realm | `realm`, `username` |

### Items and belongings

| Table | Holds | Key columns |
|-------|-------|-------------|
| `items` | Item definitions. `sell_price` is what a vendor pays for one, in copper (1 unless set, 0 for an item vendors do not buy). A consumable gives back `restore_health` and `restore_stamina` when used, and `no_combat` (0 or 1) keeps it from being used in a fight. `teleports_home` (0 or 1) marks the one home item. | `name`, `type`, `quality`, `equipment_slot`, `level_requirement`, `sell_price`, `restore_health`, `restore_stamina`, `no_combat`, `teleports_home`, the `stat_*` columns |
| `inventory` | What each player carries | `username`, `item`, `quantity`, `equipped`, `slot`, `bag_slot` |
| `equipment` | What each player wears, one column per slot | `username`, `helmet`, `chestplate`, `weapon` and the other slots |
| `bags` | Equipped bags | `username`, `slot_1` to `slot_4` |
| `currency` | Coins | `username`, `copper`, `silver`, `gold` |
| `mounts` | Mount definitions | `name`, `description`, `particles`, `icon` |
| `collectables` | Collected mounts and similar | `username`, `type`, `item` |
| `loot_tables`, `loot_table_items` | Loot tables and their entries | `name`; `loot_table_id`, `item_name`, `min_quantity`, `max_quantity`, `drop_chance` |

### Spells, quests and the world

| Table | Holds | Key columns |
|-------|-------|-------------|
| `spells` | Spell definitions. See [Spells](#/engine/spells). | `name`, `damage`, `mana`, `range`, `cast_time`, `cooldown`, `effects` |
| `learned_spells` | Which player knows which spell | `username`, `spell` |
| `quests` | Quest definitions. See [Quests](#/engine/quests). | `id`, `name`, `required_level`, `xp_reward`, `repeatable` |
| `quest_prerequisites`, `quest_objectives`, `quest_rewards`, `npc_quests` | The parts of a quest | `quest_id` |
| `quest_log`, `quest_objective_progress` | Each player's quest state and progress | `username`, `quest_id` |
| `npcs` | NPCs, their position, dialog and sprites. `vendor_items` is what a vendor stocks, as JSON: a list of `{ item, price }` with the price in copper. `innkeeper` (0 or 1) lets players make the NPC's inn their home. | `id`, `name`, `map`, `position`, `dialog`, `quest_giver`, `vendor_items`, `innkeeper` |
| `particles` | Particle definitions | `name` |
| `weather` | Weathers. See [Weather](#/engine/weather). | `name`, `temperature`, `humidity`, `wind_speed`, `wind_direction`, `precipitation`, `ambience` |
| `worlds` | Each world and the weather it is set to | `name`, `weather` |

### Social

| Table | Holds | Key columns |
|-------|-------|-------------|
| `friendslist` | A player's friends, comma separated | `username`, `friends` |
| `ignores` | Who each player ignores, one row per pair | `username`, `ignored`, `created_at` |
| `mutes` | Chat mutes. No `expires_at` is a mute until it is lifted. | `username`, `muted_by`, `reason`, `created_at`, `expires_at` |
| `reports` | Reports players sent about each other, with the chat lines attached | `id`, `reporter`, `target`, `category`, `details`, `chat_log`, `status`, `resolved_by`, `resolution` |
| `player_home` | Each player's home. `npc_id` is the innkeeper it was set at (empty: none, the world's spawn is used), `offset_x` and `offset_y` are where the player stood from that NPC, and `used_at` is when they last went home, in milliseconds (0: never). The hour between uses is counted from it. | `username`, `npc_id`, `offset_x`, `offset_y`, `used_at` |
| `trade_log` | Every trade two players completed. `a_gave` and `b_gave` are JSON: the items and coins each handed over. | `id`, `player_a`, `player_b`, `a_gave`, `b_gave`, `created_at` |
| `parties` | Parties: the leader and the member list | `id`, `leader`, `members` |
| `guilds` | Guilds, their members, bank and rank permissions | `id`, `name`, `leader`, `members`, `bank`, `rank_permissions` |

### Creatures

| Table | Holds |
|-------|-------|
| `creature_templates` | What a creature is: level range, health, damage, speeds, loot table, sprite |
| `creature_abilities` | Spells a template casts and when |
| `creature_spawns` | Where templates spawn: map, position, respawn times, movement type |
| `creature_patrol_paths` | Patrol routes |
| `creature_link_groups` | Groups of spawns that fight together |
| `creature_spawn_pools` | Pools that limit how many spawns are active |

### Differences in the SQLite script

`src/utility/database_setup_sqlite.ts` creates the same tables with these differences:

| Table | MySQL script | SQLite script |
|-------|--------------|---------------|
| `allowed_ips`, `blocked_ips` | Not created | Created (`127.0.0.1` and `::1` are inserted as allowed) |

Apart from that, the SQLite script gives every table the same columns as the MySQL one.

An older SQLite database may lack tables and columns that were added to the script later: `bags`, `loot_tables`, `loot_table_items`, the `slot` and `bag_slot` columns of `inventory`, `bag_slots` on `items`, and the `name` and `sprite_*` columns of `npcs`. Run `bun setup-localdb` again to add them. The script is safe to run again and keeps your rows.

The two-factor columns of `accounts` (`twofa_pending` and the rest) are added by the Gateway's own setup script on both engines, so run that as well.

## Adding your own table

A plugin or a new system that needs storage follows the same three steps as the built in systems:

```ts title="A cached table of your own"
import query from "@engine/controllers/sqldatabase";
import { rowCache, turns } from "@engine/services/datacache";

type Score = { username: string; points: number };

// 1. The one place that reads the database
const rows = rowCache<Score>("my_plugin_scores", async (username) => {
  const result = await query<Score>("SELECT username, points FROM my_plugin_scores WHERE username = ?", [username]);
  return result[0] ?? null;
}, { perPlayer: true });

const oneAtATime = turns();

export const scores = {
  // 2. Reads only touch the cache
  async get(username: string): Promise<number> {
    return (await rows.get(username))?.points ?? 0;
  },

  // 3. Writes: database first, then the cache. Drop the cached row if the write throws.
  async add(username: string, points: number): Promise<number> {
    return oneAtATime(username, async () => {
      const next = (await scores.get(username)) + points;
      try {
        // MySQL syntax, as the built in currency system uses
        await query(
          "INSERT INTO my_plugin_scores (username, points) VALUES (?, ?) ON DUPLICATE KEY UPDATE points = ?",
          [username, next, next]
        );
      } catch (error) {
        await rows.drop(username);
        throw error;
      }
      await rows.set(username, { username, points: next });
      return next;
    });
  },
};
```

Create the table itself once, for example from your plugin's `register` function with a `CREATE TABLE IF NOT EXISTS` statement. See [Plugins](#/engine/plugins).
