import { getIsLoaded, getMovementAllowed, cachedPlayerId, sendRequest } from "./socket.js";
import { getIsKeyPressed, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache.ts";
import { getParticleSprite, particlePool } from "./npc.js";
let weatherType = null as string | null;
let currentWeatherData = null as any; // Store full weather object for wind speed
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar, updateAbsorptionBar } from "./ui.js";
import { updateWeatherCanvas, weather } from './weather.ts';
import { renderShadows } from './shadows.js';
import { renderLightMap } from './lightmap.js';
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
import { animationManager } from "./animationStateManager.js";
import { updateLayeredAnimation } from "./layeredAnimation.js";
const times = [] as number[];
let lastFpsUpdate = 0;
let lastDirection = "";
let cameraX: number = 0, cameraY: number = 0, lastFrameTime: number = 0, nextFrameTime: number = 0;
let smoothMapX: number = 0, smoothMapY: number = 0;
let cameraInitialized: boolean = false;
// Free-pan editor camera state (used only while the tile editor is active).
let editorCameraX: number = 0, editorCameraY: number = 0;
let editorCameraInitialized: boolean = false;

// Chunk load time tracking for fade-in effect
const chunkLoadTimes = new Map<string, number>();
const CHUNK_FADE_DURATION = 0.5; // Fade duration in seconds

// Tileset lookup cache for fast tile->tileset resolution
let tilesetLookupCache: Map<number, {tileset: any, index: number}> = new Map();

import { canvas, ctx, fpsSlider, healthBar, staminaBar, collisionDebugCheckbox, chunkOutlineDebugCheckbox, collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, astarDebugCheckbox, shadowsDebugCheckbox, loadedChunksText } from "./ui.js";

const SERVER_TICK_RATE = 30;
const SERVER_FRAME_TIME = 1000 / SERVER_TICK_RATE;
const SERVER_SPEED = 6;

let lastMovementTime = 0;

// Player render position smoothing configuration
const PLAYER_SMOOTHING_FACTOR = 0.2; // Higher = faster movement

function updateLocalPlayerPrediction(currentPlayer: any, now: number) {
  if (!currentPlayer) return;
  // Movement stays locked until the loading screen begins to fade.
  if (!getMovementAllowed()) return;
  
  const isMoving = getIsMoving() && getIsKeyPressed();
  
  if (!isMoving) {
    return;
  }
  
  const timeSinceLastMove = now - lastMovementTime;
  if (timeSinceLastMove < SERVER_FRAME_TIME) {
    return;
  }
  lastMovementTime = now - (timeSinceLastMove % SERVER_FRAME_TIME);
  
  const keys = pressedKeys;
  let direction = "";
  if (keys.has("KeyW") && keys.has("KeyA")) direction = "UPLEFT";
  else if (keys.has("KeyW") && keys.has("KeyD")) direction = "UPRIGHT";
  else if (keys.has("KeyS") && keys.has("KeyA")) direction = "DOWNLEFT";
  else if (keys.has("KeyS") && keys.has("KeyD")) direction = "DOWNRIGHT";
  else if (keys.has("KeyW")) direction = "UP";
  else if (keys.has("KeyS")) direction = "DOWN";
  else if (keys.has("KeyA")) direction = "LEFT";
  else if (keys.has("KeyD")) direction = "RIGHT";
  
  if (!direction) return;
  
  const directionOffsets: Record<string, { dx: number; dy: number }> = {
    up: { dx: 0, dy: -SERVER_SPEED },
    down: { dx: 0, dy: SERVER_SPEED },
    left: { dx: -SERVER_SPEED, dy: 0 },
    right: { dx: SERVER_SPEED, dy: 0 },
    upleft: { dx: -SERVER_SPEED, dy: -SERVER_SPEED },
    upright: { dx: SERVER_SPEED, dy: -SERVER_SPEED },
    downleft: { dx: -SERVER_SPEED, dy: SERVER_SPEED },
    downright: { dx: SERVER_SPEED, dy: SERVER_SPEED },
  };
  
  const offset = directionOffsets[direction];
  if (offset) {
    currentPlayer.position.x += offset.dx;
    currentPlayer.position.y += offset.dy;
  }
}

function updateRemotePlayerInterpolation(player: any, deltaSeconds: number) {
  if (!player || !player.lastServerUpdate) return;
  if (player.id === cachedPlayerId) return;

  const dx = player.serverPosition.x - player.position.x;
  const dy = player.serverPosition.y - player.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const threshold = 5;
  const lerpFactor = 0.2 * deltaSeconds * 60;
  if (distance > threshold) {
    player.position.x = Math.round(player.position.x + dx * lerpFactor);
    player.position.y = Math.round(player.position.y + dy * lerpFactor);
  }
}

/**
 * Smoothly interpolate entity movement toward server position
 */
function updateEntityInterpolation(entity: any, deltaSeconds: number) {
  if (!entity || !entity.serverPosition) return;

  const dx = entity.serverPosition.x - entity.position.x;
  const dy = entity.serverPosition.y - entity.position.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const threshold = 2; // Stop interpolating when close enough
  const lerpFactor = 0.15 * deltaSeconds * 60; // Smooth interpolation factor

  if (distance > threshold) {
    entity.position.x = Math.round(entity.position.x + dx * lerpFactor);
    entity.position.y = Math.round(entity.position.y + dy * lerpFactor);
  } else if (distance > 0) {
    // Snap to server position when very close
    entity.position.x = entity.serverPosition.x;
    entity.position.y = entity.serverPosition.y;
  }
}

/**
 * Smoothly interpolates render positions toward actual positions
 * This creates smooth camera movement while reducing vibration from client prediction jitter
 * Frame-rate independent smoothing tuned for 144fps
 */
function smoothPlayerRenderPositions(players: any[], currentPlayer: any, deltaTime: number) {
  const TELEPORT_THRESHOLD = 500; // Distance threshold to detect teleports/warps
  const TARGET_FPS = 144; // Target framerate for smoothing calibration

  // Calculate frame-rate independent smoothing factor
  // At 144fps (deltaTime ≈ 0.00694s), use PLAYER_SMOOTHING_FACTOR
  // At lower framerates, scale proportionally to maintain same speed
  const smoothFactor = 1 - Math.pow(1 - PLAYER_SMOOTHING_FACTOR, deltaTime * TARGET_FPS);

  for (const player of players) {
    if (!player) continue;

    // Initialize renderPosition if it doesn't exist
    if (!player.renderPosition) {
      player.renderPosition = { x: player.position.x, y: player.position.y };
      continue;
    }

    // For all players, apply smoothing or snap based on distance
    const dx = player.position.x - player.renderPosition.x;
    const dy = player.position.y - player.renderPosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // If distance is very large (teleport/warp), snap immediately instead of smoothing
    if (distance > TELEPORT_THRESHOLD) {
      player.renderPosition.x = player.position.x;
      player.renderPosition.y = player.position.y;
    } else {
      // Otherwise smoothly lerp toward position with frame-rate independent factor
      player.renderPosition.x = player.renderPosition.x + dx * smoothFactor;
      player.renderPosition.y = player.renderPosition.y + dy * smoothFactor;
    }
  }
}

declare global {
  interface Window {
    mapData?: any;
  }
}

const loadedChunksSet = new Set<string>();
const pendingChunks = new Set<string>();
let pendingRequest: boolean = false;

function updateCamera(currentPlayer: any, deltaTime: number) {
  if (!getIsLoaded()) return;

  const tileEditor = (window as any).tileEditor;
  if (tileEditor?.isActive && window.mapData) {
    // Free-pan editor camera: decoupled from player-follow and unclamped so the
    // user can pan anywhere, including into the infinite paint zone.
    if (!editorCameraInitialized) {
      editorCameraX = cameraX;
      editorCameraY = cameraY;
      editorCameraInitialized = true;
      (window as any).__resetEditorCamera = false;
    }
    cameraX = editorCameraX;
    cameraY = editorCameraY;
    smoothMapX = cameraX;
    smoothMapY = cameraY;

    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType, currentWeatherData);
    }
    return;
  }
  editorCameraInitialized = false;

  if (currentPlayer && window.mapData) {
    const targetX = currentPlayer.renderPosition.x;
    const targetY = currentPlayer.renderPosition.y;

    cameraX = targetX;
    cameraY = targetY;

    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    const mapHeight = window.mapData.height * window.mapData.tileheight;
    const halfViewportWidth = window.innerWidth / 2;
    const halfViewportHeight = window.innerHeight / 2;

    cameraX = Math.max(halfViewportWidth, Math.min(mapWidth - halfViewportWidth, cameraX));
    cameraY = Math.max(halfViewportHeight, Math.min(mapHeight - halfViewportHeight, cameraY));

    smoothMapX = cameraX;
    smoothMapY = cameraY;

    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType, currentWeatherData);
    }
  }
}

// Pan the free-pan editor camera by a world-space delta.
export function panEditorCamera(dx: number, dy: number) {
  if (!window.mapData) return;
  const tw = window.mapData.tilewidth;
  const th = window.mapData.tileheight;
  const mapW = window.mapData.width * tw;
  const mapH = window.mapData.height * th;
  const pad = Math.max(window.innerWidth, window.innerHeight);

  editorCameraX += dx;
  editorCameraY += dy;
  // Clamp so camera cannot pan into negative-tile territory (left/up expansion disabled)
  const minX = window.innerWidth / 2;
  const minY = window.innerHeight / 2;
  const maxX = mapW + pad;
  const maxY = mapH + pad;
  if (editorCameraX < minX) editorCameraX = minX;
  if (editorCameraY < minY) editorCameraY = minY;
  if (editorCameraX > maxX) editorCameraX = maxX;
  if (editorCameraY > maxY) editorCameraY = maxY;
  editorCameraInitialized = true;
}

