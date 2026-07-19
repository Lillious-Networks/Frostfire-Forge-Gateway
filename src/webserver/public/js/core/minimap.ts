import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import { serverTime } from "./ui.js";

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

  bufferCanvas = document.createElement("canvas");
  bufferCanvas.width = BUFFER_SIZE;
  bufferCanvas.height = BUFFER_SIZE;
  bufferCtx = bufferCanvas.getContext("2d")!;

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

// Draws a static first-frame representation of a chunk's animated tiles onto the
// minimap buffer. The minimap never animates; it always shows animation frame 0.
function drawChunkAnimatedFirstFrames(chunkData: any, bufX: number, bufY: number, scale: number) {
  if (!bufferCtx || !window.mapData) return;
  const animatedTiles = chunkData?.animatedTiles;
  if (!animatedTiles || animatedTiles.length === 0) return;

  const destW = window.mapData.tilewidth * scale;
  const destH = window.mapData.tileheight * scale;

  for (const at of animatedTiles) {
    const image = window.mapData.images[at.tilesetIndex];
    if (!image || !image.complete || image.naturalWidth === 0) continue;

    const tileset = at.tileset;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    if (tilesPerRow <= 0) continue;

    const firstTileId = at.animation[0]?.tileid ?? 0;
    const srcX = (firstTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(firstTileId / tilesPerRow) * tileset.tileheight;

    const destBX = bufX + at.destX * scale;
    const destBY = bufY + at.destY * scale;
    const flipH = at.flipH || false;
    const flipV = at.flipV || false;
    const flipD = at.flipD || false;

    if (flipH || flipV || flipD) {
      const cx = destBX + destW / 2;
      const cy = destBY + destH / 2;
      let rot = 0;
      let effH = flipH;
      let effV = flipV;
      if (flipD) { rot = Math.PI / 2; effH = flipV; effV = !flipH; }
      bufferCtx.save();
      bufferCtx.translate(cx, cy);
      if (rot !== 0) bufferCtx.rotate(rot);
      bufferCtx.scale(effH ? -1 : 1, effV ? -1 : 1);
      bufferCtx.drawImage(
        image,
        srcX, srcY,
        tileset.tilewidth, tileset.tileheight,
        -destW / 2, -destH / 2,
        destW, destH,
      );
      bufferCtx.restore();
    } else {
      bufferCtx.drawImage(
        image,
        srcX, srcY,
        tileset.tilewidth, tileset.tileheight,
        destBX, destBY,
        destW, destH,
      );
    }
  }
}

function renderMinimap() {
  if (!minimapCtx || !window.mapData) return;

  const playersArray = Array.from(
    cache.players instanceof Map ? cache.players.values() : cache.players,
  );
  const currentPlayer = playersArray.find((p: any) => p.id === cachedPlayerId);
  if (!currentPlayer) return;

  const playerX = currentPlayer.renderPosition?.x ?? currentPlayer.position.x;
  const playerY = currentPlayer.renderPosition?.y ?? currentPlayer.position.y;

  const worldViewWidth = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldViewHeight = BUFFER_SIZE * minimapZoom / BUFFER_SCALE;
  const worldLeft = playerX - worldViewWidth / 2;
  const worldTop = playerY - worldViewHeight / 2;

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;

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

  window.mapData.loadedChunks.forEach((chunkData: any, _chunkKey: string) => {
    const cx = chunkData.chunkX;
    const cy = chunkData.chunkY;
    const chunkWorldX = cx * chunkPixelSize;
    const chunkWorldY = cy * chunkPixelSize;

    if (
      chunkWorldX + chunkPixelSize < worldLeft ||
      chunkWorldX > worldLeft + worldViewWidth ||
      chunkWorldY + chunkPixelSize < worldTop ||
      chunkWorldY > worldTop + worldViewHeight
    ) {
      return;
    }

    const bufX = (chunkWorldX - worldLeft) * scale;
    const bufY = (chunkWorldY - worldTop) * scale;
    const actualW = chunkData.width * window.mapData.tilewidth;
    const actualH = chunkData.height * window.mapData.tileheight;
    const bufW = actualW * scale;
    const bufH = actualH * scale;

    const segmentCanvases = chunkData.segmentCanvases;
    if (segmentCanvases) {
      for (const segmentCanvas of segmentCanvases) {
        bufferCtx.drawImage(
          segmentCanvas,
          0, 0, segmentCanvas.width, segmentCanvas.height,
          bufX, bufY, bufW, bufH,
        );
      }
    }

    // Animated tiles are skipped during static chunk baking, so draw a static
    // first-frame version of each onto the minimap buffer.
    drawChunkAnimatedFirstFrames(chunkData, bufX, bufY, scale);
  });

  bufferCtx.restore();

  // Draw the composited buffer onto the minimap
  const ctx = minimapCtx;
  const halfSize = MINIMAP_SIZE / 2;
  const radius = halfSize - 3;

  ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.arc(halfSize, halfSize, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bufferCanvas, 0, 0, BUFFER_SIZE, BUFFER_SIZE, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

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

  // Cardinal direction markers
  ctx.font = "bold 11px 'Comic Relief', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#FFFFFF";
  const labelOffset = radius - 12;
  ctx.fillText("N", halfSize, halfSize - labelOffset);
  ctx.fillText("S", halfSize, halfSize + labelOffset);
  ctx.fillText("E", halfSize + labelOffset, halfSize);
  ctx.fillText("W", halfSize - labelOffset, halfSize);

  // Server time at bottom of minimap (drawn after markers so it sits on top)
  const timeText = serverTime?.textContent || "";
  if (timeText) {
    const timeY = halfSize + radius - 37;
    const timeW = 80;
    const timeH = 24;
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.beginPath();
    ctx.roundRect(halfSize - timeW / 2, timeY - timeH / 2, timeW, timeH, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.font = "bold 13px 'Comic Relief', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.fillText(timeText, halfSize, timeY);
  }

  // Draw entity dots
  for (const player of playersArray) {
    if (!player || player.id === cachedPlayerId) continue;
    if (player.isStealth && !currentPlayer.isAdmin) continue;
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

  for (const entity of cache.entities) {
    if (!entity || !entity.position) continue;
    const px = halfSize + (entity.position.x - playerX) / minimapZoom;
    const py = halfSize + (entity.position.y - playerY) / minimapZoom;
    if (Math.hypot(px - halfSize, py - halfSize) <= radius - 2) {
      ctx.fillStyle = "#FF8800";
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fill();
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
}

let minimapFrameCounter = 0;
const MINIMAP_FRAME_INTERVAL = 15;

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
