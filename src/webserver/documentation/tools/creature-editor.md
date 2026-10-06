---
title: Creature Editor
description: Edit creature templates, their abilities and spawn points, and the patrol paths, link groups and spawn pools they use.
order: 90
---

The creature editor is four editors in one window. Creatures are the large record: each has stats, an appearance, rewards, a list of abilities and a list of spawn points. Patrol paths, link groups and spawn pools are the small records that spawn points refer to. This page walks through all four, the tools that act in the game window, and how saving works.

## Opening it

```text title="Chat command"
/ce
/creatureeditor
```

The editor opens in its own window at route `/creature-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.creature_editor` or `tools.*`
- `server.*`

The same rule is applied to every packet the editor sends. A refused packet answers "You do not have permission to use the creature editor."

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench), with one addition: the kinds of record are listed above the record list.

| Kind | What it is |
| --- | --- |
| Creatures | The templates every creature in the world is made from |
| Patrol paths | Routes a spawn can walk |
| Link groups | Sets of spawns that are pulled into a fight together |
| Spawn pools | Caps on how many spawns of a group are alive at once |

Each kind shows how many records it has. Up and Down move through the kinds. The search field, the New button and the list all follow the kind in view. Switching kind with unsaved changes asks whether to save, discard or stay.

Under the list is the switch **Debug overlay in the game window**. It draws spawn markers, aggro and leash circles and the live threat list over the game world while you work.

## Creatures

A creature has five tabs: General, Appearance, Rewards, Abilities and Spawns. The **At a glance** card beside the form describes the creature as its fields stand.

### General tab

**Identity**

| Field | Notes |
| --- | --- |
| Name | The creature's name |
| Title | Shown under the name, like `<Blacksmith>` |
| Rank | Normal, Elite, Rare, Rare elite or Boss |
| Type | Beast, Humanoid, Undead, Elemental, Demon, Dragonkin, Critter or Mechanical |
| Minimum level, Maximum level | Each spawn picks a level between the two |

**Combat**

| Field | Notes |
| --- | --- |
| Stance | Aggressive attacks players who come close. Neutral fights back. Passive runs when hit. |
| Health at level 1 | Its base health |
| Health per level | Added for each level above 1 |
| Armor | |
| Keeps its distance | Stops at range instead of closing in |

**Movement**

| Field | Unit | Notes |
| --- | --- | --- |
| Walk speed | yd/s | Used when idle, wandering or patrolling |
| Run speed | yd/s | Used when chasing or fleeing |
| Leash range | yards | How far it chases from where the fight started before resetting. Empty means the usual 60. |

**Awareness**

| Field | Unit | Notes |
| --- | --- | --- |
| Aggro radius | yards | Empty means the usual 20. It grows or shrinks 1 yard per level of difference to the player. |
| Assist radius | yards | Idle allies this close join in when it is pulled |
| Call for help radius | yards | Idle allies this close join in when it flees |

**Fleeing and recovery**

| Field | Unit | Notes |
| --- | --- | --- |
| Flee at health | % | 0 means it never flees |
| Flee duration | ms | |
| Regenerates out of combat | switch | |

**Exceptions** holds the Flags, as tick boxes, for creatures that do not behave as creatures usually do:

| Flag | Effect |
| --- | --- |
| Cannot be taunted | Taunt effects do not work on it |
| Immune to stun | Stuns do not affect it |
| Immune to root and slow | Roots and slows do not affect it |
| Gives no XP | Killing it gives no experience |
| No leash | It does not reset when dragged far from where the fight started |
| Never flees | It does not flee at low health |
| Can swim | Marked as able to swim |
| Detects stealth | It notices stealthed players |
| No social aggro | It neither calls allies nor answers their calls |

### Appearance tab

**Sprite**

| Field | Notes |
| --- | --- |
| Sprite type | Animated is built from sprite sheets, like a player. Static is one still image. None draws nothing. |
| Body sheet, Head sheet | For an animated creature |
| Static image | For a static creature |
| Scale | 1 is normal size. Bigger creatures also reach further in melee. |

**Worn layers** appear for an animated creature: Helmet, Shoulders, Neck, Gloves, Chest, Boots, Pants and Weapon, in the slots players wear them.

### Rewards tab

