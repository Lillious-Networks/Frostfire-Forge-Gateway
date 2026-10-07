---
title: Chat and Commands
description: Talk to players nearby, your party, your guild or one person, and every chat command you can use.
order: 40
---

Chat is how you meet people in the game. Press **Enter** to open the chat box, type your message, and press **Enter** again to send it. Press **Esc** to leave the chat box without sending.

:::note Guests cannot chat
Chat and commands need a full account. See [Getting Started](#/player-guide/getting-started) to create one.
:::

## Chat on a phone or tablet

On a touch screen the chat box is hidden until you ask for it, so it stays out of the way of the joystick.

| What you see | What it does |
|--------------|--------------|
| The round chat button under your own frame | Tap it to open the chat. Tap it again to hide it. |
| A number on the button | How many messages came in while the chat was hidden |
| Messages beside the button | What was just said. They fade after a few seconds, and taps go through them to the game. |

With the chat open you can scroll back through what was said, and keep playing beside it.

To write a message, tap the field. The keyboard covers the bottom of the screen, so the field moves to the top by itself. The messages come back when you put the keyboard away.

- **Send**, or the keyboard's own send key, sends the message. The keyboard stays up for your next one.
- The **✕** beside Send puts the keyboard away. Sending an empty message does the same.

Channels, whispers and commands work exactly as described below.

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
| `/ignore <player>` | none | Stops you seeing anything a player says or sends you | `/ignore Grumble` |
| `/unignore <player>` | none | Lets you hear a player again | `/unignore Grumble` |
| `/ignorelist` | none | Shows who you are ignoring | `/ignorelist` |
| `/report <player> <reason>` | none | Tells the game's admins about a player | `/report Grumble keeps insulting people` |

If you mistype a command, the game answers "Invalid command".

More about the invitations these send is on the [Parties](#/player-guide/parties) and [Guilds](#/player-guide/guilds) pages.

## Ignoring a player

If someone is bothering you, ignore them. You stop seeing what they say, their whispers do not reach you, and neither do their invitations or friend requests. They are not told.

| Where | How |
|-------|-----|
| In the world | **Right-click** the player and choose **Ignore** |
| Chat | Type `/ignore` and their name. This also works when they are offline. |
| Friends list | **Right-click** a friend and choose **Ignore**. This ends the friendship too. |

The players you ignore are listed under **Ignored** in your friends list (press **O**). Click the **×** beside a name, or right-click it and choose **Stop Ignoring**, to hear them again. You can ignore up to 100 players. Admins cannot be ignored.

## Reporting a player

To tell the admins about a player, **right-click** them and choose **Report Player**. Pick a reason, add what happened if you like, and press **Send**. You can also type `/report`, their name and the reason.

The admins see what that player said to you or near you just before. The player is not told that you reported them.

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
