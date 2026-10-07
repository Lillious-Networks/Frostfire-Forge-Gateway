import { sendRequest, getIsLoaded, cachedPlayerId } from "./socket.js";
import { isSelfDead, isSelfActionLocked } from "./death.js";
import Cache from "./cache.js";
import { parseCreatureTarget } from "./creature.js";
import { playerAt } from "./playerpick.js";
import { toggleWorldMap, isWorldMapOpen, closeWorldMap } from "./worldmap.js";
const cache = Cache.getInstance();
import { toggleUI, toggleDebugContainer, handleStatsUI, createGuildUI, collectablesUI, hotbarSlots, spellCooldowns, refreshSpellbookCooldowns, questLogUI, questFrameUI } from "./ui.js";
import { handleCommand, handleChatMessage } from "./chat.js";
import { itemOfSlot, useItem } from "./consumables.js";
import { setDirection, setPendingRequest, getCameraX, getCameraY } from "./renderer.js";
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
import { inventoryUI, spellBookUI, friendsListUI, pauseMenu, menuElements, guildContainer } from "./ui.js";
let userHasInteracted: boolean = false;
let lastSentDirection = "";

let toggleInventory = false;
let toggleSpellBook = false;
let toggleFriendsList = false;
let toggleCollectables = false;
let toggleGuild = false;
let controllerConnected: boolean = false;
let contextMenuKeyTriggered = false;
let isKeyPressed = false;
let isMoving = false;
const pressedKeys = new Set();
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
let lastTypingPacket = 0;
const messageHistory: string[] = [];
let historyIndex = -1;
const cooldowns: { [key: string]: number } = {};
const COOLDOWN_DURATION = 100;
const KEY_COOLDOWN_DURATION = 500;

function closeOtherPanels(_except: string) {
  if (_except !== "inventory" && toggleInventory) {
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
  }
  if (_except !== "spellbook" && toggleSpellBook) {
    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
  }
  if (_except !== "friends" && toggleFriendsList) {
    toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
  }
  if (_except !== "collectables" && toggleCollectables) {
    toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
  }
  if (_except !== "guild" && toggleGuild) {
    toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
  }
  if (_except !== "questlog" && questLogUI && questLogUI.style.display === "block") {
    questLogUI.style.display = "none";
    questLogUI.classList.remove("open");
  }
  if (_except !== "questframe" && questFrameUI && (questFrameUI.style.display === "block" || questFrameUI.style.display === "flex")) {
    import("./questframe.js").then((m) => m.closeQuestFrame());
  }
}

/** Opens the bags if they are closed: a trade is made from them. */
function openInventory() {
  if (toggleInventory) return;
  closeOtherPanels("inventory");
  toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
}

export const keyHandlers = {
  F2: () => {
    toggleDebugContainer();
  },
  Escape: () => handleEscapeKey(),
  KeyB: () => {
    closeOtherPanels("inventory");
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
  },

  KeyP: () => {
    closeOtherPanels("spellbook");
    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    if (toggleSpellBook) refreshSpellbookCooldowns();
  },
  KeyO: () => {
    closeOtherPanels("friends");
    toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
  },
  KeyC: () => handleStatsUI(),
  KeyX: () => {
    if (isKeyOnCooldown("KeyX")) return;
    putKeyOnCooldown("KeyX");
    sendRequest({ type: "STEALTH", data: null });
  },
  KeyZ: () => {
    if (isKeyOnCooldown("KeyZ")) return;
    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive) {
      putKeyOnCooldown("KeyZ");
      tileEditor.rotateSelectedTile();
      return;
    }
    putKeyOnCooldown("KeyZ");
    sendRequest({ type: "NOCLIP", data: null });
  },
  KeyK: () => {
    closeOtherPanels("collectables");
    toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
  },
  KeyL: () => {
    closeOtherPanels("questlog");
    import("./questlog.js").then((m) => m.toggleQuestLog());
  },
  // the full world map (worldmap.ts): the whole map from its baked image
  KeyM: () => {
    toggleWorldMap();
  },
  KeyG: () => {
    closeOtherPanels("guild");
    toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    if (toggleGuild) {
      const cache = Cache.getInstance();
      const currentPlayer = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
      createGuildUI(currentPlayer?.guild || [], currentPlayer?.guild_name || null);
    }
  },
  KeyQ: () => {
    mount();
  },
  Digit1: async () => {
    cast(0);
  },
  Digit2: async () => {
    cast(1);
  },
  Digit3: async () => {
    cast(2);
  },
  Digit4: async () => {
    cast(3);
  },
  Digit5: async () => {
    cast(4);
  },
  Digit6: async () => {
    cast(5);
  },
  Digit7: async () => {
    cast(6);
  },
  Digit8: async () => {
    cast(7);
  },
  Digit9: async () => {
    cast(8);
  },
  Digit0: async () => {
    cast(9);
  },
  Enter: () => {
    if (isKeyOnCooldown("Enter")) return;
    putKeyOnCooldown("Enter");
    handleEnterKey();
  }
} as const;

