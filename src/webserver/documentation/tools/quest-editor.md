---
title: Quest Editor
description: Create and edit quests: texts, level rules, chains, objectives, rewards, and the NPCs that give and end each quest.
order: 70
---

The quest editor creates, changes and deletes quests from inside the game. It covers the whole quest: who it is for, what the player reads, what has to be done, what is paid out, and which NPCs hand it out and take it back. This page walks through the window, every field and the rules the server enforces on save.

How quests behave for players, text placeholders and the underlying tables are described in [Quests](#/engine/quests).

## Opening it

```text title="Chat command"
/qe
/questeditor
```

The editor opens in its own window at route `/quest-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.quest_editor` or `tools.*`
- `server.*`

The server checks this again on every packet the editor sends. A refused packet answers "You do not have permission to use the quest editor."

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the quests found, and New |
| Top bar | The open quest, its state, then Duplicate, Delete and Save |
| Tabs | General, Texts, Objectives, Rewards |
| Page | The form, with the "As a player meets it" card beside it |

Quests are edited by search. The editor never loads the whole quest table: type part of a name and open a result. A search returns up to 50 quests.

The **As a player meets it** card stays beside the form on every tab. It states in plain words what the quest asks for and what it gives, as a player would see it.

## General tab

### Quest

| Field | Notes |
| --- | --- |
| Name | Required. Up to 255 characters. |
| Zone | Groups the quest in the player's log |
| Required level | At least 1. Players below it are not offered the quest. |
| Quest level | Sets the difficulty colour. 0 uses the required level. |
| Repeatable | Not repeatable, Repeatable or Daily: whether a player who has finished it can take it again |
| Sort order | Lower numbers are listed first |

### Quest chain

| Field | Notes |
| --- | --- |
| Next quest | Offered right after this one is turned in |
| Prerequisites | Quests that must be completed before this one is offered. Pick several. |

The server refuses chains that cannot work: a quest cannot chain into itself, cannot require itself, and a prerequisite that would create a cycle is rejected.

### NPCs

| Field | Notes |
| --- | --- |
| Given by | The NPCs that offer the quest |
| Turned in to | The NPCs the finished quest is handed in to |

:::warning Only quest givers can be picked
Both pickers list only NPCs marked as quest givers. If the NPC you want is missing, open it in the [NPC Editor](#/tools/npc-editor), turn on its quest giver flag and save. The quest editor then offers it.
:::

## Texts tab

| Field | Shown |
| --- | --- |
| Offer text | When the NPC offers the quest |
| Log description | In the quest log while the quest is active |
| Progress text | When talking to the NPC before the objectives are done |
| Completion text | When the quest is turned in |

## Objectives tab

Each objective is a card titled "Objective N" with its type. "Add objective" adds one.

| Type | Target field | The target is |
| --- | --- | --- |
| Kill | Creature to kill | A creature from the [Creature Editor](#/tools/creature-editor) |
| Collect | Item to collect | An item by name, from the [Item Editor](#/tools/item-editor) |
| Talk | NPC to talk to | An NPC |
| Explore | Map to reach | A map name |

Fields of an objective:

| Field | Notes |
| --- | --- |
| Type | One of the four types above. Changing it clears the target. |
| Target | Depends on the type |
| Required count | A whole number of at least 1 |
| X, Y, Radius | Explore objectives only. A radius in pixels around a point on the map. A radius needs both X and Y. |
| Display text (optional) | Replaces the generated line in the quest log, for example "Wolf pelts collected" |

## Rewards tab

### Experience and money

| Field | Notes |
| --- | --- |
| XP reward | Given to every player who turns the quest in |
| Money reward | Entered as gold, silver and copper |

### Item rewards

Each item reward is a card titled "Item reward N". "Add item reward" adds one.

| Field | Notes |
| --- | --- |
| Item | Search for an item by name |
| Quantity | A whole number of at least 1 |
| Player's choice | On: the player picks one of the rewards marked as a choice. All other rewards are always given. |

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `QUEST_EDITOR_DATA` | Sends the objective types, repeat modes and the lists the pickers use |
| Search | `QUEST_EDITOR_SEARCH` | Returns matching quests |
| Save | `QUEST_EDITOR_SAVE` | Validates the whole quest and stores it with its objectives, rewards, prerequisites and NPC links |
| Delete | `QUEST_EDITOR_DELETE` | Removes the quest with its objectives, rewards and prerequisite links |

The answer is `QUEST_EDITOR_RESULT`. After a successful save or delete, every other online account that may use the editor receives `QUEST_EDITOR_UPDATED`.

The server validates everything again, whatever the window checked. Problems come back as lines such as "Objective 2: target is required." The editor shows each line at the top of the page, marks the field it is about and puts a count on that field's tab. Among the rules:

- A kill target must match a creature, a collect target an item name, a talk target an NPC and an explore target a map.
- Reward items must exist.
- NPCs under "Given by" and "Turned in to" must exist and be quest givers.
- The next quest and every prerequisite must exist.

:::warning Deleting does not ask who is on the quest
Delete removes the quest definition. It is also removed from every other quest's prerequisites. Check that players are not in the middle of it first, for example with the Quests tab of the [Player Editor](#/tools/player-editor).
:::

## Tips

- Build a chain from its last quest backwards. "Next quest" can only point at a quest that already exists.
- Use "Duplicate" for daily variants: copy the quest, set Repeatable to Daily and adjust the rewards.
- For "bring me N items" quests, use a Collect objective. It counts what the player's inventory holds.
- Mark two or three item rewards as "Player's choice" to let each class pick something useful. Rewards without the mark are always given on top.
- After saving, test with a second account or reset your own progress with "Forget" in the Player Editor.
