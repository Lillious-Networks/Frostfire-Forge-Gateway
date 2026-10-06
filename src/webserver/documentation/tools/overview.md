---
title: Overview
description: Every editor and admin tool, the chat command and route that opens it, and the permission each one needs.
order: 10
---

Frostfire Forge ships its content tools inside the game client. An admin logs in to the game, types a chat command, and the tool opens in its own browser window, connected to that game session. This page lists every tool, how to open it, what permission it needs, and how the tool windows work in general.

## All tools

| Tool | Chat command | Route | Permission |
| --- | --- | --- | --- |
| [Control Panel](#/tools/control-panel) | `/cp` or `/controlpanel` | `/control-panel` | Admin role |
| [Map Editor](#/tools/map-editor) | `/te` or `/tileeditor` | `/map-editor` | `tools.tile_editor` or `tools.*`, plus the admin role |
| [Spell Editor](#/tools/spell-editor) | `/se` or `/spelleditor` | `/spell-editor` | Admin role, `tools.spell_editor`, `tools.*`, `server.admin` or `server.*` |
| [Weather Editor](#/tools/weather-editor) | `/we` or `/weathereditor` | `/weather-editor` | Admin role, `tools.weather_editor`, `tools.*`, `server.admin` or `server.*` |
| [Player Editor](#/tools/player-editor) | `/player edit <username or id>` | `/player-editor` | `server.admin` or `server.*` |
| [Quest Editor](#/tools/quest-editor) | `/qe` or `/questeditor` | `/quest-editor` | Admin role, `tools.quest_editor`, `tools.*` or `server.*` |
| [NPC Editor](#/tools/npc-editor) | `/ne` or `/npceditor` | `/npc-editor` | `tools.npc_editor` or `tools.*` |
| [Creature Editor](#/tools/creature-editor) | `/ce` or `/creatureeditor` | `/creature-editor` | Admin role, `tools.creature_editor`, `tools.*` or `server.*` |
| [Item Editor](#/tools/item-editor) | `/ie` or `/itemeditor` | `/item-editor` | Admin role, `tools.item_editor`, `tools.*` or `server.*` |
| [Loot Editor](#/tools/loot-editor) | `/le` or `/looteditor` | `/loot-editor` | `admin.loot` or `admin.*` |
| [Particle Editor](#/tools/particle-editor) | `/pe` or `/particleeditor` | `/particle-editor` | `tools.particle_editor` or `tools.*` |
| [Animator](#/tools/animator) | None | `/animator` | None |

Commands are not case sensitive. Typing a tool's command again while it is open closes it. The player editor is the exception: its command opens the editor on the player you name.

:::note The permission column is what the code checks
The engine README lists a single `tools.<name>` permission per editor. The table above shows what the server needs to open each tool. Some editors also accept the admin role or a `server.*` permission, some do not. The map, NPC and particle editor commands check the named permission only, so an admin without it is refused. Three editors ask for more when you save: see [Opening is not the same as saving](#/tools/overview/opening-is-not-the-same-as-saving).
:::

## How the tool windows work

Every tool except the animator follows the same pattern.

1. You type the command in the game chat. The client sends it to the game server as a `COMMAND` packet.
2. The server checks your permission. If you may use the tool it answers with a toggle packet such as `TOGGLE_SPELL_EDITOR`. If not, you see "You don't have permission to use this command".
3. The game client opens the tool's route in a popup window and asks the server for the tool's data.
4. The popup and the game window talk through `postMessage`. Everything the popup wants from the server is relayed by the game window over your existing game connection.
5. The server checks your permission again on every packet a tool sends, not only when it opens.

```text title="Who talks to whom"
Tool window  <-- postMessage -->  Game window  <-- WebTransport -->  Game server
```

This has a few practical consequences:

- **Open tools from the game, not from the address bar.** A tool route opened directly has no game window to talk to. It shows "This window opens from the game" and stays empty.
- **Allow popups** for the game's site. If the browser blocks the popup, nothing opens.
- **Keep the game tab open.** Closing or reloading the game window closes every tool window that belongs to it.
- **The server you edit is the realm you are logged in to.** Tools act on the game server your character is connected to.
- **Guests cannot use tools.** The server rejects every chat command from a guest account.
- **A dead character cannot open tools.** While your character is a corpse, only party, whisper and guild chat commands are accepted.

The tool routes themselves need no login. They are plain pages served by the gateway webserver and hold no data until a game window feeds them.

## Permissions

Tool access is decided by the game server from two things on your account:

- The **admin role**, a flag on the account. It is toggled with the `/admin` command or in the [Player Editor](#/tools/player-editor).
- The **permission list**, a comma separated list of names such as `tools.npc_editor`. It is managed with the `/permission` command, the Control Panel or the Player Editor.

`tools.*` is a wildcard that stands for every `tools.` permission. In the same way `admin.*` covers every `admin.` permission and `server.*` every `server.` permission.

| Permission | Opens |
| --- | --- |
| `tools.tile_editor` | Map Editor |
| `tools.npc_editor` | NPC Editor |
| `tools.particle_editor` | Particle Editor |
| `tools.creature_editor` | Creature Editor |
| `tools.item_editor` | Item Editor |
| `tools.spell_editor` | Spell Editor |
| `tools.weather_editor` | Weather Editor |
| `tools.quest_editor` | Quest Editor |
| `tools.*` | All of the above |
| `admin.loot` | Loot Editor, and the loot table controls of the Control Panel |
| `server.admin` | Player Editor |

The full permission system, including how to grant and revoke, is described in [Permissions](#/engine/permissions) and [Admin Commands](#/engine/admin-commands).

### Opening is not the same as saving

Three editors check a second permission when you save. Their `tools.` permission opens the window, but the packets that change data ask for `server.admin` or `server.*`.

| Editor | Opens with | Saving, deleting and moving need |
| --- | --- | --- |
| Map Editor | `tools.tile_editor` or `tools.*`, and the admin role for the sync that loads the map | `server.admin` or `server.*` |
| NPC Editor | `tools.npc_editor` or `tools.*` | `server.admin` or `server.*` |
| Particle Editor | `tools.particle_editor` or `tools.*` | `server.admin` or `server.*` |

:::warning What a content builder needs
A builder who should use every tool needs three things: the admin role, `tools.*` and `server.admin`. The role alone does not open the map, NPC or particle editor. `tools.*` alone opens the NPC and particle editors but cannot save in them, cannot load the map editor, and does not open the Control Panel, the Loot Editor or the Player Editor. Add `admin.loot` for the Loot Editor.
:::

## The editor workbench

The spell, weather, player, quest, NPC, creature, item, loot and particle editors share one layout, built by `js/core/tooleditor.ts`.

| Area | What it holds |
| --- | --- |
| Side pane | A search field, the list of records, and a New button |
| Top bar | The open record, its state, and the Duplicate, Delete and Save buttons the editor supports |
| Banner | One line of information or warning about the open record |
| Tabs | The pages of a large record |
| Page | The form, as cards of fields, often with a preview or summary beside it |

The state next to the record name uses the same words in every editor:

| State | Meaning |
| --- | --- |
| Saved | The server has what you see |
| Unsaved changes | You changed something and have not saved |
| Not saved yet | A new record that does not exist on the server |
| Saving, Deleting, Loading | Waiting for the server |
| Not saved | The server refused the save. The reasons are listed at the top of the page. |
| Not confirmed | A request was sent and no answer came back. It may or may not have been done. |
| Read-only | The record cannot be changed here |

Shared behaviour:

- **Ctrl+S** (Cmd+S on macOS) saves the open record in every editor.
- Up and Down move through the record list. Down from the search field enters the list.
- Left and Right move through the tabs.
- Enter in the search field searches at once.
- Leaving a record with unsaved changes asks whether to save, discard or stay.
- Deleting always asks for confirmation.
- Results appear as a short note in the corner of the window. An error stays longer.
- If the server does not answer within about 12 seconds, the page says so and offers "Try again".

The Control Panel and the Map Editor have their own layouts, described on their pages.

## Where changes go

Tools change the live game server. A saved spell, item, quest, weather or creature takes effect without a restart.

| Kind of data | Stored in |
| --- | --- |
| Spells, items, quests, weathers, loot tables, creatures, NPCs, particles, player data | The game database, through the game server |
| Map tiles, graveyards and warps | The asset server. The game server forwards each map save to it, then reloads the map. |
| Animator metadata | A JSON file you export and add to the asset server yourself |

See [Asset Server Integration](#/assets/integration) for how map saves reach the asset server.

:::tip Work on a development realm first
Every save is live for the players of that realm. Build and test content on a development server, then repeat it or copy the data to production.
:::
