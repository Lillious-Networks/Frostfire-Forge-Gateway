import.meta.hot.accept;
import { config } from "../web/global.js";
const version = config?.VERSION;
import "./events.ts";
import pako from "../libs/pako.js";
import packet from "./packetencoder.ts";
import Cache from "./cache.ts";
import { updateTime } from "./ambience.ts";
import { setWeatherType } from "./renderer.ts";
import { setupItemTooltip, removeItemTooltip, hideItemTooltip } from "./tooltip.ts";
const cache = Cache.getInstance();

// Global particle registry for resolving particle names to definitions
const particleRegistry: Map<string, any> = new Map();

// Helper function to ensure particle has all required properties
function normalizeParticle(particle: any): any {
  return {
    name: particle.name || 'unknown',
    size: particle.size !== undefined ? particle.size : 5,
    color: particle.color || '#ffffff',
    velocity: particle.velocity || { x: 0, y: 0 },
    lifetime: particle.lifetime !== undefined ? particle.lifetime : 1000,
    scale: particle.scale !== undefined ? particle.scale : 1,
    opacity: particle.opacity !== undefined ? particle.opacity : 1,
    visible: particle.visible !== false,
    gravity: particle.gravity || { x: 0, y: 0 },
    localposition: particle.localposition || { x: 0, y: 0 },
    interval: particle.interval !== undefined ? particle.interval : 10,
    amount: particle.amount !== undefined ? particle.amount : 1,
    staggertime: particle.staggertime !== undefined ? particle.staggertime : 0,
    currentLife: particle.currentLife || null,
    initialVelocity: particle.initialVelocity || null,
    spread: particle.spread || { x: 0, y: 0 },
    weather: particle.weather || 'none',
    affected_by_weather: particle.affected_by_weather || false,
    zIndex: particle.zIndex !== undefined ? particle.zIndex : 0
  };
}

// Helper function to resolve particle names to full definitions
function resolveParticles(particles: any[]): any[] {
  if (!Array.isArray(particles)) return [];

  return particles.map((p: any) => {
    // If it's already a full object with properties, normalize it
    if (typeof p === 'object' && p !== null && p.name && p.size !== undefined) {
      return normalizeParticle(p);
    }
    // If it's a string, look up the full definition
    if (typeof p === 'string') {
      const definition = particleRegistry.get(p);
      if (definition) {
        return normalizeParticle(definition);
      }
      // Create default particle for unknown name
      return normalizeParticle({ name: p });
    }
    // If it's an object with a name property, look it up
    if (typeof p === 'object' && p !== null && p.name && typeof p.name === 'string') {
      const definition = particleRegistry.get(p.name);
      if (definition) {
        return normalizeParticle(definition);
      }
      return normalizeParticle(p);
    }
    // Return normalized particle
    return normalizeParticle(p);
  });
}
import { createPlayer } from "./player.ts";
import { updateFriendsList } from "./friends.ts";
import { createInvitationPopup } from "./invites.ts";
import { updateFriendOnlineStatus } from "./friends.js";
import loadMap from "./map.ts";
import {
  createPartyUI,
  updatePartyMemberStats,
  positionText,
  fpsSlider,
  musicSlider,
  effectsSlider,
  mutedCheckbox,
  statUI,
  packetsSentReceived,
  onlinecount,
  progressBarContainer,
  inventoryGrid,
  chatMessages,
  usernameLabel,
  levelLabel,
  healthLabel,
  manaLabel,
  damageLabel,
  armorLabel,
  critChanceLabel,
  critDamageLabel,
  avoidanceLabel,
  notificationContainer,
  notificationMessage,
  collectablesUI,
  castSpell,
  spellBookUI,
  loadHotbarConfiguration,
  hotbarSlots,
  equipmentLeftColumn,
  equipmentRightColumn,
  equipmentBottomCenter,
  setupInventorySlotHandlers,
  updateCurrencyDisplay,
  updateAdminMapInput,
  updateAdminPlayerListWithData,
} from "./ui.ts";
import { updateXp } from "./xp.ts";
import { createNPC, reinitNpcSprite } from "./npc.ts";
import parseAPNG from "../libs/apng_parser.js";
import { getCookie } from "./cookies.ts";
import { createCachedImage } from "./images.ts";

let socket: WebSocket;

let sentRequests: number = 0,
  receivedResponses: number = 0;

let clearNotificationTimeout: any = null;

function sendRequest(data: any) {
  sentRequests++;
  socket.send(packet.encode(JSON.stringify(data)));
}

// Make sendRequest available globally for dynamically imported modules
(window as any).sendRequest = sendRequest;

const pendingMapChunkRequests = new Map<string, {resolve: (data: any) => void, reject: (error: Error) => void}>();
const pendingTilesetRequests = new Map<string, {resolve: (data: any) => void, reject: (error: Error) => void}>();

const tilesetChunks = new Map<string, {chunks: string[], totalChunks: number, received: number}>();

let loadPlayersProcessing = false;
const loadPlayersQueue: any[] = [];

// Global item cache for looking up item details by name
const itemsByName = new Map<string, any>();

export function requestMapChunkViaWS(mapName: string, chunkX: number, chunkY: number, chunkSize: number): Promise<any> {
  return new Promise((resolve, reject) => {

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }

    const chunkKey = `${chunkX}-${chunkY}`;
    pendingMapChunkRequests.set(chunkKey, { resolve, reject });

    sendRequest({
      type: "REQUEST_MAP_CHUNK",
      data: { map: mapName, x: chunkX, y: chunkY, size: chunkSize }
    });

    setTimeout(() => {
      if (pendingMapChunkRequests.has(chunkKey)) {
        pendingMapChunkRequests.delete(chunkKey);
        reject(new Error("Map chunk request timeout"));
      }
    }, 10000);
  });
}

export function requestTilesetViaWS(tilesetName: string): Promise<any> {
  return new Promise((resolve, reject) => {

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }

    pendingTilesetRequests.set(tilesetName, { resolve, reject });

    sendRequest({
      type: "REQUEST_TILESET",
      data: { name: tilesetName }
    });

    setTimeout(() => {
      if (pendingTilesetRequests.has(tilesetName)) {
        pendingTilesetRequests.delete(tilesetName);
        reject(new Error("Tileset request timeout"));
      }
    }, 60000);
  });
}

let cachedPlayerId: string | null = null;
let sessionActive: boolean = false;

let snapshotRevision: number | null = null;
let snapshotApplied: boolean = false;
let animationUpdateBuffer: Array<{id: string, name: string, data: any, revision: number}> = [];
let pendingMovements: Array<{id: string, _data: any, revision: number}> = [];

const setupEquipmentSlotHandlers = () => {
  const allEquipmentSlots = [
    ...equipmentLeftColumn.querySelectorAll(".slot"),
    ...equipmentRightColumn.querySelectorAll(".slot"),
    ...equipmentBottomCenter.querySelectorAll(".slot"),
  ];

  allEquipmentSlots.forEach((slot) => {
    const slotType = slot.getAttribute("data-slot");

    slot.addEventListener("dragover", (event: Event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) {

        if (dragEvent.dataTransfer.types.includes("equipment-slot")) {

          dragEvent.dataTransfer.dropEffect = "move";
          (slot as HTMLElement).style.border = "2px solid white";
        } else {
          dragEvent.dataTransfer.dropEffect = "none";
        }
      }
    });

    slot.addEventListener("dragleave", () => {
      (slot as HTMLElement).style.border = "";
    });

    slot.addEventListener("drop", (event: Event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      (slot as HTMLElement).style.border = "";

      if (dragEvent.dataTransfer) {
        const itemName = dragEvent.dataTransfer.getData("inventory-item-name");
        const itemSlot = dragEvent.dataTransfer.getData("equipment-slot");
        const slotIndex = dragEvent.dataTransfer.getData("inventory-rearrange-index");

        if (itemName && itemSlot === slotType) {
          sendRequest({
            type: "EQUIP_ITEM",
            data: { item: itemName, slotIndex: slotIndex ? parseInt(slotIndex) : undefined },
          });
        }
      }
    });
  });
};

async function connectThroughGateway(): Promise<WebSocket | undefined> {

  let connectionToken;
  try {
    const tokenResponse = await fetch('/api/gateway/connection-token');
    if (!tokenResponse.ok) {
      throw new Error('Failed to obtain connection token from gateway');
    }
    connectionToken = await tokenResponse.json();
  } catch (error) {
    console.error("Error obtaining connection token:", error);
  }

  const selectedServerId = localStorage.getItem('selectedServerId');

  if (selectedServerId) {

    try {

      const response = await fetch('/api/gateway/servers');
      if (!response.ok) {
        throw new Error('Failed to fetch server list');
      }

      const data = await response.json();
      const server = data.servers.find((s: any) => s.id === selectedServerId);

      if (server) {

        const wsProtocol = server.useSSL ? 'wss://' : 'ws://';
        const gameServerWsUrl = `${server.publicHost.startsWith('ws') ? '' : wsProtocol}${server.publicHost}:${server.wsPort}?token=${connectionToken.token}&timestamp=${connectionToken.timestamp}&expiresAt=${connectionToken.expiresAt}&signature=${connectionToken.signature}`;

        const gameServerWs = new WebSocket(gameServerWsUrl);
        return gameServerWs;
      } else {

        localStorage.removeItem('selectedServerId');
      }
    } catch (error) {
      localStorage.removeItem('selectedServerId');
    }
  }

  try {
    const response = await fetch('/api/gateway/servers');
    if (!response.ok) {
      throw new Error('Failed to fetch server list from gateway');
    }

    const data = await response.json();

    if (!data.servers || data.servers.length === 0) {
      throw new Error('No game servers available');
    }

    const healthyServers = data.servers.filter((s: any) => s.status === 'online' || s.status === 'healthy');

    if (healthyServers.length === 0) {
      throw new Error('No healthy game servers available');
    }

    const server = healthyServers[0];

    const wsProtocol = server.useSSL ? 'wss://' : 'ws://';
    const gameServerWsUrl = `${server.publicHost.startsWith('ws') ? '' : wsProtocol}${server.publicHost}:${server.wsPort}?token=${connectionToken.token}&timestamp=${connectionToken.timestamp}&expiresAt=${connectionToken.expiresAt}&signature=${connectionToken.signature}`;

    const gameServerWs = new WebSocket(gameServerWsUrl);
    return gameServerWs;
  } catch (error) {
    console.error("Error connecting through gateway:", error);
  }
}

let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function initializeSocket() {

  if (isReconnecting) {
    return;
  }

  isReconnecting = true;

  const gatewayUrl = config.GATEWAY_URL;

  if (!gatewayUrl) {
    isReconnecting = false;
    throw new Error('Gateway URL not configured');
  }

  try {
    socket = (await connectThroughGateway()) as WebSocket;
  } catch (error) {
    isReconnecting = false;
    throw error;
  }

  if (!socket) {
    isReconnecting = false;
    window.location.href = "/";
    throw new Error('Failed to establish WebSocket connection');
  }

  socket.binaryType = "arraybuffer";
  setupSocketHandlers();

  if (socket.readyState === WebSocket.OPEN) {
    initializeConnection();
  }

  isReconnecting = false;
}

function initializeConnection() {

  reconnectAttempts = 0;

  if (cache?.players) {
    cache.players.clear();
  }

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
  sessionActive = false;
  cachedPlayerId = null;

  snapshotRevision = null;
  snapshotApplied = false;
  animationUpdateBuffer = [];
  pendingMovements = [];

  sendRequest({
    type: "PING",
    data: null,
  });
}

