import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { cast } from "./input.js";
import { hideItemTooltip, setupItemTooltip, removeItemTooltip } from "./tooltip.js";
const debugContainer = document.getElementById("debug-container") as HTMLDivElement;
const statUI = document.getElementById("stat-screen") as HTMLDivElement;
const positionText = document.getElementById("position") as HTMLDivElement;
const friendsListUI = document.getElementById("friends-list-container") as HTMLDivElement;
const inventoryUI = document.getElementById("inventory") as HTMLDivElement;
const spellBookUI = document.getElementById("spell-book-container") as HTMLDivElement;
const collectablesUI = document.getElementById("collectables-container") as HTMLDivElement;
const pauseMenu = document.getElementById("pause-menu-container") as HTMLDivElement;
const menuElements = ["options-menu-container"];
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false });
const fpsSlider = document.getElementById("fps-slider") as HTMLInputElement;
const healthBar = document.getElementById("health-progress-bar") as HTMLDivElement;
const staminaBar = document.getElementById("stamina-progress-bar") as HTMLDivElement;
const xpBar = document.getElementById("xp-bar") as HTMLDivElement;
const musicSlider = document.getElementById("music-slider") as HTMLInputElement;
const effectsSlider = document.getElementById("effects-slider") as HTMLInputElement;
const mutedCheckbox = document.getElementById("muted-checkbox") as HTMLInputElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const packetsSentReceived = document.getElementById("packets-sent-received") as HTMLDivElement;
const optionsMenu = document.getElementById("options-menu-container") as HTMLDivElement;
const friendsList = document.getElementById("friends-list-content") as HTMLDivElement;
const friendsListSearch = document.getElementById("friends-list-search") as HTMLInputElement;
const onlinecount = document.getElementById("onlinecount") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressBarContainer = document.getElementById("progress-bar-container") as HTMLDivElement;
const inventoryGrid = document.getElementById("grid") as HTMLDivElement;
const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const loadingScreen = document.getElementById("loading-screen");
const usernameLabel = document.getElementById("stats-screen-username-label") as HTMLDivElement;
const levelLabel = document.getElementById("stats-screen-level-label") as HTMLDivElement;
const healthLabel = document.getElementById("stats-screen-health-label") as HTMLDivElement;
const manaLabel = document.getElementById("stats-screen-mana-label") as HTMLDivElement;
const damageLabel = document.getElementById("stats-screen-damage-label") as HTMLDivElement;
const armorLabel = document.getElementById("stats-screen-armor-label") as HTMLDivElement;
const critChanceLabel = document.getElementById("stats-screen-crit-chance-label") as HTMLDivElement;
const critDamageLabel = document.getElementById("stats-screen-crit-damage-label") as HTMLDivElement;
const avoidanceLabel = document.getElementById("stats-screen-avoidance-label") as HTMLDivElement;
const notificationContainer = document.getElementById("game-notification-container");
const notificationMessage = document.getElementById("game-notification-message");
const serverTime = document.getElementById("server-time-value") as HTMLDivElement;
const ambience = document.getElementById("ambience-overlay") as HTMLDivElement;
const weatherCanvas = document.getElementById("weather") as HTMLCanvasElement;
const weatherCtx = weatherCanvas.getContext("2d");
const guildContainer = document.getElementById("guild-container") as HTMLDivElement;
const guildName = document.getElementById("guild-name") as HTMLDivElement;
const guildRank = document.getElementById("guild-rank") as HTMLDivElement;
const guildMembersList = document.getElementById("guild-members-list") as HTMLDivElement;
const guildMemberCount = document.getElementById("guild-member-count") as HTMLDivElement;
const guildMemberInviteInput = document.getElementById("guild-invite-input") as HTMLInputElement;
const guildMemberInviteButton = document.getElementById("guild-invite-button") as HTMLButtonElement;
const guildCreateInput = document.getElementById("guild-create-input") as HTMLInputElement;
const guildCreateButton = document.getElementById("guild-create-button") as HTMLButtonElement;
const guildCreateSection = document.getElementById("guild-create-section") as HTMLDivElement;
const collisionDebugCheckbox = document.getElementById("collision-debug-checkbox") as HTMLInputElement;
const equipmentLeftColumn = document.getElementById("equipment-left-column") as HTMLDivElement;
const equipmentRightColumn = document.getElementById("equipment-right-column") as HTMLDivElement;
const equipmentBottomCenter = document.getElementById("equipment-bottom-center") as HTMLDivElement;
const chunkOutlineDebugCheckbox = document.getElementById("chunk-outline-debug-checkbox") as HTMLInputElement;
const collisionTilesDebugCheckbox = document.getElementById("collision-tiles-debug-checkbox") as HTMLInputElement;
const noPvpDebugCheckbox = document.getElementById("nopvp-debug-checkbox") as HTMLInputElement;
const wireframeDebugCheckbox = document.getElementById("wireframe-debug-checkbox") as HTMLInputElement;
const showGridCheckbox = document.getElementById("show-grid-checkbox") as HTMLInputElement;
const astarDebugCheckbox = document.getElementById("astar-debug-checkbox") as HTMLInputElement;
const loadedChunksText = document.getElementById("loaded-chunks") as HTMLDivElement;
const hotbar = document.getElementById("hotbar") as HTMLDivElement;
const hotbarGrid = hotbar.querySelector("#grid") as HTMLDivElement;
const hotbarSlots = hotbarGrid.querySelectorAll(".slot") as NodeListOf<HTMLDivElement>;
const castbar = document.getElementById("castbar") as HTMLDivElement;
const adminPanelContainer = document.getElementById("admin-panel-container") as HTMLDivElement;

let touchDragJustEnded = false;

hotbarSlots.forEach((slot, index) => {
  slot.addEventListener("click", (event) => {
    event.preventDefault();
    if (touchDragJustEnded) {
      touchDragJustEnded = false;
      return;
    }
    cast(index);
  });
});

function saveHotbarConfiguration() {
  const hotbarConfig: { [key: string]: string | null } = {};

  hotbarSlots.forEach((slot, index) => {
    const spellName = slot.dataset.spellName;
    hotbarConfig[index.toString()] = spellName || null;
  });

  sendRequest({
    type: "SAVE_HOTBAR",
    data: hotbarConfig
  });
}

let successfulHotbarDrop = false;

hotbarSlots.forEach((slot, index) => {

  slot.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.shiftKey && slot.dataset.spellName) {
      slot.draggable = true;
    } else {
      slot.draggable = false;
    }
  });

  slot.addEventListener("dragstart", (event: DragEvent) => {
    if (!event.shiftKey || !slot.dataset.spellName) {
      event.preventDefault();
      return;
    }

    successfulHotbarDrop = false;

    if (event.dataTransfer) {

      event.dataTransfer.setData("hotbar-source-index", index.toString());
      event.dataTransfer.setData("text/plain", slot.dataset.spellName);

      const img = slot.querySelector("img") as HTMLImageElement;
      if (img) {
        event.dataTransfer.setData("image/src", img.src);
      }

      event.dataTransfer.effectAllowed = "move";
      slot.style.opacity = "0.5";
    }
  });

  slot.addEventListener("dragend", (event: DragEvent) => {
    slot.style.opacity = "1";
    slot.draggable = false;

    if (!successfulHotbarDrop && event.dataTransfer && event.dataTransfer.dropEffect === "none") {

      delete slot.dataset.spellName;
      slot.innerHTML = "";
      saveHotbarConfiguration();
    }

    successfulHotbarDrop = false;
  });

  slot.addEventListener("dragover", (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {

      const isHotbarDrag = event.dataTransfer.types.includes("hotbar-source-index");
      event.dataTransfer.dropEffect = isHotbarDrag ? "move" : "copy";
    }
    slot.style.backgroundColor = "rgba(255, 255, 255, 0.2)";
  });

  slot.addEventListener("dragleave", () => {
    slot.style.backgroundColor = "";
  });

  slot.addEventListener("drop", (event: DragEvent) => {
    event.preventDefault();
    slot.style.backgroundColor = "";

    if (event.dataTransfer) {
      const sourceIndex = event.dataTransfer.getData("hotbar-source-index");
      const spellName = event.dataTransfer.getData("text/plain");
      const imageSrc = event.dataTransfer.getData("image/src");

      if (spellName) {

        if (sourceIndex !== "" && sourceIndex !== index.toString()) {
          const sourceSlot = hotbarSlots[parseInt(sourceIndex)];

          const targetSpellName = slot.dataset.spellName;
          const targetImg = slot.querySelector("img") as HTMLImageElement;
          const targetImageSrc = targetImg ? targetImg.src : null;

          slot.dataset.spellName = spellName;
          slot.innerHTML = "";

          if (imageSrc) {
            const iconImage = new Image();
            iconImage.src = imageSrc;
            iconImage.draggable = false;
            slot.appendChild(iconImage);
          } else {
            slot.innerText = spellName;
          }

          if (targetSpellName && targetSpellName !== "") {

            sourceSlot.dataset.spellName = targetSpellName;
            sourceSlot.innerHTML = "";

            if (targetImageSrc) {
              const iconImage = new Image();
              iconImage.src = targetImageSrc;
              iconImage.draggable = false;
              sourceSlot.appendChild(iconImage);
            } else {
              sourceSlot.innerText = targetSpellName;
            }
          } else {

            delete sourceSlot.dataset.spellName;
            sourceSlot.innerHTML = "";
          }

          successfulHotbarDrop = true;
        } else {

          slot.dataset.spellName = spellName;
          slot.innerHTML = "";

          if (imageSrc) {
            const iconImage = new Image();
            iconImage.src = imageSrc;
            iconImage.draggable = false;
            slot.appendChild(iconImage);
          } else {
            slot.innerText = spellName;
          }
        }

        saveHotbarConfiguration();
      }
    }
  });

  slot.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();

    if (slot.dataset.spellName) {

      delete slot.dataset.spellName;
      slot.innerHTML = "";

      saveHotbarConfiguration();
    }
  });
});

