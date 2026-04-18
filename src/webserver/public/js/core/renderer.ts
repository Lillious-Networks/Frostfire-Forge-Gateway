import { getIsLoaded, cachedPlayerId, sendRequest } from "./socket.js";
import { getIsKeyPressed, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache.ts";
let weatherType = null as string | null;
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar } from "./ui.js";
import { updateWeatherCanvas, weather } from './weather.ts';
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
import { animationManager } from "./animationStateManager.js";
import { updateLayeredAnimation } from "./layeredAnimation.js";
const times = [] as number[];
let lastDirection = "";
let cameraX: number = 0, cameraY: number = 0, lastFrameTime: number = 0;
let smoothMapX: number = 0, smoothMapY: number = 0;
let cameraInitialized: boolean = false;

// Upper layer tile visibility cache (for flood-fill result)
let lastPlayerTileX: number = -1;
let lastPlayerTileY: number = -1;
const layerConnectedCache = new Map<string, Set<string>>();

import { canvas, ctx, fpsSlider, healthBar, staminaBar, collisionDebugCheckbox, chunkOutlineDebugCheckbox, collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox, astarDebugCheckbox, loadedChunksText } from "./ui.js";

const SERVER_TICK_RATE = 30;
const SERVER_FRAME_TIME = 1000 / SERVER_TICK_RATE;
const SERVER_SPEED = 6;

let lastMovementTime = 0;

// Player render position smoothing configuration
const PLAYER_SMOOTHING_FACTOR = 0.2; // Higher = faster movement

