---
title: Map Editor
description: Paint tiles, edit collision and zone layers, place graveyards and warps, and save maps live from inside the game.
order: 30
---

The map editor paints the map your character is standing on. It has two halves: a tool window with the layers, the tools and the tile palette, and the game window itself, where you paint. This page covers both, the keyboard shortcuts, the permissions involved and what a save does.

## Opening it

Stand on the map you want to edit and type one of these in the game chat:

```text title="Chat command"
/te
/tileeditor
```

The tool window opens against the right edge of the screen, at route `/map-editor`. If the browser blocks it, the game shows "Popup blocked! Please allow popups for this site."

Typing the command again, or closing the tool window, closes the editor.

:::danger Closing the editor discards unsaved edits
When the editor closes, the map in your game window is put back to its last saved state. Save before you close.
:::

## Permissions

The map editor is checked in three places, each with its own rule.

| Step | Needs | What happens without it |
| --- | --- | --- |
| Run `/te` | `tools.tile_editor` or `tools.*` | "You don't have permission to use this command" |
| Sync with the server when the editor opens, share live edits and layer locks | The admin role | The server ignores the request. The game stays on "Syncing map state..." and the tool window reports that the game window is not answering. |
| Save the map | `server.admin` or `server.*` | "You do not have permission to save map changes." |

:::warning A map builder needs all three
The editor waits for the server's sync answer before it shows the map, and the server only answers accounts with the admin role. An account with `tools.tile_editor` but no admin role therefore gets a window that never loads, and one without `server.admin` can paint but not save. Give map builders the admin role, `tools.tile_editor` (or `tools.*`) and `server.admin`. See [Permissions](#/engine/permissions).
:::

## The tool window

### Top bar

| Part | Meaning |
| --- | --- |
| Title | The name of the map, with the number of layers and tilesets under it |
| Status | "No unsaved edits", or "Not saved yet" with the layers that have unsaved changes |
| Undo, Redo | Step back and forward through your own edits |
| Clear edits | Takes back every edit of yours that is not saved |
| Save | Sends the map to the server |

### Layers

The side pane lists the map's tile layers and, under "Objects", its two object layers.

- Click a layer to select it. The tools work on the selected layer only.
- The eye button hides or shows a layer in your own game window. It does not change the map.
- The lock button locks a layer so nobody paints on it. Locks are shared with the other editors on the map.
- Up and Down move through the rows.

Three kinds of layer are recognised by name and marked with their own icon:

| Layer name contains | Shown as | Purpose |
| --- | --- | --- |
| `collision` | Collision layer | Tiles here block movement |
| `nopvp` or `no-pvp` | No-PvP zone layer | Tiles here mark where players cannot attack each other |
| `shadow` | Shadow layer | Shadows drawn over the map |

Every other layer is a plain tile layer.

The object layers are **Graveyards** and **Warps**. Selecting one switches the game window from painting tiles to placing and editing those objects, and turns the tile tools off.

### Toolbar

| Tool | Key | What it does |
| --- | --- | --- |
| Paint | `P` | Paints the picked tiles onto the selected layer |
| Erase | `E` | Erases tiles from the selected layer |
| Copy | `C` | Picks tiles up from the map, in the game window |
| Paste | `V` | Puts the picked tiles down as they were copied |
| Rotate | `Z` | Turns the picked tiles a quarter turn |
| Grid | none | Shows or hides the grid in the game window |
| Zoom | Ctrl + wheel | Size of the tiles in the palette, from 1x to 4x |

Paint, Erase and Paste are off while the selected layer is locked. All four tile tools are off while an object layer is selected.

### Tile palette

The palette shows the map's tilesets as tabs and the tileset in view as a picture.

- Click a tile to pick it. Drag across several to pick a block.
- The footer shows what is picked and the column and row under the pointer.
- A yellow corner marks a tile that is animated.
- Left and Right move through the tileset tabs.