let activeCastbarClone: HTMLDivElement | null = null;

interface PanelDragTarget {
  element: HTMLElement;
  handle: HTMLElement;
  storageKey: string;
}

const GRID_SIZE = 16;
const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

let ctrlHeld = false;
const registeredDragPanels: PanelDragTarget[] = [];

function updateDragCursors() {
  if (isMobileDevice) return;
  for (const panel of registeredDragPanels) {
    if (!panelDragActive || activeDragPanel !== panel) {
      panel.element.style.cursor = ctrlHeld ? "grab" : "default";
      panel.handle.style.cursor = ctrlHeld ? "grab" : "default";
    }
  }
}

let panelDragActive = false;
let panelDragStartX = 0;
let panelDragStartY = 0;
let panelDragOffsetX = 0;
let panelDragOffsetY = 0;
let activeDragPanel: PanelDragTarget | null = null;

// Grid overlay for UI edit mode — desktop only
const gridOverlay = isMobileDevice ? null : (() => {
  const el = document.createElement("div");
  el.id = "ui-edit-grid";
  el.style.cssText =
    "position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;" +
    "pointer-events:none;display:none;" +
    `background-image:linear-gradient(rgba(255,255,255,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.06) 1px,transparent 1px);` +
    `background-size:${GRID_SIZE}px ${GRID_SIZE}px;`;
  document.body.appendChild(el);
  return el;
})();

if (!isMobileDevice) {
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Control" && !e.repeat) {
      ctrlHeld = true;
      if (gridOverlay) gridOverlay.style.display = "block";
      updateDragCursors();
    }
  });

  document.addEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === "Control") {
      ctrlHeld = false;
      if (gridOverlay) gridOverlay.style.display = "none";
      updateDragCursors();
    }
  });

  window.addEventListener("blur", () => {
    ctrlHeld = false;
    if (gridOverlay) gridOverlay.style.display = "none";
    updateDragCursors();
  });
}

function loadPanelPosition(element: HTMLElement, storageKey: string) {
  if (isMobileDevice) return;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const pos = JSON.parse(saved);
      element.style.left = pos.x;
      element.style.top = pos.y;
      element.style.bottom = "auto";
      element.style.right = "auto";
    }
  } catch (e) { /* ignore */ }
}

function savePanelPosition(storageKey: string, left: string, top: string) {
  if (isMobileDevice) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ x: left, y: top }));
  } catch (e) { /* ignore */ }
}

function shouldSkipDrag(target: HTMLElement): boolean {
  const tag = target.tagName;
  if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "A") return true;
  if (target.closest(".slot, button, input, select, textarea, a")) return true;
  return false;
}

function registerPanelDrag(panel: PanelDragTarget) {
  if (isMobileDevice) return;
  const { element, handle, storageKey } = panel;

  loadPanelPosition(element, storageKey);

  element.style.cursor = "default";
  handle.style.cursor = "default";

  registeredDragPanels.push(panel);

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    if (!e.ctrlKey) return;
    if (shouldSkipDrag(e.target as HTMLElement)) return;
    panelDragActive = true;
    activeDragPanel = panel;
    panelDragStartX = e.clientX;
    panelDragStartY = e.clientY;
    const rect = element.getBoundingClientRect();
    panelDragOffsetX = rect.left;
    panelDragOffsetY = rect.top;
    element.style.cursor = "grabbing";
    document.body.style.cursor = "grabbing";
    element.style.zIndex = "1000";
    element.style.margin = "0";
    element.style.bottom = "auto";
    element.style.right = "auto";
    element.style.transform = "none";
    element.style.left = `${panelDragOffsetX}px`;
    element.style.top = `${panelDragOffsetY}px`;
    e.preventDefault();
  });

  handle.addEventListener("touchstart", (e: TouchEvent) => {
    if (shouldSkipDrag(e.target as HTMLElement)) return;
    const touch = e.touches[0];
    panelDragActive = true;
    activeDragPanel = panel;
    panelDragStartX = touch.clientX;
    panelDragStartY = touch.clientY;
    const rect = element.getBoundingClientRect();
    panelDragOffsetX = rect.left;
    panelDragOffsetY = rect.top;
    element.style.cursor = "grabbing";
    document.body.style.cursor = "grabbing";
    element.style.zIndex = "1000";
    element.style.margin = "0";
    element.style.bottom = "auto";
    element.style.right = "auto";
    element.style.transform = "none";
    element.style.left = `${panelDragOffsetX}px`;
    element.style.top = `${panelDragOffsetY}px`;
  }, { passive: true });
}

if (!isMobileDevice) {
  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!panelDragActive || !activeDragPanel) return;
    const deltaX = e.clientX - panelDragStartX;
    const deltaY = e.clientY - panelDragStartY;
    let newX = panelDragOffsetX + deltaX;
    let newY = panelDragOffsetY + deltaY;
    const rect = activeDragPanel.element.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;
    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));
    newX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
    newY = Math.round(newY / GRID_SIZE) * GRID_SIZE;
    activeDragPanel.element.style.left = `${newX}px`;
    activeDragPanel.element.style.top = `${newY}px`;
  });

  document.addEventListener("touchmove", (e: TouchEvent) => {
    if (!panelDragActive || !activeDragPanel) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - panelDragStartX;
    const deltaY = touch.clientY - panelDragStartY;
    let newX = panelDragOffsetX + deltaX;
    let newY = panelDragOffsetY + deltaY;
    const rect = activeDragPanel.element.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;
    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));
    activeDragPanel.element.style.left = `${newX}px`;
    activeDragPanel.element.style.top = `${newY}px`;
  }, { passive: true });
}

let prevViewportWidth = window.innerWidth;
let prevViewportHeight = window.innerHeight;

function repositionPanelsToViewport() {
  if (isMobileDevice) return;

  const newW = window.innerWidth;
  const newH = window.innerHeight;
  const oldW = prevViewportWidth;
  const oldH = prevViewportHeight;
  prevViewportWidth = newW;
  prevViewportHeight = newH;
  if (newW === oldW && newH === oldH) return;

  for (const panel of registeredDragPanels) {
    const el = panel.element;
    if (panelDragActive && activeDragPanel === panel) continue;
    if (!el.style.left && !el.style.top) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const availOldX = oldW - rect.width;
    const availOldY = oldH - rect.height;
    const availNewX = newW - rect.width;
    const availNewY = newH - rect.height;

    const fracX = availOldX > 0 ? Math.min(Math.max(rect.left / availOldX, 0), 1) : 0;
    const fracY = availOldY > 0 ? Math.min(Math.max(rect.top / availOldY, 0), 1) : 0;

    const newX = availNewX > 0 ? Math.round(fracX * availNewX) : 0;
    const newY = availNewY > 0 ? Math.round(fracY * availNewY) : 0;

    el.style.margin = "0";
    el.style.bottom = "auto";
    el.style.right = "auto";
    el.style.transform = "none";
    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;
    savePanelPosition(panel.storageKey, el.style.left, el.style.top);
  }
}

if (!isMobileDevice) {
  window.addEventListener("resize", repositionPanelsToViewport);
}

function endDrag() {
  if (!activeDragPanel) return;
  panelDragActive = false;
  activeDragPanel.element.style.cursor = ctrlHeld ? "grab" : "default";
  activeDragPanel.handle.style.cursor = ctrlHeld ? "grab" : "default";
  document.body.style.cursor = "";
  activeDragPanel.element.style.zIndex = "";
  savePanelPosition(activeDragPanel.storageKey, activeDragPanel.element.style.left, activeDragPanel.element.style.top);
  activeDragPanel = null;
}

if (!isMobileDevice) {
  document.addEventListener("mouseup", () => {
    if (!panelDragActive) return;
    endDrag();
  });

  document.addEventListener("touchend", () => {
    if (!panelDragActive) return;
    endDrag();
  });
}

function toggleUI(element: HTMLElement, _toggleFlag?: boolean, _hidePosition?: number) {
  const isOpen = element.style.display === "block";
  element.style.display = isOpen ? "none" : "block";
  element.classList.toggle("open", !isOpen);
  return !isOpen;
}

