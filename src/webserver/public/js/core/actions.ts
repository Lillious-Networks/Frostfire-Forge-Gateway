import { cachedPlayerId, sendRequest, getIsLoaded } from './socket.js';
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { overlay } from './ui.js';
import playerEditor from './playereditor.js';
import { openReportDialog } from './report.js';
import { isTrading } from './trade.js';

const partyContextActions: Record<string, { only_self: boolean, allowed_self: boolean, label: string, handler: (username: string) => void }> = {
  'kick-player': {
    label: 'Kick',
    allowed_self: false,
    only_self: false,
    handler: (username) => {
      sendRequest({
        type: "KICK_PARTY_MEMBER",
        data: { username: username },
      });
    }
  },
  'leave-party': {
    label: 'Leave Party',
    allowed_self: true,
    only_self: true,
    handler: (username) => {
      sendRequest({
        type: "LEAVE_PARTY",
        data: { username: username },
      });
    }
  },
}

const guildContextActions: Record<string, { only_self: boolean, allowed_self: boolean, label: string, handler: (username: string) => void }> = {
  'kick-guild-member': {
    label: 'Kick',
    allowed_self: false,
    only_self: false,
    handler: (username) => {
      sendRequest({
        type: "KICK_GUILD_MEMBER",
        data: { username: username },
      });
    }
  },
  'leave-guild': {
    label: 'Leave Guild',
    allowed_self: true,
    only_self: true,
    handler: (username) => {
      sendRequest({
        type: "LEAVE_GUILD",
        data: null,
      });
    }
  },
}

const contextActions: Record<string, { allowed_self: boolean, admin_only?: boolean, label: string, handler: (id: string) => void }> = {
  'inspect-player': {
    label: 'Inspect',
    allowed_self: true,
    handler: (id) => {
      sendRequest({
        type: "INSPECTPLAYER",
        data: { id: id },
      });
    }
  },
  'send-message': {
    label: 'Send Message',
    allowed_self: false,
    handler: (id) => {

      const chatInput = document.getElementById("chat-input") as HTMLInputElement;
      const username = Array.from(cache.players).find(player => player.id === id)?.username;
      if (!username) return;
      chatInput.value = `/w ${username} `;
      chatInput.focus();
    }
  },
  'invite-to-party': {
    label: 'Invite to Party',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "INVITE_PARTY",
        data: { id: id },
      });
    }
  },
  // Asks them to trade: the window opens for both once they accept.
  'trade-player': {
    label: 'Trade',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "TRADE_REQUEST",
        data: { id: id },
      });
    }
  },
  'add-friend': {
    label: 'Add Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "ADD_FRIEND",
        data: { id: id },
      });
    }
  },
  'remove-friend': {
    label: 'Remove Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "REMOVE_FRIEND",
        data: { id: id },
      });
    }
  },
  'invite-to-guild': {
    label: 'Invite to Guild',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "INVITE_GUILD",
        data: { id: id },
      });
    }
  },
  // The server keeps the list and holds back what an ignored player says: neither side is told.
  'ignore-player': {
    label: 'Ignore',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "IGNORE_PLAYER",
        data: { id: id },
      });
    }
  },
  'unignore-player': {
    label: 'Stop Ignoring',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "UNIGNORE_PLAYER",
        data: { id: id },
      });
    }
  },
  'report-player': {
    label: 'Report Player',
    allowed_self: false,
    handler: (id) => {
      const username = Array.from(cache.players).find(player => player.id === id)?.username;
      if (username) openReportDialog(username);
    }
  },
  'edit-player': {
    label: 'Edit Player Attributes',
    allowed_self: true,
    // Hidden from everyone else; the server checks permission on every editor packet regardless.
    admin_only: true,
    handler: (id) => {
      const username = Array.from(cache.players).find(player => player.id === id)?.username;
      playerEditor.open(username || id);
    }
  },
};

/**
 * Puts a menu where it was asked for (px on the screen), moved as far as it takes to be whole on the screen. It
 * opens to the right of and below the point, and on the other side of it where there is no room. Measured once it
 * is on the page, because its entries decide its size: each menu used to guess one (200 by 150), and the menu on a
 * player has grown to nine entries, taller than that on any phone. USER REPORT 2026-10-07: "the right click menu on
 * mobile is going off the screen in some cases".
 */
function placeMenu(menu: HTMLElement, x: number, y: number): void {
  const width = window.visualViewport?.width || window.innerWidth, height = window.visualViewport?.height || window.innerHeight;
  const margin = 8;
  // (more entries than a small screen is tall: the menu scrolls)
  menu.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
  menu.style.overflowY = "auto";
  const box = menu.getBoundingClientRect();
  const left = x + box.width + margin > width ? x - box.width : x;
  const top = y + box.height + margin > height ? y - box.height : y;
  menu.style.left = `${Math.round(Math.max(margin, Math.min(left, width - box.width - margin)))}px`;
  menu.style.top = `${Math.round(Math.max(margin, Math.min(top, height - box.height - margin)))}px`;
}

