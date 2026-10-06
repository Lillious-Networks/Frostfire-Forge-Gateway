---
title: Permissions
description: How permission nodes are named, stored, granted and checked, with a table of every node the engine uses.
order: 90
---

Permissions decide which admin commands and tools a player can use. This page covers how they are stored, how the engine checks them, how to grant them, and every node name that appears in the code.

## The two layers

An account has two separate things, and most admin features need the right one of them:

| Layer | Where it lives | What it is |
|-------|----------------|------------|
| Admin role | `accounts.role` (`1` is admin) | A single on or off flag, toggled with `/admin`. On the player object it is `isAdmin`. |
| Permissions | `permissions` table, one row per player | A comma-separated list of node names such as `admin.ban,tools.*` |

The role and the list are independent. Holding `admin.*` does not make a player an admin, and being an admin gives no permission node. The two meet in one rule: `/permission add` and `/permission set` only work on a player who already has the admin role.

## Storage

```sql title="Tables created by the setup script"
CREATE TABLE IF NOT EXISTS permissions (
  username VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY,
  permissions VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_types (
  name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
);
```

`permissions.permissions` holds the whole list for one player as text, for example `admin.*,server.*,permission.*`. A player with no permission has no row.

`permission_types` is the list of names that may be granted. The setup script fills it and nothing writes to it while the server runs.

:::warning The list is limited to 255 characters
The column is 255 characters wide. The player editor and the control panel refuse a list that is longer. Use the wildcard nodes to keep lists short.
:::

## How permissions are loaded

At login the engine reads the player's row and splits it on commas into an array on the live player object:

```ts title="src/socket/receiver.ts"
permissions: typeof playerData.permissions === "string"
  ? (playerData.permissions as string).split(",")
  : playerData.permissions || [],
```

Most checks read that array. `/permission` and the player editor update it for an online player as soon as they change the database, so a change applies without a relog.

A few checks do not trust the login copy and read the stored list on every packet instead: saving a map, the particle and NPC save packets, and the spell, weather and player editors. Those reads are answered from the engine's data cache, not from the database. See [Caching](#/engine/caching).

## How a check works

There is no pattern matching. Every check is a plain comparison against the exact names it accepts, and the wildcard of the group is one of those names:

```ts title="src/socket/receiver.ts"
if (
  !currentPlayer.permissions.some(
    (p: string) => p === "admin.ban" || p === "admin.*"
  )
) {
  sendPacket(wt, packetManager.notify({
    message: "You don't have permission to use this command",
  }));
  break;
}
```

What follows from that:

- `admin.*` is a literal node. It works because every `admin.` check lists it, not because `*` is expanded.
- A wildcard only covers its own group. `admin.*` does not satisfy a `server.` or `tools.` check.
- A name that no check lists does nothing, even if it looks like it should. `admin.ba*` or `*` grant nothing.
- A few checks accept more than one group. The item, quest and creature editors also accept `server.*`, and the spell and weather editors also accept `server.admin` and `server.*`.

## Wildcards

| Wildcard | Covers |
|----------|--------|
| `admin.*` | Every `admin.` node in the table below |
| `server.*` | Every `server.` node. Also opens the item, quest, creature, spell and weather editors, and lets its holder grant any permission |
| `permission.*` | `permission.add`, `permission.remove` and `permission.list`. Also lets its holder grant any permission |
| `tools.*` | Every `tools.` node |

## All nodes

Every node name found in the engine source, and where it is checked.