function toggleDebugContainer() {
  debugContainer.style.display = debugContainer.style.display === "block" ? "none" : "block";
}

const statScreenClose = document.getElementById("stat-screen-close") as HTMLButtonElement;
if (statScreenClose) {
  statScreenClose.addEventListener("click", (e) => {
    e.stopPropagation();
    statUI.style.display = "none";
  });
}

function handleStatsUI() {
  if (statUI.style.display === "block") {
    statUI.style.display = "none";
  } else {
    sendRequest({ type: "INSPECTPLAYER", data: null });
  }
}

// Register draggable panels
if (statUI) {
  registerPanelDrag({ element: statUI, handle: statUI, storageKey: "panel-pos-stat-screen" });
}

const chatContainer = document.getElementById("chat-container") as HTMLDivElement;
if (chatContainer) {
  registerPanelDrag({ element: chatContainer, handle: chatContainer, storageKey: "panel-pos-chat" });
}

if (inventoryUI) {
  registerPanelDrag({ element: inventoryUI, handle: inventoryUI, storageKey: "panel-pos-inventory" });
}

if (spellBookUI) {
  registerPanelDrag({ element: spellBookUI, handle: spellBookUI, storageKey: "panel-pos-spellbook" });
}

if (collectablesUI) {
  registerPanelDrag({ element: collectablesUI, handle: collectablesUI, storageKey: "panel-pos-collectables" });
}

if (friendsListUI) {
  registerPanelDrag({ element: friendsListUI, handle: friendsListUI, storageKey: "panel-pos-friends" });
}

if (guildContainer) {
  registerPanelDrag({ element: guildContainer, handle: guildContainer, storageKey: "panel-pos-guild" });
}

const partyContainer = document.getElementById("party-container") as HTMLDivElement;
if (partyContainer) {
  registerPanelDrag({ element: partyContainer, handle: partyContainer, storageKey: "panel-pos-party" });
}

if (adminPanelContainer) {
  registerPanelDrag({ element: adminPanelContainer, handle: adminPanelContainer, storageKey: "panel-pos-admin" });
}

if (hotbar) {
  registerPanelDrag({ element: hotbar, handle: hotbar, storageKey: "panel-pos-hotbar" });
}

// Touch-based drag from spellbook to hotbar, and hotbar rearrange/remove (mobile)
let touchDragActive = false;
let touchDragSource: "spellbook" | "hotbar" | "inventory" = "spellbook";
let touchDragSourceIndex = -1;
let touchDragSpellName: string | null = null;
let touchDragImageSrc: string | null = null;
let touchDragGhost: HTMLDivElement | null = null;
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

function createTouchGhost(x: number, y: number) {
  const ghost = document.createElement("div");
  ghost.id = "touch-drag-ghost";
  ghost.style.position = "fixed";
  ghost.style.width = "40px";
  ghost.style.height = "40px";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "9999";
  ghost.style.opacity = "0.85";
  ghost.style.transform = "translate(-50%, -50%)";

  if (touchDragImageSrc) {
    const ghostImg = document.createElement("img");
    ghostImg.src = touchDragImageSrc;
    ghostImg.width = 40;
    ghostImg.height = 40;
    ghostImg.style.pointerEvents = "none";
    ghostImg.draggable = false;
    ghost.appendChild(ghostImg);
  } else {
    ghost.textContent = touchDragSpellName || "";
    ghost.style.background = "rgba(30, 30, 45, 0.92)";
    ghost.style.color = "#e0e7ff";
    ghost.style.borderRadius = "6px";
    ghost.style.border = "1px solid rgba(255,255,255,0.25)";
    ghost.style.display = "flex";
    ghost.style.alignItems = "center";
    ghost.style.justifyContent = "center";
    ghost.style.fontSize = "9px";
    ghost.style.padding = "2px";
    ghost.style.boxSizing = "border-box";
    ghost.style.width = "auto";
    ghost.style.minWidth = "36px";
    ghost.style.maxWidth = "64px";
    ghost.style.whiteSpace = "nowrap";
    ghost.style.overflow = "hidden";
    ghost.style.textOverflow = "ellipsis";
    ghost.style.backdropFilter = "blur(4px)";
  }

  ghost.style.left = x + "px";
  ghost.style.top = y + "px";
  document.body.appendChild(ghost);
  touchDragGhost = ghost;
}

function startTouchDrag(source: "spellbook" | "hotbar" | "inventory", slot: HTMLDivElement, index: number) {
  touchDragActive = true;
  touchDragSource = source;
  touchDragSourceIndex = index;
  touchDragSpellName = slot.dataset.spellName || slot.dataset.itemName || null;
  let img = slot.querySelector("img") as HTMLImageElement;
  if (!img && source === "inventory") {
    const cache = Cache.getInstance();
    const item = cache.inventory?.find((i: any) => i.name === touchDragSpellName);
    if (item?.iconUrl) {
      img = new Image();
      img.src = item.iconUrl;
    }
  }
  touchDragImageSrc = img ? img.src : null;
  createTouchGhost(touchStartX, touchStartY);
}

function clearTouchDrag() {
  if (touchDragGhost) {
    touchDragGhost.remove();
    touchDragGhost = null;
  }
  if (touchDragSource === "inventory" && touchDragSourceIndex >= 0) {
    const invSlots = inventoryGrid.querySelectorAll(".slot");
    const sourceSlot = invSlots[touchDragSourceIndex] as HTMLDivElement;
    if (sourceSlot) sourceSlot.style.opacity = "1";
  }
  touchDragActive = false;
  touchDragSpellName = null;
  touchDragImageSrc = null;
  touchDragSourceIndex = -1;
  touchStartTime = 0;
  inventoryPendingSlot = null;
  inventoryPendingIndex = -1;
  inventoryPendingStartTime = 0;
}

// Spellbook: immediate drag on touch start
spellBookUI.addEventListener("touchstart", (e: TouchEvent) => {
  if (touchDragActive) return;
  const touch = e.touches[0];
  const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
  const slot = target?.closest(".slot") as HTMLDivElement;
  if (!slot?.dataset?.spellName) return;

  e.preventDefault();
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  startTouchDrag("spellbook", slot, -1);
}, { passive: false });

// Hotbar: long-press (500ms detected in touchmove) then drag
let hotbarPendingSlot: HTMLDivElement | null = null;
let hotbarPendingIndex = -1;

hotbar.addEventListener("touchstart", (e: TouchEvent) => {
  if (touchDragActive) return;
  const touch = e.touches[0];
  const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
  const slot = target?.closest(".slot") as HTMLDivElement;
  if (!slot?.dataset?.spellName) return;

  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchStartTime = performance.now();
  hotbarPendingSlot = slot;
  hotbarPendingIndex = Array.from(hotbarSlots).indexOf(slot);
}, { passive: true });

// Inventory: long-press (500ms) then drag to rearrange
let inventoryPendingSlot: HTMLDivElement | null = null;
let inventoryPendingIndex = -1;
let inventoryPendingStartX = 0;
let inventoryPendingStartY = 0;
let inventoryPendingStartTime = 0;

inventoryUI.addEventListener("touchstart", (e: TouchEvent) => {
  if (touchDragActive) return;
  const touch = e.touches[0];
  const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
  const slot = target?.closest(".slot") as HTMLDivElement;
  if (!slot?.dataset?.itemName) return;

  inventoryPendingSlot = slot;
  inventoryPendingIndex = Array.from(inventoryGrid.querySelectorAll(".slot")).indexOf(slot);
  inventoryPendingStartX = touch.clientX;
  inventoryPendingStartY = touch.clientY;
  inventoryPendingStartTime = performance.now();
}, { passive: true });

// Shared touchmove: handles long-press detection AND ghost movement
document.addEventListener("touchmove", (e: TouchEvent) => {
  if (touchDragActive && touchDragGhost) {
    e.preventDefault();
    const touch = e.touches[0];
    touchDragGhost.style.left = touch.clientX + "px";
    touchDragGhost.style.top = touch.clientY + "px";
    return;
  }

  // Hotbar long-press detection
  if (hotbarPendingSlot && !touchDragActive) {
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
      hotbarPendingSlot = null;
      hotbarPendingIndex = -1;
      touchStartTime = 0;
    } else if (performance.now() - touchStartTime >= 500) {
      e.preventDefault();
      const slot = hotbarPendingSlot;
      const idx = hotbarPendingIndex;
      hotbarPendingSlot = null;
      hotbarPendingIndex = -1;
      startTouchDrag("hotbar", slot, idx);
      touchDragGhost!.style.left = touch.clientX + "px";
      touchDragGhost!.style.top = touch.clientY + "px";
    }
  }

  // Inventory long-press detection
  if (inventoryPendingSlot && !touchDragActive) {
    const touch = e.touches[0];
    const dx = touch.clientX - inventoryPendingStartX;
    const dy = touch.clientY - inventoryPendingStartY;
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
      inventoryPendingSlot = null;
      inventoryPendingIndex = -1;
      inventoryPendingStartTime = 0;
    } else if (performance.now() - inventoryPendingStartTime >= 500) {
      e.preventDefault();
      const slot = inventoryPendingSlot;
      const idx = inventoryPendingIndex;
      inventoryPendingSlot = null;
      inventoryPendingIndex = -1;
      startTouchDrag("inventory", slot, idx);
      slot.style.opacity = "0.4";
      touchDragGhost!.style.left = touch.clientX + "px";
      touchDragGhost!.style.top = touch.clientY + "px";
    }
  }
}, { passive: false });

