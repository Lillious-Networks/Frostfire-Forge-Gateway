import Cache from "./cache.js";
import { config } from "../web/global.js";
import { getCachedImage } from "./images.js";

// Death skeletons are fully server-authoritative: the game server spawns a
// marker where a player dies, sends LOAD_SKELETONS (AOI-filtered) on login,
// broadcasts ADD_SKELETON on death and REMOVE_SKELETON on expiry. This module
// only renders the "skeleton.png" sprite from the asset server's sprites
// folder on the ground. It never creates markers itself.
export const SKELETON_ICON_NAME = "skeleton";
export const SKELETON_TTL_MS = 15 * 60 * 1000;

const MAX_DRAW_SIZE = 56;
const FADE_OUT_MS = 60 * 1000;
const HOVER_RADIUS = 34;
const TAP_RADIUS = 46;
const TAP_LABEL_MS = 3000;
const TAP_MAX_MOVE_PX = 12;
const TAP_MAX_DURATION_MS = 500;

let tapListenerAttached = false;
let tapStartX = 0;
let tapStartY = 0;
let tapStartTime = 0;
let tappedId: number | string | null = null;
let tappedAt = 0;

export interface GroundSkeleton {
  id: number | string;
  username: string;
  map: string;
  x: number;
  y: number;
  createdAt: number;
  expiresAt: number;
}

export function getSkeletonSpriteUrl(): string {
  const base = (window as any).__assetServerUrl || config.ASSET_SERVER_URL;
  return `${base}/icon?name=${encodeURIComponent(SKELETON_ICON_NAME)}`;
}

function currentMap(): string {
  return (window as any).mapData?.name || "";
}

function normalizeSkeleton(row: any): GroundSkeleton | null {
  if (!row) return null;
  const x = Number(row.x);
  const y = Number(row.y);
  const createdAt = Number(row.createdAt ?? row.created_at ?? Date.now());
  const expiresAt = Number(row.expiresAt ?? row.expires_at ?? createdAt + SKELETON_TTL_MS);
  if (!row.map || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(expiresAt)) return null;
  return {
    id: row.id ?? `${row.username}:${createdAt}`,
    username: String(row.username ?? ""),
    map: String(row.map),
    x: Math.round(x),
    y: Math.round(y),
    createdAt,
    expiresAt,
  };
}

export function preloadSkeletonImage(): void {
  getCachedImage(getSkeletonSpriteUrl());
}

export function pruneExpiredSkeletons(now: number = Date.now()): void {
  const cache = Cache.getInstance();
  if (!cache.skeletons || cache.skeletons.length === 0) return;
  cache.skeletons = cache.skeletons.filter((s: GroundSkeleton) => s.expiresAt > now);
}

export function clearSkeletons(): void {
  Cache.getInstance().skeletons = [];
}

// Full snapshot from LOAD_SKELETONS (already AOI-filtered by the server).
export function setSkeletons(rows: any[]): void {
  const now = Date.now();
  const list: GroundSkeleton[] = [];
  for (const row of rows || []) {
    const s = normalizeSkeleton(row);
    if (s && s.expiresAt > now) list.push(s);
  }
  Cache.getInstance().skeletons = list;
  if (list.length > 0) preloadSkeletonImage();
}

// Single marker from ADD_SKELETON. Ignores other maps (map changes clear).
export function addSkeleton(row: any): void {
  const s = normalizeSkeleton(row);
  if (!s || s.map !== currentMap()) return;
  const cache = Cache.getInstance();
  const existing = (cache.skeletons || []).findIndex(
    (e: GroundSkeleton) => String(e.id) === String(s.id)
  );
  if (existing !== -1) {
    cache.skeletons[existing] = s;
  } else {
    cache.skeletons = [...(cache.skeletons || []), s];
  }
  preloadSkeletonImage();
}

export function removeSkeleton(id: number | string): void {
  const cache = Cache.getInstance();
  if (!cache.skeletons || cache.skeletons.length === 0) return;
  cache.skeletons = cache.skeletons.filter((s: GroundSkeleton) => String(s.id) !== String(id));
  if (tappedId !== null && String(tappedId) === String(id)) tappedId = null;
}