| Node | Used by | Seeded |
|------|---------|--------|
| `admin.*` | Wildcard for every `admin.` node | Yes |
| `admin.ban` | `/ban` | Yes |
| `admin.unban` | `/unban` | Yes |
| `admin.kick` | `/kick`, `/disconnect` | No |
| `admin.kill` | `/kill` | Yes |
| `admin.revive` | `/revive` | Yes |
| `admin.respawn` | `/respawn` | Yes |
| `admin.summon` | `/summon`, `/goto`, `/teleport` | No |
| `admin.summonadmins` | Needed on top of `admin.summon` to summon a player who is an admin | Yes |
| `admin.warp` | `/warp` | Yes |
| `admin.weather` | `/weather` | Yes |
| `admin.reloadmap` | `/reloadmap` | No |
| `admin.whitelist` | `/whitelist` | Yes |
| `admin.permission` | `/permission` (the command itself) | Yes |
| `admin.items` | `/give`, `/drop`, `/spawnchest` | MySQL only |
| `admin.loot` | `/loottable`, `/looteditor`, every loot editor packet | MySQL only |
| `admin.drag` | Dragging another player (`DRAG_PLAYER_START`, `DRAG_UPDATE`, `DRAG_PLAYER_STOP`) | Yes |
| `admin.disconnect` | Nothing. Seeded, but no check reads it | Yes |
| `permission.*` | Wildcard for the three nodes below | Yes |
| `permission.add` | `/permission add` and `set`, adding permissions in the player editor | Yes |
| `permission.remove` | `/permission remove` and `clear`, removing permissions in the player editor | Yes |
| `permission.list` | `/permission list` | Yes |
| `server.*` | Wildcard for every `server.` node | Yes |
| `server.admin` | `/admin`, `/player edit` and the player editor, saving a map, saving, renaming, deleting and testing particles, adding, saving, moving and deleting NPCs, the spell and weather editors | Yes |
| `server.gateway` | Opening the gateway monitoring dashboard (with the admin role). See [Monitoring Dashboard](#/gateway/dashboard/logging-in) | Yes |
| `server.notify` | `/notify`, `/broadcast` | Yes |
| `server.restart` | `/restart` | Yes |
| `server.shutdown` | `/shutdown` | Yes |
| `tools.*` | Wildcard for every `tools.` node | Yes |
| `tools.tile_editor` | `/tileeditor` | Yes |
| `tools.npc_editor` | `/npceditor`, listing particles for the NPC editor | Yes |
| `tools.particle_editor` | `/particleeditor`, listing particles | Yes |
| `tools.creature_editor` | `/creatureeditor` and every creature editor packet | MySQL only |
| `tools.item_editor` | `/itemeditor` and every item editor packet | MySQL only |
| `tools.spell_editor` | `/spelleditor` and every spell editor packet | MySQL only |
| `tools.quest_editor` | `/questeditor` and every quest editor packet | MySQL only |
| `tools.weather_editor` | `/weathereditor` and every weather editor packet | Yes |
| `tools.entity_editor` | Nothing. Seeded by the SQLite setup only, no check reads it | SQLite only |

"Seeded" means the setup script inserts the name into `permission_types`. "MySQL only" means `src/utility/database_setup.ts` inserts it and `src/utility/database_setup_sqlite.ts` does not.

### Nodes that are not seeded

`/permission add`, `/permission set`, the player editor and the control panel all reject a name that is not in `permission_types`:

```text title="Result of granting an unseeded node"
/permission add alice admin.kick
Invalid permission: admin.kick
```

`admin.kick`, `admin.summon` and `admin.reloadmap` are checked by their commands but are missing from the seed, so with a freshly set up database only a holder of `admin.*` can use `/kick`, `/summon`, `/goto` and `/reloadmap`. To hand them out one at a time, add the names yourself:

```sql title="Make the three nodes grantable"
INSERT INTO permission_types (name) VALUES
  ('admin.kick'),
  ('admin.summon'),
  ('admin.reloadmap');
```

The same applies to the "MySQL only" rows on a SQLite development database.

:::note Restart after editing permission_types
The engine reads `permission_types` into its data cache at startup and nothing refreshes it while the server runs. Restart the engine after inserting rows.
:::

## Features that check the admin role

These do not look at the permission list at all. They only ask whether the player's role is admin.

| Feature | Rule |
|---------|------|
| `/controlpanel` and every control panel packet | Admin role, has a username, not a guest |
| `NOCLIP` and `STEALTH` packets | Admin role |
| Map editor live sync (`EDITOR_OPEN`, `EDITOR_TILE_EDIT`, `EDITOR_LAYER_LOCK`) | Admin role |
| Item, quest, creature, spell and weather editors | Admin role is enough by itself, a matching `tools.` node also works |

The loot editor and the player editor are the exceptions among the tools: being an admin is not enough for them. The loot editor needs `admin.loot` or `admin.*`, and the player editor needs `server.admin` or `server.*`.

## Granting permissions

### With the command

```text title="In-game"
/admin alice
/permission add alice admin.ban,admin.unban
/permission list alice
```

The granter needs `admin.permission` (or `admin.*`) plus the permission of the mode, and can only hand out a node they hold themselves unless they hold `permission.*` or `server.*`. The full rules are on the [Admin Commands](#/engine/admin-commands/permissions) page.

### With the tools

The [Player Editor](#/tools/player-editor) and the [Control Panel](#/tools/control-panel) apply the same rules as the command, including the admin role requirement and the check that the granter holds what they give.

### With SQL

For the first admin of a fresh server there is nobody to run the command, so write the rows directly. Set the role and the list, then log in again:

```sql title="Make the first admin"
UPDATE accounts SET role = 1 WHERE username = 'alice';

INSERT INTO permissions (username, permissions)
VALUES ('alice', 'admin.*,server.*,permission.*,tools.*')
ON DUPLICATE KEY UPDATE permissions = VALUES(permissions);
```

The engine reloads a player's cached rows when they log in, so a row written with SQL while the player is online is not picked up until their next login.

## The permissions module

`src/systems/permissions.ts` is the only code that reads or writes the two tables. It keeps each player's row in the data cache and writes the database first, then the cache.

| Method | Returns | What it does |
|--------|---------|--------------|
| `permissions.get(username)` | `Promise<string>` | The stored comma-separated list, or `""` when the player has none |
| `permissions.set(username, list)` | `Promise<void>` | Replaces the list. Takes one name or an array, and removes duplicates |
| `permissions.add(username, name)` | `Promise<void>` | Adds one node if it is not already held |
| `permissions.remove(username, name)` | `Promise<void>` | Removes one node if it is held |
| `permissions.clear(username)` | `Promise<void>` | Deletes the player's row |
| `permissions.list()` | `Promise<string[]>` | Every name in `permission_types` |

```ts title="Checking a permission from a plugin"
import permissions from "@engine/systems/permissions";

async function mayModerate(username: string): Promise<boolean> {
  const held = String(await permissions.get(username)).split(",").filter(Boolean);
  return held.includes("admin.ban") || held.includes("admin.*");
}
```

For an online player it is cheaper to read the array that is already on the player object:

```ts title="Checking the live player object"
const mayBan = player.permissions?.some(
  (p: string) => p === "admin.ban" || p === "admin.*"
);
```

:::warning The module does not validate names
`permissions.add` and `permissions.set` store whatever they are given. The check against `permission_types`, the admin role requirement and the audit log line all live in the `/permission` handler and the player editor, not in this module. A plugin that calls the module directly has to apply its own rules.
:::