hotbar.addEventListener("touchend", () => {
  if (!touchDragActive) {
    hotbarPendingSlot = null;
    hotbarPendingIndex = -1;
    touchStartTime = 0;
  }
});

inventoryUI.addEventListener("touchend", () => {
  if (!touchDragActive) {
    if (inventoryPendingSlot) {
      inventoryPendingSlot.style.opacity = "1";
    }
    inventoryPendingSlot = null;
    inventoryPendingIndex = -1;
    inventoryPendingStartTime = 0;
  }
});

// Shared touchend for drop handling
document.addEventListener("touchend", (e: TouchEvent) => {
  if (!touchDragActive) return;

  const touch = (e as any).changedTouches?.[0] || { clientX: touchStartX, clientY: touchStartY };
  const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement;
  const hotbarSlot = target?.closest("#hotbar .slot") as HTMLDivElement;

  if (touchDragSource === "spellbook") {
    if (hotbarSlot && touchDragSpellName) {
      hotbarSlot.dataset.spellName = touchDragSpellName;
      hotbarSlot.innerHTML = "";
      hotbarSlot.classList.remove("empty");
      if (touchDragImageSrc) {
        const iconImage = new Image();
        iconImage.src = touchDragImageSrc;
        iconImage.draggable = false;
        hotbarSlot.appendChild(iconImage);
      } else {
        hotbarSlot.innerText = touchDragSpellName;
      }
      saveHotbarConfiguration();
    }
  } else if (touchDragSource === "hotbar") {
    if (hotbarSlot && touchDragSpellName) {
      const targetIndex = Array.from(hotbarSlots).indexOf(hotbarSlot);
      const targetSpellName = hotbarSlot.dataset.spellName || null;
      const targetImg = hotbarSlot.querySelector("img") as HTMLImageElement;
      const targetImageSrc = targetImg ? targetImg.src : null;

      hotbarSlot.dataset.spellName = touchDragSpellName;
      hotbarSlot.innerHTML = "";
      hotbarSlot.classList.remove("empty");
      if (touchDragImageSrc) {
        const iconImage = new Image();
        iconImage.src = touchDragImageSrc;
        iconImage.draggable = false;
        hotbarSlot.appendChild(iconImage);
      } else {
        hotbarSlot.innerText = touchDragSpellName;
      }

      if (touchDragSourceIndex !== targetIndex && touchDragSourceIndex >= 0) {
        const sourceSlot = hotbarSlots[touchDragSourceIndex];
        if (targetSpellName && targetSpellName !== touchDragSpellName) {
          sourceSlot.dataset.spellName = targetSpellName;
          sourceSlot.innerHTML = "";
          sourceSlot.classList.remove("empty");
          if (targetImageSrc) {
            const iconImage = new Image();
            iconImage.src = targetImageSrc;
            iconImage.draggable = false;
            sourceSlot.appendChild(iconImage);
          } else {
            sourceSlot.innerText = targetSpellName;
          }
        } else {
          sourceSlot.innerHTML = "";
          sourceSlot.classList.add("empty");
          delete sourceSlot.dataset.spellName;
        }
      }

      saveHotbarConfiguration();
    } else if (touchDragSourceIndex >= 0) {
      const sourceSlot = hotbarSlots[touchDragSourceIndex];
      sourceSlot.innerHTML = "";
      sourceSlot.classList.add("empty");
      delete sourceSlot.dataset.spellName;
      saveHotbarConfiguration();
    }
  } else if (touchDragSource === "inventory") {
    if (inventoryPendingSlot) {
      inventoryPendingSlot.style.opacity = "1";
    }
    const invTarget = target?.closest("#inventory .slot") as HTMLDivElement;
    const invSlots = inventoryGrid.querySelectorAll(".slot");
    const targetIndex = invTarget ? Array.from(invSlots).indexOf(invTarget) : -1;

    if (invTarget && targetIndex >= 0 && targetIndex !== touchDragSourceIndex && touchDragSpellName) {
      const sourceSlot = invSlots[touchDragSourceIndex] as HTMLDivElement;

      const targetItemName = invTarget.dataset.itemName || null;
      const targetItemType = invTarget.dataset.itemType || null;
      const targetEquipmentSlot = invTarget.dataset.equipmentSlot || null;
      const targetImg = invTarget.querySelector("img") as HTMLImageElement;
      const targetImgSrc = targetImg ? targetImg.src : null;
      const targetQuantityLabel = invTarget.querySelector(".quantity-label");
      const targetHTML = invTarget.innerHTML;
      const targetClasses = Array.from(invTarget.classList).filter(c => c !== "slot" && c !== "ui" && c !== "empty");

      invTarget.innerHTML = "";
      invTarget.className = "slot ui";
      if (targetQuantityLabel) {
        invTarget.classList.add("has-quantity");
      }

      const sourceImg = sourceSlot.querySelector("img") as HTMLImageElement;
      if (sourceImg) {
        const newImg = new Image();
        newImg.src = sourceImg.src;
        newImg.draggable = false;
        newImg.width = 32;
        newImg.height = 32;
        newImg.style.pointerEvents = "none";
        invTarget.appendChild(newImg);
      }

      const sourceQtyLabel = sourceSlot.querySelector(".quantity-label");
      if (sourceQtyLabel) {
        const newQtyLabel = sourceQtyLabel.cloneNode(true) as HTMLElement;
        newQtyLabel.style.pointerEvents = "none";
        invTarget.appendChild(newQtyLabel);
        invTarget.classList.add("has-quantity");
      }

      if (sourceSlot.dataset.itemName) invTarget.dataset.itemName = sourceSlot.dataset.itemName;
      if (sourceSlot.dataset.itemType) invTarget.dataset.itemType = sourceSlot.dataset.itemType;
      if (sourceSlot.dataset.equipmentSlot) invTarget.dataset.equipmentSlot = sourceSlot.dataset.equipmentSlot;
      Array.from(sourceSlot.classList).forEach(cls => {
        if (cls !== "slot" && cls !== "ui" && cls !== "empty") invTarget.classList.add(cls);
      });
      invTarget.classList.remove("empty");
      invTarget.draggable = true;

      removeItemTooltip(invTarget);
      setupItemTooltip(invTarget, () => {
        const itemName = invTarget.dataset.itemName;
        const cache = Cache.getInstance();
        if (!itemName || !cache.inventory) return null;
        return cache.inventory.find((invItem: any) => invItem.name === itemName);
      });

      sourceSlot.innerHTML = "";
      sourceSlot.className = "slot ui";

      if (targetItemName) {
        if (targetImgSrc) {
          const newImg = new Image();
          newImg.src = targetImgSrc;
          newImg.draggable = false;
          newImg.width = 32;
          newImg.height = 32;
          newImg.style.pointerEvents = "none";
          sourceSlot.appendChild(newImg);
        }

        const origQty = targetHTML.match(/<div class="quantity-label">([^<]+)<\/div>/);
        if (origQty) {
          const qtyDiv = document.createElement("div");
          qtyDiv.classList.add("quantity-label");
          qtyDiv.innerText = origQty[1];
          qtyDiv.style.pointerEvents = "none";
          sourceSlot.appendChild(qtyDiv);
          sourceSlot.classList.add("has-quantity");
        }

        sourceSlot.dataset.itemName = targetItemName;
        if (targetItemType) sourceSlot.dataset.itemType = targetItemType;
        if (targetEquipmentSlot) sourceSlot.dataset.equipmentSlot = targetEquipmentSlot;
        targetClasses.forEach(cls => sourceSlot.classList.add(cls));
        sourceSlot.classList.remove("empty");
        sourceSlot.draggable = true;

        removeItemTooltip(sourceSlot);
        setupItemTooltip(sourceSlot, () => {
          const itemName = sourceSlot.dataset.itemName;
          const cache = Cache.getInstance();
          if (!itemName || !cache.inventory) return null;
          return cache.inventory.find((invItem: any) => invItem.name === itemName);
        });
      } else {
        delete sourceSlot.dataset.itemName;
        delete sourceSlot.dataset.itemType;
        delete sourceSlot.dataset.equipmentSlot;
        sourceSlot.classList.add("empty");
        sourceSlot.draggable = false;
        removeItemTooltip(sourceSlot);
      }

      saveInventoryConfiguration();
    } else if (touchDragSourceIndex >= 0) {
      const sourceSlot = invSlots[touchDragSourceIndex] as HTMLDivElement;
      sourceSlot.style.opacity = "1";
    }
  }

  clearTouchDrag();
  touchDragJustEnded = true;
  setTimeout(() => { touchDragJustEnded = false; }, 100);
});

