import { sendRequest, getIsLoaded, getMovementAllowed, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { getCameraX, getCameraY } from "./renderer.js";
import { chatInput, pauseMenu, optionsMenu, fpsSlider, musicSlider, effectsSlider, mutedCheckbox, canvas, ctx, friendsList } from "./ui.js";
import { getUserHasInteracted, setUserHasInteracted, setControllerConnected, getLastSentDirection, setLastSentDirection,
    getLastTypingPacket, setLastTypingPacket, getContextMenuKeyTriggered, setContextMenuKeyTriggered, blacklistedKeys, movementKeys,
    pressedKeys,
    setIsKeyPressed,
    getIsKeyPressed,
    getIsMoving,
    handleKeyPress,
    keyHandlers,
    COOLDOWN_DURATION,
    cooldowns,
    stopMovement,
    setIsMoving,
    closeAllPanels} from "./input.js";
import { friendsListSearch } from "./friends.js";
import { createContextMenu, createPartyContextMenu, createGuildContextMenu, createFriendContextMenu } from "./actions.js";
import { closeRadialMenu } from "./mobileui.js";
let typingTimer: number | null = null;

const getActualViewportHeight = () => {
  if (window.visualViewport) {
    return window.visualViewport.height;
  }
  return window.innerHeight;
};

document.documentElement.style.setProperty('--viewport-height', `${getActualViewportHeight()}px`);

const userInteractionListener = () => {
  if (!getUserHasInteracted()) {
    setUserHasInteracted(true);
    document.removeEventListener("mousedown", userInteractionListener);
    document.removeEventListener("keydown", userInteractionListener);
    document.removeEventListener("touchstart", userInteractionListener);
  }
};

document.addEventListener("mousedown", userInteractionListener);
document.addEventListener("keydown", userInteractionListener);
document.addEventListener("touchstart", userInteractionListener);
window.addEventListener("gamepadconnected", () => {
  setControllerConnected(true);
});
window.addEventListener("gamepaddisconnected", () => {
  setControllerConnected(false);
});

window.addEventListener("gamepadjoystick", (e: CustomEventInit) => {
  if (!getIsLoaded() || !getMovementAllowed()) return;
  if (pauseMenu.style.display == "block") return;

  const x = e.detail.x;
  const y = e.detail.y;

  const deadzone = 0.5;
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) {
    if (getLastSentDirection() !== "ABORT") {
      sendRequest({
        type: "MOVEXY",
            data: "ABORT",
      });
      setLastSentDirection("ABORT");
    }
    return;
  }

  const angle = Math.atan2(y, x) * (180 / Math.PI);

  let direction = "";
  if (angle >= -22.5 && angle < 22.5) {
    direction = "RIGHT";
  } else if (angle >= 22.5 && angle < 67.5) {
    direction = "DOWNRIGHT";
  } else if (angle >= 67.5 && angle < 112.5) {
    direction = "DOWN";
  } else if (angle >= 112.5 && angle < 157.5) {
    direction = "DOWNLEFT";
  } else if (angle >= 157.5 || angle < -157.5) {
    direction = "LEFT";
  } else if (angle >= -157.5 && angle < -112.5) {
    direction = "UPLEFT";
  } else if (angle >= -112.5 && angle < -67.5) {
    direction = "UP";
  } else if (angle >= -67.5 && angle < -22.5) {
    direction = "UPRIGHT";
  }

  if (direction && direction !== getLastSentDirection()) {
    if (pauseMenu.style.display == "block") return;
    sendRequest({
      type: "MOVEXY",
          data: direction,
    });
    setLastSentDirection(direction);
  }
});

chatInput.addEventListener("input", () => {

  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  if (getLastTypingPacket() + 1000 < performance.now()) {
    sendRequest({
      type: "TYPING",
      data: null,
    });
    setLastTypingPacket(performance.now());
  }

  typingTimer = window.setTimeout(() => {
    if (chatInput.value.length > 0) {
      sendRequest({
        type: "TYPING",
        data: null,
      });
      setLastTypingPacket(performance.now());
    }
  }, 1000);
});

