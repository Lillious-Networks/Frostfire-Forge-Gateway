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
/** the distance between two fingers at their last move, while they pinch (0: no pinch) */
let pinch = 0;

/**
 * Centre on player (USER REQUEST 2026-10-04: "Add a center on player toggle that zooms in and moves the map centering
 * on the player"). On: the view eases to the player at FOLLOW_ZOOM screen px per tile (or the zoom it already has, if
 * that is closer in) and stays on him as he moves; the wheel and a pinch then only change the zoom. Dragging the map
 * lets go of him. Off (the button again): the view eases back to where it was when it was turned on. The choice lasts
 * while the page does: a map closed with it on opens on the player again.
 */
type View = { x: number; y: number; zoom: number };
const FOLLOW_ZOOM = 4, MAX_ZOOM = 16;
let follow = false, followZoom = FOLLOW_ZOOM;
/** the view the toggle was turned on from, and the view being eased back to after it was turned off */
let before: View | null = null, back: View | null = null;
let followBtn: HTMLButtonElement | null = null;
let lastFrame = 0;

/** The player's place on the image (tiles), or null before he is known. */
function playerTile(): { x: number; y: number } | null {
  const me: any = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  if (!me?.position) return null;
  return { x: me.position.x / (window.mapData?.tilewidth || 16), y: me.position.y / (window.mapData?.tileheight || 16) };
}

/** Turns centre-on-player on or off. `goBack`: off returns to the view it was turned on from (the button), or stays (a drag). */
function setFollow(on: boolean, goBack = true) {
  if (on === follow) return;
  follow = on;
  if (on) {
    before = { x: viewX, y: viewY, zoom };
    back = null;
    followZoom = Math.min(MAX_ZOOM, Math.max(zoom, FOLLOW_ZOOM, coverZoom));
  } else {
    back = goBack ? before : null;
    before = null;
  }
  paintFollow();
}

/** The toggle's look: lit while it holds the player. */
function paintFollow() {
  if (!followBtn) return;
  followBtn.style.background = follow ? "rgba(255,214,90,0.92)" : "rgba(10,8,5,0.75)";
  followBtn.style.color = follow ? "#2a1c00" : "#fff3c4";
  followBtn.setAttribute("aria-pressed", String(follow));
}
/** Behind the map while its image loads (the map itself is opaque and always fills the screen). USER REQUEST
 * 2026-10-03: the earlier slight transparency removed. */
const BACKDROP = "#06080e";

