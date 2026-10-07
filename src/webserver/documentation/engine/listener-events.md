---
title: Listener Events
description: The complete catalog of engine events, covering lifecycle, tick, network and every gameplay hook, with the payload each one carries.
order: 170
---

The engine announces what happens inside it on one shared event bus. Plugins subscribe to it to react to logins, combat, chat, quests and more. This page lists every event name in `src/systems/events.ts`, the payload each one is emitted with, and when it fires.

Every payload below was read from the `listener.emit` call that sends it, not from the type declarations, because a few of them differ.

## The bus

The bus is a single Node `EventEmitter` created in `src/modules/event_bus.ts` and re-exported, with the name constants, from `src/systems/events.ts`.

```ts title="src/modules/event_bus.ts"
import EventEmitter from "node:events";
export const listener = new EventEmitter();
```

```ts title="Subscribing from a plugin"
import { listener, Events } from "@engine/systems/events";

listener.on(Events.PLAYER_DEATH, ({ player, killer }) => {
  // ...
});
```

`Events` maps a constant to the event's string name, for example `Events.PLAYER_DEATH` is `"onPlayerDeath"`. Both forms work with `listener.on`. The constants protect you from typos.

| Method | Use |
|--------|-----|
| `listener.on(name, handler)` | Subscribe |
| `listener.once(name, handler)` | Subscribe for one emission |
| `listener.off(name, handler)` | Unsubscribe. Needs the same function reference that was passed to `on` |
| `listener.emit(name, payload)` | Emit. Plugins may emit their own event names |

Rules that come with a plain `EventEmitter`:

- Handlers run synchronously, in the order they were added, inside the code that emitted the event. A slow handler slows down that code path.
- An `async` handler is started but not awaited. The engine carries on as soon as the handler reaches its first `await`.
- An error thrown synchronously by a handler propagates into the engine code that emitted. Wrap risky work in `try` and `catch`.
- Payload objects are the live objects the engine uses. `player` is the entry from the player cache, so changing it changes the game state.

## Lifecycle events

| Constant | Name | Payload | When |
|----------|------|---------|------|
| `Events.AWAKE` | `onAwake` | none | Once, after the servers are listening and the gateway registration is done |
| `Events.START` | `onStart` | none | Once, straight after `onAwake` |
| `Events.PLUGIN_LOAD` | `onPluginLoad` | `{ name, version, dirPath }` | A plugin's manifest was read and its entry module imported |
| `Events.PLUGIN_INITIALIZE` | `onPluginInitialize` | `{ name, engine }` | Just before a plugin's `register` is called. `engine` is the `EngineAPI` object |
| `Events.PLUGIN_REGISTER` | `onPluginRegister` | `{ name }` | A plugin's `register` finished without throwing |
| `Events.PLUGIN_UNREGISTER` | `onPluginUnregister` | `{ name }` | A plugin's `unregister` finished. The engine itself never triggers this, see [Plugins](#/engine/plugins/register-and-unregister) |

:::warning Plugins cannot hear onAwake or onStart
Both are emitted before the plugin loader runs. A handler added inside `register` is added too late and never fires. Put startup work directly in `register`.
:::

## Tick events

| Constant | Name | Interval | Payload |
|----------|------|----------|---------|
| `Events.FIXED_UPDATE` | `onFixedUpdate` | Every 100 ms | none |
| `Events.SERVER_TICK` | `onServerTick` | Every 1 second | none |
| `Events.SAVE` | `onSave` | Every 60 seconds | none |
| `Events.UPDATE` | `onUpdate` | Never emitted | none |

```ts title="src/socket/server.ts"
setInterval(() => {
  listener.emit(Events.FIXED_UPDATE);
}, 100);

setInterval(() => {
  listener.emit(Events.SAVE);
}, 60000);

setInterval(() => {
  listener.emit(Events.SERVER_TICK);
}, 1000);
```

