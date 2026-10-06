import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import { serverTime } from "./ui.js";
import { getCorpseMarkerTarget } from "./death.js";
import { getCachedImage } from "./images.js";
import { getSkeletonSpriteUrl } from "./skeletons.js";
import { renderMinimapMap } from "./glmap/index.js";
import { renderMinimapMap as renderMinimapMapMobile } from "./glmap-mobile/index.js";
import { MOBILE_RENDERER } from "./renderpath.js";
import { bakedMap, mapDetailPiece, DETAIL_TILES } from "./bakedmap.js";

const cache = Cache.getInstance();

const MINIMAP_SIZE = 250;
/**
 * USER REQUEST 2026-10-03 ("minimap should use the baked image too and update the zoom mechanics"): the minimap draws
 * the map's baked image (bakedmap.ts, one pixel per tile), so it can zoom far out. Zoom goes in fixed steps of minimap
 * pixels per tile (whole or simple fractions, so the tile blocks stay even): 8 = ~31 tiles across, 0.5 = ~500. The
 * wheel steps through them; the choice is remembered. While the tile editor is open (its edits are not baked yet) or
 * when the map has no baked image, the live tile render of the loaded chunks is drawn instead, at most LIVE_MAX_ZOOM
 * world px per minimap px (it can only show loaded chunks).
 */
const ZOOM_LEVELS = [8, 6, 4, 3, 2, 1.5, 1, 0.75, 0.5];
const ZOOM_DEFAULT = 3;
const ZOOM_STORE = "minimapZoomLevel";
const LIVE_MAX_ZOOM = 4;
let zoomIndex = (() => {
  try {
    const i = ZOOM_LEVELS.indexOf(Number(localStorage.getItem(ZOOM_STORE)));
    if (i >= 0) return i;
  } catch { /* storage unavailable: the default */ }
  return ZOOM_LEVELS.indexOf(ZOOM_DEFAULT);
})();
/** World px per minimap px this frame (the overlays' scale), from the zoom level and the map's tile size. */
let minimapZoom = 16 / ZOOM_DEFAULT;

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
    // wheel up zooms in (more pixels per tile), down zooms out, one step per notch
    zoomIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, zoomIndex + (e.deltaY < 0 ? -1 : 1)));
    try { localStorage.setItem(ZOOM_STORE, String(ZOOM_LEVELS[zoomIndex])); } catch { /* not remembered */ }
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

  const tw = window.mapData.tilewidth || 16, th = window.mapData.tileheight || 16;
  const pxPerTile = ZOOM_LEVELS[zoomIndex]!;
  const editing = !!(window as any).tileEditor?.isActive;
  // A world's image is several tiles to a pixel (bakedmap.ts scale): close in, the live render shows more than it
  // could, so that is drawn; zoomed out past what the live render reaches (LIVE_MAX_ZOOM), the image is drawn with
  // its full-detail pieces over it (USER FEEDBACK 2026-10-05: "I can't zoom the minimap out anymore" on a world).
  const bakedNow = bakedMap(), bakedScale = bakedNow.scale;
  const baked = editing || (bakedScale !== 1 && tw / pxPerTile <= LIVE_MAX_ZOOM) ? null : bakedNow.image;
  // the overlays' scale; the live render can only cover the loaded chunks, so it stops at LIVE_MAX_ZOOM
  minimapZoom = baked ? tw / pxPerTile : Math.min(LIVE_MAX_ZOOM, tw / pxPerTile);

  const worldViewWidth = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldViewHeight = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldLeft = playerX - worldViewWidth / 2;
  const worldTop = playerY - worldViewHeight / 2;

  if (baked) {
    // the baked image is drawn straight onto the minimap below (no live render)
  } else if (MOBILE_RENDERER) {
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

  if (baked) {
    // the baked image (one pixel per tile) round the player: whole blocks when zoomed in, smoothed below 1 px per tile;
    // beyond the map's edge the dark void
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    const span = MINIMAP_SIZE / pxPerTile;
    // a world's coarse image is smoothed (it is only what shows until its pieces load)
    ctx.imageSmoothingEnabled = bakedScale !== 1 || pxPerTile < 1;
    ctx.imageSmoothingQuality = "high";
    const sx = playerX / tw - span / 2, sy = playerY / th - span / 2;
    // the part of the view inside the image (in tiles), drawn where it falls on the minimap
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(baked.naturalWidth * bakedScale, sx + span), y1 = Math.min(baked.naturalHeight * bakedScale, sy + span);
    if (x1 > x0 && y1 > y0) {
      ctx.drawImage(baked, x0 / bakedScale, y0 / bakedScale, (x1 - x0) / bakedScale, (y1 - y0) / bakedScale, (x0 - sx) * pxPerTile, (y0 - sy) * pxPerTile, (x1 - x0) * pxPerTile, (y1 - y0) * pxPerTile);
      if (bakedScale !== 1) {
        // the world's full-detail pieces under the view, one pixel per tile like any map's image
        ctx.imageSmoothingEnabled = pxPerTile < 1;
        for (let ry = Math.floor(y0 / DETAIL_TILES); ry * DETAIL_TILES < y1; ry++) for (let rx = Math.floor(x0 / DETAIL_TILES); rx * DETAIL_TILES < x1; rx++) {
          const piece = mapDetailPiece(rx, ry);
          if (!piece) continue;
          const px = rx * DETAIL_TILES, py = ry * DETAIL_TILES;
          const a0 = Math.max(x0, px), b0 = Math.max(y0, py), a1 = Math.min(x1, px + piece.naturalWidth), b1 = Math.min(y1, py + piece.naturalHeight);
          if (a1 > a0 && b1 > b0) ctx.drawImage(piece, a0 - px, b0 - py, a1 - a0, b1 - b0, (a0 - sx) * pxPerTile, (b0 - sy) * pxPerTile, (a1 - a0) * pxPerTile, (b1 - b0) * pxPerTile);
        }
      }
    }
  } else if (!MOBILE_RENDERER) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bufferCanvas, 0, 0, BUFFER_SIZE, BUFFER_SIZE, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  }

  // Tinted overlay to desaturate and give a map-like feel
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#1a2a3a";
  ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  ctx.globalAlpha = 1;

  // (no grid lines over the map: USER REQUEST 2026-10-03 "Remove the borders in the map image")

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
