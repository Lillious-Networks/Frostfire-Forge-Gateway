---
title: Spells
description: The full spell reference, covering every spells table field, the effects JSON, every effect type, how a cast runs on the server, and how to add a spell.
order: 100
---

Spells are data. Each one is a row of the `spells` table, loaded into the asset cache at startup, and its `effects` column is a JSON array that says what the spell does when it lands. This page documents every field and effect type, walks through a cast step by step, and shows how to add a spell with SQL or from a plugin.

To edit spells with a form instead, see the [Spell Editor](#/tools/spell-editor). For the player's view of combat see [Combat and Spells](#/player-guide/combat-and-spells).

## The spells table

```sql title="src/utility/database_setup.ts"
CREATE TABLE IF NOT EXISTS spells (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY UNIQUE,
  name VARCHAR(255) NOT NULL,
  damage INT NULL DEFAULT 0,
  mana INT NULL DEFAULT 0,
  `range` INT NULL DEFAULT 0,
  type VARCHAR(255) NULL DEFAULT 'cast',
  cast_time DOUBLE NULL DEFAULT 0,
  cooldown INT NULL DEFAULT 0,
  can_move INT NULL DEFAULT 0,
  description VARCHAR(255) NULL,
  icon VARCHAR(255) NULL DEFAULT NULL,
  effects TEXT NULL DEFAULT NULL,
  particles VARCHAR(500) NULL DEFAULT NULL,
  aoe_radius INT NULL DEFAULT NULL,
  ground_aoe TINYINT(1) NULL DEFAULT 0,
  ground_duration INT NULL DEFAULT 0,
  is_thrown TINYINT(1) NULL DEFAULT 0,
  charge_distance INT NULL DEFAULT 0,
  teleport_behind TINYINT(1) NULL DEFAULT 0
);
```

### Spell fields

| Field | Type | Meaning |
|-------|------|---------|
| `id` | number | Row id. Cooldowns are tracked by this id, and a spell without one cannot be cast |
| `name` | string | The spell's identifier. Hotbars, `learned_spells` and creature abilities refer to a spell by name |
| `damage` | number | Base amount. Positive deals damage, negative heals, `0` makes an effect-only spell |
| `mana` | number | Cost as a percentage of the caster's base stamina (`stats.max_stamina`, the value from level alone) |
| `range` | number | Longest cast distance in pixels. `0` is read as 100 |
| `type` | string | Category label. Nothing in the engine reads it. The seeded spells and the editor use `spell` |
| `cast_time` | number | Cast bar length in seconds, fractions allowed. `0` is instant |
| `cooldown` | number | Seconds before the spell can be cast again, counted from the start of the cast |
| `can_move` | number | `1` lets the caster walk while casting. `0` means moving cancels the cast, and makes the cast interruptible |
| `description` | string | Tooltip text, up to 255 characters |
| `icon` | string | Icon name on the asset server |
| `effects` | JSON array | What the spell applies when it lands, see [The effects format](#/engine/spells/the-effects-format) |
| `particles` | string | Comma-separated particle names for the projectile or cast visual |
| `aoe_radius` | number | Area radius in pixels. Without `ground_aoe` the area is centred on the caster |
| `ground_aoe` | number | `1` makes the spell ground targeted: the caster clicks a point on the map |
| `ground_duration` | number | Seconds a ground area stays and keeps ticking. `0` makes it a single burst |
| `is_thrown` | number | `1` makes a ground spell arc through the air before it lands |
| `charge_distance` | number | Pixels the caster dashes toward the target. Makes the spell an instant charge |
| `teleport_behind` | number | `1` moves the caster behind the target instantly |

:::note The sprite field
The global `SpellData` type also has a `sprite` field, and the login code passes it through when it is set. The `spells` table created by the setup script has no `sprite` column and the spell editor does not write one.
:::

### Limits the spell editor enforces

The game accepts whatever the row holds. The editor is stricter, and these ranges are a good guide when writing rows by hand.

| Field | Allowed range |
|-------|---------------|
| `name` | 1 to 64 characters: letters, digits, spaces, underscores, hyphens and apostrophes. Cannot be changed once saved |
| `damage` | -100000 to 100000, whole numbers |
| `mana` | 0 to 1000 |
| `range` | 0 to 5000 |
| `cast_time` | 0 to 60, two decimals |
| `cooldown` | 0 to 86400 |
| `aoe_radius` | 0 to 2000 |
| `ground_duration` | 0 to 600 |
| `charge_distance` | 0 to 2000 |
| `effects` | At most 10 effects |

The editor also refuses a spell with `damage` 0 and no effects (the server would refuse to cast it), and a ground-targeted spell with no `aoe_radius` (it would hit nothing).

## The effects format

`effects` is a JSON array of effect objects. Each object has a `type` that picks the handler, and the fields that handler reads. Anything else in the object is ignored.

```json title="effects column"
[
  { "type": "damage_over_time", "value": 4, "duration": 12, "interval": 3, "stackable": true, "max_stacks": 5 }
]
```

```ts title="types.d.ts"
declare interface SpellEffect {
  type: string;
  value: number;
  duration?: number;
  interval?: number;
  stackable?: boolean;
  max_stacks?: number;
  target_particles?: string;
}
```

| Field | Meaning |
|-------|---------|
| `type` | The effect type, one of the eleven below |
| `value` | Strength: damage or healing per tick, slow percentage, shield size, threat percentage |
| `duration` | Seconds the effect lasts |
| `interval` | Seconds between ticks, for the two periodic types |
| `stackable` | Whether casting again adds a stack. Periodic types only |
| `max_stacks` | Most stacks when `stackable` is true. Defaults to 5 |
| `target_particles` | Comma-separated particle names shown on the affected target |

:::note Effect type is not spell type
The `type` inside an effect (`stun`, `slow` and so on) has nothing to do with the spell's own `type` column, which is only a label.
:::

## Effect types

Every type the engine has a handler for. The "Hostile" column decides whether the spell counts as an attack: a spell with any hostile effect cannot be cast on yourself or your party, breaks the caster's vanish, and emits `onPlayerDebuffAdded` when it lands.

| Type | Fields read | Hostile | Works on players | Works on creatures |
|------|-------------|---------|------------------|--------------------|
| `damage_over_time` | `value`, `duration`, `interval`, `stackable`, `max_stacks`, `target_particles` | Yes | Yes | Yes |
| `heal_over_time` | `value`, `duration`, `interval`, `stackable`, `max_stacks`, `target_particles` | No | Yes | Only from a creature's own abilities, on its allies |
| `absorbtion` | `value`, `duration`, `target_particles` | No | Yes | No |
| `stun` | `duration`, `target_particles` | Yes | Yes | Yes, unless the creature is immune to stuns |
| `slow` | `value`, `duration`, `target_particles` | Yes | Yes | Yes, unless the creature is immune to roots |
| `vanish` | `duration`, `target_particles` | No | Yes | No |
| `interrupt` | `duration` | Yes | Yes | Yes |
| `visual` | `duration`, `target_particles` | No | Yes | No |
| `taunt` | `duration` | Yes | No | Yes, unless the creature cannot be taunted |
| `feign_death` | none | No | Caster only | Acts on every creature fighting the caster |
| `threat` | `value` | No | Caster only | Yes |

### damage_over_time

Deals `value` damage every `interval` seconds for `duration` seconds.

```json title="Poison: 4 damage every 3 seconds for 12 seconds, up to 5 stacks"
{ "type": "damage_over_time", "value": 4, "duration": 12, "interval": 3, "stackable": true, "max_stacks": 5 }
```

See [Damage and healing over time](#/engine/spells/damage-and-healing-over-time) for stacking, the stat bonus and mitigation.

### heal_over_time

The same as `damage_over_time`, but each tick restores health. The sign of `value` does not matter, the handler always treats it as healing.

```json title="Regrowth: 5 health every 2 seconds for 10 seconds"
{ "type": "heal_over_time", "value": 5, "duration": 10, "interval": 2 }
```

### absorbtion

Puts a shield on the target that soaks up to `value` damage before health is touched. The shield is never larger than the target's maximum health.

- `duration` above 0 removes the shield after that many seconds and shows it on the buff bar.
- `duration` 0 keeps it until it is used up, and it is not shown on the buff bar.
- Shields from different spells add up. Casting the same spell again refills its own shield and restarts its timer.

```json title="Shield: absorbs 50 damage for 8 seconds"
{ "type": "absorbtion", "value": 50, "duration": 8 }
```

The spelling `absorbtion` is the one the engine uses. `absorption` matches no handler and does nothing.

### stun

The target cannot move or cast for `duration` seconds. `value` is ignored. A stun with no positive duration does nothing.

- Movement in progress is stopped by the server at once.
- A cast in progress is interrupted if it is interruptible.
- The same spell cast again refreshes its stun. Stuns from different spells are tracked separately and the longest one decides when the target is free.

```json title="Three second stun"
{ "type": "stun", "value": 0, "duration": 3 }
```

### slow

Cuts the target's movement speed by `value` percent for `duration` seconds. `value` is clamped to 1 through 99. With several slows active only the strongest counts.

```json title="Half speed for 5 seconds"
{ "type": "slow", "value": 50, "duration": 5 }
```

### vanish

Hides the target from everyone except admins and their own party. `duration` 0 (or left out) lasts until it is broken. Taking damage breaks it, and so does casting a damaging or hostile spell.

```json title="Vanish until broken"
{ "type": "vanish", "value": 0, "duration": 0 }
```

While vanished, a caster can only cast spells that deal damage, carry a hostile effect, or carry a `vanish` effect. Anything else fails with reason `vanished`.

### interrupt

Stops the target's cast and locks all of their spells for `duration` seconds. A `duration` of 0 uses 3 seconds. It only does something when the target is casting a spell with `can_move` 0.

```json title="Interrupt with a 3 second lockout"
{ "type": "interrupt", "value": 0, "duration": 3 }
```

### visual

Plays `target_particles` on the target for `duration` seconds. No gameplay effect. A visual with no positive duration does nothing.

```json title="Frost particles for 5 seconds"
{ "type": "visual", "value": 0, "duration": 5, "target_particles": "frost_particles" }
```

### taunt

Forces a creature to attack the caster for `duration` seconds. A `duration` of 0 uses 3 seconds. It does nothing to players.

```json title="Taunt for 3 seconds"
{ "type": "taunt", "value": 0, "duration": 3 }
```

### feign_death

Drops the caster off the threat list of every creature they are fighting. A creature above the caster's level resists with a chance of 10 percent per level of difference, and the caster is told `Feign Death was resisted.` It reads no fields.

```json title="Feign death"
{ "type": "feign_death", "value": 0 }
```

### threat

Changes the caster's threat by `value` percent. Cast on a creature it changes the threat on that creature. Cast on yourself it changes the threat on every creature you are fighting.

| `value` | Result |
|---------|--------|
| `-50` | Halves the caster's threat |
| `-100` | Clears it |
| `100` | Doubles it |

```json title="Halve threat"
{ "type": "threat", "value": -50 }
```

## Multiple effects

A spell can carry several effects. They are applied in array order when the spell lands, and one failing does not stop the others.

```json title="Poison and slow on the same hit"
[
  { "type": "damage_over_time", "value": 3, "duration": 9, "interval": 3 },
  { "type": "slow", "value": 30, "duration": 4 }
]
```

:::warning A dodged hit applies no effects
When a spell has positive `damage` and the target avoids all of it, the effects are skipped too. Effect-only spells (`damage` 0) cannot be avoided.
:::

## How casting works

The client sends a `HOTBAR` packet. The handler in `src/socket/receiver.ts` then runs these steps.

```ts title="What the client sends"
sendRequest({ type: "HOTBAR", data: { spell: spellName, target, creature: isCreature } });
```

Ground-targeted spells also send `groundX` and `groundY` in `data`.

### 1. Checks that drop the cast silently

The request is ignored when the caster is a corpse or ghost, is an admin in stealth, is already casting, cast something less than 500 ms ago, is locked out by an interrupt, or is stunned. Guests get `Please create an account to use that feature.`

### 2. Spell and target

- The spell is looked up by name. An unknown spell, or one with no `id`, answers `Invalid spell selected.`
- The caster must have learned it, otherwise `You have not learned this spell.`
- With no target the spell targets the caster. Ghosts cannot be targeted.
- A healing spell, or a spell with only friendly effects, that is aimed at someone outside the caster's party lands on the caster instead.
- A damaging or hostile spell aimed at a party member is refused with `You cannot attack your party members`.

### 3. Validation

Each failure emits `onSpellFailed` with the reason shown.

| Check | Reason |
|-------|--------|
| A harmful spell where PvP is not allowed (a no-PvP zone) | `nopvp` |
| The spell is still on cooldown | `cooldown` |
| The caster is vanished and the spell is neither harmful nor a vanish | `vanished` |
| `can_move` is 0 and the caster is moving | `moving` |
| Not enough stamina for the mana cost | `mana` |
| `damage` is 0 and there are no effects | `no_effects` |
| Target out of range | `range` |
| No line of sight | `path_blocked` |
| Caster not facing the target when the cast finishes | `direction` |

### 4. Cooldown starts

The cooldown is set as soon as validation passes, before the cast bar, so two requests cannot both get through. It runs for `cooldown` seconds from that moment.

```ts title="src/socket/receiver.ts"
const spellCooldownTime = spell.cooldown * 1000;
freshPlayerForMana.spellCooldowns[spell_id] = performance.now() + spellCooldownTime;
cooldownManager.setCooldown(freshPlayerForMana.username, spell_id, performance.now() + spellCooldownTime);
```

### 5. The cast bar

A mounted caster is dismounted. Everyone on the map receives `CAST_SPELL` with the spell name and `cast_time`, and the server waits for the cast time.

The cast is abandoned, and the cooldown refunded, when:

- the caster presses escape (the client sends `CANCEL_SPELL`),
- the caster moves and `can_move` is 0,
- an `interrupt` or `stun` lands on a caster whose spell has `can_move` 0.

### 6. The cast lands

For a single target the server checks range, line of sight, PvP rules and facing again, then sends a `PROJECTILE` packet. The projectile takes 1 ms per pixel of distance, at most 500 ms.

Damage and healing are then worked out:

```ts title="Damage roll in src/socket/receiver.ts"
const baseDamage = Math.floor(Math.random() * ((playerLevel - 1) * 3 + 1))
  + spell_damage + (playerLevel - 1) * 2 + attackerDamageBonus;
const critDamage = currentPlayer.stats.stat_critical_damage || 0;
isCrit = Math.random() * 100 < (currentPlayer.stats.stat_critical_chance || 0);
finalDamage = isCrit ? Math.floor(baseDamage * (1 + critDamage / 100)) : baseDamage;
```

| Step | Rule |
|------|------|
| Base damage | `damage` plus 2 to 5 per caster level past 1, plus the caster's `stat_damage` |
| Critical hit | Chance is `stat_critical_chance` percent. A crit multiplies by `1 + stat_critical_damage / 100` |
| Avoidance | The target's `stat_avoidance` is the percent chance to take no damage at all |
| Armor | Damage is cut by the target's `stat_armor` percent, capped at 75 |
| Healing | Same level roll, plus `stat_damage` times `cast_time / 3.5` (an instant cast counts as 1.5 seconds, the share is capped at 1). A crit heals for 150 percent. Avoidance and armor never apply |
| Shields | Positive damage is taken from `absorbtion` shields first, the rest from health |

After that the mana cost is deducted, the effects are applied, and `onSpellCast` is emitted. A target that reaches 0 health goes through the normal death flow.

### Casting branches

The steps above describe a single-target spell. Four fields change how the cast plays out:

| Fields | Behaviour |
|--------|-----------|
| `aoe_radius` above 0, `ground_aoe` not 1 | The spell ignores the selected target. After the cast bar it hits every valid player within `aoe_radius` of the caster, with no critical hits. Damage skips the caster and their party and also hits creatures in range, healing reaches only the caster and their party |
| `ground_aoe` 1 | Ground targeted, see [Ground AoE](#/engine/spells/ground-aoe) |
| `charge_distance` above 0 | Instant. The caster dashes up to `charge_distance` pixels toward the target, stopping 40 pixels short. Only the effects are applied, the spell's `damage` is not dealt. Fails if the path is blocked |
| `teleport_behind` 1 | Instant. The caster appears behind the target. Only the effects are applied. Fails if the landing point is blocked |

## Cooldowns

- Cooldowns are per player and per spell `id`, kept in memory by `src/services/cooldownmanager.ts`. They are not written to the database.
- A cooldown starts when the cast starts, not when it lands.
- On top of each spell's own cooldown there is a fixed 500 ms gap between any two casts.
- A spell lockout (from `interrupt` or `stun`) blocks every spell until it ends, and the client is told with `SPELL_LOCKOUT`.
- A cast that is cancelled, interrupted, or fails its final range, line of sight, PvP or mana check gets its cooldown back.

```ts title="src/services/cooldownmanager.ts"
cooldownManager.hasCooldown(username, spellId);            // boolean
cooldownManager.setCooldown(username, spellId, endTime);   // endTime is a performance.now() value
cooldownManager.deleteCooldown(username, spellId);
cooldownManager.getActiveCooldowns(username);              // { [spellId]: endTime }
cooldownManager.getLockout(username);                      // 0 when not locked out
```

## Damage and healing over time

`damage_over_time` and `heal_over_time` share one implementation in `src/systems/dots.ts`.

- A target has one timer per spell name. Casting the spell again restarts the duration without delaying the next tick.
- With `stackable` true each recast also adds a stack, up to `max_stacks` (default 5). Each tick is `value` times the number of stacks.
- `interval` defaults to 1 second. An effect with no positive `duration`, or a `value` of 0, does nothing.
- A scheduler checks every 250 ms, so ticks land within a quarter second of their time.
- Damage ticks can be avoided and are reduced by armor like a direct hit, and shields absorb them. Healing ticks cannot exceed maximum health.
- A damage tick from another player puts both players in combat.

The caster's `stat_damage` adds to every tick. The bonus is fixed when the effect is applied:

```ts title="src/systems/spellmath.ts"
const ticks = Math.max(1, Math.floor(duration / interval));
const coefficient = Math.min(1, duration / PERIODIC_FULL_COEFFICIENT_S); // 15 seconds
return Math.floor((Math.max(0, Number(statDamage) || 0) * coefficient) / ticks);
```

With 50 `stat_damage`, a 12 second effect ticking every 3 seconds gets `50 * 12 / 15 = 40` spread over 4 ticks, so 10 extra per tick.

## Ground AoE

A spell with `ground_aoe` 1 is placed on the map instead of aimed at a target. It needs an `aoe_radius`.

1. The clicked point must be within `range` of the caster, otherwise the cast stops and the cooldown is refunded.
2. During the cast bar everyone on the map sees a preview circle (`GROUND_AOE_CASTING`).
3. With `is_thrown` 1 a projectile arcs to the point first. It travels at 350 pixels per second and takes between 0.4 and 2.5 seconds.
4. With `ground_duration` 0 the spell is a single burst at the point. It uses the same level roll as a direct hit, without critical hits.
5. With `ground_duration` above 0 a zone is spawned (`GROUND_AOE_SPAWN`) and removed when it expires (`GROUND_AOE_DESPAWN`).

A lingering zone, handled by `src/systems/groundaoe.ts`:

| Rule | Value |
|------|-------|
| Tick rate | Once a second |
| Amount per tick | The spell's `damage` as written. No level roll and no damage stat |
| Mitigation | Avoidance and armor apply to damage ticks, shields absorb them |
| Who a damaging zone hits | Players inside it, except the caster and their party, guests, corpses, ghosts and stealthed admins. Creatures inside it are hit too |
| Who a healing zone reaches | The caster and their party only |
| No-PvP zones | A damaging zone harms nobody standing in one, and nobody while its caster stands in one |
| Effects | The spell's `effects` are applied again on every tick to each player the tick reached |
| Events | `onPlayerEnterAOE` when a player walks in, `onPlayerLeftAOE` when they leave or the zone ends |

```sql title="A lingering fire zone, from the seeded spells"
INSERT INTO spells (name, damage, mana, `range`, type, cast_time, cooldown, description, icon, can_move, aoe_radius, ground_aoe, ground_duration) VALUES
  ('fire_storm', 8, 15, 800, 'spell', 2, 12, 'Summons a fiery storm at a target location, dealing damage to all enemies in the area for 6 seconds.', 'fire_storm', 0, 150, 1, 6);
```

## Adding a new spell

### With SQL

Insert a row. The server loads spells at startup, so the spell exists after the next restart.

```sql title="A slowing single-target spell"
INSERT INTO spells (name, damage, mana, `range`, type, cast_time, cooldown, description, icon, can_move, effects) VALUES
  ('shadow_burst', 12, 15, 800, 'spell', 1.5, 20, 'A burst of shadow energy that damages and slows the target.', 'shadow_burst', 0, '[{ "type": "slow", "value": 25, "duration": 4 }]');
```

`range` is a reserved word in MySQL, so it needs backticks. The `effects` value must be valid JSON.

A player can only cast a spell they have learned. Learning is a row of `learned_spells`:

```sql title="Teach the spell to a player"
INSERT INTO learned_spells (spell, username) VALUES ('shadow_burst', 'alice');
```

A row inserted with SQL takes effect at the player's next login. To avoid the restart, save the spell in the [Spell Editor](#/tools/spell-editor), which can also teach it to your own character, and teach it to other players with the [Player Editor](#/tools/player-editor).

### With a plugin manifest

A plugin's `manifest.json` can carry a `spells` array. The loader collects those spells while it scans plugins and merges them into the asset cache before any plugin's `register` runs.

```json title="src/plugins/fire-spells/manifest.json"
{
  "name": "fire-spells",
  "version": "1.0.0",
  "entry": "./src/index.ts",
  "provides": ["fire.spells"],
  "spells": [
    {
      "id": 9001,
      "name": "fire_blast",
      "damage": 15,
      "mana": 12,
      "range": 600,
      "type": "spell",
      "cast_time": 1,
      "cooldown": 8,
      "description": "Hurls a blast of fire at the target.",
      "icon": "fire_blast",
      "can_move": 0,
      "effects": [
        { "type": "damage_over_time", "value": 3, "duration": 6, "interval": 2 }
      ]
    }
  ]
}
```

The loader fills in missing fields: `effects` becomes `[]`, `type` becomes `spell`, and `damage`, `mana`, `range`, `cast_time`, `cooldown` and `can_move` become `0`. A spell whose name is already in the cache is skipped with a warning.

### With engine.registerSpell

Call it from a plugin's `register` function to add a spell in code. It applies the same defaults and skips a duplicate name. See the [Engine API](#/engine/engine-api/registerspell) page.

```ts title="src/plugins/fire-spells/src/index.ts"
export default {
  async register(engine: EngineAPI) {
    await engine.registerSpell({
      id: 9002,
      name: "shadow_nova",
      damage: 20,
      mana: 25,
      range: 500,
      type: "spell",
      cast_time: 2,
      cooldown: 30,
      can_move: 0,
      description: "Unleashes a wave of shadow energy.",
      icon: null,
      sprite: null,
      particles: null,
      effects: [{ type: "slow", value: 40, duration: 4 }],
      aoe_radius: 200,
      ground_aoe: null,
      ground_duration: null,
      is_thrown: null,
      charge_distance: null,
      teleport_behind: null,
    });
  },
};
```

Plugin spells live in memory only. They are registered again on every start, never written to the database, and shown read-only in the spell editor.

:::warning What a plugin spell needs before it can be cast
Three things come from the code, not from the loader:

- **An `id`.** Neither the loader nor `registerSpell` assigns one, and the cast handler answers `Invalid spell selected.` for a spell with no `id`. Give each plugin spell a number that no database row uses. Cooldowns are keyed by `id`, so two spells sharing one would share a cooldown.
- **A `learned_spells` row** for each player who should have it, the same as a database spell.
- **A refresh of the login workers.** The workers that build a player's spell book at login copy the spell list when they start, which is before plugins load. Call `refreshAuthSpells()` once your spells are registered, as the spell editor does after a save, or a player who logs in will not have the spell in their book.
:::

```ts title="Refreshing the login workers after registering spells"
import { refreshAuthSpells } from "@engine/socket/authentication_pool";

export default {
  async register(engine: EngineAPI) {
    // shadowNova is the SpellData object from the example above.
    await engine.registerSpell(shadowNova);
    await refreshAuthSpells();
  },
};
```