function build() {
  if (root) return;
  root = document.createElement("div");
  root.id = "world-map";
  Object.assign(root.style, {
    // over the whole HUD, the mobile action menu and its button (z 8998-9000) and the mobile panels (9500) included
    // (USER FEEDBACK 2026-10-04: "Action menu z-index needs to be below the map itself so make the map higher
    // z-index"); under the options and pause menus, the loading screen and the rotate prompt (10000 and up). The
    // menu's World Map entry opens it; the close button, M or Esc close it.
    position: "fixed", inset: "0", zIndex: "9600", display: "none", background: BACKDROP,
    userSelect: "none", cursor: "grab", touchAction: "none",
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
  // a close button: a touch screen has no M or Esc. Top right, the same distance from the top as from the right
  // (USER FEEDBACK 2026-10-04, "map close button needs to be top right even padding": it followed the phone's safe
  // areas, which on a phone held sideways put it some 50 px in from the right and 10 px down)
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Close the map";
  closeBtn.setAttribute("aria-label", "Close the map");
  Object.assign(closeBtn.style, {
    position: "absolute", top: "16px", right: "16px", margin: "0", padding: "0", boxSizing: "border-box",
    width: "44px", height: "44px", borderRadius: "22px", border: "2px solid rgba(255,243,196,0.8)",
    background: "rgba(10,8,5,0.75)", color: "#fff3c4", font: "700 20px sans-serif", lineHeight: "1", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  } as CSSStyleDeclaration);
  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); closeWorldMap(); });
  // centre on player (see `follow`): beside the close button, the same size and the same distance from the top
  followBtn = document.createElement("button");
  followBtn.type = "button";
  followBtn.title = "Centre on player";
  followBtn.setAttribute("aria-label", "Centre on player");
  followBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
  Object.assign(followBtn.style, {
    position: "absolute", top: "16px", right: "70px", margin: "0", padding: "0", boxSizing: "border-box",
    width: "44px", height: "44px", borderRadius: "22px", border: "2px solid rgba(255,243,196,0.8)", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  } as CSSStyleDeclaration);
  followBtn.addEventListener("click", (e) => { e.stopPropagation(); setFollow(!follow); });
  paintFollow();
  for (const btn of [closeBtn, followBtn]) for (const type of ["mousedown", "touchstart"]) btn.addEventListener(type, (e) => e.stopPropagation(), { passive: true }); // not a drag
  root.append(canvas, titleEl, statusEl, followBtn, closeBtn);
  document.body.appendChild(root);
  ctx = canvas.getContext("2d");

  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!image || !canvas) return;
    const step = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    // centred on the player: the wheel changes how close, not where
    if (follow) { followZoom = Math.min(MAX_ZOOM, Math.max(coverZoom, followZoom * step)); return; }
    back = null;
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const under = { x: viewX + mx / zoom, y: viewY + my / zoom };
    zoom = Math.min(MAX_ZOOM, Math.max(coverZoom, zoom * step));
    viewX = under.x - mx / zoom; viewY = under.y - my / zoom;
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
  /**
   * A drag by (dx, dy) screen px: the map moves with it, and lets go of the player. While it holds the player the
   * first 8 px of a drag do nothing, so a finger that shifts as it taps does not let go of him.
   */
  let slack = 0;
  const pan = (dx: number, dy: number) => {
    if (dx === 0 && dy === 0) return;
    if (follow && (slack += Math.hypot(dx, dy)) < 8) return;
    setFollow(false, false);
    back = null;
    viewX -= dx / zoom; viewY -= dy / zoom;
  };
  for (const type of ["mousedown", "touchstart"]) root.addEventListener(type, () => { slack = 0; }, { passive: true });
  window.addEventListener("mousemove", (e) => {
    if (!dragging || !open) return;
    pan(e.clientX - dragX, e.clientY - dragY); dragX = e.clientX; dragY = e.clientY;
  });
  // touch: one finger pans, two fingers pinch to zoom round the point between them
  const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onePan = (t: TouchList) => { dragging = t.length === 1; if (dragging) { dragX = t[0].clientX; dragY = t[0].clientY; } };
  root.addEventListener("touchstart", (e) => { onePan(e.touches); pinch = e.touches.length === 2 ? spread(e.touches) : 0; }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinch > 0 && image && canvas) {
      const r = canvas.getBoundingClientRect(), now = spread(e.touches);
      // centred on the player: the pinch changes how close, not where
      if (follow) { followZoom = Math.min(MAX_ZOOM, Math.max(coverZoom, followZoom * now / pinch)); pinch = now; return; }
      back = null;
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left - r.width / 2, my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top - r.height / 2;
      const under = { x: viewX + mx / zoom, y: viewY + my / zoom };
      zoom = Math.min(MAX_ZOOM, Math.max(coverZoom, zoom * now / pinch));
      viewX = under.x - mx / zoom; viewY = under.y - my / zoom;
      pinch = now;
      keepInside();
      return;
    }
    if (!dragging || e.touches.length !== 1) return;
    pan(e.touches[0].clientX - dragX, e.touches[0].clientY - dragY);
    dragX = e.touches[0].clientX; dragY = e.touches[0].clientY;
  }, { passive: true });
  // a finger lifted from a pinch: the one left pans on from where it is
  for (const type of ["touchend", "touchcancel"]) root.addEventListener(type, (e) => { pinch = 0; onePan((e as TouchEvent).touches); });
}

/** A touch screen (no wheel, no keys): the hint names its gestures. */
const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

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
  if (statusEl) statusEl.textContent = image ? (TOUCH ? "Pinch to zoom · drag to move · ✕ to close" : "Scroll to zoom · drag to move · M or Esc to close")
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
  // opened with centre-on-player on: it zooms in from here, and turning it off comes back to here
  back = null;
  if (follow) { before = { x: viewX, y: viewY, zoom }; followZoom = Math.min(MAX_ZOOM, Math.max(followZoom, coverZoom)); }
}

/**
 * Moves the view a step toward where it is headed: the player while centre-on-player is on, else the view being gone
 * back to after it was turned off (dropped once reached). `dt`: seconds since the last frame.
 */
function ease(dt: number) {
  const at = follow ? playerTile() : null, to: View | null = follow ? (at ? { ...at, zoom: followZoom } : null) : back;
  if (!to) return;
  const k = 1 - Math.exp(-dt * 10), toZoom = Math.max(to.zoom, coverZoom);
  viewX += (to.x - viewX) * k; viewY += (to.y - viewY) * k;
  zoom *= (toZoom / zoom) ** k; // by ratio: a zoom looks even when it scales, not when it adds
  if (!follow && Math.abs(Math.log(toZoom / zoom)) < 0.002) {
    // back at the zoom it had (the place may differ a little where the map's edge holds the view): done
    viewX = to.x; viewY = to.y; zoom = toZoom;
    back = null;
  }
}

function draw() {
  if (!open || !canvas || !ctx) return;
  syncImage();
  const now = performance.now();
  if (image) ease(Math.min(0.1, Math.max(0, (now - lastFrame) / 1000)));
  lastFrame = now;
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
  lastFrame = performance.now();
  syncImage();
  if (raf === null) raf = requestAnimationFrame(draw);
}

export function closeWorldMap() {
  open = false;
  dragging = false;
  pinch = 0;
  back = null;
  if (root) root.style.display = "none";
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
}

export function toggleWorldMap() {
  if (open) closeWorldMap(); else openWorldMap();
}
