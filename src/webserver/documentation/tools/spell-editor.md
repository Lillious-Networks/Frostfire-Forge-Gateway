---
title: Spell Editor
description: Create and edit spells live: casting numbers, targeting, particles and the effects a spell applies.
order: 40
---

The spell editor creates, changes and deletes the rows of the `spells` table from inside the game. A saved spell works at once, with no restart. This page walks through the window, every field, the effect types and what the server does on save.

For how spells behave in combat and the raw table format, see [Spells](#/engine/spells).

## Opening it

```text title="Chat command"
/se
/spelleditor
```

The editor opens in its own window at route `/spell-editor`. Typing the command again closes it.

## Permission

Any one of these lets you in:

- The admin role
- `tools.spell_editor` or `tools.*`
- `server.admin` or `server.*`

Guests are always refused. The server reads your permissions from its permission cache on every packet the editor sends, so a permission taken away while the window is open applies to the very next save.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench).

| Area | Contents |
| --- | --- |
| Side pane | Search field, the list of spells, and New |
| Top bar | The open spell, its state, then Learn, Duplicate, Delete and Save |
| Tabs | General, Targeting, Effects |
| Page | The form on the left and the "In plain words" card on the right |

An empty search lists every spell (up to 200). Type part of a name to narrow the list.

The **In plain words** card stays beside the form on every tab. It shows the icon and name and describes in sentences what the current numbers do in the game, so you can check a spell without casting it.

### Top bar buttons

| Button | What it does |
| --- | --- |
| Learn | Teaches the open spell to your own character so you can try it. Save first: the button is off while there are unsaved changes. |
| Duplicate | Opens a copy as a new, unsaved spell |
| Delete | Deletes the spell after a confirmation |
| Save | Saves the spell. Ctrl+S does the same. |

## General tab

### Spell

| Field | Notes |
| --- | --- |
| Name | Up to 64 characters: letters, digits, spaces, underscores, hyphens and apostrophes, starting with a letter or digit. Fixed once saved. |
| Icon | Picked from the sprites the asset server has. Shown in the spell book and on the hotbar. The projectile that flies is the asset server's icon of the same name. |
| Type | A category label. `spell` is the only value the game knows. |
| Description | Tooltip text in the spell book. Up to 255 characters. |

:::warning A spell's name cannot be changed
Players' spell books, hotbars and creatures refer to a spell by its name. Once a spell is saved the Name field is locked. To rename, use Duplicate, give the copy the new name, and delete the old spell when nothing uses it any more.
:::

### Casting

| Field | Unit | Notes |
| --- | --- | --- |
| Damage | | Base damage on hit, raised by the caster's level and damage stat. A negative number heals. 0 is fine for a spell that only has effects. |
| Mana cost | % | Percent of the caster's base stamina: the stamina their level gives, not counting gear. |
| Range | pixels | Longest distance to the target. 0 falls back to 100. |
| Cast time | seconds | How long the cast bar takes. 0 is instant. Fractions work, for example 1.5. |
| Cooldown | seconds | Whole seconds before it can be cast again. |
| Cast while moving | switch | Off: the caster must stand still, moving cancels the cast, and the cast can be interrupted. |

### Looks

