---
title: Plugins
description: How the engine discovers and loads plugins, what goes in manifest.json, the register and unregister hooks, and a complete worked example.
order: 150
---

A plugin is a folder under `src/plugins/` with a `manifest.json` and an entry module. The engine finds it at startup, imports it, and hands it an API object it can use to add packets, HTTP routes, spells and event listeners without touching engine source. This page covers discovery, the manifest, the two hooks, what a plugin may import, and a full example.

The methods on the API object are documented one by one on the [Engine API](#/engine/engine-api) page, and the events a plugin can subscribe to are on [Listener Events](#/engine/listener-events).

## Where plugins live

```text title="Layout"
src/plugins/
  welcome/
    manifest.json
    src/
      index.ts
```

`src/plugins/` is listed in the engine's `.gitignore`, so the folder is empty in a fresh checkout and plugins are kept in their own repositories. Clone or copy a plugin into the folder, or link it in: the loader follows symbolic links.

## How plugins are loaded

Loading is done by `src/modules/plugin_loader.ts`, called from `src/socket/server.ts` during startup.

1. `loadPlugins` scans `src/plugins/`. If the folder itself holds a `manifest.json` it is loaded as a plugin. Then every sub-folder (or symbolic link) that holds a `manifest.json` is loaded. Folders without one are skipped.
2. For each plugin the manifest is parsed and checked, the entry file is imported, and its default export is stored. Spells in the manifest are collected. `onPluginLoad` is emitted.
3. `mergePluginSpellsIntoCache` adds the collected spells to the asset cache.
4. The engine builds the `EngineAPI` object.
5. `registerAllPlugins` calls each plugin's `register(engine, manifest)`. `onPluginInitialize` is emitted just before the call and `onPluginRegister` after it resolves.

```ts title="src/socket/server.ts"
listener.emit(Events.AWAKE);
listener.emit(Events.START);

gameLoop.start();
await creatures.init();
// ...
await loadPlugins(listener);
await mergePluginSpellsIntoCache();

const engineApi: EngineAPI = { /* ... */ };

const registered = await registerAllPlugins(engineApi, listener);
```

Things that follow from that order:

- Plugins load after the HTTP and WebTransport servers are listening, after the gateway registration, and after assets and creatures are loaded. A plugin can read the asset cache straight away.
- `onAwake` and `onStart` are emitted before plugins are loaded. A listener for either that is added inside `register` never fires.
- `register` functions are started one after another but not awaited one by one, so two plugins with asynchronous `register` functions run interleaved. Do not rely on another plugin having finished registering.
- A plugin that throws while loading or registering is logged and skipped. The server keeps starting.

### What the loader checks

| Check | Result when it fails |
|-------|----------------------|
| `manifest.json` is valid JSON | `Failed to load plugin from <folder>` is logged, plugin skipped |
| `name`, `entry` and `provides` are present | `Invalid plugin manifest in <folder>: missing required fields`, plugin skipped |
| The `entry` file exists | `Plugin entry file not found`, plugin skipped |
| The module's default export has a `register` function | `Plugin <name> does not export a default object with a register function`, plugin skipped |

Two plugins with the same `name` overwrite each other in the loader's table, so keep names unique.

## manifest.json

```json title="src/plugins/welcome/manifest.json"
{
  "name": "welcome",
  "version": "1.0.0",
  "description": "Greets players and puts a level requirement on one warp.",
  "entry": "./src/index.ts",
  "requires": {
    "engine": ">=1.0.0"
  },
  "provides": ["welcome.greeting", "welcome.gate"]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes | Unique plugin name. Used as its key and in every log line |
| `version` | No, but always set it | Printed when the plugin loads and passed in `onPluginLoad` |
| `description` | No | Free text for people reading the manifest |
| `entry` | Yes | Path to the entry module, relative to the plugin folder |
| `requires.engine` | No | A version range. It is part of the manifest type, but the loader does not read or enforce it |
| `provides` | Yes | A list of feature names. The loader only checks that the field exists. It can be an empty array |
| `spells` | No | Spells to add to the asset cache, see [Spells in the manifest](#/engine/plugins/spells-in-the-manifest) |

```ts title="types.d.ts"
declare interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  entry: string;
  requires?: {
    engine?: string;
  };
  provides: string[];
  spells?: SpellData[];
}
```

## register and unregister

The entry module's default export is an object with a `register` function and, optionally, an `unregister` function.

```ts title="types.d.ts"
declare interface GamePlugin {
  register: (engine: EngineAPI, manifest: PluginManifest) => void | Promise<void>;
  unregister?: (manifest: PluginManifest) => void | Promise<void>;
}
```

```ts title="src/plugins/welcome/src/index.ts"
const plugin: GamePlugin = {
  async register(engine, manifest) {
    // Add packets, routes, spells and listeners here.
  },
  async unregister(manifest) {
    // Remove what register added.
  },
};

