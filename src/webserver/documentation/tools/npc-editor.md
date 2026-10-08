---
title: NPC Editor
description: Place NPCs on the map you stand on and edit their name, sprite, dialogue, script, quests and particles.
order: 80
---

The NPC editor works on the NPCs of the map your character is standing on. NPCs are placed and dragged in the game window and edited in a tool window beside it. This page covers both halves, every field, the permissions involved and how saving works.

## Opening it

Stand on the map whose NPCs you want to edit and type:

```text title="Chat command"
/ne
/npceditor
```

The editor opens in its own window at route `/npc-editor`. Typing the command again closes it.

## Permission

| Step | Needs | What happens without it |
| --- | --- | --- |
| Open the editor | `tools.npc_editor` or `tools.*` | "You don't have permission to use this command" |
| Add an NPC | `server.admin` or `server.*` | "You do not have permission to add NPCs." |
| Save an NPC | `server.admin` or `server.*` | "You do not have permission to save NPCs." |
| Delete an NPC | `server.admin` or `server.*` | "You do not have permission to delete NPCs." |

:::warning Opening is not enough to save
The `tools.npc_editor` permission only opens the window. Every change is checked against `server.admin` or `server.*`. Give NPC builders both. The admin role on its own opens nothing here.
:::

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the NPCs of the current map, and New |
| Top bar | The open NPC, its state, then Delete and Save |
| Tabs | General, Appearance, Dialogue, Quests, Vendor & Inn, Effects |
| Page | The form, with the "At a glance" card beside it |

There is no Duplicate button: an NPC is placed, not copied.

The list holds only the NPCs of the map you are on. To edit another map's NPCs, walk or warp there. The search field filters the list.

The **At a glance** card beside the form shows the NPC as players find it.

### Working with the game window

- **New NPC** places an NPC where your character stands. A banner reminds you that it is only kept once you save it.
- **Click an NPC** in the game window to open it in the editor.
- **Drag an NPC** in the game window to move it. The Position fact and the X and Y fields in the editor follow live. The new position is stored with the next save.
- **Ctrl+Z** and **Ctrl+Y** in the game window undo and redo moves.
- Field changes are sent to the game window as you type, so the NPC in the world previews your edits before you save.

## General tab

### NPC

| Field | Notes |
| --- | --- |
| Name | Up to 64 characters. What players see the NPC called. Leave it empty for an NPC without a name. |

### Placement

| Part | Notes |
| --- | --- |
| Map | The map the NPC is on. For a new NPC it is set when you save. |
| Position | Where the NPC stands, as it is being moved |
| X, Y | The same place in pixels, across and down the map from its top left corner. Type a number to move the NPC there. |
| Bring to me | Puts the NPC where your character stands |
| Facing | Down, Up, Left or Right |
| Hidden | Hidden NPCs are not shown to players |

An NPC that has ended up off the map, or somewhere you cannot reach to drag it, can be put right with X and Y or with **Bring to me**. Both show the NPC in its new place at once, and like a drag, neither is kept until you save.

## Appearance tab

### Sprite

**Sprite type** decides how the NPC is drawn:

| Type | Meaning | Fields |
| --- | --- | --- |
| Animated | Drawn from sprite sheets, one over the other, as a player is | Body sheet, Head sheet |
| Static | Drawn as one still image | Static image |
| None | Nothing is drawn where the NPC stands | None |

### Worn