const blacklistedKeys = new Set([
  'ContextMenu',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftRight',
  'F1',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'Tab',
]);

/** Walking by keyboard, or holding a direction on the joystick / gamepad. */
function isLocallyMoving(): boolean {
  return isMoving || (lastSentDirection !== "" && lastSentDirection !== "ABORT");
}

function cast(hotbar_index: number) {
    if (isSelfActionLocked()) return;
    const keyName = `Digit${hotbar_index + 1}`;
    if (isKeyOnCooldown(keyName)) return;
    // A slot that holds a consumable uses it: no spell is cast.
    const slotItem = itemOfSlot(hotbarSlots[hotbar_index]);
    if (slotItem) {
      selectHotbarSlot(hotbar_index);
      putKeyOnCooldown(keyName);
      useItem(slotItem);
      return;
    }
    if (Date.now() < cache.spellLockoutUntil) return;
    // A spell that needs you to stand still does nothing while moving: no
    // cast bar, no "interrupted", nothing sent (the server ignores it too).
    const pressedSpell = cache.spells[hotbarSlots[hotbar_index]?.dataset?.spellName || ""];
    if (pressedSpell && !pressedSpell.can_move && !pressedSpell.ground_aoe && isLocallyMoving()) return;
    selectHotbarSlot(hotbar_index);
    putKeyOnCooldown(keyName);

    // Check for targeted player
    const targetPlayer = Array.from(cache?.players).find(p => p?.targeted) || null;

    let target = null;
    let isCreature = false;
    const creatureTargetId = parseCreatureTarget(cache.targetId);

    if (targetPlayer) {
      target = targetPlayer;
    } else if (creatureTargetId !== null) {
      target = { id: creatureTargetId };
      isCreature = true;
    }

    const slot = hotbarSlots[hotbar_index];
    const spellName = slot?.dataset?.spellName;
    if (!spellName) return;

    const spellData = cache.spells[spellName];
    if (spellData && spellData.ground_aoe) {
      if (spellCooldowns.has(spellName) && performance.now() < spellCooldowns.get(spellName)!.end) {
        return;
      }
      cache.groundTargetingSpell = spellName;
      document.body.style.cursor = 'crosshair';
      return;
    }

    // Optimistically set casting state on client before server response
    const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
    if (currentPlayer) {
      const formattedSpellName = spellName.split('_').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(' ');
      currentPlayer.castingSpell = formattedSpellName;
      currentPlayer.castingStartTime = performance.now();
      currentPlayer.castingDuration = 2000; // Default, will be updated by server
      currentPlayer.castingInterrupted = false;
    }

    sendRequest({
      type: "HOTBAR",
      data: {
        spell: spellName,
        target,
        creature: isCreature
      }
    });
}