function setupSocketHandlers() {
socket.onopen = () => {
  initializeConnection();
};

socket.onclose = (ev: CloseEvent) => {

  progressBarContainer.style.display = "none";

  const wasUnexpected = ev.code !== 1000 && ev.code !== 1001;

  if (wasUnexpected && config.GATEWAY_ENABLED === 'true') {
    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      showNotification(
        `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Please refresh the page.`,
        false,
        true
      );
      return;
    }

    showNotification(
      `Connection lost (${ev.code}). Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
      false,
      false
    );

    setTimeout(async () => {
      try {
        await initializeSocket();
        reconnectAttempts = 0;
        showNotification(
          `Reconnected successfully!`,
          true,
          false
        );
      } catch (error) {
        showNotification(
          `Reconnection failed. Please refresh the page.`,
          false,
          true
        );
      }
    }, 2000);
  } else {
    showNotification(
      `You have been disconnected from the server: ${ev.code}`,
      false,
      true
    );
  }
};

socket.onerror = (ev: Event) => {
  progressBarContainer.style.display = "none";
  showNotification(
    `An error occurred while connecting to the server: ${ev.type}`,
    false,
    true
  );
};

async function handleLoadPlayersPacket(data: any) {

  if (loadPlayersProcessing) {
    loadPlayersQueue.push(data);
    return;
  }

  loadPlayersProcessing = true;

  try {

    if (!sessionActive || !cachedPlayerId) {
      return;
    }

    await isLoaded();
    if (!data) {
      return;
    }

    const players = data.players || data;
    snapshotRevision = data.snapshotRevision ?? null;

    const playerArray = Array.isArray(players) ? players : [];

    for (const player of playerArray) {
      if (player.id != cachedPlayerId) {

        const existingByUsername = Array.from(cache.players).find(
          (p) => p.username === player.username && p.userid === player.userid
        );

        const existingInPending = cache.pendingPlayers?.get(player.id);

        if (!existingByUsername && !existingInPending) {
          await createPlayer(player);
        } else if (existingByUsername) {
          // Update stealth state for existing players (fixes admin unstealth visibility issue)
          existingByUsername.isStealth = player.isStealth;
        }
      }
    }

    snapshotApplied = true;

    if (pendingMovements.length > 0) {
      for (const movement of pendingMovements) {
        const player = Array.from(cache.players).find(
          (p) => p.id === movement.id
        );
        if (player && movement._data) {
          player.position.x = Math.round(movement._data.x);
          player.position.y = Math.round(movement._data.y);
          if (movement.id === cachedPlayerId) {
            positionText.innerText = `Position: ${player.position.x}, ${player.position.y}`;
          }
        }
      }
      pendingMovements = [];
    }

    const bufferedAnimations = animationUpdateBuffer
      .filter(update => snapshotRevision === null || update.revision > snapshotRevision)
      .sort((a, b) => a.revision - b.revision);

    for (const update of bufferedAnimations) {
      const player = Array.from(cache.players).find(p => p.id === update.id);
      if (player) {
        try {
          let apng: any;
          const cachedData = cache.animations.get(update.name);

          if (cachedData instanceof Uint8Array) {
            apng = parseAPNG(cachedData);
          } else {

            const dbData = await getAnimationFromDB(update.name);
            if (dbData) {
              cache.animations.set(update.name, dbData);
              apng = parseAPNG(dbData);
            } else {

              //@ts-expect-error - Imported via HTML
              const inflated = pako.inflate(new Uint8Array(update.data.data));
              if (inflated) {
                cache.animations.set(update.name, inflated);
                await saveAnimationToDB(update.name, inflated);
                apng = parseAPNG(inflated);
              }
            }
          }

          if (!(apng instanceof Error)) {

            if (apng.frames && apng.frames.length > 0) {
              apng.frames.forEach((frame: any) => frame.createImage());
              await Promise.all(
                apng.frames.map((frame: any) => {
                  return new Promise<void>((resolve) => {
                    if (frame.imageElement?.complete) {
                      resolve();
                    } else if (frame.imageElement) {
                      frame.imageElement.onload = () => resolve();
                      frame.imageElement.onerror = () => resolve();
                    } else {
                      resolve();
                    }
                  });
                })
              );
            }

            player.animation = {
              frames: apng.frames,
              currentFrame: 0,
              lastFrameTime: performance.now(),
            };
          }
        } catch (error) {
          console.error("Error handling sprite sheet animation update:", error);
        }
      }
    }

    animationUpdateBuffer = [];
  } finally {

    loadPlayersProcessing = false;

    if (loadPlayersQueue.length > 0) {
      const queuedData = loadPlayersQueue.shift();

      setTimeout(() => {
        handleLoadPlayersPacket(queuedData);
      }, 0);
    }
  }
}

socket.onmessage = async (event) => {
  receivedResponses++;
  if (!(event.data instanceof ArrayBuffer)) return;

  const bytes = new Uint8Array(event.data);
  const FIRST_BYTE = bytes[0];

  let type: string;
  let data: any;

  if (FIRST_BYTE === 0x01) {
    type = "BATCH_MOVEXY";
    data = bytes;
  } else if (FIRST_BYTE === 0x02) {
    type = "MOVEXY";
    data = bytes;
  } else if (FIRST_BYTE === 0x03) {
    type = "MOVE_ENTITY_BINARY";
    data = bytes;
  } else {
    const decoded = JSON.parse(packet.decode(event.data));
    data = decoded["data"];
    type = decoded["type"];
  }

  switch (type) {
    case "SERVER_TIME": {
      sendRequest({ type: "TIME_SYNC" });
      if (!data) return;
      updateTime(data);
      break;
    }
    case "CAST_SPELL": {
      if (!data || !data.spell || (!data.time && data.time !== 0) || !data.id) return;
      castSpell(data.id, data.spell, data.time);
      break;
    }
    case "PROJECTILE": {
      const player_id = data?.id;
      const target_id = data?.target_id;
      const time_to_travel = data?.time;
      const spell = data?.spell;
      const icon = data?.icon;
      const isEntityTarget = data?.entity || false;

      if (!player_id || !target_id || !time_to_travel) break;

      // Source could be a player or entity
      const sourcePlayer = Array.from(cache.players).find(p => p.id === player_id);
      const sourceEntity = cache.entities.find((e: any) => e.id === player_id);
      const sourcePos = sourcePlayer?.position || sourceEntity?.position;

      let targetPos: { x: number; y: number } | null;

      if (isEntityTarget) {
        // Target is an entity
        const targetEntity = cache.entities.find((e: any) => e.id === target_id);
        if (!targetEntity) break;
        targetPos = targetEntity.position;
      } else {
        // Target is a player
        const targetPlayer = Array.from(cache.players).find(p => p.id === target_id);
        if (!targetPlayer) break;
        targetPos = targetPlayer.position;
      }

      if (!sourcePos || !targetPos) break;

      if (icon && spell && !cache.projectileIcons.has(spell)) {

        createCachedImage(icon).then((iconImage) => {
          iconImage.onload = () => {
            cache.projectileIcons.set(spell, iconImage);
          };

          iconImage.onerror = (error) => {
            console.error("Error loading projectile icon:", error);
          };

          // Trigger load in case image is cached
          if (iconImage.complete) {
            cache.projectileIcons.set(spell, iconImage);
          }
        });
      }

      cache.projectiles.push({
        startX: sourcePos.x,
        startY: sourcePos.y,
        targetPlayerId: target_id,
        targetEntityId: isEntityTarget ? target_id : undefined,
        targetPos: targetPos,
        currentX: sourcePos.x,
        currentY: sourcePos.y,
        startTime: performance.now(),
        duration: time_to_travel * 1000,
        spell: spell || 'unknown',
        isEntityTarget: isEntityTarget
      });

      break;
    }
    case "WEATHER": {
      if (!data || !data.weather) return;
      setWeatherType(data.weather);
      break;
    }
    case "CONSOLE_MESSAGE": {
      if (!data || !data.message) return;
      window.Notify(data.type, data.message);
      break;
    }
    case "TOGGLE_TILE_EDITOR": {

      import('./tileeditor.js').then((module) => {
        module.default.toggle();
      });
      break;
    }
    case "TOGGLE_PARTICLE_EDITOR": {

      import('./particleeditor.js').then((module) => {
        module.default.toggle();
      });
      break;
    }
    case "TOGGLE_NPC_EDITOR": {

      import('./npceditor.js').then((module) => {
        module.default.toggle();
      });
      break;
    }
    case "TOGGLE_ENTITY_EDITOR": {

      import('./entityeditor.js').then((module) => {
        module.default.toggle();
      });
      break;
    }
    case "NPC_LIST": {

      if ((window as any).npcEditor && (window as any).npcEditor.setNpcs) {
        (window as any).npcEditor.setNpcs(data.data ?? data);
      } else {
        import('./npceditor.js').then((module) => {
          if (module.default && module.default.setNpcs) {
            module.default.setNpcs(data.data ?? data);
          }
        });
      }
      break;
    }
    case "NPC_UPDATED": {

      const updatedNpc = data.data ?? data;
      // Update live game world NPC
      const cachedNpcs = cache.npcs || [];
      const existingIdx = cachedNpcs.findIndex((n: any) => n.id === updatedNpc.id);
      if (existingIdx >= 0) {
        // Update position and properties on the existing live NPC object
        const liveNpc = cachedNpcs[existingIdx];
        if (updatedNpc.position) {
          liveNpc.position = {
            x: updatedNpc.position.x,
            y: updatedNpc.position.y,
          };
        }
        if (updatedNpc.name !== undefined) liveNpc.name = updatedNpc.name || "";
        if (updatedNpc.dialog !== undefined) liveNpc.dialog = updatedNpc.dialog || "";
        if (updatedNpc.hidden !== undefined) liveNpc.hidden = updatedNpc.hidden;
        if (updatedNpc.particles !== undefined) liveNpc.particles = resolveParticles(updatedNpc.particles || []);
        if (updatedNpc.quest !== undefined) liveNpc.quest = updatedNpc.quest || null;
        // Update sprite and reinit if changed
        if (updatedNpc.sprite_type !== undefined) {
          liveNpc.sprite_type = updatedNpc.sprite_type;
          liveNpc.spriteLayers = updatedNpc.spriteLayers || null;
          liveNpc.direction = updatedNpc.position?.direction || liveNpc.direction || "down";
          reinitNpcSprite(liveNpc);
        }
        // Reset particle arrays so they re-emit with updated config
        liveNpc.particleArrays = {};
        liveNpc.lastEmitTime = {};
        // Re-run script if it changed
        if (updatedNpc.script !== undefined) {
          liveNpc.script = updatedNpc.script;
          try {
            if (updatedNpc.script) {
              new Function(
                "with(this) { " + decodeURIComponent(updatedNpc.script) + " }"
              ).call(liveNpc);
            }
          } catch (e) {
            console.error("Error re-running NPC script:", e);
          }
        }
      } else {
        // New NPC — spawn it in the game world
        createNPC({
          id: updatedNpc.id,
          name: updatedNpc.name || "",
          location: { x: updatedNpc.position?.x ?? 0, y: updatedNpc.position?.y ?? 0, direction: updatedNpc.position?.direction || "down" },
          dialog: updatedNpc.dialog || "",
          hidden: updatedNpc.hidden ?? false,
          particles: resolveParticles(updatedNpc.particles || []),
          quest: updatedNpc.quest || null,
          script: updatedNpc.script || "",
          map: updatedNpc.map,
          position: updatedNpc.position,
          last_updated: updatedNpc.last_updated,
          sprite_type: updatedNpc.sprite_type || 'none',
          spriteLayers: updatedNpc.spriteLayers || null,
        });
      }
      // Notify editor
      if ((window as any).npcEditor && (window as any).npcEditor.handleNpcUpdated) {
        (window as any).npcEditor.handleNpcUpdated(updatedNpc);
      }
      break;
    }
    case "NPC_REMOVED": {

      const removedId = (data.data ?? data)?.id;
      if (removedId != null) {
        // Remove from live game world
        const idx = cache.npcs ? cache.npcs.findIndex((n: any) => n.id === removedId) : -1;
        if (idx >= 0) {
          cache.npcs.splice(idx, 1);
        }
        // Notify editor
        if ((window as any).npcEditor && (window as any).npcEditor.handleNpcRemoved) {
          (window as any).npcEditor.handleNpcRemoved(removedId);
        }
      }
      break;
    }
    case "PARTICLE_LIST": {

      // Store particles in global registry for entity creation
      const particleListData = Array.isArray(data) ? data : (data.data ?? []);
      particleRegistry.clear();
      particleListData.forEach((p: any) => {
        const name = p.name || p;
        particleRegistry.set(name, p);
      });

      // Try to access globally set instance first
      if ((window as any).particleEditor && (window as any).particleEditor.addParticleListItem) {
        (window as any).particleEditor.addParticleListItem(data);
      } else {
        // Fallback to importing
        import('./particleeditor.js').then((module) => {
          if (module.default && module.default.addParticleListItem) {
            module.default.addParticleListItem(data);
          }
        });
      }
      // Also feed particle names to NPC editor if open
      if ((window as any).npcEditor && (window as any).npcEditor.setParticleOptions) {
        (window as any).npcEditor.setParticleOptions(particleListData);
      }
      // Feed particles to entity editor
      if ((window as any).entityEditor && (window as any).entityEditor.setParticleOptions) {
        (window as any).entityEditor.setParticleOptions(particleListData);
      }
      break;
    }
    case "ENTITY_LIST": {
      const entityListData = Array.isArray(data) ? data : (data.data ?? []);
      // Send to editor for UI only - don't update cached game entities
      if ((window as any).entityEditor && (window as any).entityEditor.setEntities) {
        (window as any).entityEditor.setEntities(entityListData);
      }
      break;
    }
    case "ENTITY_UPDATED": {
      const updatedEntity = data.data ?? data;
      const cachedEntities = cache.entities || [];
      const existingIdx = cachedEntities.findIndex((e: any) => e.id === updatedEntity.id);
      if (existingIdx >= 0) {
        const liveEntity = cachedEntities[existingIdx];
        if (updatedEntity.position) {
          liveEntity.updatePosition(updatedEntity.position.x, updatedEntity.position.y);
        }
        if (updatedEntity.health !== undefined) {
          liveEntity.health = updatedEntity.health;
        }
        if (updatedEntity.aggro_type !== undefined) {
          liveEntity.aggro_type = updatedEntity.aggro_type;
        }
        if (updatedEntity.position?.direction !== undefined) {
          liveEntity.direction = updatedEntity.position.direction;
        }
        // Reset animation when combat state changes to idle
        if (updatedEntity.combatState === 'idle' && liveEntity.combatState !== 'idle') {
          liveEntity.combatState = 'idle';
          // Reinitialize sprite to reset animation
          const { reinitEntitySprite } = await import("./entity.js");
          reinitEntitySprite(liveEntity);
        } else if (updatedEntity.combatState !== undefined) {
          liveEntity.combatState = updatedEntity.combatState;
        }
      }
      // Don't update entity editor - it only needs updates on explicit reload
      break;
    }
    case "ENTITY_REMOVED": {
      const removedId = data.data ?? data.id;
      const cachedEntities = cache.entities || [];
      const idx = cachedEntities.findIndex((e: any) => e.id === removedId);
      if (idx >= 0) {
        cachedEntities.splice(idx, 1);
      }
      if ((window as any).entityEditor && (window as any).entityEditor.setEntities) {
        (window as any).entityEditor.setEntities(cache.entities);
      }
      break;
    }
    case "TEST_PARTICLE_EVENT": {

      const { testType, particle, position, npcId } = data;

      if (testType === "spawn_at_position" && position) {
        // Spawn particle at player's position
        if ((window as any).currentPlayer) {
          (window as any).currentPlayer.particles = (window as any).currentPlayer.particles || [];
          (window as any).currentPlayer.particles.push(particle);
        }
      } else if (testType === "attach_to_npc" && npcId) {
        // Attach particle to NPC
        if ((window as any).npcs && (window as any).npcs[npcId]) {
          (window as any).npcs[npcId].particles = (window as any).npcs[npcId].particles || [];
          (window as any).npcs[npcId].particles.push(particle);
        }
      } else if (testType === "simulate_weather") {
        // Weather-affected particles test
        if ((window as any).currentPlayer) {
          (window as any).currentPlayer.particles = (window as any).currentPlayer.particles || [];
          (window as any).currentPlayer.particles.push(particle);
        }
      }
      break;
    }
    case "PARTICLE_UPDATED": {
      // Update particle definitions in all NPCs that use this particle
      const updatedParticle = data as any;
      if (!updatedParticle.name) break;

      // Get NPCs from cache instead of window object
      const npcs = cache.npcs || [];

      // Iterate through all NPCs and update matching particles
      for (const npc of npcs) {
        if (npc.particles && Array.isArray(npc.particles)) {
          // Find and update particles with matching name
          for (let i = 0; i < npc.particles.length; i++) {
            if (npc.particles[i].name === updatedParticle.name) {
              // Replace particle with updated definition
              // Reset runtime properties (currentLife, initialVelocity) to null
              // so particles restart fresh with the new definition
              npc.particles[i] = {
                ...updatedParticle,
                currentLife: null,
                initialVelocity: null
              };

              // Clear NPC's internal particle tracking so it emits fresh particles
              if (npc.particleArrays && npc.particleArrays[updatedParticle.name]) {
                npc.particleArrays[updatedParticle.name] = [];
              }
              if (npc.lastEmitTime && npc.lastEmitTime[updatedParticle.name] !== undefined) {
                delete npc.lastEmitTime[updatedParticle.name];
              }
            }
          }
        }
      }
      break;
    }
    case "RELOAD_CHUNKS": {

      if (window.mapData && window.mapData.loadedChunks) {
        const chunksToReload: Array<{x: number, y: number}> = [];
        window.mapData.loadedChunks.forEach((chunk: any, key: string) => {
          const [x, y] = key.split('-').map(Number);
          chunksToReload.push({ x, y });
        });

        window.mapData.loadedChunks.clear();

        chunksToReload.forEach(async (pos) => {
          await window.mapData.requestChunk(pos.x, pos.y);
        });
      }
      break;
    }
    case "UPDATE_CHUNKS": {

      if (window.mapData && window.mapData.loadedChunks && data) {
        const chunksToUpdate = data as Array<{chunkX: number, chunkY: number}>;

        import("./map.js").then(({ clearChunkFromCache }) => {
          chunksToUpdate.forEach((chunkCoord: {chunkX: number, chunkY: number}) => {
            const chunkKey = `${chunkCoord.chunkX}-${chunkCoord.chunkY}`;

            clearChunkFromCache(window.mapData.name, chunkCoord.chunkX, chunkCoord.chunkY);

            if (window.mapData.loadedChunks.has(chunkKey)) {
              window.mapData.loadedChunks.delete(chunkKey);

              window.mapData.requestChunk(chunkCoord.chunkX, chunkCoord.chunkY);
            }
          });
        });
      }
      break;
    }
    case "CHUNK_DATA": {

      if (data && data.chunkX !== undefined && data.chunkY !== undefined) {
        const chunkKey = `${data.chunkX}-${data.chunkY}`;
        const resolver = pendingMapChunkRequests.get(chunkKey);
        if (resolver) {
          resolver.resolve(data);
          pendingMapChunkRequests.delete(chunkKey);
        }
      }
      break;
    }
    case "COLLISION_DEBUG": {
      if (!data || data.tileX === undefined || data.tileY === undefined) return;

      if (!(window as any).collisionTiles) {
        (window as any).collisionTiles = [];
      }
      (window as any).collisionTiles.push({ x: data.tileX, y: data.tileY, time: Date.now() });

      if ((window as any).collisionTiles.length > 10) {
        (window as any).collisionTiles.shift();
      }
      break;
    }
    case "INVITATION": {

      createInvitationPopup(data);
      break;
    }
    case "UPDATE_FRIENDS": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.friends = data.friends || [];
        updateFriendsList(data);
      }
      break;
    }
    case "UPDATE_ONLINE_STATUS": {
      updateFriendOnlineStatus(data.username, data.online);
      break;
    }
    case "ONLINE_PLAYERS_LIST": {

      if (data && Array.isArray(data)) {
        updateAdminPlayerListWithData(data);
      }
      break;
    }
    case "UPDATE_PARTY": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.party = data.members || [];
        createPartyUI(currentPlayer.party, Array.from(cache.players));
      }
      break;
    }
    case "ANIMATION": {
      try {
        if (!data?.name || !data?.data) return;

        if (!snapshotApplied && data.revision !== undefined) {
          animationUpdateBuffer.push({
            id: data.id,
            name: data.name,
            data: data.data,
            revision: data.revision
          });
          break;
        }

        let apng: any;
        const cachedData = cache.animations.get(data.name);

        if (cachedData instanceof Uint8Array) {
          apng = parseAPNG(cachedData);
        } else {

          const dbData = await getAnimationFromDB(data.name);
          if (dbData) {
            cache.animations.set(data.name, dbData);
            apng = parseAPNG(dbData);
          } else {

            //@ts-expect-error - Imported via HTML
            const inflated = pako.inflate(new Uint8Array(data.data.data));
            if (!inflated) {
              return;
            }

            cache.animations.set(data.name, inflated);
            await saveAnimationToDB(data.name, inflated);
            apng = parseAPNG(inflated);
          }
        }

        if (!(apng instanceof Error) && cache.players) {
          const findPlayer = async () => {
            const player = cache.players.size
              ? Array.from(cache.players).find((p) => p.id === data.id)
              : null;
            if (player) {

              if (apng.frames && apng.frames.length > 0) {

                apng.frames.forEach((frame: any) => frame.createImage());

                await Promise.all(
                  apng.frames.map((frame: any) => {
                    return new Promise<void>((resolve) => {
                      if (frame.imageElement?.complete) {
                        resolve();
                      } else if (frame.imageElement) {
                        frame.imageElement.onload = () => resolve();
                        frame.imageElement.onerror = () => resolve();
                      } else {
                        resolve();
                      }
                    });
                  })
                );
              }

              player.animation = {
                frames: apng.frames,
                currentFrame: 0,
                lastFrameTime: performance.now(),
              };
            } else {
              await new Promise((resolve) => setTimeout(resolve, 100));
              await findPlayer();
            }
          };

          findPlayer().catch((err) =>
            console.error("Error finding player for animation update:", err)
          );
        }
      } catch (error) {
        console.error("Error handling animation update:", error);
      }
      break;
    }
    case "SPRITE_SHEET_ANIMATION": {
      try {

        if (!data?.bodySprite && !data?.headSprite && !data?.bodyArmorSprite && !data?.headArmorSprite) {
          return;
        }

        const findPlayer = async () => {

          let player = cache.players.size
            ? Array.from(cache.players).find((p) => p.id === data.id)
            : null;

          if (!player && cache.pendingPlayers) {
            player = cache.pendingPlayers.get(data.id) || null;
          }

          if (player) {

            const { initializeLayeredAnimation, changeLayeredAnimation } = await import('./layeredAnimation.js');

            let animationState = data.animationState || 'idle';

            if (animationState.includes('_')) {
              const direction = animationState.split('_')[1];
              player.lastDirection = direction;
            } else {

              animationState = `${animationState}_${player.lastDirection}`;
            }

            const hasExisting = player.layeredAnimation;
            const spriteSheetsChanged = hasExisting ? (
              player.layeredAnimation.layers.mount?.spriteSheet?.name !== data.mountSprite?.name ||
              player.layeredAnimation.layers.body?.spriteSheet?.name !== data.bodySprite?.name ||
              player.layeredAnimation.layers.head?.spriteSheet?.name !== data.headSprite?.name ||
              player.layeredAnimation.layers.armor_helmet?.spriteSheet?.name !== data.armorHelmetSprite?.name ||
              player.layeredAnimation.layers.armor_shoulderguards?.spriteSheet?.name !== data.armorShoulderguardsSprite?.name ||
              player.layeredAnimation.layers.armor_neck?.spriteSheet?.name !== data.armorNeckSprite?.name ||
              player.layeredAnimation.layers.armor_hands?.spriteSheet?.name !== data.armorHandsSprite?.name ||
              player.layeredAnimation.layers.armor_chest?.spriteSheet?.name !== data.armorChestSprite?.name ||
              player.layeredAnimation.layers.armor_feet?.spriteSheet?.name !== data.armorFeetSprite?.name ||
              player.layeredAnimation.layers.armor_legs?.spriteSheet?.name !== data.armorLegsSprite?.name ||
              player.layeredAnimation.layers.armor_weapon?.spriteSheet?.name !== data.armorWeaponSprite?.name
            ) : true;

            if (!hasExisting || spriteSheetsChanged) {

              player.layeredAnimation = await initializeLayeredAnimation(
                data.mountSprite || null,
                data.bodySprite || null,
                data.headSprite || null,
                data.armorHelmetSprite || null,
                data.armorShoulderguardsSprite || null,
                data.armorNeckSprite || null,
                data.armorHandsSprite || null,
                data.armorChestSprite || null,
                data.armorFeetSprite || null,
                data.armorLegsSprite || null,
                data.armorWeaponSprite || null,
                animationState
              );
            } else {

              if (data.mountSprite && player.layeredAnimation.layers.mount) {
                player.layeredAnimation.layers.mount.spriteSheet = data.mountSprite;
              } else if (!data.mountSprite && player.layeredAnimation.layers.mount) {
                // Player dismounted - remove the mount layer
                player.layeredAnimation.layers.mount = null;
              }
              if (data.bodySprite && player.layeredAnimation.layers.body) {
                player.layeredAnimation.layers.body.spriteSheet = data.bodySprite;
              }
              if (data.headSprite && player.layeredAnimation.layers.head) {
                player.layeredAnimation.layers.head.spriteSheet = data.headSprite;
              }
              if (data.armorHelmetSprite && player.layeredAnimation.layers.armor_helmet) {
                player.layeredAnimation.layers.armor_helmet.spriteSheet = data.armorHelmetSprite;
              }
              if (data.armorShoulderguardsSprite && player.layeredAnimation.layers.armor_shoulderguards) {
                player.layeredAnimation.layers.armor_shoulderguards.spriteSheet = data.armorShoulderguardsSprite;
              }
              if (data.armorNeckSprite && player.layeredAnimation.layers.armor_neck) {
                player.layeredAnimation.layers.armor_neck.spriteSheet = data.armorNeckSprite;
              }
              if (data.armorHandsSprite && player.layeredAnimation.layers.armor_hands) {
                player.layeredAnimation.layers.armor_hands.spriteSheet = data.armorHandsSprite;
              }
              if (data.armorChestSprite && player.layeredAnimation.layers.armor_chest) {
                player.layeredAnimation.layers.armor_chest.spriteSheet = data.armorChestSprite;
              }
              if (data.armorFeetSprite && player.layeredAnimation.layers.armor_feet) {
                player.layeredAnimation.layers.armor_feet.spriteSheet = data.armorFeetSprite;
              }
              if (data.armorLegsSprite && player.layeredAnimation.layers.armor_legs) {
                player.layeredAnimation.layers.armor_legs.spriteSheet = data.armorLegsSprite;
              }
              if (data.armorWeaponSprite && player.layeredAnimation.layers.armor_weapon) {
                player.layeredAnimation.layers.armor_weapon.spriteSheet = data.armorWeaponSprite;
              }

              if (player.layeredAnimation.currentAnimationName !== animationState) {

                await changeLayeredAnimation(player.layeredAnimation, animationState);
              }
            }

            player.animation = null;

            if (data.id === cachedPlayerId) {
              setSelfPlayerSpriteLoaded(true);
            }

            if (cache.pendingPlayers && cache.pendingPlayers.has(data.id)) {
              cache.pendingPlayers.delete(data.id);
              cache.players.add(player);

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await findPlayer();
          }
        };

        findPlayer().catch((err) =>
          console.error("Error finding player for sprite sheet animation update:", err)
        );
      } catch (error) {
        console.error("Error handling sprite sheet animation update:", error);
      }
      break;
    }
    case "BATCH_SPRITE_SHEET_ANIMATION": {
      try {

        if (!Array.isArray(data) || data.length === 0) {
          return;
        }

        for (const animationData of data) {

          if (!animationData?.bodySprite && !animationData?.headSprite && !animationData?.bodyArmorSprite && !animationData?.headArmorSprite) {
            continue;
          }

          const player = cache.players.size
            ? Array.from(cache.players).find((p) => p.id === animationData.id)
            : null;

          const pendingPlayer = !player && cache.pendingPlayers
            ? cache.pendingPlayers.get(animationData.id)
            : null;

          const targetPlayer = player || pendingPlayer;

          if (targetPlayer) {

            const { initializeLayeredAnimation, changeLayeredAnimation } = await import('./layeredAnimation.js');

            let animationState = animationData.animationState || 'idle';

            if (animationState.includes('_')) {
              const direction = animationState.split('_')[1];
              targetPlayer.lastDirection = direction;
            } else {
              animationState = `${animationState}_${targetPlayer.lastDirection}`;
            }

            const hasExisting = targetPlayer.layeredAnimation;
            const spriteSheetsChanged = hasExisting ? (
              targetPlayer.layeredAnimation.layers.mount?.spriteSheet?.name !== animationData.mountSprite?.name ||
              targetPlayer.layeredAnimation.layers.body?.spriteSheet?.name !== animationData.bodySprite?.name ||
              targetPlayer.layeredAnimation.layers.head?.spriteSheet?.name !== animationData.headSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_helmet?.spriteSheet?.name !== animationData.armorHelmetSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_shoulderguards?.spriteSheet?.name !== animationData.armorShoulderguardsSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_neck?.spriteSheet?.name !== animationData.armorNeckSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_hands?.spriteSheet?.name !== animationData.armorHandsSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_chest?.spriteSheet?.name !== animationData.armorChestSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_feet?.spriteSheet?.name !== animationData.armorFeetSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_legs?.spriteSheet?.name !== animationData.armorLegsSprite?.name ||
              targetPlayer.layeredAnimation.layers.armor_weapon?.spriteSheet?.name !== animationData.armorWeaponSprite?.name
            ) : true;

            if (!hasExisting || spriteSheetsChanged) {
              targetPlayer.layeredAnimation = await initializeLayeredAnimation(
                animationData.mountSprite || null,
                animationData.bodySprite || null,
                animationData.headSprite || null,
                animationData.armorHelmetSprite || null,
                animationData.armorShoulderguardsSprite || null,
                animationData.armorNeckSprite || null,
                animationData.armorHandsSprite || null,
                animationData.armorChestSprite || null,
                animationData.armorFeetSprite || null,
                animationData.armorLegsSprite || null,
                animationData.armorWeaponSprite || null,
                animationState
              );
            } else {

              await changeLayeredAnimation(targetPlayer.layeredAnimation, animationState);
            }

            if (cache.pendingPlayers && cache.pendingPlayers.has(animationData.id)) {
              cache.pendingPlayers.delete(animationData.id);
              cache.players.add(targetPlayer);
            }
          }
        }

        sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      } catch (error) {
        console.error("Error handling sprite sheet animation update:", error);
      }
      break;
    }
    case "PONG":
      sendRequest({
        type: "LOGIN",
        data: null,
      });
      break;
    case "CONNECTION_COUNT": {
      onlinecount.innerText = `${data} online`;
      break;
    }
    case "SPAWN_PLAYER": {

      if (!sessionActive || !cachedPlayerId) {
        break;
      }

      await isLoaded();

      const existingByUsername = Array.from(cache.players).find(
        (p) => p.username === data.username && p.userid === data.userid
      );

      const existingInPending = cache.pendingPlayers?.get(data.id);

      if (!existingByUsername && !existingInPending) {
        await createPlayer(data);
      } else if (existingByUsername) {
        // Update existing player instead of recreating to avoid duplicates
        Object.assign(existingByUsername, data);
        // Update sprite data if provided
        if (data.spriteData) {
          existingByUsername.spriteData = data.spriteData;
        }
      }

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });

      if (data.id === cachedPlayerId) {
        updateCurrencyDisplay();

        const noclipButton = document.getElementById("admin-noclip");
        const stealthButton = document.getElementById("admin-stealth");

        if (noclipButton) {
          if (data.isNoclip) {
            noclipButton.classList.add("active");
          } else {
            noclipButton.classList.remove("active");
          }
        }

        if (stealthButton) {
          if (data.isStealth) {
            stealthButton.classList.add("active");
          } else {
            stealthButton.classList.remove("active");
          }
        }
      }
      break;
    }
    case "RECONNECT": {
      window.location.reload();
      break;
    }
    case "LOAD_PLAYERS": {
      await handleLoadPlayersPacket(data);
      break;
    }
    case "DISCONNECT_MALIFORMED": {
      if (!data) return;
      const arrayToDisconnect = Array.isArray(data) ? data : [data];
      arrayToDisconnect.forEach((playerData) => {
        const player = Array.from(cache.players).find(
          (player) => player.id === playerData.id
        );
        if (player) {
          cache.players.delete(player);
        }
      });

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      break;
    }
    case "DISCONNECT_PLAYER": {
      if (!data || !data.id || !data.username) return;

      updateFriendOnlineStatus(data.username, false);

      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (player) {
        cache.players.delete(player);

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      }

      break;
    }
    case "DESPAWN_PLAYER": {
      if (!data || !data.id) return;

      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (player) {
        cache.players.delete(player);

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      }
      break;
    }
    case "BATCH_DISCONNECT_PLAYER": {

      if (!Array.isArray(data)) return;

      data.forEach((despawnData: { id: string; reason: string }) => {
        if (!despawnData.id) return;

        const player = Array.from(cache.players).find(
          (p) => p.id === despawnData.id
        );
        if (player) {
          cache.players.delete(player);
        }
      });

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });
      break;
    }
    case "DESPAWN_ENTITY": {
      if (!data || !data.id) return;

      const entityIndex = cache.entities.findIndex((e: any) => e.id === data.id);
      if (entityIndex !== -1) {
        cache.entities.splice(entityIndex, 1);
      }

      // Untarget the entity if it was targeted
      if (cache.targetId === data.id) {
        cache.targetId = null;
      }

      // Respawn is handled server-side via entityAI timer
      // Client will receive SPAWN_ENTITY packet when entity respawns

      break;
    }
    case "SPAWN_ENTITY": {
      if (!data) return;

      // Check if entity already exists in cache
      const existingEntityIndex = cache.entities.findIndex((e: any) => e.id === data.id);
      if (existingEntityIndex !== -1) {
        // Update existing entity
        const existingEntity = cache.entities[existingEntityIndex];
        cache.entities[existingEntityIndex] = {
          ...existingEntity,
          ...data,
          health: data.health || data.max_health,
          combatState: 'idle',
        };
      } else {
        // Create new entity
        const { createEntity } = await import("./entity.js");
        createEntity({
          id: data.id,
          name: data.name,
          location: {
            x: data.position?.x || 0,
            y: data.position?.y || 0,
            direction: data.position?.direction || 'down',
          },
          health: data.health || data.max_health,
          max_health: data.max_health,
          level: data.level,
          aggro_type: data.aggro_type,
          sprite_type: data.sprite_type,
          spriteLayers: data.spriteLayers,
          particles: data.particles,
        });
      }

      break;
    }
    case "MOVE_ENTITY": {
      const { id, position, direction, isMoving, isCasting, castingSpell, castingProgress } = data;
      if (!id || !position) break;

      const entity = cache.entities.find((e: any) => e.id === id);

      if (entity) {
        // Store server position for smooth interpolation in game loop
        if (!entity.serverPosition) {
          entity.serverPosition = { x: position.x, y: position.y };
        } else {
          entity.serverPosition.x = position.x;
          entity.serverPosition.y = position.y;
        }
        entity.isMoving = isMoving;
        entity.isCasting = isCasting || false;
        entity.castingSpell = castingSpell || null;
        entity.castingProgress = castingProgress || 0;

        if (direction) {
          entity.direction = direction;
        }

        // Update animation based on casting or movement state
        if (entity.layeredAnimation) {
          let animationName;
          if (isCasting) {
            // Use casting idle animation when casting (entities stop moving while casting)
            animationName = `cast_idle_${direction || entity.direction || 'down'}`;
          } else {
            // Use regular walk/idle animation
            animationName = isMoving
              ? `walk_${direction || entity.direction || 'down'}`
              : `idle_${direction || entity.direction || 'down'}`;
          }

          const { changeLayeredAnimation } = await import('./layeredAnimation.js');
          changeLayeredAnimation(entity.layeredAnimation, animationName);
        }
      }
      break;
    }
    case "MOVE_ENTITY_BINARY": {
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length < 11) break;

        const DIRECTION_MAP = [
          "up", "down", "left", "right",
          "upleft", "upright", "downleft", "downright"
        ];

        const view = new DataView(bytes.buffer, bytes.byteOffset, 11);
        const entityId = view.getUint32(1, true);
        const x = view.getInt16(5, true);
        const y = view.getInt16(7, true);
        const flags = bytes[9];
        const direction = (flags >> 4) & 0x0F;
        const isMoving = (flags >> 3) & 0x01;
        const isCasting = (flags >> 2) & 0x01;
        const castingProgress = bytes[10] / 100;

        const entity = cache.entities.find((e: any) => e.id === entityId);
        if (entity) {
          if (!entity.serverPosition) {
            entity.serverPosition = { x, y };
          } else {
            entity.serverPosition.x = x;
            entity.serverPosition.y = y;
          }
          entity.isMoving = isMoving ? true : false;
          entity.isCasting = isCasting ? true : false;
          entity.castingProgress = castingProgress;
          entity.direction = DIRECTION_MAP[direction] || "down";

          if (entity.layeredAnimation) {
            let animationName;
            if (isCasting) {
              animationName = `cast_idle_${entity.direction}`;
            } else if (isMoving) {
              animationName = `walk_${entity.direction}`;
            } else {
              animationName = `idle_${entity.direction}`;
            }

            const { changeLayeredAnimation } = await import('./layeredAnimation.js');
            changeLayeredAnimation(entity.layeredAnimation, animationName);
          }
        }
      }
      break;
    }
    case "MOVEXY": {
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length < 9) break;

        const DIRECTION_MAP = [
          "up", "down", "left", "right",
          "upleft", "upright", "downleft", "downright"
        ];

        const view = new DataView(bytes.buffer, bytes.byteOffset, 9);
        const playerId = view.getUint16(1, true);
        const x = view.getInt16(3, true);
        const y = view.getInt16(5, true);
        const dirStealth = bytes[7];
        const direction = dirStealth & 0x0F;
        const stealth = (dirStealth >> 4) & 0x0F;

        data = {
          i: playerId,
          d: { x, y, dr: DIRECTION_MAP[direction] || "down" },
          r: 0,
          s: stealth
        };
      }

      if (data._data === "abort") {
        break;
      }

      if (!sessionActive || !cachedPlayerId) {
        break;
      }

      const playerId = data.i || data.id;

      const player = Array.from(cache.players).find(
        (player) => player.id == playerId
      );

      const moveData = data.d || data._data;

      if (player) {
        // Handle player movement
        player.typing = false;
        player.serverPosition.x = Math.round(moveData.x);
        player.serverPosition.y = Math.round(moveData.y);
        player.position.x = Math.round(moveData.x);
        player.position.y = Math.round(moveData.y);
        player.lastServerUpdate = performance.now();

        if (playerId == cachedPlayerId) {
          positionText.innerText = `Position: ${player.serverPosition.x}, ${player.serverPosition.y}`;
        }
      } else {
        // Handle entity movement
        const entity = cache.entities.find((e: any) => e.id === playerId);
        if (entity) {
          const oldX = entity.position?.x ?? 0;
          const oldY = entity.position?.y ?? 0;
          const newX = Math.round(moveData.x);
          const newY = Math.round(moveData.y);
          const isMoving = oldX !== newX || oldY !== newY;
          const isCasting = data.s === 1; // For entities, stealth field indicates casting

          if (!entity.serverPosition) {
            entity.serverPosition = { x: newX, y: newY };
          } else {
            entity.serverPosition.x = newX;
            entity.serverPosition.y = newY;
          }
          entity.position.x = newX;
          entity.position.y = newY;
          entity.direction = moveData.dr || "down";
          entity.isMoving = isMoving;
          entity.isCasting = isCasting;

          // Update entity animation if it has layered animation
          if (entity.layeredAnimation) {
            let animationName;
            if (isCasting) {
              animationName = `cast_idle_${entity.direction}`;
            } else if (isMoving) {
              animationName = `walk_${entity.direction}`;
            } else {
              animationName = `idle_${entity.direction}`;
            }
            const { changeLayeredAnimation } = await import('./layeredAnimation.js');
            changeLayeredAnimation(entity.layeredAnimation, animationName);
          }
        }
      }
      break;
    }
    case "BATCH_MOVEXY": {

      if (!sessionActive || !cachedPlayerId) {
        break;
      }

      let movements: any[] = [];

      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length === 0) break;

        const HEADER_BYTE = 0x01;
        if (bytes[0] === HEADER_BYTE) {
          const DIRECTION_MAP = [
            "up", "down", "left", "right",
            "upleft", "upright", "downleft", "downright"
          ];

          let offset = 1;
          const countView = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
          const count = countView.getUint16(0, true);
          offset += 2;

          for (let i = 0; i < count; i++) {
            if (offset + 2 > bytes.length) break;

            const idView = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
            const playerId = idView.getUint16(0, true);
            offset += 2;

            if (offset + 5 > bytes.length) break;
            const moveView = new DataView(bytes.buffer, bytes.byteOffset + offset, 5);
            const x = moveView.getInt16(0, true);
            const y = moveView.getInt16(2, true);
            const dirStealth = bytes[offset + 4];
            const direction = dirStealth & 0x0F;
            const stealth = (dirStealth >> 4) & 0x0F;
            offset += 5;

            movements.push({
              i: playerId,
              d: { x, y, dr: DIRECTION_MAP[direction] || "down" },
              r: 0,
              s: stealth
            });
          }
        } else {
          try {
            const decoder = new TextDecoder();
            const decoded = JSON.parse(decoder.decode(bytes));
            movements = decoded.data || decoded;
          } catch (e) {
            break;
          }
        }
      } else if (Array.isArray(data)) {
        movements = data;
      } else {
        break;
      }

      for (const movement of movements) {

        const moveData = movement.d || movement._data;
        const playerId = movement.i || movement.id;

        if (moveData === "abort") continue;

        const player = Array.from(cache.players).find(
          (p) => p.id == playerId
        );

        if (!player) {

          if (!snapshotApplied) {
            pendingMovements.push(movement);
          }
          continue;
        }

        player.typing = false;
        player.serverPosition.x = Math.round(moveData.x);
        player.serverPosition.y = Math.round(moveData.y);
        player.lastServerUpdate = performance.now();
        
        if (playerId != cachedPlayerId) {
          player.position.x = Math.round(moveData.x);
          player.position.y = Math.round(moveData.y);
        } else {
          player.position.x = Math.round(moveData.x);
          player.position.y = Math.round(moveData.y);
        }

        if (playerId == cachedPlayerId) {
          positionText.innerText = `Position: ${player.serverPosition.x}, ${player.serverPosition.y}`;
        }
      }
      break;
    }
    case "CREATE_NPC": {
      await isLoaded();
      if (!data) return;
      // Resolve particle names to full definitions with z-index
      if (data.particles) {
        data.particles = resolveParticles(data.particles);
      }
      createNPC(data);
      break;
    }
    case "CREATE_ENTITY": {
      await isLoaded();
      if (!data) return;
      // Resolve particle names to full definitions
      if (data.particles) {
        data.particles = resolveParticles(data.particles);
      }
      const { createEntity } = await import('./entity.js');
      createEntity(data);
      break;
    }
    case "UPDATE_ENTITY": {
      if (!data || !data.id) return;
      const entity = cache.entities.find((e: any) => e.id === data.id);
      if (entity) {
        if (data.position) {
          entity.updatePosition(data.position.x, data.position.y);
        }
        if (data.direction !== undefined) {
          entity.direction = data.direction;
          // Update animation to idle with new direction using proper animation handler
          if (entity.layeredAnimation) {
            const { changeLayeredAnimation } = await import('./layeredAnimation.js');
            changeLayeredAnimation(entity.layeredAnimation, `idle_${data.direction}`);
          }
        }
        if (data.health !== undefined) {
          entity.health = data.health;
        }
        if (data.combatState) {
          entity.combatState = data.combatState;
        }
        if (data.target !== undefined) {
          entity.target = data.target;
        }
      }
      break;
    }
    case "ENTITY_DIED": {
      if (!data || !data.id) return;
      const entity = cache.entities.find((e: any) => e.id === data.id);
      if (entity) {
        entity.combatState = 'dead';
        // Remove from cache after a delay for animation
        setTimeout(() => {
          const index = cache.entities.indexOf(entity);
          if (index > -1) {
            cache.entities.splice(index, 1);
          }
        }, 3000);
      }
      break;
    }
    case "ENTITY_DAMAGE": {
      if (!data || !data.id) return;
      const entity = cache.entities.find((e: any) => e.id === data.id);
      if (entity) {
        entity.takeDamage(data.damage || 0);
      }
      break;
    }
    case "UPDATE_ENTITY_HEALTH": {
      if (!data || !data.id) return;
      const entity = cache.entities.find((e: any) => e.id === data.id);
      if (entity) {
        entity.health = data.health;
        entity.maxHealth = data.maxHealth;
      }
      break;
    }
    case "LOAD_MAP":
      {
        loaded = await loadMap(data);

        if (loaded && selfPlayerSpriteLoaded) {
          hideLoadingScreen();
        }

        if (loaded) {
          updateAdminMapInput();
        }
      }
      break;
    case "LOGIN_SUCCESS":
      {
        const connectionId = JSON.parse(packet.decode(event.data))["data"];
        const chatDecryptionKey = JSON.parse(packet.decode(event.data))[
          "chatDecryptionKey"
        ];
        sessionStorage.setItem("connectionId", connectionId);
        cachedPlayerId = connectionId;
        sessionActive = true;

        if (cache?.players) {
          cache.players.clear();
        }

  sendRequest({ type: "GET_ONLINE_PLAYERS", data: null });

        snapshotRevision = null;
        snapshotApplied = false;
        animationUpdateBuffer = [];
        pendingMovements = [];

        const sessionToken = getCookie("token");
        if (!sessionToken) {
          window.location.href = "/game";
          return;
        }

        sessionStorage.setItem("chatDecryptionKey", chatDecryptionKey);

        const language =
          navigator.language.split("-")[0] || navigator.language || "en";
        sendRequest({
          type: "AUTH",
          data: sessionToken,
          language,
        });
      }
      break;
    case "LOGIN_FAILED":
      {
        window.location.href = "/";
      }
      break;
    case "SPELLS": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const slots = JSON.parse(packet.decode(event.data))["slots"];

      const grid = spellBookUI.querySelector("#grid");
      if (!grid) return;

      grid.querySelectorAll(".slot").forEach((slot) => {
        grid.removeChild(slot);
      });

      const spellsArray = Array.isArray(data) ? data : Object.values(data);

      if (spellsArray.length > 0) {

        for (let i = 0; i < spellsArray.length; i++) {
          const spell = spellsArray[i];

          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("ui");
          slot.classList.add("common");

          slot.draggable = true;
          slot.dataset.spellName = spell.name || Object.keys(data)[i] || 'Unknown';

          if (spell.spriteUrl) {
            const iconImage = new Image();
            iconImage.draggable = false;
            iconImage.width = 32;
            iconImage.height = 32;
            iconImage.onload = () => {
              slot.appendChild(iconImage);
            };
            iconImage.src = spell.spriteUrl;
          } else {

            slot.innerHTML = `${spell.name || Object.keys(data)[i] || 'Unknown'}`;
          }

          slot.addEventListener("dragstart", (event: DragEvent) => {
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("text/plain", slot.dataset.spellName || '');

              const iconImg = slot.querySelector('img');
              if (iconImg) {
                event.dataTransfer.setData("image/src", iconImg.src);
              }
            }
          });

          slot.addEventListener("click", () => {
            const target = Array.from(cache?.players).find(p => p?.targeted) || null;
            sendRequest({
              type: "HOTBAR",
              data: {
                spell: slot.dataset.spellName,
                target
              }
            });
          });

          grid.appendChild(slot);
        }
      }

      const totalSlots = slots || 20;
      for (let i = spellsArray.length; i < totalSlots; i++) {
        const slot = document.createElement("div");
        slot.classList.add("slot");
        slot.classList.add("empty");
        slot.classList.add("ui");
        grid.appendChild(slot);
      }

      hotbarSlots.forEach((hotbarSlot) => {
        const spellName = hotbarSlot.dataset.spellName;
        if (spellName) {

          const matchingSpell = spellsArray.find((spell: any) =>
            (spell.name || '') === spellName
          );

          if (matchingSpell && matchingSpell.spriteUrl) {
            const iconImage = new Image();
            iconImage.draggable = false;
            iconImage.width = 32;
            iconImage.height = 32;
            iconImage.onload = () => {
              hotbarSlot.innerHTML = "";
              hotbarSlot.classList.remove("empty");
              hotbarSlot.appendChild(iconImage);
            };
            iconImage.src = matchingSpell.spriteUrl;
          }
        }
      });

      break;
    }
    case "COLLECTABLES":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];

        const grid = collectablesUI.querySelector("#grid");
        if (!grid) return;

        grid.querySelectorAll(".slot").forEach((slot) => {
          grid.removeChild(slot);
        });

        if (data.length > 0) {

          for (let i = 0; i < data.length; i++) {

            const slot = document.createElement("div");
            slot.classList.add("slot");
            slot.classList.add("ui");
            slot.classList.add("epic");

            if (data[i].iconUrl) {

              createCachedImage(data[i].iconUrl).then((iconImage) => {
                iconImage.width = 32;
                iconImage.height = 32;
                iconImage.draggable = false;
                slot.appendChild(iconImage);
              });

              slot.addEventListener("click", () => {

                if (data[i].type === "mount") {
                  cache.mount = data[i].item;
                  sendRequest({
                    type: "MOUNT",
                    data: { mount: data[i].item},
                  });
                }
              });
              grid.appendChild(slot);
            } else {
              slot.innerHTML = `${data[i].item}`;
              grid.appendChild(slot);
            }
          }
        }

        for (let i = 0; i < slots - data.length; i++) {
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("empty");
          slot.classList.add("ui");
          grid.appendChild(slot);
        }
        break;
      }
    case "EQUIPMENT": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      cache.equipment = data;

      const statSheetOpen = statUI.style.left === "10px";
      const showingCurrentPlayer = statUI.getAttribute("data-id") === String(cachedPlayerId);

      if (statSheetOpen && !showingCurrentPlayer) {
        break;
      }

      const leftSlots = ['helmet', 'necklace', 'shoulderguards', 'chestplate', 'wristguards', 'gloves', 'belt', 'pants'];
      const rightSlots = ['boots', 'ring_1', 'ring_2', 'trinket_1', 'trinket_2'];
      const bottomSlots = ['weapon', 'off_hand_weapon'];

      equipmentLeftColumn.innerHTML = '';
      leftSlots.forEach(slotType => {
        const slot = document.createElement('div');
        slot.className = 'slot empty ui';
        slot.setAttribute('data-slot', slotType);
        equipmentLeftColumn.appendChild(slot);
      });

      equipmentRightColumn.innerHTML = '';
      rightSlots.forEach(slotType => {
        const slot = document.createElement('div');
        slot.className = 'slot empty ui';
        slot.setAttribute('data-slot', slotType);
        equipmentRightColumn.appendChild(slot);
      });

      equipmentBottomCenter.innerHTML = '';
      bottomSlots.forEach(slotType => {
        const slot = document.createElement('div');
        slot.className = 'slot empty ui';
        slot.setAttribute('data-slot', slotType);
        equipmentBottomCenter.appendChild(slot);
      });

      setupEquipmentSlotHandlers();

      for (const [slotName, itemName] of Object.entries(data)) {
        if (!itemName) continue;

        if (slotName === 'body' || slotName === 'head') continue;

        const slotElement = document.querySelector(`.slot[data-slot="${slotName}"]`) as HTMLDivElement;
        if (!slotElement) {
          continue;
        }

        // Look up item details from global cache or inventory cache
        let itemDetails = itemsByName.get(String(itemName)) || (cache.inventory || []).find((item: any) => item.name === itemName);

        // If item doesn't have iconUrl but has icon, generate it
        if (itemDetails && !itemDetails.iconUrl && itemDetails.icon) {
          itemDetails = {
            ...itemDetails,
            iconUrl: `http://127.0.0.1:8000/icon?name=${encodeURIComponent(itemDetails.icon)}`
          };
        }

        if (itemDetails && itemDetails.iconUrl) {

          if (itemDetails.quality) {
            slotElement.classList.add(itemDetails.quality.toLowerCase());
            slotElement.classList.remove("empty");
          }

          const iconSrc = itemDetails.iconUrl;

          slotElement.ondblclick = () => {

            hideItemTooltip();

            const inventorySlots = inventoryGrid.querySelectorAll(".slot");
            let firstEmptySlot = -1;
            inventorySlots.forEach((invSlot, idx) => {
              if (firstEmptySlot === -1 && invSlot.classList.contains("empty")) {
                firstEmptySlot = idx;
              }
            });

            sendRequest({
              type: "UNEQUIP_ITEM",
              data: { slot: slotName, targetSlotIndex: firstEmptySlot >= 0 ? firstEmptySlot : undefined },
            });
          };

          slotElement.ondragstart = (event: DragEvent) => {

            hideItemTooltip();

            if (event.dataTransfer) {
              event.dataTransfer.setData("equipped-item-slot", slotName);
              event.dataTransfer.setData("equipped-item-name", String(itemName));
              event.dataTransfer.effectAllowed = "move";
              slotElement.style.opacity = "0.5";
            }
          }

          slotElement.ondragend = () => {
            slotElement.style.opacity = "1";
          };

          slotElement.draggable = true;
          slotElement.dataset.equippedItem = String(itemName);

          const iconImage = new Image();
          iconImage.draggable = false;
          iconImage.width = 32;
          iconImage.height = 32;
          iconImage.style.pointerEvents = "none";
          iconImage.onload = () => {
            slotElement.appendChild(iconImage);
          };
          iconImage.src = iconSrc;

          setupItemTooltip(slotElement, () => itemDetails);
        } else {

          slotElement.innerHTML = String(itemName);
          slotElement.classList.remove("empty");

          slotElement.addEventListener("dblclick", () => {

            hideItemTooltip();

            const inventorySlots = inventoryGrid.querySelectorAll(".slot");
            let firstEmptySlot = -1;
            inventorySlots.forEach((invSlot, idx) => {
              if (firstEmptySlot === -1 && invSlot.classList.contains("empty")) {
                firstEmptySlot = idx;
              }
            });

            sendRequest({
              type: "UNEQUIP_ITEM",
              data: { slot: slotName, targetSlotIndex: firstEmptySlot >= 0 ? firstEmptySlot : undefined },
            });
          });

          slotElement.draggable = true;
          slotElement.dataset.equippedItem = String(itemName);

          slotElement.addEventListener("dragstart", (event: DragEvent) => {

            hideItemTooltip();

            if (event.dataTransfer) {
              event.dataTransfer.setData("equipped-item-slot", slotName);
              event.dataTransfer.setData("equipped-item-name", String(itemName));
              event.dataTransfer.effectAllowed = "move";
              slotElement.style.opacity = "0.5";
            }
          });

          slotElement.addEventListener("dragend", () => {
            slotElement.style.opacity = "1";
          });

          setupItemTooltip(slotElement, () => itemDetails);
        }
      }

      break;
    }
    case "INVENTORY":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];

        // Ensure all items have iconUrl (convert from icon if needed)
        const assetServerUrl = data.find((item: any) => item.iconUrl)?.iconUrl?.split('/icon')?.[0] || "http://127.0.0.1:8000";
        data.forEach((item: any) => {
          if (!item.iconUrl && item.icon) {
            item.iconUrl = `${assetServerUrl}/icon?name=${encodeURIComponent(item.icon)}`;
          }
        });

        cache.inventory = data;

        // Populate global item cache for equipment lookups
        data.forEach((item: any) => {
          itemsByName.set(item.name, item);
        });

        inventoryGrid.querySelectorAll(".slot").forEach((slot) => {

          removeItemTooltip(slot as HTMLElement);
          inventoryGrid.removeChild(slot);
        });

        const itemMap: { [key: string]: any } = {};
        data.forEach((item: any) => {
          if (!item.equipped) {
            itemMap[item.name] = item;
          }
        });

        const slotArray: (any | null)[] = new Array(slots).fill(null);

        if (cache.inventoryConfig) {

          for (const slotIndex in cache.inventoryConfig) {
            const itemName = cache.inventoryConfig[slotIndex];
            const idx = parseInt(slotIndex);
            if (itemName && itemMap[itemName] && idx >= 0 && idx < slots) {
              slotArray[idx] = itemMap[itemName];
              delete itemMap[itemName];
            }
          }

          let nextEmptySlot = 0;
          for (const itemName in itemMap) {

            while (nextEmptySlot < slots && slotArray[nextEmptySlot] !== null) {
              nextEmptySlot++;
            }
            if (nextEmptySlot < slots) {
              slotArray[nextEmptySlot] = itemMap[itemName];
              nextEmptySlot++;
            }
          }
        } else {

          let slotIndex = 0;
          for (const itemName in itemMap) {
            if (slotIndex < slots) {
              slotArray[slotIndex] = itemMap[itemName];
              slotIndex++;
            }
          }
        }

        for (let i = 0; i < slots; i++) {
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("ui");
          slot.dataset.inventoryIndex = i.toString();

          const item = slotArray[i];

          if (item) {

            slot.classList.add(item.quality.toLowerCase() || "common");

            if (item.iconUrl) {

              createCachedImage(item.iconUrl).then((iconImage) => {
                iconImage.draggable = false;
                iconImage.style.pointerEvents = "none";
                iconImage.width = 32;
                iconImage.height = 32;
                slot.appendChild(iconImage);

                if (item.quantity > 1) {
                  const quantityLabel = document.createElement("div");
                  quantityLabel.classList.add("quantity-label");
                  quantityLabel.innerText = `x${item.quantity}`;
                  quantityLabel.style.pointerEvents = "none";
                  slot.appendChild(quantityLabel);
                }

                slot.dataset.itemName = item.name;
                slot.dataset.itemType = item.type;

                if (item.type === "equipment") {
                  slot.dataset.equipmentSlot = item.equipment_slot;
                }

                slot.draggable = true;
                slot.setAttribute("draggable", "true");

                setupItemTooltip(slot, () => {

                  const itemName = slot.dataset.itemName;
                  if (!itemName || !cache.inventory) return null;
                  return cache.inventory.find((invItem: any) => invItem.name === itemName);
                });
              });
            } else {
              slot.innerHTML = `${item.name}${
                item.quantity > 1 ? `<br>x${item.quantity}` : ""
              }`;
              slot.dataset.itemName = item.name;
              slot.dataset.itemType = item.type;
              if (item.type === "equipment") {
                slot.dataset.equipmentSlot = item.equipment_slot;
              }
              slot.draggable = true;
              slot.setAttribute("draggable", "true");

              setupItemTooltip(slot, () => {

                const itemName = slot.dataset.itemName;
                if (!itemName || !cache.inventory) return null;
                return cache.inventory.find((invItem: any) => invItem.name === itemName);
              });
            }
          } else {

            slot.classList.add("empty");
          }

          inventoryGrid.appendChild(slot);
        }

        setupInventorySlotHandlers();
      }
      break;
    case "QUESTLOG": {

      break;
    }
    case "QUESTDETAILS": {

      break;
    }
    case "CHAT": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {

          player.chat = data.message;
          player.chatType = "normal";

          const username =
            data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
          const timestamp = new Date().toLocaleTimeString();

          if (data.message?.trim() !== "" && username) {
            const message = document.createElement("div");
            message.classList.add("message");
            message.classList.add("ui");
            message.style.userSelect = "text";

            const escapedMessage = data.message
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            message.innerHTML = `<span>${timestamp} <span ${player.isAdmin ? "class='admin'" : "class='user'"}>${username}: </span><span>${escapedMessage.toString()}</span></span>`;
            chatMessages.appendChild(message);

            chatMessages.scrollTop = chatMessages.scrollHeight;

            player.typing = false;
          }
        }
      });
      break;
    }
    case "TYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = true;

          if (player.typingTimeout) {
            clearTimeout(player.typingTimeout);
          }

          player.typingTimeout = setTimeout(() => {
            player.typing = false;
          }, 3000);
        }
      });
      break;
    }
    case "STOPTYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = false;
        }
      });
      break;
    }
    case "NPCDIALOG": {
      const npc = cache.npcs.find((npc) => npc.id === data.id);
      if (!npc) return;
      npc.dialog = data.dialog;
      break;
    }
    case "STATS": {
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (!player) return;
      updateXp(data.xp, data.level, data.max_xp);
      player.stats = data;
      player.max_health = data.total_max_health;
      player.max_stamina = data.total_max_stamina;

      if (statUI.style.left === "10px" && statUI.getAttribute("data-id") === String(data.id)) {
        levelLabel!.innerText = `Level: ${data.level}`;
        healthLabel!.innerText = `Health: ${data.health} / ${data.total_max_health}`;
        manaLabel!.innerText = `Mana: ${data.stamina} / ${data.total_max_stamina}`;
        damageLabel!.innerText = `Damage: ${data.stat_damage || 0}`;
        armorLabel!.innerText = `Armor: ${data.stat_armor || 0}%`;
        critChanceLabel!.innerText = `Critical Chance: ${data.stat_critical_chance || 0}%`;
        critDamageLabel!.innerText = `Critical Damage: ${data.stat_critical_damage || 0}%`;
        avoidanceLabel!.innerText = `Avoidance: ${data.stat_avoidance || 0}%`;
      }

      const currentPlayer = Array.from(cache.players).find(
        (p) => p.id === cachedPlayerId
      );
      if (currentPlayer?.party?.includes(player.username)) {
        updatePartyMemberStats(
          player.username,
          data.health,
          data.total_max_health,
          data.stamina,
          data.total_max_stamina
        );
      }
      break;
    }
    case "CLIENTCONFIG": {
      const data = JSON.parse(packet.decode(event.data))["data"][0];
      fpsSlider.value = data.fps;
      document.getElementById(
        "limit-fps-label"
      )!.innerText = `FPS: (${fpsSlider.value})`;
      musicSlider.value = data.music_volume || 0;
      document.getElementById(
        "music-volume-label"
      )!.innerText = `Music: (${musicSlider.value})`;
      effectsSlider.value = data.effects_volume || 0;
      document.getElementById(
        "effects-volume-label"
      )!.innerText = `Effects: (${effectsSlider.value})`;
      mutedCheckbox.checked = data.muted;
      document.getElementById(
        "muted-checkbox"
      )!.innerText = `Muted: ${mutedCheckbox.checked}`;

      if (data.hotbar_config) {
        loadHotbarConfiguration(data.hotbar_config);
      }

      if (data.inventory_config) {

        if (typeof data.inventory_config === 'string') {
          try {
            cache.inventoryConfig = JSON.parse(data.inventory_config);
          } catch (error) {
            cache.inventoryConfig = {};
          }
        } else if (typeof data.inventory_config === 'object' && data.inventory_config !== null) {
          cache.inventoryConfig = data.inventory_config;
        } else {
          cache.inventoryConfig = {};
        }
      }
      break;
    }
    case "SELECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (!data || !data.id) {
        const target = Array.from(cache.players).find((p) => p.targeted);
        if (target) target.targeted = false;
        cache.targetId = null;

        break;
      }

      // Check if it's a player or entity
      const isPlayer = data.username !== undefined;

      if (isPlayer) {
        // Handle player targeting
        cache.players.forEach((player) => {
          player.targeted = player.id === data.id;
        });
        cache.targetId = null;
      } else {
        // Handle entity targeting
        cache.targetId = data.id;
      }

      break;
    }
    case "NOCLIP": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId || player.id === cachedPlayerId
      );

      if (currentPlayer && data.id === currentPlayer.id) {
        const noclipButton = document.getElementById("admin-noclip");
        if (noclipButton) {
          if (data.isNoclip) {
            noclipButton.classList.add("active");
          } else {
            noclipButton.classList.remove("active");
          }
        }
      }

      break;
    }
    case "STEALTH": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId || player.id === cachedPlayerId
      );

      if (currentPlayer && data.id === currentPlayer.id) {
        sendRequest({
          type: "MOVEXY",
          data: "ABORT",
        });

        const stealthButton = document.getElementById("admin-stealth");
        if (stealthButton) {
          if (data.isStealth) {
            stealthButton.classList.add("active");
          } else {
            stealthButton.classList.remove("active");
          }
        }
      }

      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.isStealth = data.isStealth;
        }

        if (player.isStealth && player.targeted) {
          player.targeted = false;
        }
      });

      break;
    }
    case "UPDATESTATS": {
      const { target, stats, isCrit, username, damage, entity } = JSON.parse(packet.decode(event.data))["data"];

      let t;

      if (entity) {
        // Entity target
        t = cache.entities.find((e: any) => e.id === target);
      } else {
        // Player target
        t = Array.from(cache.players).find(
          (player) => player.id === target
        );
      }

      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId
      );

      if (t) {

        const oldHealth = entity ? t.health : t.stats.health;
        const newHealth = stats.health;
        const healthDiff = newHealth - oldHealth;


        const isRevive = (oldHealth <= 0 && newHealth === stats.total_max_health) ||
                         (newHealth === stats.total_max_health && healthDiff > stats.total_max_health * 0.5);

        if (healthDiff !== 0 && oldHealth > 0 && !isRevive) {

          const randomOffsetX = (Math.random() - 0.5) * 20;
          const randomOffsetY = (Math.random() - 0.5) * 10;

          t.damageNumbers.push({
            value: Math.abs(healthDiff),
            x: t.position.x + randomOffsetX,
            y: t.position.y - 30 + randomOffsetY,
            startTime: performance.now(),
            isHealing: healthDiff > 0,
            isCrit: isCrit || false,
            isMiss: false,
          });
        } else if (damage === 0 && newHealth > 0 && oldHealth > 0 && !isRevive) {

          const randomOffsetX = (Math.random() - 0.5) * 20;
          const randomOffsetY = (Math.random() - 0.5) * 10;

          t.damageNumbers.push({
            value: 0,
            x: t.position.x + randomOffsetX,
            y: t.position.y - 30 + randomOffsetY,
            startTime: performance.now(),
            isHealing: false,
            isCrit: false,
            isMiss: true,
          });
        }

        if (entity) {
          // For entities, update health directly
          t.health = stats.health;
          t.max_health = stats.total_max_health;
          // Set combatState to 'dead' if health <= 0
          if (t.health <= 0) {
            t.combatState = 'dead';
          }
        } else {
          // For players, merge stats object (preserve existing fields)
          t.stats = { ...t.stats, ...stats };
          t.max_health = stats.total_max_health;
          t.max_stamina = stats.total_max_stamina;
        }

        if (statUI.style.left === "10px" && statUI.getAttribute("data-id") === String(target)) {
          // Use existing player stats for fields not included in damage packet
          const displayLevel = stats.level !== undefined ? stats.level : t.stats.level;
          const displayStamina = stats.stamina !== undefined ? stats.stamina : t.stats.stamina;
          const displayMaxStamina = stats.total_max_stamina !== undefined ? stats.total_max_stamina : t.stats.total_max_stamina;

          levelLabel!.innerText = `Level: ${displayLevel}`;
          healthLabel!.innerText = `Health: ${stats.health} / ${stats.total_max_health}`;
          manaLabel!.innerText = `Mana: ${displayStamina} / ${displayMaxStamina}`;
          damageLabel!.innerText = `Damage: ${stats.stat_damage || 0}`;
          armorLabel!.innerText = `Armor: ${stats.stat_armor || 0}%`;
          critChanceLabel!.innerText = `Critical Chance: ${stats.stat_critical_chance || 0}%`;
          critDamageLabel!.innerText = `Critical Damage: ${stats.stat_critical_damage || 0}%`;
          avoidanceLabel!.innerText = `Avoidance: ${stats.stat_avoidance || 0}%`;
        }

        if (currentPlayer?.party?.includes(t.username)) {
          updatePartyMemberStats(
            t.username,
            stats.health,
            stats.total_max_health,
            stats.stamina,
            stats.total_max_stamina
          );
        }
      } else if (username && currentPlayer?.party?.includes(username)) {

        updatePartyMemberStats(
          username,
          stats.health,
          stats.total_max_health,
          stats.stamina,
          stats.total_max_stamina
        );
      }
      break;
    }
    case "REVIVE": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const target = Array.from(cache.players).find(
        (player) => player.id === data.target
      );
      if (!target) return;

      target.stats = data.stats;
      target.max_health = data.stats.total_max_health;
      target.max_stamina = data.stats.total_max_stamina;

      const isSelf = target.id.toString() === cachedPlayerId;

      if (!isSelf) {
        target.targeted = false;
      }

      cache.players.forEach((player) => (player.targeted = false));

      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId
      );
      if (currentPlayer?.party?.includes(target.username)) {
        updatePartyMemberStats(
          target.username,
          data.stats.health,
          data.stats.total_max_health,
          data.stats.stamina,
          data.stats.total_max_stamina
        );
      }
      break;
    }
    case "UPDATE_XP": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (data.id === cachedPlayerId) {
        updateXp(data.xp, data.level, data.max_xp);
      }
      break;
    }
    case "INSPECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      const previousShownId = statUI.getAttribute("data-id");

      const username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
      usernameLabel!.innerText = username;

      levelLabel!.innerText = `Level: ${data.stats.level}`;
      healthLabel!.innerText = `Health: ${data.stats.health} / ${data.stats.total_max_health}`;
      manaLabel!.innerText = `Mana: ${data.stats.stamina} / ${data.stats.total_max_stamina}`;
      damageLabel!.innerText = `Damage: ${data.stats.stat_damage || 0}`;
      armorLabel!.innerText = `Armor: ${data.stats.stat_armor || 0}%`;
      critChanceLabel!.innerText = `Critical Chance: ${data.stats.stat_critical_chance || 0}%`;
      critDamageLabel!.innerText = `Critical Damage: ${data.stats.stat_critical_damage || 0}%`;
      avoidanceLabel!.innerText = `Avoidance: ${data.stats.stat_avoidance || 0}%`;

      if (String(data.id) !== String(cachedPlayerId) && data.equipment) {

        const allSlots = [
          ...equipmentLeftColumn.querySelectorAll(".slot"),
          ...equipmentRightColumn.querySelectorAll(".slot"),
          ...equipmentBottomCenter.querySelectorAll(".slot"),
        ];

        allSlots.forEach((slot) => {

          removeItemTooltip(slot as HTMLElement);

          const newSlot = slot.cloneNode(false) as HTMLElement;

          const slotType = slot.getAttribute("data-slot");
          if (slotType) {
            newSlot.setAttribute("data-slot", slotType);
          }

          newSlot.innerHTML = "";
          newSlot.className = "slot empty ui";

          (newSlot as any)._updateId = Date.now() + Math.random();

          slot.parentNode?.replaceChild(newSlot, slot);
        });

        const targetInventory = data.inventory || [];

        for (const [slotName, itemName] of Object.entries(data.equipment)) {
          if (!itemName) continue;

          if (slotName === 'body' || slotName === 'head') continue;

          const slotElement = document.querySelector(`.slot[data-slot="${slotName}"]`) as HTMLDivElement;
          if (!slotElement) continue;

          let itemDetails = targetInventory.find((item: any) => item.name === itemName);

          // If item doesn't have iconUrl but has icon, generate it
          if (itemDetails && !itemDetails.iconUrl && itemDetails.icon) {
            const assetServerUrl = targetInventory.find((item: any) => item.iconUrl)?.iconUrl?.split('/icon')?.[0] || "http://127.0.0.1:8000";
            itemDetails = {
              ...itemDetails,
              iconUrl: `${assetServerUrl}/icon?name=${encodeURIComponent(itemDetails.icon)}`
            };
          }

          if (itemDetails && itemDetails.iconUrl) {
            if (itemDetails.quality) {
              slotElement.classList.add(itemDetails.quality.toLowerCase());
              slotElement.classList.remove("empty");
            }

            createCachedImage(itemDetails.iconUrl).then((iconImage) => {
              iconImage.draggable = false;
              iconImage.width = 32;
              iconImage.height = 32;
              slotElement.appendChild(iconImage);

              setupItemTooltip(slotElement, () => itemDetails);
            });
          } else {

            slotElement.innerHTML = String(itemName);
            slotElement.classList.remove("empty");

            setupItemTooltip(slotElement, () => itemDetails);
          }
        }
      } else if (String(data.id) === String(cachedPlayerId)) {

        if (previousShownId && previousShownId !== String(cachedPlayerId)) {

          if (cache.equipment) {

            const allSlots = [
              ...equipmentLeftColumn.querySelectorAll(".slot"),
              ...equipmentRightColumn.querySelectorAll(".slot"),
              ...equipmentBottomCenter.querySelectorAll(".slot"),
            ];

            allSlots.forEach((slot) => {

              removeItemTooltip(slot as HTMLElement);

              slot.innerHTML = "";
              slot.className = "slot empty ui";

              Array.from(slot.attributes).forEach(attr => {
                if (attr.name !== "data-slot" && attr.name !== "class") {
                  slot.removeAttribute(attr.name);
                }
              });
            });

            setupEquipmentSlotHandlers();

            for (const [slotName, itemName] of Object.entries(cache.equipment)) {
              if (!itemName) continue;

              if (slotName === 'body' || slotName === 'head') continue;

              const slotElement = document.querySelector(`.slot[data-slot="${slotName}"]`) as HTMLDivElement;
              if (!slotElement) continue;

              const inventoryData = cache.inventory || [];
              const itemDetails = inventoryData.find((item: any) => item.name === itemName);

              if (itemDetails && itemDetails.iconUrl) {

                if (itemDetails.quality) {
                  slotElement.classList.add(itemDetails.quality.toLowerCase());
                  slotElement.classList.remove("empty");
                }

                const iconSrc = itemDetails.iconUrl;

                slotElement.ondblclick = () => {

                  hideItemTooltip();

                  const inventorySlots = inventoryGrid.querySelectorAll(".slot");
                  let firstEmptySlot = -1;
                  inventorySlots.forEach((invSlot, idx) => {
                    if (firstEmptySlot === -1 && invSlot.classList.contains("empty")) {
                      firstEmptySlot = idx;
                    }
                  });

                  sendRequest({
                    type: "UNEQUIP_ITEM",
                    data: { slot: slotName, targetSlotIndex: firstEmptySlot >= 0 ? firstEmptySlot : undefined },
                  });
                };

                slotElement.ondragstart = (event: DragEvent) => {

                  hideItemTooltip();

                  if (event.dataTransfer) {
                    event.dataTransfer.setData("equipped-item-slot", slotName);
                    event.dataTransfer.setData("equipped-item-name", String(itemName));
                    event.dataTransfer.effectAllowed = "move";
                    slotElement.style.opacity = "0.5";
                  }
                };

                slotElement.ondragend = () => {
                  slotElement.style.opacity = "1";
                };

                slotElement.draggable = true;
                slotElement.dataset.equippedItem = String(itemName);

                const iconImage = new Image();
                iconImage.draggable = false;
                iconImage.width = 32;
                iconImage.height = 32;
                iconImage.style.pointerEvents = "none";
                iconImage.onload = () => {
                  slotElement.appendChild(iconImage);
                };
                iconImage.src = iconSrc;

                setupItemTooltip(slotElement, () => itemDetails);
              } else {

                slotElement.innerHTML = String(itemName);
                slotElement.classList.remove("empty");

                slotElement.addEventListener("dblclick", () => {

                  hideItemTooltip();

                  const inventorySlots = inventoryGrid.querySelectorAll(".slot");
                  let firstEmptySlot = -1;
                  inventorySlots.forEach((invSlot, idx) => {
                    if (firstEmptySlot === -1 && invSlot.classList.contains("empty")) {
                      firstEmptySlot = idx;
                    }
                  });

                  sendRequest({
                    type: "UNEQUIP_ITEM",
                    data: { slot: slotName, targetSlotIndex: firstEmptySlot >= 0 ? firstEmptySlot : undefined },
                  });
                });

                slotElement.draggable = true;
                slotElement.dataset.equippedItem = String(itemName);

                slotElement.addEventListener("dragstart", (event: DragEvent) => {

                  hideItemTooltip();

                  if (event.dataTransfer) {
                    event.dataTransfer.setData("equipped-item-slot", slotName);
                    event.dataTransfer.setData("equipped-item-name", String(itemName));
                    event.dataTransfer.effectAllowed = "move";
                    slotElement.style.opacity = "0.5";
                  }
                });

                slotElement.addEventListener("dragend", () => {
                  slotElement.style.opacity = "1";
                });

                setupItemTooltip(slotElement, () => itemDetails);
              }
            }
          }
        }

      }

      statUI.setAttribute("data-id", data.id);

      statUI.style.transition = "1s";
      statUI.style.left = "10px";
      break;
    }
    case "NOTIFY": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      showNotification(data.message, true, false);
      break;
    }
    case "WHISPER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();

      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.classList.add("ui");
        message.style.userSelect = "text";

        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `<span>${timestamp} <span class="whisper-username">${username}:</span> <span class="whisper-message">${escapedMessage}</span></span>`;
        chatMessages.appendChild(message);

        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "PARTY_CHAT": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();

      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.chat = data.message;
          player.chatType = "party";

          setTimeout(() => {
            const currentPlayer = Array.from(cache.players).find(p => p.id === data.id);
            if (currentPlayer?.chat === data.message && currentPlayer?.chatType === "party") {
              currentPlayer.chat = "";
              currentPlayer.chatType = "global";
            }
          }, 7000 + data.message.length * 35);
        }
      });

      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.classList.add("ui");
        message.style.userSelect = "text";

        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `<span>${timestamp} <span class="party-username">${username}:</span> <span class="party-message">${escapedMessage}</span></span>`;
        chatMessages.appendChild(message);

        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "CURRENCY": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (!cachedPlayerId) break;

      const currentPlayer = Array.from(cache.players).find(
        (p) => p.id === cachedPlayerId
      );
      if (currentPlayer && data) {
        currentPlayer.currency = {
          copper: data.copper || 0,
          silver: data.silver || 0,
          gold: data.gold || 0,
        };
      }

      updateCurrencyDisplay();
      break;
    }
    case "MAP_CHUNK": {

      if (data.error) {
        const chunkKey = pendingMapChunkRequests.keys().next().value;
        if (chunkKey) {
          const resolver = pendingMapChunkRequests.get(chunkKey);
          if (resolver) {
            resolver.reject(new Error(data.error));
            pendingMapChunkRequests.delete(chunkKey);
          }
        }
        break;
      }

      const chunkKey = `${data.chunkX}-${data.chunkY}`;
      const resolver = pendingMapChunkRequests.get(chunkKey);
      if (resolver) {
        resolver.resolve(data);
        pendingMapChunkRequests.delete(chunkKey);
      }
      break;
    }
    case "TILESET": {

      if (data.error) {
        const name = pendingTilesetRequests.keys().next().value;
        if (name) {
          const resolver = pendingTilesetRequests.get(name);
          if (resolver) {
            resolver.reject(new Error(data.error));
            pendingTilesetRequests.delete(name);
            tilesetChunks.delete(name);
          }
        }
        break;
      }

      if (data.chunkIndex !== undefined) {
        const tilesetName = data.name;

        if (data.chunkIndex === -1) {
          tilesetChunks.set(tilesetName, {
            chunks: new Array(data.totalChunks),
            totalChunks: data.totalChunks,
            received: 0
          });
        } else {

          const state = tilesetChunks.get(tilesetName);
          if (state) {
            state.chunks[data.chunkIndex] = data.data;
            state.received++;

            if (state.received === state.totalChunks) {
              const completeData = state.chunks.join('');
              const resolver = pendingTilesetRequests.get(tilesetName);
              if (resolver) {
                resolver.resolve({ name: tilesetName, data: completeData });
                pendingTilesetRequests.delete(tilesetName);
              }
              tilesetChunks.delete(tilesetName);
            }
          }
        }
      } else if (data.tileset) {

        const resolver = pendingTilesetRequests.get(data.tileset.name);
        if (resolver) {
          resolver.resolve(data.tileset);
          pendingTilesetRequests.delete(data.tileset.name);
        }
      }
      break;
    }
    case "DEBUG_ASTAR": {
      // Store A* debug data for visualization
      (window as any).astarDebugData = data;
      break;
    }
    case "DRAG_PLAYER_START": {
      // Called when an admin starts dragging a player
      // data = { id: playerId, adminId: adminId }
      if (!data || !data.id) break;

      const draggedPlayer = Array.from(cache.players).find((p) => p.id === data.id);
      if (draggedPlayer) {
        draggedPlayer.canmove = false;  // Prevent the dragged player from moving
      }
      break;
    }
    case "DRAG_PLAYER_STOP": {
      // Called when an admin stops dragging a player
      // data = { id: playerId, adminId: adminId }
      if (!data || !data.id) break;

      const draggedPlayer = Array.from(cache.players).find((p) => p.id === data.id);
      if (draggedPlayer) {
        draggedPlayer.canmove = true;  // Allow the dragged player to move again

        // If the released player is the current player, send MOVEXY abort to clear stuck movement on server
        if (draggedPlayer.id === cachedPlayerId) {
          sendRequest({ type: "MOVEXY", data: "ABORT" });
        }
      }
      break;
    }
    case "DRAG_UPDATE": {
      // Server sends position updates for dragged players
      // This handler is called when the client receives movement updates for dragged players
      // data = { id: playerId, x: number, y: number }
      if (!data || !data.id || data.x === undefined || data.y === undefined) break;

      const draggedPlayer = Array.from(cache.players).find((p) => p.id === data.id);
      if (draggedPlayer) {
        // Update the dragged player's position
        draggedPlayer.serverPosition.x = Math.round(data.x);
        draggedPlayer.serverPosition.y = Math.round(data.y);
        draggedPlayer.position.x = Math.round(data.x);
        draggedPlayer.position.y = Math.round(data.y);
        draggedPlayer.lastServerUpdate = performance.now();
      }
      break;
    }
    default:
      break;
  }
};