export default plugin;
```

`register` receives the [Engine API](#/engine/engine-api) object and the parsed manifest. It may be synchronous or return a promise.

:::warning unregister is not called by the engine
The loader exports `unregisterPlugin(name)`, which calls a plugin's `unregister` and emits `onPluginUnregister`. Nothing in the engine calls it today: plugins are not unloaded at shutdown and there is no reload command. Write `unregister` so it is correct, but do not depend on it running.
:::

`EngineAPI`, `PluginManifest`, `GamePlugin`, `PluginHandlerFn` and `SpellData` are global types declared in the root `types.d.ts`. They need no import.

## Imports available to plugins

The `tsconfig.json` path alias `@engine/*` points at `src/*`, so a plugin can import any engine module without counting `../` segments.

```ts title="Common imports"
import log from "@engine/modules/logger";
import packet from "@engine/modules/packet";
import playerCache from "@engine/services/playermanager";
import assetCache from "@engine/services/assetCache";
import cooldownManager from "@engine/services/cooldownmanager";
import { packetManager } from "@engine/socket/packet_manager";
import { packetTypes } from "@engine/socket/types";
import { topicBus } from "@engine/socket/topics";
import { listener, Events } from "@engine/systems/events";
import permissions from "@engine/systems/permissions";
import query from "@engine/controllers/sqldatabase";
```

| Module | What it gives you |
|--------|-------------------|
| `@engine/modules/logger` | `log.info`, `log.warn`, `log.error`, `log.success`, `log.debug`, `log.trace`. Use it instead of `console` |
| `@engine/modules/packet` | `packet.encode(string)` and `packet.decode(buffer)` |
| `@engine/services/playermanager` | The live player cache: `get(id)`, `getByUsername(name)`, `list()`, `set(id, player)` |
| `@engine/services/assetCache` | Static game data: `await assetCache.get("spells")`, `"items"`, `"npcs"`, `"particles"`, `"weather"` and more |
| `@engine/services/cooldownmanager` | Spell cooldowns and lockouts per player |
| `@engine/socket/packet_manager` | `packetManager`, the built-in packet builders such as `packetManager.notify({ message })` |
| `@engine/socket/types` | `packetTypes`, the packet type registry |
| `@engine/socket/topics` | `topicBus`, publish and subscribe for groups of connections |
| `@engine/systems/events` | `listener` and the `Events` name constants |
| `@engine/systems/permissions` | Reading and writing permission lists |
| `@engine/controllers/sqldatabase` | `query(sql, values)`, the only supported way to reach the database |

:::danger Never import the server entry point
`@engine/socket/server` boots the whole engine as a side effect of being imported. A plugin must not import it.
:::

See [Caching](#/engine/caching) for the two caches and [Database](#/engine/database) for `query`.

## A complete example

The engine ships no plugin, so this one is written against the loader's contract above. It does five things:

- greets a player with a notification whenever they enter a map,
- blocks one warp for players below a level,
- observes a built-in packet without consuming it,
- sends a custom packet to the client on level up,
- exposes a small HTTP status route.

```json title="src/plugins/welcome/manifest.json"
{
  "name": "welcome",
  "version": "1.0.0",
  "description": "Greets players and puts a level requirement on one warp.",
  "entry": "./src/index.ts",
  "provides": ["welcome.greeting", "welcome.gate"]
}
```

```ts title="src/plugins/welcome/src/index.ts"
import log from "@engine/modules/logger";
import packet from "@engine/modules/packet";
import playerCache from "@engine/services/playermanager";
import { packetManager } from "@engine/socket/packet_manager";
import { listener, Events } from "@engine/systems/events";

const GATED_MAP = "dungeon_inside";
const REQUIRED_LEVEL = 10;

let declinedQuests = 0;

/** Builders return an array of encoded frames. Send each one. */
function send(wt: any, frames: Uint8Array[]): void {
  if (!wt || wt.readyState !== 1) return;
  for (const frame of frames) wt.send(frame);
}

function onMapEnter({ player, mapName }: { player: any; mapName: string }): void {
  send(player?.wt, packetManager.notify({ message: `Welcome to ${mapName}, ${player.username}.` }));
}

function onLevelUp({ player, level }: { player: any; level: number }): void {
  // welcomeLevel is the builder added in register below.
  send(player?.wt, (packetManager as any).welcomeLevel({ level }));
}