function createPartyContextMenu(event: MouseEvent, username: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';

  contextMenu.dataset.username = username.toLowerCase();
  const ul = document.createElement("ul");
  const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
  const isSelf = currentPlayer?.username.toLowerCase() === username.toLowerCase();
  Object.entries(partyContextActions).forEach(([action, { label, handler, only_self, allowed_self }]) => {
    if (only_self && !isSelf) return;
    if (!allowed_self && isSelf) return;

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(username);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  placeMenu(contextMenu, event.clientX, event.clientY);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

function createGuildContextMenu(event: MouseEvent, username: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';

  contextMenu.dataset.username = username.toLowerCase();
  const ul = document.createElement("ul");
  const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
  const isSelf = currentPlayer?.username.toLowerCase() === username.toLowerCase();

  const isLeader = currentPlayer?.guild?.length > 0
    && currentPlayer?.guild?.[0]?.toLowerCase() === currentPlayer?.username?.toLowerCase();

  if (isLeader && isSelf) return;

  Object.entries(guildContextActions).forEach(([action, { label, handler, only_self, allowed_self }]) => {
    if (only_self && !isSelf) return;
    if (!allowed_self && isSelf) return;

    if (action === 'kick-guild-member' && !isLeader) return;

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(username);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  placeMenu(contextMenu, event.clientX, event.clientY);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

function createContextMenu(event: MouseEvent, id: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';

  contextMenu.dataset.id = id;

  const ul = document.createElement("ul");
  const isSelf = id === cachedPlayerId;
  const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
  const targetedPlayer = Array.from(cache.players).find(player => player.id === id);
  const isFriend = currentPlayer?.friends?.includes(targetedPlayer?.username?.toString()) || false;
  const isInParty = currentPlayer?.party?.includes(targetedPlayer?.username?.toString()) || false;
  const isInGuild = currentPlayer?.guild?.includes(targetedPlayer?.username?.toString()) || false;
  const isIgnored = cache.ignored.has(String(targetedPlayer?.username ?? "").toLowerCase());

  Object.entries(contextActions).forEach(([action, { label, handler, allowed_self, admin_only }]) => {
    if (!allowed_self && isSelf) return;

    if (admin_only && !currentPlayer?.isAdmin) return;

    if (action === 'invite-to-party' && isInParty) return;

    if (action === 'invite-to-guild' && isInGuild) return;

    // One trade at a time: not offered while the window is open.
    if (action === 'trade-player' && isTrading()) return;

    if (action === 'add-friend' && isFriend) return;

    if (action === 'remove-friend' && !isFriend) return;

    // Admins ignore nobody and are ignored by nobody: the server refuses both, so neither is offered.
    if (action === 'ignore-player' && (isIgnored || currentPlayer?.isAdmin || targetedPlayer?.isAdmin)) return;

    if (action === 'unignore-player' && !isIgnored) return;

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(id);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  placeMenu(contextMenu, event.clientX, event.clientY);

  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

function createFriendContextMenu(event: MouseEvent, username: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';

  contextMenu.dataset.username = username.toLowerCase();
  const ul = document.createElement("ul");

  const li = document.createElement("li");
  li.innerText = "Remove Friend";
  li.onclick = (e) => {
    e.stopPropagation();
    sendRequest({
      type: "REMOVE_FRIEND",
      data: { username },
    });
    contextMenu.remove();
  };
  ul.appendChild(li);

  // Ignoring a friend ends the friendship on both sides: the server does both.
  const ignore = document.createElement("li");
  ignore.innerText = "Ignore";
  ignore.onclick = (e) => {
    e.stopPropagation();
    sendRequest({
      type: "IGNORE_PLAYER",
      data: { username },
    });
    contextMenu.remove();
  };
  ul.appendChild(ignore);

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  placeMenu(contextMenu, event.clientX, event.clientY);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

/** The menu on a name in the list of who is ignored. */
function createIgnoredContextMenu(event: MouseEvent, username: string) {
  if (!getIsLoaded()) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';
  contextMenu.dataset.username = username.toLowerCase();

  const ul = document.createElement("ul");
  const li = document.createElement("li");
  li.innerText = "Stop Ignoring";
  li.onclick = (e) => {
    e.stopPropagation();
    sendRequest({
      type: "UNIGNORE_PLAYER",
      data: { username },
    });
    contextMenu.remove();
  };
  ul.appendChild(li);

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  placeMenu(contextMenu, event.clientX, event.clientY);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

export { partyContextActions, guildContextActions, contextActions, createPartyContextMenu, createGuildContextMenu, createFriendContextMenu, createIgnoredContextMenu, createContextMenu };