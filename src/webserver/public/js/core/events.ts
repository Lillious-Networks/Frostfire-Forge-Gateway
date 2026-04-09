import { sendRequest, getIsLoaded } from "./socket.js";
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
    setIsMoving} from "./input.js";
import { friendsListSearch } from "./friends.js";
import { createContextMenu, createPartyContextMenu } from "./actions.js";
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
  if (!getIsLoaded()) return;
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

window.addEventListener("resize", () => {

  const actualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

  // Don't update viewport height if tile editor is active (it would break NPC dialog positioning)
  const tileEditor = (window as any).tileEditor;
  if (!tileEditor?.isActive) {
    document.documentElement.style.setProperty('--viewport-height', `${actualHeight}px`);
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = actualHeight * dpr;

  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = actualHeight + "px";

  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

    if (isTouchDevice) {
      const mobileZoom = 0.85;
      ctx.scale(dpr * mobileZoom, dpr * mobileZoom);

      ctx.translate((window.innerWidth * (1 - mobileZoom)) / (2 * mobileZoom),
                    (actualHeight * (1 - mobileZoom)) / (2 * mobileZoom));
    } else {
      ctx.scale(dpr, dpr);
    }

  }

  if (document.getElementById("context-menu")) {
    document.getElementById("context-menu")!.remove();
  }

  updateOrientationClass();

});

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

fpsSlider.addEventListener("input", () => {
  document.getElementById(
    "limit-fps-label"
  )!.innerText = `FPS: (${fpsSlider.value})`;
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

  if ((event.target as HTMLElement)?.classList.contains("ui")) {

    const partyMember = (event.target as HTMLElement).closest(".party-member") as HTMLElement;
    if (partyMember) {
      const username = partyMember.dataset.username;
      if (username) {
        createPartyContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  const worldX = screenX - window.innerWidth / 2 + getCameraX();
  const worldY = screenY - window.innerHeight / 2 + getCameraY();

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

document.addEventListener("click", (event) => {

  if (!getIsLoaded()) return;

  if ((window as any).tileEditor?.isActive) return;
  if ((event.target as HTMLElement)?.classList.contains("ui")) return;

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

  const worldX = screenX - window.innerWidth / 2 + getCameraX();
  const worldY = screenY - window.innerHeight / 2 + getCameraY();

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