function mount() {
    if (isSelfActionLocked()) return;
    if (isKeyOnCooldown("Mount")) return;
    putKeyOnCooldown("Mount");
    sendRequest({ type: "MOUNT", data: { mount: cache.mount || "unicorn" } });
}

function selectHotbarSlot(index: number) {
  const slot = hotbarSlots[index];
  slot.classList.add("selected");
  setTimeout(() => {
    slot.classList.remove("selected");
  }, 250);
}

function putKeyOnCooldown(key: string) {
  cooldowns[key] = Date.now() + KEY_COOLDOWN_DURATION;
  setTimeout(() => {
    clearKeyCooldown(key);
  }, KEY_COOLDOWN_DURATION);
}

function isKeyOnCooldown(key: string): boolean {
  return !!(cooldowns[key] && Date.now() < cooldowns[key]);
}

function clearKeyCooldown(key: string) {
  delete cooldowns[key];
}

function handleEscapeKey() {
  stopMovement();
  chatInput.blur();

  if (isWorldMapOpen()) {
    closeWorldMap();
    return;
  }

  if (cache.groundTargetingSpell) {
    cache.groundTargetingSpell = null;
    document.body.style.cursor = '';
    return;
  }

  // Check if currently casting a spell and cancel it instead of opening pause menu
  const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);

  if (currentPlayer && currentPlayer.castingSpell && !currentPlayer.castingInterrupted && currentPlayer.castingDuration > 0) {
    // Cancel the spell cast
    currentPlayer.castingSpell = null;
    currentPlayer.castingInterrupted = true;
    currentPlayer.castingInterruptedProgress = currentPlayer.castingDuration
      ? (performance.now() - currentPlayer.castingStartTime) / currentPlayer.castingDuration
      : 0;

    // Clear all spell key cooldowns so player can immediately recast
    for (let i = 1; i <= 10; i++) {
      clearKeyCooldown(`Digit${i}`);
    }

    // Notify server to cancel the spell
    sendRequest({
      type: "CANCEL_SPELL",
      data: null
    });

    return; // Don't open pause menu
  }

  // Windows that are open close, and that is all this press does: the menu opens on the next one. With the menu
  // itself open, the press closes the menu (below).
  if (pauseMenu.style.display !== "block" && closeOpenWindows()) return;

  const isPauseMenuVisible = pauseMenu.style.display === "block";
  pauseMenu.style.display = isPauseMenuVisible ? "none" : "block";

  menuElements.forEach(elementId => {
    const element = document.getElementById(elementId);
    if (element?.style.display === "block") {
      element.style.display = "none";
    }
  });
}
function recordSentMessage(message: string) {
  if (!message) return;
  if (messageHistory[messageHistory.length - 1] !== message) {
    messageHistory.push(message);
  }
  historyIndex = messageHistory.length;
}

chatInput.addEventListener("input", () => {
  historyIndex = messageHistory.length;
});

chatInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (messageHistory.length === 0) return;

  const atHistoryEnd = historyIndex >= messageHistory.length;

  if (event.key === "ArrowUp") {
    // Don't overwrite text the user has typed that isn't from history
    if (atHistoryEnd && chatInput.value.trim() !== "") return;
    event.preventDefault();
    if (historyIndex > 0) historyIndex--;
    chatInput.value = messageHistory[historyIndex];
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  } else {
    // ArrowDown
    if (atHistoryEnd) {
      // Only clear if the field is showing a history message, not user-typed text
      return;
    }
    event.preventDefault();
    if (historyIndex < messageHistory.length - 1) {
      historyIndex++;
      chatInput.value = messageHistory[historyIndex];
    } else {
      // One more down past the last message clears the input
      historyIndex = messageHistory.length;
      chatInput.value = "";
    }
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  }
});