function updateLocalPlayerPrediction(currentPlayer: any, now: number) {
  if (!currentPlayer) return;
  
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

canvas.style.position = 'fixed';

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
      weather(weatherType);
    }
  }
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

  const startChunkX = Math.max(0, Math.floor((cameraLeft - padding) / chunkPixelSize));
  const startChunkY = Math.max(0, Math.floor((cameraTop - padding) / chunkPixelSize));
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

  for (const chunkKey of loadedChunksSet) {
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

function drawAllLayersWithOpacity(layer: 'lower' | 'upper', visibleChunks: any[], offsetX: number, offsetY: number, selectedLayerName: string) {
  if (!ctx || !window.mapData) return;

  const PLAYER_Z_INDEX = 3;
  const selectedLayerLower = selectedLayerName.toLowerCase();
  const isCollisionSelected = selectedLayerLower.includes('collision');
  const isNoPvpSelected = selectedLayerLower.includes('nopvp') || selectedLayerLower.includes('no-pvp');

  for (const chunk of visibleChunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;
    const chunkData = window.mapData.loadedChunks.get(chunkKey);
    if (!chunkData) continue;

    const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
    const chunkWorldX = chunk.x * chunkPixelSize;
    const chunkWorldY = chunk.y * chunkPixelSize;

    const screenX = chunkWorldX + offsetX;
    const screenY = chunkWorldY + offsetY;

    const sortedLayers = [...chunkData.layers].sort((a: any, b: any) => a.zIndex - b.zIndex);

    for (const chunkLayer of sortedLayers) {

      const belongsToThisCanvas = layer === 'lower'
        ? chunkLayer.zIndex < PLAYER_Z_INDEX
        : chunkLayer.zIndex >= PLAYER_Z_INDEX;

      if (!belongsToThisCanvas) continue;

      const isSelected = chunkLayer.name === selectedLayerName;
      const layerNameLower = chunkLayer.name.toLowerCase();
      const isCollisionLayer = layerNameLower.includes('collision');
      const isNoPvpLayer = layerNameLower.includes('nopvp') || layerNameLower.includes('no-pvp');

      if ((isCollisionLayer || isNoPvpLayer) && !isSelected) {
        continue;
      }

      const tileEditor = (window as any).tileEditor;
      const useDimming = tileEditor?.isActive && tileEditor.dimOtherLayers;
      const isLayerVisible = tileEditor?.isLayerVisible(chunkLayer.name) ?? true;

      if (isCollisionSelected || isNoPvpSelected) {

        if (isCollisionLayer || isNoPvpLayer) {
          continue;
        }
        ctx.globalAlpha = isLayerVisible ? 1.0 : 0;
      } else if (useDimming) {
        ctx.globalAlpha = isSelected ? (isLayerVisible ? 1.0 : 0) : (isLayerVisible ? 0.5 : 0);
      } else {
        ctx.globalAlpha = isLayerVisible ? 1.0 : 0;
      }

      for (let y = 0; y < chunkData.height; y++) {
        for (let x = 0; x < chunkData.width; x++) {
          const tileIndex = chunkLayer.data[y * chunkData.width + x];
          if (tileIndex === 0) continue;

          const tileset = window.mapData.tilesets.find(
            (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
          );
          if (!tileset) continue;

          const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
          if (!image || !image.complete) continue;

          const localTileIndex = tileIndex - tileset.firstgid;
          const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
          const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
          const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

          const drawX = screenX + x * window.mapData.tilewidth;
          const drawY = screenY + y * window.mapData.tileheight;

          try {
            ctx.drawImage(
              image,
              tileX, tileY,
              tileset.tilewidth, tileset.tileheight,
              drawX, drawY,
              window.mapData.tilewidth, window.mapData.tileheight
            );
          } catch (error) {
            console.error("Error drawing tile:", error);
          }
        }
      }
    }

    ctx.globalAlpha = 1;
  }
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

function renderMap(layer: 'lower' | 'upper' = 'lower', playerTileX?: number, playerTileY?: number) {
  if (!ctx || !window.mapData) return;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const offsetX = Math.round(viewportWidth / 2 - smoothMapX);
  const offsetY = Math.round(viewportHeight / 2 - smoothMapY);

  const visibleChunks = getVisibleChunks();

  const tileEditor = (window as any).tileEditor;
  const isEditorActive = tileEditor?.isActive;
  const selectedLayer = tileEditor?.selectedLayer;

  if (isEditorActive && selectedLayer) {
    drawAllLayersWithOpacity(layer, visibleChunks, offsetX, offsetY, selectedLayer);
  } else {
    const PLAYER_Z_INDEX = 3;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);
      if (!chunkData) continue;

      if (layer === 'lower') {
        const chunkCanvas = window.mapData.getChunkLowerCanvas(chunk.x, chunk.y);
        if (!chunkCanvas) continue;

        const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
        const chunkWorldX = chunk.x * chunkPixelSize;
        const chunkWorldY = chunk.y * chunkPixelSize;

        const screenX = chunkWorldX + offsetX;
        const screenY = chunkWorldY + offsetY;

        try {
          ctx.drawImage(chunkCanvas, screenX, screenY);
        } catch (error) {
          console.error("Error drawing chunk canvas:", error);
        }
      } else {
        const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
        const chunkWorldX = chunk.x * chunkPixelSize;
        const chunkWorldY = chunk.y * chunkPixelSize;

        const screenX = chunkWorldX + offsetX;
        const screenY = chunkWorldY + offsetY;

        const sortedLayers = [...chunkData.layers].sort((a: any, b: any) => a.zIndex - b.zIndex);

        for (const chunkLayer of sortedLayers) {
          if (chunkLayer.zIndex < PLAYER_Z_INDEX) continue;

          const layerNameLower = chunkLayer.name?.toLowerCase() || '';
          if (layerNameLower.includes('collision') || layerNameLower.includes('nopvp') || layerNameLower.includes('no-pvp')) {
            continue;
          }

          const tileEditor = (window as any).tileEditor;
          const isLayerVisible = tileEditor?.isLayerVisible(chunkLayer.name) ?? true;
          if (!isLayerVisible) {
            continue;
          }

          let connected = new Set<string>();

          if (playerTileX !== undefined && playerTileY !== undefined) {
            // Check if player moved to a different tile
            if (lastPlayerTileX !== playerTileX || lastPlayerTileY !== playerTileY) {
              lastPlayerTileX = playerTileX;
              lastPlayerTileY = playerTileY;
              // Clear cache when player moves to new tile
              layerConnectedCache.clear();
            }

            // Try to get cached result for this layer
            const cacheKey = chunkLayer.name;
            let cachedConnected = layerConnectedCache.get(cacheKey);

            if (!cachedConnected) {
              // Compute flood-fill if not cached
              cachedConnected = new Set<string>();
              const visited = new Set<string>();
              const queue: Array<{cx: number, cy: number, lx: number, ly: number}> = [];

              const scx = Math.floor(playerTileX / window.mapData.chunkSize);
              const scy = Math.floor(playerTileY / window.mapData.chunkSize);
              const sx = playerTileX - scx * window.mapData.chunkSize;
              const sy = playerTileY - scy * window.mapData.chunkSize;

              visited.add(`${scx}-${scy}-${sx}-${sy}`);
              queue.push({cx: scx, cy: scy, lx: sx, ly: sy});

              while (queue.length > 0) {
                const c = queue.shift()!;
                const ck = `${c.cx}-${c.cy}`;
                const cd = window.mapData.loadedChunks.get(ck);
                if (!cd) continue;

                const cl = cd.layers.find((l: any) => l.name === chunkLayer.name);
                if (!cl) continue;

                const tileIdx = cl.data[c.ly * cd.width + c.lx];
                if (tileIdx === 0) continue;

                cachedConnected.add(`${c.cx}-${c.cy}-${c.lx}-${c.ly}`);

                const nbrs = [
                  {lx: c.lx - 1, ly: c.ly},
                  {lx: c.lx + 1, ly: c.ly},
                  {lx: c.lx, ly: c.ly - 1},
                  {lx: c.lx, ly: c.ly + 1}
                ];

                for (const n of nbrs) {
                  let nx = n.lx, ny = n.ly, ncx = c.cx, ncy = c.cy;

                  if (nx < 0) { ncx--; nx = window.mapData.chunkSize - 1; }
                  else if (nx >= window.mapData.chunkSize) { ncx++; nx = 0; }

                  if (ny < 0) { ncy--; ny = window.mapData.chunkSize - 1; }
                  else if (ny >= window.mapData.chunkSize) { ncy++; ny = 0; }

                  if (ncx < 0 || ncy < 0 || ncx >= window.mapData.chunksX || ncy >= window.mapData.chunksY) continue;

                  const nk = `${ncx}-${ncy}-${nx}-${ny}`;
                  if (visited.has(nk)) continue;

                  visited.add(nk);
                  queue.push({cx: ncx, cy: ncy, lx: nx, ly: ny});
                }
              }

              // Cache the result
              layerConnectedCache.set(cacheKey, cachedConnected);
            }

            connected = cachedConnected;
          }

          const time = performance.now() / 1000;
          const fadeProgress = Math.min(time / 0.5, 1);
          const fadeAlpha = 1 - fadeProgress * 0.40;

          for (let y = 0; y < chunkData.height; y++) {
            for (let x = 0; x < chunkData.width; x++) {
              const tileIndex = chunkLayer.data[y * chunkData.width + x];
              if (tileIndex === 0) continue;

              if (connected.has(`${chunk.x}-${chunk.y}-${x}-${y}`)) {
                ctx.globalAlpha = fadeAlpha;
              } else {
                ctx.globalAlpha = 1;
              }

              const tileset = window.mapData.tilesets.find(
                (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
              );
              if (!tileset) continue;

              const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
              if (!image || !image.complete) continue;

              const localTileIndex = tileIndex - tileset.firstgid;
              const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
              const srcX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
              const srcY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

              const drawX = screenX + x * window.mapData.tilewidth;
              const drawY = screenY + y * window.mapData.tileheight;

              try {
                ctx.drawImage(
                  image,
                  srcX, srcY,
                  tileset.tilewidth, tileset.tileheight,
                  drawX, drawY,
                  window.mapData.tilewidth, window.mapData.tileheight
                );
              } catch (error) {
                console.error("Error drawing tile:", error);
              }
            }
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  }
}

function animationLoop() {
  if (!ctx) return;

  const fpsTarget = parseFloat(fpsSlider.value);
  const frameDuration = 1000 / fpsTarget;
  const now = performance.now();
  let deltaTime = (now - lastFrameTime) / 1000;

  // Clamp deltaTime to prevent huge jumps when tab is hidden/visible
  // If more than 100ms has passed, assume it was a pause and cap at 16ms (60fps)
  const maxDeltaTime = 0.016; // 16ms for 60fps
  if (deltaTime > maxDeltaTime) {
    deltaTime = maxDeltaTime;
  }

  if (now - lastFrameTime < frameDuration) {
    requestAnimationFrame(animationLoop);
    return;
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

  if (getIsMoving() && getIsKeyPressed()) {
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

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.imageSmoothingEnabled = false;

  if (!wireframeDebugCheckbox.checked) {
    renderMap('lower');
  }

  const viewportLeft = cameraX - window.innerWidth / 2;
  const viewportTop = cameraY - window.innerHeight / 2;
  const viewportRight = cameraX + window.innerWidth / 2;
  const viewportBottom = cameraY + window.innerHeight / 2;
  const padding = 64;

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
    const { health, total_max_health, stamina, total_max_stamina } = currentPlayer.stats;
    const healthPercent = (health / total_max_health) * 100;
    const staminaPercent = (stamina / total_max_stamina) * 100;
    updateHealthBar(healthBar, healthPercent);
    updateStaminaBar(staminaBar, staminaPercent);
  }

  const visibleNpcs = cache.npcs.filter(npc =>
    isInView(npc.position.x, npc.position.y)
  );

  ctx.save();

  const offsetX = Math.round(window.innerWidth / 2 - smoothMapX);
  const offsetY = Math.round(window.innerHeight / 2 - smoothMapY);
  ctx.translate(offsetX, offsetY);

  ctx.imageSmoothingEnabled = false;

  // Render graveyards and warps when tile editor is active
  const tileEditor = (window as any).tileEditor;
  if (tileEditor?.isActive) {
    ctx.save();
    renderGraveyardsAndWarps(ctx, offsetX, offsetY);
    ctx.restore();
  }

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

    const npcEditor = (window as any).npcEditor;
    for (const npc of visibleNpcs) {
      npc.show(ctx);
      if (npc.particles) {
        for (const particle of npc.particles) {
          if (particle.visible) {
            npc.updateParticle(particle, npc, ctx, deltaTime);
          }
        }
      }
      npc.dialogue(ctx);
      // Draw outline for hidden NPCs when NPC editor is active
      if (npcEditor?.isActive && npc.hidden) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
        ctx.fillStyle = 'rgba(255, 80, 80, 0.15)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(npc.position.x - 16, npc.position.y - 24, 32, 48);
        ctx.strokeRect(npc.position.x - 16, npc.position.y - 24, 32, 48);
        ctx.restore();
      }
    }

    // Render entities (same pattern as NPCs but with combat features)
    const visibleEntities = cache.entities.filter(entity =>
      isInView(entity.position.x, entity.position.y)
    );

    for (const entity of visibleEntities) {
      entity.show(ctx);
      if (entity.particles) {
        for (const particle of entity.particles) {
          if (particle.visible !== false) {
            entity.updateParticle(particle, entity, ctx, deltaTime);
          }
        }
      }
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
        } else {

          ctx.fillStyle = 'white';
          ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(projectile.currentX, projectile.currentY, 5, 0, Math.PI * 2);
          ctx.fill();
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
    let playerTileX: number | undefined;
    let playerTileY: number | undefined;
    if (currentPlayer && window.mapData) {
      playerTileX = Math.floor(currentPlayer.position.x / window.mapData.tilewidth);
      playerTileY = Math.floor(currentPlayer.position.y / window.mapData.tileheight);
    }
    renderMap('upper', playerTileX, playerTileY);
  } else {

    ctx.save();
    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY);
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
    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY);
    ctx.translate(offsetX, offsetY);
    (window as any).tileEditor.renderPreview();
    ctx.restore();
  }

  if (!wireframeDebugCheckbox.checked) {
    ctx.save();
    const offsetX = Math.round(window.innerWidth / 2 - smoothMapX);
    const offsetY = Math.round(window.innerHeight / 2 - smoothMapY);
    ctx.translate(offsetX, offsetY);
    ctx.imageSmoothingEnabled = false;

    for (const p of visiblePlayers) {
      p.showChat(ctx, currentPlayer);
    }

    for (const p of visiblePlayers) {
      p.showDamageNumbers(ctx);
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

  if (times.length > 60) times.shift();
  times.push(now);
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
  initializeCamera,
  setPendingRequest,
  getPendingRequest
};
