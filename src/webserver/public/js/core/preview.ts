import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import { initializeLayeredAnimation, updateLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";

// Character sheet player preview: a dedicated idle LayeredAnimation built
// from the current player's spriteData (live equipment), drawn onto
// #stat-screen-preview while the sheet is open. A separate instance is used
// so the in-world animation state is never disturbed.
const PREVIEW_SCALE = 2;

let rafId: number | null = null;
let previewAnim: any = null;
// Rebuild key: spriteData reference (self) or live animation reference (other).
let previewKey: any = null;
let previewSubject: { kind: "self" } | { kind: "other"; id: string } | null = null;
let buildInFlight = false;
let buildToken = 0;
let lastFrameTime = 0;

function getCanvas(): HTMLCanvasElement | null {
  return document.getElementById("stat-screen-preview") as HTMLCanvasElement | null;
}

function isSheetOpen(): boolean {
  return document.getElementById("stat-screen")?.style.display === "block";
}

function currentSpriteData(): any | null {
  const cache = Cache.getInstance();
  const me = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId) as any;
  return me?.spriteData ?? null;
}

function findPlayer(id: string): any | null {
  const cache = Cache.getInstance();
  return (Array.from(cache.players).find((p: any) => String(p.id) === String(id)) as any) ?? null;
}

// Sprite templates backing a live animation (already cached), so building an
// idle preview for another player reuses loaded art with no downloads.
function templatesFromLiveAnim(live: any): any | null {
  if (!live?.layers) return null;
  const L = live.layers;
  return {
    bodySprite: L.body?.spriteSheet ?? null,
    headSprite: L.head?.spriteSheet ?? null,
    armorHelmetSprite: L.armor_helmet?.spriteSheet ?? null,
    armorShoulderguardsSprite: L.armor_shoulderguards?.spriteSheet ?? null,
    armorNeckSprite: L.armor_neck?.spriteSheet ?? null,
    armorHandsSprite: L.armor_hands?.spriteSheet ?? null,
    armorChestSprite: L.armor_chest?.spriteSheet ?? null,
    armorFeetSprite: L.armor_feet?.spriteSheet ?? null,
    armorLegsSprite: L.armor_legs?.spriteSheet ?? null,
    armorWeaponSprite: L.armor_weapon?.spriteSheet ?? null,
  };
}

async function rebuild(spriteData: any, key: any): Promise<void> {
  const token = ++buildToken;
  try {
    const anim = await (initializeLayeredAnimation as any)(
      null, // never show the mount in the sheet - character only
      spriteData.bodySprite || null,
      spriteData.headSprite || null,
      spriteData.armorHelmetSprite || null,
      spriteData.armorShoulderguardsSprite || null,
      spriteData.armorNeckSprite || null,
      spriteData.armorHandsSprite || null,
      spriteData.armorChestSprite || null,
      spriteData.armorFeetSprite || null,
      spriteData.armorLegsSprite || null,
      spriteData.armorWeaponSprite || null,
      "idle"
    );
    buildInFlight = false;
    if (token !== buildToken || rafId === null) return;
    previewAnim = anim;
    previewKey = key;
  } catch (e) {
    buildInFlight = false;
    console.error("Error building stat preview animation:", e);
  }
}

function drawPreview(): void {
  const canvas = getCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!previewAnim) return;

  ctx.imageSmoothingEnabled = false;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  const layers = getVisibleLayersSorted(previewAnim);
  for (const layer of layers) {
    if (!layer || layer.frames.length === 0) continue;
    const frame = layer.frames[layer.currentFrame];
    if (!frame || !frame.imageElement?.complete) continue;
    const w = frame.width || 64;
    const h = frame.height || 64;
    const ox = (frame.offset?.x || 0) * PREVIEW_SCALE;
    const oy = (frame.offset?.y || 0) * PREVIEW_SCALE;
    ctx.drawImage(
      frame.imageElement,
      Math.round(cx - (w * PREVIEW_SCALE) / 2 + ox),
      Math.round(cy - (h * PREVIEW_SCALE) / 2 + oy),
      w * PREVIEW_SCALE,
      h * PREVIEW_SCALE
    );
  }
}

function tick(now: number): void {
  if (!isSheetOpen() || !previewSubject) {
    stopStatPreview();
    return;
  }
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  // Resolve the rebuild key + sprite source for the inspected subject. Self
  // keys on spriteData (refreshed by noteSelfSpritesChanged); others key on
  // their live animation object, which the server replaces on gear changes.
  let key: any;
  let spriteData: any;
  if (previewSubject.kind === "self") {
    spriteData = currentSpriteData();
    key = spriteData;
  } else {
    const target = findPlayer(previewSubject.id);
    const live = target?.layeredAnimation ?? null;
    key = live;
    spriteData = live ? templatesFromLiveAnim(live) : null;
  }

  if (!key || !spriteData) {
    previewAnim = null;
    previewKey = null;
  } else if (key !== previewKey && !buildInFlight) {
    previewAnim = null;
    buildInFlight = true;
    void rebuild(spriteData, key);
  } else if (previewAnim) {
    updateLayeredAnimation(previewAnim, dt);
  }

  drawPreview();
  rafId = requestAnimationFrame(tick);
}

export function startStatPreview(inspectedId: string): void {
  previewSubject = String(inspectedId) === String(cachedPlayerId)
    ? { kind: "self" }
    : { kind: "other", id: String(inspectedId) };
  if (rafId !== null) {
    // Sheet already open (e.g. inspecting someone else): drop the old build
    // so the loop rebuilds for the new subject immediately.
    previewAnim = null;
    previewKey = null;
    buildToken++;
    return;
  }
  previewAnim = null;
  previewKey = null;
  buildInFlight = false;
  buildToken++;
  lastFrameTime = performance.now();
  rafId = requestAnimationFrame(tick);
}

export function stopStatPreview(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  buildToken++;
  previewAnim = null;
  previewKey = null;
  previewSubject = null;
  const canvas = getCanvas();
  if (canvas) {
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
}

const SPRITE_FIELDS = [
  "bodySprite",
  "headSprite",
  "armorHelmetSprite",
  "armorShoulderguardsSprite",
  "armorNeckSprite",
  "armorHandsSprite",
  "armorChestSprite",
  "armorFeetSprite",
  "armorLegsSprite",
  "armorWeaponSprite",
] as const;

// Called when SPRITE_SHEET_ANIMATION(_BATCH) arrives for the local player.
// Equip/unequip/mount changes arrive this way, not via PLAYER packets, so
// without this the preview (and player.spriteData) would go stale. Merges
// into a fresh object so the loop's reference check triggers a rebuild.
export function noteSelfSpritesChanged(sprites: any): void {
  if (!sprites) return;
  const cache = Cache.getInstance();
  const me = Array.from(cache.players).find((p: any) => p.id === cachedPlayerId) as any;
  if (!me) return;
  // Compare by sprite name, not reference: every movement packet carries
  // freshly-deserialized (content-identical) objects, and a reference check
  // would rebuild the preview on every step.
  const keyOf = (s: any) => (s == null ? null : (typeof s === "object" ? (s.name ?? JSON.stringify(s)) : s));
  const merged: any = { ...(me.spriteData || {}) };
  let changed = false;
  for (const f of SPRITE_FIELDS) {
    if (f in sprites && keyOf(sprites[f]) !== keyOf(merged[f])) {
      merged[f] = sprites[f] ?? null;
      changed = true;
    }
  }
  if (changed) me.spriteData = merged;
}