addEventListener("keypress", (event: KeyboardEvent) => {

  if (chatInput === document.activeElement) {
    const inputValue = chatInput.value.trim();

    switch (true) {
      case inputValue === "/party" || inputValue === "/p":

        if (event.key === " ") {
          event.preventDefault();
          chatInput.value = "";
          chatInput.dataset.mode = "party";
          chatInput.style.color = "#86b3ff";

          chatInput.placeholder = "[Party] Type here...";

          chatInput.style.setProperty('--chat-placeholder-color', '#86b3ff');
        }
        break;
      case inputValue === "/guild" || inputValue === "/g":

        if (event.key === " ") {
          event.preventDefault();
          chatInput.value = "";
          chatInput.dataset.mode = "guild";
          chatInput.style.color = "#a855f7";

          chatInput.placeholder = "[Guild] Type here...";

          chatInput.style.setProperty('--chat-placeholder-color', '#a855f7');
        }
        break;
      case inputValue === "/say" || inputValue === "/s":

        if (event.key === " ") {
          event.preventDefault();
          chatInput.value = "";

          delete chatInput.dataset.mode;
          chatInput.style.color = "#FFF1DA";

          chatInput.placeholder = "Type here...";

          chatInput.style.setProperty('--chat-placeholder-color', '#FFF1DA');
        }
        break;
      case inputValue.startsWith("/whisper ") || inputValue.startsWith("/w "):

        if (event.key === " " && inputValue.split(" ").length >= 2) {
          event.preventDefault();
          const name = inputValue.split(" ")[1];
          chatInput.value = "";
          chatInput.dataset.mode = `whisper ${name}`;
          chatInput.style.color = "#ff59f8";

          chatInput.placeholder = `[${name}] Type here...`;
          chatInput.style.setProperty('--chat-placeholder-color', '#ff59f8');
        }
        break;
      default:
        break;
    }
  }
});

async function handleEnterKey() {

  if (friendsListSearch === document.activeElement) return;
  const isTyping = chatInput === document.activeElement;

  if (!isTyping) {
    chatInput.focus();
    return;
  }

  sendRequest({ type: "STOPTYPING", data: null });

  const message = chatInput.value.trim();
  if (!message) {
    chatInput.value = "";
    chatInput.blur();
    return;
  }

  // On a touch screen the field keeps the keyboard for the next message (mobilechat.ts): bringing it up again for
  // each one is slow there. It is put away by the X beside the field, or by sending nothing (above).
  if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) chatInput.blur();
  chatInput.value = "";

  if (chatInput.dataset.mode) {
    const _message = `/${chatInput.dataset.mode} ${message}`;
    recordSentMessage(_message);
    await handleCommand(_message);
    return;
  }

  recordSentMessage(message);
  if (message.startsWith("/")) {
    await handleCommand(message);
  } else {
    await handleChatMessage(message);
  }
}

function handleKeyPress() {
  if (!getIsLoaded() || controllerConnected || pauseMenu.style.display === "block" || isMoving) return;
  if (isSelfDead()) return;
  isMoving = true;
  setDirection("");
  setPendingRequest(false);
}

function stopMovement() {

  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });

  pressedKeys.clear();
  isKeyPressed = false;
  isMoving = false;
}

function setIsMoving(value: boolean) {
  isMoving = value;
}

function getIsMoving() {
  return isMoving;
}

function getUserHasInteracted() {
    return userHasInteracted;
}

function setUserHasInteracted(value: boolean) {
    userHasInteracted = value;
}

function getControllerConnected() {
    return controllerConnected;
}

function setControllerConnected(value: boolean) {
    controllerConnected = value;
}

function getLastSentDirection() {
    return lastSentDirection;
}

function setLastSentDirection(value: string) {
    lastSentDirection = value;
}

function getLastTypingPacket() {
    return lastTypingPacket;
}

function setLastTypingPacket(value: number) {
    lastTypingPacket = value;
}

function getContextMenuKeyTriggered() {
    return contextMenuKeyTriggered;
}

function setContextMenuKeyTriggered(value: boolean) {
    contextMenuKeyTriggered = value;
}

