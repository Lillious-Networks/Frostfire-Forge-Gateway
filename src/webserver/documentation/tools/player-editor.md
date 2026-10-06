---
title: Player Editor
description: Inspect and change one player, online or offline: stats, currency, location, items, spells, guild, quests, role and permissions.
order: 60
---

The player editor opens one account and lets an admin change almost everything about it. It works on players who are online and on accounts that are offline, and an online player's client is updated as each change is made. This page covers how to open it, each tab, and how changes are sent.

## Opening it

From the chat, name the player:

```text title="Chat command"
/player edit <username or id>
```

`id` is the connection id of an online player, as the other admin commands take it, or an account number. An unknown name answers "Player not found".

You can also right click a player in the game and choose "Edit Player Attributes".

The editor opens in its own window at route `/player-editor`, already on that player. From there the side pane switches to any other account without going back to the chat.

## Permission

The player editor needs `server.admin` or `server.*` in your permission list. The admin role alone is not enough, and guests are always refused.

Two parts of the editor ask for more:

| Change | Also needs |
| --- | --- |
| Give a permission | `permission.add` or `permission.*`, and you must hold the permission you give (or `permission.*` or `server.*`) |
| Take a permission away | `permission.remove` or `permission.*` |

The server reads your stored permissions on every packet the editor sends. It does not trust the copy made when you logged in.

## The window

The editor uses the shared workbench described in [Tools Overview](#/tools/overview/the-editor-workbench), with two differences: there is no New button, since accounts are not created here, and there is no single Save.

| Area | Contents |
| --- | --- |
| Side pane | Who is online, or the accounts found by the search |
| Top bar | The open player, the state, and Reload |
| Tabs | Overview, Stats, Inventory, Equipment, Collections, Social, Quests, Access |

With an empty search the side pane lists the players online. Type a name to search every account, online or not.

### How changes are sent

- **List changes are sent as you make them.** Adding an item, equipping gear, teaching a spell, adding a friend and similar actions go to the server immediately.
- **Forms have their own Apply button.** Stats, Currency, Location and Permissions are edited as a form and sent when you press Apply on that card.

The state in the top bar reads "Up to date" or "Unapplied changes" accordingly. After every change the server answers with the player as they now stand, and the window redraws from that.

:::warning A dead player is partly locked
While the player is dead, their location and stats cannot be changed. Revive them first, for example from the [Control Panel](#/tools/control-panel).
:::

## Overview tab

**Account** shows facts that cannot be edited here:

| Fact | Meaning |
| --- | --- |
| Account number | The account id |
| Status | Online with connection id and map, or Offline |
| Role | Admin, Guest or Player |
| State | Alive or one of the dead states |
| Banned | Yes or No |
| Bags | The bags the player has equipped |

**Location**

| Field | Notes |
| --- | --- |
| Map | One of the server's maps |
| Facing | The direction the character faces |
| X, Y | Position in pixels, within the size of the chosen map |

Applying moves an online player straight away. For an offline player it sets where they will log in.

**Currency** has one field, Balance, entered as gold, silver and copper. 100 copper make a silver and 100 silver a gold. The card states the most a player can hold.

## Stats tab

| Field | Notes |
| --- | --- |
| Level | A new level sets the XP it needs and the base health and mana |
| XP | Must stay below what the level needs |
| Health, Max health | |
| Mana, Max mana | |
| Damage | |
| Armor, Critical chance, Critical damage, Avoidance | Percent |

The hints under the combat stats show the value with the player's gear counted in. Only the stats you changed are sent.

## Inventory tab

Lists every item with its quantity and shows how many slots are used.

- "Add item" opens the item picker and gives one of the picked item.
- Change a row's quantity to set how many they hold. A quantity of 0 takes the item away.
- The remove button takes the whole stack, after a confirmation.

## Equipment tab

One row per equipment slot. Pick an item for a slot to equip it, or unequip what is worn.

:::note
Equipping gives the player the item if they do not already have it.
:::

## Collections tab

| Card | Actions |
| --- | --- |
| Mounts and collectables | "Add mount", and remove on each entry |
| Spells | "Teach spell", and remove on each known spell |

## Social tab

| Card | Actions |
| --- | --- |
| Guild | "Add to guild" when they have none. In a guild: "Make leader", "Remove from guild" and "Disband guild". |
| Party | "Add to a party" asks whose party. If that player has none, they lead a new one. "Remove from party" when they are in one. |
| Friends | "Add friend" asks for a username. Remove on each friend. |

Disbanding a guild removes it for all its members and cannot be undone. It asks for confirmation.

## Quests tab

| Card | Actions |
| --- | --- |
| Active quests | "Start a quest" adds one. "Complete" finishes a quest. The remove button abandons it. |
| Completed quests | "Forget" lets the player take the quest again |

:::warning Completing a quest here gives no rewards
"Complete" only marks the quest as done. No items, currency or XP are granted.
:::

## Access tab

**Role** has the admin switch. Changing it asks for confirmation, and the player is reconnected when their role changes.

**Permissions** lists every permission defined on the server as tick boxes. Tick what the player should hold and press Apply.

- You can only give out permissions you hold yourself.
- You cannot change your own role or permissions. The tab says "This is you".

The permission names are explained in [Permissions](#/engine/permissions).

## Packets

| Packet | Direction | Purpose |
| --- | --- | --- |
| `PLAYER_EDITOR_OPEN` | Server to client | Tells the game to open the editor on a player |
| `PLAYER_EDITOR_LOAD` | Client to server | Ask for a player's full state |
| `PLAYER_EDITOR_DATA` | Server to client | The player as they stand |
| `PLAYER_EDITOR_SEARCH` | Client to server | Search accounts |
| `PLAYER_EDITOR_RESULTS` | Server to client | The accounts found |
| `PLAYER_EDITOR_ACTION` | Client to server | One change, such as `stats.set` or `inventory.add` |
| `PLAYER_EDITOR_RESULT` | Server to client | Whether it was done, any problems, and the fresh state |

The actions the server accepts:

| Group | Actions |
| --- | --- |
| Forms | `stats.set`, `currency.set`, `location.set`, `permissions.set` |
| Role | `admin.set` |
| Inventory | `inventory.add`, `inventory.remove`, `inventory.set` |
| Equipment | `equipment.equip`, `equipment.unequip` |
| Collections | `collectable.add`, `collectable.remove`, `spell.learn`, `spell.unlearn` |
| Social | `friend.add`, `friend.remove`, `guild.join`, `guild.leave`, `guild.lead`, `guild.disband`, `party.join`, `party.leave` |
| Quests | `quest.accept`, `quest.abandon`, `quest.complete`, `quest.forget` |

If the server does not answer a change in time, the window says that nothing was confirmed. Press Reload to see how the player really stands before trying again.

## Tips

- Use Reload before a long session on a busy player. Their inventory and stats keep changing while they play.
- To test a quest chain, use "Forget" on the completed quests instead of creating a new character.
- To hand out starting gear, the Equipment tab is quicker than Inventory, since equipping also gives the item.
- For actions on many players at once, such as messages, kicks or bans, use the [Control Panel](#/tools/control-panel).