Tilesets are part of the map file. A map with none shows "This map has no tilesets": add them to the map on the asset server. See [Asset Paths](#/assets/asset-paths).

## Painting in the game window

With a tile layer selected:

| Action | Result |
| --- | --- |
| Left click or drag | Uses the current tool: paint, erase, paste, or copy the tile under the pointer |
| Shift + left click | With Paint or Paste, draws a straight line from the last tile you placed |
| Right drag | Picks up a block of tiles from the map |
| Middle drag | Pans the editor camera |

## Graveyards and warps

Select **Graveyards** or **Warps** in the Objects list, then work in the game window.

| Action | Result |
| --- | --- |
| Right click on empty ground | "Create" places a new object, named `Graveyard_1`, `Warp_1` and so on |
| Left click an object | Selects it. Drag to move it. |
| Drag a corner of a warp | Resizes the warp area |
| Click an object's label | Renames it in place. Enter confirms, Escape cancels. |
| Right click an object | "Properties" or "Delete" |
| `Delete` key | Deletes the selected object |

The Properties panel lists an object's custom properties. "Add Property" asks for a property name and a value type: `string`, `bool`, `int`, `float`, `color`, `file` or `object`. The names `layer`, `position`, `size` and `name` are reserved.

A warp needs three properties before the map can be saved:

| Property | Meaning |
| --- | --- |
| `map` | The map the warp leads to |
| `x` | Destination X |
| `y` | Destination Y |

:::warning A warp without a destination blocks the save
If any warp is missing `map`, `x` or `y`, the save is refused with "Cannot save: Invalid warps" and the names of the warps to fix. A new warp starts with an empty `map`, so fill it in right after creating it.
:::

Graveyards are where players return after dying. See [Combat and Spells](#/player-guide/combat-and-spells).

## Keyboard shortcuts

These work in both the tool window and the game window.

| Key | Action |
| --- | --- |
| `P` | Paint |
| `E` | Erase |
| `C` | Copy |
| `V` | Paste |
| `Z` | Rotate the picked tiles |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Save the map |
| `Delete` | Delete the selected graveyard or warp (game window) |
| `Shift` + click | Line from the last placed tile (game window) |
| `Ctrl` + wheel | Zoom the palette (tool window) |

## Working with other editors

Several admins can edit the same map at once.

- Each edit is sent to the server as an `EDITOR_TILE_EDIT` packet and relayed to the other admins on that map who have the editor open.
- Layer locks travel the same way (`EDITOR_LAYER_LOCK`).
- When you open the editor on a map others are already editing, the server replays their unsaved edits to you first. The game shows "Syncing map state..." while that happens.
- The server forgets the unsaved edit history of a map when its last editor closes.

## Saving

Save sends a `SAVE_MAP` packet with the changed chunks, the map bounds, and all graveyards and warps. The game server then:

1. Checks `server.admin` or `server.*`.
2. Sends the changed chunks to the asset server (`/save-map-chunks`) and the graveyards and warps (`/save-map-properties`).
3. Reloads the map so collision and zones match the new tiles.
4. Answers "Map saved successfully!" with the number of chunks updated.
5. Tells the other players on the map to reload the changed chunks.

Large world maps (see [World Maps](#/engine/world-maps)) are saved the same way, except that the asset server writes the chunks into the world's packs and the game server fetches the new collision and no-PvP data afterwards. A world's size is fixed.

Saves are limited to one every half second. If the tool window reports "The game window did not save the map", the game window shows the reason: an invalid warp or a save sent too soon after the last one.

How the asset server stores maps is described in [Asset Server Integration](#/assets/integration).

## Tips

- Select the layer before you paint. With nothing selected the tools are off and the palette says "Select a layer on the left to paint on it".
- Lock finished layers such as the ground so a stray click cannot change them.
- Hide upper layers while you work on the ones below. Hiding only affects your view.
- Use right drag to copy a finished building or tree and Paste to stamp it elsewhere.
- Paint the collision layer last, with the other layers visible, so blocked tiles line up with the art.
- Save often. Closing the editor, reloading the game or losing the connection discards unsaved edits.