function findSkeletonAt(worldX: number, worldY: number, radius: number): GroundSkeleton | null {
  const cache = Cache.getInstance();
  const skeletons = cache.skeletons || [];
  if (skeletons.length === 0) return null;
  const map = currentMap();
  let best: GroundSkeleton | null = null;
  let bestD2 = radius * radius;
  for (const s of skeletons) {
    if (s.map !== map || s.expiresAt <= Date.now()) continue;
    const dx = worldX - s.x;
    const dy = worldY - (s.y - 10);
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best;
}

function ensureTapListener(): void {
  if (tapListenerAttached) return;
  tapListenerAttached = true;
  const canvas = document.getElementById("game");
  if (!canvas) return;
  // Track the gesture start so drags (joystick movement) and long-presses
  // (context menu) are not mistaken for taps. Passive: never blocks input.
  canvas.addEventListener("touchstart", (e) => {
    const touch = (e as TouchEvent).touches?.[0];
    if (!touch) return;
    tapStartX = touch.clientX;
    tapStartY = touch.clientY;
    tapStartTime = Date.now();
  }, { passive: true });
  canvas.addEventListener("touchend", (e) => {
    void handleSkeletonTap(e as TouchEvent);
  }, { passive: true });
}

async function handleSkeletonTap(e: TouchEvent): Promise<void> {
  if ((window as any).tileEditor?.isActive) return;
  const touch = (e as TouchEvent).changedTouches?.[0];
  if (!touch || (e as TouchEvent).changedTouches.length !== 1) return;
  if (Date.now() - tapStartTime > TAP_MAX_DURATION_MS) return;
  if (Math.abs(touch.clientX - tapStartX) > TAP_MAX_MOVE_PX) return;
  if (Math.abs(touch.clientY - tapStartY) > TAP_MAX_MOVE_PX) return;

  const canvas = document.getElementById("game");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const view = getScreenView();
  if (!view) return;
  const { x: worldX, y: worldY } = screenToWorldCss(touch.clientX - rect.left, touch.clientY - rect.top, view);
  const hit = findSkeletonAt(worldX, worldY, TAP_RADIUS);
  tappedId = hit ? hit.id : null;
  tappedAt = Date.now();
}

function displayName(username: string): string {
  if (!username) return "";
  return username.charAt(0).toUpperCase() + username.slice(1);
}

// World <-> CSS-px projection shared by DOM overlays (orb, corpse marker,
// tap hit-testing). Mirrors the game canvas transform from map.ts loadMap,
// including the 0.85 mobile zoom - without it every overlay lands up to ~15%
// of half-viewport off on touch devices.
export interface ScreenView {
  viewW: number;
  viewH: number;
  zoom: number;
  centerX: number;
  camX: number;
  camY: number;
}

export function getScreenView(): ScreenView | null {
  const camX = (window as any).cameraX;
  const camY = (window as any).cameraY;
  if (!Number.isFinite(camX) || !Number.isFinite(camY)) return null;
  const canvas = document.getElementById("game") as HTMLCanvasElement | null;
  const rawDpr = window.devicePixelRatio || 1;
  const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  const zoom = isTouch ? 0.85 : 1;
  const canvasDpr = isTouch ? Math.min(rawDpr, 2) : rawDpr;
  const viewW = (canvas?.width || window.innerWidth * canvasDpr) / canvasDpr;
  const viewH = (canvas?.height || window.innerHeight * canvasDpr) / canvasDpr;
  const md = (window as any).mapData;
  let centerX = 0;
  if (md && md.width * md.tilewidth < window.innerWidth) {
    centerX = (window.innerWidth - md.width * md.tilewidth) / 2;
  }
  return { viewW, viewH, zoom, centerX, camX, camY };
}

export function worldToScreenCss(worldX: number, worldY: number, v: ScreenView): { x: number; y: number } {
  const tx = v.zoom === 1 ? 0 : (v.viewW * (1 - v.zoom)) / (2 * v.zoom);
  const ty = v.zoom === 1 ? 0 : (v.viewH * (1 - v.zoom)) / (2 * v.zoom);
  return {
    x: (worldX - v.camX + v.viewW / 2 + v.centerX) * v.zoom + tx * v.zoom,
    y: (worldY - v.camY + v.viewH / 2) * v.zoom + ty * v.zoom,
  };
}

export function screenToWorldCss(sx: number, sy: number, v: ScreenView): { x: number; y: number } {
  const tx = v.zoom === 1 ? 0 : (v.viewW * (1 - v.zoom)) / (2 * v.zoom);
  const ty = v.zoom === 1 ? 0 : (v.viewH * (1 - v.zoom)) / (2 * v.zoom);
  return {
    x: (sx - tx * v.zoom) / v.zoom - v.viewW / 2 + v.camX - v.centerX,
    y: (sy - ty * v.zoom) / v.zoom - v.viewH / 2 + v.camY,
  };
}

export function renderSkeletons(ctx: CanvasRenderingContext2D): void {
  const cache = Cache.getInstance();
  const skeletons = cache.skeletons || [];
  if (skeletons.length === 0) return;

  ensureTapListener();
  pruneExpiredSkeletons();
  if (cache.skeletons.length === 0) return;

  const map = currentMap();
  const img = getCachedImage(getSkeletonSpriteUrl());
  if (!img.complete || img.naturalWidth === 0) return;

  const now = Date.now();
  const scale = Math.min(1, MAX_DRAW_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const s of cache.skeletons) {
    if (s.map !== map) continue;
    const remaining = s.expiresAt - now;
    if (remaining <= 0) continue;
    ctx.globalAlpha = remaining < FADE_OUT_MS ? 0.15 + 0.85 * (remaining / FADE_OUT_MS) : 1;

    ctx.drawImage(img, Math.round(s.x - w / 2), Math.round(s.y - h / 2 - 10), w, h);
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // Username label: desktop hover, or the tapped skeleton on mobile.
  let labeled: GroundSkeleton | null = null;
  const mouseX = (window as any).mouseWorldX;
  const mouseY = (window as any).mouseWorldY;
  if (Number.isFinite(mouseX) && Number.isFinite(mouseY)) {
    labeled = findSkeletonAt(mouseX, mouseY, HOVER_RADIUS);
  }
  if (!labeled && tappedId !== null && Date.now() - tappedAt < TAP_LABEL_MS) {
    labeled = cache.skeletons.find((s: GroundSkeleton) => String(s.id) === String(tappedId)) ?? null;
    if (labeled && labeled.map !== map) labeled = null;
  }
  const label = labeled ? displayName(labeled.username) : "";
  if (labeled && label) {
    ctx.save();
    ctx.font = "14px 'Comic Relief'";
    ctx.textAlign = "center";
    ctx.shadowColor = "black";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "black";
    const labelY = Math.round(labeled.y - h / 2 - 10 - 10);
    ctx.strokeText(label, labeled.x, labelY);
    ctx.fillStyle = "white";
    ctx.fillText(label, labeled.x, labelY);
    ctx.restore();
  }
}