if (version) {
  const versionText = document.createElement("div");
  versionText.style.position = "fixed";
  versionText.style.bottom = "5px";
  versionText.style.right = "10px";
  versionText.style.fontSize = "14px";
  versionText.style.color = "rgba(255, 255, 255, 0.5)";
  versionText.style.zIndex = "1000";
  versionText.style.userSelect = "none";
  versionText.innerText = `v${version}`;
  document.body.appendChild(versionText);
}

function showNotification(
  message: string,
  autoClose: boolean = true,
  reconnect: boolean = false
) {
  if (!notificationContainer || !notificationMessage) return;

  notificationMessage.innerText = message;
  notificationContainer.style.display = "flex";

  const baseTimeout = 5000;
  const timePerChar = 100;
  const timeout = baseTimeout + message.length * timePerChar;

  if (autoClose) {

    if (clearNotificationTimeout) {
      clearTimeout(clearNotificationTimeout);
    }
    clearNotificationTimeout = setTimeout(() => {
      if (!notificationContainer || !notificationMessage) return;
      notificationContainer.style.display = "none";

      if (reconnect) {
        if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
          window.close();
        } else {

          window.location.href = "/";
        }
      }
    }, timeout);
  } else if (reconnect) {

    setTimeout(() => {
      if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
        window.close();
      } else {
        window.location.href = "/";
      }
    }, timeout);
  }
}

}

