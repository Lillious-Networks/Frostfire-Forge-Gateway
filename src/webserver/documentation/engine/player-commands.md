---
title: Player Commands
description: The chat commands every logged-in player can use, and the rules the server applies to them.
order: 80
---

This page lists every command a normal player can use, with no permission needed. They are handled by the same `COMMAND` case in `src/socket/receiver.ts` as the [admin commands](#/engine/admin-commands), so parsing works the same way: the first word is the command (not case sensitive), the rest are arguments, and double quotes keep a phrase together.

For the player-facing version of this page see [Chat and Commands](#/player-guide/chat-and-commands).

## All commands

| Command | Alias | Handled by | What it does |
|---------|-------|------------|--------------|
| `/say` | `/s` | Client only | Switches the chat box back to local chat |
| `/party <message>` | `/p` | Server | Sends a message to your party |
| `/guild <message>` | `/g` | Server | Sends a message to your guild |
| `/whisper <username> <message>` | `/w` | Server | Sends a private message to one online player |
| `/invite <username>` | none | Server | Invites an online player to your party |
| `/ginvite <username>` | none | Server | Invites an online player to your guild. Guild leader only |

## Who can use commands

| Player state | What is allowed |
|--------------|-----------------|
| Guest account | Nothing. Every command, and local chat, answers `Please create an account to use that feature.` |
| Corpse (dead, not released) | Only `/p`, `/party`, `/w`, `/whisper`, `/g` and `/guild`. Anything else answers `You cannot do that while dead.` |
| Ghost | Every command. Local chat is replaced by spirit speech (see below). |
| Alive | Every command on this page |

A command the server does not recognise answers `Invalid command`.

## Local chat

Plain text typed into the chat box is not a command. The client sends it as a `CHAT` packet and the server shows it to everyone on the same map.

`/say` and `/s` never reach the server. Typing either of them followed by a space only switches the chat box back to local chat after it was set to party, guild or whisper.

Rules the `CHAT` handler enforces:

| Rule | Value |
|------|-------|
| Longest message | 500 characters |
| Rate limit | 5 messages in 3 seconds per connection, then `You are sending messages too fast.` |
| Audience | Players on the same map |
| Corpses | Cannot talk |
| Ghosts | A ghost who is not an admin speaks in generated spirit speech, not the text typed |
| Stealthed admins | Only other admins see the message |
| Translation | A reader whose language differs from the sender's gets a translated copy |

```ts title="src/socket/receiver.ts"
const MAX_CHAT_LENGTH = 500;
const CHAT_RATE_MAX = 5;
const CHAT_RATE_WINDOW = 3000;
```

A plugin can watch local chat with the `onPlayerChat` event, see [Listener Events](#/engine/listener-events).

## Party chat

```text title="Syntax"
/party <message>
/p <message>
```

Sends the message to every online member of your party, yourself included, as a `PARTY_CHAT` packet. It fails with `Please provide a message` when the text is empty and `You are not in a party` when you have none. Emits `onPartyChat`.

```text title="Example"
/p Pull the left pack first
```

In the client, typing `/party` or `/p` followed by a space puts the chat box into party mode, so every line you send after that goes to the party until you switch back with `/s`.

## Guild chat

```text title="Syntax"
/guild <message>
/g <message>
```

Sends the message to every online member of your guild as a `GUILD_CHAT` packet. It fails with `Please provide a message` or `You are not in a guild`. Emits `onGuildChat`.

```text title="Example"
/g Anyone up for the cellar quest?
```

## Whisper

```text title="Syntax"
/whisper <username> <message>
/w <username> <message>
```

Sends a private message to one online player. The target is matched by username, ignoring case. Both sides receive a `WHISPER` packet: the target sees it marked as coming from you, and you get a copy marked as sent to them.

| Problem | Answer |
|---------|--------|
| No username given | `Please provide a username` |
| Target is offline or does not exist | `Player not found or is not online` |

```text title="Example"
/w alice Meet me at the inn
```

## Party invite

```text title="Syntax"
/invite <username>
```

Sends a party invitation to an online player. The target gets a popup and answers it with an `INVITATION_RESPONSE` packet.

:::note The command does not emit onPartyInvite
The `onPartyInvite` event is emitted by the `INVITE_PARTY` packet, which the party interface sends. The `/invite` command sends the same invitation but does not emit the event.
:::

| Problem | Answer |
|---------|--------|
| No username given | `Usage: /invite <username>` |
| You named yourself | `You cannot invite yourself to a party.` |
| Target is offline | `Player <username> is not online.` |
| An invite from you is already pending | `You have already sent a party invite to <username>.` |

```text title="Example"
/invite alice
```

## Guild invite

```text title="Syntax"
/ginvite <username>
```

Invites an online player to your guild. Only the guild leader may use it.

| Problem | Answer |
|---------|--------|
| You are not in a guild | `You are not in a guild` |
| You are not the leader | `You are not the guild leader` |
| No username given | `Usage: /ginvite <username>` |
| You named yourself | `You cannot invite yourself to your guild.` |
| Target is offline | `Player <username> is not online.` |
| Target is a guest | `<username> is a guest and cannot join a guild.` |
| Target already has a guild | `<username> is already in a guild` |
| An invite from you is already pending | `You have already sent a guild invite to <username>.` |

```text title="Example"
/ginvite alice
```

## How the client sends a command

The client removes the leading `/`, encrypts the text with the chat key it was given at login when the browser supports it, and sends one packet:

```ts title="Gateway client: js/core/chat.ts"
sendRequest({
  type: "COMMAND",
  data: { command: encryptedMessage, mode: "decrypt" }
});
```

The server decrypts it with its RSA key, then parses it as described on the [Admin Commands](#/engine/admin-commands/how-commands-are-parsed) page. Without encryption support the client sends the plain text in `data.command` and leaves `mode` out.

:::note Everything else is a button
Creating a guild, leaving a party, adding friends, mounting and the rest of the social features are packets sent by the interface, not chat commands. They are listed on the [Packet Types](#/engine/packet-types) page.
:::