document.addEventListener("touchcancel", () => {
  clearTouchDrag();
});

function createPartyUI(partyMembers: string[], players?: any[]) {
  const partyContainer = document.getElementById("party-container");
  if (!partyContainer) return;

  if (partyMembers.length === 0) {
    const existingMembers = partyContainer.querySelectorAll(".party-member");
    existingMembers.forEach(member => partyContainer.removeChild(member));
    return;
  }

  const existingElements = Array.from(
    partyContainer.querySelectorAll(".party-member-username")
  );

  const existingNames = new Map<string, HTMLElement>();
  existingElements.forEach(el => {
    const name = el.textContent?.toLowerCase();
    if (name) {
      const container = el.closest(".party-member") as HTMLElement;
      if (container) {
        existingNames.set(name, container);
      }
    }
  });

  const desiredNames = new Set(partyMembers.map(name => name.toLowerCase()));

  for (const [name, el] of existingNames.entries()) {
    if (!desiredNames.has(name)) {
      partyContainer.removeChild(el);
    }
  }

  partyMembers.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  for (const member of partyMembers) {
    const lowerName = member.toLowerCase();
    if (!existingNames.has(lowerName)) {
      const memberElement = document.createElement("div");
      memberElement.className = "party-member ui";
      memberElement.dataset.username = lowerName;

      const usernameElement = document.createElement("div");
      usernameElement.className = "party-member-username ui";
      usernameElement.innerText = member.charAt(0).toUpperCase() + member.slice(1);

      const barsContainer = document.createElement("div");
      barsContainer.className = "party-member-bars ui";

      const healthBarContainer = document.createElement("div");
      healthBarContainer.className = "party-member-health-bar ui";
      const healthProgress = document.createElement("div");
      healthProgress.className = "party-member-health-progress ui green";
      healthProgress.style.setProperty("--health-scale", "1");
      healthBarContainer.appendChild(healthProgress);

      const staminaBarContainer = document.createElement("div");
      staminaBarContainer.className = "party-member-stamina-bar ui";
      const staminaProgress = document.createElement("div");
      staminaProgress.className = "party-member-stamina-progress ui";
      staminaProgress.style.setProperty("--stamina-scale", "1");
      staminaBarContainer.appendChild(staminaProgress);

      barsContainer.appendChild(healthBarContainer);
      barsContainer.appendChild(staminaBarContainer);

      memberElement.appendChild(usernameElement);
      memberElement.appendChild(barsContainer);
      partyContainer.appendChild(memberElement);

      if (players) {
        const playerData = players.find(p => p.username?.toLowerCase() === lowerName);
        if (playerData?.stats) {
          updatePartyMemberStats(
            member,
            playerData.stats.health,
            playerData.stats.total_max_health,
            playerData.stats.stamina,
            playerData.stats.total_max_stamina
          );
        }
      }
    }
  }
}

function createGuildUI(guildMembers: string[], guildNameValue: string | null) {
  const guildNameEl = document.getElementById("guild-name");
  if (!guildMembersList) return;

  if (!guildNameValue) {
    if (guildNameEl) guildNameEl.style.display = "none";
    if (guildRank) guildRank.style.display = "none";
    if (guildMemberCount) guildMemberCount.style.display = "none";
    if (guildMembersList) guildMembersList.style.display = "none";
    if (guildMemberInviteInput) guildMemberInviteInput.style.display = "none";
    if (guildMemberInviteButton) guildMemberInviteButton.style.display = "none";
    if (guildCreateSection) guildCreateSection.style.display = "block";

    const separator = document.getElementById("guild-header-separator");
    if (separator) separator.style.display = "none";

    const leaveButton = document.getElementById("guild-leave-button");
    if (leaveButton) leaveButton.style.display = "none";

    const existingMembers = guildMembersList.querySelectorAll(".guild-member");
    existingMembers.forEach(member => guildMembersList.removeChild(member));
    return;
  }

  if (guildCreateSection) guildCreateSection.style.display = "none";
  if (guildMembersList) guildMembersList.style.display = "block";

  const separator = document.getElementById("guild-header-separator");
  if (separator) separator.style.display = "block";

  if (guildNameEl) {
    guildNameEl.textContent = guildNameValue;
    guildNameEl.style.display = "block";
  }

  const currentPlayer = Array.from(Cache.getInstance().players)
    .find((p: any) => p.id === cachedPlayerId);

  const isLeader = guildMembers.length > 0
    && guildMembers[0].toLowerCase() === currentPlayer?.username?.toLowerCase();

  if (guildRank) {
    guildRank.textContent = isLeader ? "Guild Master" : "Member";
    guildRank.style.display = "block";
  }

  if (guildMemberCount) {
    guildMemberCount.textContent = `Members: ${guildMembers.length}`;
    guildMemberCount.style.display = "block";
  }

  if (guildMemberInviteInput && guildMemberInviteButton) {
    if (isLeader) {
      guildMemberInviteInput.style.display = "block";
      guildMemberInviteButton.style.display = "block";
    } else {
      guildMemberInviteInput.style.display = "none";
      guildMemberInviteButton.style.display = "none";
    }
  }

  const leaveButton = document.getElementById("guild-leave-button");
  if (leaveButton) {
    if (isLeader) {
      leaveButton.textContent = "Disband Guild";
      leaveButton.style.display = "block";
    } else {
      leaveButton.textContent = "Leave Guild";
      leaveButton.style.display = "block";
    }
  }

  const existingElements = Array.from(
    guildMembersList.querySelectorAll(".guild-member-username")
  );

  const existingNames = new Map<string, HTMLElement>();
  existingElements.forEach(el => {
    const name = el.textContent?.toLowerCase();
    if (name) {
      const container = el.closest(".guild-member") as HTMLElement;
      if (container) {
        existingNames.set(name, container);
      }
    }
  });

  const desiredNames = new Set(guildMembers.map(name => name.toLowerCase()));

  for (const [name, el] of existingNames.entries()) {
    if (!desiredNames.has(name)) {
      guildMembersList.removeChild(el);
    }
  }

  guildMembers.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  for (const member of guildMembers) {
    const lowerName = member.toLowerCase();
    if (!existingNames.has(lowerName)) {
      const memberElement = document.createElement("div");
      memberElement.className = "guild-member ui";
      memberElement.dataset.username = lowerName;

      const usernameElement = document.createElement("div");
      usernameElement.className = "guild-member-username ui";
      usernameElement.innerText = member.charAt(0).toUpperCase() + member.slice(1);

      const statusElement = document.createElement("span");
      statusElement.className = "guild-member-status ui";

      const cache = Cache.getInstance();
      const isOnline = cache.onlinePlayers.has(lowerName);
      statusElement.classList.add(isOnline ? "guild-online" : "guild-offline");

      memberElement.appendChild(usernameElement);
      memberElement.appendChild(statusElement);
      guildMembersList.appendChild(memberElement);
    }
  }
}

function updateGuildMemberOnlineStatus(username: string, isOnline: boolean) {
  if (!guildMembersList) return;
  const memberElement = guildMembersList.querySelector(
    `.guild-member[data-username="${username.toLowerCase()}"]`
  ) as HTMLElement;
  if (!memberElement) return;
  const statusElement = memberElement.querySelector(".guild-member-status") as HTMLElement;
  if (!statusElement) return;
  statusElement.classList.toggle("guild-online", isOnline);
  statusElement.classList.toggle("guild-offline", !isOnline);
}

function updatePartyMemberStats(username: string, health: number, maxHealth: number, stamina: number, maxStamina: number) {
  const partyContainer = document.getElementById("party-container");
  if (!partyContainer) return;

  const lowerUsername = username.toLowerCase();
  const memberElement = partyContainer.querySelector(
    `.party-member[data-username="${lowerUsername}"]`
  ) as HTMLElement;

  if (!memberElement) return;

  const healthProgress = memberElement.querySelector(".party-member-health-progress") as HTMLElement;
  const staminaProgress = memberElement.querySelector(".party-member-stamina-progress") as HTMLElement;

  if (healthProgress && maxHealth > 0) {
    const healthPercent = (health / maxHealth) * 100;
    const healthScale = Math.max(0, Math.min(1, health / maxHealth));
    healthProgress.style.setProperty("--health-scale", healthScale.toString());

    let colorClass = "green";
    if (healthPercent < 30) {
      colorClass = "red";
    } else if (healthPercent < 50) {
      colorClass = "orange";
    } else if (healthPercent < 80) {
      colorClass = "yellow";
    }

    const current = Array.from(healthProgress.classList).find(c =>
      ["green", "yellow", "orange", "red"].includes(c)
    );

    if (current !== colorClass) {
      healthProgress.classList.remove("green", "yellow", "orange", "red");
      healthProgress.classList.add(colorClass);
    }
  }

  if (staminaProgress && maxStamina > 0) {
    const staminaScale = Math.max(0, Math.min(1, stamina / maxStamina));
    staminaProgress.style.setProperty("--stamina-scale", staminaScale.toString());
  }
}

