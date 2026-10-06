---
title: Control Panel
description: The admin dashboard of a game server: live charts, players, messages, whitelist, restarts, weather, items and loot tables.
order: 20
---

The control panel is a dashboard for the admins of one game server. It shows how the server is doing and gives a control for every admin command, each running under that command's own permission. This page walks through its six pages and explains how its actions are checked.

## Opening it

```text title="Chat command"
/cp
/controlpanel
```

The panel opens in its own window at route `/control-panel`. Typing the command again closes it.

:::note It only works from the game
Opened straight from the address bar, the panel shows "This window opens from the game". Log in to the game as an admin and type `/cp`. See [Tools Overview](#/tools/overview/how-the-tool-windows-work).
:::

## Permission

Opening the panel needs the **admin role**. Guests are refused. No `tools.` permission is involved.

Inside the panel, every control stands for one admin command and is checked with that command's own rule, first by the panel code on the server and again by the command itself. The panel therefore gives nobody a power the chat command would refuse. A control you may not use is greyed out with the reason as its tooltip.

| Control | Command it runs | Permission |
| --- | --- | --- |
| Noclip, Stealth | `/noclip`, `/stealth` | Admin role |
| Summon, Go to | `/summon`, `/teleport` | `admin.summon` or `admin.*` |
| Respawn | `/respawn` | `admin.respawn` or `admin.*` |
| Revive | `/revive` | `admin.revive` or `admin.*` |
| Kill | `/kill` | `admin.kill` or `admin.*` |
| Kick | `/kick` | `admin.kick` or `admin.*` |
| Ban | `/ban` | `admin.ban` or `admin.*` |
| Unban | `/unban` | `admin.unban` or `admin.*` |
| Make admin, Remove admin | `/admin` | `server.admin` or `server.*` |
| Give item, Drop item, Spawn chest | `/give`, `/drop`, `/spawnchest` | `admin.items` or `admin.*` |
| See, give, take, set and clear permissions | `/permission` | `admin.permission` or `admin.*`, plus `permission.list`, `permission.add` or `permission.remove` (or `permission.*`) for the part used |
| Send message | `/broadcast` | `server.notify` or `server.*` |
| Whitelist switch, add and remove | `/whitelist` | `admin.whitelist` or `admin.*` |
| Schedule restart, Cancel restart | `/restart` | `server.restart` or `server.*` |
| Shut down | `/shutdown` | `server.shutdown` or `server.*` |
| Reload map | `/reloadmap` | `admin.reloadmap` or `admin.*` |
| Warp | `/warp` | `admin.warp` or `admin.*` |
| Change weather | `/weather` | `admin.weather` or `admin.*` |
| Loot tables | `/loottable` | `admin.loot` or `admin.*` |

The commands themselves are documented in [Admin Commands](#/engine/admin-commands).

## Layout

| Area | Contents |
| --- | --- |
| Navigation | The six pages, grouped as Overview, People and Operations, with who is logged in at the foot |
| Top bar | The page name and a status pill for the server |
| Banner | A line shown when something needs attention |
| Page | Cards for the page in view |

The status pill reads one of:

| Pill | Meaning |
| --- | --- |
| Running | The server is keeping up |
| Running behind | Server lag is 30 ms or more |
| Struggling | Server lag is 60 ms or more |
| Restart scheduled | A restart countdown is running |
| Not answering | No answer from the server for about 16 seconds |
| Connecting | Waiting for the first answer |
| No access | The server refused this account |

The panel refreshes itself every 5 seconds.

## Dashboard

**Over time** holds three charts with a range selector: Last hour, 6 hours, 24 hours.

| Chart | Shows |
| --- | --- |
| Players online | How many players were connected |
| Server lag | How late the server's work is running, in milliseconds |
| Memory in use | Memory of the server process |

**Who is online** breaks the current players down:

| Card | Shows |
| --- | --- |
| By map | Players per map. Pick a map to list the players on it. |
| By level | Players in each band of ten levels |
| By role | Admins, guests, and everyone else |

**Recent activity** lists what admins did through the panel.

:::note History lives in memory
The server takes a reading every 15 seconds. It keeps the last hour at that resolution, the last 24 hours at one reading a minute, and the last 100 actions. All of it starts again when the server restarts.
:::

## Players

A table of everyone online, with columns Player, Level, Map, Status and Online for. Click a column to sort.

- The search field filters by name or map. Typing two or more characters also searches every account, so offline players appear, tagged Offline.
- The Show filter switches between All, Admins and Guests. A second filter limits the table to one map.
- Up and Down move through the rows. Enter or Space opens the player.

Picking a player opens a side panel with their facts (level, map, time online, connection id, or account number when offline) and four groups of actions.

| Group | Actions |
| --- | --- |
| Movement | Summon (bring them to you), Go to (take yourself to them), Respawn (send them to the respawn point, alive and at full health), Revive (bring them back to life where they are) |
| Moderation | Kill, Kick, Ban, Unban |
| Account | Make admin or Remove admin, and Permissions |
| Items | Give item: an item name with search, and an amount. It goes straight into their inventory, online or not. |

Built in limits:

- Summon, Go to, Kick, Ban and Unban are off for yourself.
- Admins cannot be kicked or banned.
- Summoning an admin needs an extra right.
- Summon, Go to, Revive, Kill and Kick need the player to be online.

**Permissions** shows the player's permissions as tick boxes. "Save ticked" sets the list to what is ticked, "Clear all" removes every permission, and below them one permission can be given or taken away on its own. You can only give out permissions you hold yourself, and you cannot change your own.

To change a player's stats, inventory or quests, use the [Player Editor](#/tools/player-editor).

## Communication

**Send a message** sends a notification to the screen of everyone it is addressed to.

| Field | Notes |
| --- | --- |
| Audience | Everyone, Everyone on your map, or Admins on your map |
| Message | Up to 500 characters |

**Recent messages** lists what was sent through the panel since the server started.

## Server

| Card | Contents |
| --- | --- |
| Status | State, time running, start time, players online with the peak, memory in use and server lag |
| Creatures | How many creatures exist, are awake and are in combat, the number of maps with creatures, and how long a typical, a slow and the slowest round of moving them takes |
| Whitelist | The on and off switch, and a username field with "Add to whitelist" and "Remove from whitelist" |
| Restart | "Schedule restart" and "Cancel restart" |
| Shut down | Stops the server |

Things to know:

- **Whitelist.** While it is on, only the names on it can log in. Players already online stay. Turning it on puts you on the list. The switch lasts until the server restarts: the `WHITELIST` setting decides how the server starts. See [Realm Whitelist](#/engine/realm-whitelist).
- **Restart.** Players get a 15 minute countdown, then everyone is disconnected and the server stops. Under Docker it is started again at once. Started by hand, it stays down until someone starts it.
- **Shut down.** Players are warned, and 5 seconds later everyone is disconnected, you included, and the server stops.

## World

| Card | Contents |
| --- | --- |
| Worlds | Every world, the weather it is showing, and how many players are in it. Your own world is marked. |
| Weather | Changes the weather of the map you are on |
| Reload a map | Reads a map again and sends it to everyone on it |
| Your character | Warp to another map, plus the Noclip and Stealth switches |

- Warping puts you in the middle of the map you pick.
- Noclip lets you walk through anything that would stop you.
- Stealth hides you from players who are not admins.

Weathers themselves are made in the [Weather Editor](#/tools/weather-editor).

## Items and Loot

| Card | Contents |
| --- | --- |
| Drop an item | An item and an amount. It falls on the ground where you are standing. |
| Spawn a chest | A chest where you are standing, for any player to open |
| Loot tables | Create, change and delete the tables that chests and creatures drop from |

A chest is filled in one of two ways:

- **From a loot table.** The chest rolls what it holds from the table when it is opened.
- **With chosen items.** You list the rows yourself, up to 20, each with an item and an amount.

Each row of a loot table has an item, the fewest and most that drop, a chance in percent and a quality (common, uncommon, rare, epic or legendary). The same tables can be edited in the dedicated [Loot Editor](#/tools/loot-editor).

## Confirmations

Anything that cannot be taken back asks first: kick, ban, kill, the admin role, permission changes, restart, shutdown and deleting a loot table.

## Packets

| Packet | Direction | Purpose |
| --- | --- | --- |
| `TOGGLE_CONTROL_PANEL` | Server to client | Open or close the panel window |
| `CONTROL_PANEL_LOAD` | Client to server | Ask for the current state. The first request is full, later ones only ask for what is new. |
| `CONTROL_PANEL_DATA` | Server to client | Status, players, worlds, readings and activity |
| `CONTROL_PANEL_QUERY` | Client to server | A list read on request: players, items, permissions, loot tables |
| `CONTROL_PANEL_RESULTS` | Server to client | The answer to a query |
| `CONTROL_PANEL_ACTION` | Client to server | Run one action, such as `player.kick` or `server.broadcast` |
| `CONTROL_PANEL_RESULT` | Server to client | What the command answered and how things now stand |

If no answer arrives for an action within about 15 seconds, the panel reports "The server is not answering".

## Tips

- Keep the panel on the Dashboard during an event or a load test. Server lag is the first number to move when a realm is in trouble.
- Use the By map card to find where players are before you reload a map or change its weather.
- Schedule restarts instead of shutting down. The countdown gives players time to finish what they are doing.
- The Recent activity list is an audit trail only until the next restart. Copy anything you need to keep.