The intervals are plain timers. They start after plugins have registered and are not tied to the 30 Hz movement loop described on the [Game Loop](#/engine/game-loop) page.

The engine does real work on these ticks: creature updates on `onFixedUpdate`, health and stamina regeneration and quest radius checks on `onServerTick`. Keep your own handlers short so they do not hold those up.

## Network events

| Name | Payload | When |
|------|---------|------|
| `onConnection` | The connection id, as a string | A WebTransport session opened. No player exists yet |
| `onDisconnect` | `{ id, reason }` | A session ended |

Neither has a constant that is used at the emit site, but `Events.CONNECTION` and `Events.DISCONNECT` hold the same strings.

`reason` is one of:

| Reason | Meaning |
|--------|---------|
| `player_left` | The client closed the session |
| `inactive` | The server swept a player whose connection was already gone |
| `session_stolen` | The account logged in somewhere else, so this session was closed |

For player-level cleanup use `onPlayerDisconnect`, which carries the player object.

## Gameplay events

Every gameplay hook the engine emits. The `Area` column is there for the filter box.

| Area | Name | Payload | When |
|------|------|---------|------|
| Map | `onWarp` | `{ mapName, metadata }` | Map metadata was built for a `LOAD_MAP` packet. `metadata` is the object that is sent |
| Map | `onMapEnter` | `{ player, mapName, position }` | A player was moved to a map (warp, teleport, summon), after the AOI change and before `LOAD_MAP` is sent. `position` is `{ x, y }` |
| Session | `onPlayerAuthComplete` | `{ username, spawnLocation, playerData }` | Login was verified and the spawn location chosen, before the map is looked up |
| Session | `onPlayerLogout` | `{ player }` | The client sent `LOGOUT` and the player's location was saved |
| Session | `onPlayerDisconnect` | `{ player }` | A logged-in player's connection ended and their in-memory state was cleaned up |
| Session | `onPlayerStealthChange` | `{ player, isStealth }` | An admin toggled stealth |
| Combat | `onPlayerDamaged` | `{ attacker, target, damage, isCrit }` | A player took damage from a spell, an area splash, a damage-over-time tick or a creature. For a creature `attacker` is `{ id, username, isCreature: true }`. It can be `null` for a tick whose caster is offline |
| Combat | `onPlayerHealed` | `{ caster, target, amount, source }` | A player was healed by a direct heal or a heal-over-time tick. `source` is the spell name |
| Combat | `onPlayerDeath` | `{ player, killer }` | A player died and the death packets were sent |
| Combat | `onPlayerGhostReleased` | `{ player }` | A dead player released their spirit |
| Combat | `onPlayerRevived` | `{ player }` | A player came back to life: `/revive`, an accepted revive offer, or a graveyard revive |
| Combat | `onPlayerRespawn` | `{ player, mapName, x, y }` | An admin used `/respawn` on a player |
| Combat | `onPlayerLevelUp` | `{ player, level }` | A player gained a level from quest XP, kill XP or the player editor. `level` is the new level |
| Combat | `onPlayerEnteredPVP` | `{ player }` | A player's combat flag turned on |
| Combat | `onPlayerLeftPVP` | `{ player }` | A player's combat flag turned off, 5 seconds after their last attack |
| Combat | `onPlayerEnterAOE` | `{ player, zoneId, spellName }` | A player walked into a ground zone. Not emitted for players already inside when the zone appears |
| Combat | `onPlayerLeftAOE` | `{ player, zoneId, spellName }` | A player left a ground zone, or the zone ended while they were inside |
| Spells | `onSpellCast` | `{ player, spellName, target, isEntityTarget }` | A spell landed. For a creature target `target` is `null` and the payload also has `creatureId` |
| Spells | `onSpellFailed` | `{ player, target, spellName, reason }` | A cast was refused, see the reasons below |
| Spells | `onSpellInterrupted` | `{ player }` | A cast was cancelled with escape, or broken by an interrupt or a stun |
| Spells | `onPlayerAbsorbtion` | `{ caster, target, spellName, amount, duration }` | An absorb shield was applied or refreshed |
| Spells | `onPlayerStunned` | `{ caster, target, spellName, duration }` | A stun landed on a player |
| Spells | `onPlayerDebuffAdded` | `{ caster, target, spellName, effectType, effect }` | A hostile effect was applied to a player |
| Spells | `onPlayerBuffAdded` | `{ caster, target, spellName, effectType, effect }` | A friendly effect was applied to a player |
| Spells | `onPlayerDebuffRemoved` | `{ player, effectId, effectType, spellName }` | A stun, slow or damage-over-time effect ran out |
| Spells | `onPlayerBuffRemoved` | `{ player, effectId, effectType, spellName }` | An absorb shield's timer or a heal-over-time effect ran out |
| Spells | `onPlayerVanish` | `{ player, vanished, spellName }` | Vanish was applied (`vanished: true`), or it expired or was broken (`vanished: false`) |
| Social | `onPlayerChat` | `{ player, message, mapName }` | A local chat message was sent. `message` is the text other players see |
| Social | `onPartyChat` | `{ player, message, partyMembers }` | A party chat message was sent. `partyMembers` is a list of usernames |
| Social | `onGuildChat` | `{ player, message, guildMembers, guildId }` | A guild chat message was sent. `guildMembers` is a list of usernames |
| Social | `onPartyInvite` | `{ inviterUsername, invitedUsername }` | A party invitation was sent through the `INVITE_PARTY` packet |
| Social | `onPartyChanged` | `{ type, username, kickedUsername, members }` | A party gained or lost a member, see the shapes below |
| Social | `onGuildChanged` | `{ type, guildId, guildName, playerUsername, kickedUsername }` | A guild was created, joined, left or disbanded, or a member was kicked |
| Social | `onVendorBuy` | `{ player, npcId, item, quantity, coins }` | A player bought from a vendor, or bought back something they sold. `coins` is the copper paid for all of it |
| Social | `onVendorSell` | `{ player, npcId, item, quantity, coins }` | A player sold an item to a vendor. `coins` is the copper they were paid |
| Social | `onItemUsed` | `{ player, item, health, stamina, home }` | A player used a consumable. `health` and `stamina` are what it gave back. For the home item both are 0 and `home` is where they arrived, `{ map, x, y }`: it fires once the cast has finished and they have been moved. Otherwise `home` is `null` |
| Social | `onHomeSet` | `{ player, npcId, inn }` | A player made an innkeeper's inn their home. `inn` is the NPC's name |
| Social | `onTradeCompleted` | `{ trade }` | Two players completed a trade. `trade` is the row written to `trade_log`: `{ id, player_a, player_b, a_gave, b_gave, created_at }`, where each `gave` is `{ items: [{ name, quantity }], coins }` |
| Social | `onFriendAdded` | `{ type, playerUsername, friendUsername }` | A friend request was accepted. `type` is `"add"` |
| Social | `onFriendRemoved` | `{ type, playerUsername, friendUsername }` | A friend was removed. `type` is `"remove"` |
| Items | `onItemEquip` | `{ player, item, slot }` | An item was equipped |
| Items | `onItemUnequip` | `{ player, slot }` | An item was unequipped |
| Items | `onPlayerMount` | `{ player, mounted, mountType }` | A player mounted or dismounted |
| Loot | `onPlayerLootDropped` | `{ player, itemName, quantity, mapName, x, y }` | A loot drop appeared on the ground |
| Loot | `onPlayerLootDespawned` | `{ player, itemName, quantity, mapName, x, y }` | A loot drop was removed without being picked up. `player` is only `{ username, id }` of the owner, both empty for loot that had no owner |
| Loot | `onPlayerLootRetrieved` | `{ player, itemName, quantity, mapName, x, y }` | A player picked up a loot drop |
| Creatures | `onCreatureKilled` | `{ creature, template, killer, tapper }` | A creature died. `killer` is a player object or `null` |
| Creatures | `onCreatureKillCredit` | `{ player, templateId, creature, updates }` | A player received kill credit. `updates` are the quest objective updates it caused |
| Quests | `onQuestAccepted` | `{ username, questId }` | A quest was accepted |
| Quests | `onQuestObjectiveProgress` | `{ username, questId, objectiveId, count, required }` | An objective count changed |
| Quests | `onQuestReady` | `{ username, questId }` | Every objective of a quest is met |
| Quests | `onQuestCompleted` | `{ username, questId, rewards }` | A quest was turned in. `rewards` is `{ ok, items, xpResult }` |
| Quests | `onQuestAbandoned` | `{ username, questId }` | A quest was abandoned |

### Declared but never emitted

Three names exist in `Events` and have payload types, but no code emits them. A handler for them never runs.

| Constant | Name |
|----------|------|
| `Events.UPDATE` | `onUpdate` |
| `Events.PLAYER_MOVED` | `onPlayerMoved` |
| `Events.WHISPER` | `onWhisper` |

To follow movement today, use an [`onPacket`](#/engine/engine-api/onpacket) interceptor and watch for `MOVEXY`. Whispers travel inside `COMMAND` packets, which the client normally encrypts, so there is no hook for them.

## Payload details

### Payloads you can change

Two payloads are read again by the engine after the event, so a synchronous handler can alter the outcome.

| Event | What to change | Effect |
|-------|----------------|--------|
| `onPlayerAuthComplete` | `spawnLocation.map`, `.x`, `.y`, `.direction` | The player logs in at that place. `map` includes the `.json` extension |
| `onWarp` | Any field of `metadata`, for example `metadata.name` | The client receives the changed `LOAD_MAP` data |

```ts title="Sending new characters to a tutorial map"
listener.on(Events.PLAYER_AUTH_COMPLETE, ({ spawnLocation, playerData }) => {
  if ((playerData.stats?.level ?? 1) > 1) return;
  spawnLocation.map = "tutorial.json";
  spawnLocation.x = 512;
  spawnLocation.y = 512;
});
```

The change has to be made before the handler returns. An `async` handler that changes the object after an `await` is too late.

### onPlayerLevelUp

The payload is `{ player, level }`, where `level` is the new level. The `PlayerLevelUpEvent` interface in `events.ts` declares `oldLevel` and `newLevel`, but no emit site sends those fields.

```ts title="Reading the level"
import { listener, Events } from "@engine/systems/events";
import log from "@engine/modules/logger";

listener.on(Events.PLAYER_LEVEL_UP, ({ player, level }) => {
  log.info(`${player.username} reached level ${level}`);
});
```

### onPartyChanged

| `type` | `username` | `kickedUsername` | `members` |
|--------|------------|------------------|-----------|
| `join` | The player who joined | not set | The party's usernames after the join |
| `leave` | The player who left | not set | Only the player who left |
| `kick` | The player who kicked | The player who was removed | Only the player who was removed |
| `disband` | not set | not set | The usernames that were in the party |

### onGuildChanged

| `type` | `playerUsername` | `kickedUsername` |
|--------|------------------|------------------|
| `create` | The founder | not set |
| `join` | The player who joined | not set |
| `leave` | The player who left | not set |
| `kick` | The player who kicked | The player who was removed |
| `disband` | The leader who disbanded it | not set |

`guildId` and `guildName` identify the guild in every case.

### onSpellFailed reasons

| Reason | Meaning |
|--------|---------|
| `cooldown` | The spell is on cooldown |
| `mana` | Not enough stamina for the mana cost |
| `moving` | A stand-still spell was pressed while moving |
| `vanished` | The caster is vanished and the spell cannot be cast from vanish |
| `no_effects` | The spell has no damage and no effects |
| `nopvp` | PvP is not allowed where the caster or the target stands |
| `range` | The target is out of range |
| `path_blocked` | No line of sight to the target |
| `direction` | The caster is not facing the target |
| `invalid_target` | Creature targets only: the creature cannot be targeted, or the spell cannot be used on creatures |
| `unknown` | Any other failed check |

`target` is the player object the spell was aimed at, or `null` when the target was a creature.

### Effect events

`onPlayerDebuffAdded` and `onPlayerBuffAdded` are emitted once per effect in the spell's `effects` array. Which of the two fires depends on the effect type: `damage_over_time`, `interrupt`, `stun`, `slow` and `taunt` are hostile, everything else is friendly. `effect` is the raw `SpellEffect` object from the spell.

The two removal events fire only when an effect's own timer runs out. `effectId` identifies it:

| Effect | `effectId` | `effectType` |
|--------|------------|--------------|
| Stun | `stun:<spell name>` | `stun` |
| Slow | `slow:<spell name>` | `slow` |
| Damage over time | `dot:<spell name>` | `damage_over_time` |
| Heal over time | `dot:<spell name>` | `heal_over_time` |
| Absorb shield | The spell name | `absorbtion` |

They are not emitted when a player removes a buff by hand, or when a shield is used up by damage before its timer ends.

### onPlayerDisconnect and onPlayerLogout

`onPlayerLogout` fires only for a deliberate logout. `onPlayerDisconnect` fires for every way a logged-in player's connection can end, a logout included, because the logout closes the connection.

By the time `onPlayerDisconnect` is emitted the player has already been removed from the player cache, the map index and the AOI. The `player` in the payload is the last copy of their state. Read from it, but do not expect `playerCache.get(player.id)` to return anything.

## Examples

### A kill counter

```ts title="src/plugins/stats/src/index.ts"
import { listener, Events } from "@engine/systems/events";
import log from "@engine/modules/logger";

const kills = new Map<string, number>();

function onDeath({ player, killer }: { player: any; killer?: any }): void {
  if (!killer?.username || killer.username === player.username) return;
  const total = (kills.get(killer.username) ?? 0) + 1;
  kills.set(killer.username, total);
  log.info(`${killer.username} has ${total} player kill(s)`);
}

const plugin: GamePlugin = {
  register() {
    listener.on(Events.PLAYER_DEATH, onDeath);
  },
  unregister() {
    listener.off(Events.PLAYER_DEATH, onDeath);
  },
};

export default plugin;
```

### Periodic work on a tick

```ts title="Announcing the player count once a minute"
import { listener, Events } from "@engine/systems/events";
import playerCache from "@engine/services/playermanager";
import log from "@engine/modules/logger";

listener.on(Events.SAVE, () => {
  log.info(`${Object.keys(playerCache.list()).length} player(s) online`);
});
```

### Reacting to quests and creatures

```ts title="Rewarding a boss kill"
import { listener, Events } from "@engine/systems/events";
import { packetManager } from "@engine/socket/packet_manager";

const BOSS_TEMPLATE_ID = 42;

listener.on(Events.CREATURE_KILL_CREDIT, ({ player, templateId }) => {
  if (templateId !== BOSS_TEMPLATE_ID || !player?.wt) return;
  for (const frame of packetManager.notify({ message: "The cellar king has fallen!" })) {
    player.wt.send(frame);
  }
});
```

### Async handlers

```ts title="Doing slow work without blocking the engine"
import { listener, Events } from "@engine/systems/events";
import log from "@engine/modules/logger";
import query from "@engine/controllers/sqldatabase";

listener.on(Events.QUEST_COMPLETED, ({ username, questId }) => {
  // Not awaited by the engine: catch errors here or they become unhandled rejections.
  recordCompletion(username, questId).catch((error) => log.error(`Could not record quest: ${error}`));
});

// plugin_quest_history is a table this example plugin created for itself.
async function recordCompletion(username: string, questId: number): Promise<void> {
  await query("INSERT INTO plugin_quest_history (username, quest_id, at) VALUES (?, ?, ?)", [username, questId, Date.now()]);
}
```

## The internal event emitter

`src/systems/events.ts` also exports a second emitter named `event`. The engine uses it for one internal signal, `online`, which logs how long startup took. Plugins should use `listener`.