function updateHealthBar(bar: HTMLDivElement, healthPercent: number) {
  const xscale = Math.max(0, Math.min(1, healthPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });

  let colorClass = "green";
  if (healthPercent < 30) {
    colorClass = "red";
  } else if (healthPercent < 50) {
    colorClass = "orange";
  } else if (healthPercent < 80) {
    colorClass = "yellow";
  }

  const current = Array.from(bar.classList).find(c =>
    ["green", "yellow", "orange", "red"].includes(c)
  );

  if (current !== colorClass) {
    bar.classList.remove("green", "yellow", "orange", "red");
    bar.classList.add(colorClass);
  }

  if (!bar.classList.contains("ui")) {
    bar.classList.add("ui");
  }
}

function updateStaminaBar(bar: HTMLDivElement, staminaPercent: number) {
  const xscale = Math.max(0, Math.min(1, staminaPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });
}

function castSpell(id: string, spell: string, time: number) {
  spell = spell.toLowerCase();

  if (id !== cachedPlayerId) {
    const cache = Cache.getInstance();
    const player = Array.from(cache.players).find(p => p.id === id);

    if (player) {
      if (time === 0) {
        player.castingSpell = null;
        player.castingDuration = 0;
        player.castingInterrupted = false;
        return;
      }
      if (spell === 'interrupted' || spell === 'failed') {

        if (player.castingSpell && !player.castingInterrupted) {
          const elapsed = performance.now() - player.castingStartTime;
          player.castingInterruptedProgress = Math.min(elapsed / player.castingDuration, 1);
        } else {
          player.castingInterruptedProgress = 0;
        }

        player.castingSpell = spell.charAt(0).toUpperCase() + spell.slice(1);
        player.castingInterrupted = true;
        player.castingStartTime = performance.now();
        player.castingDuration = 1500;
      } else {

        const formattedSpell = spell.split('_').map(word =>
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');

        player.castingSpell = formattedSpell;
        player.castingStartTime = performance.now();
        player.castingDuration = time * 1000;
        player.castingInterrupted = false;
        player.castingInterruptedProgress = undefined;
      }
    }
    return;
  }

  if (time === 0) {
    if (activeCastbarClone) {
      activeCastbarClone.remove();
      activeCastbarClone = null;
    }
    const cache = Cache.getInstance();
    const localPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
    if (localPlayer) {
      localPlayer.castingSpell = null;
      localPlayer.castingDuration = 0;
      localPlayer.castingInterrupted = false;
    }
    return;
  }

  let currentProgress = 0;
  if (activeCastbarClone && (spell == 'interrupted' || spell == 'failed')) {
    if (spell == 'failed') {

      currentProgress = 1.0;
    } else {

      const cloneProgress = activeCastbarClone.querySelector("#castbar-progress") as HTMLDivElement;
      if (cloneProgress) {
        const animations = cloneProgress.getAnimations();
        for (const anim of animations) {
          if (anim.effect && (anim.effect as KeyframeEffect).getKeyframes().some((kf: any) => kf.transform)) {
            const currentTime = anim.currentTime as number;
            const duration = (anim.effect as AnimationEffect).getTiming().duration as number;
            if (currentTime && duration) {
              currentProgress = currentTime / duration;
            }
            break;
          }
        }
      }
    }
  }

  if (activeCastbarClone) {
    activeCastbarClone.remove();
    activeCastbarClone = null;
  }

  if (spell == 'interrupted' || spell == 'failed') {

    const cache = Cache.getInstance();
    const localPlayer = Array.from(cache.players).find(p => p.id === cachedPlayerId);
    if (localPlayer) {
      if (!localPlayer.castingInterrupted) {
        const elapsed = performance.now() - localPlayer.castingStartTime;
        localPlayer.castingInterruptedProgress = Math.min(elapsed / localPlayer.castingDuration, 1);
      }
      localPlayer.castingSpell = spell.charAt(0).toUpperCase() + spell.slice(1);
      localPlayer.castingInterrupted = true;
      localPlayer.castingStartTime = performance.now();
      localPlayer.castingDuration = 1500;
    }

    const interruptClone = castbar.cloneNode(true) as HTMLDivElement;
    interruptClone.id = "castbar-active-clone";

    interruptClone.style.display = "block";
    interruptClone.style.position = "fixed";
    interruptClone.style.zIndex = "100";

    const children = interruptClone.children;
    const clonedProgress = children[0] as HTMLDivElement;
    const clonedText = children[1] as HTMLDivElement;

    if (clonedProgress && clonedText) {

      clonedProgress.style.transform = `scaleX(${currentProgress})`;
      clonedProgress.style.transformOrigin = 'left';

      if (spell === 'failed') {
        clonedProgress.style.background = 'linear-gradient(180deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)';
        clonedProgress.style.boxShadow = '0 0 20px rgba(239, 68, 68, 0.6), inset 0 2px 4px rgba(255, 255, 255, 0.2), inset 0 -2px 4px rgba(0, 0, 0, 0.3)';
      } else {
        clonedProgress.style.background = 'linear-gradient(180deg, #9ca3af 0%, #6b7280 50%, #4b5563 100%)';
        clonedProgress.style.boxShadow = '0 0 15px rgba(107, 114, 128, 0.4), inset 0 2px 4px rgba(255, 255, 255, 0.15), inset 0 -2px 4px rgba(0, 0, 0, 0.3)';
      }
      clonedText.innerText = spell;

      clonedProgress.getAnimations().forEach(anim => anim.cancel());
    }

    castbar.parentNode?.insertBefore(interruptClone, castbar.nextSibling);
    activeCastbarClone = interruptClone;

    setTimeout(() => {
      if (activeCastbarClone === interruptClone) {
        interruptClone.remove();
        activeCastbarClone = null;
      }
    }, 1500);

    return;
  }

  const castClone = castbar.cloneNode(true) as HTMLDivElement;
  castClone.id = "castbar-active-clone";

  const children = castClone.children;
  const clonedProgress = children[0] as HTMLDivElement;
  const clonedText = children[1] as HTMLDivElement;

  if (clonedProgress && clonedText) {

    castClone.style.display = "block";
    castClone.style.position = "fixed";
    castClone.style.zIndex = "100";

    clonedProgress.style.transform = 'scaleX(0)';
    clonedProgress.style.transformOrigin = 'left';
    clonedProgress.style.background = '';

    const formattedSpell = spell.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    clonedText.innerText = formattedSpell;

    const timeMs = time * 1000;

    clonedProgress.animate([
      { transform: 'scaleX(0)' },
      { transform: 'scaleX(1)' }
    ], {
      duration: timeMs,
      fill: 'forwards'
    });

    castbar.parentNode?.insertBefore(castClone, castbar.nextSibling);
    activeCastbarClone = castClone;

    setTimeout(() => {
      if (activeCastbarClone === castClone) {
        castClone.remove();
        activeCastbarClone = null;
      }
    }, timeMs + 100);
  }
}

function saveInventoryConfiguration() {
  const inventoryConfig: { [key: string]: string | null } = {};
  const inventorySlots = inventoryGrid.querySelectorAll(".slot");

  inventorySlots.forEach((slot, index) => {
    const itemName = (slot as HTMLElement).dataset.itemName;
    inventoryConfig[index.toString()] = itemName || null;
  });

  sendRequest({
    type: "SAVE_INVENTORY_CONFIG",
    data: inventoryConfig
  });
}

async function loadInventoryConfiguration(inventoryConfig: any, inventoryData: any[]) {

  const itemMap: { [key: string]: any } = {};
  inventoryData.forEach(item => {
    itemMap[item.name] = item;
  });

  const sortedInventory: any[] = [];
  const usedItems = new Set<string>();

  Object.keys(inventoryConfig).sort((a, b) => parseInt(a) - parseInt(b)).forEach(index => {
    const itemName = inventoryConfig[index];
    if (itemName && itemMap[itemName] && !usedItems.has(itemName)) {
      sortedInventory.push(itemMap[itemName]);
      usedItems.add(itemName);
    }
  });

  inventoryData.forEach(item => {
    if (!usedItems.has(item.name)) {
      sortedInventory.push(item);
    }
  });

  return sortedInventory;
}

async function loadHotbarConfiguration(hotbarConfig: any) {

  const waitForSpellbookImages = async (maxAttempts = 50, delayMs = 100) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const spellbookSpells = document.querySelectorAll("#spell-book-container #grid .slot") as NodeListOf<HTMLDivElement>;
      const imagesExist = Array.from(spellbookSpells).some(slot => slot.querySelector("img"));

      if (imagesExist) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return false;
  };

  await waitForSpellbookImages();

  const spellbookSpells = document.querySelectorAll("#spell-book-container #grid .slot") as NodeListOf<HTMLDivElement>;
  const spellImageMap: { [key: string]: string } = {};

  spellbookSpells.forEach(slot => {
    const spellName = slot.dataset.spellName;
    const img = slot.querySelector("img") as HTMLImageElement;
    if (spellName && img) {
      spellImageMap[spellName] = img.src;
    }
  });

  hotbarSlots.forEach((slot, index) => {
    const slotData = hotbarConfig[index.toString()];

    const spellName = typeof slotData === 'string' ? slotData : slotData?.name;

    if (spellName) {

      slot.dataset.spellName = spellName;

      slot.innerHTML = "";

      const imageSrc = spellImageMap[spellName];
      if (imageSrc) {
        const iconImage = new Image();
        iconImage.src = imageSrc;
        iconImage.draggable = false;
        slot.appendChild(iconImage);
      } else {

        slot.innerText = spellName;
      }
    } else {

      delete slot.dataset.spellName;
      slot.innerHTML = "";
    }
  });
}

