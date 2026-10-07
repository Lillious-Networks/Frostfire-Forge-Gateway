---
title: Admin Commands
description: Every admin chat command in the engine, with syntax, aliases, the permission each one checks, and examples.
order: 70
---

This page lists every admin command the engine handles, grouped by area. All of it is taken from the `COMMAND` case in `src/socket/receiver.ts`, which is the only place chat commands are parsed.

For the commands open to every player see [Player Commands](#/engine/player-commands). For how the permission names work see [Permissions](#/engine/permissions).

## How commands are parsed

The client strips the leading `/` and sends the rest in a `COMMAND` packet. The server then:

1. Refuses guests with `Please create an account to use that feature.`
2. Decrypts the text if the client sent it encrypted (`mode: "decrypt"`).
3. Splits it into parts on whitespace. Text inside double quotes stays one part.
4. Upper-cases the first part and uses it as the command name. Command names are not case sensitive.
5. Refuses everything except the chat channels (`P`, `PARTY`, `W`, `WHISPER`, `G`, `GUILD`) while the player is a corpse, with `You cannot do that while dead.`

```ts title="src/socket/receiver.ts"
const commandParts = decryptedMessage.match(/[^\s"]+|"([^"]*)"/g) || [];
const commandName = panelCommand?.name ?? commandParts[0]?.toUpperCase();

const args = panelCommand?.args ?? commandParts
  .slice(1)
  .map((arg: any) => (arg.startsWith('"') ? arg.slice(1, -1) : arg));
```

:::tip Quote anything that has a space
Arguments are split on spaces, so an item called Rat Tail must be written as `"Rat Tail"`. Without the quotes `/give alice Rat Tail 5` reads the item as `Rat` and the amount as `Tail`.
:::

A command the server does not know answers `Invalid command`. A command the player may not use answers `You don't have permission to use this command`.

### Naming a player

Most commands take `<username | id>`. A value that is not a number is matched against the usernames of online players, ignoring case. A number is read as the connection id of an online player (the session id the server gave that connection). Some commands then fall back to the database, so they also work on offline players. The tables below say which.

## All commands

| Command | Aliases | Permission | What it does |
|---------|---------|------------|--------------|
| `/kick <username \| id>` | `/disconnect` | `admin.kick` or `admin.*` | Disconnects an online player |
| `/ban <username \| id>` | none | `admin.ban` or `admin.*` | Bans an account, online or offline |
| `/unban <username \| id>` | none | `admin.unban` or `admin.*` | Lifts a ban |
| `/mute <username> [duration] [reason]` | none | `admin.mute` or `admin.*` | Mutes a player's chat without telling them |
| `/unmute <username>` | none | `admin.unmute` or `admin.*` | Lifts a mute |
| `/reports [view <number> \| resolve <number> [note]]` | none | `admin.reports` or `admin.*` | Lists, shows or resolves the reports players have sent |
| `/trades <username>` | none | `admin.trades` or `admin.*` | Lists the latest trades a player completed |
| `/admin <username \| id>` | `/setadmin` | `server.admin` or `server.*` | Toggles the admin role of an account |
| `/kill [username \| id]` | none | `admin.kill` or `admin.*` | Kills an online player through the normal death flow |
| `/revive [username \| id]` | none | `admin.revive` or `admin.*` | Revives a dead or ghost player in place |
| `/respawn [username \| id]` | none | `admin.respawn` or `admin.*` | Sends a player to the default map's spawn at full health |
| `/cooldowns [username \| id]` | `/resetcooldowns` | `admin.cooldowns` or `admin.*` | Ends every cooldown an online player is waiting on |
| `/summon <username \| id>` | none | `admin.summon` or `admin.*` | Brings an online player to you |
| `/goto <username \| id>` | `/teleport` | `admin.summon` or `admin.*` | Takes you to an online player |
| `/permission <mode> <username \| id> [permissions]` | `/permissions` | `admin.permission` or `admin.*`, plus the mode's own permission | Reads or changes a player's permissions |
| `/notify [all \| map \| admins] <message>` | `/broadcast` | `server.notify` or `server.*` | Sends a notification to players |
| `/restart` | none | `server.restart` or `server.*` | Starts, or cancels, a 15 minute restart countdown |
| `/shutdown` | none | `server.shutdown` or `server.*` | Stops the server after a 5 second warning |
| `/whitelist <on \| off \| add \| remove> [username]` | none | `admin.whitelist` or `admin.*` | Switches the realm whitelist or edits its list |
| `/warp <map>` | none | `admin.warp` or `admin.*` | Moves you to another map |
| `/reloadmap <map>` | none | `admin.reloadmap` or `admin.*` | Reloads a map and resends it to everyone on it |
| `/weather <name \| clear \| random \| weather_api>` | none | `admin.weather` or `admin.*` | Sets the weather of the world you are in |
| `/give <username \| id> <item> [amount]` | none | `admin.items` or `admin.*` | Adds an item to a player's inventory |
| `/drop <item> [amount]` | none | `admin.items` or `admin.*` | Drops loot on the ground at your position, for anyone to pick up |
| `/spawnchest table <id>` or `/spawnchest inline ...` | none | `admin.items` or `admin.*` | Spawns a loot chest at your position |
| `/loottable <sub-command> ...` | none | `admin.loot` or `admin.*` | Lists and edits loot tables |
| `/tileeditor` | `/te` | `tools.tile_editor` or `tools.*` | Opens the map editor |
| `/particleeditor` | `/pe` | `tools.particle_editor` or `tools.*` | Opens the particle editor |
| `/npceditor` | `/ne` | `tools.npc_editor` or `tools.*` | Opens the NPC editor |
| `/itemeditor` | `/ie` | admin role, `tools.item_editor`, `tools.*` or `server.*` | Opens the item editor |
| `/spelleditor` | `/se` | admin role, `tools.spell_editor`, `tools.*`, `server.admin` or `server.*` | Opens the spell editor |
| `/weathereditor` | `/we` | admin role, `tools.weather_editor`, `tools.*`, `server.admin` or `server.*` | Opens the weather editor |
| `/questeditor` | `/qe` | admin role, `tools.quest_editor`, `tools.*` or `server.*` | Opens the quest editor |
| `/creatureeditor` | `/ce` | admin role, `tools.creature_editor`, `tools.*` or `server.*` | Opens the creature editor |
| `/looteditor` | `/le` | `admin.loot` or `admin.*` | Opens the loot table editor |
| `/player edit <username \| id>` | none | `server.admin` or `server.*` | Opens the player editor on one player |
| `/controlpanel` | `/cp` | admin role | Opens the server control panel |

:::warning Three permissions are checked but not seeded
`admin.kick`, `admin.summon` and `admin.reloadmap` are checked by the commands above, but the setup scripts do not insert them into the `permission_types` table. `/permission add` only accepts names found in that table, so out of the box these three commands can only be reached through `admin.*`. See [Permissions](#/engine/permissions/nodes-that-are-not-seeded).
:::

## Player moderation

### /kick

```text title="Syntax"
/kick <username | id>
/disconnect <username | id>
```

Disconnects an online player. It refuses yourself (`You cannot disconnect yourself`) and other admins (`You cannot disconnect other admins`).

```text title="Example"
/kick alice
```

### /ban and /unban

```text title="Syntax"
/ban <username | id>
/unban <username | id>
```

`/ban` looks for an online player first and then for the account in the database, so it works on offline players. It refuses yourself, an admin who is online, and an account that is already banned. An online target is disconnected as part of the ban.

`/unban` always looks the account up in the database.

```text title="Example"
/ban alice
/unban alice
```

### /mute and /unmute

```text title="Syntax"
/mute <username> [duration] [reason]
/unmute <username>
```

A mute is silent. The muted player still sees their own say, whisper, party and guild lines as if they were sent, and nobody else receives them. They are never told, and chat events are not emitted for their lines, so plugins do not see them either.

| Part | Meaning |
|------|---------|
| `duration` | A whole number and a unit: `s`, `m`, `h`, `d` or `w`. `30m`, `2h`, `7d`. Left out, the mute lasts until `/unmute`. |
| `permanent` | Written in place of a duration, it says there is none. Use it when the reason itself starts with something that reads as a duration. |
| `reason` | The rest of the line. Shown to other admins in the control panel. |

The command works on offline accounts, by username. It refuses yourself and admins. Muting a muted player replaces the mute. A mute survives logins and restarts, and one whose time has passed is removed the next time the player speaks.

```text title="Example"
/mute alice 30m spamming the market
/mute alice permanent 7d was not enough
/unmute alice
```

### /reports

```text title="Syntax"
/reports
/reports view <number>
/reports resolve <number> [note]
```

Players send reports with `/report` or from the menu on another player (see [Player Commands](#/engine/player-commands)). Admins online who hold `admin.reports` get a notification when one arrives.

| Form | What it answers |
|------|-----------------|
| `/reports` | The open reports, newest first, ten at most. The rest are in the control panel. |
| `/reports view 12` | Who reported whom and why, what the reporter typed, where the reported player was, and the lines attached |
| `/reports resolve 12 warned` | Closes the report with a note for the other admins |

A report carries the reported player's latest chat lines that reached the reporter, up to 20 from the half hour before. A whisper to somebody else is never attached. The control panel's Reports page shows the same and adds Mute, Kick and Ban.

### /trades

```text title="Syntax"
/trades <username>
```

Lists the latest trades a player completed, newest first and ten at most. Each line says who the trade was with, how long ago, what the player gave and what they got.

```text title="Example answer"
Aria's latest trades: 2
#41 with Borin, 5m ago: gave nothing, got 12g
#37 with Cale, 1h ago: gave 4 Iron Ore, 1s 60c, got 5 Health Potion
```

Every completed trade is written to the `trade_log` table in the same transaction as the swap. The engine holds the latest 500 in memory, and this command and the control panel read from those. Older trades stay in the table. A trade that was cancelled or refused is not recorded.

### /admin

```text title="Syntax"
/admin <username | id>
/setadmin <username | id>
```

Flips the admin role of an account (`accounts.role`) and answers with `<Name> is now an admin` or `<Name> is now not an admin`. You cannot change your own role. If the target is online their client is told to reconnect so the new role applies.

The admin role is separate from permissions. It gates the control panel, stealth, noclip and the map editor's live sync, and it is required before `/permission add` or `/permission set` will give anyone a permission.

### /kill, /revive and /respawn

```text title="Syntax"
/kill [username | id]
/revive [username | id]
/respawn [username | id]
```

All three act on yourself when no player is named.

| Command | Target | Behaviour |
|---------|--------|-----------|
| `/kill` | Online only | Runs the normal death flow with you as the killer. Fails with `<Name> is already dead` for a corpse or ghost. |
| `/revive` | Online only | Brings a corpse or ghost back in place at full health and stamina. Fails with `<Name> is not dead` otherwise. Emits `onPlayerRevived`. |
| `/respawn` | Online or offline | Moves the player to the spawn of the default map (`default_map` in the settings, `main` when unset), or to the centre of that map when it has no spawn. Clears the death state and restores health and stamina. Emits `onPlayerRespawn`. |

```text title="Example"
/kill alice
/revive alice
/respawn
```

### /cooldowns

```text title="Syntax"
/cooldowns [username | id]
/resetcooldowns [username | id]
```

Ends every cooldown a player is waiting on, at once. It acts on yourself when no player is named, and the player has to be online.

| Cooldown | Where it is kept |
|----------|------------------|
| Spell cooldowns | In memory |
| The spell lockout after an interrupt | In memory |
| The 30 seconds all consumables share | In memory |
| The home item's hour | `player_home.used_at` in the database |

The player's home is left as it is, and so are their buffs and debuffs. Their game is sent `COOLDOWNS_RESET`, which takes the clocks off their hotbar, spell book and bags.

| Answer | When |
|--------|------|
| `Reset the cooldowns of <Name>` | It was done |
| `Player must be online to reset their cooldowns` | No online player has that name or id |
| `The home cooldown of <Name> could not be reset. The others were.` | The database write failed. The other three are reset regardless. |

```text title="Example"
/cooldowns
/cooldowns alice
```

### /summon and /goto

```text title="Syntax"
/summon <username | id>
/goto <username | id>
/teleport <username | id>
```

`/summon` moves an online player to your position, across maps if needed, and puts them on your layer when it has room. Summoning an admin also needs `admin.summonadmins` (or `admin.*`), otherwise the answer is `You cannot summon other admins`.

`/goto` moves you to an online player and onto their layer. `/teleport` is the same command. Both check `admin.summon`, there is no separate permission for them.

```text title="Example"
/summon alice
/goto alice
```

## Permissions

```text title="Syntax"
/permission <add | remove | set | clear | list> <username | id> [permissions]
/permissions ...
```

The command itself needs `admin.permission` or `admin.*`. Each mode then needs its own permission:

| Mode | Extra permission | What it does |
|------|------------------|--------------|
| `add` | `permission.add` or `permission.*` | Adds one permission, or a comma-separated list |
| `remove` | `permission.remove` or `permission.*` | Removes one permission, or a comma-separated list |
| `set` | `permission.add` or `permission.*` | Replaces the whole list |
| `clear` | `permission.remove` or `permission.*` | Deletes every permission the player holds |
| `list` | `permission.list` or `permission.*` | Shows what the player holds |

Rules the handler enforces:

- The target can be online or offline.
- You cannot change your own permissions. `list` on yourself is allowed.
- `add` and `set` only work on a player who has the admin role (`You can only grant permissions to admin players`). `remove`, `clear` and `list` work on anyone.
- Every name must exist in the `permission_types` table, otherwise the answer is `Invalid permission: <name>`.
- You can only hand out a permission you hold yourself, unless you hold `permission.*` or `server.*`.
- Each change is written to the server log with a `[PERMISSION_AUDIT]` prefix.

```text title="Examples"
/permission list alice
/permission add alice admin.ban,admin.unban
/permission remove alice admin.ban
/permission set alice tools.*,admin.warp
/permission clear alice
```

## Server

### /notify

```text title="Syntax"
/notify <message>
/notify all <message>
/notify map <message>
/notify admins <message>
/broadcast ...
```

Sends a `NOTIFY` packet. When the first word is not `all`, `map` or `admins` the whole text is the message and the audience is `all`.

| Audience | Who receives it |
|----------|-----------------|
| `all` | Every online player |
| `map` | Every player on your current map |
| `admins` | Players with the admin role on your current map |

```text title="Example"
/notify map The bridge event starts in five minutes
```

### /restart

```text title="Syntax"
/restart
```

Starts a 15 minute countdown. Every player is notified once a minute, then once a second for the last 30 seconds. When it ends every connection is closed, the player table is cleared and the process exits through its graceful shutdown. The engine does not start itself again: whatever supervises the process has to do that.

Running `/restart` while a countdown is active cancels it and tells everyone the restart was aborted.

### /shutdown

```text title="Syntax"
/shutdown
```

Warns every player, waits 5 seconds, closes every connection, waits for the database queue to drain and exits. A second `/shutdown` while one is in progress answers `The server is already shutting down`.

### /whitelist

```text title="Syntax"
/whitelist on
/whitelist off
/whitelist add <username>
/whitelist remove <username>
```

`on` and `off` switch the realm whitelist at runtime. `add` and `remove` only work while it is on, and neither accepts your own username. See [Realm Whitelist](#/engine/realm-whitelist) for what the switch does.

## World

### /warp

```text title="Syntax"
/warp <map>
```

Moves you to a map by name, without the `.json` extension. You land on the map's spawn point, or in its centre when it has none. Naming a second argument is refused: `Warping another player is not supported. Usage: /warp <map>`. Use `/summon` to move someone else.

```text title="Example"
/warp overworld
```

### /reloadmap

```text title="Syntax"
/reloadmap <map>
```

Reads the map again and sends a fresh `LOAD_MAP` to every player on it.

### /weather

```text title="Syntax"
/weather <weather_name | clear | random | weather_api>
```

Sets the weather of the world you are standing in and sends `CHANGE_WEATHER` to everyone on that map. A name must exist in the weather data unless it is one of the three keywords. See [Weather](#/engine/weather) for what each keyword means.

```text title="Example"
/weather rainy
/weather clear
```

## Items and loot

### /give

```text title="Syntax"
/give <username | id> <item> [amount]
```

Adds an item to a player's inventory. The player can be offline. The item name is matched without regard to case against the item list, and the amount defaults to 1. An online target sees the item at once and is told `You received <amount>x <item>`.

```text title="Example"
/give alice "Rat Tail" 5
```

### /drop

```text title="Syntax"
/drop <item> [amount]
```

Spawns a loot drop at your position with no owner: any player who walks up to it can pick it up, and the first one to do so gets it. The amount defaults to 1 and is capped at 9999. The drop disappears after 30 minutes if nobody takes it.

### /spawnchest

```text title="Syntax"
/spawnchest table <loot_table_id>
/spawnchest inline <item> <min> <max> <chance> [<item> <min> <max> <chance> ...]
```

Spawns a loot chest at your position. `table` fills it from a stored loot table. `inline` takes groups of four arguments, one group per item.

```text title="Example"
/spawnchest table 3
/spawnchest inline Bread 1 3 100 "Rat Tail" 1 1 25
```

### /loottable

```text title="Syntax"
/loottable <sub-command> ...
```

| Sub-command | Arguments | What it does |
|-------------|-----------|--------------|
| `list` | none | Lists every table with its id and item count |
| `create` | `<name>` | Creates an empty table |
| `delete` | `<id>` | Deletes a table |
| `info` | `<id>` | Lists the rows of one table |
| `additem` | `<tableId> <item> <min> <max> <chance> [quality]` | Adds a row. `min` and `max` default to 1, `quality` to `common` |
| `removeitem` | `<itemId>` | Removes a row by its row id |
| `updateitem` | `<itemId> <min> <max> <chance> [quality]` | Changes a row |

```text title="Example"
/loottable create cellar_rats
/loottable additem 4 "Rat Tail" 1 2 60 common
/loottable info 4
```

## Tools

These commands only tell the client to open a window. Each editor checks permission again on every packet it sends, so opening the window grants nothing by itself.

| Command | Alias | Who may open it | Tool |
|---------|-------|-----------------|------|
| `/tileeditor` | `/te` | `tools.tile_editor` or `tools.*` | [Map editor](#/tools/map-editor) |
| `/particleeditor` | `/pe` | `tools.particle_editor` or `tools.*` | [Particle editor](#/tools/particle-editor) |
| `/npceditor` | `/ne` | `tools.npc_editor` or `tools.*` | [NPC editor](#/tools/npc-editor) |
| `/itemeditor` | `/ie` | Admin role, `tools.item_editor`, `tools.*` or `server.*` | [Item editor](#/tools/item-editor) |
| `/spelleditor` | `/se` | Admin role, `tools.spell_editor`, `tools.*`, `server.admin` or `server.*` | [Spell editor](#/tools/spell-editor) |
| `/weathereditor` | `/we` | Admin role, `tools.weather_editor`, `tools.*`, `server.admin` or `server.*` | [Weather editor](#/tools/weather-editor) |
| `/questeditor` | `/qe` | Admin role, `tools.quest_editor`, `tools.*` or `server.*` | [Quest editor](#/tools/quest-editor) |
| `/creatureeditor` | `/ce` | Admin role, `tools.creature_editor`, `tools.*` or `server.*` | [Creature editor](#/tools/creature-editor) |
| `/looteditor` | `/le` | `admin.loot` or `admin.*` | [Loot editor](#/tools/loot-editor) |
| `/player edit <username \| id>` | none | `server.admin` or `server.*` | [Player editor](#/tools/player-editor) |
| `/controlpanel` | `/cp` | Admin role, not a guest | [Control panel](#/tools/control-panel) |

:::warning Opening an editor is not the same as saving from it
Saving a map (`SAVE_MAP`), saving, renaming, deleting or testing a particle, and adding, saving, moving or deleting an NPC each check `server.admin` or `server.*`. A player who only holds `tools.tile_editor`, `tools.particle_editor` or `tools.npc_editor` can open the window but cannot save from it.
:::

`/player edit` takes the connection id of an online player or an account id. The target can be offline.

The control panel runs the commands on this page for you. Each control uses the same permission as the command it stands for, so the panel gives nobody a power the commands would refuse.

## Admin actions without a command

Some admin actions are packets sent by the client, not chat commands:

| Packet | Requirement | What it does |
|--------|-------------|--------------|
| `NOCLIP` | Admin role | Toggles walking through collision |
| `STEALTH` | Admin role | Toggles admin stealth. Other players stop seeing you, other admins still do |
| `TELEPORTXY` | Admin role | Moves you to a position on the current map |
| `GET_ONLINE_PLAYERS` | Admin role | Asks for the list of online players, answered with `ONLINE_PLAYERS_LIST` |
| `DRAG_PLAYER_START`, `DRAG_UPDATE`, `DRAG_PLAYER_STOP` | `admin.drag` or `admin.*` | Drags another player around the map |