const plugin: GamePlugin = {
  async register(engine, manifest) {
    // 1. A custom packet the server sends to the client.
    engine.addPacketTypes(["WELCOME_LEVEL"]);
    engine.addPacketBuilders({
      welcomeLevel: (data: { level: number }) => [
        packet.encode(JSON.stringify({ type: "WELCOME_LEVEL", data })),
      ],
    });

    // 2. Event listeners.
    listener.on(Events.MAP_ENTER, onMapEnter);
    listener.on(Events.PLAYER_LEVEL_UP, onLevelUp);

    // 3. Watch a built-in packet. Returning false lets the engine handle it as usual.
    engine.onPacket((type) => {
      if (type === "QUEST_DECLINE") declinedQuests++;
      return false;
    });

    // 4. Put a level requirement on every warp that leads to one map.
    engine.onWarpCollision(async (warp, wt, player, sendPacket) => {
      if (String(warp.map).replace(".json", "") !== GATED_MAP) return false;
      const level = Number(player?.stats?.level) || 1;
      if (level >= REQUIRED_LEVEL) return false;
      sendPacket(wt, packetManager.notify({
        message: `You must be level ${REQUIRED_LEVEL} to enter.`,
      }));
      return true; // Handled: the engine does not move the player.
    });

    // 5. An HTTP route on the game server's HTTP port.
    engine.addHttpRoute("GET", "/plugins/welcome/status", async () =>
      Response.json({
        plugin: manifest.name,
        version: manifest.version,
        online: Object.keys(playerCache.list()).length,
        declinedQuests,
      })
    );

    log.success(`${manifest.name} v${manifest.version} is ready`);
  },

  async unregister() {
    listener.off(Events.MAP_ENTER, onMapEnter);
    listener.off(Events.PLAYER_LEVEL_UP, onLevelUp);
  },
};

export default plugin;
```

Start the server and the log shows the plugin being picked up:

```text title="Startup log"
Loaded plugin: welcome v1.0.0
Registered 1 plugin packet types
Registered 1 plugin packet builders
Registered plugin HTTP route: GET /plugins/welcome/status
welcome v1.0.0 is ready
Registered plugin: welcome
Auto-starting 1 plugin(s): welcome
```

The last two lines can appear in either order, because the engine does not wait for each `register` to finish before it logs the list.

Notes on the example:

- Handlers are kept as named functions so `unregister` can remove exactly what `register` added.
- `onPacket` and `onWarpCollision` have no way to remove an interceptor. Once added, it stays until the process exits.
- The warp interceptor is asynchronous and runs on every warp a player touches, so keep it fast and return `false` for anything that is not yours.
- The `onPlayerLevelUp` payload is `{ player, level }`. See [Listener Events](#/engine/listener-events/gameplay-events).

:::warning Packets sent from the client
The example only adds a packet that travels from the server to the client. A packet type that the client sends has a restriction in the current code, described under [Adding a packet from a plugin](#/engine/packet-types/adding-a-packet-from-a-plugin). Read it before using `registerHandlers` with a new type name.
:::

## Spells in the manifest

A manifest may carry a `spells` array of `SpellData` objects. The loader collects them while it scans plugins, and they are merged into the asset cache before any `register` function runs, so a plugin's code can already find its own spells there.

```json title="manifest.json with a spell"
{
  "name": "fire-spells",
  "version": "1.0.0",
  "entry": "./src/index.ts",
  "provides": ["fire.spells"],
  "spells": [
    {
      "id": 9001,
      "name": "fire_blast",
      "damage": 15,
      "mana": 12,
      "range": 600,
      "type": "spell",
      "cast_time": 1,
      "cooldown": 8,
      "description": "Hurls a blast of fire at the target.",
      "icon": "fire_blast",
      "can_move": 0,
      "effects": [
        { "type": "damage_over_time", "value": 3, "duration": 6, "interval": 2 }
      ]
    }
  ]
}
```

What the loader does with each spell:

| Field | Default when missing |
|-------|----------------------|
| `effects` | `[]` (also when it is not an array) |
| `type` | `"spell"` |
| `damage`, `mana`, `range`, `cast_time`, `cooldown`, `can_move` | `0` |

A spell whose `name` already exists in the cache, from the database or from another plugin, is skipped with the warning `Plugin spell "<name>" already exists in cache -- skipping`.

Plugin spells exist in memory only. They are not written to the `spells` table and the spell editor shows them read-only.

:::warning Give plugin spells an id and refresh the login workers
The loader does not assign an `id`, and the cast handler refuses a spell without one. Players also need a `learned_spells` row for the spell, and the login workers need to be told about it. The details and the fix are on the [Spells](#/engine/spells/adding-a-new-spell) page.
:::

To add a spell from code instead, use [`engine.registerSpell`](#/engine/engine-api/registerspell).

## Checklist

1. Create `src/plugins/<name>/manifest.json` with `name`, `version`, `entry` and `provides`.
2. Export a default object with `register` from the entry file.
3. Import engine modules through `@engine/`, and never import `@engine/socket/server`.
4. Log through `@engine/modules/logger`.
5. Run the engine's checks: `bun eslint`, `bun run --bun tsc --noEmit` and `bun test`. Plugin files sit under `src/`, so the type check covers them too. See [Testing](#/engine/testing).
6. Start the server with `bun development` and look for `Loaded plugin` and `Registered plugin` in the log.