| Field | Notes |
| --- | --- |
| XP multiplier | 1 is the normal XP for its level |
| Loot table | Items rolled into its corpse. Tables are made in the [Loot Editor](#/tools/loot-editor). |
| Minimum money, Maximum money | Dropped as coins. Each kill gives an amount picked between the two. |

### Abilities tab

What the creature casts in a fight, and when. "Add ability" adds one. Each ability folds open to its fields.

| Field | Notes |
| --- | --- |
| Spell | A spell from the [Spell Editor](#/tools/spell-editor) |
| Trigger | When it is used, see below |
| Health threshold | Percent. Only used by the low health trigger. |
| Target | Who it is cast on, see below |
| Minimum and Maximum initial delay | Milliseconds. Wait before the first use, picked between the two. |
| Minimum and Maximum cooldown | Milliseconds. Wait between uses, picked between the two. |
| Chance | Percent. How often it is cast when its turn comes. |
| Max range | Yards. 0 uses the spell's own range. |
| Priority | When several are ready at once, the highest goes first |
| Interruptible | Whether the cast can be interrupted |

| Trigger | Fires |
| --- | --- |
| On a timer, in a fight | Repeatedly during combat |
| Once its health is low | When health drops below the threshold |
| When a fight starts | On aggro |
| When it dies | On death |
| When it gives up and resets | On evade |
| While its target is casting | To answer a cast |
| On a timer, out of a fight | Repeatedly while idle |

| Target | Meaning |
| --- | --- |
| Its current target | The player it is attacking |
| A random player it is fighting | Anyone on its threat list |
| A random player, not its current target | Anyone but the one it is attacking |
| The farthest player it is fighting | |
| The most wounded creature nearby | For heals |
| Itself | |

Abilities are saved together, with the creature.

### Spawns tab

**Spawn points** lists where this creature appears in the world. Pick one to change it, or press "New spawn point".

| Group | Field | Notes |
| --- | --- | --- |
| Where | Map, X, Y, Facing | Where it stands and which way it faces |
| Respawn | Minimum respawn, Maximum respawn | Seconds. Each respawn waits a time picked between the two. |
| Respawn | Layers | Per layer: one creature on every layer. Shared: one creature all layers see. See [AOI and Layers](#/engine/aoi-and-layers). |
| Movement | Movement | Idle, Wander or Patrol |
| Movement | Wander radius | Yards. Only used with wander movement. |
| Movement | Patrol path | Only used with patrol movement. The path has to be on this spawn's map. |
| Grouping | Link group | Linked spawns are pulled together |
| Grouping | Spawn pool | Caps how many spawns in the pool are alive at once |

Two buttons act in the game window:

- **Place in world.** Press it, then click in the game window where the creature should stand. The map and position are set from that click. Escape in the game cancels.
- **Go to.** Moves your character to the saved spawn point, on its map.

A spawn point belongs to a saved creature. On a new creature, the tab offers "Save creature" first.

## Patrol paths

| Field | Notes |
| --- | --- |
| Map | The map the path is on |
| Loop | On: walks from the last point back to the first. Off: walks back and forth. |
| Points | Where it walks, in order, and how long it stops at each |

The **Shape** card beside the form draws the points in the order they are walked.

**Draw path** lets you click the path into the world: press the button, then click in the game window to add points after the existing ones. They appear in the editor as you click.

| In the game window | Result |
| --- | --- |
| Click | Adds a point |
| Shift + click | Adds a point with a 2 second wait |
| Enter or Escape | Finishes drawing |

The path takes the map you are standing on. Saving also finishes drawing.

## Link groups

A link group has one field, Name. Spawns in the same link group are pulled together: attack one and the others join.

## Spawn pools

| Field | Notes |
| --- | --- |
| Max alive at once | How many of the pool's spawn points can be alive together |
| Rare chance | Percent. Chance a respawn is the rare creature instead. Never two rares at once. |
| Rare creature | The creature that appears on a rare roll |

## Saving

Each kind has its own save and delete packet. A creature's abilities and its open spawn point are saved by their own requests when you press Save.

| Action | Packet |
| --- | --- |
| Open and reload | `CREATURE_EDITOR_LIST` |
| Close | `CREATURE_EDITOR_CLOSE` |
| Save or delete a creature | `CREATURE_EDITOR_SAVE_TEMPLATE`, `CREATURE_EDITOR_DELETE_TEMPLATE` |
| Save a creature's abilities | `CREATURE_EDITOR_SAVE_ABILITIES` |
| Save or delete a spawn point | `CREATURE_EDITOR_SAVE_SPAWN`, `CREATURE_EDITOR_DELETE_SPAWN` |
| Save or delete a patrol path | `CREATURE_EDITOR_SAVE_PATH`, `CREATURE_EDITOR_DELETE_PATH` |
| Save or delete a link group | `CREATURE_EDITOR_SAVE_LINKGROUP`, `CREATURE_EDITOR_DELETE_LINKGROUP` |
| Save or delete a spawn pool | `CREATURE_EDITOR_SAVE_POOL`, `CREATURE_EDITOR_DELETE_POOL` |
| Go to a spawn point | `CREATURE_EDITOR_ACTION` with action `goto` |

The server validates every save and answers with `CREATURE_EDITOR_RESULT`. A refused save comes back as sentences. The editor shows them at the top of the page, marks the fields they are about and points at the tab. After a successful change, other admins with the editor open receive `CREATURE_EDITOR_UPDATED`.

Changes apply to the running world without a restart.

## Tips

- Build in this order: loot table, creature, patrol path or link group if needed, then spawn points. Each step only refers to things that already exist.
- Leave Leash range and Aggro radius empty unless a creature needs to be different. The defaults of 60 and 20 yards suit most.
- Turn on the debug overlay while placing spawns. The aggro circles show at once whether two packs will pull together.
- Use a spawn pool with a rare creature for named enemies: several spawn points, one alive at a time, and a small rare chance.
- For a boss, set the flags "Immune to stun" and "Cannot be taunted" only if the fight is designed around it. They remove tools players rely on.
- Quests with a Kill objective refer to the creature. Check the [Quest Editor](#/tools/quest-editor) before deleting one.