function getIsKeyPressed() {
    return isKeyPressed;
}

function setIsKeyPressed(value: boolean) {
    isKeyPressed = value;
}

// Drag player functionality
let isDragging = false;
let draggedPlayerId: number | null = null;
let lastDragUpdateTime = 0;
const DRAG_UPDATE_THROTTLE = 50; // ms between drag updates

// Helper function to get canvas - lazy load to ensure it exists
function getCanvas(): HTMLCanvasElement | null {
    if (!canvas) {
        canvas = document.getElementById("game") as HTMLCanvasElement;
    }
    return canvas;
}

let canvas: HTMLCanvasElement | null = null;

// Helper function to find player at canvas coordinates
function getPlayerAtCanvasPosition(clientX: number, clientY: number): any | null {
    // Get canvas bounding rect to convert screen coords to canvas coords
    const gameCanvas = getCanvas();
    if (!gameCanvas) return null;

    const rect = gameCanvas.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;

    // Use same coordinate system as context menu
    const worldX = screenX - window.innerWidth / 2 + getCameraX();
    const worldY = screenY - window.innerHeight / 2 + getCameraY();

    // Same pick as the context menu: the player drawn on top
    return playerAt(worldX, worldY);
}

// Setup drag event listeners
function setupDragListeners() {
    const gameCanvas = getCanvas();
    if (!gameCanvas) {
        setTimeout(setupDragListeners, 500);
        return;
    }

    gameCanvas.addEventListener('mousedown', (event: MouseEvent) => {
        // Check if admin is holding Ctrl or Shift and left-clicking
        if ((event.ctrlKey || event.shiftKey) && event.button === 0) {
            const player = getPlayerAtCanvasPosition(event.clientX, event.clientY);

            if (player) {
                const currentPlayer = Array.from(cache.players || []).find(p => p.id === cachedPlayerId);

                // Only allow admins to drag OTHER players (not themselves)
                if (currentPlayer && currentPlayer.isAdmin && player.id !== cachedPlayerId) {
                    isDragging = true;
                    draggedPlayerId = player.id;

                    // Send DRAG_PLAYER_START packet
                    sendRequest({
                        type: "DRAG_PLAYER_START",
                        data: { id: draggedPlayerId }
                    });

                    event.preventDefault();
                }
            }
        }
    });

    document.addEventListener('mousemove', (event: MouseEvent) => {
        if (isDragging && draggedPlayerId !== null) {
            // Throttle drag updates to avoid overwhelming the server
            const now = performance.now();
            if (now - lastDragUpdateTime < DRAG_UPDATE_THROTTLE) {
                return;
            }
            lastDragUpdateTime = now;

            // Send position update using same coordinate system as context menu
            const gameCanvas = getCanvas();
            if (!gameCanvas) return;

            const rect = gameCanvas.getBoundingClientRect();
            const screenX = event.clientX - rect.left;
            const screenY = event.clientY - rect.top;

            // Use same coordinate system as context menu for consistency
            const worldX = screenX - window.innerWidth / 2 + getCameraX();
            const worldY = screenY - window.innerHeight / 2 + getCameraY();

            sendRequest({
                type: "DRAG_UPDATE",
                data: {
                    id: draggedPlayerId,
                    x: Math.round(worldX),
                    y: Math.round(worldY)
                }
            });
        }
    });

    document.addEventListener('mouseup', (event: MouseEvent) => {
        if (isDragging && draggedPlayerId !== null) {
            // Send DRAG_PLAYER_STOP packet
            sendRequest({
                type: "DRAG_PLAYER_STOP",
                data: { id: draggedPlayerId }
            });

            isDragging = false;
            draggedPlayerId = null;
        }
    });

    // Also listen for window mouseleave in case user leaves the window while dragging
    window.addEventListener('mouseleave', (event: MouseEvent) => {
        if (isDragging && draggedPlayerId !== null) {
            sendRequest({
                type: "DRAG_PLAYER_STOP",
                data: { id: draggedPlayerId }
            });

            isDragging = false;
            draggedPlayerId = null;
        }
    });
}