window.addEventListener("keydown", async (e) => {
  // Handle Ctrl+S globally to prevent player movement and spam
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    e.stopPropagation();

    // Only trigger save if tile editor is active
    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive) {
      // Delegate to tile editor's save method which properly handles all data
      tileEditor.saveMap();
    }
    return;
  }

  if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
    setContextMenuKeyTriggered(true);
  }

  if (blacklistedKeys.has(e.code)) {

    if (e.code === "Tab" && !getContextMenuKeyTriggered()) {
      const target = Array.from(cache.players).find(player => player.targeted);
      if (target) {
        target.targeted = false;
      }

      sendRequest({ type: "TARGETCLOSEST", data: null });
      e.preventDefault();
      return;
    }

    e.preventDefault();
    return;
  }
  if (!getIsLoaded() || (pauseMenu.style.display === "block" && e.code !== "Escape")) return;

  const activeElement = document.activeElement;
  const isTypingInInput = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    (activeElement as HTMLElement).contentEditable === 'true'
  );
  if (isTypingInInput && !["Enter", "Escape"].includes(e.code)) return;

  if (movementKeys.has(e.code)) {
    pressedKeys.add(e.code);
    if (!getIsKeyPressed()) {
      setIsKeyPressed(true);
      if (!getIsMoving()) {
        handleKeyPress();
      }
    }
  }

  const now = Date.now();
  const handler = keyHandlers[e.code as keyof typeof keyHandlers];
  if (!handler) return;

  if (cooldowns[e.code] && now - cooldowns[e.code] < COOLDOWN_DURATION) return;

  cooldowns[e.code] = now;

  try {
    await handler();
    closeRadialMenu();
  } catch (err) {
    console.error(`Error handling key ${e.code}:`, err);
  }
});

window.addEventListener("keyup", (e) => {

  const activeElement = document.activeElement;
  const isTypingInInput = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    (activeElement as HTMLElement).contentEditable === 'true'
  );
  if (isTypingInInput) return;

  if (movementKeys.has(e.code)) {
    pressedKeys.delete(e.code);
    if (pressedKeys.size === 0) {
      setIsKeyPressed(false);
    }
  }
});

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
const isIPhone = /iPhone/.test(navigator.userAgent);
const isIPad = /iPad/.test(navigator.userAgent);

function updateOrientationClass() {
  const isLandscape = window.innerWidth > window.innerHeight;
  const viewportHeight = window.innerHeight;

  document.body.classList.remove('portrait-mode', 'landscape-mode', 'ios-device', 'iphone-device', 'ipad-device', 'mobile-landscape', 'small-landscape', 'tiny-landscape');

  if (isIOS) {
    document.body.classList.add('ios-device');
  }

  if (isIPhone) {
    document.body.classList.add('iphone-device');
  }

  if (isIPad) {
    document.body.classList.add('ipad-device');
  }

  if (isLandscape) {
    document.body.classList.add('landscape-mode');

    if (viewportHeight <= 600) {
      document.body.classList.add('mobile-landscape');

      if (viewportHeight <= 450) {
        document.body.classList.add('small-landscape');

        if (viewportHeight <= 380) {
          document.body.classList.add('tiny-landscape');
        }
      }
    }
  } else {
    document.body.classList.add('portrait-mode');
  }
}

function updateViewportMetrics() {
  const actualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

  // Don't update viewport height if tile editor is active (it would break NPC dialog positioning)
  const tileEditor = (window as any).tileEditor;
  if (!tileEditor?.isActive) {
    document.documentElement.style.setProperty('--viewport-height', `${actualHeight}px`);
  }

  if (document.getElementById("context-menu")) {
    document.getElementById("context-menu")!.remove();
  }

  updateOrientationClass();
}

