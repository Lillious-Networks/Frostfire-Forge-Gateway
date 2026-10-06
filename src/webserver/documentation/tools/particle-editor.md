---
title: Particle Editor
description: Build particle effects with a live preview: look, light and glow, emission, motion, and time and weather rules.
order: 120
---

Particles are the small visual effects attached to NPCs, spells, mounts and map objects: sparks, smoke, glows and lights. The particle editor creates and tunes them with a preview that runs each particle the way the game does. This page covers the window, every setting, the permissions involved and how saving works.

## Opening it

```text title="Chat command"
/pe
/particleeditor
```

The editor opens in its own window at route `/particle-editor`. Typing the command again closes it.

## Permission

| Step | Needs | What happens without it |
| --- | --- | --- |
| Open the editor and list particles | `tools.particle_editor` or `tools.*` | "You don't have permission to use this command" |
| Save a particle | `server.admin` or `server.*` | "You do not have permission to save particles." |
| Rename a particle | `server.admin` or `server.*` | "You do not have permission to rename particles." |
| Delete a particle | `server.admin` or `server.*` | "You do not have permission to delete particles." |

:::warning Opening is not enough to save
`tools.particle_editor` only opens the window and loads the list. Creating, saving, renaming and deleting all need `server.admin` or `server.*`. Without it a new particle is simply never created, and the editor reports that the server did not add it. The admin role on its own opens nothing here.
:::

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the list of particles, and New |
| Top bar | The open particle, its state, then Rename, Revert, Duplicate, Delete and Save |
| Page | The settings as cards, with the live Preview card beside them |

| Button | What it does |
| --- | --- |
| New | Asks for a name and creates the particle. It starts as a small white dot. |
| Rename | Gives the particle another name and updates what refers to it |
| Revert | Puts the form back to the last saved values |
| Duplicate | Asks for the name of the copy and creates it |
| Delete | Deletes the particle after a confirmation |
| Save | Saves the settings. Ctrl+S does the same. |

### Names

A particle's name is what NPCs, spells and mounts refer to it by. Names must be unique, ignoring case, and cannot contain commas, because references are stored as comma separated lists.

### Preview

The Preview card runs the particle continuously as you change settings. Its two buttons pause or run the preview and start it over. Facts under the canvas summarise the particle.

The preview has no wind, so "Affected by weather" can only be judged in the game.

## Settings

### Look

| Setting | Notes |
| --- | --- |
| Size | Pixels |
| Opacity | 0 cannot be seen, 1 is solid |
| Colour | The colour of the round particle |
| Z-index | Its place in the drawing order |
| Visible | Off: the game does not draw it. When a time window is set, the window decides instead. |

### Light and glow

| Setting | Notes |
| --- | --- |
| Brightness | Light the whole particle gives off, day and night. 1 is as drawn, above 1 is brighter. |
| Glow intensity | How strong the halo is. At 0 there is none. |
| Glow radius | How far the halo reaches, in pixels. At 0 it is sized from the particle. |
| Static light | One steady light at the particle's position: no emission, lifetime, movement or spread. |

### Image

| Setting | Notes |
| --- | --- |
| Image | A sprite from the asset server in place of the round particle, drawn as wide as Size. "None" keeps the round particle. With an image, the colour only tints the glow. |

### Emission

| Setting | Unit | Notes |
| --- | --- | --- |
| Lifetime | ms | How long each particle lasts |
| Interval | frames | Frames from one particle to the next. The game counts 60 a second. |
| Max amount | | The most that are alive at once |
| Stagger time | ms | Each lasts up to this much longer, at random, so they do not all fade together |

**Where they start** is measured from what emits them. X grows to the right, Y grows downward.

| Setting | Unit | Notes |
| --- | --- | --- |
| Position X, Position Y | px | Offset from the emitter |
| Spread X, Spread Y | px | Each particle starts at random within this width |

### Motion

| Setting | Unit | Notes |
| --- | --- | --- |
| Velocity X, Velocity Y | px/s | The speed each particle starts with |
| Gravity X, Gravity Y | px/s² | A steady pull, added every second |

### Time and weather

| Setting | Notes |
| --- | --- |
| Affected by time | Only show it for part of the day, by the server's clock |
| Shows from, Until | The time window, used when "Affected by time" is on |
| Affected by weather | The wind pushes it sideways in the game. See [Weather Editor](#/tools/weather-editor/wind). |

## Saving

The particle editor's conversation is indirect. The server does not answer a request from here by name. Instead the game window asks for the particle list again shortly after each change and passes it to the tool window, which checks whether what it asked for is now there and then reports "done" or "not done".

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open, refresh | `LIST_PARTICLES` | Sends every particle |
| Create, Save, Duplicate | `SAVE_PARTICLE` | Adds the particle or updates the one with that name, then sends the update to players |
| Rename | `RENAME_PARTICLE` | Renames the particle and every NPC, spell and mount reference to it |
| Delete | `DELETE_PARTICLE` | Removes the particle |

Particles are stored in the `particles` table of the game database. A saved particle is pushed to connected players, so effects in the world change as you save.

### Renaming

Rename updates the references the server holds: NPCs, spells and mounts. The chat notification afterwards says how many were updated.

:::warning Map objects keep the old name
Particles placed in a map file are not renamed. The notification tells you how many map objects still use the old name. Rename them in the map as well, or those effects stop showing.
:::

## Where particles are used

| Place | Set in |
| --- | --- |
| Around an NPC | Effects tab of the [NPC Editor](#/tools/npc-editor) |
| On a spell's projectile or cast, and on effect targets | Looks section and effect cards of the [Spell Editor](#/tools/spell-editor) |
| On mounts | The mount's particle list |
| At fixed spots on a map | Particle objects in the map file |

## Tips

- Start from Duplicate. A torch flame, a campfire and a brazier differ in a few numbers only.
- For a lamp or window light, turn on Static light and set Brightness and Glow. No emission settings are needed.
- For smoke or mist, use a low Opacity, a long Lifetime, a small upward Velocity (negative Y) and a wide Spread.
- Keep Max amount low. Every NPC or spell that uses the particle multiplies it.
- Use "Affected by time" for effects that belong to the night, such as fireflies or street lamps.
- Decide on names early. Renaming is safe for NPCs, spells and mounts, but map files have to be fixed by hand.
