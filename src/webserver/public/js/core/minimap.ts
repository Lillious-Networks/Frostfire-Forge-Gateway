import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import { serverTime } from "./ui.js";
import { getCorpseMarkerTarget } from "./death.js";
import { getCachedImage } from "./images.js";
import { getSkeletonSpriteUrl } from "./skeletons.js";
import { renderMinimapMap } from "./glmap/index.js";
import { renderMinimapMap as renderMinimapMapMobile } from "./glmap-mobile/index.js";
import { MOBILE_RENDERER } from "./renderpath.js";

const cache = Cache.getInstance();

const MINIMAP_SIZE = 250;
let minimapZoom = 2;
const MIN_ZOOM = 2;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.1;

const BUFFER_SCALE = 4;
const BUFFER_SIZE = MINIMAP_SIZE * BUFFER_SCALE;

let minimapCanvas: HTMLCanvasElement;
let minimapCtx: CanvasRenderingContext2D;
let minimapContainer: HTMLDivElement;
let minimapTimeEl: HTMLDivElement;
let minimapLocationEl: HTMLDivElement;
let bufferCanvas: HTMLCanvasElement;
let bufferCtx: CanvasRenderingContext2D;

function createMinimap() {
  minimapContainer = document.createElement("div");
  minimapContainer.id = "minimap-container";
  minimapContainer.className = "ui";

  minimapCanvas = document.createElement("canvas");
  minimapCanvas.id = "minimap-canvas";
  minimapCanvas.width = MINIMAP_SIZE;
  minimapCanvas.height = MINIMAP_SIZE;

  minimapContainer.appendChild(minimapCanvas);

  minimapTimeEl = document.createElement("div");
  minimapTimeEl.id = "minimap-time";
  minimapTimeEl.className = "ui";
  minimapContainer.appendChild(minimapTimeEl);

  minimapLocationEl = document.createElement("div");
  minimapLocationEl.id = "minimap-location";
  minimapLocationEl.className = "ui";
  minimapContainer.appendChild(minimapLocationEl);

  // Mobile draws the map into its own #minimap-map canvas (no buffer).
  if (!MOBILE_RENDERER) {
    bufferCanvas = document.createElement("canvas");
    bufferCanvas.width = BUFFER_SIZE;
    bufferCanvas.height = BUFFER_SIZE;
    bufferCtx = bufferCanvas.getContext("2d")!;
  }

  const overlay = document.getElementById("overlay");
  if (overlay) {
    overlay.appendChild(minimapContainer);
  }

  minimapCtx = minimapCanvas.getContext("2d")!;

  minimapContainer.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) {
      minimapZoom = Math.max(MIN_ZOOM, minimapZoom / ZOOM_STEP);
    } else {
      minimapZoom = Math.min(MAX_ZOOM, minimapZoom * ZOOM_STEP);
    }
  }, { passive: false });

  requestAnimationFrame(minimapLoop);
}
function renderMinimap() {
  if (!minimapCtx || !window.mapData) return;

  const playersArray = Array.from(
    cache.players instanceof Map ? cache.players.values() : cache.players,
  );
  const currentPlayer = playersArray.find((p: any) => p.id === cachedPlayerId);
  if (!currentPlayer) return;

  // Sync the frame plaque labels (top: server time, bottom: map name).
  if (minimapTimeEl) {
    const timeText = serverTime?.textContent || "";
    if (minimapTimeEl.textContent !== timeText) minimapTimeEl.textContent = timeText;
  }
  if (minimapLocationEl) {
    const rawName = (window.mapData?.name || "").replace(/\.json$/i, "");
    const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    if (minimapLocationEl.textContent !== displayName) minimapLocationEl.textContent = displayName;
  }

  const playerX = currentPlayer.renderPosition?.x ?? currentPlayer.position.x;
  const playerY = currentPlayer.renderPosition?.y ?? currentPlayer.position.y;

  const worldViewWidth = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldViewHeight = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldLeft = playerX - worldViewWidth / 2;
  const worldTop = playerY - worldViewHeight / 2;

  if (MOBILE_RENDERER) {
    // Mobile: glmap-mobile renders the map into #minimap-map, a WebGL canvas
    // placed under minimapCanvas; this canvas only draws the overlays.
    const tileEditor = (window as any).tileEditor;
    renderMinimapMapMobile(minimapCanvas, worldLeft, worldTop, worldViewWidth, worldViewHeight,
      tileEditor?.isActive ? (name: string) => tileEditor.isLayerVisible(name) : null);
  } else {
    // Compose all chunks into the offscreen buffer
    bufferCtx.clearRect(0, 0, BUFFER_SIZE, BUFFER_SIZE);
    bufferCtx.fillStyle = "#0a0a0a";
    bufferCtx.fillRect(0, 0, BUFFER_SIZE, BUFFER_SIZE);
    bufferCtx.imageSmoothingEnabled = true;
    bufferCtx.imageSmoothingQuality = "high";

    const mapPixelWidth = window.mapData.width * window.mapData.tilewidth;
    const mapPixelHeight = window.mapData.height * window.mapData.tileheight;
    const scale = BUFFER_SIZE / worldViewWidth;

    const mapBufX = (0 - worldLeft) * scale;
    const mapBufY = (0 - worldTop) * scale;
    const mapBufW = mapPixelWidth * scale;
    const mapBufH = mapPixelHeight * scale;

    bufferCtx.save();
    bufferCtx.beginPath();
    bufferCtx.rect(mapBufX, mapBufY, mapBufW, mapBufH);
    bufferCtx.clip();

    // Tile layers of the loaded chunks, rendered on the GPU at world resolution
    // and scaled into the buffer (glmap).
    const tileEditor = (window as any).tileEditor;
    renderMinimapMap(bufferCtx, worldLeft, worldTop, worldViewWidth, worldViewHeight, 0, 0, BUFFER_SIZE, BUFFER_SIZE,
      tileEditor?.isActive ? (name: string) => tileEditor.isLayerVisible(name) : null);

    bufferCtx.restore();
  }

  // Draw the composited buffer onto the minimap
  const ctx = minimapCtx;
  const halfSize = MINIMAP_SIZE / 2;
  const radius = halfSize - 3;

  ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.arc(halfSize, halfSize, radius, 0, Math.PI * 2);
  ctx.clip();

  if (!MOBILE_RENDERER) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bufferCanvas, 0, 0, BUFFER_SIZE, BUFFER_SIZE, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  }

  // Tinted overlay to desaturate and give a map-like feel
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#1a2a3a";
  ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  ctx.globalAlpha = 1;

  // Subtle grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 0.5;
  const gridStep = 16;
  for (let gx = gridStep; gx < MINIMAP_SIZE; gx += gridStep) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, MINIMAP_SIZE);
    ctx.stroke();
  }
  for (let gy = gridStep; gy < MINIMAP_SIZE; gy += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(MINIMAP_SIZE, gy);
    ctx.stroke();
  }

  // Radial vignette
  const vignetteGradient = ctx.createRadialGradient(
    halfSize, halfSize, radius * 0.6,
    halfSize, halfSize, radius,
  );
  vignetteGradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignetteGradient.addColorStop(1, "rgba(0, 0, 0, 0.25)");
  ctx.fillStyle = vignetteGradient;
  ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  // Draw player dots
  for (const player of playersArray) {
    if (!player || player.id === cachedPlayerId) continue;
    if (player.isStealth && !currentPlayer.isAdmin) continue;
    // Corpses despawn for everyone else; ghosts stay visible.
    if (player.isDead) continue;
    // Ghosts pending teleport render only once their spawn confirm lands.
    if (player.isGhost && player.ghostTeleportPending) continue;
    const px = halfSize + (player.position.x - playerX) / minimapZoom;
    const py = halfSize + (player.position.y - playerY) / minimapZoom;
    if (Math.hypot(px - halfSize, py - halfSize) <= radius - 2) {
      let color = "#FFFFFF";
      let size = 2;
      if (player.isAdmin) {
        color = "#FF4444";
        size = 3;
      } else if (currentPlayer.party?.includes(player.username)) {
        color = "#00ff88";
      } else if (currentPlayer.guild?.includes(player.username)) {
        color = "#00CC66";
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Own corpse: skeleton icon when inside the minimap, clamped to the rim
  // when outside so the direction is always visible.
  const corpse = getCorpseMarkerTarget();
  if (corpse) {
    const corpseImg = getCachedImage(getSkeletonSpriteUrl());
    if (corpseImg.complete && corpseImg.naturalWidth > 0) {
      const iconSize = 22;
      let ix = halfSize + (corpse.x - playerX) / minimapZoom;
      let iy = halfSize + (corpse.y - playerY) / minimapZoom;
      const dx = ix - halfSize;
      const dy = iy - halfSize;
      const dist = Math.hypot(dx, dy);
      const rim = radius - 6 - iconSize / 2;
      if (dist > rim && dist > 0) {
        ix = halfSize + (dx / dist) * rim;
        iy = halfSize + (dy / dist) * rim;
      }
      ctx.drawImage(corpseImg, ix - iconSize / 2, iy - iconSize / 2, iconSize, iconSize);
    }
  }

  // Current player marker
  ctx.fillStyle = "#4488FF";
  ctx.beginPath();
  ctx.arc(halfSize, halfSize, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Direction arrow
  ctx.resetTransform();
  const dir = currentPlayer.lastDirection || "down";
  const arrowAngles: Record<string, number> = {
    up: -Math.PI / 2,
    down: Math.PI / 2,
    left: Math.PI,
    right: 0,
    upleft: -Math.PI * 3 / 4,
    upright: -Math.PI / 4,
    downleft: Math.PI * 3 / 4,
    downright: Math.PI / 4,
  };
  const arrowAngle = arrowAngles[dir] ?? Math.PI / 2;
  const arrowTipX = halfSize + Math.cos(arrowAngle) * 8;
  const arrowTipY = halfSize + Math.sin(arrowAngle) * 8;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(arrowTipX, arrowTipY, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Border rings
  ctx.beginPath();
  ctx.arc(halfSize, halfSize, radius + 1, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(halfSize, halfSize, radius + 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Signal a completed draw pass (reached only past all early-returns above).
  // hideLoadingScreen waits on this alongside the main canvas first frame.
  (window as any).__minimapRendered = true;
}

let minimapFrameCounter = 0;
const MINIMAP_FRAME_INTERVAL = 2;

function minimapLoop() {
  minimapFrameCounter++;
  if (minimapFrameCounter >= MINIMAP_FRAME_INTERVAL) {
    renderMinimap();
    minimapFrameCounter = 0;
  }
  requestAnimationFrame(minimapLoop);
}

createMinimap();

export { createMinimap };