const adminPlayerSelect = document.getElementById("admin-player-select") as HTMLSelectElement;
const adminNoclipButton = document.getElementById("admin-noclip");
const adminStealthButton = document.getElementById("admin-stealth");
const adminSummonButton = document.getElementById("admin-summon");
const adminTeleportButton = document.getElementById("admin-teleport");
const adminKickButton = document.getElementById("admin-kick");
const adminBanButton = document.getElementById("admin-ban");
const adminUnbanButton = document.getElementById("admin-unban");
const adminRespawnButton = document.getElementById("admin-respawn");
const adminToggleAdminButton = document.getElementById("admin-toggle-admin");
const adminMapInput = document.getElementById("admin-map-input") as HTMLInputElement;
const adminReloadMapButton = document.getElementById("admin-reload-map");
const adminWarpInput = document.getElementById("admin-warp-input") as HTMLInputElement;
const adminWarpButton = document.getElementById("admin-warp");
const adminBroadcastInput = document.getElementById("admin-broadcast-input") as HTMLInputElement;
const adminBroadcastAllButton = document.getElementById("admin-broadcast-all");
const adminBroadcastMapButton = document.getElementById("admin-broadcast-map");
const adminBroadcastAdminsButton = document.getElementById("admin-broadcast-admins");

function updateAdminMapInput() {
  if (!adminMapInput) return;

  if ((window as any).mapData && (window as any).mapData.name) {
    const mapName = (window as any).mapData.name;

    const displayName = mapName.replace(/\.json$/i, '');
    adminMapInput.placeholder = `Current map: ${displayName}`;
  }
}

function updateAdminPlayerListWithData(players: Array<{ username: string; map: string; isAdmin: boolean }>) {
  if (!adminPlayerSelect) return;

  const currentSelection = adminPlayerSelect.value;

  adminPlayerSelect.innerHTML = '<option value="">Select a player...</option>';

  players.forEach((player) => {
    if (player.username) {
      const option = document.createElement("option");
      option.value = player.username;
      const adminBadge = player.isAdmin ? " [Admin]" : "";
      option.textContent = `${player.username} (${player.map})${adminBadge}`;
      adminPlayerSelect.appendChild(option);
    }
  });

  if (currentSelection) {
    const exists = players.some((p) => p.username === currentSelection);
    if (exists) {
      adminPlayerSelect.value = currentSelection;
    }
  }
}


function getSelectedPlayer(): string {
  return adminPlayerSelect?.value || "";
}

function sendAdminCommand(command: string, args: string[] = []) {
  const fullCommand = args.length > 0 ? `${command} ${args.join(" ")}` : command;
  sendRequest({
    type: "COMMAND",
    data: { command: fullCommand }
  });
}

function showAdminNotification(message: string) {
  if (!notificationContainer || !notificationMessage) return;
  notificationMessage.innerText = message;
  notificationContainer.style.display = "flex";
  setTimeout(() => {
    if (notificationContainer) {
      notificationContainer.style.display = "none";
    }
  }, 3000);
}

if (adminNoclipButton) {
  adminNoclipButton.addEventListener("click", () => {
    sendRequest({ type: "NOCLIP", data: null });
  });
}

if (adminStealthButton) {
  adminStealthButton.addEventListener("click", () => {
    sendRequest({ type: "STEALTH", data: null });
  });
}

if (adminSummonButton) {
  adminSummonButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("summon", [player]);
  });
}

if (adminTeleportButton) {
  adminTeleportButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("teleport", [player]);
  });
}

if (adminKickButton) {
  adminKickButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("kick", [player]);
  });
}

if (adminBanButton) {
  adminBanButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("ban", [player]);
  });
}

if (adminUnbanButton) {
  adminUnbanButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("unban", [player]);
  });
}

if (adminRespawnButton) {
  adminRespawnButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("respawn", [player]);
  });
}

if (adminToggleAdminButton) {
  adminToggleAdminButton.addEventListener("click", () => {
    const player = getSelectedPlayer();
    if (!player) {
      showAdminNotification("Please select a player first");
      return;
    }
    sendAdminCommand("setadmin", [player]);
  });
}

if (adminReloadMapButton) {
  adminReloadMapButton.addEventListener("click", () => {

    let mapName = adminMapInput?.value.trim();

    if (!mapName) {

      if ((window as any).mapData && (window as any).mapData.name) {
        mapName = (window as any).mapData.name.replace(/\.json$/i, '');
      }
    }

    if (!mapName) {
      showAdminNotification("Unable to determine map name");
      return;
    }

    sendAdminCommand("reloadmap", [mapName]);
  });
}

if (adminWarpButton) {
  adminWarpButton.addEventListener("click", () => {
    const mapName = adminWarpInput?.value.trim();

    if (!mapName) {
      showAdminNotification("Please enter a map name to warp to");
      return;
    }

    sendAdminCommand("warp", [mapName]);

    if (adminWarpInput) {
      adminWarpInput.value = "";
    }
  });
}

if (adminBroadcastAllButton) {
  adminBroadcastAllButton.addEventListener("click", () => {
    const message = adminBroadcastInput?.value.trim();
    if (!message) {
      showAdminNotification("Please enter a message");
      return;
    }
    sendAdminCommand("broadcast", ["ALL", message]);
    adminBroadcastInput.value = "";
  });
}

if (adminBroadcastMapButton) {
  adminBroadcastMapButton.addEventListener("click", () => {
    const message = adminBroadcastInput?.value.trim();
    if (!message) {
      showAdminNotification("Please enter a message");
      return;
    }
    sendAdminCommand("broadcast", ["MAP", message]);
    adminBroadcastInput.value = "";
  });
}

if (adminBroadcastAdminsButton) {
  adminBroadcastAdminsButton.addEventListener("click", () => {
    const message = adminBroadcastInput?.value.trim();
    if (!message) {
      showAdminNotification("Please enter a message");
      return;
    }
    sendAdminCommand("broadcast", ["ADMINS", message]);
    adminBroadcastInput.value = "";
  });
}

if (guildMemberInviteButton) {
  guildMemberInviteButton.addEventListener("click", () => {
    const username = guildMemberInviteInput?.value.trim();
    if (!username) return;
    const cache = Cache.getInstance();
    const targetPlayer = Array.from(cache.players).find(
      (p: any) => p.username?.toLowerCase() === username.toLowerCase()
    );
    if (!targetPlayer) return;
    sendRequest({
      type: "INVITE_GUILD",
      data: { id: targetPlayer.id },
    });
    guildMemberInviteInput.value = "";
  });
}

const guildLeaveButton = document.getElementById("guild-leave-button");
if (guildLeaveButton) {
  guildLeaveButton.addEventListener("click", () => {
    const currentPlayer = Array.from(Cache.getInstance().players).find((p: any) => p.id === cachedPlayerId);
    const isLeader = currentPlayer?.guild?.length > 0
      && currentPlayer?.guild?.[0]?.toLowerCase() === currentPlayer?.username?.toLowerCase();

    if (isLeader) {
      const existing = document.getElementById("guild-confirm-popup");
      if (existing) existing.remove();

      const popup = document.createElement("div");
      popup.id = "guild-confirm-popup";
      popup.className = "popup";
      popup.innerHTML = `
        <h2>Disband Guild</h2>
        <p>Are you sure you want to disband "${currentPlayer.guild_name}"? This cannot be undone.</p>
        <div class="button-container">
          <button id="confirm-disband">Disband</button>
          <button id="cancel-disband">Cancel</button>
        </div>
      `;
      document.body.appendChild(popup);

      document.getElementById("confirm-disband")?.addEventListener("click", () => {
        sendRequest({ type: "DISBAND_GUILD", data: null });
        popup.remove();
      });

      document.getElementById("cancel-disband")?.addEventListener("click", () => {
        popup.remove();
      });
    } else {
      sendRequest({ type: "LEAVE_GUILD", data: null });
    }
  });
}

if (guildCreateButton) {
  guildCreateButton.addEventListener("click", () => {
    const name = guildCreateInput?.value.trim();
    if (!name) return;
    sendRequest({
      type: "CREATE_GUILD",
      data: { name },
    });
    guildCreateInput.value = "";
  });
}

