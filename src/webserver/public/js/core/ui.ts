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
const ctx = canvas.getContext("2d");
const fpsSlider = document.getElementById("fps-slider") as HTMLInputElement;
const healthBar = document.getElementById("health-progress-bar") as HTMLDivElement;
const staminaBar = document.getElementById("stamina-progress-bar") as HTMLDivElement;
const xpBar = document.getElementById("xp-bar") as HTMLDivElement;
const levelContainer = document.getElementById("level-container") as HTMLDivElement;
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

hotbarSlots.forEach((slot, index) => {
  slot.addEventListener("click", (event) => {
    event.preventDefault();
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

function toggleUI(element: HTMLElement, toggleFlag: boolean, hidePosition: number) {
  element.style.transition = "1s";
  element.style.right = toggleFlag ? hidePosition.toString() : "10";
  return !toggleFlag;
}

function toggleDebugContainer() {
  debugContainer.style.display = debugContainer.style.display === "block" ? "none" : "block";
}

function handleStatsUI() {

  if (statUI.style.left === "10px") {

    statUI.style.transition = "1s";
    statUI.style.left = "-600px";
  } else {

    sendRequest({ type: "INSPECTPLAYER", data: null });
  }
}

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

    const interruptClone = castbar.cloneNode(true) as HTMLDivElement;
    interruptClone.id = "castbar-active-clone";

    interruptClone.style.display = "block";
    interruptClone.style.position = "fixed";
    interruptClone.style.bottom = "200px";
    interruptClone.style.left = "50%";
    interruptClone.style.transform = "translateX(-50%)";
    interruptClone.style.width = "300px";
    interruptClone.style.height = "25px";
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
    castClone.style.bottom = "200px";
    castClone.style.left = "50%";
    castClone.style.transform = "translateX(-50%)";
    castClone.style.width = "300px";
    castClone.style.height = "25px";
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

export {
    toggleUI, toggleDebugContainer, handleStatsUI, createPartyUI, updatePartyMemberStats, updateHealthBar, updateStaminaBar, castSpell, positionText,
    friendsListUI, inventoryUI, spellBookUI, pauseMenu, menuElements, chatInput, canvas, ctx, fpsSlider, healthBar,
    staminaBar, xpBar, levelContainer, musicSlider, effectsSlider, mutedCheckbox, statUI, overlay,
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