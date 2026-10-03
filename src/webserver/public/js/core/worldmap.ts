import Cache from "./cache.js";
import { cachedPlayerId, sendRequest } from "./socket.js";
import { bakedMap } from "./bakedmap.js";

/**
 * Full world map (M): the whole map at once from its baked image (bakedmap.ts: the asset server bakes one pixel per tile
 * at startup), since the live tile render only has the chunks this client has loaded.
 * Always fills the screen (opens centred on the player; zooming out stops where the map still fills it, panning stops
 * at its edges; USER REQUEST 2026-10-03, opaque); mouse wheel zooms round the cursor, drag pans. The player and the map's warps are marked.
 */
const cache = Cache.getInstance();

let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let statusEl: HTMLDivElement | null = null;
let titleEl: HTMLDivElement | null = null;
let open = false;
let raf: number | null = null;

// the baked image (bakedmap.ts, shared with the minimap) and the one the view was last fitted to
let image: HTMLImageElement | null = null;
let fitted: HTMLImageElement | null = null;

// view: image pixel (tile) at the canvas centre, and screen px per image px
// coverZoom: the least zoom that still fills the screen (USER REQUEST 2026-10-03: "the fullscreen map should always fill
// the screen and should catch on edges as not to show behind the map"); zoom never goes below it and the view never
// pans past the map's edges (keepInside, every frame, so a window resize holds too)
let viewX = 0, viewY = 0, zoom = 1, coverZoom = 1;
let dragging = false, dragX = 0, dragY = 0;
/** Behind the map while its image loads (the map itself is opaque and always fills the screen). USER REQUEST
 * 2026-10-03: the earlier slight transparency removed. */
const BACKDROP = "#06080e";

function build() {
  if (root) return;
  root = document.createElement("div");
  root.id = "world-map";
  Object.assign(root.style, {
    position: "fixed", inset: "0", zIndex: "9000", display: "none", background: BACKDROP,
    userSelect: "none", cursor: "grab",
  } as CSSStyleDeclaration);
  canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" } as CSSStyleDeclaration);
  titleEl = document.createElement("div");
  Object.assign(titleEl.style, {
    position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)", color: "#e8e2d0",
    font: "600 18px sans-serif", textShadow: "0 1px 3px #000", pointerEvents: "none",
  } as CSSStyleDeclaration);
  statusEl = document.createElement("div");
  Object.assign(statusEl.style, {
    // USER REQUEST 2026-10-03: the controls hint more noticeable (the text itself, no background): larger, bold, bright,
    // with a dark outline so it reads on any part of the map
    position: "absolute", bottom: "22px", left: "50%", transform: "translateX(-50%)", color: "#fff3c4",
    font: "700 18px sans-serif", letterSpacing: "0.3px", pointerEvents: "none", whiteSpace: "nowrap",
    textShadow: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 6px rgba(0,0,0,0.9)",
  } as CSSStyleDeclaration);
  root.append(canvas, titleEl, statusEl);
  document.body.appendChild(root);
  ctx = canvas.getContext("2d");

  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!image || !canvas) return;
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const before = { x: viewX + mx / zoom, y: viewY + my / zoom };
    zoom = Math.min(16, Math.max(coverZoom, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    viewX = before.x - mx / zoom; viewY = before.y - my / zoom;
    keepInside();
  }, { passive: false });
  root.addEventListener("mousedown", (e) => { if (e.button !== 0) return; dragging = true; dragX = e.clientX; dragY = e.clientY; root!.style.cursor = "grabbing"; });
  // USER REQUEST 2026-10-03: right-click on the map warps there (the same TELEPORTXY as a right-click on the ground in
  // game; the server only takes it from admins). Kept from the document's handler, which reads the game camera.
  root.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!image || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const ix = Math.min(image.width - 0.5, Math.max(0, viewX + (e.clientX - r.left - r.width / 2) / zoom));
    const iy = Math.min(image.height - 0.5, Math.max(0, viewY + (e.clientY - r.top - r.height / 2) / zoom));
    const tw = window.mapData?.tilewidth || 16, th = window.mapData?.tileheight || 16;
    sendRequest({ type: "TELEPORTXY", data: { x: Math.floor(ix * tw), y: Math.floor(iy * th) } });
  });
  window.addEventListener("mouseup", () => { dragging = false; if (root) root.style.cursor = "grab"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !open) return;
    viewX -= (e.clientX - dragX) / zoom; viewY -= (e.clientY - dragY) / zoom; dragX = e.clientX; dragY = e.clientY;
  });
  // touch: one finger pans
  root.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { dragging = true; dragX = e.touches[0].clientX; dragY = e.touches[0].clientY; } }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (!dragging || e.touches.length !== 1) return;
    viewX -= (e.touches[0].clientX - dragX) / zoom; viewY -= (e.touches[0].clientY - dragY) / zoom;
    dragX = e.touches[0].clientX; dragY = e.touches[0].clientY;
  }, { passive: true });
  root.addEventListener("touchend", () => { dragging = false; });
}

