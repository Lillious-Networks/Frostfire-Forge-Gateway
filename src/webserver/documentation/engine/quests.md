---
title: Quests
description: How quests are stored and run, covering NPC dialogue and gossip chains, the quest flow, objective types, rewards, and repeatable and daily quests.
order: 110
---

Quests are rows in a handful of tables, linked to the NPCs that give and end them. This page explains that data, what happens when a player talks to an NPC, how each objective type earns credit, how rewards are granted, and how repeatable and daily quests reset.

Quests are normally written in the [Quest Editor](#/tools/quest-editor) and linked to NPCs in the [NPC Editor](#/tools/npc-editor). The player's view is on the [Quests](#/player-guide/quests) page of the player guide. The code lives in `src/systems/quests/`.

## The data

| Table | Holds |
|-------|-------|
| `quests` | One row per quest: texts, levels, XP and copper rewards, repeat rule, chain link |
| `quest_objectives` | The objectives of each quest |
| `quest_rewards` | The item rewards of each quest |
| `quest_prerequisites` | Quests that must be completed first |
| `npc_quests` | Which NPC gives a quest and which NPC ends it |
| `quest_log` | Per player: each quest's state, and when it was accepted and completed |
| `quest_objective_progress` | Per player: the count reached on each objective |

### Quest fields

| Field | Meaning |
|-------|---------|
| `id` | Quest id |
| `name` | Title shown in the log and on the NPC's list |
| `zone` | Optional zone label |
| `offer_text` | What the NPC says when offering the quest |
| `description` | The objectives summary shown in the log |
| `progress_text` | What the ending NPC says while the quest is still in progress |
| `completion_text` | What the ending NPC says at turn-in |
| `required_level` | Lowest player level that may accept it |
| `quest_level` | The level shown for the quest. Falls back to `required_level` when 0 |
| `xp_reward` | XP granted at turn-in |
| `copper_reward` | Copper granted at turn-in |
| `repeatable` | `none`, `repeatable` or `daily`. Anything else is read as `none` |
| `next_quest_id` | The follow-up quest the client is pointed to after turn-in |
| `sort_order` | Display order |

When quests are loaded each one also gets three arrays that are not columns: `objectives`, `rewards` and `prerequisites` (a list of quest ids).

### Objective fields

| Field | Meaning |
|-------|---------|
| `type` | `kill`, `collect`, `talk` or `explore` |
| `target` | What to act on. Its meaning depends on `type`, see [Objective types](#/engine/quests/objective-types) |
| `required_count` | How many are needed |
| `target_x`, `target_y`, `target_radius` | Only for `explore`: a point and radius in pixels. Leave them empty for a whole-map objective |
| `description` | The line shown in the tracker, for example "Rats slain" |
| `sort_order` | Display order |

### Reward fields

| Field | Meaning |
|-------|---------|
| `item_name` | Name of an item in the items table |
| `quantity` | How many |
| `is_choice` | `0` is always granted. `1` puts the item in the choice set, from which the player picks exactly one |
| `sort_order` | Order within the guaranteed list or the choice set |

### Linking a quest to NPCs

`npc_quests` connects a quest to an NPC with a `role`:

| `role` | Meaning |
|--------|---------|
| `giver` | The NPC offers the quest |
| `ender` | The NPC accepts the turn-in |

A quest can have several givers and several enders, and the giver and the ender can be the same NPC. The server checks the role on every accept and turn-in, so a client cannot accept a quest from an NPC that does not give it.

## A complete example

The setup script seeds two chained quests. This is the same data written as plain SQL.

```sql title="A quest with one objective of each type"
INSERT INTO quests
  (name, zone, offer_text, description, progress_text, completion_text,
   required_level, quest_level, xp_reward, copper_reward, repeatable, sort_order)
VALUES
  ('Rats in the Cellar', 'overworld',
   'The cellar is overrun with rats. Please, deal with them!',
   'Slay rats, gather their tails, and speak with the innkeeper.',
   'You still have work to do. Check your objectives.',
   'Thank you! The cellar is safe once more.',
   1, 1, 50, 100, 'none', 0);

-- Assume the quest above got id 1, creature template 1 is the rat and NPC 1 is the innkeeper.
INSERT INTO quest_objectives (quest_id, sort_order, type, target, required_count, description) VALUES
  (1, 0, 'kill',    '1',         3, 'Rats slain'),
  (1, 1, 'collect', 'Rat Tail',  2, 'Rat tails collected'),
  (1, 2, 'talk',    '1',         1, 'Speak with the innkeeper'),
  (1, 3, 'explore', 'overworld', 1, 'Explore the overworld');

INSERT INTO quest_rewards (quest_id, item_name, quantity, is_choice, sort_order) VALUES
  (1, 'Bread', 1, 0, 0);

INSERT INTO npc_quests (npc_id, quest_id, role) VALUES
  (1, 1, 'giver'),
  (1, 1, 'ender');
```

```sql title="A follow-up quest with a choice of reward"
INSERT INTO quests
  (name, zone, offer_text, description, progress_text, completion_text,
   required_level, quest_level, xp_reward, copper_reward, repeatable, next_quest_id, sort_order)
VALUES
  ('The Cellar Aftermath', 'overworld',
   'Now that the rats are gone, take this bread to the traveler.',
   'A chained follow-up to the first quest.',
   'You have not finished helping yet.',
   'You have done well, traveler.',
   1, 2, 100, 200, 'none', NULL, 1);

-- Assume it got id 2.
INSERT INTO quest_prerequisites (quest_id, required_quest_id) VALUES (2, 1);
UPDATE quests SET next_quest_id = 2 WHERE id = 1;

INSERT INTO quest_objectives (quest_id, sort_order, type, target, required_count) VALUES
  (2, 0, 'talk', '1', 1);

INSERT INTO quest_rewards (quest_id, item_name, quantity, is_choice, sort_order) VALUES
  (2, 'Bread', 1, 1, 0),
  (2, 'Apple', 1, 1, 1);
```

:::warning Restart after editing with SQL
Quest definitions are loaded into memory at startup and indexed by target. Rows written with SQL are not seen until the engine restarts. The quest editor reloads the definitions for you after every save.
:::

## Talking to an NPC

The client sends `NPC_INTERACT` with the NPC's id. The server:

1. Ignores the request from a corpse or ghost, for a hidden NPC, and for an NPC on another map.
2. Checks the player is within 120 pixels of the NPC, otherwise it answers `QUEST_ERROR` with code `too_far`.
3. Credits any `talk` objective that targets this NPC and sends `QUEST_PROGRESS` for it.
4. Works out what this NPC can show this player, then answers with one packet:

| Situation | Packet sent |
|-----------|-------------|
| Nothing to show | `NPC_GOSSIP` with an empty quest list. The client shows the NPC's dialogue or gossip only |
| Exactly one visible quest, not yet taken | `QUEST_OFFER` with the quest, `canAccept` and the eligibility reason |
| Exactly one visible quest, in progress | `QUEST_INCOMPLETE` with the quest and the current counts |
| Exactly one visible quest, ready | `QUEST_TURN_IN_OFFER` with the quest |
| More than one | `NPC_GOSSIP` with the list, and the player picks one (`QUEST_SELECT`) |

Quests that are locked by level or by a missing prerequisite are hidden, and do not count toward the "exactly one" rule.

Each player may send at most 5 quest packets of one kind in 3 seconds. Extra ones are dropped.

### Dialogue and gossip chains

An NPC has two text fields:

| Field | Use |
|-------|-----|
| `dialog` | A single line. Sent as `gossipText` in the `NPC_GOSSIP` packet |
| `gossip` | A gossip chain: one line per step, separated by line breaks |

The gossip chain is played by the client. When a player talks to the NPC the chain starts from its first line in the NPC's overhead speech bubble, each line stays up for `2500 + 45 * length` milliseconds, and the bubble clears after the last line. Talking again while it plays jumps to the next line. Talking after it finished replays it.

```text title="A gossip chain in the NPC editor"
Welcome back, ${player.name}.
I hear you have reached level ${player.level} already.
The cellar still needs someone brave.
```

### Placeholders

Any `${player...}` expression in NPC text is filled in by the client from the player who is reading it.

| Placeholder | Value |
|-------------|-------|
| `${player.name}` | Username |
| `${player.username}` | Username |
| `${player.userid}` | Account id |
| `${player.level}` | Level |
| `${player.guild_name}` | Guild name |
| `${player.mounted}` | `true` or `false` |
| `${player.isAdmin}` | `true` or `false` |
| `${player.isGuest}` | `true` or `false` |
| `${player.stats.<stat>}` | Any stat: `level`, `xp`, `max_xp`, `health`, `max_health`, `total_max_health`, `stamina`, `max_stamina`, `total_max_stamina`, `stat_damage`, `stat_armor`, `stat_health`, `stat_stamina`, `stat_critical_chance`, `stat_critical_damage`, `stat_avoidance` |
| `${player.currency.<coin>}` | `copper`, `silver` or `gold` |

`name` and `level` are shortcuts. Every other path is followed as written on the client's player object, so the table lists the paths the NPC editor suggests rather than a closed set. A path that leads nowhere, or to an object instead of a value, is left in the text as written.

## Quest flow

A quest moves through three states in a player's log:

| State | Meaning |
|-------|---------|
| `active` | Accepted, objectives not all met |
| `ready` | Every objective met, waiting for turn-in |
| `completed` | Turned in. Kept as history, and used for prerequisites |

### Accepting

The client sends `QUEST_ACCEPT` with `npcId` and `questId`. The server checks the distance and the NPC's `giver` role, then the player's eligibility:

| Eligibility | Meaning | Message |
|-------------|---------|---------|
| `available` | Can be accepted | none |
| `active` | Already in the log | That quest is already in your log. |
| `ready` | In the log and ready | That quest is ready to turn in. |
| `completed` | Done, and not repeatable | You have already completed that quest. |
| `level_too_low` | Below `required_level` | You are not high enough level for that quest. |
| `missing_prerequisite` | A prerequisite quest is not completed | You must complete the previous quest first. |
| `log_full` | 25 active quests already | Your quest log is full. |
| `daily_not_reset` | A daily quest completed since the last reset | That daily quest is not available yet. |
| `unknown_quest` | No such quest | You cannot accept that quest. |

On success the client gets `QUEST_LOG_ENTRY` with the new entry and the quest definition. The server then backfills what the player already has: `collect` objectives are set from the inventory, whole-map `explore` objectives are credited if the player is on that map, and a radius objective is credited if the player is already standing inside it. A quest with no objectives is `ready` the moment it is accepted.

The log holds at most 25 active quests:

```ts title="src/systems/quests/log.ts"
export const MAX_ACTIVE_QUESTS = 25;
export const DAILY_RESET_UTC_HOUR = 3;
```

### Progress

Whenever an objective count changes the client gets `QUEST_PROGRESS` with a list of updates:

```ts title="types.d.ts"
declare interface ObjectiveUpdate {
  questId: number;
  objectiveId: number;
  type: QuestObjectiveType;
  target: string;
  count: number;
  required: number;
  /** This update pushed the whole quest to 'ready'. */
  questReady: boolean;
}
```

Counts never go above `required_count`.

### Turning in

The client sends `QUEST_TURN_IN` with `npcId`, `questId` and, when the quest has a choice set, `rewardChoiceIndex`. The server checks distance, the NPC's `ender` role and that the quest is `ready`, grants the rewards, then marks the quest `completed`.

On success the client gets `QUEST_LOG_ENTRY` (entry removed), `QUEST_COMPLETED` with `questId`, `xp`, `copper`, `items` and `nextQuestId`, and fresh inventory, currency and stats. `nextQuestId` is the quest's `next_quest_id`, which lets the client open the follow-up straight away.

### Abandoning and declining

`QUEST_ABANDON` removes an active or ready quest from the log and deletes its progress. It never deletes a `completed` row, so abandoning cannot erase history. `QUEST_DECLINE` changes nothing on the server. It exists so packet interceptors and plugins can observe it.

### Errors

Every refusal is a `QUEST_ERROR` packet with a `code` and a `message`.

| Code | When |
|------|------|
| `too_far` | More than 120 pixels from the NPC |
| `not_giver` | The NPC does not offer that quest |
| `not_ender` | The NPC does not complete that quest |
| `not_active` | The quest is not in the player's log |
| `not_ready` | Objectives are not all met |
| `bad_choice` | The quest has a choice set and no valid choice was sent |
| `bag_full` | The rewards do not fit in the player's bags |
| `bad_item` | A reward names an item that does not exist |
| `bad_quantity` | A reward has an invalid quantity |
| `db_error` | A database write failed |
| An eligibility value | The accept was refused for that reason, see the table above |

## Objective types

| Type | `target` holds | How credit is earned |
|------|----------------|----------------------|
| `kill` | A creature template id, as text | One count each time a creature of that template dies, for every eligible member of the group that tagged it |
| `collect` | An item name, compared without regard to case | The count is set from the player's inventory whenever it changes, so it goes down again if the items are lost |
| `talk` | An NPC id, as text | One count each time the player interacts with that NPC |
| `explore` | A map name, without `.json` | Whole map: credited on entering the map. With `target_x`, `target_y` and `target_radius`: credited when the player stands within the radius of the point |

Details that matter when writing objectives:

- Only `collect` can lose progress. A `ready` quest whose items are sold or dropped goes back to `active`.
- Point and radius `explore` objectives are checked once a second, on the `onServerTick` event, and only for players who have such an objective active. They are also checked on entering the map.
- A `kill` target is a template id, not a creature name, because several spawns can share one template. See the [Creature Editor](#/tools/creature-editor).

```sql title="An explore objective with a point and radius"
INSERT INTO quest_objectives
  (quest_id, sort_order, type, target, required_count, target_x, target_y, target_radius, description)
VALUES
  (3, 0, 'explore', 'overworld', 1, 4200, 1880, 160, 'Find the old well');
```

## Rewards

A quest can grant four things at turn-in:

| Reward | Source |
|--------|--------|
| Guaranteed items | `quest_rewards` rows with `is_choice` 0. All of them are granted |
| One chosen item | `quest_rewards` rows with `is_choice` 1. The player picks one, sent as an index into that set ordered by `sort_order` |
| XP | `quests.xp_reward` |
| Currency | `quests.copper_reward`, added as copper |

Before anything is given the server checks that every reward item exists, that the quantities are valid, and that the items fit in the player's bags. If any check fails the turn-in is refused and nothing is granted, so rewards are never handed out in part.

```ts title="src/systems/quests/rewards.ts"
export function validateChoice(quest: Quest, rewardChoiceIndex?: number): boolean {
  const choices = choiceSet(quest);
  if (choices.length === 0) return true;
  return (
    typeof rewardChoiceIndex === "number" &&
    Number.isInteger(rewardChoiceIndex) &&
    rewardChoiceIndex >= 0 &&
    rewardChoiceIndex < choices.length
  );
}
```

If the XP makes the player level up, the server recalculates their stats, refills health and stamina, and emits `onPlayerLevelUp`.

## Repeatable and daily quests

The `repeatable` column decides what happens after a quest has been completed once.

| Value | After completion |
|-------|------------------|
| `none` | The quest is `completed` for good and is never offered again |
| `repeatable` | Offered again at once. Accepting it clears the old progress and starts over |
| `daily` | Offered again after the next daily reset |

The daily reset is at **03:00 UTC** for the whole server. A daily quest is unavailable while its `completed_at` time is later than the most recent reset:

```ts title="src/systems/quests/log.ts"
export function lastResetBoundary(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const boundary = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    DAILY_RESET_UTC_HOUR, 0, 0, 0
  );
  if (nowMs < boundary) return boundary - 24 * 60 * 60 * 1000;
  return boundary;
}
```

Level and prerequisite checks still apply every time a repeatable or daily quest is accepted. `quest_log.times_completed` counts the turn-ins.

```sql title="Make a quest daily"
UPDATE quests SET repeatable = 'daily' WHERE id = 1;
```

## Quest markers

The server sends `QUEST_MARKERS` with one marker per NPC on the player's map. It is sent after login, after every accept, abandon, turn-in and talk credit, and when the player levels up.

| Marker | When | Drawn by the client as |
|--------|------|------------------------|
| `ready` | The NPC ends a quest that is ready | Gold `?` |
| `available` | The NPC gives a quest the player can accept | Gold `!` |
| `in_progress` | The NPC ends a quest that is still active | Grey `?` |
| `available_future` | Used in an NPC's quest list for a quest the player cannot take yet | Grey `!` |
| `none` | Nothing to show | Nothing |

When an NPC has several quests the highest one in that table wins. Locked quests (level, prerequisite, full log, daily cooldown) put no marker above an NPC's head.

## Events

Plugins can follow quest progress through the event bus. Payloads are documented on the [Listener Events](#/engine/listener-events) page.

| Event | Emitted when |
|-------|--------------|
| `onQuestAccepted` | A quest is accepted |
| `onQuestObjectiveProgress` | An objective count changes |
| `onQuestReady` | Every objective of a quest is met |
| `onQuestCompleted` | A quest is turned in |
| `onQuestAbandoned` | A quest is abandoned |
| `onCreatureKillCredit` | A player gets kill credit, with the quest updates it caused |

```ts title="Reacting to a completed quest from a plugin"
import { listener, Events } from "@engine/systems/events";
import log from "@engine/modules/logger";

listener.on(Events.QUEST_COMPLETED, ({ username, questId, rewards }) => {
  log.info(`${username} finished quest ${questId} and received ${rewards.items?.length ?? 0} item stack(s)`);
});
```

## Admin tools

The [Player Editor](#/tools/player-editor) can change a player's quest log directly. These actions skip the normal rules:

| Action | Effect |
|--------|--------|
| Accept | Starts a quest whatever its giver, level, prerequisites or daily reset say. A full log still refuses it |
| Complete | Marks a quest completed without a turn-in, so no rewards are granted |
| Abandon | Removes an active quest, as the player could |
| Forget | Erases a quest from the log, history included, as if it was never taken |

Deleting a quest in the quest editor removes it from every player's log and progress.