// Recenter the editor camera on the local player (or the map center as a fallback).
export function resetEditorCamera() {
  const playersArray = Array.from(cache.players instanceof Map ? cache.players.values() : cache.players);
  const currentPlayer = playersArray.find((p: any) => p.id === cachedPlayerId);
  if (currentPlayer) {
    editorCameraX = currentPlayer.renderPosition?.x ?? currentPlayer.position.x;
    editorCameraY = currentPlayer.renderPosition?.y ?? currentPlayer.position.y;
  } else if (window.mapData) {
    editorCameraX = (window.mapData.width * window.mapData.tilewidth) / 2;
    editorCameraY = (window.mapData.height * window.mapData.tileheight) / 2;
  }
  editorCameraInitialized = true;
}

function getVisibleChunks(): Array<{x: number, y: number}> {
  if (!window.mapData) return [];

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const cameraLeft = cameraX - viewportWidth / 2;
  const cameraTop = cameraY - viewportHeight / 2;
  const cameraRight = cameraX + viewportWidth / 2;
  const cameraBottom = cameraY + viewportHeight / 2;

  const padding = chunkPixelSize;

  const minCX = window.mapData.minChunkX ?? 0;
  const minCY = window.mapData.minChunkY ?? 0;
  const startChunkX = Math.max(minCX, Math.floor((cameraLeft - padding) / chunkPixelSize));
  const startChunkY = Math.max(minCY, Math.floor((cameraTop - padding) / chunkPixelSize));
  const endChunkX = Math.min(window.mapData.chunksX - 1, Math.floor((cameraRight + padding) / chunkPixelSize));
  const endChunkY = Math.min(window.mapData.chunksY - 1, Math.floor((cameraBottom + padding) / chunkPixelSize));

  const visible: Array<{x: number, y: number}> = [];
  for (let cy = startChunkY; cy <= endChunkY; cy++) {
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
      visible.push({ x: cx, y: cy });
    }
  }
  return visible;
}

async function loadVisibleChunks() {
  if (!window.mapData) return;

  const visibleChunks = getVisibleChunks();
  const visibleKeys = new Set(visibleChunks.map(c => `${c.x}-${c.y}`));

  const unloadDistance = window.mapData.chunkSize * window.mapData.tilewidth * 2;
  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;

  const chunksToUnload: string[] = [];

  // Don't unload chunks while the editor is active: freshly painted / expansion
  // chunks aren't on the server yet, so unloading would discard unsaved edits.
  const editorActiveForUnload = (window as any).tileEditor?.isActive;
  if (!editorActiveForUnload) for (const chunkKey of loadedChunksSet) {
    if (!visibleKeys.has(chunkKey)) {

      const chunkData = window.mapData.loadedChunks.get(chunkKey);
      if (chunkData) {
        const chunkCenterX = (chunkData.chunkX + 0.5) * chunkPixelSize;
        const chunkCenterY = (chunkData.chunkY + 0.5) * chunkPixelSize;
        const distance = Math.hypot(chunkCenterX - cameraX, chunkCenterY - cameraY);

        if (distance > unloadDistance) {
          chunksToUnload.push(chunkKey);
        }
      }
    }
  }

  for (const chunkKey of chunksToUnload) {
    window.mapData.loadedChunks.delete(chunkKey);
    loadedChunksSet.delete(chunkKey);
    chunkLoadTimes.delete(chunkKey); // Clean up load time tracking
  }

  const chunksToLoad: Array<{x: number, y: number, key: string}> = [];

  for (const chunk of visibleChunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;

    if (!loadedChunksSet.has(chunkKey) && !pendingChunks.has(chunkKey)) {
      chunksToLoad.push({ x: chunk.x, y: chunk.y, key: chunkKey });
      pendingChunks.add(chunkKey);
    }
  }

  if (chunksToLoad.length > 0) {
    const loadPromises = chunksToLoad.map(chunk =>
      window.mapData.requestChunk(chunk.x, chunk.y)
        .then((chunkData: any) => {
          if (chunkData) {
            loadedChunksSet.add(chunk.key);
          }
        })
        .catch((error: any) => {
        })
        .finally(() => {
          pendingChunks.delete(chunk.key);
        })
    );

    Promise.all(loadPromises).catch(() => {});
  }
}

let chunkLoadThrottle = 0;

function segmentForZ(z: number, cuts: Array<{ key: number }>): number {
  let i = 0;
  while (i < cuts.length && z > cuts[i].key) i++;
  return i;
}

function drawAllLayersWithOpacity(segment: number, cuts: Array<{ key: number }>, visibleChunks: any[], offsetX: number, offsetY: number, selectedLayerName: string) {
  if (!ctx || !window.mapData) return;

  const now = performance.now();

  for (const chunk of visibleChunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;
    const chunkData = window.mapData.loadedChunks.get(chunkKey);
    if (!chunkData) continue;

    const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
    const chunkWorldX = chunk.x * chunkPixelSize;
    const chunkWorldY = chunk.y * chunkPixelSize;

    const screenX = chunkWorldX + offsetX;
    const screenY = chunkWorldY + offsetY;

    // Get the appropriate pre-rendered chunk segment canvas
    const chunkCanvas = chunkData.segmentCanvases?.[segment];

    if (!chunkCanvas) continue;

    const sortedLayers = [...chunkData.layers].sort((a: any, b: any) => a.zIndex - b.zIndex);
    const tileEditor = (window as any).tileEditor;

    // Check whether any visible layer lives here (collision/no-pvp are excluded unless selected).
    let hasVisibleLayer = false;

    for (const chunkLayer of sortedLayers) {
      const belongsToThisCanvas = segmentForZ(Number(chunkLayer.zIndex), cuts) === segment;

      if (!belongsToThisCanvas) continue;

      const layerNameLower = chunkLayer.name.toLowerCase();
      const isCollisionOrNoPvp = layerNameLower.includes('collision') ||
        layerNameLower.includes('nopvp') || layerNameLower.includes('no-pvp') || layerNameLower.includes('shadow');

      if (isCollisionOrNoPvp && chunkLayer.name !== selectedLayerName) continue;

      const isLayerVisible = tileEditor?.isLayerVisible(chunkLayer.name) ?? true;
      if (isLayerVisible) {
        hasVisibleLayer = true;
      }
    }

    if (hasVisibleLayer) {
      try {
        ctx.globalAlpha = 1.0;
        ctx.drawImage(chunkCanvas, screenX, screenY);
        drawChunkAnimatedTiles(chunkData, segment, screenX, screenY, 1.0, now);
      } catch (error) {
        console.error("Error drawing chunk canvas:", error);
      }
    }
  }

  ctx.globalAlpha = 1;
}

