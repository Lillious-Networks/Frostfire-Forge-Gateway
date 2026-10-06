---
title: Chat and Commands
description: Talk to players nearby, your party, your guild or one person, and every chat command you can use.
order: 40
---

Chat is how you meet people in the game. Press **Enter** to open the chat box, type your message, and press **Enter** again to send it. Press **Esc** to leave the chat box without sending.

:::note Guests cannot chat
Chat and commands need a full account. See [Getting Started](#/player-guide/getting-started) to create one.
:::

## Chat channels

| Channel | Who sees it | How to use it |
|---------|-------------|---------------|
| Say | Players on the same map as you | Just type and press Enter |
| Party | Everyone in your party, wherever they are | `/p` or `/party` |
| Guild | Every online member of your guild | `/g` or `/guild` |
| Whisper | One player | `/w` or `/whisper` followed by their name |

Say messages also appear in a speech bubble over your character. Each channel has its own colour in the chat box so you can tell them apart.

### Staying in a channel

You do not have to type the command every time. Type the command and press **Space**, and the chat box switches to that channel:

```text title="Switch to party chat"
/p
```

The chat box now shows **[Party] Type here...** and everything you send goes to your party until you switch again. The same works for `/g`, and for `/w` followed by a name. To go back to normal chat, type `/s` and press **Space**.

## Whispers

A whisper is a private message to one player. The player has to be online.

```text title="Whisper a player"
/w Aria Are you free for a quest?
```

In your chat box, whispers you send are marked with `->` and the other player's name. Whispers you receive are marked with `<-` and the sender's name.

:::tip
Right-click a player and choose **Send Message** to start a whisper without typing their name.
:::

## Commands

Commands start with a slash. These are the commands every player can use:

| Command | Short form | What it does | Example |
|---------|------------|--------------|---------|
| `/say` | `/s` | Switches the chat box back to normal say chat | `/s` |
| `/party <message>` | `/p` | Sends a message to your party | `/p Ready when you are` |
| `/guild <message>` | `/g` | Sends a message to your guild | `/g Good evening all` |
| `/whisper <player> <message>` | `/w` | Sends a private message to an online player | `/w Aria thank you!` |
| `/invite <player>` | none | Invites an online player to your party | `/invite Aria` |
| `/ginvite <player>` | none | Invites an online player to your guild. Guild Master only. | `/ginvite Aria` |

If you mistype a command, the game answers "Invalid command".

More about the invitations these send is on the [Parties](#/player-guide/parties) and [Guilds](#/player-guide/guilds) pages.

## Chat history

While the chat box is open, press the **Up** arrow to bring back the last message you sent, and keep pressing to go further back. **Down** moves forward again. This is handy for repeating a command.

## Chat limits

- A message can be at most 500 characters long. Shorter is safer: very long messages may not be sent.
- You can send up to 5 say messages within 3 seconds. Faster than that and you see "You are sending messages too fast."
- Party chat needs a party, and guild chat needs a guild. Otherwise you see "You are not in a party" or "You are not in a guild".

## Chat while dead

- After you die and before you release your spirit, say chat is switched off. Party, guild and whisper still work, so you can call for help.
- As a ghost you can type in say chat, but your words come out as ghostly gibberish. Party, guild and whisper messages still arrive normally.

See [death and respawn](#/player-guide/combat-and-spells/death-and-respawn) for what these states mean.