// Initialize drag listeners when page is ready
function initializeDragListeners() {
    setupDragListeners();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDragListeners);
} else {
    // Give DOM a tick to ensure everything is loaded
    requestAnimationFrame(initializeDragListeners);
}

// Also try to initialize after a short delay to ensure all modules are loaded
setTimeout(initializeDragListeners, 100);

// Make setupDragListeners globally available for debugging
(window as any).setupDragListeners = setupDragListeners;
(window as any).initializeDragListeners = initializeDragListeners;

/** Closes every panel that is open. Whether any was. */
function closeAllPanels(): boolean {
  let closed = false;
  if (toggleInventory) {
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
    closed = true;
  }
  if (toggleSpellBook) {
    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    closed = true;
  }
  if (toggleFriendsList) {
    toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
    closed = true;
  }
  if (toggleCollectables) {
    toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
    closed = true;
  }
  if (toggleGuild) {
    toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    closed = true;
  }
  if (questLogUI && questLogUI.style.display === "block") {
    questLogUI.style.display = "none";
    questLogUI.classList.remove("open");
    closed = true;
  }
  if (questFrameUI && (questFrameUI.style.display === "block" || questFrameUI.style.display === "flex")) {
    import("./questframe.js").then((m) => m.closeQuestFrame());
    closed = true;
  }
  return closed;
}

/** The character sheet, which opens on the left and is not one of the panels above. */
const statScreen = () => document.getElementById("stat-screen");

/**
 * Closes every window the player has open: the panels, and the character sheet. Whether any was.
 * USER REQUEST 2026-10-06: "Allow esc to close any UI open like character sheet, spell book etc".
 */
function closeOpenWindows(): boolean {
  let closed = closeAllPanels();
  if (statScreen()?.style.display === "block") {
    // (open, so this closes it and stops its preview)
    handleStatsUI();
    closed = true;
  }
  return closed;
}

// An X on each window, at its top right corner, that closes it. Each closes its window the way its key does, so
// what the game knows of which windows are open stays right. USER REQUEST 2026-10-06: "add an X on these UIs to
// close them manually". (The character sheet has its own, in the page.)
const CLOSABLE: Array<[element: HTMLElement | null, close: () => void]> = [
  [inventoryUI, () => { if (toggleInventory) toggleInventory = toggleUI(inventoryUI, toggleInventory, -350); }],
  [spellBookUI, () => { if (toggleSpellBook) toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450); }],
  [friendsListUI, () => { if (toggleFriendsList) toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450); }],
  [collectablesUI, () => { if (toggleCollectables) toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450); }],
  [guildContainer, () => { if (toggleGuild) toggleGuild = toggleUI(guildContainer, toggleGuild, -450); }],
  [questLogUI, () => { questLogUI.style.display = "none"; questLogUI.classList.remove("open"); }],
  [questFrameUI, () => { import("./questframe.js").then((m) => m.closeQuestFrame()); }],
];
for (const [element, close] of CLOSABLE) {
  if (!element || element.querySelector(":scope > .panel-close")) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "panel-close ui";
  button.setAttribute("aria-label", "Close");
  button.textContent = "✕";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
  });
  // A press on it is not the start of dragging the window, nor a click on the world behind.
  for (const type of ["mousedown", "touchstart"]) button.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
  element.appendChild(button);
}

export {
    getIsKeyPressed, setIsKeyPressed, pressedKeys, movementKeys, handleKeyPress, stopMovement, setIsMoving, getIsMoving, getUserHasInteracted, setUserHasInteracted,
    getControllerConnected, setControllerConnected, getLastSentDirection, setLastSentDirection, getLastTypingPacket,
    setLastTypingPacket, cooldowns, COOLDOWN_DURATION, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys,
    cast, mount, setupDragListeners, closeAllPanels, openInventory
};