// Re-assigning canvas.width/height wipes the backing store and resets the
// context transform the renderer relies on. Guard against no-op resizes so the
// game canvas isn't blanked for a frame on every iOS viewport event (which
// flickers once WebKit stops promoting the canvas to its own compositing layer).
function resizeGameCanvas() {
  const rawDpr = window.devicePixelRatio || 1;
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const dpr = isTouchDevice ? Math.min(rawDpr, 2) : rawDpr;

  const bodyStyle = getComputedStyle(document.body);
  const displayWidth = parseFloat(bodyStyle.width) || window.innerWidth;
  const displayHeight = parseFloat(bodyStyle.height) || window.innerHeight;

  const targetWidth = Math.round(displayWidth * dpr);
  const targetHeight = Math.round(displayHeight * dpr);

  if (canvas.width === targetWidth && canvas.height === targetHeight) {
    return;
  }

  const prevWidth = canvas.width;
  const prevHeight = canvas.height;

  // Snapshot the current frame before resizing. Reassigning canvas.width/height
  // clears the backing store, so without this the canvas's black CSS background
  // shows through for a frame before the render loop repaints — seen as black
  // flicker while dragging to resize on PC.
  let snapshot: HTMLCanvasElement | null = null;
  if (ctx && prevWidth > 0 && prevHeight > 0) {
    snapshot = document.createElement("canvas");
    snapshot.width = prevWidth;
    snapshot.height = prevHeight;
    snapshot.getContext("2d")?.drawImage(canvas, 0, 0);
  }

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  canvas.style.width = displayWidth + "px";
  canvas.style.height = displayHeight + "px";

  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Bridge the one-frame gap with the previous frame stretched to the new size
    // until the next animation frame redraws everything crisply.
    if (snapshot) {
      ctx.drawImage(snapshot, 0, 0, prevWidth, prevHeight, 0, 0, targetWidth, targetHeight);
    }

    if (isTouchDevice) {
      const mobileZoom = 0.85;
      ctx.scale(dpr * mobileZoom, dpr * mobileZoom);

      ctx.translate((displayWidth * (1 - mobileZoom)) / (2 * mobileZoom),
                    (displayHeight * (1 - mobileZoom)) / (2 * mobileZoom));
    } else {
      ctx.scale(dpr, dpr);
    }

  }
}

function handleViewportResize() {
  updateViewportMetrics();
  resizeGameCanvas();
}

window.addEventListener("resize", handleViewportResize);
window.visualViewport?.addEventListener("resize", handleViewportResize);

// Scroll never changes the canvas size, so only refresh lightweight metrics.
// Touching canvas.width here would blank the canvas on every iOS scroll tick.
window.visualViewport?.addEventListener("scroll", updateViewportMetrics);

window.addEventListener("orientationchange", () => {

  setTimeout(() => {
    updateOrientationClass();
  }, 100);
});

updateOrientationClass();

window.addEventListener("blur", () => {
  setIsKeyPressed(false);
  pressedKeys.clear();
});

document
  .getElementById("pause-menu-action-back")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("pause-menu-action-options")
  ?.addEventListener("click", () => {

    pauseMenu.style.display = "none";
    optionsMenu.style.display = "block";
  });

document
  .getElementById("pause-menu-action-exit")
  ?.addEventListener("click", () => {
    sendRequest({
      type: "LOGOUT",
          data: null,
    });
    window.location.href = "/";
  });

document
  .getElementById("pause-menu-close")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("options-menu-close")
  ?.addEventListener("click", () => {
    optionsMenu.style.display = "none";
  });

fpsSlider.addEventListener("input", () => {
  document.getElementById(
    "limit-fps-label"
  )!.innerText = `FPS: (${Number(fpsSlider.value) >= 240 ? "240+" : fpsSlider.value})`;
});

musicSlider.addEventListener("input", () => {
  document.getElementById(
    "music-volume-label"
  )!.innerText = `Music: (${musicSlider.value})`;
});