function mapName(): string {
  return String(window.mapData?.name ?? "").replace(".json", "");
}

/** A map name as shown (title, warp labels): "underworld-dev" -> "Underworld Dev". In code, not CSS: the warp labels
 * are canvas text, which CSS text-transform never reaches (USER FEEDBACK 2026-10-03: the names were not capitalised). */
function displayName(name: string): string {
  return name.replace(/\.json$/i, "").replace(/[-_]+/g, " ").trim().replace(/(^|\s)(\S)/g, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

/** Picks up the shared baked image; fits the view the first time a map's image is there. */
function syncImage() {
  const b = bakedMap();
  image = b.image;
  if (image && image !== fitted) { fitted = image; fitView(); }
  if (statusEl) statusEl.textContent = image ? "Scroll to zoom · drag to move · M or Esc to close"
    : b.state === "missing" ? "No world map for this area" : "Loading map…";
}

/** The least zoom that fills a w x h screen with the image. */
function coverFor(w: number, h: number): number {
  return image ? Math.max(w / image.width, h / image.height) : 1;
}

/** Zoom at least coverZoom and the view inside the image, so the map always fills the screen. */
function keepInside() {
  if (!image) return;
  const w = window.innerWidth, h = window.innerHeight;
  coverZoom = coverFor(w, h);
  if (zoom < coverZoom) zoom = coverZoom;
  const hw = w / 2 / zoom, hh = h / 2 / zoom;
  viewX = Math.min(Math.max(viewX, hw), image.width - hw);
  viewY = Math.min(Math.max(viewY, hh), image.height - hh);
}

/** Opens at the fill zoom, centred on the player (kept inside the map). */
function fitView() {
  if (!image || !canvas) return;
  zoom = coverFor(window.innerWidth, window.innerHeight);
  const me: any = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const tw = window.mapData?.tilewidth || 16, th = window.mapData?.tileheight || 16;
  viewX = me?.position ? me.position.x / tw : image.width / 2;
  viewY = me?.position ? me.position.y / th : image.height / 2;
  keepInside();
}

function draw() {
  if (!open || !canvas || !ctx) return;
  syncImage();
  keepInside();
  const dpr = window.devicePixelRatio || 1, w = window.innerWidth, h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (image) {
    const toX = (ix: number) => w / 2 + (ix - viewX) * zoom, toY = (iy: number) => h / 2 + (iy - viewY) * zoom;
    ctx.imageSmoothingEnabled = zoom < 1;
    ctx.drawImage(image, toX(0), toY(0), image.width * zoom, image.height * zoom);
    // (no outline round the image: USER REQUEST 2026-10-03 "Remove the borders in the map image")

    const tw = window.mapData?.tilewidth || 16, th = window.mapData?.tileheight || 16;
    // warps: where each leads
    const warps: any[] = Array.isArray(window.mapData?.warps) ? window.mapData.warps : [];
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    for (const warp of warps) {
      const px = (Number(warp.position?.x ?? 0) + Number(warp.size?.width ?? 0) / 2) / tw;
      const py = (Number(warp.position?.y ?? 0) + Number(warp.size?.height ?? 0) / 2) / th;
      const sx = toX(px), sy = toY(py);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      ctx.fillStyle = "#7fd0ff";
      ctx.strokeStyle = "#0b1a26";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 5, sy); ctx.closePath();
      ctx.stroke(); ctx.fill();
      if (zoom >= coverZoom * 2) {
        const label = displayName(String(warp.map ?? ""));
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.strokeText(label, sx, sy - 10);
        ctx.fillStyle = "#cfeeff"; ctx.fillText(label, sx, sy - 10);
      }
    }
    // the player
    const me: any = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
    if (me?.position) {
      const sx = toX(me.position.x / tw), sy = toY(me.position.y / th), pulse = 2 + Math.sin(performance.now() / 250) * 1.5;
      ctx.fillStyle = "rgba(255,214,90,0.35)";
      ctx.beginPath(); ctx.arc(sx, sy, 7 + pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd65a"; ctx.strokeStyle = "#3a2a00"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
    }
  }
  raf = requestAnimationFrame(draw);
}

export function isWorldMapOpen(): boolean {
  return open;
}

export function openWorldMap() {
  build();
  if (!root) return;
  open = true;
  root.style.display = "block";
  if (titleEl) titleEl.textContent = displayName(mapName());
  fitted = null; // refit on every open
  syncImage();
  if (raf === null) raf = requestAnimationFrame(draw);
}

export function closeWorldMap() {
  open = false;
  dragging = false;
  if (root) root.style.display = "none";
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
}

export function toggleWorldMap() {
  if (open) closeWorldMap(); else openWorldMap();
}
