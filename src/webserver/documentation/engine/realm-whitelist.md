---
title: Realm Whitelist
description: Restrict a realm to approved usernames: setup, the whitelist commands, switching it on and off at runtime, and how the gateway learns about it.
order: 140
---

A realm with its whitelist on only lets approved usernames log in. Use it for a closed test, a staff realm or a private server. This page covers turning it on, managing the list while the server runs, and what the gateway shows to players.

## How it works

| Piece | Where | Role |
|-------|-------|------|
| `WHITELIST` | Environment | Whether the realm starts with the whitelist on |
| `SERVER_ID` | Environment | The realm id. Each realm has its own list. |
| `whitelist` table | Database | The approved usernames, per realm |
| `realmWhitelist` | `src/services/whitelist.ts` | The list in memory, lower case. Logins are checked against this set, never against the database. |

```sql title="The whitelist table (MySQL)"
CREATE TABLE IF NOT EXISTS whitelist (
  realm VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  UNIQUE KEY unique_realm_username (realm, username)
)
```

The check runs when a login has been verified, just before the player enters the world:

```ts title="src/socket/receiver.ts"
// Check realm whitelist
if (isWhitelistEnabled() && !realmWhitelist.has(playerData.username.toLowerCase())) {
  log.warn(`[Whitelist] Access denied for ${playerData.username} - not in whitelist`);
  sendPacket(wt, packetManager.loginFailed());
  wt.close(1008, "Username not whitelisted on this realm");
  return;
}
```

A refused player receives `LOGIN_FAILED` and the connection is closed with the reason `Username not whitelisted on this realm`. Usernames are compared in lower case, so `Alice` and `alice` are the same entry.

## Setup

### 1. Give the realm an id

The list belongs to a realm, identified by `SERVER_ID`. Set it explicitly: when it is unset the whitelist uses the realm name `default`.

```env title=".env.production"
SERVER_ID=server-1
WHITELIST=true
```

### 2. Start with the whitelist on, or switch it on later

:::tabs
```env title="At startup"
# The realm starts with its whitelist on
WHITELIST=true
```
```text title="While running"
/whitelist on
```
:::

With `WHITELIST=true`, the server loads the realm's usernames from the database during startup and logs the result:

```text title="Startup log"
Loaded 12 whitelisted usernames for realm server-1 from database
```

If the table has no rows for this realm it logs `Whitelist enabled but no usernames found for realm server-1`, and nobody can log in until names are added.

:::warning Do not lock yourself out
With `WHITELIST=true` and an empty list, no one can log in, including you, and the whitelist commands only work in game. Either insert your own username first (below), or start with `WHITELIST=false` and run `/whitelist on` in game, which adds you automatically.
:::

```sql title="Adding the first name by hand"
INSERT INTO whitelist (realm, username) VALUES ('server-1', 'your_username');
```

Rows inserted by hand are only read when the list is loaded: at startup with `WHITELIST=true`, or the next time the whitelist is switched on.

### 3. Add players

```text title="In game chat"
/whitelist add alice
/whitelist remove bob
```

## Commands