export {
    toggleUI, toggleDebugContainer, handleStatsUI, createPartyUI, createGuildUI, updateGuildMemberOnlineStatus, updatePartyMemberStats, updateHealthBar, updateStaminaBar, castSpell, positionText,
    friendsListUI, inventoryUI, spellBookUI, pauseMenu, menuElements, chatInput, canvas, ctx, fpsSlider, healthBar,
    staminaBar, xpBar, musicSlider, effectsSlider, mutedCheckbox, statUI, overlay,
    packetsSentReceived, optionsMenu, friendsList, friendsListSearch, onlinecount, progressBar, progressBarContainer,
    inventoryGrid, chatMessages, loadingScreen, usernameLabel, levelLabel, healthLabel, manaLabel, damageLabel, armorLabel, critChanceLabel, critDamageLabel, avoidanceLabel, notificationContainer, notificationMessage,
    serverTime, ambience, weatherCanvas, weatherCtx, guildContainer, guildName, guildRank, guildMembersList,
    guildMemberCount, guildMemberInviteInput, guildMemberInviteButton, collisionDebugCheckbox, chunkOutlineDebugCheckbox,
    collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, astarDebugCheckbox, loadedChunksText, collectablesUI,
    hotbarSlots, saveHotbarConfiguration, loadHotbarConfiguration, equipmentLeftColumn, equipmentRightColumn, equipmentBottomCenter,
    saveInventoryConfiguration, loadInventoryConfiguration, setupInventorySlotHandlers, updateCurrencyDisplay, adminPanelContainer,
    updateAdminMapInput, updateAdminPlayerListWithData,
};

function updateCurrencyDisplay() {
  const cache = Cache.getInstance();

  if (!cachedPlayerId) return;

  const currentPlayer = Array.from(cache.players).find(
    (p) => p.id === cachedPlayerId
  );

  if (!currentPlayer || !currentPlayer.currency) return;

  const goldElement = document.getElementById("currency-gold");
  const silverElement = document.getElementById("currency-silver");
  const copperElement = document.getElementById("currency-copper");

  if (goldElement) goldElement.textContent = currentPlayer.currency.gold.toString();
  if (silverElement) silverElement.textContent = currentPlayer.currency.silver.toString();
  if (copperElement) copperElement.textContent = currentPlayer.currency.copper.toString();
}

function setupInventorySlotHandlers() {
  const inventorySlots = inventoryGrid.querySelectorAll(".slot") as NodeListOf<HTMLDivElement>;

  inventorySlots.forEach((slot, index) => {

    slot.addEventListener("dblclick", () => {
      if (slot.dataset.itemType === "equipment" && slot.dataset.itemName) {
        hideItemTooltip();
        sendRequest({
          type: "EQUIP_ITEM",
          data: { item: slot.dataset.itemName, slotIndex: index },
        });
      }
    });

    // Touch double-tap for mobile (dblclick unreliable on touch devices)
    let lastTapTime = 0;
    slot.addEventListener("touchend", (e) => {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        e.preventDefault();
        if (slot.dataset.itemType === "equipment" && slot.dataset.itemName) {
          hideItemTooltip();
          sendRequest({
            type: "EQUIP_ITEM",
            data: { item: slot.dataset.itemName, slotIndex: index },
          });
        }
      }
      lastTapTime = now;
    });

    slot.addEventListener("dragstart", (event: DragEvent) => {
      if (!slot.draggable) {
        event.preventDefault();
        return;
      }

      hideItemTooltip();

      if (event.dataTransfer) {
        event.dataTransfer.setData("inventory-rearrange-index", index.toString());

        const itemName = slot.dataset.itemName;
        if (itemName) {
          event.dataTransfer.setData("inventory-item-name", itemName);
        }

        if (slot.dataset.itemType === "equipment" && slot.dataset.equipmentSlot) {
          event.dataTransfer.setData("equipment-slot", slot.dataset.equipmentSlot);
        }

        event.dataTransfer.effectAllowed = "move";
        slot.style.opacity = "0.5";
      }
    });

    slot.addEventListener("dragend", () => {
      slot.style.opacity = "1";
    });

    slot.addEventListener("dragover", (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        if (event.dataTransfer.types.includes("inventory-rearrange-index") ||
            event.dataTransfer.types.includes("equipped-item-slot")) {
          event.dataTransfer.dropEffect = "move";
          slot.style.border = "2px solid white";
        }
      }
    });

    slot.addEventListener("dragleave", () => {
      slot.style.border = "";
    });

    slot.addEventListener("drop", (event: DragEvent) => {
      event.preventDefault();
      slot.style.border = "";

      if (event.dataTransfer) {

        const equippedItemSlot = event.dataTransfer.getData("equipped-item-slot");
        const equippedItemName = event.dataTransfer.getData("equipped-item-name");

        if (equippedItemSlot && equippedItemName) {

          sendRequest({
            type: "UNEQUIP_ITEM",
            data: { slot: equippedItemSlot, targetSlotIndex: index },
          });
          return;
        }

        const sourceIndex = event.dataTransfer.getData("inventory-rearrange-index");

        if (sourceIndex !== "" && sourceIndex !== index.toString()) {
          const sourceSlot = inventorySlots[parseInt(sourceIndex)];

          const targetItemName = slot.dataset.itemName;
          const targetItemType = slot.dataset.itemType;
          const targetEquipmentSlot = slot.dataset.equipmentSlot;
          const targetImg = slot.querySelector("img") as HTMLImageElement;
          const targetImgSrc = targetImg ? targetImg.src : null;
          const targetHTML = slot.innerHTML;
          const targetClasses = Array.from(slot.classList).filter(c => c !== "slot" && c !== "ui");

          slot.innerHTML = "";
          slot.className = "slot ui";

          const sourceImg = sourceSlot.querySelector("img") as HTMLImageElement;
          if (sourceImg) {
            const newImg = new Image();
            newImg.src = sourceImg.src;
            newImg.draggable = false;
            newImg.width = 32;
            newImg.height = 32;
            newImg.style.pointerEvents = "none";
            slot.appendChild(newImg);
          }

          const sourceQuantityLabel = sourceSlot.querySelector(".quantity-label");
          if (sourceQuantityLabel) {
            const newQuantityLabel = sourceQuantityLabel.cloneNode(true) as HTMLElement;
            newQuantityLabel.style.pointerEvents = "none";
            slot.appendChild(newQuantityLabel);
          }

          if (sourceSlot.dataset.itemName) slot.dataset.itemName = sourceSlot.dataset.itemName;
          if (sourceSlot.dataset.itemType) slot.dataset.itemType = sourceSlot.dataset.itemType;
          if (sourceSlot.dataset.equipmentSlot) slot.dataset.equipmentSlot = sourceSlot.dataset.equipmentSlot;

          Array.from(sourceSlot.classList).forEach(cls => {
            if (cls !== "slot" && cls !== "ui") slot.classList.add(cls);
          });

          slot.draggable = true;

          const cache = Cache.getInstance();
          removeItemTooltip(slot);
          setupItemTooltip(slot, () => {
            const itemName = slot.dataset.itemName;
            if (!itemName || !cache.inventory) return null;
            return cache.inventory.find((invItem: any) => invItem.name === itemName);
          });

          sourceSlot.innerHTML = "";
          sourceSlot.className = "slot ui";

          if (targetItemName) {

            if (targetImgSrc) {
              const newImg = new Image();
              newImg.src = targetImgSrc;
              newImg.draggable = false;
              newImg.width = 32;
              newImg.height = 32;
              newImg.style.pointerEvents = "none";
              sourceSlot.appendChild(newImg);

              const targetQuantityLabel = document.createElement("div");
              const origQuantityLabel = targetHTML.match(/<div class="quantity-label">([^<]+)<\/div>/);
              if (origQuantityLabel) {
                targetQuantityLabel.classList.add("quantity-label");
                targetQuantityLabel.innerText = origQuantityLabel[1];
                targetQuantityLabel.style.pointerEvents = "none";
                sourceSlot.appendChild(targetQuantityLabel);
              }
            }

            if (targetItemName) sourceSlot.dataset.itemName = targetItemName;
            if (targetItemType) sourceSlot.dataset.itemType = targetItemType;
            if (targetEquipmentSlot) sourceSlot.dataset.equipmentSlot = targetEquipmentSlot;

            targetClasses.forEach(cls => sourceSlot.classList.add(cls));
            sourceSlot.draggable = true;

            removeItemTooltip(sourceSlot);
            setupItemTooltip(sourceSlot, () => {
              const itemName = sourceSlot.dataset.itemName;
              if (!itemName || !cache.inventory) return null;
              return cache.inventory.find((invItem: any) => invItem.name === itemName);
            });
          } else {

            delete sourceSlot.dataset.itemName;
            delete sourceSlot.dataset.itemType;
            delete sourceSlot.dataset.equipmentSlot;
            sourceSlot.classList.add("empty");
            sourceSlot.draggable = false;

            removeItemTooltip(sourceSlot);
          }

          saveInventoryConfiguration();
        }
      }
    });
  });
}