import { sendRequest, getIsLoaded, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { toggleUI, toggleDebugContainer, handleStatsUI, collectablesUI, hotbarSlots, adminPanelContainer } from "./ui.js";
import { handleCommand, handleChatMessage } from "./chat.js";
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
let toggleAdminPanel = false;
let controllerConnected: boolean = false;
let contextMenuKeyTriggered = false;
let isKeyPressed = false;
let isMoving = false;
const pressedKeys = new Set();
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
let lastTypingPacket = 0;
const cooldowns: { [key: string]: number } = {};
const COOLDOWN_DURATION = 100;
const KEY_COOLDOWN_DURATION = 500;

export const keyHandlers = {
  F2: () => {
    toggleDebugContainer();
  },
  Escape: () => handleEscapeKey(),
  KeyB: () => {
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
  },

  KeyP: () => {
    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
    }

    if (toggleGuild) {
      toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    }

    if (toggleCollectables) {
      toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
    }

    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
  },
  KeyO: () => {
    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    }

    if (toggleGuild) {
      toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    }

    if (toggleCollectables) {
      toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -400);
    }

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
    putKeyOnCooldown("KeyZ");
    sendRequest({ type: "NOCLIP", data: null });
  },
  KeyK: () => {
    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
    }

    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    }

    if (toggleGuild) {
      toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    }

    toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
  },
  KeyG: () => {
    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
    }

    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    }

    if (toggleCollectables) {
      toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
    }

    toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
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
  },
  Insert: () => {
    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -450);
    }

    if (toggleGuild) {
      toggleGuild = toggleUI(guildContainer, toggleGuild, -450);
    }

    if (toggleCollectables) {
      toggleCollectables = toggleUI(collectablesUI, toggleCollectables, -450);
    }

    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -450);
    }

    if (toggleInventory) {
      toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
    }

    const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
    if (currentPlayer?.isAdmin) {
      toggleAdminPanel = toggleUI(adminPanelContainer, toggleAdminPanel, -480);

      if (toggleAdminPanel) {
        sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      }
    }
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

function cast(hotbar_index: number) {
    const keyName = `Digit${hotbar_index + 1}`;
    if (isKeyOnCooldown(keyName)) return;
    selectHotbarSlot(hotbar_index);
    putKeyOnCooldown(keyName);

    // Check for targeted player
    const targetPlayer = Array.from(cache?.players).find(p => p?.targeted) || null;

    let target = null;
    let isEntity = false;

    if (targetPlayer) {
      target = targetPlayer;
    } else if (cache.targetId) {
      // Entity target
      target = { id: cache.targetId };
      isEntity = true;
    }

    const slot = hotbarSlots[hotbar_index];
    const spellName = slot?.dataset?.spellName;
    if (!spellName) return;

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
        entity: isEntity
      }
    });
}

function mount() {
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

  // Check if currently casting a spell and cancel it instead of opening pause menu
  const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);

  if (currentPlayer && currentPlayer.castingSpell) {
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

  const isPauseMenuVisible = pauseMenu.style.display === "block";
  pauseMenu.style.display = isPauseMenuVisible ? "none" : "block";

  menuElements.forEach(elementId => {
    const element = document.getElementById(elementId);
    if (element?.style.display === "block") {
      element.style.display = "none";
    }
  });
}
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

  chatInput.blur();
  chatInput.value = "";

  if (chatInput.dataset.mode) {
    const _message = `/${chatInput.dataset.mode} ${message}`;
    await handleCommand(_message);
    return;
  }

  if (message.startsWith("/")) {
    await handleCommand(message);
  } else {
    await handleChatMessage(message);
  }
}

function handleKeyPress() {
  if (!getIsLoaded() || controllerConnected || pauseMenu.style.display === "block" || isMoving) return;
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

// Helper function to find player at canvas coordinates (copied from events.ts context menu logic)
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

    // Use same hitbox as context menu
    const clickedPlayer = Array.from(cache.players || []).find((player: any) => {
        const playerX = player.position.x;
        const playerY = player.position.y;

        return (
            worldX >= playerX - 16 && worldX <= playerX + 32 &&
            worldY >= playerY - 24 && worldY <= playerY + 48
        );
    });

    if (clickedPlayer) {
        return clickedPlayer;
    }

    return null;
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
    console.log("Initializing drag listeners...");
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

export {
    getIsKeyPressed, setIsKeyPressed, pressedKeys, movementKeys, handleKeyPress, stopMovement, setIsMoving, getIsMoving, getUserHasInteracted, setUserHasInteracted,
    getControllerConnected, setControllerConnected, getLastSentDirection, setLastSentDirection, getLastTypingPacket,
    setLastTypingPacket, cooldowns, COOLDOWN_DURATION, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys,
    cast, mount, setupDragListeners
};
