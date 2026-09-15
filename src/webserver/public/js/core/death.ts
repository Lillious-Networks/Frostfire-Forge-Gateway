import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { SKELETON_TTL_MS, getScreenView, worldToScreenCss } from "./skeletons.js";

// Whether this device uses the zoomed-out mobile viewport (mirrors map.ts).
function isTouchViewport(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

// Self death state. The authoritative copy lives on the game server
// (accounts.is_dead); these flags only drive local UI locks and popups.
let selfDead = false;
let selfGhost = false;

// Revive-offer tracking: the server sends the corpse position with the offer
// so the popup can hide itself once the ghost leaves the zone. The hide band
// is wider than the server's 100px offer radius (hysteresis) so small
// client/server position desync at the boundary can't flap the popup.
const REVIVE_OFFER_HIDE_RADIUS = 120;
let reviveOfferPos: { map: string; x: number; y: number } | null = null;

// Corpse awaiting release: nothing allowed (no move/talk/interact/mount/cast).
export function isSelfDead(): boolean {
  return selfDead;
}

// Ghost: movement only.
export function isSelfGhost(): boolean {
  return selfGhost;
}

export function isSelfMovementLocked(): boolean {
  // Ghosts walk, except during the release cinematic's fade.
  return selfDead || cinematic !== null;
}

export function isSelfActionLocked(): boolean {
  return selfDead || selfGhost;
}

function syncSelfPlayerFlags(): void {
  const cache = Cache.getInstance();
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  if (self) {
    self.isDead = selfDead;
    self.isGhost = selfGhost;
  }
}

// The world turns grey while dead or haunting as a ghost (blur is
// desktop-only: fullscreen CSS blur tanks mobile GPUs). Applies to the main
// canvas and the above-player layer; the ghost layer stays unfiltered.
function syncGreyscale(): void {
  const filter = !(selfDead || selfGhost)
    ? ""
    : isTouchViewport()
      ? "grayscale(1)"
      : "grayscale(1) blur(0.5px) sepia(0.4) hue-rotate(185deg) saturate(2.2)";
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  if (canvas) canvas.style.filter = filter;
  const above = document.getElementById("game-above") as HTMLCanvasElement | null;
  if (above) above.style.filter = filter;
  syncWisps();
}

export function setSelfDead(dead: boolean): void {
  selfDead = dead;
  if (dead) {
    selfGhost = false;
    reviveOfferPos = null;
    hideReviveOfferPopup();
    showReleasePopup();
  } else {
    hideReleasePopup();
  }
  syncSelfPlayerFlags();
  syncGreyscale();
}

export function setSelfGhost(ghost: boolean): void {
  selfGhost = ghost;
  if (ghost) {
    selfDead = false;
    hideReleasePopup();
  }
  syncSelfPlayerFlags();
  syncGreyscale();
}

// Revived (or admin-respawned): everything unlocked, popups gone.
export function clearSelfDeath(): void {
  selfDead = false;
  selfGhost = false;
  reviveOfferPos = null;
  graveyardOfferAt = 0;
  graveyardOfferArmed = false;
  graveyardOfferSuppressed = false;
  graveyardAnchor = null;
  clearCorpseMarker();
  hideReleasePopup();
  hideReviveOfferPopup();
  hideGraveyardOfferPopup();
  syncSelfPlayerFlags();
  syncGreyscale();
}

// Corpse marker: guides the ghost back to the body. Fed by the server
// (PLAYER_DIED / spawn snapshot) and outlives the 15-minute skeleton, which
// shares its coordinates. Only shown while a ghost on the same map.
let corpseMarker: { map: string; x: number; y: number } | null = null;

export function setCorpseMarker(map: string, x: number, y: number): void {
  if (!map || !Number.isFinite(x) || !Number.isFinite(y)) return;
  corpseMarker = { map, x: Math.round(x), y: Math.round(y) };
}

export function clearCorpseMarker(): void {
  corpseMarker = null;
}

function activeDeathTarget(): { map: string; x: number; y: number } | null {  if (!isSelfGhost()) return null;
  const cache = Cache.getInstance();
  const map = (window as any).mapData?.name || "";
  if (!map) return null;
  // Current corpse (DB-backed, survives skeleton expiry) wins: stale
  // skeletons from older deaths may still be on the ground.
  if (corpseMarker && corpseMarker.map === map) return corpseMarker;
  // Fallback: the live skeleton for your own death, if any.
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const username = self?.username ? String(self.username).toLowerCase() : "";
  if (username) {
    const now = Date.now();
    const skel = (cache.skeletons || []).find((s: any) =>
      s.map === map &&
      s.expiresAt > now &&
      s.username && String(s.username).toLowerCase() === username
    );
    if (skel) return { map: skel.map, x: skel.x, y: skel.y };
  }
  return null;
}

// Own corpse position for the minimap (null unless a ghost with a known
// corpse/skeleton on the current map).
export function getCorpseMarkerTarget(): { map: string; x: number; y: number } | null {
  return activeDeathTarget();
}

// Corpse marker lives in unfiltered DOM layers (above the greyscaled world
// canvas) so its red stays red. One per-frame tick shows either the in-world
// marker or the screen-edge indicator, never both.
const MARKER_EDGE_MARGIN = 44;

function hideCorpseMarkerDom(): void {
  document.getElementById("corpse-edge")?.remove();
}

// Client-only corpse skeleton: if no live server skeleton sits at the death
// spot (expired, or the server restarted and lost them), leave a local one so
// the ground marker, hover, and tap all keep working. Never sent anywhere.
const CORPSE_SKELETON_ID = "corpse-skeleton";
const CORPSE_SKELETON_MATCH_PX = 12;

function ensureCorpseSkeleton(m: { map: string; x: number; y: number } | null): void {
  const cache = Cache.getInstance();
  const list = cache.skeletons || [];
  const localIdx = list.findIndex((s: any) => String(s.id) === CORPSE_SKELETON_ID);
  if (!m) {
    if (localIdx !== -1) {
      cache.skeletons = list.filter((s: any) => String(s.id) !== CORPSE_SKELETON_ID);
    }
    return;
  }
  const now = Date.now();
  const hasLive = list.some((s: any) =>
    String(s.id) !== CORPSE_SKELETON_ID &&
    s.map === m.map &&
    s.expiresAt > now &&
    Math.abs(s.x - m.x) <= CORPSE_SKELETON_MATCH_PX &&
    Math.abs(s.y - m.y) <= CORPSE_SKELETON_MATCH_PX
  );
  if (hasLive) {
    if (localIdx !== -1) {
      cache.skeletons = list.filter((s: any) => String(s.id) !== CORPSE_SKELETON_ID);
    }
    return;
  }
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const entry = {
    id: CORPSE_SKELETON_ID,
    username: self?.username || "",
    map: m.map,
    x: m.x,
    y: m.y,
    createdAt: now,
    expiresAt: now + SKELETON_TTL_MS,
    local: true,
  };
  if (localIdx !== -1) {
    cache.skeletons[localIdx] = entry;
  } else {
    cache.skeletons = [...list, entry];
  }
}

function corpseScreenCss(m: { x: number; y: number }): { x: number; y: number } | null {
  const view = getScreenView();
  if (!view) return null;
  const pos = worldToScreenCss(m.x, m.y, view);
  return { x: pos.x, y: pos.y - 10 };
}

export function tickCorpseMarker(): void {
  const m = activeDeathTarget();
  ensureCorpseSkeleton(m);
  if (!m) {
    hideCorpseMarkerDom();
    return;
  }
  const pos = corpseScreenCss(m);
  if (!pos) {
    hideCorpseMarkerDom();
    return;
  }
  const offscreen =
    pos.x < MARKER_EDGE_MARGIN || pos.x > window.innerWidth - MARKER_EDGE_MARGIN ||
    pos.y < MARKER_EDGE_MARGIN || pos.y > window.innerHeight - MARKER_EDGE_MARGIN;
  if (offscreen) {
    updateCorpseEdge(m, pos);
  } else {
    // On screen the ground skeleton itself (server or local backfill) marks
    // the spot: no separate DOM marker, so there is ever only one skeleton
    // and nothing paints above the UI layer.
    document.getElementById("corpse-edge")?.remove();
  }
}

function updateCorpseEdge(m: { x: number; y: number }, pos: { x: number; y: number }): void {
  const cache = Cache.getInstance();
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const worldDist = self?.position ? Math.hypot(m.x - self.position.x, m.y - self.position.y) : 0;

  const halfW = window.innerWidth / 2;
  const halfH = window.innerHeight / 2;
  let dx = pos.x - halfW;
  let dy = pos.y - halfH;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const margin = MARKER_EDGE_MARGIN;
  const tx = dx !== 0 ? (halfW - margin) / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? (halfH - margin) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const ax = halfW + dx * t;
  const ay = halfH + dy * t;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  let el = document.getElementById("corpse-edge");
  if (!el) {
    el = document.createElement("div");
    el.id = "corpse-edge";
    el.innerHTML = `<div class="corpse-edge-arrow"></div><div class="corpse-edge-dist"></div>`;
    document.body.appendChild(el);
  }
  // Skip DOM writes when nothing visible changed (per-frame style writes
  // force layout work, which matters on mobile GPUs).
  const rx = Math.round(ax);
  const ry = Math.round(ay);
  const ra = Math.round(angleDeg);
  const label = `${Math.round(worldDist)}m`;
  const distEl = el.lastChild as HTMLElement | null;
  if (
    (el as any)._edgeKey === `${rx}:${ry}:${ra}` &&
    distEl?.textContent === label
  ) {
    return;
  }
  (el as any)._edgeKey = `${rx}:${ry}:${ra}`;
  el.style.cssText =
    "position:fixed;left:0;top:0;pointer-events:none;z-index:600;text-align:center;" +
    `transform:translate(${rx}px, ${ry}px) translate(-50%, -50%);`;
  const arrow = el.firstChild as HTMLElement | null;
  if (arrow) {
    arrow.style.cssText =
      "width:0;height:0;margin:0 auto;" +
      "border-top:10px solid transparent;border-bottom:10px solid transparent;border-left:18px solid #ff4646;" +
      `transform:rotate(${ra}deg);` +
      "filter:drop-shadow(0 0 6px rgba(255,40,40,0.9));";
  }
  if (distEl) {
    distEl.textContent = label;
    distEl.style.cssText =
      "margin-top:4px;font:bold 12px 'Comic Relief',sans-serif;color:#FFD9D9;" +
      "text-shadow:1px 1px 2px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000;";
  }
}

export function showReleasePopup(): void {
  if (document.getElementById("death-popup")) return;
  const popup = document.createElement("div");
  popup.id = "death-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>You have died</h2>
    <p>Release your spirit to return to the graveyard.</p>
    <div class="button-container">
      <button id="release-spirit">Release Spirit</button>
    </div>
  `;
  document.body.appendChild(popup);
  document.getElementById("release-spirit")?.addEventListener("click", () => {
    beginReleaseCinematic();
  });
}

export function hideReleasePopup(): void {
  document.getElementById("death-popup")?.remove();
}

export function showReviveOfferPopup(data?: any): void {
  // Server verdict on a confirm: revoked hides a stale popup. The popup only
  // ever hides on this verdict, on REVIVE, or on leaving the zone below.
  if (data && (data as any).revoked) {
    reviveOfferPos = null;
    hideReviveOfferPopup();
    return;
  }
  if (!isSelfGhost()) return;
  if (typeof data?.x === "number" && typeof data?.y === "number") {
    reviveOfferPos = {
      map: (window as any).mapData?.name || "",
      x: Math.round(data.x),
      y: Math.round(data.y),
    };
  }
  if (document.getElementById("revive-popup")) return;
  const popup = document.createElement("div");
  popup.id = "revive-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Your body lies nearby</h2>
    <p>Return to your body to revive with half health.</p>
    <div class="button-container">
      <button id="confirm-revive">Revive</button>
    </div>
  `;
  document.body.appendChild(popup);
  document.getElementById("confirm-revive")?.addEventListener("click", () => {
    sendRequest({ type: "CONFIRM_REVIVE", data: null });
    // Stays up until the server confirms with REVIVE.
  });
}

export function hideReviveOfferPopup(): void {
  document.getElementById("revive-popup")?.remove();
}

// Graveyard resurrection offer: 5s after the release cinematic ends, a ghost
// near a graveyard may resurrect on the spot at the price of 15-min
// Resurrection Sickness (-20% health, -10% all other stats) instead of
// walking back to the corpse. Gated on real proximity (with hysteresis, like
// the corpse offer) so it never pops up mid corpse-run.
let graveyardOfferAt = 0;
let graveyardOfferArmed = false;
// Cancel only snoozes the offer: leaving the graveyard area re-arms it, so
// walking back in shows it again (mirrors the corpse offer's re-arm).
let graveyardOfferSuppressed = false;
let graveyardAnchor: { map: string; x: number; y: number } | null = null;
const GRAVEYARD_OFFER_DELAY_MS = 5000;
const GRAVEYARD_OFFER_RADIUS = 150;
const GRAVEYARD_OFFER_HIDE_RADIUS = 200;

export function scheduleGraveyardOffer(delayMs: number = GRAVEYARD_OFFER_DELAY_MS): void {
  graveyardOfferSuppressed = false;
  graveyardOfferArmed = false;
  graveyardOfferAt = performance.now() + delayMs;
}

// Distance to the nearest graveyard on the current map, or null when it
// can't be determined. Candidates are the map's graveyard metadata plus the
// recorded teleport landing spot (covers maps without metadata).
function distToGraveyard(): number | null {
  const cache = Cache.getInstance();
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const map = (window as any).mapData?.name || "";
  if (!self?.position || !map) return null;
  let best: number | null = null;
  const consider = (x: unknown, y: unknown) => {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    const d = Math.hypot(self.position.x - nx, self.position.y - ny);
    if (best === null || d < best) best = d;
  };
  const gy = (window as any).mapData?.graveyards;
  if (gy) {
    const entries = Array.isArray(gy) ? gy : Object.values(gy);
    for (const g of entries as any[]) {
      consider(g?.position?.x ?? g?.x, g?.position?.y ?? g?.y);
    }
  }
  if (graveyardAnchor && graveyardAnchor.map === map) {
    consider(graveyardAnchor.x, graveyardAnchor.y);
  }
  return best;
}

export function tickGraveyardOffer(): void {
  if (!isSelfGhost()) return;
  if (!graveyardOfferArmed) {
    if (!graveyardOfferAt || performance.now() < graveyardOfferAt) return;
    graveyardOfferArmed = true;
  }
  const popup = document.getElementById("graveyard-resurrect-popup");
  const dist = distToGraveyard();
  const far = dist === null || dist > GRAVEYARD_OFFER_HIDE_RADIUS;
  if (far) {
    // Outside the area: hide an open popup and lift any Cancel snooze, so
    // re-entering the graveyard shows the offer again.
    graveyardOfferSuppressed = false;
    if (popup) hideGraveyardOfferPopup();
    return;
  }
  if (popup || graveyardOfferSuppressed) return;
  if (dist <= GRAVEYARD_OFFER_RADIUS) {
    showGraveyardOfferPopup();
  }
}

export function showGraveyardOfferPopup(): void {
  if (!isSelfGhost()) return;
  if (document.getElementById("graveyard-resurrect-popup")) return;
  const popup = document.createElement("div");
  popup.id = "graveyard-resurrect-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Resurrect here?</h2>
    <p>Return to life at the graveyard now, but suffer Resurrection Sickness for 15 minutes: -20% health, -10% all other stats.</p>
    <div class="button-container">
      <button id="confirm-graveyard-revive">Resurrect</button>
      <button id="decline-graveyard-revive">Cancel</button>
    </div>
  `;
  document.body.appendChild(popup);
  document.getElementById("confirm-graveyard-revive")?.addEventListener("click", () => {
    sendRequest({ type: "CONFIRM_GRAVEYARD_REVIVE", data: null });
    // Stays up until the server confirms with REVIVE.
  });
  document.getElementById("decline-graveyard-revive")?.addEventListener("click", () => {
    // Snooze until the ghost leaves the graveyard area; coming back
    // re-shows the offer.
    graveyardOfferSuppressed = true;
    hideGraveyardOfferPopup();
  });
}

export function hideGraveyardOfferPopup(): void {
  document.getElementById("graveyard-resurrect-popup")?.remove();
}

// Release cinematic: hide popup and corpse, a clean blue orb rises from the
// body, fade to black, server teleport lands mid-black (+3s), fade back out
// at the graveyard. Total 5s; movement stays locked throughout.
interface ReleaseCinematic {
  start: number;
  fromX: number;
  fromY: number;
  map: string;
  destX: number | null;
  destY: number | null;
}

let cinematic: ReleaseCinematic | null = null;
const CINEMATIC_MS = 5000;
const ORB_MS = 2500;
const ORB_RISE_PX = 130;
const FADE_IN_START = 1500;
const FADE_FULL_AT = 2500;
const FADE_OUT_START = 3500;

function ensureFadeOverlay(): HTMLElement | null {
  let overlay = document.getElementById("release-fade");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "release-fade";
    document.body.appendChild(overlay);
  }
  return overlay;
}

export function beginReleaseCinematic(): void {
  if (cinematic) return;
  const cache = Cache.getInstance();
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  cinematic = {
    start: performance.now(),
    fromX: Math.round(self?.position?.x ?? 0),
    fromY: Math.round(self?.position?.y ?? 0),
    map: (window as any).mapData?.name || "",
    destX: null,
    destY: null,
  };
  hideReleasePopup();
  const overlay = ensureFadeOverlay();
  if (overlay) overlay.style.opacity = "0";
  sendRequest({ type: "RELEASE_SPIRIT", data: null });
}

// Destination arrives with PLAYER_GHOST: warm the graveyard chunks while dark.
export function noteGhostDestination(data: any): void {
  if (!cinematic || !data || typeof data.x !== "number" || typeof data.y !== "number") return;
  if (typeof data.map === "string" && data.map !== cinematic.map) return;
  cinematic.destX = Math.round(data.x);
  cinematic.destY = Math.round(data.y);
  preloadGraveyardChunks(cinematic);
}

function preloadGraveyardChunks(cine: ReleaseCinematic): void {
  if (cine.destX === null || cine.destY === null) return;
  const md = (window as any).mapData;
  if (!md || md.name !== cine.map) return;
  const requestChunk = md.requestChunk;
  if (typeof requestChunk !== "function") return;
  const px = (md.chunkSize || 32) * (md.tilewidth || 32);
  if (!px) return;
  const cx = Math.floor(cine.destX / px);
  const cy = Math.floor(cine.destY / px);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      try {
        const result = requestChunk.call(md, cx + dx, cy + dy);
        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
      } catch {
        // Preloading is best-effort; the normal chunk flow covers misses.
      }
    }
  }
}

export function isReleaseCinematic(): boolean {
  return cinematic !== null;
}

// Death ambience: blue dust motes and slow wisps drifting across the whole
// screen while dead or ghost. Own canvas layer (unfiltered) above the world.
interface WispParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
  speed: number;
  alpha: number;
  hue: number;
}

let wispParticles: WispParticle[] = [];
let lastWispTick = 0;

function syncWisps(): void {
  const active = selfDead || selfGhost;
  let layer = document.getElementById("death-wisps") as HTMLCanvasElement | null;
  if (active && !layer) {
    layer = document.createElement("canvas");
    layer.id = "death-wisps";
    layer.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:50;";
    document.body.appendChild(layer);
    wispParticles = [];
  } else if (!active && layer) {
    layer.remove();
    wispParticles = [];
  }
}

export function tickDeathWisps(): void {
  const layer = document.getElementById("death-wisps") as HTMLCanvasElement | null;
  if (!layer || (!selfDead && !selfGhost)) return;
  const now = performance.now();
  const dt = Math.min(Math.max((now - lastWispTick) / 1000, 0.001), 0.1);
  lastWispTick = now;
  const camX = (window as any).cameraX;
  const camY = (window as any).cameraY;
  if (!Number.isFinite(camX) || !Number.isFinite(camY)) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (layer.width !== w || layer.height !== h) {
    layer.width = w;
    layer.height = h;
  }
  const ctx = layer.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // World-anchored bounds (viewport + margin), like the weather layer: motes
  // keep world positions so they slide past correctly as the camera moves.
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height || window.innerHeight;
  const margin = 120;
  const x0 = camX - vw / 2 - margin;
  const x1 = camX + vw / 2 + margin;
  const y0 = camY - vh / 2 - margin;
  const y1 = camY + vh / 2 + margin;

  const nowSec = now / 1000;
  const targetDust = Math.round(Math.min(70, ((x1 - x0) * (y1 - y0)) / 22000));
  while (wispParticles.length < targetDust) {
    wispParticles.push({
      x: x0 + Math.random() * (x1 - x0),
      y: y0 + Math.random() * (y1 - y0),
      vx: (Math.random() - 0.5) * 6,
      vy: -(8 + Math.random() * 16),
      size: 1 + Math.random() * 2.2,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 0.9,
      alpha: 0.15 + Math.random() * 0.35,
      hue: 205 + Math.random() * 15,
    });
  }
  if (wispParticles.length > targetDust) {
    wispParticles.length = targetDust;
  }

  for (const p of wispParticles) {
    p.x += (p.vx + Math.sin(nowSec * p.speed + p.phase) * 8) * dt;
    p.y += p.vy * dt;
    if (p.y < y0) {
      p.y = y1;
      p.x = x0 + Math.random() * (x1 - x0);
    }
    if (p.x < x0) p.x = x1;
    else if (p.x > x1) p.x = x0;
    const twinkle = 0.6 + 0.4 * Math.sin(nowSec * p.speed * 2 + p.phase);
    const a = Math.max(0, Math.min(1, p.alpha * twinkle));
    if (a <= 0.01) continue;
    const sx = (p.x - camX + vw / 2) * dpr;
    const sy = (p.y - camY + vh / 2) * dpr;
    if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue;
    ctx.fillStyle = `hsla(${p.hue}, 90%, 78%, ${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, p.size * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// The releaser's body stays hidden until just after the server teleport
// lands (+3s), so it reappears at the graveyard before the fade lifts.
const TELEPORT_VISIBLE_AT = 3200;
export function isReleaseHidden(): boolean {
  if (!cinematic) return false;
  return performance.now() - cinematic.start < TELEPORT_VISIBLE_AT;
}

export function tickReleaseCinematic(): void {
  if (!cinematic) return;
  updateReleaseOrb();
  const elapsed = performance.now() - cinematic.start;
  const overlay = document.getElementById("release-fade");
  if (overlay) {
    let opacity = 0;
    if (elapsed >= FADE_IN_START && elapsed < FADE_FULL_AT) {
      opacity = (elapsed - FADE_IN_START) / (FADE_FULL_AT - FADE_IN_START);
    } else if (elapsed >= FADE_FULL_AT && elapsed < FADE_OUT_START) {
      opacity = 1;
    } else if (elapsed >= FADE_OUT_START && elapsed < CINEMATIC_MS) {
      opacity = 1 - (elapsed - FADE_OUT_START) / (CINEMATIC_MS - FADE_OUT_START);
    }
    overlay.style.opacity = String(Math.max(0, Math.min(1, opacity)));
  }
  if (elapsed >= CINEMATIC_MS) {
    cinematic = null;
    document.getElementById("release-fade")?.remove();
    removeReleaseFx();
    // Record the teleport landing spot as a graveyard anchor (movement is
    // still locked, so this is exactly the graveyard), then arm the offer.
    const cache = Cache.getInstance();
    const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
    const map = (window as any).mapData?.name || "";
    graveyardAnchor =
      self?.position && map
        ? { map, x: Math.round(self.position.x), y: Math.round(self.position.y) }
        : null;
    // The graveyard offer lands 5s after the cinematic, not with it.
    scheduleGraveyardOffer();
  }
}

// The orb lives in a DOM layer above the (greyscaled) world canvas so it
// keeps its blue color. Positioned from the renderer's camera each tick.
function removeReleaseFx(): void {
  document.getElementById("release-orb")?.remove();
}

function updateReleaseOrb(): void {
  if (!cinematic) return;
  const existing = document.getElementById("release-orb");
  const elapsed = performance.now() - cinematic.start;
  const sameMap = cinematic.map === ((window as any).mapData?.name || "");
  const camX = (window as any).cameraX;
  const camY = (window as any).cameraY;
  if (elapsed < 0 || elapsed > ORB_MS || !sameMap || !Number.isFinite(camX) || !Number.isFinite(camY)) {
    existing?.remove();
    return;
  }
  // Slow ease-out ascent with a barely-there drift.
  const progress = elapsed / ORB_MS;
  const rise = ORB_RISE_PX * (1 - (1 - progress) * (1 - progress));
  const sway = Math.sin(progress * Math.PI) * 5;
  const radius = 24 * (1 - progress * 0.35);
  const alpha = Math.max(0, 1 - progress * progress);
  const worldX = cinematic.fromX + sway;
  const worldY = cinematic.fromY - 20 - rise;

  const view = getScreenView();
  if (!view) {
    existing?.remove();
    return;
  }
  const { x: screenX, y: screenY } = worldToScreenCss(worldX, worldY, view);

  let orb = existing;
  if (!orb) {
    orb = document.createElement("div");
    orb.id = "release-orb";
    orb.style.cssText =
      "position:fixed;left:0;top:0;border-radius:50%;pointer-events:none;z-index:600;" +
      "background:radial-gradient(circle, rgba(240,248,255,0.95) 0%, rgba(170,210,255,0.75) 30%, rgba(100,160,255,0.35) 55%, rgba(80,140,255,0) 72%);";
    document.body.appendChild(orb);
  }
  const diameter = Math.max(1, Math.round(radius * 3.6));
  orb.style.width = `${diameter}px`;
  orb.style.height = `${diameter}px`;
  orb.style.opacity = String(alpha);
  orb.style.transform = `translate(${Math.round(screenX)}px, ${Math.round(screenY)}px) translate(-50%, -50%)`;
}

// Per-frame hook (throttled): hide the revive offer once the ghost leaves
// the revival zone. Re-entering re-offers from the server (it re-arms past
// the radius).
let lastOfferTick = 0;
const OFFER_TICK_MS = 100;
export function tickDeathOffer(): void {
  const now = performance.now();
  if (now - lastOfferTick < OFFER_TICK_MS) return;
  lastOfferTick = now;
  if (!document.getElementById("revive-popup")) return;
  if (!isSelfGhost()) {
    reviveOfferPos = null;
    hideReviveOfferPopup();
    return;
  }
  if (!reviveOfferPos) return;
  const cache = Cache.getInstance();
  const self = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId);
  const map = (window as any).mapData?.name || "";
  if (!self?.position || map !== reviveOfferPos.map) {
    reviveOfferPos = null;
    hideReviveOfferPopup();
    return;
  }
  const dx = self.position.x - reviveOfferPos.x;
  const dy = self.position.y - reviveOfferPos.y;
  if (dx * dx + dy * dy > REVIVE_OFFER_HIDE_RADIUS * REVIVE_OFFER_HIDE_RADIUS) {
    reviveOfferPos = null;
    hideReviveOfferPopup();
  }
}