effectsSlider.addEventListener("input", () => {
  document.getElementById(
    "effects-volume-label"
  )!.innerText = `Effects: (${effectsSlider.value})`;
});

[fpsSlider, musicSlider, effectsSlider, mutedCheckbox].forEach(element => {
  element.addEventListener("change", () => {
    sendRequest({
      type: "CLIENTCONFIG",
          data: {
            fps: parseInt(fpsSlider.value),
            music_volume: parseInt(musicSlider.value) || 0,
            effects_volume: parseInt(effectsSlider.value) || 0,
            muted: mutedCheckbox.checked,
          } as ConfigData,
    });
  });
});

document.addEventListener("contextmenu", (event) => {
  if (!getIsLoaded()) return;

  if ((window as any).tileEditor?.isActive) return;
  if (getContextMenuKeyTriggered()) {
    event.preventDefault();
    setContextMenuKeyTriggered(false);
    return;
  }

  if ((event.target as HTMLElement)?.closest(".ui")) {

    const partyMember = (event.target as HTMLElement).closest(".party-member") as HTMLElement;
    if (partyMember) {
      const username = partyMember.dataset.username;
      if (username) {
        createPartyContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }

    const guildMember = (event.target as HTMLElement).closest(".guild-member") as HTMLElement;
    if (guildMember) {
      const username = guildMember.dataset.username;
      if (username) {
        const currentPlayer = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
        const isSelf = currentPlayer?.username?.toLowerCase() === username.toLowerCase();
        const isLeader = currentPlayer?.guild?.length > 0
          && currentPlayer?.guild?.[0]?.toLowerCase() === currentPlayer?.username?.toLowerCase();
        if (!isSelf && !isLeader) {
          event.preventDefault();
          return;
        }
        createGuildContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }

    const friendItem = (event.target as HTMLElement).closest(".friend-item") as HTMLElement;
    if (friendItem) {
      const nameEl = friendItem.querySelector(".friend-name");
      if (nameEl?.textContent) {
        createFriendContextMenu(event, nameEl.textContent);
      }
      event.preventDefault();
      return;
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Account for map centering offset for small maps
  let mapCenterOffsetX = 0;
  const mapCenterOffsetY = 0;
  if (window.mapData) {
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    if (mapWidth < window.innerWidth) {
      mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }
  }

  const worldX = screenX - window.innerWidth / 2 + getCameraX() - mapCenterOffsetX;
  const worldY = screenY - window.innerHeight / 2 + getCameraY() - mapCenterOffsetY;

  const clickedPlayer = Array.from(cache.players).find(player => {
    const playerX = player.position.x;
    const playerY = player.position.y;
    return (
      worldX >= playerX - 16 && worldX <= playerX + 32 &&
      worldY >= playerY - 24 && worldY <= playerY + 48
    );
  });

  if (clickedPlayer) {
    const id = clickedPlayer.id;

    createContextMenu(event, id);
    return;
  }

  const existingMenu = document.getElementById("context-menu");
  if (existingMenu) existingMenu.remove();

  sendRequest({
    type: "TELEPORTXY",
    data: { x: Math.floor(worldX), y: Math.floor(worldY) },
  });
});

// Long-press player on mobile to show context menu
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressStartX = 0;
let longPressStartY = 0;

canvas.addEventListener("touchstart", (e) => {
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  if (!isTouchDevice) return;
  if ((window as any).tileEditor?.isActive) return;
  if (e.touches.length !== 1) { longPressTimer && clearTimeout(longPressTimer); longPressTimer = null; return; }

  const touch = e.touches[0];
  longPressStartX = touch.clientX;
  longPressStartY = touch.clientY;

  longPressTimer = setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    const screenX = longPressStartX - rect.left;
    const screenY = longPressStartY - rect.top;

    const worldX = screenX - rect.width / 2 + getCameraX();
    const worldY = screenY - rect.height / 2 + getCameraY();

    const clickedPlayer = Array.from(cache.players).find(player => {
      return worldX >= player.position.x - 16 && worldX <= player.position.x + 32 &&
             worldY >= player.position.y - 24 && worldY <= player.position.y + 48;
    });

    if (clickedPlayer) {
      createContextMenu({ clientX: longPressStartX, clientY: longPressStartY } as MouseEvent, clickedPlayer.id);
    }

    longPressTimer = null;
  }, 500);
});

canvas.addEventListener("touchend", () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
});

canvas.addEventListener("touchmove", (e) => {
  if (!longPressTimer) return;
  const touch = e.touches[0];
  const dx = touch.clientX - longPressStartX;
  const dy = touch.clientY - longPressStartY;
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

// Double-tap on mobile for admin warp
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

canvas.addEventListener("touchend", (e) => {
  if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  if ((window as any).tileEditor?.isActive) return;

  const now = Date.now();
  const touch = (e as any).changedTouches?.[0];
  if (!touch) return;

  const currentPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
  if (!currentPlayer?.isAdmin) return;

  if (now - lastTapTime < 300 &&
      Math.abs(touch.clientX - lastTapX) < 30 &&
      Math.abs(touch.clientY - lastTapY) < 30) {

    const rect = canvas.getBoundingClientRect();
    const screenX = touch.clientX - rect.left;
    const screenY = touch.clientY - rect.top;

    let mapCenterOffsetX = 0;
    const mapCenterOffsetY = 0;
    if (window.mapData) {
      const mapWidth = window.mapData.width * window.mapData.tilewidth;
      if (mapWidth < window.innerWidth) mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }

    const worldX = screenX - window.innerWidth / 2 + getCameraX() - mapCenterOffsetX;
    const worldY = screenY - window.innerHeight / 2 + getCameraY() - mapCenterOffsetY;

    sendRequest({
      type: "TELEPORTXY",
      data: { x: Math.floor(worldX), y: Math.floor(worldY) },
    });

    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }
});

document.addEventListener("click", (event) => {

  if (!getIsLoaded()) return;

  if ((window as any).tileEditor?.isActive) return;
  if ((event.target as HTMLElement)?.closest(".ui")) return;

  // Don't untarget when clicking on entity editor UI
  const entityEditorContainer = document.getElementById("entity-editor-container");
  if (entityEditorContainer && entityEditorContainer.contains(event.target as Node)) return;

  const contextMenu = document.getElementById("context-menu");
  if (contextMenu && !contextMenu.contains(event.target as Node)) {
    contextMenu.remove();
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Account for map centering offset for small maps
  let mapCenterOffsetX = 0;
  const mapCenterOffsetY = 0;
  if (window.mapData) {
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    if (mapWidth < window.innerWidth) {
      mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }
  }

  const worldX = screenX - window.innerWidth / 2 + getCameraX() - mapCenterOffsetX;
  const worldY = screenY - window.innerHeight / 2 + getCameraY() - mapCenterOffsetY;

  // Clear previous target
  const prevPlayer = Array.from(cache.players).find(player => player.targeted);
  if (prevPlayer) {
    prevPlayer.targeted = false;
  }
  const prevNpc = cache.npcs.find((npc: any) => npc.id === cache.targetId);
  if (prevNpc) {
    cache.targetId = null;
  }
  const prevEntity = cache.entities.find((entity: any) => entity.id === cache.targetId);
  if (prevEntity) {
    cache.targetId = null;
  }

  // Check if clicked on NPC
  const clickedNpc = cache.npcs.find((npc: any) => {
    const npcX = npc.position.x;
    const npcY = npc.position.y;
    return (
      worldX >= npcX - 16 && worldX <= npcX + 32 &&
      worldY >= npcY - 24 && worldY <= npcY + 48
    );
  });

  if (clickedNpc) {
    cache.targetId = clickedNpc.id;
    return;
  }

  // Check if clicked on entity
  const clickedEntity = cache.entities.find((entity: any) => {
    // Skip dead entities - check both health and combatState
    if (entity.health <= 0 || entity.combatState === 'dead') return false;

    const entityX = entity.position.x;
    const entityY = entity.position.y;
    return (
      worldX >= entityX - 16 && worldX <= entityX + 32 &&
      worldY >= entityY - 24 && worldY <= entityY + 48
    );
  });

  if (clickedEntity) {
    cache.targetId = clickedEntity.id;
    // Also select in entity editor if it's open
    if ((window as any).entityEditor) {
      (window as any).entityEditor.selectEntity(clickedEntity);
    }
    return;
  }

  sendRequest({
    type: "SELECTPLAYER",
    data: { x: Math.floor(worldX), y: Math.floor(worldY) },
  });
});

chatInput.addEventListener("focus", () => {
  stopMovement();
});

friendsListSearch.addEventListener("focus", () => {
  stopMovement();
});

const adminInputFields = [
  document.getElementById("admin-map-input"),
  document.getElementById("admin-warp-input"),
  document.getElementById("admin-broadcast-input")
];

adminInputFields.forEach(field => {
  if (field) {
    field.addEventListener("focus", () => {
      stopMovement();
    });
  }
});

chatInput.addEventListener("blur", () => {
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  pressedKeys.clear();
  setIsKeyPressed(false);
  setIsMoving(false);
});

friendsListSearch.addEventListener("input", () => {
  const searchTerm = friendsListSearch.value.toLowerCase();
  const friendItems = Array.from(friendsList.querySelectorAll('.friend-item')) as HTMLElement[];
  if (!searchTerm) {

    friendItems.forEach(item => {
      item.style.display = 'block';
    });
    return;
  }

  friendItems.forEach(item => {
    const friendName = item.querySelector('.friend-name')?.textContent?.toLowerCase() || '';
    if (friendName.includes(searchTerm)) {
      item.style.display = 'block';
    } else {
      item.style.display = 'none';
    }
  });
});

// Party member click on mobile shows context menu
document.addEventListener("click", (e) => {
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  if (!isTouchDevice) return;

  const partyMember = (e.target as HTMLElement).closest(".party-member") as HTMLElement;
  if (partyMember) {
    const username = partyMember.dataset.username;
    if (username) {
      createPartyContextMenu(e as MouseEvent, username);
    }
    return;
  }

  const guildMember = (e.target as HTMLElement).closest(".guild-member") as HTMLElement;
  if (guildMember) {
    const username = guildMember.dataset.username;
    if (username) {
      const currentPlayer = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
      const isSelf = currentPlayer?.username?.toLowerCase() === username.toLowerCase();
      const isLeader = currentPlayer?.guild?.length > 0
        && currentPlayer?.guild?.[0]?.toLowerCase() === currentPlayer?.username?.toLowerCase();
      if (isSelf || isLeader) {
        createGuildContextMenu(e as MouseEvent, username);
      }
    }
    return;
  }

  const friendItem = (e.target as HTMLElement).closest(".friend-item") as HTMLElement;
  if (friendItem) {
    const nameEl = friendItem.querySelector(".friend-name");
    if (nameEl?.textContent) {
      createFriendContextMenu(e as MouseEvent, nameEl.textContent);
    }
    return;
  }
});

// Close open panels when tapping outside on mobile
document.addEventListener("click", (e) => {
  const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  if (!isTouchDevice) return;

  const target = e.target as HTMLElement;
  // Don't close if clicking radial menu items — they toggle panels themselves
  if (target.closest(".radial-item") || target.closest(".radial-menu-btn") || target.closest("#radial-menu")) return;

  const openPanels = document.querySelectorAll("#inventory.open, #spell-book-container.open, #collectables-container.open, #friends-list-container.open, #guild-container.open, #admin-panel-container.open");
  if (openPanels.length === 0) return;

  const clickedInside = Array.from(openPanels).some(panel => panel.contains(target));
  if (!clickedInside) {
    closeAllPanels();
  }
});