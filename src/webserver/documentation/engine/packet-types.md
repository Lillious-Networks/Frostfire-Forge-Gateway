---
title: Packet Types
description: The packet type registry, with every packet name, its direction and purpose, how packets are built, sent and dispatched, and how a plugin adds its own.
order: 180
---

Every message between the client and the game server is a packet with a `type`. This page lists all 264 types in the registry, says which way each one travels, and explains how packets are built, sent and dispatched, and how a plugin adds one.

The transport underneath (WebTransport streams, datagrams and frame batching) is covered on the [Networking](#/engine/networking) page.

## The registry

`src/socket/types.ts` exports one object, `packetTypes`, that maps each packet name to its string value.

```ts title="src/socket/types.ts"
export const packetTypes: PacketType = {
  PING: "PING",
  PONG: "PONG",
  CONNECTION_COUNT: "CONNECTION_COUNT",
  // ...
  CREATURE_TARGETED: "CREATURE_TARGETED",
};
```

The registry has one job in the engine: the receiver builds the set of valid incoming types from its values and rejects anything else. Handlers and builders use the plain strings.

:::note One value has a trailing space
The entry `EQUIPMENT` holds the value `"EQUIPMENT "`, with a space at the end. The builder sends `"EQUIPMENT"` without it, and that packet only travels from server to client, so nothing is affected. Compare against the string, not the registry value, when handling it.
:::

## Packet shape

A packet sent by the client is JSON text:

```ts title="types.d.ts"
declare interface Packet {
  type: string;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
  chatDecryptionKey: Nullable<string>;
}
```

Only `type` and `data` matter to almost every handler. `data` can be any JSON value, including `null`.

```json title="A client packet"
{ "type": "QUEST_ACCEPT", "data": { "npcId": 1, "questId": 1 } }
```

A packet sent by the server has the same two fields:

```json title="A server packet"
{ "type": "NOTIFY", "data": { "message": "Welcome back." } }
```

Movement is the exception. Positions are sent from the server as compact binary frames, not JSON, see [Movement frames](#/engine/packet-types/movement-frames).

## Building packets

`src/modules/packet.ts` turns text into bytes and back. It keeps one `TextEncoder` and one `TextDecoder` for the whole process because encoding sits on the hottest path in the engine.

```ts title="src/modules/packet.ts"
const packet = {
  decode(data: ArrayBuffer) {
    return decoder.decode(data);
  },
  encode(data: string) {
    return encoder.encode(data);
  },
};

export default packet;
```

`src/socket/packet_manager.ts` exports `packetManager`, an object with one builder function per outgoing packet. A builder takes the payload and returns an array of encoded frames, ready to send.

```ts title="src/socket/packet_manager.ts"
notify: (data: any) => {
  return [
    packet.encode(JSON.stringify({ type: "NOTIFY", data })),
  ] as any[];
},
```

Builders return an array so a single call can produce more than one frame. Nearly all of them return exactly one.

| Builder | Use |
|---------|-----|
| `packetManager.notify({ message })` | A notification line for one player |
| `packetManager.custom(object)` | Encodes any object as it is. The object must carry its own `type` |
| `packetManager.moveXY(data)` | One binary movement frame |
| `packetManager.batchMoveXY(list)` | One binary frame holding many movements |

## Sending packets

Inside the receiver, and inside plugin handlers, packets go out through `sendPacket`:

```ts title="src/socket/receiver.ts"
function sendPacket(wt: any, packets: any[]) {
  if (!wt || !wt.send || wt.readyState !== 1) {
    return;
  }
  // ...
  packets.forEach((packet) => {
    wt.send(packet);
  });
}
```

| Way to send | Delivery | Used for |
|-------------|----------|----------|
| `sendPacket(wt, packets)` | Reliable and ordered | Anything that must arrive: chat, inventory, quest updates, notifications |
| `wt.sendBestEffort(frame)` | A datagram that may be lost | Updates that repeat, so a lost one heals itself: stat regeneration, projectiles, cast bars for onlookers |
| `broadcastToAOI(player, packets)` in `src/socket/aoi.ts` | Reliable, to everyone who can see the player | Things nearby players must see. See [AOI and Layers](#/engine/aoi-and-layers) |
| `topicBus.publish(topic, frame)` in `src/socket/topics.ts` | Reliable, to every connection subscribed to the topic | Server-wide fan-out |
| `topicBus.publishBestEffort(topic, frame)` | Datagram, to every subscriber | Loss-tolerant fan-out such as `CONNECTION_COUNT` |

```ts title="Sending from a plugin"
import { packetManager } from "@engine/socket/packet_manager";

for (const frame of packetManager.notify({ message: "The gates are open." })) {
  player.wt.send(frame);
}
```

## How the receiver dispatches

Every incoming message passes through `onTransportMessage` in `src/socket/server.ts` and then `packetReceiver` in `src/socket/receiver.ts`.

In `server.ts`:

1. An empty message is ignored. The message is parsed as JSON once, and one that does not parse is logged and dropped.
2. If packet rate limiting is enabled and the client is over its limit, the packet is dropped and the client gets `RATE_LIMITED`.
3. The player's idle timestamp is refreshed. Any packet counts as activity.
4. `MOVEXY` is handed to the receiver at once. Every other handled type goes through the connection's backpressure queue.

In `receiver.ts`:

```ts title="src/socket/receiver.ts"
if (!validPacketTypes.has(type as unknown as string)) {
  wt.close(1007, "Invalid packet type");
}

const currentPlayer = playerCache.get(wt.data.id) || null;

for (const interceptor of packetInterceptors) {
  if (interceptor(type, data, wt, currentPlayer)) {
    return;
  }
}

const pluginHandler = pluginHandlers.get(type);
if (pluginHandler) {
  await pluginHandler(wt, currentPlayer, data, sendPacket);
  return;
}

switch (type) {
  case "BENCHMARK": { /* ... */ }
  // one case per client packet
}
```

| Step | What happens |
|------|--------------|
| 1 | A message over the size limit closes the connection with code 1009. The limit is `webtransport.maxPayloadMB` from the settings, 1 MB when unset. `BENCHMARK` packets are exempt |
| 2 | A packet with no `type` closes it with code 1007 |
| 3 | A `type` that is not in the valid set closes it with code 1007 |
| 4 | The sender's player is looked up. It is `null` until the client has logged in |
| 5 | Every plugin packet interceptor runs. One returning `true` ends the dispatch |
| 6 | A plugin handler registered for the type runs, and ends the dispatch |
| 7 | The built-in `switch` runs the engine's own handler. A valid type with no handler is logged as `Unknown packet type` |

Nearly every built-in handler begins with `if (!currentPlayer) return;`, so a client that has not logged in can only use the connection and login packets.

## All packet types

Direction is taken from the code: "To server" means the receiver has a handler for it, "To client" means the engine sends it, "Both" means both, and "Unused" means the name is in the registry but the engine neither handles nor sends it. Some unused types still have a builder in `packetManager` that nothing calls.

| Packet | Direction | Area | Purpose |
|--------|-----------|------|---------|
| `PING` | To server | Connection | Latency probe. Answered with `PONG` |
| `PONG` | Both | Connection | Answer to `PING`. A `PONG` from the client is echoed back as well |
| `CONNECTION_COUNT` | To client | Connection | Number of open connections, published to every subscriber |
| `RATE_LIMITED` | To client | Connection | The client sent too many packets and is being throttled |
| `BENCHMARK` | Both | Connection | Echo for load testing. The server adds `returned_timestamp` and sends it back |
| `DISCONNECT_MALIFORMED` | Unused | Connection | A builder exists (`packetManager.disconnect`) but nothing calls it |
| `LOGIN` | To server | Session | Asks for the session's login data |
| `LOGIN_SUCCESS` | To client | Session | Session id and the chat encryption key |
| `LOGIN_FAILED` | To client | Session | Authentication was refused |
| `AUTH` | To server | Session | The login token. Verified on the authentication worker pool |
| `LOGOUT` | To server | Session | Saves the player's location, logs out and closes the connection |
| `DISCONNECT` | To server | Session | Saves the player's location and clears the session id |
| `REGISTER` | Unused | Session | In the registry only |
| `CLIENTCONFIG` | Both | Session | Client settings: saved when sent by the client, delivered at login |
| `SERVER_TIME` | To client | Session | The server clock, for the time of day |
| `CONSOLE_MESSAGE` | Unused | Session | A builder exists (`packetManager.consoleMessage`) but nothing calls it |
| `LOAD_MAP` | To client | Map | Map metadata: name, size, tilesets, spawn, warps, graveyards |
| `PRELOAD_MAP_CHUNKS` | To client | Map | Chunks for the client to load ahead of time |
| `CHUNK_DATA` | Unused | Map | A builder exists (`packetManager.chunkData`) but nothing calls it |
| `REQUEST_MAP_CHUNK` | Unused | Map | In the registry only |
| `RELOAD_CHUNK` | Unused | Map | In the registry only |
| `RELOAD_CHUNKS` | Unused | Map | A builder exists (`packetManager.reloadChunks`) but nothing calls it |
| `UPDATE_CHUNKS` | To client | Map | Chunks that changed |
| `MAP_REBASE` | To client | Map | Sent to players on a map after a save that changed its origin or bounds |
| `MOVEXY` | To server | Movement | Start moving in a direction, or `"ABORT"` to stop. Positions come back as binary frames |
| `BATCH_MOVEXY` | Unused | Movement | In the registry only. Batched movement is sent as a binary frame, not as this type |
| `TELEPORTXY` | To server | Movement | An admin moves themself to a position |
| `ANIMATION` | Unused | Movement | A builder exists (`packetManager.animation`) but nothing calls it. Animations are sent as `SPRITE_SHEET_ANIMATION` |
| `SPAWN_PLAYER` | To client | Players | A player entered the client's area of interest |
| `LOAD_PLAYERS` | To client | Players | A batch of players to show, with a snapshot revision |
| `DESPAWN_PLAYER` | To client | Players | A player left the client's area of interest |
| `DISCONNECT_PLAYER` | Unused | Players | In the registry only. The name is used as a topic that connections subscribe to |
| `BATCH_DISCONNECT_PLAYER` | To client | Players | Several players to remove at once |
| `SELECTPLAYER` | Both | Players | Select the player at a position, and the selection result |
| `TARGETCLOSEST` | To server | Players | Tab targeting: select the nearest target |
| `INSPECTPLAYER` | Both | Players | Ask for, and receive, a player's details |
| `GET_ONLINE_PLAYERS` | To server | Players | An admin asks for the list of online players |
| `ONLINE_PLAYERS_LIST` | To client | Players | The list of online players |
| `STEALTH` | Both | Players | An admin toggles stealth, and the new state |
| `NOCLIP` | Both | Players | An admin toggles noclip, and the new state |
| `DRAG_PLAYER_START` | Both | Players | An admin starts dragging a player |
| `DRAG_PLAYER_STOP` | Both | Players | An admin stops dragging a player |
| `DRAG_UPDATE` | To server | Players | The new position of a dragged player |
| `MOUNT` | To server | Players | Mount or dismount |
| `CHAT` | Both | Chat | A local chat message |
| `TYPING` | Both | Chat | A player started typing |
| `STOPTYPING` | Both | Chat | A player stopped typing |
| `COMMAND` | To server | Chat | A slash command, see [Admin Commands](#/engine/admin-commands) |
| `WHISPER` | To client | Chat | A private message |
| `PARTY_CHAT` | To client | Chat | A party chat message |
| `GUILD_CHAT` | Both | Chat | A guild chat message |
| `NOTIFY` | To client | Chat | A notification line |
| `STATS` | Unused | Stats | A builder exists (`packetManager.stats`) but nothing calls it. Stats are sent as `UPDATESTATS` |
| `UPDATESTATS` | To client | Stats | A change to a player's stats, with the damage or healing that caused it |
| `UPDATE_XP` | To client | Stats | XP, level and XP needed for the next level |
| `CURRENCY` | To client | Stats | The player's copper, silver and gold |
| `ATTACK` | Unused | Combat | In the registry only |
| `PROJECTILE` | To client | Combat | A projectile to draw from a caster to a target or a point |
| `REVIVE` | To client | Combat | A player was restored to life, with their stats |
| `HOTBAR` | To server | Spells | Cast a spell at a target or a ground point |
| `CANCEL_SPELL` | To server | Spells | Cancel the cast in progress |
| `CAST_SPELL` | To client | Spells | A cast bar started, was interrupted or failed |
| `SPELL_LOCKOUT` | To client | Spells | The player's spells are locked for a duration |
| `CANCEL_EFFECT` | To server | Spells | Remove one of the player's own buffs |
| `GROUND_AOE_CASTING` | To client | Spells | Preview circle of a ground spell being cast |
| `GROUND_AOE_SPAWN` | To client | Spells | A ground zone appeared |
| `GROUND_AOE_DESPAWN` | To client | Spells | A ground zone, or its preview, is gone |
| `LEARN_SPELL` | Unused | Spells | A builder exists (`packetManager.learnSpell`) but nothing calls it |
| `UNLEARN_SPELL` | Unused | Spells | A builder exists (`packetManager.unlearnSpell`) but nothing calls it |
| `SAVE_HOTBAR` | To server | Spells | Save the hotbar layout |
| `LOAD_HOTBAR` | Unused | Spells | A builder exists (`packetManager.loadHotBar`) but nothing calls it |
| `PLAYER_DIED` | To client | Death | The player died. Carries the corpse position |
| `RELEASE_SPIRIT` | To server | Death | Release to the graveyard as a ghost |
| `PLAYER_GHOST` | To client | Death | A player became, or stopped being, a ghost |
| `REVIVE_OFFER` | To client | Death | A ghost may revive at its corpse, with the corpse position. Also sent with `revoked` to withdraw the offer |
| `CONFIRM_REVIVE` | To server | Death | Accept the revive at the corpse |
| `CONFIRM_GRAVEYARD_REVIVE` | To server | Death | Revive at the graveyard with resurrection sickness |
| `LOAD_SKELETONS` | To client | Death | The skeletons to show on the map |
| `ADD_SKELETON` | To client | Death | A skeleton appeared |
| `REMOVE_SKELETON` | To client | Death | A skeleton is gone |
| `NPC_INTERACT` | To server | Quests | Talk to an NPC |
| `NPC_GOSSIP` | To client | Quests | An NPC's dialogue and its list of quests. `vendor: true` when the NPC also sells things, `innkeeper: true` when it keeps an inn |
| `USE_ITEM` | To server | Items | Use a consumable from the bags: `{ item }`. Answered with the player's bags and stats and an `ITEM_COOLDOWN`, or with a notification saying why not. The home item starts a cast instead (`CAST_SPELL` with the item's name) |
| `ITEM_COOLDOWN` | To client | Items | `{ kind, remaining, total }` in milliseconds. `kind` is `consumable` (the cooldown all consumables share) or `home` (the home item's own). Sent when one starts, and what is left of each at login |
| `COOLDOWNS_RESET` | To client | Items | Every cooldown of the player is over: spells, the spell lockout and both item cooldowns. No data. Sent by the `/cooldowns` admin command |
| `MAP_MARKERS` | To client | Maps | `{ map, markers }`: what the map the player is on marks, each `{ kind, x, y, name }` in map pixels. `kind` is `inn`, `merchant`, `cave` or `house`. An inn or a merchant is marked on the warp that leads into the map its innkeeper or vendor is on (the middle of the warp's top edge), or where the NPC stands when it is in a world. A cave is a warp from one world into another. A house is a warp from a world into any other map. The minimap draws a pin for each inn, merchant and cave; the world map draws `house.png` on each house and `cave.png` on each cave. Sent on login and on entering a map, and to everyone when an innkeeper or a vendor is added, saved or deleted |
| `SET_HOME` | To server | Items | Make an innkeeper's inn the player's home: `{ npcId }`. The player has to be alive and next to it |
| `VENDOR_OPEN` | To server | Vendors | Ask to see what an NPC sells: `{ npcId }`. Talking to a vendor that has no quests for the player does the same |
| `VENDOR_BUY` | To server | Vendors | Buy from the vendor's stock: `{ npcId, item, quantity }` |
| `VENDOR_SELL` | To server | Vendors | Sell an item for its sell price: `{ npcId, item, quantity }`. No quantity sells all that is spare |
| `VENDOR_BUYBACK` | To server | Vendors | Buy back one of the player's latest sales: `{ npcId, index }`, counted from 0 with the last sale first |
| `VENDOR_STOCK` | To client | Vendors | `{ npcId, name, items, buyback }`: each stocked item with its details and its `price` in copper, and what the player can buy back. Opens the vendor window, and is sent again after every deal |
| `VENDOR_CLOSED` | To client | Vendors | The player may no longer deal with the vendor: `{ message }` |
| `QUEST_LOG` | To client | Quests | The whole quest log, sent at login |
| `QUEST_LOG_ENTRY` | To client | Quests | One log entry was added or removed |
| `QUEST_PROGRESS` | To client | Quests | Objective counts changed |
| `QUEST_OFFER` | To client | Quests | A quest the player can look at and accept |
| `QUEST_INCOMPLETE` | To client | Quests | A quest in progress, with current counts |
| `QUEST_TURN_IN_OFFER` | To client | Quests | A quest ready to turn in |
| `QUEST_COMPLETED` | To client | Quests | A turn-in succeeded, with the rewards |
| `QUEST_ERROR` | To client | Quests | A quest request was refused, with a code and message |
| `QUEST_MARKERS` | To client | Quests | The marker to draw above each NPC |
| `QUEST_SELECT` | To server | Quests | Pick one quest from an NPC's list |
| `QUEST_ACCEPT` | To server | Quests | Accept a quest |
| `QUEST_DECLINE` | To server | Quests | Decline an offer. No server-side effect |
| `QUEST_ABANDON` | To server | Quests | Abandon a quest |
| `QUEST_TURN_IN` | To server | Quests | Turn in a quest, with the chosen reward |
| `ADD_FRIEND` | To server | Social | Send a friend request |
| `REMOVE_FRIEND` | To server | Social | Remove a friend |
| `UPDATE_FRIENDS` | To client | Social | The friends list |
| `IGNORE_PLAYER` | To server | Social | Ignore a player, by the id of one in sight or by username |
| `UNIGNORE_PLAYER` | To server | Social | Stop ignoring a player |
| `UPDATE_IGNORES` | To client | Social | The names the player ignores, sent at login and after each change |
| `REPORT_PLAYER` | To server | Social | Report a player to the admins, with a category and optional details |
| `TRADE_REQUEST` | To server | Social | Ask a nearby player to trade, by the id of one in sight. They get an `INVITATION` with the action `TRADE_REQUEST` |
| `TRADE_OFFER` | To server | Social | The sender's whole side of their trade: `{ items: [{ name, quantity }], coins: { gold, silver, copper } }` |
| `TRADE_ACCEPT` | To server | Social | Accept the trade as it stands. When both have, the offers change hands |
| `TRADE_CANCEL` | To server | Social | End the trade with nothing exchanged |
| `TRADE_STATE` | To client | Social | The trade as it stands for this player: `{ partner, mine, theirs, accepted: { mine, theirs }, acceptIn }`. Sent to both after every change |
| `TRADE_CLOSED` | To client | Social | The trade ended: `{ completed, message }` |
| `UPDATE_ONLINE_STATUS` | To client | Social | A friend came online or went offline |
| `INVITATION_RESPONSE` | To server | Social | Accept or decline a friend, party or guild invitation |
| `INVITE_PARTY` | To server | Social | Invite a player to the party |
| `REMOVE_PARTY` | Unused | Social | In the registry only |
| `UPDATE_PARTY` | To client | Social | The party's members |
| `KICK_PARTY_MEMBER` | To server | Social | Remove a member from the party |
| `LEAVE_PARTY` | To server | Social | Leave the party |
| `INVITE_GUILD` | To server | Social | Invite a player to the guild |
| `CREATE_GUILD` | To server | Social | Create a guild |
| `UPDATE_GUILD` | To client | Social | The guild's name and members |
| `KICK_GUILD_MEMBER` | To server | Social | Remove a member from the guild |
| `LEAVE_GUILD` | To server | Social | Leave the guild |
| `DISBAND_GUILD` | To server | Social | Disband the guild |
| `INVENTORY` | To client | Inventory | The whole inventory and its slot count |
| `ADD_INVENTORY_ITEM` | To client | Inventory | An item was added, or its quantity grew |
| `REMOVE_INVENTORY_ITEM` | To client | Inventory | An item was removed |
| `DELETE_ITEM` | To server | Inventory | Destroy an item |
| `SAVE_INVENTORY_SLOTS` | To server | Inventory | Save which slot each item sits in |
| `SAVE_INVENTORY_CONFIG` | To server | Inventory | Save the inventory window's layout |
| `EQUIP_ITEM` | To server | Inventory | Equip an item |
| `UNEQUIP_ITEM` | To server | Inventory | Unequip an item |
| `EQUIPMENT` | To client | Inventory | What the player has equipped |
| `BAGS` | To client | Inventory | The player's bags |
| `BAG_EQUIP` | To server | Inventory | Equip a bag |
| `BAG_UNEQUIP` | To server | Inventory | Unequip a bag |
| `COLLECTABLES` | To client | Inventory | The player's collectables, mounts included |
| `ADD_COLLECTABLE` | Unused | Inventory | A builder exists (`packetManager.addCollectable`) but nothing calls it |
| `REMOVE_COLLECTABLE` | Unused | Inventory | A builder exists (`packetManager.removeCollectable`) but nothing calls it |
| `LOOT_SPAWN` | To client | Loot | A loot drop appeared on the ground |
| `LOOT_DESPAWN` | To client | Loot | A loot drop is gone |
| `LOAD_LOOT` | To client | Loot | The loot drops on the map |
| `PICKUP_LOOT` | To server | Loot | Pick up one drop |
| `BATCH_PICKUP_LOOT` | To server | Loot | Pick up several drops |
| `LOOT_CHEST_SPAWN` | To client | Loot | A loot chest appeared |
| `LOOT_CHEST_DESPAWN` | To client | Loot | A loot chest is gone |
| `OPEN_LOOT_CHEST` | To server | Loot | Open a chest |
| `LOOT_CHEST_CONTENTS` | To client | Loot | What a chest holds |
| `TAKE_CHEST_ITEMS` | To server | Loot | Take chosen items from a chest |
| `TAKE_ALL_CHEST_ITEMS` | To server | Loot | Take everything from a chest |
| `CREATURE_SPAWN` | To client | Creatures | A creature entered view |
| `CREATURE_DESPAWN` | To client | Creatures | A creature left view |
| `CREATURE_MOVE` | To client | Creatures | A creature moved |
| `CREATURE_STATE` | To client | Creatures | A creature's AI state and current victim |
| `CREATURE_HEALTH` | To client | Creatures | A creature's health |
| `CREATURE_COMBAT_TEXT` | To client | Creatures | Floating combat text: damage, immune, interrupted |
| `CREATURE_ATTACK` | To server | Creatures | Start, or stop, auto-attacking a creature |
| `CREATURE_ATTACK_STOPPED` | To client | Creatures | Auto-attack on a creature ended |
| `CREATURE_TAP` | To client | Creatures | Who has tagged a creature |
| `CREATURE_LOOTABLE` | To client | Creatures | A corpse has loot for this player |
| `CREATURE_LOOT` | To server | Creatures | Open a creature's corpse |
| `CREATURE_LOOT_CONTENTS` | To client | Creatures | What the corpse holds |
| `CREATURE_LOOT_TAKE` | To server | Creatures | Take loot from a corpse |
| `CREATURE_XP` | To client | Creatures | XP gained from a kill |
| `CREATURE_CAST` | To client | Creatures | A creature started casting |
| `CREATURE_CAST_END` | To client | Creatures | A creature's cast ended |
| `CREATURE_AURAS` | To client | Creatures | The effects active on a creature |
| `CREATURE_TARGETED` | To client | Creatures | The creature that tab targeting selected |
| `CREATURE_DEBUG_SUBSCRIBE` | To server | Creatures | Turn the creature debug overlay on or off. Needs creature editor access |
| `CREATURE_DEBUG` | To client | Creatures | Debug overlay data: radii and threat |
| `CREATE_NPC` | Unused | NPCs | A builder exists (`packetManager.createNpc`) but nothing calls it. NPCs are sent with `LOAD_NPCS` |
| `LOAD_NPCS` | To client | NPCs | A batch of NPCs to show |
| `WEATHER` | To client | Weather | The weather of the world the player is in |
| `CHANGE_WEATHER` | To client | Weather | The weather changed |
| `LIGHTNING` | To client | Weather | A lightning flash |
| `TOGGLE_TILE_EDITOR` | To client | Map editor | Open or close the map editor |
| `SAVE_MAP` | To server | Map editor | Save map changes. Needs `server.admin` or `server.*` |
| `EDITOR_OPEN` | To server | Map editor | An admin opened the editor on this map |
| `EDITOR_CLOSE` | To server | Map editor | An admin closed the editor |
| `EDITOR_TILE_EDIT` | Both | Map editor | Live tile edits, relayed to other admins editing the same map |
| `EDITOR_LAYER_LOCK` | Both | Map editor | A layer was locked or unlocked, relayed to other admins |
| `EDITOR_SYNC_READY` | To client | Map editor | Unsaved edits were replayed and the editor is in sync |
| `TOGGLE_PARTICLE_EDITOR` | To client | Particle editor | Open or close the particle editor |
| `SAVE_PARTICLE` | To server | Particle editor | Save a particle |
| `DELETE_PARTICLE` | To server | Particle editor | Delete a particle |
| `RENAME_PARTICLE` | To server | Particle editor | Rename a particle |
| `LIST_PARTICLES` | To server | Particle editor | Ask for the list of particles. Answered with `PARTICLE_LIST` |
| `TEST_PARTICLE` | To server | Particle editor | Preview a particle in the world. Nearby players get `TEST_PARTICLE_EVENT` |
| `PARTICLE_UPDATED` | To client | Particle editor | A particle changed |
| `TOGGLE_NPC_EDITOR` | To client | NPC editor | Open or close the NPC editor |
| `LIST_NPCS` | To server | NPC editor | Ask for the NPCs on the current map |
| `NPC_LIST` | To client | NPC editor | The NPCs on the current map |
| `ADD_NPC` | To server | NPC editor | Create an NPC |
| `SAVE_NPC` | To server | NPC editor | Save an NPC |
| `DELETE_NPC` | To server | NPC editor | Delete an NPC |
| `MOVE_NPC` | To server | NPC editor | Move an NPC |
| `NPC_UPDATED` | To client | NPC editor | An NPC was created or changed |
| `NPC_REMOVED` | To client | NPC editor | An NPC was deleted |
| `TOGGLE_QUEST_EDITOR` | Both | Quest editor | Open the quest editor |
| `QUEST_EDITOR_DATA` | Both | Quest editor | Ask for, and receive, the editor's data |
| `QUEST_EDITOR_SEARCH` | To server | Quest editor | Search from the editor |
| `QUEST_EDITOR_RESULTS` | To client | Quest editor | Search results |
| `QUEST_EDITOR_SAVE` | To server | Quest editor | Save a quest |
| `QUEST_EDITOR_DELETE` | To server | Quest editor | Delete a quest |
| `QUEST_EDITOR_RESULT` | To client | Quest editor | Whether a save or delete worked |
| `QUEST_EDITOR_UPDATED` | To client | Quest editor | Quest definitions changed |
| `QUEST_EDITOR_CLOSE` | To server | Quest editor | The editor was closed |
| `TOGGLE_ITEM_EDITOR` | To client | Item editor | Open or close the item editor |
| `ITEM_EDITOR_LIST` | To server | Item editor | Ask for the editor's data |
| `ITEM_EDITOR_DATA` | To client | Item editor | The editor's data |
| `ITEM_EDITOR_SEARCH` | To server | Item editor | Search items |
| `ITEM_EDITOR_RESULTS` | To client | Item editor | Search results |
| `ITEM_EDITOR_SAVE` | To server | Item editor | Save an item |
| `ITEM_EDITOR_DELETE` | To server | Item editor | Delete an item |
| `ITEM_EDITOR_RESULT` | To client | Item editor | Whether a save or delete worked |
| `ITEM_EDITOR_UPDATED` | To client | Item editor | The item list changed |
| `TOGGLE_SPELL_EDITOR` | To client | Spell editor | Open or close the spell editor |
| `SPELL_EDITOR_LIST` | To server | Spell editor | Ask for the editor's data |
| `SPELL_EDITOR_DATA` | To client | Spell editor | The editor's data, effect type rules included |
| `SPELL_EDITOR_SEARCH` | To server | Spell editor | Search spells |
| `SPELL_EDITOR_RESULTS` | To client | Spell editor | Search results |
| `SPELL_EDITOR_SAVE` | To server | Spell editor | Save a spell |
| `SPELL_EDITOR_DELETE` | To server | Spell editor | Delete a spell |
| `SPELL_EDITOR_LEARN` | To server | Spell editor | Teach a saved spell to the admin's own character, to try it out |
| `SPELL_EDITOR_RESULT` | To client | Spell editor | Whether a change worked |
| `SPELL_EDITOR_UPDATED` | To client | Spell editor | The spell list changed |
| `TOGGLE_WEATHER_EDITOR` | To client | Weather editor | Open or close the weather editor |
| `WEATHER_EDITOR_LIST` | To server | Weather editor | Ask for the editor's data |
| `WEATHER_EDITOR_DATA` | To client | Weather editor | The editor's data |
| `WEATHER_EDITOR_SAVE` | To server | Weather editor | Save a weather |
| `WEATHER_EDITOR_DELETE` | To server | Weather editor | Delete a weather |
| `WEATHER_EDITOR_RESULT` | To client | Weather editor | Whether a change worked |
| `WEATHER_EDITOR_UPDATED` | To client | Weather editor | The weather list changed |
| `TOGGLE_LOOT_EDITOR` | To client | Loot editor | Open or close the loot table editor |
| `LIST_LOOT_TABLES` | To server | Loot editor | Ask for every loot table |
| `LOOT_TABLE_LIST` | To client | Loot editor | Every loot table |
| `LOOT_EDITOR_CREATE_TABLE` | To server | Loot editor | Create a table |
| `LOOT_EDITOR_DELETE_TABLE` | To server | Loot editor | Delete a table |
| `LOOT_EDITOR_ADD_ITEM` | To server | Loot editor | Add a row to a table |
| `LOOT_EDITOR_REMOVE_ITEM` | To server | Loot editor | Remove a row |
| `LOOT_EDITOR_UPDATE_ITEM` | To server | Loot editor | Change a row |
| `LOOT_EDITOR_RESULT` | To client | Loot editor | Whether the change worked, and the fresh list of tables |
| `PLAYER_EDITOR_OPEN` | To client | Player editor | Open the player editor on one player |
| `PLAYER_EDITOR_LOAD` | To server | Player editor | Ask for a player's snapshot |
| `PLAYER_EDITOR_DATA` | To client | Player editor | The snapshot and the editor's options |
| `PLAYER_EDITOR_SEARCH` | To server | Player editor | Search players or items |
| `PLAYER_EDITOR_RESULTS` | To client | Player editor | Search results |
| `PLAYER_EDITOR_ACTION` | To server | Player editor | Apply one change to the player |
| `PLAYER_EDITOR_RESULT` | To client | Player editor | Whether the change worked, and the fresh snapshot |
| `TOGGLE_CONTROL_PANEL` | To client | Control panel | Open or close the control panel |
| `CONTROL_PANEL_LOAD` | To server | Control panel | Ask for the panel's data |
| `CONTROL_PANEL_DATA` | To client | Control panel | Players, history, activity and what the viewer may do |
| `CONTROL_PANEL_QUERY` | To server | Control panel | Ask for a list, such as permissions or loot tables |
| `CONTROL_PANEL_RESULTS` | To client | Control panel | The list that was asked for |
| `CONTROL_PANEL_ACTION` | To server | Control panel | Run one admin command through the panel |
| `CONTROL_PANEL_RESULT` | To client | Control panel | Whether the command worked, and what it answered |
| `TOGGLE_CREATURE_EDITOR` | To client | Creature editor | Open or close the creature editor |
| `CREATURE_EDITOR_LIST` | To server | Creature editor | Ask for the editor's data |
| `CREATURE_EDITOR_CLOSE` | To server | Creature editor | The editor was closed |
| `CREATURE_EDITOR_DATA` | To client | Creature editor | Templates, abilities, spawns, paths, link groups and pools |
| `CREATURE_EDITOR_RESULT` | To client | Creature editor | Whether a change worked |
| `CREATURE_EDITOR_UPDATED` | To client | Creature editor | Creature data changed |
| `CREATURE_EDITOR_SAVE_TEMPLATE` | To server | Creature editor | Save a creature template |
| `CREATURE_EDITOR_DELETE_TEMPLATE` | To server | Creature editor | Delete a creature template |
| `CREATURE_EDITOR_SAVE_ABILITY` | To server | Creature editor | Save one ability |
| `CREATURE_EDITOR_DELETE_ABILITY` | To server | Creature editor | Delete one ability |
| `CREATURE_EDITOR_SAVE_ABILITIES` | To server | Creature editor | Save a template's abilities together |
| `CREATURE_EDITOR_SAVE_SPAWN` | To server | Creature editor | Save a spawn |
| `CREATURE_EDITOR_DELETE_SPAWN` | To server | Creature editor | Delete a spawn |
| `CREATURE_EDITOR_SAVE_PATH` | To server | Creature editor | Save a patrol path |
| `CREATURE_EDITOR_DELETE_PATH` | To server | Creature editor | Delete a patrol path |
| `CREATURE_EDITOR_SAVE_LINKGROUP` | To server | Creature editor | Save a link group |
| `CREATURE_EDITOR_DELETE_LINKGROUP` | To server | Creature editor | Delete a link group |
| `CREATURE_EDITOR_SAVE_POOL` | To server | Creature editor | Save a spawn pool |
| `CREATURE_EDITOR_DELETE_POOL` | To server | Creature editor | Delete a spawn pool |
| `CREATURE_EDITOR_ACTION` | To server | Creature editor | Run an editor action on live creatures |

### Types the server sends that are not in the registry

The registry is only consulted for incoming packets, so the server can send types it does not list. These are built or sent by the engine today:

| Type | Sent by | Purpose |
|------|---------|---------|
| `AUTH_CONNECT_SUCCESS` | `src/socket/transport.ts` | The WebTransport session was accepted |
| `RECONNECT` | `packetManager.reconnect` | Tells the client to reconnect, for example after its admin role changed |
| `SPELLS` | `packetManager.spells` | The player's spell book, sent at login |
| `EFFECTS` | `packetManager.effects` | The buffs and debuffs active on a player |
| `INVITATION` | `packetManager.invitation` | A friend, party or guild invitation popup |
| `UNLOAD_NPCS` | `packetManager.unloadNpcs` | NPCs the client should drop |
| `SPRITE_SHEET_ANIMATION` | `packetManager.spriteSheetAnimation` | A player's sprite layers and animation |
| `BATCH_SPRITE_SHEET_ANIMATION` | `packetManager.batchSpriteSheetAnimation` | The same for several players |
| `COLLISION_DEBUG` | `packetManager.collisionDebug` | The tile a player collided with |
| `PARTICLE_LIST` | `packetManager.custom` in the receiver | The list of particles for the editors |
| `TEST_PARTICLE_EVENT` | `packetManager.custom` in the receiver | A particle preview for players nearby |

## Movement frames

Player positions are the highest-volume traffic, so the server sends them as binary frames with a one-byte header instead of JSON.

| Header | Builder | Layout |
|--------|---------|--------|
| `0x02` | `packetManager.moveXY` | One movement, 21 bytes: `u8` header, `u32` player id, `i32` x, `i32` y, `u8` direction and stealth, `u8` padding, `u32` seconds and `u16` milliseconds of the server send time |
| `0x01` | `packetManager.batchMoveXY` | Many movements: `u8` header, `u16` count, then per movement `u32` player id, `i32` x, `i32` y, `u8` direction and stealth |

All numbers are little-endian. The direction byte holds the direction in its low four bits and the stealth flag in bit 4:

| Value | Direction |
|-------|-----------|
| 0 | `up` |
| 1 | `down` |
| 2 | `left` |
| 3 | `right` |
| 4 | `upleft` |
| 5 | `upright` |
| 6 | `downleft` |
| 7 | `downright` |

The client still sends movement as an ordinary `MOVEXY` JSON packet. How the transport batches these frames is described on the [Networking](#/engine/networking) page.

## Adding a packet from a plugin

A plugin uses three [Engine API](#/engine/engine-api) methods: `addPacketTypes` to register the names, `addPacketBuilders` to build what the server sends, and `registerHandlers` to handle what the client sends.

### A packet the server sends

This direction has no restrictions. Register the name, add a builder, and send it.

```ts title="src/plugins/arena/src/index.ts"
import packet from "@engine/modules/packet";
import { packetManager } from "@engine/socket/packet_manager";
import { listener, Events } from "@engine/systems/events";

const plugin: GamePlugin = {
  register(engine) {
    engine.addPacketTypes(["ARENA_STATE"]);

    engine.addPacketBuilders({
      arenaState: (data: { round: number; alive: number }) => [
        packet.encode(JSON.stringify({ type: "ARENA_STATE", data })),
      ],
    });

    listener.on(Events.MAP_ENTER, ({ player, mapName }) => {
      if (mapName !== "arena" || !player?.wt) return;
      for (const frame of (packetManager as any).arenaState({ round: 1, alive: 8 })) {
        player.wt.send(frame);
      }
    });
  },
};

export default plugin;
```

The client then needs code that handles `ARENA_STATE`. The browser client lives in the gateway repository, see the [Gateway overview](#/gateway/overview).

### A packet the client sends

The intended flow is to register the type and a handler:

```ts title="Handling a client packet"
engine.addPacketTypes(["ARENA_JOIN"]);

engine.registerHandlers({
  ARENA_JOIN: async (wt, currentPlayer, data, sendPacket) => {
    if (!currentPlayer || currentPlayer.isGuest) return;
    const arenaId = Number(data?.arenaId);
    if (!Number.isInteger(arenaId)) return;
    sendPacket(wt, packetManager.notify({ message: `Joined arena ${arenaId}` }));
  },
});
```

:::danger New incoming types are closed by the validity check
The receiver builds its set of valid types once, when `receiver.ts` is first imported:

`const validPacketTypes = new Set<string>(Object.values(packetTypes) as string[]);`

That happens before any plugin loads. `addPacketTypes` adds the name to the `packetTypes` object but not to this set. As the code stands, a packet with a plugin-defined type still reaches the interceptors and your handler, because the check does not `return`, but the same check also calls `wt.close(1007, "Invalid packet type")` on the sender's connection.

Until the set is kept in step with the registry, do not send new type names from the client. Two approaches work today:

- Register a handler for a type that is already in the registry and not handled by the engine, and tell your messages apart by a field in `data`.
- Use an HTTP route added with `addHttpRoute` for requests that do not need the game connection.
:::

A handler registered for a built-in type replaces the engine's handling of that type completely. To watch a built-in packet without replacing it, use [`onPacket`](#/engine/engine-api/onpacket) and return `false`.

### Rules for plugin packets

- Prefix type names and builder names with your plugin's name so they cannot collide with the engine's or another plugin's.
- Validate everything in `data`. It comes straight from the client.
- Check `currentPlayer` for `null`. Handlers run for connections that have not logged in.
- Use `sendPacket` or `wt.send` for anything that must arrive, and `wt.sendBestEffort` only for updates that repeat.
