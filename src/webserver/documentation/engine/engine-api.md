---
title: Engine API
description: Reference for every method on the EngineAPI object a plugin receives, with signatures, parameters, return values and examples.
order: 160
---

`EngineAPI` is the object the engine passes to a plugin's `register` function. It has eight methods, covering packets, interceptors, HTTP routes, teleporting and spells. This page documents each one from its declaration in `types.d.ts` and its implementation in `src/socket/server.ts`.

For how a plugin is found and loaded see [Plugins](#/engine/plugins). For the event bus, which is the other half of the extension surface, see [Listener Events](#/engine/listener-events).

## The interface

```ts title="types.d.ts"
declare interface PluginHandlerFn {
  (wt: any, currentPlayer: any, data: any, sendPacketFn: (wt: any, packets: any[]) => void): Promise<void>;
}

declare interface EngineAPI {
  addPacketTypes(types: string[]): void;
  addPacketBuilders(builders: Record<string, (...args: any[]) => any[]>): void;
  registerHandlers(handlers: Record<string, PluginHandlerFn>): void;
  onWarpCollision(interceptor: (warp: any, wt: any, player: any, sendPacket: any) => Promise<boolean>): void;
  onPacket(interceptor: (type: string, data: any, wt: any, player: any) => boolean): void;
  addHttpRoute(method: string, route: string, handler: (req: Request) => Promise<Response>): void;
  teleportPlayer(playerObj: any, mapName: string, x: number, y: number): Promise<void>;
  registerSpell(spell: SpellData): Promise<void>;
}
```

Both types are global. A plugin does not import them.

| Method | Returns | Use it to |
|--------|---------|-----------|
| `addPacketTypes(types)` | `void` | Add names to the packet type registry |
| `addPacketBuilders(builders)` | `void` | Add functions to `packetManager` that build outgoing packets |
| `registerHandlers(handlers)` | `void` | Handle a packet type sent by the client |
| `onPacket(interceptor)` | `void` | See, and optionally swallow, every incoming packet |
| `onWarpCollision(interceptor)` | `void` | Decide what happens when a player walks into a warp |
| `addHttpRoute(method, route, handler)` | `void` | Add a route to the game server's HTTP API |
| `teleportPlayer(playerObj, mapName, x, y)` | `Promise<void>` | Move an online player to a map position |
| `registerSpell(spell)` | `Promise<void>` | Add a spell to the asset cache |

## Objects you are handed

Several methods pass the same three things to your callback.

### wt, the connection

`wt` is the player's WebTransport connection (`TransportConnection` in `src/socket/transport.ts`).

| Member | Meaning |
|--------|---------|
| `wt.data.id` | The session id of the connection. It is also the player's key in the player cache |
| `wt.readyState` | `1` while the connection is open |
| `wt.send(frame)` | Sends one encoded frame on the reliable stream |
| `wt.sendBestEffort(frame)` | Sends one frame as a datagram that may be lost. For updates that repeat |
| `wt.close(code, reason)` | Closes the connection |
| `wt.subscribe(topic)` / `wt.unsubscribe(topic)` | Joins or leaves a `topicBus` topic |

See [Networking](#/engine/networking) for the transport itself.

### player, the live player object

`player` (or `currentPlayer`) is the object stored in the player cache for that connection: `username`, `id`, `userid`, `isAdmin`, `isGuest`, `permissions`, `stats`, `location.map`, `location.position`, `party`, `guild_id`, `inventory`, `equipment`, `wt` and more.

:::warning player can be null
Interceptors and handlers run for every packet, including the ones a client sends before it has logged in (`PING`, `LOGIN`, `AUTH`). For those `player` is `null`. Always check it.
:::

### sendPacket

`sendPacket(wt, packets)` sends an array of encoded frames to one connection, and does nothing if the connection is not open. Packet builders return such an array, so the two fit together:

```ts title="Sending a built-in packet"
sendPacket(wt, packetManager.notify({ message: "Hello" }));
```

Outside a handler, where `sendPacket` is not passed in, send the frames yourself:

```ts title="Sending without sendPacket"
function send(wt: any, frames: Uint8Array[]): void {
  if (!wt || wt.readyState !== 1) return;
  for (const frame of frames) wt.send(frame);
}
```

## addPacketTypes

```ts title="Signature"
addPacketTypes(types: string[]): void
```

Adds each name to the `packetTypes` registry in `src/socket/types.ts`, with the name as both key and value.

| Parameter | Meaning |
|-----------|---------|
| `types` | Packet type names. By convention upper case with underscores |

```ts title="Example"
engine.addPacketTypes(["ARENA_JOIN", "ARENA_STATE"]);

import { packetTypes } from "@engine/socket/types";
packetTypes.ARENA_STATE; // "ARENA_STATE"
```

A name that already exists is overwritten with itself, so calling this twice is harmless.

:::warning Incoming types are checked against the startup list
The receiver validates each incoming packet type against a set that is built once, when `receiver.ts` is first imported. That is before plugins load, and `addPacketTypes` does not add to that set. See [Adding a packet from a plugin](#/engine/packet-types/adding-a-packet-from-a-plugin) for what this means for packets the client sends. Packets the server sends are not affected.
:::

## addPacketBuilders

```ts title="Signature"
addPacketBuilders(builders: Record<string, (...args: any[]) => any[]>): void
```

Assigns each function onto the shared `packetManager` object from `src/socket/packet_manager.ts`, under the key you give it.

| Parameter | Meaning |
|-----------|---------|
| `builders` | Map of builder name to function. Each function returns an array of encoded frames |

```ts title="Example"
import packet from "@engine/modules/packet";
import { packetManager } from "@engine/socket/packet_manager";

engine.addPacketBuilders({
  arenaState: (data: { round: number; alive: number }) => [
    packet.encode(JSON.stringify({ type: "ARENA_STATE", data })),
  ],
});

// Anywhere afterwards:
sendPacket(wt, (packetManager as any).arenaState({ round: 2, alive: 7 }));
```

The cast to `any` is needed because the builder is added at runtime and is not part of `packetManager`'s type.

:::danger A builder can replace a built-in one
The assignment is unconditional. A builder called `notify`, `chat` or any other existing name replaces the engine's own builder for every caller. Prefix your builder names with your plugin's name.
:::

## registerHandlers

```ts title="Signature"
registerHandlers(handlers: Record<string, PluginHandlerFn>): void
```

Registers one handler per packet type. When a packet of that type arrives, the receiver awaits your handler and then stops. The engine's own handling for that type does not run.

| Parameter | Meaning |
|-----------|---------|
| `handlers` | Map of packet type to handler |

Handler arguments:

| Argument | Meaning |
|----------|---------|
| `wt` | The sender's connection |
| `currentPlayer` | The sender's player object, or `null` before login |
| `data` | The packet's `data` field, as the client sent it |
| `sendPacketFn` | `sendPacket(wt, packets)`, see above |

```ts title="Example"
engine.registerHandlers({
  ARENA_JOIN: async (wt, currentPlayer, data, sendPacket) => {
    if (!currentPlayer || currentPlayer.isGuest) return;
    const arenaId = Number(data?.arenaId);
    if (!Number.isInteger(arenaId)) return;

    sendPacket(wt, packetManager.notify({ message: `Joined arena ${arenaId}` }));
  },
});
```

Behaviour to know about:

- There is one handler per type. Registering the same type again, from this plugin or another, replaces the earlier handler.
- A handler for a built-in type such as `CHAT` takes over that packet completely. Use [`onPacket`](#/engine/engine-api/onpacket) if you only want to observe it.
- Handlers run after every `onPacket` interceptor.
- Treat `data` as untrusted input. Check types and ranges before using it.
- The receiver catches and logs an error thrown by a handler.

## onPacket

```ts title="Signature"
onPacket(interceptor: (type: string, data: any, wt: any, player: any) => boolean): void
```

Adds an interceptor that is called for every incoming packet, before plugin handlers and before the engine's own handling.

| Argument | Meaning |
|----------|---------|
| `type` | The packet type |
| `data` | The packet's `data` field |
| `wt` | The sender's connection |
| `player` | The sender's player object, or `null` before login |

Return `true` to swallow the packet: nothing else sees it. Return `false` to let it continue.

```ts title="Counting chat messages without changing them"
let chatCount = 0;

engine.onPacket((type) => {
  if (type === "CHAT") chatCount++;
  return false;
});
```

```ts title="Blocking a packet for some players"
engine.onPacket((type, _data, wt, player) => {
  if (type !== "MOUNT" || !player) return false;
  if (player.location?.map !== "arena") return false;
  wt.send(packetManager.notify({ message: "You cannot mount in the arena." })[0]);
  return true;
});
```

:::danger The interceptor must be synchronous
The receiver tests the return value directly: `if (interceptor(type, data, wt, currentPlayer)) return;`. An `async` function returns a promise, a promise is truthy, and every packet from every player would be swallowed. Do asynchronous work without awaiting it, and return a plain boolean.
:::

Interceptors run in the order they were added, on every packet including movement. Keep them cheap. There is no way to remove one.

## onWarpCollision

```ts title="Signature"
onWarpCollision(
  interceptor: (warp: any, wt: any, player: any, sendPacket: any) => Promise<boolean>
): void
```

Adds an interceptor that runs when a moving player touches a warp object on the map, before the engine moves them.

| Argument | Meaning |
|----------|---------|
| `warp` | `{ map, x, y }`: the destination map name and position in pixels |
| `wt` | The player's connection |
| `player` | The player object |
| `sendPacket` | `sendPacket(wt, packets)` |

Resolve to `true` when you handled the warp yourself, and the engine does nothing more. Resolve to `false` to let the normal warp happen.

```ts title="Requiring a party for a dungeon warp"
engine.onWarpCollision(async (warp, wt, player, sendPacket) => {
  if (String(warp.map).replace(".json", "") !== "dungeon_inside") return false;

  if (!player.party_id) {
    sendPacket(wt, packetManager.notify({ message: "You need a party to enter." }));
    return true;
  }

  await engine.teleportPlayer(player, "dungeon_inside", warp.x, warp.y);
  return true;
});
```

The engine has already filtered some cases before your interceptor runs: corpses and ghosts cannot use warps, and neither can a player who is in combat. Interceptors are awaited in the order they were added and the first one that resolves to `true` ends the chain.

## addHttpRoute

```ts title="Signature"
addHttpRoute(method: string, route: string, handler: (req: Request) => Promise<Response>): void
```

Adds a route to the HTTP API the game server already serves on its port, next to `/status` and `/ping`.

| Parameter | Meaning |
|-----------|---------|
| `method` | HTTP method in upper case, for example `"GET"` or `"POST"` |
| `route` | The exact path, starting with `/` |
| `handler` | Receives the standard `Request` and resolves to a `Response` |

```ts title="Example"
engine.addHttpRoute("GET", "/plugins/arena/standings", async () => {
  return Response.json({ updated: Date.now(), standings: currentStandings() });
});

engine.addHttpRoute("POST", "/plugins/arena/reset", async (req) => {
  if (req.headers.get("authorization") !== `Bearer ${process.env.ARENA_ADMIN_TOKEN}`) {
    return new Response("Forbidden", { status: 403 });
  }
  resetStandings();
  return new Response(null, { status: 204 });
});
```

How matching works:

```ts title="src/socket/server.ts"
const routeKey = `${req.method}:${url.pathname}`;
const httpHandler = httpRouteHandlers.get(routeKey);
if (httpHandler) {
  return httpHandler(req);
}

return new Response("Not found", { status: 404 });
```

- The match is exact. There are no path parameters, wildcards or trailing-slash rules. Read variable parts from the query string with `new URL(req.url).searchParams`.
- Built-in routes are checked first and cannot be replaced: `GET /status`, `GET /creature-stats`, `GET /ping`, `GET /wt-cert-hash`, and every `OPTIONS` request.
- Registering the same method and path again replaces the earlier handler.

:::warning Routes are public and get no CORS headers
The engine adds no authentication and no CORS headers to a plugin route. Anyone who can reach the game port can call it, so check credentials yourself for anything that changes state. Because the engine answers every `OPTIONS` request itself, a plugin cannot add its own preflight handling. Keep secrets in environment variables, never in the plugin's source.
:::

## teleportPlayer

```ts title="Signature"
teleportPlayer(playerObj: any, mapName: string, x: number, y: number): Promise<void>
```

Moves an online player to a position on a map and runs the full map transition for them.

| Parameter | Meaning |
|-----------|---------|
| `playerObj` | The live player object from the player cache. It must have an open `wt` |
| `mapName` | Target map. A trailing `.json` is removed |
| `x`, `y` | Position in pixels |

```ts title="Example"
import playerCache from "@engine/services/playermanager";

const target = playerCache.getByUsername("alice");
if (target) {
  await engine.teleportPlayer(target, "overworld", 1024, 768);
}
```

What it does, through `transitionPlayerToMap` in `src/socket/receiver.ts`:

1. Moves the player between maps in the AOI system, despawning them for the old neighbours and spawning them for the new ones.
2. Emits `onMapEnter`.
3. Sends the player a fresh `LOAD_MAP`, keeping the direction they were facing.

It returns without doing anything when the player object has no connection.

:::note It does not store the location
The built-in warp and the admin commands call `player.setLocation` before the transition, which writes the new map and position for the account. `teleportPlayer` only runs the transition. The player's position is written by the usual saves, for example at logout.
:::

## registerSpell

```ts title="Signature"
registerSpell(spell: SpellData): Promise<void>
```

Adds one spell to the `spells` list in the asset cache.

| Parameter | Meaning |
|-----------|---------|
| `spell` | A `SpellData` object. Only `name` is strictly required by this method |

```ts title="Example"
await engine.registerSpell({
  id: 9002,
  name: "shadow_nova",
  damage: 20,
  mana: 25,
  range: 500,
  type: "spell",
  cast_time: 2,
  cooldown: 30,
  can_move: 0,
  description: "Unleashes a wave of shadow energy.",
  icon: null,
  sprite: null,
  particles: null,
  effects: [{ type: "slow", value: 40, duration: 4 }],
  aoe_radius: 200,
  ground_aoe: null,
  ground_duration: null,
  is_thrown: null,
  charge_distance: null,
  teleport_behind: null,
});
```

What it does:

| Case | Result |
|------|--------|
| `spell` is missing or has no `name` | Logs a warning and returns |
| `effects` is missing or not an array | Set to `[]` |
| `damage`, `mana`, `range`, `cast_time`, `cooldown` or `can_move` is not a number | Set to `0` |
| `type` is empty | Set to `"spell"` |
| A spell with the same `name` is already cached | Logs a warning and returns. The existing spell is kept |
| Otherwise | The spell is added at the front of the cached list |

The spell is held in memory only and has to be registered again on every start. It is never written to the `spells` table.

:::warning A registered spell is not castable by itself
`registerSpell` does not assign an `id`, does not teach the spell to anyone, and does not update the copy of the spell list the login workers hold. All three are needed before a player can cast it. The [Spells](#/engine/spells/adding-a-new-spell) page explains each one and shows the `refreshAuthSpells()` call that fixes the last.
:::

For spells that never change, the `spells` array in [manifest.json](#/engine/plugins/spells-in-the-manifest) does the same job with no code.

## Putting it together

```ts title="src/plugins/arena/src/index.ts"
import log from "@engine/modules/logger";
import packet from "@engine/modules/packet";
import playerCache from "@engine/services/playermanager";
import { packetManager } from "@engine/socket/packet_manager";
import { listener, Events } from "@engine/systems/events";

const plugin: GamePlugin = {
  async register(engine, manifest) {
    engine.addPacketTypes(["ARENA_STATE"]);
    engine.addPacketBuilders({
      arenaState: (data: unknown) => [packet.encode(JSON.stringify({ type: "ARENA_STATE", data }))],
    });

    engine.onPacket((type, _data, _wt, player) => {
      // Nobody leaves their party while inside the arena.
      return type === "LEAVE_PARTY" && player?.location?.map === "arena";
    });

    engine.onWarpCollision(async (warp, _wt, player) => {
      if (String(warp.map).replace(".json", "") !== "arena") return false;
      await engine.teleportPlayer(player, "arena", warp.x, warp.y);
      return true;
    });

    engine.addHttpRoute("GET", "/plugins/arena/online", async () =>
      Response.json({
        players: Object.values(playerCache.list() as Record<string, any>)
          .filter((p) => p?.location?.map === "arena")
          .map((p) => p.username),
      })
    );

    listener.on(Events.MAP_ENTER, ({ player, mapName }) => {
      if (mapName !== "arena" || !player?.wt) return;
      for (const frame of (packetManager as any).arenaState({ round: 1 })) player.wt.send(frame);
    });

    log.success(`${manifest.name} registered`);
  },
};

export default plugin;
```