function renderGraveyardsAndWarps(renderCtx: CanvasRenderingContext2D, offsetX: number, offsetY: number) {
  if (!window.mapData) return;

  const tilesize = 32;
  const tileEditor = (window as any).tileEditor;

  // Render graveyards as tombstones
  if (window.mapData.graveyards) {
    // Check if Graveyards are visible in the Objects panel
    const graveyardsVisible = !tileEditor || tileEditor.isObjectLayerVisible('Graveyards');

    Object.entries(window.mapData.graveyards).forEach(([name, data]: [string, any]) => {
      const x = data.position?.x || 0;
      const y = data.position?.y || 0;
      const isSelected = tileEditor && tileEditor.getSelectedObjectName?.() === name;

      // Draw selection highlight first (behind everything)
      if (isSelected) {
        renderCtx.fillStyle = 'rgba(100, 200, 255, 0.3)';
        renderCtx.beginPath();
        renderCtx.arc(x, y, 25, 0, Math.PI * 2);
        renderCtx.fill();
      }

      // Apply opacity based on visibility toggle
      const opacity = graveyardsVisible ? 1.0 : 0;

      const width = 16;
      const height = 22;
      const cornerRadius = 2;

      // Set opacity based on layer visibility
      const prevAlpha = renderCtx.globalAlpha;
      renderCtx.globalAlpha = opacity;

      // Draw tombstone shadow
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
      renderCtx.fillRect(x - width / 2 + 1, y - height / 2 + 1, width, height);

      // Draw main tombstone body (dark gray or highlighted)
      renderCtx.fillStyle = isSelected ? 'rgba(100, 100, 150, 0.9)' : 'rgba(60, 60, 70, 0.9)';
      renderCtx.strokeStyle = isSelected ? 'rgba(150, 150, 200, 1)' : 'rgba(80, 80, 90, 1)';
      renderCtx.lineWidth = isSelected ? 2.5 : 1.5;

      // Rounded rectangle for tombstone
      renderCtx.beginPath();
      renderCtx.moveTo(x - width / 2 + cornerRadius, y - height / 2);
      renderCtx.lineTo(x + width / 2 - cornerRadius, y - height / 2);
      renderCtx.quadraticCurveTo(x + width / 2, y - height / 2, x + width / 2, y - height / 2 + cornerRadius);
      renderCtx.lineTo(x + width / 2, y + height / 2 - 2);
      renderCtx.quadraticCurveTo(x + width / 2, y + height / 2, x + width / 2 - cornerRadius, y + height / 2);
      renderCtx.lineTo(x - width / 2 + cornerRadius, y + height / 2);
      renderCtx.quadraticCurveTo(x - width / 2, y + height / 2, x - width / 2, y + height / 2 - 2);
      renderCtx.lineTo(x - width / 2, y - height / 2 + cornerRadius);
      renderCtx.quadraticCurveTo(x - width / 2, y - height / 2, x - width / 2 + cornerRadius, y - height / 2);
      renderCtx.fill();
      renderCtx.stroke();

      // Draw lighter edge/highlight
      renderCtx.strokeStyle = 'rgba(120, 120, 130, 0.6)';
      renderCtx.lineWidth = 1;
      renderCtx.beginPath();
      renderCtx.moveTo(x - width / 2 + 2, y - height / 2 + 2);
      renderCtx.lineTo(x - width / 2 + 2, y + height / 2 - 2);
      renderCtx.stroke();

      // Draw cross on tombstone (centered)
      renderCtx.strokeStyle = 'rgba(200, 180, 140, 0.9)';
      renderCtx.lineWidth = 1.5;
      renderCtx.lineCap = 'round';

      // Vertical line of cross
      renderCtx.beginPath();
      renderCtx.moveTo(x, y - 4);
      renderCtx.lineTo(x, y + 2);
      renderCtx.stroke();

      // Horizontal line of cross
      renderCtx.beginPath();
      renderCtx.moveTo(x - 2.5, y - 1);
      renderCtx.lineTo(x + 2.5, y - 1);
      renderCtx.stroke();

      // Draw name label above tombstone with background
      renderCtx.save();
      renderCtx.font = 'bold 13px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.textBaseline = 'middle';

      const textMetrics = renderCtx.measureText(name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const labelX = x;
      const labelY = y - height / 2 - 12;

      // Draw background
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      renderCtx.fillRect(labelX - textWidth / 2 - 4, labelY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);

      // Draw text
      renderCtx.fillStyle = 'rgba(150, 220, 255, 1)';
      renderCtx.fillText(name, labelX, labelY);

      // Store label coordinates for click detection (convert world to screen coords)
      if (tileEditor) {
        const screenX = labelX + offsetX;
        const screenY = labelY + offsetY;
        tileEditor.setLabelCoords(name, 'Graveyards', screenX - textWidth / 2 - 4, screenY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
      }

      // Draw delete button at bottom right when selected
      if (isSelected) {
        const buttonSize = 16;
        const buttonX = x + width / 2 + 8;
        const buttonY = y + height / 2 + 8;

        renderCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
        renderCtx.fillRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(200, 50, 50, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.strokeRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.beginPath();
        renderCtx.moveTo(buttonX + 3, buttonY + 3);
        renderCtx.lineTo(buttonX + buttonSize - 3, buttonY + buttonSize - 3);
        renderCtx.moveTo(buttonX + buttonSize - 3, buttonY + 3);
        renderCtx.lineTo(buttonX + 3, buttonY + buttonSize - 3);
        renderCtx.stroke();

        // Store button coordinates for click detection
        if (tileEditor) {
          tileEditor.setDeleteButtonCoords('Graveyards', name, buttonX, buttonY, buttonSize);
        }
      }

      renderCtx.restore();
      // Restore opacity
      renderCtx.globalAlpha = prevAlpha;
    });
  }

  // Render warps as blue outlines
  if (window.mapData.warps) {
    // Check if Warps are visible in the Objects panel
    const warpsVisible = !tileEditor || tileEditor.isObjectLayerVisible('Warps');

    Object.entries(window.mapData.warps).forEach(([name, data]: [string, any]) => {
      const x = data.position?.x || 0;
      const y = data.position?.y || 0;
      const width = data.size?.width || tilesize;
      const height = data.size?.height || tilesize;
      const isSelected = tileEditor && tileEditor.getSelectedObjectName?.() === name;

      // Draw selection highlight first (behind everything)
      if (isSelected) {
        renderCtx.fillStyle = 'rgba(100, 200, 255, 0.2)';
        renderCtx.fillRect(x - 5, y - 5, width + 10, height + 10);
      }

      // Apply opacity based on visibility toggle
      const opacity = warpsVisible ? 1.0 : 0;

      // Set opacity for rendering
      const prevAlpha = renderCtx.globalAlpha;
      renderCtx.globalAlpha = opacity;

      // Draw blue outline rectangle (position is top-left corner)
      renderCtx.strokeStyle = isSelected ? 'rgba(150, 220, 255, 1)' : 'rgba(0, 150, 255, 0.8)';
      renderCtx.lineWidth = isSelected ? 3 : 2;
      renderCtx.strokeRect(x, y, width, height);

      // Draw corner markers (dark blue)
      renderCtx.fillStyle = 'rgba(50, 100, 200, 1)';
      const markerSize = isSelected ? 6 : 4;
      const corners = [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height]
      ];
      corners.forEach(([cx, cy]) => {
        renderCtx.fillRect(cx - markerSize / 2, cy - markerSize / 2, markerSize, markerSize);
      });

      // Draw edge midpoint markers only when selected
      if (isSelected) {
        const edgeMarkerSize = 5;

        // Top edge midpoint (green)
        renderCtx.fillStyle = 'rgba(100, 255, 100, 1)';
        renderCtx.fillRect(x + width / 2 - edgeMarkerSize / 2, y - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Bottom edge midpoint (green)
        renderCtx.fillStyle = 'rgba(100, 255, 100, 1)';
        renderCtx.fillRect(x + width / 2 - edgeMarkerSize / 2, y + height - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Left edge midpoint (red)
        renderCtx.fillStyle = 'rgba(255, 100, 100, 1)';
        renderCtx.fillRect(x - edgeMarkerSize / 2, y + height / 2 - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);

        // Right edge midpoint (red)
        renderCtx.fillStyle = 'rgba(255, 100, 100, 1)';
        renderCtx.fillRect(x + width - edgeMarkerSize / 2, y + height / 2 - edgeMarkerSize / 2, edgeMarkerSize, edgeMarkerSize);
      }

      // Draw name label above the warp with background
      renderCtx.save();
      renderCtx.font = 'bold 13px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.textBaseline = 'middle';

      const textMetrics = renderCtx.measureText(name);
      const textWidth = textMetrics.width;
      const textHeight = 16;
      const labelX = x + width / 2;
      const labelY = y - 12;

      // Draw background
      renderCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      renderCtx.fillRect(labelX - textWidth / 2 - 4, labelY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);

      // Draw text
      renderCtx.fillStyle = 'rgba(100, 200, 255, 1)';
      renderCtx.fillText(name, labelX, labelY);

      // Store label coordinates for click detection (convert world to screen coords)
      if (tileEditor) {
        const screenX = labelX + offsetX;
        const screenY = labelY + offsetY;
        tileEditor.setLabelCoords(name, 'Warps', screenX - textWidth / 2 - 4, screenY - textHeight / 2 - 2, textWidth + 8, textHeight + 4);
      }

      // Draw delete button at bottom right when selected
      if (isSelected) {
        const buttonSize = 16;
        const buttonX = x + width + 4;
        const buttonY = y + height + 4;

        renderCtx.fillStyle = 'rgba(255, 100, 100, 0.9)';
        renderCtx.fillRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(200, 50, 50, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.strokeRect(buttonX, buttonY, buttonSize, buttonSize);

        renderCtx.strokeStyle = 'rgba(255, 255, 255, 1)';
        renderCtx.lineWidth = 1.5;
        renderCtx.beginPath();
        renderCtx.moveTo(buttonX + 3, buttonY + 3);
        renderCtx.lineTo(buttonX + buttonSize - 3, buttonY + buttonSize - 3);
        renderCtx.moveTo(buttonX + buttonSize - 3, buttonY + 3);
        renderCtx.lineTo(buttonX + 3, buttonY + buttonSize - 3);
        renderCtx.stroke();

        // Store button coordinates for click detection
        if (tileEditor) {
          tileEditor.setDeleteButtonCoords('Warps', name, buttonX, buttonY, buttonSize);
        }
      }

      renderCtx.restore();
      // Restore opacity
      renderCtx.globalAlpha = prevAlpha;
    });
  }
}

// Build a fast tileset lookup map: tileIndex -> {tileset, tilesetIndex}
function buildTilesetLookupMap(): Map<number, {tileset: any, index: number}> {
  const map = new Map<number, {tileset: any, index: number}>();
  if (!window.mapData?.tilesets) return map;

  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    for (let tileIdx = ts.firstgid; tileIdx < ts.firstgid + ts.tilecount; tileIdx++) {
      map.set(tileIdx, { tileset: ts, index: i });
    }
  }
  return map;
}

function invalidateTilesetLookupCache() {
  tilesetLookupCache.clear();
}

function recordChunkLoadTime(chunkKey: string) {
  if (!chunkLoadTimes.has(chunkKey)) {
    chunkLoadTimes.set(chunkKey, performance.now() / 1000);
  }
}

// Resolve the active local tile id for a Tiled animation at the given time (ms).
function getCurrentAnimationTileId(animation: Array<{ tileid: number; duration: number }>, totalDuration: number, now: number): number {
  if (!animation || animation.length === 0) return 0;
  if (totalDuration <= 0) return animation[0].tileid;
  let t = now % totalDuration;
  for (let i = 0; i < animation.length; i++) {
    if (t < animation[i].duration) return animation[i].tileid;
    t -= animation[i].duration;
  }
  return animation[animation.length - 1].tileid;
}

// Draw a chunk's animated tiles (which are skipped during static chunk baking) on
// top of the matching segment's pre-rendered canvas, at the current frame.
function drawChunkAnimatedTiles(chunkData: any, segment: number, screenX: number, screenY: number, alpha: number, now: number) {
  if (!ctx || !window.mapData) return;
  const animatedTiles = chunkData?.animatedTiles;
  if (!animatedTiles || animatedTiles.length === 0 || alpha <= 0) return;

  const mapTileW = window.mapData.tilewidth;
  const mapTileH = window.mapData.tileheight;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;

  for (const at of animatedTiles) {
    if (at.segment !== segment) continue;

    const image = window.mapData.images[at.tilesetIndex];
    if (!image || !image.complete || image.naturalWidth === 0) continue;

    const tileset = at.tileset;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    if (tilesPerRow <= 0) continue;

    const frameTileId = getCurrentAnimationTileId(at.animation, at.totalDuration, now);
    const srcX = (frameTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(frameTileId / tilesPerRow) * tileset.tileheight;

    try {
      const destX = screenX + at.destX;
      const destY = screenY + at.destY;
      const flipH = at.flipH || false;
      const flipV = at.flipV || false;
      const flipD = at.flipD || false;

      if (flipH || flipV || flipD) {
        const cx = destX + mapTileW / 2;
        const cy = destY + mapTileH / 2;
        let rot = 0;
        let effH = flipH;
        let effV = flipV;
        if (flipD) { rot = Math.PI / 2; effH = flipV; effV = !flipH; }
        ctx.save();
        ctx.translate(cx, cy);
        if (rot !== 0) ctx.rotate(rot);
        ctx.scale(effH ? -1 : 1, effV ? -1 : 1);
        ctx.drawImage(
          image, srcX, srcY,
          tileset.tilewidth, tileset.tileheight,
          -mapTileW / 2, -mapTileH / 2,
          mapTileW, mapTileH
        );
        ctx.restore();
      } else {
        ctx.drawImage(
          image,
          srcX, srcY,
          tileset.tilewidth, tileset.tileheight,
          destX, destY,
          mapTileW, mapTileH
        );
      }
    } catch {
      // Ignore individual animated tile draw errors
    }
  }

  ctx.globalAlpha = prevAlpha;
}

// Draws the Tiled-style "infinite paint zone" outside the current map bounds while
// the tile editor is active on an infinite map: the area beyond the map shows a
// faint white grid over the black background, indicating it can be painted into.
function renderInfiniteZone() {
  if (!ctx || !window.mapData) return;

  const tw = window.mapData.tilewidth;
  const th = window.mapData.tileheight;
  const mapWidth = window.mapData.width * tw;
  const mapHeight = window.mapData.height * th;

  let mapCenterOffsetX = 0;
  let mapCenterOffsetY = 0;
  if (mapWidth < window.innerWidth) mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
  if (mapHeight < window.innerHeight) mapCenterOffsetY = (window.innerHeight - mapHeight) / 2;

  const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
  const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  ctx.save();

  // Clip to the viewport EXCLUDING the current map rect (even-odd), so the grid
  // only appears in the out-of-bounds zone.
  ctx.beginPath();
  ctx.rect(0, 0, vw, vh);
  // Exclude the full map extent (including any negative/expanded area) so the grid
  // never draws over painted content. Left/up expansion is disabled, so clamp to 0.
  const izMinTileX = Math.max(0, window.mapData.minTileX ?? 0);
  const izMinTileY = Math.max(0, window.mapData.minTileY ?? 0);
  ctx.rect(offsetX + izMinTileX * tw, offsetY + izMinTileY * th, mapWidth - izMinTileX * tw, mapHeight - izMinTileY * th);
  ctx.clip('evenodd');

  // The canvas is already cleared to black; draw a faint tile grid over it.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const worldLeft = -offsetX;
  const worldTop = -offsetY;
  const startCol = Math.floor(worldLeft / tw);
  const endCol = Math.ceil((worldLeft + vw) / tw);
  const startRow = Math.floor(worldTop / th);
  const endRow = Math.ceil((worldTop + vh) / th);

  for (let c = startCol; c <= endCol; c++) {
    const sx = c * tw + offsetX;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, vh);
  }
  for (let r = startRow; r <= endRow; r++) {
    const sy = r * th + offsetY;
    ctx.moveTo(0, sy);
    ctx.lineTo(vw, sy);
  }
  ctx.stroke();

  ctx.restore();
}

// Renders the map's baked zIndex segments in order, drawing each shadow layer's
// dynamic silhouette at its own zIndex between segments. The 'below' phase draws
// every segment up to the player cut (zIndex < PLAYER_Z_INDEX); the 'above' phase
// draws the remaining segments.
function renderMap(phase: 'below' | 'above' = 'below') {
  if (!ctx || !window.mapData) return;

  const cuts: Array<{ key: number; shadowZ: number | null; player: boolean }> = window.mapData.layerCuts || [];
  let playerCutIndex = cuts.findIndex((c) => c.player);
  if (playerCutIndex === -1) playerCutIndex = cuts.length;

  const startSegment = phase === 'below' ? 0 : playerCutIndex + 1;
  const endSegment = phase === 'below' ? playerCutIndex : cuts.length;
  if (startSegment > endSegment) return;

  const now = performance.now();

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Calculate map size in pixels
  const mapWidth = window.mapData.width * window.mapData.tilewidth;
  const mapHeight = window.mapData.height * window.mapData.tileheight;

  // Calculate centering offset for small maps
  let mapCenterOffsetX = 0;
  const mapCenterOffsetY = 0;

  if (mapWidth < viewportWidth) {
    mapCenterOffsetX = (viewportWidth - mapWidth) / 2;
  }

  const offsetX = Math.round(viewportWidth / 2 - smoothMapX + mapCenterOffsetX);
  const offsetY = Math.round(viewportHeight / 2 - smoothMapY + mapCenterOffsetY);

  const visibleChunks = getVisibleChunks();

  const tileEditor = (window as any).tileEditor;
  const isEditorActive = tileEditor?.isActive;
  const selectedLayer = tileEditor?.selectedLayer;

  // Build tileset lookup map for this frame (cached if possible)
  if (tilesetLookupCache.size === 0) {
    tilesetLookupCache = buildTilesetLookupMap();
  }

  // Set up clipping region to prevent rendering outside map bounds (extended to
  // include any negative/expanded area while editing an infinite map).
  ctx.save();
  ctx.beginPath();
  const clipMinTileX = window.mapData.minTileX ?? 0;
  const clipMinTileY = window.mapData.minTileY ?? 0;
  const clipMinX = clipMinTileX * window.mapData.tilewidth;
  const clipMinY = clipMinTileY * window.mapData.tileheight;
  ctx.rect(offsetX + clipMinX, offsetY + clipMinY, mapWidth - clipMinX, mapHeight - clipMinY);
  ctx.clip();

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
  const nowSeconds = performance.now() / 1000;

  for (let segment = startSegment; segment <= endSegment; segment++) {
    if (isEditorActive && selectedLayer) {
      drawAllLayersWithOpacity(segment, cuts, visibleChunks, offsetX, offsetY, selectedLayer);
    } else {
      for (const chunk of visibleChunks) {
        const chunkKey = `${chunk.x}-${chunk.y}`;
        const chunkData = window.mapData.loadedChunks.get(chunkKey);
        if (!chunkData) continue;

        const chunkCanvas = chunkData.segmentCanvases?.[segment];
        if (!chunkCanvas) continue;

        const screenX = chunk.x * chunkPixelSize + offsetX;
        const screenY = chunk.y * chunkPixelSize + offsetY;

        // Calculate fade-in alpha based on chunk load time
        let chunkAlpha = 1;
        const loadTime = chunkLoadTimes.get(chunkKey);
        if (loadTime !== undefined) {
          const elapsed = nowSeconds - loadTime;
          chunkAlpha = Math.min(elapsed / CHUNK_FADE_DURATION, 1);
        }

        try {
          ctx.globalAlpha = chunkAlpha;
          ctx.drawImage(chunkCanvas, screenX, screenY);
          ctx.globalAlpha = 1;
          drawChunkAnimatedTiles(chunkData, segment, screenX, screenY, chunkAlpha, now);
        } catch (error) {
          console.error("Error drawing chunk canvas:", error);
        }
      }
    }

    // Draw shadow silhouettes belonging to the cut that ends this segment, so
    // shadows render at exactly their own layer zIndex.
    if (segment < cuts.length) {
      const cut = cuts[segment];
      if (cut.shadowZ !== null) {
        renderShadows(ctx, visibleChunks, cut.shadowZ, offsetX, offsetY);
      }
    }
  }
  ctx.restore();
}

function animationLoop() {
  if (!ctx) return;

  const fpsTarget = parseFloat(fpsSlider.value);
  // Treat the slider maximum as "uncapped": render every animation frame with no
  // frame-rate gate (the browser/display still bounds the actual rate).
  const uncapped = fpsTarget >= 240;
  const frameDuration = 1000 / fpsTarget;
  const now = performance.now();
  let deltaTime = (now - lastFrameTime) / 1000;

  // Clamp deltaTime to prevent huge jumps when tab is hidden/visible
  // Use a larger cap on mobile to allow particles to catch up after iOS RAF throttling
  const maxDeltaTime = (frameDuration * 30) / 1000;
  if (deltaTime > maxDeltaTime) {
    deltaTime = maxDeltaTime;
  }

  if (!uncapped) {
    if (now - nextFrameTime < frameDuration) {
      requestAnimationFrame(animationLoop);
      return;
    }

    // Step nextFrameTime forward by frameDuration; snap if we fell far behind
    if (now - nextFrameTime > frameDuration * 3) {
      nextFrameTime = now;
    }
    nextFrameTime += frameDuration;
  } else {
    // Uncapped: render every tick; keep the pacing clock in sync for when a cap returns.
    nextFrameTime = now;
  }

  lastFrameTime = now;

  const playersArray = Array.from(cache.players instanceof Map ? cache.players.values() : cache.players);
  const currentPlayer = playersArray.find(player => player.id === cachedPlayerId);
  if (!currentPlayer) {
    requestAnimationFrame(animationLoop);
    return;
  }

  for (const npc of cache.npcs) {
    if ((npc as any).layeredAnimation) {
      updateLayeredAnimation((npc as any).layeredAnimation, deltaTime);
    }
  }

  for (const entity of cache.entities) {
    if ((entity as any).layeredAnimation) {
      updateLayeredAnimation((entity as any).layeredAnimation, deltaTime);
    }
    // Smooth entity movement interpolation
    updateEntityInterpolation(entity, deltaTime);
  }

  if (cache.players instanceof Map) {
    animationManager.updateAllPlayers(cache.players, deltaTime);
    cache.players.forEach((player: any) => {
      updateRemotePlayerInterpolation(player, deltaTime);
    });
  } else if (cache.players instanceof Set) {

    const playersMap = new Map<string, any>();
    for (const player of cache.players) {
      if (player && player.id) {
        playersMap.set(player.id, player);
        updateRemotePlayerInterpolation(player, deltaTime);
      }
    }
    animationManager.updateAllPlayers(playersMap, deltaTime);
  }

  if (!cameraInitialized && window.mapData) {
    const initialX = window.mapData.spawnX || currentPlayer.position.x;
    const initialY = window.mapData.spawnY || currentPlayer.position.y;
    cameraX = initialX;
    cameraY = initialY;
    smoothMapX = initialX;
    smoothMapY = initialY;
    cameraInitialized = true;
  }

  updateLocalPlayerPrediction(currentPlayer, now);

  // Apply smoothing to all player render positions after position updates
  smoothPlayerRenderPositions(playersArray, currentPlayer, deltaTime);

  updateCamera(currentPlayer, deltaTime * 60);

  (window as any).cameraX = cameraX;
  (window as any).cameraY = cameraY;

  if (getMovementAllowed() && getIsMoving() && getIsKeyPressed()) {
    if (document.activeElement === chatInput || document.activeElement === friendsListSearch) {
      setIsMoving(false);
      lastDirection = "";
      return;
    }

    const keys = pressedKeys;
    let dir = "";
    if (keys.has("KeyW") && keys.has("KeyA")) dir = "UPLEFT";
    else if (keys.has("KeyW") && keys.has("KeyD")) dir = "UPRIGHT";
    else if (keys.has("KeyS") && keys.has("KeyA")) dir = "DOWNLEFT";
    else if (keys.has("KeyS") && keys.has("KeyD")) dir = "DOWNRIGHT";
    else if (keys.has("KeyW")) dir = "UP";
    else if (keys.has("KeyS")) dir = "DOWN";
    else if (keys.has("KeyA")) dir = "LEFT";
    else if (keys.has("KeyD")) dir = "RIGHT";
    if (dir && dir !== lastDirection) {
      sendRequest({ type: "MOVEXY", data: dir });
      lastDirection = dir;
    }
  } else if (getIsMoving() && !getIsKeyPressed()) {
    if (lastDirection !== "") sendRequest({ type: "MOVEXY", data: "ABORT" });
    setIsMoving(false);
    lastDirection = "";
  }

  chunkLoadThrottle++;
  if (chunkLoadThrottle >= 5) {
    loadVisibleChunks();
    chunkLoadThrottle = 0;
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.imageSmoothingEnabled = false;

  const viewportLeft = cameraX - window.innerWidth / 2;
  const viewportTop = cameraY - window.innerHeight / 2;
  const viewportRight = cameraX + window.innerWidth / 2;
  const viewportBottom = cameraY + window.innerHeight / 2;
  const padding = 256;

  const isInView = (x: number, y: number) =>
    x >= viewportLeft - padding &&
    y >= viewportTop - padding &&
    x <= viewportRight + padding &&
    y <= viewportBottom + padding;

  const visiblePlayers = playersArray.filter(p => {
    const inView = isInView(p.position.x, p.position.y);
    const isOwn = p.id === cachedPlayerId;
    const notStealth = !p.isStealth;
    const isAdmin = p.isStealth && currentPlayer.isAdmin;
    const visible = inView && (isOwn || notStealth || isAdmin);

    return visible;
  });

  if (currentPlayer) {
    const { health, total_max_health, stamina, total_max_stamina, absorbtion } = currentPlayer.stats;
    const healthPercent = (health / total_max_health) * 100;
    const staminaPercent = (stamina / total_max_stamina) * 100;
    updateHealthBar(healthBar, healthPercent);
    updateStaminaBar(staminaBar, staminaPercent);
    updateAbsorptionBar(absorbtion || 0, total_max_health);
  }

  const visibleNpcs = cache.npcs.filter(npc =>
    isInView(npc.position.x, npc.position.y)
  );

  const visibleEntities = cache.entities.filter(entity =>
    isInView(entity.position.x, entity.position.y)
  );

  // Collect particles by zIndex before rendering
  const particlesByLayer = new Map<number, Array<{
    particle: any;
    source: any;
    sourceType: 'npc' | 'entity';
  }>>();

  for (const npc of visibleNpcs) {
    if (npc.particles) {
      for (const particle of npc.particles) {
        if (particle.visible) {
          const zIndex = particle.zIndex || 0;
          if (!particlesByLayer.has(zIndex)) {
            particlesByLayer.set(zIndex, []);
          }
          particlesByLayer.get(zIndex)!.push({
            particle,
            source: npc,
            sourceType: 'npc'
          });
        }
      }
    }
  }

  for (const entity of visibleEntities) {
    if (entity.particles) {
      for (const particle of entity.particles) {
        if (particle.visible !== false) {
          const zIndex = particle.zIndex || 0;
          if (!particlesByLayer.has(zIndex)) {
            particlesByLayer.set(zIndex, []);
          }
          particlesByLayer.get(zIndex)!.push({
            particle,
            source: entity,
            sourceType: 'entity'
          });
        }
      }
    }
  }

  // Collect player effect particles into the same layer system that
  // entity/NPC particles use. zIndex defaults to 3 (upper layer, above sprites).
  for (const p of visiblePlayers) {
    const effects = p.activeEffects?.filter((e: any) => e.endTime > Date.now()) || [];
    const allParticles: any[] = [];
    for (const effect of effects) {
      if (Array.isArray(effect.particles)) {
        for (const pd of effect.particles) allParticles.push(pd);
      }
    }
    if (allParticles.length === 0) continue;

    if (!(p as any)._fxWrapper) {
      (p as any)._fxWrapper = {
        position: { x: 0, y: 0 },
        particleArrays: {} as Record<string, any[]>,
        lastEmitTime: {} as Record<string, number>,
        particles: [] as any[],
        updateParticle: null as any,
      };
    }
    const wrap = (p as any)._fxWrapper;
    wrap.position.x = p.renderPosition.x;
    wrap.position.y = p.renderPosition.y;
    wrap.particles = allParticles;

    if (!wrap.updateParticle && cache.entities.length > 0) {
      wrap.updateParticle = ((cache.entities[0] as any).updateParticle as any);
    }
    if (!wrap.updateParticle) continue;

    for (const particleDef of allParticles) {
      const zIndex = particleDef.zIndex || 3;
      if (!particlesByLayer.has(zIndex)) {
        particlesByLayer.set(zIndex, []);
      }
      particlesByLayer.get(zIndex)!.push({
        particle: particleDef,
        source: wrap,
        sourceType: 'entity',
      });
    }
  }

  if (!wireframeDebugCheckbox.checked) {
    if ((window as any).tileEditor?.isActive && window.mapData?.infinite) {
      renderInfiniteZone();
    }
    renderMap('below');
  }

  ctx.save();

  // Calculate map size in pixels and centering offset for small maps
  const mapWidth = window.mapData.width * window.mapData.tilewidth;
  let mapCenterOffsetX = 0;
  const mapCenterOffsetY = 0;

  if (mapWidth < window.innerWidth) {
    mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
  }

  const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
  const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
  ctx.save();
  ctx.translate(offsetX, offsetY);

  ctx.imageSmoothingEnabled = false;

  // Render particles with zIndex < 3 (lower layers) before NPCs
  if (!wireframeDebugCheckbox.checked) {
    const lowerZIndices = Array.from(particlesByLayer.keys())
      .filter(z => z < 3)
      .sort((a, b) => a - b);

    for (const zIdx of lowerZIndices) {
      const particlesAtLayer = particlesByLayer.get(zIdx);
      if (particlesAtLayer) {
        for (const { particle, source } of particlesAtLayer) {
          source.updateParticle(particle, source, ctx, deltaTime);
        }
      }
    }
  }

  const npcEditor = (window as any).npcEditor;

  if (wireframeDebugCheckbox.checked) {

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 2;

    for (const p of visiblePlayers) {
      const width = 24;
      const height = 40;
      const x = p.position.x - width / 2;
      const y = p.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.username || 'Player', p.position.x, y - 5);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    }

    ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
    ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';

    for (const npc of visibleNpcs) {
      const width = 32;
      const height = 48;
      const x = npc.position.x - width / 2;
      const y = npc.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(npc.name || 'NPC', npc.position.x, y - 5);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
    }
  } else {

    for (const p of visiblePlayers) p.show(ctx, currentPlayer);

    for (const npc of visibleNpcs) {
      npc.show(ctx);
      npc.dialogue(ctx);
    }

    // Render entities (same pattern as NPCs but with combat features)
    for (const entity of visibleEntities) {
      entity.show(ctx);
    }

    const now = performance.now();
    for (let i = cache.projectiles.length - 1; i >= 0; i--) {
      const projectile = cache.projectiles[i];
      const elapsed = now - projectile.startTime;
      const progress = Math.min(elapsed / projectile.duration, 1);

      let endX: number;
      let endY: number;

      if ((projectile as any).isEntityTarget) {
        // Target is an entity
        const targetEntity = cache.entities.find((e: any) => e.id === (projectile as any).targetEntityId);
        if (!targetEntity) {
          cache.projectiles.splice(i, 1);
          continue;
        }
        endX = targetEntity.position.x;
        endY = targetEntity.position.y;
      } else {
        // Target is a player
        const targetPlayer = playersArray.find(p => p.id === projectile.targetPlayerId);
        if (!targetPlayer) {
          cache.projectiles.splice(i, 1);
          continue;
        }
        endX = targetPlayer.position.x;
        endY = targetPlayer.position.y;
      }

      projectile.currentX = projectile.startX + (endX - projectile.startX) * progress;
      projectile.currentY = projectile.startY + (endY - projectile.startY) * progress;

      // --- Emit and update projectile trail particles ---
      const particles = projectile.particles as any[] | undefined;
      if (particles && particles.length > 0) {
        if (!projectile.particleArrays) projectile.particleArrays = {};
        const dtSec = Math.min(deltaTime, 0.1);

        // Track the last position where particles were emitted so new particles
        // are distributed along the travel arc, producing a trail instead of a
        // single stacking cluster.
        if (!(projectile as any)._lastSpawnX) {
          (projectile as any)._lastSpawnX = projectile.startX;
          (projectile as any)._lastSpawnY = projectile.startY;
        }
        const lastSpawnX = (projectile as any)._lastSpawnX;
        const lastSpawnY = (projectile as any)._lastSpawnY;
        const dsx = projectile.currentX - lastSpawnX;
        const dsy = projectile.currentY - lastSpawnY;
        (projectile as any)._lastSpawnX = projectile.currentX;
        (projectile as any)._lastSpawnY = projectile.currentY;

        for (const particleDef of particles) {
          const name = particleDef.name || '';
          // Spawn a batch of particles every frame, distributed along the arc
          // since the last frame. The trail forms naturally because each particle
          // persists for its lifetime and the arc segments overlap.
          const amount = Math.max(Number(particleDef.amount) || 1, 1);
          const staggerTime = Math.max(Number(particleDef.staggertime) || 0, 0);

          for (let a = 0; a < amount; a++) {
            // Distribute each particle along the arc segment travelled since the
            // last frame so they form a continuous trail.
            const t = amount > 1 ? a / (amount - 1) : 0.5;
            const spawnWX = lastSpawnX + dsx * t;
            const spawnWY = lastSpawnY + dsy * t;

            const p = particlePool.acquire();
            const life = (Number(particleDef.lifetime) || 1000) + staggerTime * a;
            p.currentLife = life;
            p.lifetime = life;
            p.size = Number(particleDef.size) || 5;
            p.color = particleDef.color || '#ffffff';
            p.opacity = Number(particleDef.opacity) || 1;
            p.gravity = particleDef.gravity ? { x: Number(particleDef.gravity.x || 0), y: Number(particleDef.gravity.y || 0) } : { x: 0, y: 0 };
            p.velocity = particleDef.velocity ? { x: Number(particleDef.velocity.x || 0), y: Number(particleDef.velocity.y || 0) } : { x: 0, y: 0 };
            // Spread applies around the spawn point
            const spreadX = (Math.random() - 0.5) * (Number(particleDef.spread?.x) || 0);
            const spreadY = (Math.random() - 0.5) * (Number(particleDef.spread?.y) || 0);
            // Store absolute world position so the particle stays where it was spawned
            // instead of following the projectile.
            p.worldX = spawnWX + spreadX;
            p.worldY = spawnWY + spreadY;
            p.glow_intensity = Number(particleDef.glow_intensity) || 0;

            if (!(projectile.particleArrays as Record<string, any[]>)[name]) {
              (projectile.particleArrays as Record<string, any[]>)[name] = [];
            }
            (projectile.particleArrays as Record<string, any[]>)[name].push(p);
          }
        }

        // Update and render existing particles (absolute world positions, trail)
        for (const name of Object.keys(projectile.particleArrays)) {
          const arr = (projectile.particleArrays as Record<string, any[]>)[name];
          const particleDef = particles.find((d: any) => d.name === name);
          if (!particleDef) continue;

          const gravX = Number(particleDef.gravity?.x || 0);
          const gravY = Number(particleDef.gravity?.y || 0);
  const baseColor = particleDef.color || 'white';
          const baseOpacity = Number(particleDef.opacity) || 1;
          const glowIntensity = Number(particleDef.glow_intensity) || 0;
          const particleSprite = getParticleSprite(baseColor, (Number(particleDef.size) || 5) / 2, glowIntensity);

          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

          for (let k = arr.length - 1; k >= 0; k--) {
            const pp = arr[k];
            pp.currentLife -= dtSec * 1000;
            if (pp.currentLife <= 0) {
              particlePool.release(pp);
              arr.splice(k, 1);
              continue;
            }

            // Apply gravity to velocity (wind/time-of-day intentionally skipped)
            pp.velocity.y += gravY * dtSec;
            pp.velocity.x += gravX * dtSec;

            // Move the absolute world position
            pp.worldX += pp.velocity.x * dtSec;
            pp.worldY += pp.velocity.y * dtSec;

            const lifeElapsed = pp.lifetime - pp.currentLife;
            const fadeInDur = pp.lifetime * 0.4;
            const fadeOutDur = pp.lifetime * 0.4;
            let alpha;
            if (lifeElapsed < fadeInDur) {
              alpha = (lifeElapsed / fadeInDur) * baseOpacity;
            } else if (pp.currentLife < fadeOutDur) {
              alpha = (pp.currentLife / fadeOutDur) * baseOpacity;
            } else {
              alpha = baseOpacity;
            }

            ctx.globalAlpha = alpha;
            const cx = pp.worldX * 1;
            const cy = pp.worldY * 1;
            ctx.drawImage(
              particleSprite.canvas,
              cx - particleSprite.half,
              cy - particleSprite.half,
              particleSprite.half * 2,
              particleSprite.half * 2
            );
          }

          ctx.restore();
        }
      }

      if (isInView(projectile.currentX, projectile.currentY)) {
        ctx.save();

        const icon = cache.projectileIcons.get(projectile.spell);

        if (icon && icon.complete && icon.naturalWidth > 0) {

          const dx = endX - projectile.currentX;
          const dy = endY - projectile.currentY;
          const angle = Math.atan2(dy, dx) + Math.PI / 2;

          const iconSize = 24;
          ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
          ctx.shadowBlur = 8;

          ctx.translate(projectile.currentX, projectile.currentY);
          ctx.rotate(angle);
          ctx.drawImage(
            icon,
            -iconSize / 2,
            -iconSize / 2,
            iconSize,
            iconSize
          );
  }

  ctx.restore();
      }

      if (progress >= 1) {
        cache.projectiles.splice(i, 1);
      }
    }

  }

  ctx.restore();

  if (!wireframeDebugCheckbox.checked) {
    renderMap('above');

    // Render upper particles (zIndex >= 3) after upper map layers
    ctx.save();
    const upperOffsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
    const upperOffsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
    ctx.translate(upperOffsetX, upperOffsetY);

    // Get all zIndex values >= 3 and sort them
    const upperZIndices = Array.from(particlesByLayer.keys())
      .filter(z => z >= 3)
      .sort((a, b) => a - b);

    for (const zIdx of upperZIndices) {
      const particlesAtLayer = particlesByLayer.get(zIdx);
      if (particlesAtLayer) {
        for (const { particle, source } of particlesAtLayer) {
          source.updateParticle(particle, source, ctx, deltaTime);
        }

  }
  }

  ctx.restore();
    // Render graveyards and warps on top of all tile layers when tile editor is active
    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive) {
      ctx.save();
      const graveyardWarpOffsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
      const graveyardWarpOffsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
      ctx.translate(graveyardWarpOffsetX, graveyardWarpOffsetY);
      renderGraveyardsAndWarps(ctx, graveyardWarpOffsetX, graveyardWarpOffsetY);
      ctx.restore();
    }

    // Draw outline for hidden NPCs when NPC editor is active (z-index 15 - after upper particles)
    if (npcEditor?.isActive) {
      ctx.save();
      const npcOutlineOffsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
      const npcOutlineOffsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
      ctx.translate(npcOutlineOffsetX, npcOutlineOffsetY);

      for (const npc of visibleNpcs) {
        if (npc.hidden) {
          ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
          ctx.fillStyle = 'rgba(255, 80, 80, 0.1)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          // Draw centered square (16x16) - NPC visual center is at position + (16, 24)
          const squareSize = 16;
          const centerX = npc.position.x + 16;
          const centerY = npc.position.y + 24;
          ctx.fillRect(centerX - squareSize / 2, centerY - squareSize / 2, squareSize, squareSize);
          ctx.strokeRect(centerX - squareSize / 2, centerY - squareSize / 2, squareSize, squareSize);

          // Draw NPC ID above the square
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'center';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
          ctx.shadowBlur = 4;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.fillStyle = 'rgba(255, 100, 100, 1)';
          ctx.fillText(`#${npc.id}`, centerX, centerY - squareSize / 2 - 5);
          ctx.shadowColor = 'transparent';
        }
      }
      ctx.restore();
    }
  } else {

    ctx.save();
    // Calculate map size in pixels and centering offset for small maps
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    let mapCenterOffsetX = 0;
    const mapCenterOffsetY = 0;

    if (mapWidth < window.innerWidth) {
      mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }

    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
    ctx.translate(offsetX, offsetY);

    if (window.mapData) {
      const visibleChunks = getVisibleChunks();
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;

      for (const chunk of visibleChunks) {
        const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
        const chunkWorldX = chunk.x * chunkPixelSize;
        const chunkWorldY = chunk.y * chunkPixelSize;

        for (let i = 0; i <= window.mapData.chunkSize; i++) {

          const lineX = chunkWorldX + (i * window.mapData.tilewidth);
          ctx.beginPath();
          ctx.moveTo(lineX, chunkWorldY);
          ctx.lineTo(lineX, chunkWorldY + chunkPixelSize);
          ctx.stroke();

          const lineY = chunkWorldY + (i * window.mapData.tileheight);
          ctx.beginPath();
          ctx.moveTo(chunkWorldX, lineY);
          ctx.lineTo(chunkWorldX + chunkPixelSize, lineY);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.imageSmoothingEnabled = false;

  if (collisionDebugCheckbox.checked && (window as any).collisionTiles && window.mapData) {
    const collisionTiles = (window as any).collisionTiles as Array<{ x: number; y: number; time: number }>;
    const currentTime = Date.now();
    const maxAge = 3000;

    (window as any).collisionTiles = collisionTiles.filter(tile => currentTime - tile.time < maxAge);

    ctx.fillStyle = 'rgba(0, 100, 255, 0.5)';
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.8)';
    ctx.lineWidth = 2;

    for (const tile of (window as any).collisionTiles) {
      const tileWorldX = tile.x * window.mapData.tilewidth;
      const tileWorldY = tile.y * window.mapData.tileheight;

      if (isInView(tileWorldX, tileWorldY)) {
        ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
        ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
      }
    }
  }

  if (chunkOutlineDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    ctx.lineWidth = 3;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      ctx.strokeRect(chunkWorldX, chunkWorldY, chunkPixelSize, chunkPixelSize);
    }
  }

  if (collisionTilesDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
    ctx.fillStyle = 'rgba(255, 0, 0, 0.2)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      const collisionLayer = chunkData.layers.find((layer: any) =>
        layer.name && layer.name.toLowerCase().includes('collision')
      );

      if (collisionLayer) {

        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = collisionLayer.data[y * chunkData.width + x];

            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  if (noPvpDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)';
    ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      const noPvpLayer = chunkData.layers.find((layer: any) =>
        layer.name && (layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp'))
      );

      if (noPvpLayer) {

        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = noPvpLayer.data[y * chunkData.width + x];

            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  if (shadowsDebugCheckbox && shadowsDebugCheckbox.checked && window.mapData) {
    const shadowLayerNames = window.mapData.shadowLayerNames;
    if (!shadowLayerNames || shadowLayerNames.length === 0) return;

    // Camera-position cache key (recompute every tile-width of movement)
    const tw = window.mapData.tilewidth;
    const th = window.mapData.tileheight;
    const worldOX = -offsetX;
    const worldOY = -offsetY;
    const camKey = `${Math.floor(worldOX / tw)},${Math.floor(worldOY / th)}`;

    const silCacheRoot = '__shadowSilCache';
    const silCache = (window as any)[silCacheRoot] as Record<string, [number,number,number,number][]> || {};
    (window as any)[silCacheRoot] = silCache;

    let allEdges = silCache[camKey];
    if (!allEdges) {
      // --- Always-cached tileset lookup (built once) ---
      const tsKey = '__shadowTsAll';
      let tsAll = (window as any)[tsKey] as Map<number, { tileset: any; image: HTMLImageElement }> | undefined;
      if (!tsAll) {
        tsAll = new Map();
        for (let i = 0; i < window.mapData.tilesets.length; i++) {
          const ts = window.mapData.tilesets[i];
          const img = window.mapData.images[i];
          if (img && img.complete && img.naturalWidth > 0) {
            for (let gid = ts.firstgid; gid < ts.firstgid + ts.tilecount; gid++) {
              tsAll.set(gid, { tileset: ts, image: img });
            }
          }
        }
        (window as any)[tsKey] = tsAll;
      }

      // --- Offscreen silhouette canvas (viewport-sized) ---
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let silCanvas = (window as any).__shadowSilCanvas as HTMLCanvasElement | undefined;
      if (!silCanvas || silCanvas.width !== vw || silCanvas.height !== vh) {
        silCanvas = document.createElement('canvas');
        silCanvas.width = vw;
        silCanvas.height = vh;
        (window as any).__shadowSilCanvas = silCanvas;
      }
      const sctx = silCanvas.getContext('2d')!;
      sctx.clearRect(0, 0, vw, vh);
      sctx.imageSmoothingEnabled = false;
      sctx.save();
      sctx.translate(offsetX, offsetY);

      // Draw every shadow tile into the silhouette canvas
      const shadowNameSet = new Set(shadowLayerNames.map((n: string) => n.toLowerCase()));
      const visibleChunks = getVisibleChunks();

      for (const chunk of visibleChunks) {
        const chunkData = window.mapData.loadedChunks.get(`${chunk.x}-${chunk.y}`);
        if (!chunkData) continue;
        const layers = chunkData.layers.filter((l: any) =>
          l.name && shadowNameSet.has(l.name.toLowerCase())
        );
        if (layers.length === 0) continue;
        const bcx = chunk.x * window.mapData.chunkSize;
        const bcy = chunk.y * window.mapData.chunkSize;

        for (const sl of layers) {
          if (!sl.data) continue;
          for (let y = 0; y < chunkData.height; y++) {
            for (let x = 0; x < chunkData.width; x++) {
              const gid = sl.data[y * chunkData.width + x];
              if (gid === 0) continue;
              const info = tsAll.get(gid & 0x0FFFFFFF);
              if (!info) continue;
              const ts = info.tileset; const img = info.image;
              const li = (gid & 0x0FFFFFFF) - ts.firstgid;
              const tpr = Math.floor(ts.imagewidth / ts.tilewidth);
              const sx = (li % tpr) * ts.tilewidth;
              const sy = Math.floor(li / tpr) * ts.tileheight;
              const dx = (bcx + x) * tw;
              const dy = (bcy + y) * th;
              sctx.drawImage(img, sx, sy, ts.tilewidth, ts.tileheight, dx, dy, tw, th);
            }
          }
        }
      }
      sctx.restore();

      // Edge-detect: horizontal edges (bottom-facing) + vertical edges (right-facing)
      const imgData = sctx.getImageData(0, 0, vw, vh);
      const d = imgData.data;

      const hedges: [number,number,number,number][] = []; // horizontal runs
      const vedges: [number,number,number,number][] = []; // vertical runs

      // Bottom-facing edges: scan each row for a>=64 && below<64
      for (let py = 0; py < vh; py++) {
        let runStart = -1;
        for (let px = 0; px < vw; px++) {
          const a = d[(py * vw + px) * 4 + 3];
          const below = py + 1 < vh ? d[((py + 1) * vw + px) * 4 + 3] : 0;
          if (a >= 64 && below < 64) {
            if (runStart === -1) runStart = px;
          } else {
            if (runStart !== -1) { hedges.push([runStart - offsetX, py - offsetY, px - offsetX, py - offsetY]); runStart = -1; }
          }
        }
        if (runStart !== -1) hedges.push([runStart - offsetX, py - offsetY, vw - offsetX, py - offsetY]);
      }

      // Right-facing edges: scan each column for a>=64 && right<64
      for (let px = 0; px < vw; px++) {
        let runStart = -1;
        for (let py = 0; py < vh; py++) {
          const a = d[(py * vw + px) * 4 + 3];
          const right = px + 1 < vw ? d[(py * vw + (px + 1)) * 4 + 3] : 0;
          if (a >= 64 && right < 64) {
            if (runStart === -1) runStart = py;
          } else {
            if (runStart !== -1) { vedges.push([px - offsetX, runStart - offsetY, px - offsetX, py - offsetY]); runStart = -1; }
          }
        }
        if (runStart !== -1) vedges.push([px - offsetX, runStart - offsetY, px - offsetX, vh - offsetY]);
      }

      allEdges = hedges.concat(vedges);
      silCache[camKey] = allEdges;
    }

    // Draw cached edges (already in world-space, ctx is translated)
    if (allEdges.length > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of allEdges) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
  }

  if (astarDebugCheckbox && astarDebugCheckbox.checked) {
    // Request data every frame to keep it fresh
    sendRequest({ type: "GET_DEBUG_ASTAR", data: null });

    const debugData = (window as any).astarDebugData;

    if (!debugData || !debugData.nodes) {
      // No data yet
    } else {
      const nodes = debugData.nodes || [];

      if (nodes.length === 0) {
        // No nodes to display
      } else {
      // Find min/max f-score for color gradient
      let minF = Infinity;
      let maxF = -Infinity;

      for (const node of nodes) {
        if (node.f < minF) minF = node.f;
        if (node.f > maxF) maxF = node.f;
      }

      // Draw tiles based on f-score
      for (const node of nodes) {
        // Skip if node is not in view
        if (!isInView(node.x * 32, node.y * 32)) continue;

        // Calculate color based on f-score (blue = low/good, red = high/bad)
        const fNormalized = maxF === minF ? 0.5 : (node.f - minF) / (maxF - minF);
        const r = Math.round(fNormalized * 255);
        const g = 0;
        const b = Math.round((1 - fNormalized) * 255);

        // Draw tile with gradient color
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
        ctx.fillRect(node.x * 32, node.y * 32, 32, 32);

        // Draw border
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(node.x * 32, node.y * 32, 32, 32);

        // Optional: Draw f-score text for small number of nodes
        if (nodes.length < 50) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.font = '10px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const text = `${Math.round(node.f)}`;
          ctx.fillText(text, node.x * 32 + 16, node.y * 32 + 16);
        }
      }

      // Draw legend
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(10, 10, 200, 60);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, 200, 60);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '12px Arial';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('A* Debug:', 20, 20);
      ctx.fillText(`Nodes: ${nodes.length}`, 20, 35);
      ctx.fillText(`Blue=Low, Red=High`, 20, 50);
      }
    }
  }

  if (showGridCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      for (let x = 0; x <= window.mapData.chunkSize; x++) {
        const lineX = chunkWorldX + (x * window.mapData.tilewidth);
        ctx.beginPath();
        ctx.moveTo(lineX, chunkWorldY);
        ctx.lineTo(lineX, chunkWorldY + chunkPixelSize);
        ctx.stroke();
      }

      for (let y = 0; y <= window.mapData.chunkSize; y++) {
        const lineY = chunkWorldY + (y * window.mapData.tileheight);
        ctx.beginPath();
        ctx.moveTo(chunkWorldX, lineY);
        ctx.lineTo(chunkWorldX + chunkPixelSize, lineY);
        ctx.stroke();
      }
    }
  }

  ctx.restore();

  if ((window as any).tileEditor) {
    ctx.save();
    // Calculate map size in pixels and centering offset for small maps
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    let mapCenterOffsetX = 0;
    const mapCenterOffsetY = 0;

    if (mapWidth < window.innerWidth) {
      mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }

    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
    ctx.translate(offsetX, offsetY);
    (window as any).tileEditor.renderPreview();
    ctx.restore();
  }

  if (!wireframeDebugCheckbox.checked) {
    ctx.save();
    // Calculate map size in pixels and centering offset for small maps
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    let mapCenterOffsetX = 0;
    const mapCenterOffsetY = 0;

    if (mapWidth < window.innerWidth) {
      mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }

    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX + mapCenterOffsetX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY + mapCenterOffsetY);
    ctx.translate(offsetX, offsetY);
    ctx.imageSmoothingEnabled = false;

    for (const p of visiblePlayers) {
      p.showChat(ctx, currentPlayer);
    }

    for (const p of visiblePlayers) {
      if (p.typing) {
        if (!p._typingEl) {
          p._typingEl = document.createElement("img");
          p._typingEl.src = "data:image/gif;base64,R0lGODdhMAAwAHcAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJDgAAACwAAAAAMAAwAIIAAAAQDQ1cSkqHeHi8srLX19f88/MAAAAD/wi63P4wykmrvUDorQOmAectwmCcRqEO4/eEaMGGJZqqRN66C2wXuZwtBsxteIpAYZjKLZm3IGEgQAqeP5WKqSVsDYSq64q9aaFRgi089j7P6Jh6yPoInO/4sIzaUQREfHpxdRWAP4OJSwR+EIeJkCddjQ6PkYNdQJQNlkw1kThSmwwBUFtUoF05hRKle3CQql5sICZmOF+xQSoaFgFzqoJ6uwW9F7+SK8IpXFLGGAEDQQMDgotloVRiLgHdJW5ZRVor3aPQ0eBEUirdSK3S46F45u5J0eNSU/T1PffZ7Rv21fPWYcSVE6z4XTiIIqHCP9gEPlRABmGxib6qyaC2DT3jBHRTOnr8SGOkyZMBT/4xIUOix0cFXGI86EWkygb+nt3MIKAFwZ0kWMqcicIm0CRqqByFUHKp06dQJSQAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKyYK9geoNwjCgUQwWZzoBEYajYAkwfFLpuhZEHhKDPAMxmGXwsbFUq1xvJkCCcAOnsWA0EJec5jRHrXqtREFWeux+p1HxRlvFnW1UHE9NK77PhXw+R6DT7nd6fH0cAYCBgwQZa2SHUzgjixQCRFJ9bI56khNNUQRmLgECjiybnHw2oaOZBqacbjaXjXAskSYCeV9mXrkghLe9j2+fe1hZsCwGnyq7yYl+Y057fHpw05/GJ01OiQPVT9d50NpReqFX3yLUBeNMMSUdnnpyg+0/EEPE19n3Gvl8PYT0O3EhRhcSA3/gWoEwIbAbrhxKwHWQncRC3kaEuYhRPYk9jvhEfQRJ0uG7khooiWiIMsIqERFbLlj4aWRLD+JsXhSo4IVOiSoLxJSp4OXPkjX4EW0gcqnTp1B/JAAAIfkECQ4AAAAsAAAAADAAMACCAAAAEA0NXEpKh3h4vLKy19fX/PPzAAAAA/8Iutz+MMpJq70sBCE0tlzoKdpAnMQwfpBgFkXaaQIB3zHHPrWNowWDUBhD6XYL19DwCy6JKMIRKXgyb9Zh8dShZpmEr9Z2Cuyq35RYCyOYPwJnNib/3qRv0KBu5dsLIhdxfmtiOW6CWIWLQ3ggdHVSNYxWiBUBQHIzaEqUBgIWASYnWJtCA2iLQaChUWEGkq+ebaytJ55EdbR5l5O4OLk1vK2/Pj6AHMO9c0zNuWSuXWeyuTg/xkbKGL5XRdYqG22OSEk1d5mAbzTJ5A00oyioK+0U6yLDgfRnTir6cHX9/D1aUkCbQB4wTgE6eGlPgQEQazGUIOoEqomhNkjEyNEzX76OEZQ8NAgSQKqCJVsEsbExJQmHU0qyI6HRpckBTEjKHNLSJiYDF206qCm0qNGjDhIAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKSau9QOitA6YB5y3CYJxGoQ7j94RowYYlmqpE3roLbBe5nC0GzG14ikBhmMotmbcgYSBACp4/lYqpJWwNhKrrir1poVGCLTz2Ps/omHrI+gic7/iwjNpRBER8enF1FYA/g4lLBH4Qh4mQJ12NDo9MYXdgGnNoXUCUDZZDAgEwpD5QOFKgDAGpBaeAsZ1dOYUSrns4m5qZXKpebCAmZjhfkEVuGhYBc7WCekEqyxfNkivQKVxS1BgBA0EDA4KLZapUYi6lIeDHZnhaM6ze325ZUiqlSLjtWsBu8/Yl+eZPypSAAnsQPKdvA0KBpRyOuHLiVsILFFFYvPjHS9xDjgrIVIQFktk4GeLSlZxQb4rKlSxpwJxJ0yHNPyZkfFz5qMDOkhS9vLzZYGE3ohlIKTxKtIZPpBEeDYWaRA0VqhBkYt3KtauEBAAh+QQJDgAAACwAAAAAMAAwAIIAAAAQDQ1cSkqHeHi8srLX19f88/MAAAAD/wi63P4wysmCvYHqDcIwoFEMFmc6ARGGo2AJMHxS6boWRB4SgzwDMZhl8LGxVKtcbyZAgnADp7FgNBCXnOY0R616rURBVnrsfqdR8UZbxZ1tVBxPTSu+z4V8Pkeg0+53enx9HAGAgYMEGWtkh1M4I4sUAkRSfVqXjY8FkhNNUQRmLgECBqOlpnZTnZ58NqemLyA9bQasnm42mQa7cCyRJgJ5X2ZewyCEwcePb6F7WFm5LLxuxdOJfmNOe3x6cNyh0CdNTokD3k/gednjUXqjV+gi3QXsTDElHaB6coP2PxCGOAMnDqAGgXx6CDF44kKMLiQY/hC2IqJEZTduXZQgDEZivY2Fzo0IAzKkkn8lA5JCmbLlRXwuNVASYTFmBFQiNNpcQDEUS5se1v0EuVDBi6EbZ3LayTEEUpc1CjJtsHKq1atYfyQAACH5BAkOAAAALAAAAAAwADAAggAAABANDVxKSod4eLyystfX1/zz8wAAAAP/CLrc/jDKSau9LAQhNLZc6CnaQJzEMH6QYBZF2mkCAd8xxz61jaMFg1AYQ+l2C9fQ8AsuiSjCESl4Mm/WYfHUoWaZhK/Wdgrsqt+UWAsjmD8CZzYm/96kb9CgbuXbCyIXcX5rYjlugliFi0N4IHR1UjUGkmGVYogVAUByM1WeBqBiAhYBJidYoKo0dqEXm1FCl7McYX05GLC2jER1bV2vk7y9ML01ea+7jJA+gBzIpWhPQdRsZFGOZ8pXOD8+UcBUu3fNMCobbdlICrXkqDDANM/rDTSnKAMz9K8bIfoMgfadcaJCIJw6BQ0+WlIAmsIIg4TsIfWQgilzA/JV1HRKOONGTf0+itwYcCTEAUwSmuShxeFKdkFsUHxZb48zmgDmkQhJU0lDnA6kzQRKIoxHogt4Il3KFGkCADs=";
          p._typingEl.style.position = "absolute";
          p._typingEl.style.pointerEvents = "none";
          p._typingEl.style.imageRendering = "pixelated";
          document.body.appendChild(p._typingEl);
        }
        const sx = p.renderPosition.x + offsetX - 5;
        const sy = p.renderPosition.y + offsetY - 58;
        p._typingEl.style.left = sx + "px";
        p._typingEl.style.top = sy + "px";
        p._typingEl.style.display = "block";
      } else if (p._typingEl) {
        p._typingEl.style.display = "none";
      }
    }

    for (const p of visiblePlayers) {
      p.showDamageNumbers(ctx);
    }

    for (const p of visiblePlayers) {
      if (p.showDebuffs) {
        p.showDebuffs(ctx);
      }
    }

    for (const p of visiblePlayers) {
      if (p.id !== cachedPlayerId) {
        p.showCastbar(ctx);
      }
    }

    ctx.restore();
  }

  if (window.mapData && window.mapData.loadedChunks) {
    loadedChunksText.innerText = `Loaded Chunks: ${window.mapData.loadedChunks.size}`;
  }

  // Additive light map: glowing emitters brighten the darkened night scene.
  renderLightMap(smoothMapX, smoothMapY);

  if (times.length > 60) times.shift();
  times.push(now);

  if (now - lastFpsUpdate >= 1000 && times.length >= 2) {
    lastFpsUpdate = now;
    const fps = Math.round((times.length - 1) / ((times[times.length - 1] - times[0]) / 1000));
    const fpsEl = document.getElementById("fps-counter");
    if (fpsEl) fpsEl.textContent = `${fps} FPS`;
  }

  if (!(window as any).__firstFrameRendered && window.mapData) {
    (window as any).__firstFrameRendered = true;
  }

  requestAnimationFrame(animationLoop);
}

animationLoop();

function setDirection(dir: string) {
  lastDirection = dir;
}

function setCameraX(x: number) {
  cameraX = x;
}

function setCameraY(y: number) {
  cameraY = y;
}

function getCameraX() {
  return cameraX;
}

function getCameraY() {
  return cameraY;
}

(window as any).cameraX = cameraX;
(window as any).cameraY = cameraY;

function getWeatherType() {
  return weatherType;
}

function setWeatherType(type: string | null) {
  weatherType = type;
}

function setWeatherData(data: any) {
  currentWeatherData = data;
}

function resetCameraInitialized() {
  cameraInitialized = false;
}

function initializeCamera(x: number, y: number) {
  if (!cameraInitialized) {
    cameraX = x;
    cameraY = y;
    smoothMapX = x;
    smoothMapY = y;
    cameraInitialized = true;
  }
}

function setPendingRequest(value: boolean) {
  pendingRequest = value;
}

function getPendingRequest(): boolean {
  return pendingRequest;
}

export {
  lastDirection,
  setDirection,
  canvas,
  setCameraX,
  setCameraY,
  getCameraX,
  getCameraY,
  setWeatherType,
  getWeatherType,
  setWeatherData,
  initializeCamera,
  resetCameraInitialized,
  setPendingRequest,
  getPendingRequest,
  invalidateTilesetLookupCache,
  recordChunkLoadTime
};
