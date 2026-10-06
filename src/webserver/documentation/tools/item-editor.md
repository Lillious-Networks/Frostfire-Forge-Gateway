---
title: Item Editor
description: Create and edit items: name, type, quality, icon, equipment slot, weapon damage, bag size and stats.
order: 100
---

The item editor creates, changes and deletes the rows of the `items` table from inside the game. This page covers the window, every field, the rules the server enforces and how saving works.

How players use items is described in [Inventory and Equipment](#/player-guide/inventory-and-equipment).

## Opening it

```text title="Chat command"
/ie
/itemeditor
```

The editor opens in its own window at route `/item-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.item_editor` or `tools.*`
- `server.*`

The same rule is applied to every packet the editor sends. A refused packet answers "You don't have permission to use the item editor."

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the items found, and New |
| Top bar | The open item, its state, then Duplicate, Delete and Save |
| Tabs | General, Equipment, Stats |
| Page | The form, with the "At a glance" card beside it |

:::note The list starts empty
The editor never loads the whole item table. Type part of a name and it lists the matches, up to 50, with names that start with what you typed first. When more match, the list says so: narrow the search.
:::

The **At a glance** card beside the form shows the item as its fields describe it, with its icon in the rarity frame of its quality.

## General tab

| Field | Notes |
| --- | --- |
| Name | Required, up to 255 characters. Must be unique: items are looked up by name. |
| Type | Consumable, Equipment, Material, Quest or Miscellaneous |
| Quality | Common, Uncommon, Rare, Epic or Legendary. Sets the colour of the name and the icon frame. |
| Icon | Picked from the icons the asset server has |
| Level requirement | Shown here for items that are not equipment. At least 1 when set. |
| Description | Shown in the item's tooltip. Up to 255 characters. |

## Equipment tab

| Field | Notes |
| --- | --- |
| Equipable | Can be worn from the inventory. Only items of type Equipment can be equipable. |
| Slot | Where it is worn. Required for an equipable item. |
| Level requirement | Players below this level cannot equip it |

The slots are: helmet, necklace, shoulderguards, cape, chestplate, wristguards, gloves, belt, pants, boots, ring 1, ring 2, trinket 1, trinket 2, weapon and bag.

Two slots add a card of their own.

### Weapon

| Field | Notes |
| --- | --- |
| Minimum damage per swing | At least 1. Leave both damage fields empty to use the Damage stat instead. |
| Maximum damage per swing | At least 1, and not below the minimum |
| Swing speed | Milliseconds between swings. Lower is faster. At least 500. |

These three drive melee auto attacks. They only apply to items in the weapon slot: the server refuses them on anything else.

### Bag

| Field | Notes |
| --- | --- |
| Bag slots | Extra inventory slots the bag gives. Cannot be negative. |

## Stats tab

The stats an item gives while worn:

| Field | Unit |
| --- | --- |
| Armor | |
| Damage | |
| Health | |
| Stamina | |
| Critical chance | % |
| Critical damage | % |
| Avoidance | |

Leave a stat empty for an item that does not give it.

## Saving

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `ITEM_EDITOR_LIST` | Sends the types, qualities, slots, icons and the item count |
| Search | `ITEM_EDITOR_SEARCH` | Returns matching items |
| Save | `ITEM_EDITOR_SAVE` | Validates, then inserts or updates the `items` row and refreshes the item cache |
| Delete | `ITEM_EDITOR_DELETE` | Deletes the row and refreshes the item cache |

The answer is `ITEM_EDITOR_RESULT`. After a successful change, every other online account that may use the editor receives `ITEM_EDITOR_UPDATED`.

A refused save comes back as sentences such as "An item with that name already exists." or "Equipable items need an equipment slot." The editor shows them at the top of the page, marks the field each one is about and points at its tab.

A saved item is live at once: the server answers from its in-memory item cache, which the save refreshes.

:::warning Items are referred to by name
Loot tables, quest rewards, quest collect objectives and player inventories all point at an item by its name. Before deleting an item, check where it is used, for example in the [Loot Editor](#/tools/loot-editor) and the [Quest Editor](#/tools/quest-editor).
:::

## Tips

- Use Duplicate to build a set: make the helmet, duplicate it for each slot, then change name, slot, icon and stats.
- Give every weapon a damage range and a swing speed. A weapon without a range falls back to its flat Damage stat.
- Use the Quest type for items that exist only for a Collect objective, so players can tell them apart.
- Bags are equipment in the bag slot. Set Equipable on, Slot to bag, then Bag slots.
- After creating an item, try it with "Give item" in the [Control Panel](#/tools/control-panel) or the Inventory tab of the [Player Editor](#/tools/player-editor).
