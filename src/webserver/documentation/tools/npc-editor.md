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
| Tabs | General, Appearance, Dialogue, Quests, Effects |
| Page | The form, with the "At a glance" card beside it |

There is no Duplicate button: an NPC is placed, not copied.

The list holds only the NPCs of the map you are on. To edit another map's NPCs, walk or warp there. The search field filters the list.

The **At a glance** card beside the form shows the NPC as players find it.

### Working with the game window

- **New NPC** places an NPC where your character stands. A banner reminds you that it is only kept once you save it.
- **Click an NPC** in the game window to open it in the editor.
- **Drag an NPC** in the game window to move it. The Position fact in the editor follows live. The new position is stored with the next save.
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
| Position | Read only here. Drag the NPC in the game window to move it. |
| Facing | Down, Up, Left or Right |
| Hidden | Hidden NPCs are not shown to players |

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

## Tips

- Stand exactly where the NPC should be before pressing New. It saves a drag.
- Save a new NPC before linking quests to it from the Quest Editor. Unsaved NPCs do not exist on the server yet.
- Turn on Quest giver first, save, then pick quests. The quest editor only offers NPCs with the flag.
- Use Hidden to prepare an NPC on a live realm and reveal it when the content is ready.
- Keep gossip lines short. They appear in the speech bubble over the NPC.