let loaded: boolean = false;
export let selfPlayerSpriteLoaded: boolean = false;

export function setSelfPlayerSpriteLoaded(value: boolean) {
  selfPlayerSpriteLoaded = value;

  if (value && loaded) {
    hideLoadingScreen();
  }
}

async function hideLoadingScreen() {
  const { loadingScreen, progressBar, progressBarContainer } = await import('./ui.js');

  if (loadingScreen) {
    loadingScreen.style.transition = "1s";
    loadingScreen.style.opacity = "0";
    setTimeout(() => {
      if (loadingScreen) {
        loadingScreen.style.display = "none";
        if (progressBar) progressBar.style.width = "0%";
        if (progressBarContainer) progressBarContainer.style.display = "block";
      }
    }, 1000);
  }
}

function getIsLoaded() {
  return loaded;
}

async function isLoaded() {

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (loaded) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

initializeSocket();

setInterval(() => {
  if (
    packetsSentReceived.innerText ===
    `Sent: ${sentRequests}, Received: ${receivedResponses}`
  )
    return;
  packetsSentReceived.innerText = `Sent: ${sentRequests}, Received: ${receivedResponses}`;
  sentRequests = 0;
  receivedResponses = 0;
}, 1000);

async function openAnimationDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("AnimationCache", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("animations")) {
        db.createObjectStore("animations");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAnimationFromDB(
  name: string
): Promise<Uint8Array | undefined> {
  const db = await openAnimationDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("animations", "readonly");
    const store = tx.objectStore("animations");
    const req = store.get(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAnimationToDB(name: string, data: Uint8Array) {
  const db = await openAnimationDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("animations", "readwrite");
    const store = tx.objectStore("animations");
    const req = store.put(data, name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

setupEquipmentSlotHandlers();

(window as any).__socketModule = {
  sendRequest,
  pendingMapChunkRequests
};

export { sendRequest, cachedPlayerId, getIsLoaded };