| Field | Notes |
| --- | --- |
| Particles | A list of particle names drawn on the projectile or the cast. Particles are made in the [Particle Editor](#/tools/particle-editor). |

## Targeting tab

### Area

| Field | Unit | Notes |
| --- | --- | --- |
| Area radius | pixels | Leave at 0 for a spell that hits one target. With ground targeting off, the spell is cast around the caster and hits everyone within this distance. With it on, this is the size of the circle. |
| Ground targeted | switch | The caster clicks a spot on the ground instead of picking a target. |
| Ground duration | seconds | How long a zone stays on the ground, hitting everyone inside once a second. 0 leaves no zone. |
| Thrown | switch | The projectile arcs through the air to the spot. |

### Movement

| Field | Unit | Notes |
| --- | --- | --- |
| Charge distance | pixels | The caster dashes up to this far toward the target, stopping just short of them. 0 for no dash. |
| Teleport behind | switch | The caster blinks to behind the target. |

## Effects tab

A spell can carry up to 10 effects, one of each type at most. Each effect is a card titled "Effect N" with its type. "Add effect" adds one, and each card shows only the fields its type uses.

| Type | What it does |
| --- | --- |
| Damage over time | Hurts the target every tick |
| Heal over time | Heals the target every tick |
| Absorb shield | A shield that soaks up damage before health is touched |
| Stun | The target cannot move or cast |
| Slow | The target moves slower. The strongest slow on a target wins. |
| Vanish | Hides the target from everyone but admins and their party. Damage or a hostile cast breaks it. |
| Interrupt | Stops a cast in progress and locks the target's spells |
| Visual only | Plays particles on the target. No effect on the game. |
| Taunt | Forces a creature to attack the caster. Does nothing to players. |
| Feign death | The caster drops off the threat list of every creature they are fighting. Higher level creatures can resist. |
| Threat change | Changes the caster's threat on the creature hit, or on every creature they are fighting when cast on themself |

Common effect fields:

| Field | Applies to | Notes |
| --- | --- | --- |
| Duration | Timed effects | Seconds, up to 3600, two decimals |
| Damage or Healing per tick | Over time effects | Per tick and per stack. The caster's damage stat adds a share on top. |
| Tick every | Over time effects | Seconds between ticks, from 0.25 |
| Stacks | Over time effects | Casting again adds a stack instead of only restarting the timer |
| Most stacks | Over time effects, when Stacks is on | 1 to 100. Each stack ticks for the full amount. |
| Absorbs | Absorb shield | Damage soaked up before it breaks. Never more than the target's max health. |
| Slow | Slow | Percent, 1 to 99. 50 halves movement speed. |
| Threat | Threat change | Percent, from -100 to 1000. -50 halves the caster's threat, -100 clears it, 100 doubles it. |
| Particles on the target | Most effects | Shown on the affected target while the effect lasts |

The card **As it is saved** at the bottom of the tab shows the effects exactly as the server stores them, as JSON. It follows what you change above and cannot be edited directly.

## Plugin spells

Spells registered by a plugin live in memory only. The editor lists them, marks them "Plugin spell" and opens them read-only, with a banner offering "Duplicate it". The copy is a normal database spell you can edit and save. See [Plugins](#/engine/plugins).

## Saving

The window checks each field with the server's own rules before sending, so most mistakes are caught as you type. Problems are listed at the top of the page and marked on the field and on its tab.

| Action | Packet | Server behaviour |
| --- | --- | --- |
| Open, reload | `SPELL_EDITOR_LIST` | Sends the rules, icons, particles and spell count |
| Search | `SPELL_EDITOR_SEARCH` | Returns matching spells |
| Save | `SPELL_EDITOR_SAVE` | Validates, writes the `spells` row, then refreshes the spell cache |
| Delete | `SPELL_EDITOR_DELETE` | Deletes the row if nothing uses the spell |
| Learn | `SPELL_EDITOR_LEARN` | Adds the spell to your own character |

Each answer comes back as `SPELL_EDITOR_RESULT`. After a successful change the server also sends `SPELL_EDITOR_UPDATED` to every other player who may have the editor open, so their lists reload.

:::note A spell in use cannot be deleted
Delete is refused with "is still in use and was not deleted", followed by what uses it, while any player has learned the spell or anything else refers to it. Remove those uses first.
:::

## Tips

- Start from a spell that is close to what you want and use Duplicate. It is faster than filling a new one and it keeps a working baseline.
- Use Learn straight after the first save, then tune numbers and save again. Changes apply to the spell you already know.
- Keep Damage at 0 for pure utility spells and let the effects do the work.
- A ground zone needs three things: Ground targeted on, an Area radius above 0, and a Ground duration above 0.
- If a save is refused with no field marked, read the list at the top of the page. It holds the problems that are not about one field.
