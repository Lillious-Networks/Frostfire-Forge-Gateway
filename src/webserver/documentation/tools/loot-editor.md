---
title: Loot Editor
description: Create loot tables and edit their rows in place: which items drop, how many, and how often.
order: 110
---

A loot table lists the items a creature or a chest can drop, and how often. The loot editor creates and deletes tables and edits their rows in place. There is no Save button: every change is sent as you make it. This page covers the window, the rules for a row, and the packets behind each change.

## Opening it

```text title="Chat command"
/le
/looteditor
```

The editor opens in its own window at route `/loot-editor`. Typing the command again closes it.

## Permission

The loot editor needs `admin.loot` or `admin.*` in your permission list.

:::warning This is not a tools permission
Unlike the other editors, the loot editor is not opened by `tools.*`, and the admin role alone does not open it either. It uses the same permission as the `/loottable` command. The server checks it again on every change.
:::

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the loot tables, and New |
| Top bar | The open table as "Table N" with its row count, the state, then Reload and Delete |
| Page | The field that adds an item, and the rows of the table |

The search field filters the tables by name. A table's number finds it too.

The state reads "Changes save automatically" when the server has everything, and "Saving" while a change is on its way. Ctrl+S has nothing to do here.

**Reload** reads the tables again from the server. Use it when another admin may have changed them.

## Creating a table

Press New. The editor asks for a table name, up to 64 characters. Name it after what drops it, for example "Wolf drops". Names must be unique: a second table with the same name is refused.

## Rows

Each row is one item that can drop.

| Column | Rule | Meaning |
| --- | --- | --- |
| Item | An existing item | What drops |
| Fewest | Whole number from 1 to 9999 | The smallest amount |
| Most | Whole number from 1 to 9999 | The largest amount |
| Chance | 0 to 100 | Chance to drop, in percent |

Each row rolls its chance on its own. When it hits, the amount that drops is picked between the fewest and the most.

- Edit a number in a row and it is sent to the server at once.
- The remove button on a row deletes that row.
- A row takes the quality of its item. The editor changes a row's numbers only.

### Adding an item

Type part of an item name in "Add an item to this table". Matching items are listed with their quality, and items already in the table are marked "in this table". Click one, or press Enter when exactly one matches, to add it. Up and Down move through the suggestions and Escape closes them.

A new row starts as one item that always drops: Fewest 1, Most 1, Chance 100.

:::warning Only items you carry can be found
The add field searches the items your game window knows, which are the items in your own character's inventory. If the item you want is not suggested, give it to yourself first, for example with "Give item" in the [Control Panel](#/tools/control-panel), then come back.
:::

## Deleting a table

Delete in the top bar removes the open table and all its rows after a confirmation. The table is removed for good.

:::note
Creatures point at a loot table from their Rewards tab in the [Creature Editor](#/tools/creature-editor). Check that no creature still uses a table before you delete it.
:::

## Saving

Every change is its own request. One request is in flight at a time, and anything you do meanwhile is sent when the answer has arrived.

| Action | Packet | Data |
| --- | --- | --- |
| Open, Reload | `LIST_LOOT_TABLES` | None |
| Create a table | `LOOT_EDITOR_CREATE_TABLE` | `name` |
| Delete a table | `LOOT_EDITOR_DELETE_TABLE` | `id` |
| Add a row | `LOOT_EDITOR_ADD_ITEM` | `tableId`, `itemName`, `minQuantity`, `maxQuantity`, `dropChance` |
| Change a row | `LOOT_EDITOR_UPDATE_ITEM` | `itemId`, `minQuantity`, `maxQuantity`, `dropChance` |
| Remove a row | `LOOT_EDITOR_REMOVE_ITEM` | `itemId` |

The server answers each change with `LOOT_EDITOR_RESULT`: whether it was made, why not when it was not, and the tables as they stand afterwards. The window redraws from that list, so what you see is always what the server holds.

Reasons a change can be refused include "Give the loot table a name.", a duplicate table name, "The fewest and the most must be whole numbers from 1 to 9999.", "The chance must be from 0 to 100." and an item name that does not exist.

If no answer arrives in time, the editor says that nothing was confirmed. Press Reload to see what the server really holds.

## Other ways to edit loot

- The Items and Loot page of the [Control Panel](#/tools/control-panel) has the same tables, with a quality choice per row.
- The `/loottable` chat command creates tables and rows from the chat. See [Admin Commands](#/engine/admin-commands).

## Tips

- Keep one table per kind of enemy or chest and name it after the source. Reusing one table for many creatures makes later tuning hard.
- For a guaranteed drop, leave Chance at 100. For a rare drop, use a low chance and put the common drops in their own rows.
- Use Fewest and Most for stackable materials, for example 1 to 3 pelts.
- To test a table, spawn a chest from it in the Control Panel and open it a few times.