All of them need the `admin.whitelist` or `admin.*` permission. See [Permissions](#/engine/permissions).

| Command | Effect |
|---------|--------|
| `/whitelist on` | Turns the whitelist on until the server restarts |
| `/whitelist off` | Turns it off until the server restarts |
| `/whitelist add <username>` | Adds a username to this realm's list (database and memory) |
| `/whitelist remove <username>` | Removes a username from this realm's list |

Rules that the command enforces:

- `add` and `remove` only work while the whitelist is on. Otherwise the answer is `Whitelist is not enabled on this realm. Turn it on with /whitelist on`.
- You cannot add or remove yourself.
- Adding a name that is already listed answers `<username> is already whitelisted`. Removing one that is not listed answers `<username> is not whitelisted`.
- If the database write fails, the change in memory is undone, so the two never disagree.

The same four actions are available on the Server page of the [Control panel](#/tools/control-panel), under the same permissions. The complete list of commands is on the [Admin commands](#/engine/admin-commands) page.

## Turning it on and off at runtime

`/whitelist on` and `/whitelist off` (or the switch in the control panel) change the state without a restart. They call `setWhitelistEnabled` in `src/services/whitelist.ts`.

```ts title="src/services/whitelist.ts"
export function setWhitelistEnabled(wanted: boolean, by?: string): Promise<{ success: boolean; message: string }>
```

What happens when it is turned **on**:

1. The realm's usernames are read from the database, replacing the set in memory.
2. The admin who ran the command is added to the list (and to the database) if they are not on it, so they can log back in.
3. The whitelist is enabled. From now on every new login is checked.
4. Everyone who registered a listener is told. This is how the gateway hears about it.

```text title="Answers"
Whitelist is on with 13 names (you were added). Players already online stay, new logins are checked. This lasts until the server restarts: the WHITELIST setting decides how it starts.
Whitelist is off: anyone can log in. This lasts until the server restarts: the WHITELIST setting decides how it starts.
```

Things to know:

| Behaviour | Detail |
|-----------|--------|
| Players already online | Stay connected. Only new logins are checked. |
| Lifetime | Until the server stops. On the next start, `WHITELIST` decides again. |
| Database failure while turning on | The whitelist stays off and the answer says the list could not be read |
| Already in the wanted state | Answers `Whitelist is already on` (or `off`) and does nothing |
| Two switches at once | They run one after the other, never interleaved |

:::tip Make it permanent
A runtime switch is forgotten at the next restart. To keep the whitelist on, also set `WHITELIST=true` in the environment file.
:::

### Using it from code

```ts title="Reading and switching the whitelist"
import { isWhitelistEnabled, onWhitelistSwitch, realmWhitelist, setWhitelistEnabled } from "@engine/services/whitelist";

if (isWhitelistEnabled() && !realmWhitelist.has(username.toLowerCase())) {
  // this username would be refused at login
}

onWhitelistSwitch((enabled) => {
  // called each time the whitelist is switched
});

const result = await setWhitelistEnabled(true, adminUsername);
// result.success, result.message
```

## How the gateway is told

Players pick a realm on the gateway's realm list, so the gateway needs to know which realms are restricted. The engine tells it in three ways.

| When | Request | Field |
|------|---------|-------|
| Registration | `POST /register` | `whitelisted: isWhitelistEnabled()` |
| Every heartbeat (every 5 seconds by default) | `POST /heartbeat` | `whitelisted: isWhitelistEnabled()` |
| Right after a switch | An extra heartbeat, sent at once | the same |

```ts title="src/modules/gateway-client.ts"
body: JSON.stringify({
  id: this.config.serverId,
  activeConnections: this.activeConnections,
  cpuUsage: cpuUsage,
  ramUsage: ramUsage,
  authKey: process.env.GATEWAY_AUTH_KEY,
  timestamp: sendTime,
  rtt: this.previousRtt ?? Date.now() - sendTime,
  // Sent every time: the whitelist can be switched while the server runs.
  whitelisted: isWhitelistEnabled()
})
```

The immediate heartbeat is wired up in `server.ts`:

```ts title="src/socket/server.ts"
// The realm list shows whether this realm is whitelisted: tell the gateway as soon as that is switched.
onWhitelistSwitch(() => {
  void gatewayClient?.heartbeatNow();
});
```

The gateway stores the flag with the realm and includes it in its server list, where the realm selection page marks a whitelisted realm. The gateway only displays the state. The check itself always happens on the game server, at login.

See [Game servers](#/gateway/game-servers) for the gateway's side of registration and heartbeats.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Everyone is refused | The list is empty for this `SERVER_ID`, or `SERVER_ID` changed and the rows belong to the old realm id |
| A name added with SQL is still refused | Rows are only read when the list is loaded. Use `/whitelist add`, or switch the whitelist off and on. |
| The whitelist is off after a restart | It was switched on at runtime only. Set `WHITELIST=true`. |
| `/whitelist add` says the whitelist is not enabled | Run `/whitelist on` first |
| The realm list does not show the realm as whitelisted | The gateway hears about it on the next heartbeat. Check that the game server is registered. |