For an animated NPC, sprite sheets drawn over the body and head: Helmet, Shoulders, Neck, Gloves, Chest, Boots, Pants and Weapon. These are the same appearance pickers the [Creature Editor](#/tools/creature-editor) uses.

Sprite sheets and their animation metadata come from the asset server. See [Asset Paths](#/assets/asset-paths) and the [Animator](#/tools/animator).

## Dialogue tab

### Dialogue

| Field | Notes |
| --- | --- |
| Says when clicked | What the NPC says to a player who clicks it. Up to 500 characters. |
| Gossip chain | One line per step. The NPC cycles through them over time. Up to 5,000 characters. |

Gossip lines can hold details of the player. Type `${` and the editor suggests what is available, for example `${player.name}`. Use the arrow keys to move through the suggestions, Enter or Tab to take one, and Escape to close the list. The placeholders are described in [Quests](#/engine/quests).

### Script

| Field | Notes |
| --- | --- |
| Script | Code the game runs for this NPC. Up to 5,000 characters. It runs with the NPC as `this`, so its own members need no prefix, for example `dialogue()` and `show()`. |

The script field has the same suggestion list, offering the NPC's own members such as `id`, `name`, `dialog`, `gossip`, `hidden` and `direction`.

## Quests tab

| Field | Notes |
| --- | --- |
| Quest giver | Only quest givers can be given quests, here or in the quest editor |
| Gives these quests | The quests this NPC hands out |
| Takes these quests back | The quests this NPC accepts when finished |

The two pickers are the other side of "Given by" and "Turned in to" in the [Quest Editor](#/tools/quest-editor). Either tool can make the link. A quest that no longer exists is left out when the NPC is saved.

## Vendor & Inn tab

### Inn

| Field | Notes |
| --- | --- |
| Innkeeper | Players who talk to this NPC can make its inn their home |

Talking to an innkeeper lists a "Make this inn your home" line, under its quests and its goods if it has any. A player who confirms it arrives there whenever they use their home item: at the spot they were standing on when they set it, so pick a place for the innkeeper that players can stand beside.

The home is kept as the NPC, not as a place on the map. Move the innkeeper and the homes set there move with it. Delete it, hide it or turn the switch off, and those players go to the world's starting point until they set a new home.

Nothing limits how many innkeepers a map has. The home item itself is set in the [Item Editor](#/tools/item-editor).

:::note Inns and vendors on the minimap
Players see a pin on their minimap for each inn and each vendor. Place the NPC inside the house's own map: the pin is then drawn in the world outside, on the door that leads into that map. Saving the NPC updates the pins for everyone online. An innkeeper or vendor placed in a world itself, out in the open, is marked where it stands.

| Pin | Picture |
| --- | --- |
| Inn | `inn.png` in the asset server's icons folder |
| Vendor | `ui-gold-currency.png`, the game's own gold coin |
| Cave (a warp from one world into another) | `cave.png` in the asset server's icons folder |

An NPC that is both an innkeeper and a vendor gets both pins, side by side. On the world map, every house is drawn with `house.png` and every cave with `cave.png`, both from the same icons folder.
:::

### Vendor

What the NPC sells. An NPC with at least one item in stock is a vendor: players who talk to it get the vendor window, and it buys what they sell.

Select **Add item** to add a card, then fill it in:

| Field | Notes |
| --- | --- |
| Item | Picked from the items made in the [Item Editor](#/tools/item-editor), with search |
| Price | What one costs to buy here, as gold, silver and copper. A newly picked item starts at four times its sell price. |

The line under each card's title says what the item is sold for and what vendors pay for it. The arrows move a card up or down, which is the order players see, and the bin removes it. A vendor stocks up to 40 different items, and never runs out.

| Rule | What happens |
| --- | --- |
| A price below the item's sell price | Players are charged the sell price instead, and the card says so. Sold for less, the item could be bought and sold back for a profit. |
| A price of nothing | The item is free, unless it has a sell price, in which case the rule above applies |
| An item that no longer exists | Left out when the NPC is saved |

What a vendor pays for an item is not set here. It is the item's own sell price, the same at every vendor.

When an NPC has both quests and stock, players see its quests first, with a "Browse goods" line under them.

## Effects tab

| Field | Notes |
| --- | --- |
| Particles | Effects that play around the NPC. Pick from the particles made in the [Particle Editor](#/tools/particle-editor). |

## Saving

The NPC editor's conversation differs from the other editors. There is no search on the server and no separate result for a save. The game window sends the tool window the whole NPC list whenever it changes, and a save or delete is known to have gone through when the list that comes back shows it.

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open | `LIST_NPCS` | Sends the NPCs of your map, the quest list, and the sprite sheets and icons for the pickers |
| Save a new NPC | `ADD_NPC` | Inserts the NPC, stores its quest links, and sends it to players |
| Save an existing NPC | `SAVE_NPC` | Updates the NPC and its quest links, and sends the update to players. Answers "NPC saved successfully." |
| Delete | `DELETE_NPC` | Removes the NPC |

NPCs are stored in the `npcs` table of the game database, and their quest links in `npc_quests`. Saved changes are live at once.

Ctrl+S in the tool window saves the open NPC.

:::note Map particle NPCs are not listed
NPCs that exist only to carry particles placed in the map file are edited with the map, not here. The editor leaves them out of its list.
:::

:::note NPCs placed by a map are not listed either
A map file can place a whole NPC itself: a point of type `npc` on one of its object layers. The point is where the NPC stands, its name is the NPC's name, and its properties are `direction`, `dialog`, `gossip`, `sprite_type`, the `sprite_*` sheets and `innkeeper`. These NPCs are drawn and talked to like any other, and an innkeeper among them can be made a home, but they are changed in the map, not here. Each needs a name: its id is made from the map's name and its own, so renaming it or its map makes it a new NPC, and homes set at the old one fall back to the world's starting point.
:::

## Tips

- Stand exactly where the NPC should be before pressing New. It saves a drag.
- Save a new NPC before linking quests to it from the Quest Editor. Unsaved NPCs do not exist on the server yet.
- Turn on Quest giver first, save, then pick quests. The quest editor only offers NPCs with the flag.
- Use Hidden to prepare an NPC on a live realm and reveal it when the content is ready.
- Keep gossip lines short. They appear in the speech bubble over the NPC.
