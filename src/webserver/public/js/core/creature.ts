// Client view of server-authoritative creatures. The client never simulates
// creatures; it only renders the snapshots the game server sends.
import { initializeLayeredAnimation, updateLayeredAnimation, changeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";
import { createCachedImage, getCachedImage } from "./images.js";
import { getSkeletonSpriteUrl } from "./skeletons.js";
import { formatDuration } from "./tooltip.js";
import { NUMBER_FONT, fontFor } from "./fonts.js";
import { config } from "../web/global.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();

export interface CreatureView {
  id: number;
  templateId: number;
  name: string;
  subname: string | null;
  level: number;
  rank: "normal" | "elite" | "rare" | "rare_elite" | "boss";
  stance: "aggressive" | "neutral" | "passive";
  creatureType: string;
  health: number;
  maxHealth: number;
  x: number;
  y: number;
  dir: string;
  moving: boolean;
  state: string;
  victimId: string | null;
  /** Tap state for the local player: grey nameplate when "other". */
  tap: "none" | "mine" | "other";
  /** Local player may loot this corpse. */
  lootable: boolean;
  /** Snapshot form from the server; converted to castStart/castEnd on arrival. */
  casting: { spell: string; durationMs: number; remainingMs: number; targetId: string } | null;
  cast: { spell: string; startedAt: number; endsAt: number } | null;
  auras: Array<{ id: string; kind: string; spell?: string; debuff?: boolean; icon?: string | null; remainingMs: number; stacks: number }>;
  aurasAt: number;
  spriteType: "animated" | "static" | "none";
  sprite: string | null;
  spriteLayers: any;
  scale: number;
  // Loaded client-side from spriteLayers.
  anim: any | null;
  staticImage: HTMLImageElement | null;
  // Client-side interpolation between server positions.
  renderX: number;
  renderY: number;
  fromX: number;
  fromY: number;
  lerpStart: number;
}

export const creatures = new Map<number, CreatureView>();

// Server AI ticks every 100ms; interpolate across one tick.
const INTERPOLATION_MS = 100;

/** Client target ids for creatures are prefixed so they never collide with player/NPC ids. */
export const CREATURE_TARGET_PREFIX = "c:";
export const creatureTargetKey = (id: number) => `${CREATURE_TARGET_PREFIX}${id}`;
export function parseCreatureTarget(targetId: unknown): number | null {
  if (typeof targetId !== "string" || !targetId.startsWith(CREATURE_TARGET_PREFIX)) return null;
  const id = Number(targetId.slice(CREATURE_TARGET_PREFIX.length));
  return Number.isFinite(id) ? id : null;
}

/** Live position of a creature by client target key or id, for projectiles and effects. */
export function creaturePositionFor(key: unknown): { x: number; y: number } | null {
  const id = typeof key === "number" ? key : parseCreatureTarget(key);
  if (id === null) return null;
  const c = creatures.get(id);
  return c ? { x: c.renderX, y: c.renderY } : null;
}

/** Creature the local player is auto-attacking, if any. */
let autoAttackingId: number | null = null;
export const getAutoAttackingId = () => autoAttackingId;
export function setAutoAttackingId(id: number | null): void {
  autoAttackingId = id;
}

export function applyCreatureSpawn(data: any): void {
  const list = Array.isArray(data?.creatures) ? data.creatures : [];
  for (const c of list) {
    if (typeof c?.id !== "number") continue;
    const existing = creatures.get(c.id);
    const view = c as CreatureView;
    view.renderX = existing ? existing.renderX : c.x;
    view.renderY = existing ? existing.renderY : c.y;
    view.fromX = view.renderX;
    view.fromY = view.renderY;
    view.lerpStart = performance.now();
    const now = performance.now();
    view.cast = c.casting
      ? { spell: c.casting.spell, startedAt: now - (c.casting.durationMs - c.casting.remainingMs), endsAt: now + c.casting.remainingMs }
      : null;
    view.auras = Array.isArray(c.auras) ? c.auras : [];
    view.aurasAt = now;
    // Keep an already-loaded sprite when the same creature is re-sent.
    const sameSprite = existing && existing.templateId === view.templateId && existing.sprite === view.sprite;
    view.anim = sameSprite ? existing.anim : null;
    view.staticImage = sameSprite ? existing.staticImage : null;
    creatures.set(c.id, view);
    if (!sameSprite) void loadCreatureSprite(view);
  }
}

const spriteFailures = new Set<string>();

async function loadCreatureSprite(c: CreatureView): Promise<void> {
  const layers = c.spriteLayers;
  if (!layers || c.spriteType === "none" || !c.sprite || spriteFailures.has(c.sprite)) return;
  try {
    if (c.spriteType === "static" && layers.body?.imageUrl) {
      const image = await createCachedImage(layers.body.imageUrl);
      if (creatures.get(c.id) === c) c.staticImage = image;
      return;
    }
    if (c.spriteType === "animated" && layers.body) {
      const anim = await initializeLayeredAnimation(
        null,
        layers.body,
        layers.head || null,
        layers.helmet || null,
        layers.shoulderguards || null,
        layers.neck || null,
        layers.hands || null,
        layers.chest || null,
        layers.feet || null,
        layers.legs || null,
        layers.weapon || null,
        animationNameFor(c)
      );
      if (creatures.get(c.id) === c) c.anim = anim;
    }
  } catch (error) {
    // Fall back to the placeholder body; don't retry a broken sheet every spawn.
    spriteFailures.add(c.sprite);
    console.error(`Creature sprite ${c.sprite} failed to load:`, error);
  }
}

function animationNameFor(c: CreatureView): string {
  const dir = c.dir || "down";
  if (c.cast && c.state !== "dead") return `cast_idle_${dir}`;
  if (c.moving && c.state !== "dead") return `walk_${dir}`;
  return `idle_${dir}`;
}

/** entries: [id, x, y, dir, moving] */
export function applyCreatureMove(data: any): void {
  const entries = Array.isArray(data?.c) ? data.c : [];
  const now = performance.now();
  for (const e of entries) {
    if (!Array.isArray(e)) continue;
    const c = creatures.get(e[0]);
    if (!c) continue;
    c.fromX = c.renderX;
    c.fromY = c.renderY;
    c.lerpStart = now;
    c.x = e[1];
    c.y = e[2];
    c.dir = e[3];
    c.moving = e[4] === 1;
  }
}

function updateRenderPosition(c: CreatureView, now: number): void {
  const t = Math.min(1, Math.max(0, (now - c.lerpStart) / INTERPOLATION_MS));
  c.renderX = c.fromX + (c.x - c.fromX) * t;
  c.renderY = c.fromY + (c.y - c.fromY) * t;
}

export function applyCreatureDespawn(data: any): number[] {
  const ids: number[] = Array.isArray(data?.ids) ? data.ids : [];
  for (const id of ids) {
    creatures.delete(id);
    if (autoAttackingId === id) autoAttackingId = null;
  }
  return ids;
}

export function applyCreatureState(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.state = data.state;
  c.victimId = data.victimId ?? null;
  if (c.state === "dead") {
    // A corpse is not a target: drop it so its ring and frame go away. Looting
    // is a right-click on the skeleton and does not need a target.
    if (parseCreatureTarget(cache.targetId) === c.id) cache.targetId = null;
    if (autoAttackingId === c.id) autoAttackingId = null;
  }
}

export function applyCreatureHealth(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.health = data.health;
  c.maxHealth = data.maxHealth;
}

export function applyCreatureTap(data: any): void {
  const c = creatures.get(data?.id);
  if (c) c.tap = data.tap;
}

export function applyCreatureLootable(data: any): void {
  const c = creatures.get(data?.id);
  if (c) c.lootable = !!data.lootable;
}

/** "+N XP" over the local player. */
export function applyCreatureXp(data: any, localPlayerId: string | null): void {
  if (!localPlayerId || !(data?.amount > 0)) return;
  floatingTexts.push({
    creatureId: data.creatureId,
    playerId: localPlayerId,
    text: `+${data.amount} XP`,
    color: "#c080ff",
    size: 14,
    start: performance.now(),
    jitter: 0,
  });
}

export function applyCreatureCast(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  const now = performance.now();
  c.cast = { spell: String(data.spell), startedAt: now, endsAt: now + (Number(data.durationMs) || 0) };
}

export function applyCreatureCastEnd(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.cast = null;
  if (data.result === "interrupted") {
    floatingTexts.push({ creatureId: c.id, playerId: null, text: "Interrupted", color: "#ff9040", size: 13, start: performance.now(), jitter: 0 });
  }
}

export function applyCreatureAuras(data: any): void {
  const c = creatures.get(data?.id);
  if (!c) return;
  c.auras = Array.isArray(data.auras) ? data.auras : [];
  c.aurasAt = performance.now();
}

export function applyCreatureAttackStopped(data: any): void {
  if (autoAttackingId === data?.id) autoAttackingId = null;
}

export function clearCreatures(): void {
  creatures.clear();
  floatingTexts.length = 0;
  autoAttackingId = null;
}

// ------------------------------------------------------------- combat text

interface FloatingText {
  creatureId: number;
  /** Player id when the text belongs over a player instead of the creature. */
  playerId: string | null;
  text: string;
  color: string;
  size: number;
  start: number;
  jitter: number;
}

const floatingTexts: FloatingText[] = [];
const FLOAT_MS = 1200;

const TEXT_STYLES: Record<string, { color: string; label?: string; size: number }> = {
  hit: { color: "#ffffff", size: 14 },
  spell: { color: "#ffe066", size: 14 },
  crit: { color: "#ffffff", size: 20 },
  crush: { color: "#ff6060", size: 20 },
  glancing: { color: "#cccccc", size: 12 },
  miss: { color: "#ffffff", label: "Miss", size: 13 },
  dodge: { color: "#ffffff", label: "Dodge", size: 13 },
  parry: { color: "#ffffff", label: "Parry", size: 13 },
  evade: { color: "#ffffff", label: "Evading", size: 13 },
  immune: { color: "#ffffff", label: "Immune", size: 13 },
  resist: { color: "#b0b0ff", label: "Resist", size: 13 },
  heal: { color: "#40ff60", size: 14 },
  interrupted: { color: "#ff9040", label: "Interrupted", size: 13 },
};

/** data: { creatureId, targetId, sourceId, kind, amount } */
export function applyCreatureCombatText(data: any): void {
  // Interrupts are shown from CREATURE_CAST_END so stuns and kicks look the same.
  if (!data || data.kind === "interrupted") return;
  const onCreature = typeof data.targetId === "string" && data.targetId.startsWith("creature:");
  if (onCreature && !creatures.has(data.creatureId)) return;
  const style = TEXT_STYLES[data.kind] ?? TEXT_STYLES.hit;
  // Damage numbers on players already arrive through UPDATESTATS; only show avoidance there.
  if (!onCreature && !style.label) return;
  const emphasis = data.kind === "crit" || data.kind === "crush" ? "!" : "";
  floatingTexts.push({
    creatureId: data.creatureId,
    playerId: onCreature ? null : data.targetId,
    text: style.label ?? `${data.kind === "heal" ? "+" : ""}${data.amount}${emphasis}`,
    color: style.color,
    size: style.size,
    start: performance.now(),
    jitter: Math.random() * 20 - 10,
  });
  if (floatingTexts.length > 100) floatingTexts.splice(0, floatingTexts.length - 100);
}

/** Creature under a world-space point, nearest first. Corpses only when `corpses` is set. */
/**
 * Creature under a world point, nearest first. The hit circle is centred on the
 * sprite's middle and covers most of a 64px body; `slop` widens it for touch,
 * where a fingertip is far less precise than a cursor.
 */
export function creatureAt(worldX: number, worldY: number, corpses = false, slop = 0): CreatureView | null {
  let best: CreatureView | null = null;
  let bestDist = Infinity;
  for (const c of creatures.values()) {
    if ((c.state === "dead") !== corpses) continue;
    const radius = 24 * (c.scale || 1) + slop;
    const d = Math.hypot(worldX - c.renderX, worldY - c.renderY);
    if (d <= radius && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

// WoW grey-level formula: creatures at or below this level are trivial.
export function greyLevel(playerLevel: number): number {
  if (playerLevel <= 5) return 0;
  if (playerLevel <= 39) return playerLevel - Math.floor(playerLevel / 10) - 5;
  if (playerLevel <= 59) return playerLevel - Math.floor(playerLevel / 5) - 1;
  return playerLevel - 9;
}

export function levelColor(creatureLevel: number, playerLevel: number): string {
  const diff = creatureLevel - playerLevel;
  if (diff >= 5) return "#ff2020";
  if (diff >= 3) return "#ff8040";
  if (diff >= -2) return "#ffff00";
  if (creatureLevel > greyLevel(playerLevel)) return "#40c040";
  return "#808080";
}

const TAPPED_COLOR = "#8f8f8f";

const STANCE_COLORS: Record<CreatureView["stance"], string> = {
  aggressive: "#ff4040",
  neutral: "#ffff40",
  passive: "#80e080",
};

let lastRenderAt = 0;

export function renderCreatures(
  ctx: CanvasRenderingContext2D,
  isInView: (x: number, y: number) => boolean,
  playerLevel: number,
  targetId: string | null,
  playerPosition: (playerId: string) => { x: number; y: number } | null
): void {
  const now = performance.now();
  const deltaSeconds = Math.min(0.1, lastRenderAt ? (now - lastRenderAt) / 1000 : 0);
  lastRenderAt = now;
  const targeted = parseCreatureTarget(targetId);
  for (const c of creatures.values()) {
    updateRenderPosition(c, now);
    if (c.anim) {
      const wanted = animationNameFor(c);
      if (c.anim.currentAnimationName !== wanted) void changeLayeredAnimation(c.anim, wanted);
      updateLayeredAnimation(c.anim, deltaSeconds);
    }
    if (!isInView(c.renderX, c.renderY)) continue;
    drawCreature(ctx, c, playerLevel, c.id === targeted);
  }
  drawFloatingTexts(ctx, now, playerPosition);
}

function drawFloatingTexts(
  ctx: CanvasRenderingContext2D,
  now: number,
  playerPosition: (playerId: string) => { x: number; y: number } | null
): void {
  if (floatingTexts.length === 0) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const t = floatingTexts[i];
    const age = now - t.start;
    if (age >= FLOAT_MS) {
      floatingTexts.splice(i, 1);
      continue;
    }
    let anchor: { x: number; y: number } | null = null;
    if (t.playerId) {
      anchor = playerPosition(t.playerId);
    } else {
      const c = creatures.get(t.creatureId);
      if (c) anchor = { x: c.renderX, y: c.renderY - 30 * (c.scale || 1) };
    }
    if (!anchor) continue;
    const progress = age / FLOAT_MS;
    ctx.globalAlpha = 1 - progress * progress;
    // Numbers use the hotbar's font; words ("Miss", "Evading") the text font.
    ctx.font = `bold ${t.size}px ${fontFor(t.text)}`;
    const x = anchor.x + t.jitter;
    const y = anchor.y - 20 - progress * 30;
    ctx.strokeText(t.text, x, y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x, y);
  }
  ctx.restore();
}

/** Draws the creature's sprite centred on its anchor. Returns the drawn height, or 0 if nothing was drawn. */
/**
 * Where the sprite's feet land, and how tall it is, without drawing anything.
 *
 * A sprite frame is mostly empty space below the character, so the feet are not
 * the bottom edge of the image. Players put their shadow a quarter of a frame
 * below the anchor (+16 on a 64px frame); creatures use the same rule so both
 * stand on the ground the same way.
 */
const FEET_FRACTION = 0.25;

function spriteMetrics(c: CreatureView): { height: number; feetY: number } | null {
  const scale = c.scale > 0 ? c.scale : 1;
  if (c.anim) {
    let height = 0;
    for (const layer of getVisibleLayersSorted(c.anim)) {
      if (!layer.frames.length) continue;
      const frame = layer.frames[layer.currentFrame];
      if (!frame?.imageElement?.complete || !frame.imageElement.naturalWidth) continue;
      height = Math.max(height, frame.height * scale);
    }
    return height > 0 ? { height, feetY: c.renderY + height * FEET_FRACTION } : null;
  }
  const img = c.staticImage;
  if (img?.complete && img.naturalWidth > 0) {
    const height = img.height * scale;
    return { height, feetY: c.renderY + height * FEET_FRACTION };
  }
  return null;
}

function drawCreatureSprite(ctx: CanvasRenderingContext2D, c: CreatureView): number {
  // The template's scale grows every layer about the frame centre (like
  // players), with each layer's offset scaled too - so head, body and gear
  // keep their relative alignment at any scale instead of overlapping.
  const scale = c.scale > 0 ? c.scale : 1;
  const draw = (image: CanvasImageSource, width: number, height: number, ox: number, oy: number): void => {
    ctx.drawImage(
      image,
      Math.round(c.renderX - (width * scale) / 2 + ox * scale),
      Math.round(c.renderY - (height * scale) / 2 + oy * scale),
      Math.round(width * scale),
      Math.round(height * scale)
    );
  };

  if (c.anim) {
    const layers = getVisibleLayersSorted(c.anim);
    let height = 0;
    ctx.imageSmoothingEnabled = false;
    for (const layer of layers) {
      if (!layer.frames.length) continue;
      const frame = layer.frames[layer.currentFrame];
      if (!frame?.imageElement?.complete || !frame.imageElement.naturalWidth) continue;
      draw(frame.imageElement, frame.width, frame.height, frame.offset?.x || 0, frame.offset?.y || 0);
      height = Math.max(height, frame.height * scale);
    }
    return height;
  }
  const img = c.staticImage;
  if (img?.complete && img.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false;
    draw(img, img.width, img.height, 0, 0);
    return img.height * scale;
  }
  return 0;
}

/** Longest edge of a corpse skeleton, matching player death markers. */
const CORPSE_SKELETON_SIZE = 56;

/**
 * A dead creature is drawn as a skeleton, the same marker players leave, in
 * place of its sprite. It stays as long as the server keeps the corpse (so it
 * can still be looted), then disappears with it.
 */
function drawCreatureCorpse(ctx: CanvasRenderingContext2D, c: CreatureView): void {
  const img = getCachedImage(getSkeletonSpriteUrl());
  if (!img.complete || img.naturalWidth === 0) return;
  const fit = Math.min(1, CORPSE_SKELETON_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * fit));
  const h = Math.max(1, Math.round(img.naturalHeight * fit));
  const x = c.renderX;
  const y = c.renderY;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  // Same placement as player skeletons (skeletons.ts).
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h / 2 - 10), w, h);

  if (c.lootable) {
    // Pulsing gold sparkle marks corpses the local player can loot.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
    ctx.fillStyle = `rgba(255, 215, 90, ${0.35 + pulse * 0.45})`;
    for (let i = 0; i < 4; i++) {
      const a = performance.now() / 600 + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * (w / 2 + 4), y - 10 + Math.sin(a) * (h / 3), 2 + pulse * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawCreature(ctx: CanvasRenderingContext2D, c: CreatureView, playerLevel: number, targeted: boolean): void {
  if (c.state === "dead") {
    drawCreatureCorpse(ctx, c);
    return;
  }
  const radius = 14 * (c.scale || 1);
  // Server anchor matches players: horizontal centre, footprint below y.
  const cx = c.renderX;
  const cy = c.renderY + 8;

  ctx.save();

  // Ground markers go under the creature's feet and are drawn before the
  // sprite, so nothing is painted over the creature itself.
  const metrics = spriteMetrics(c);
  const groundY = metrics ? metrics.feetY : cy + radius * 0.9;
  const groundRx = metrics ? Math.max(radius, 10 * (c.scale || 1)) : radius;

  // Same as players (player.ts show()): a dark shadow, which a target swaps
  // for a slightly larger red ring - never both.
  if (targeted) {
    const rx = groundRx * 1.2;
    ctx.beginPath();
    ctx.ellipse(cx, groundY, rx, rx * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 0, 0, 0.35)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(cx, groundY, groundRx, groundRx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sprite if loaded, otherwise the placeholder body.
  const spriteHeight = drawCreatureSprite(ctx, c);
  if (spriteHeight === 0) {
    ctx.fillStyle = "#7a5c3e";
    ctx.strokeStyle = targeted ? "#ffffff" : "rgba(0, 0, 0, 0.8)";
    ctx.lineWidth = targeted ? 2 : 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Bars and icons sit above the drawn sprite, so they follow scaled creatures.
  // Measured from the feet so bars clear the head of a tall or scaled sprite.
  const headY = spriteHeight > 0 ? groundY - spriteHeight : cy - radius;
  drawNameplate(ctx, c, playerLevel, targeted, headY, groundY);
  drawCastBar(ctx, c, headY);
  ctx.restore();
}

/** Same layout as player nameplates: name below the feet, subname in the guild slot, bars and level when targeted. */
function drawNameplate(ctx: CanvasRenderingContext2D, c: CreatureView, playerLevel: number, targeted: boolean, headY: number, groundY: number): void {
  const x = c.renderX;
  // Below the feet (feet sit a quarter frame under the anchor, players offset
  // their name the same way), so a scaled creature's shadow never lands on it.
  const nameY = groundY + 34;
  const tappedByOther = c.tap === "other";

  ctx.textAlign = "center";
  ctx.font = "14px 'Comic Relief'";
  ctx.shadowColor = "black";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = "black";
  ctx.lineWidth = 1;
  ctx.fillStyle = tappedByOther ? TAPPED_COLOR : STANCE_COLORS[c.stance] || STANCE_COLORS.neutral;
  ctx.strokeText(c.name, x, nameY);
  ctx.fillText(c.name, x, nameY);

  const subOffset = c.subname ? 16 : 0;
  if (c.subname) {
    ctx.font = "12px 'Comic Relief'";
    ctx.fillStyle = "#c9a655";
    ctx.shadowBlur = 1;
    ctx.strokeText(`<${c.subname}>`, x, nameY + 16);
    ctx.fillText(`<${c.subname}>`, x, nameY + 16);
    ctx.shadowBlur = 2;
  }

  if (targeted) {
    const barY = nameY + 6 + subOffset;
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(x - 50, barY, 100, 3);
    const pct = c.maxHealth > 0 ? Math.max(0, Math.min(1, c.health / c.maxHealth)) : 0;
    if (pct < 0.3) ctx.fillStyle = "#C81D1D";
    else if (pct < 0.5) ctx.fillStyle = "#C87C1D";
    else if (pct < 0.8) ctx.fillStyle = "#C8C520";
    else ctx.fillStyle = "#519D41";
    ctx.fillRect(x - 50, barY, pct * 100, 3);

    // Level beside the bar, coloured by difficulty. Players centre theirs on
    // two bars (health + mana); creatures have only the health bar, so the
    // level sits level with that one bar instead of hanging below it.
    const skull = c.rank === "boss" || c.level - playerLevel >= 10;
    const elite = c.rank === "elite" || c.rank === "rare_elite" || c.rank === "boss";
    const levelText = `${skull ? "??" : c.level}${elite ? "+" : ""}`;
    ctx.textAlign = "left";
    ctx.font = "12px 'Comic Relief'";
    ctx.fillStyle = skull ? "#ff2020" : levelColor(c.level, playerLevel);
    ctx.fillText(levelText, x - 60 - levelText.length * 5, barY + 7);
  }

  drawAuras(ctx, c, headY);

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.textAlign = "center";
}

/** Same buff/debuff icons as players: rows of five above the head, buffs first, timers underneath. */
function drawAuras(ctx: CanvasRenderingContext2D, c: CreatureView, headY: number): void {
  const elapsed = performance.now() - (c.aurasAt || 0);
  const active = (c.auras || [])
    .map((a) => ({ ...a, left: a.remainingMs - elapsed, debuff: a.debuff ?? a.kind !== "hot" }))
    .filter((a) => a.left > 0)
    .sort((a, b) => (a.debuff ? 1 : 0) - (b.debuff ? 1 : 0))
    .slice(0, 10);
  if (active.length === 0) return;

  const iconSize = 18;
  const gap = 3;
  const maxPerRow = 5;
  const timerHeight = 12;
  const rowHeight = iconSize + timerHeight + gap;
  const baseIconY = headY - 63;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  for (let r = 0; r * maxPerRow < active.length; r++) {
    const row = active.slice(r * maxPerRow, (r + 1) * maxPerRow);
    const rowWidth = row.length * iconSize + (row.length - 1) * gap;
    let x = Math.round(c.renderX - rowWidth / 2);
    const y = Math.round(baseIconY - r * rowHeight);

    for (const aura of row) {
      const iconUrl = aura.icon || (aura.spell && cache.spells?.[aura.spell]?.spriteUrl) || `${config.ASSET_SERVER_URL}/icon?name=missing_icon`;
      const img = getCachedImage(iconUrl);

      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(x - 1, y - 1, iconSize + 2, iconSize + 2);
      if (img.complete && img.naturalWidth > 0) ctx.drawImage(img, x, y, iconSize, iconSize);

      ctx.strokeStyle = aura.debuff ? "rgba(255, 90, 90, 0.9)" : "rgba(120, 170, 255, 0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 0.5, y - 0.5, iconSize + 1, iconSize + 1);

      const stacks = Number(aura.stacks) || 1;
      if (stacks > 1) {
        ctx.font = `bold 10px ${NUMBER_FONT}`;
        ctx.textAlign = "right";
        ctx.fillStyle = "#ffd75e";
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.strokeText(`${stacks}`, x + iconSize, y + iconSize - 1);
        ctx.fillText(`${stacks}`, x + iconSize, y + iconSize - 1);
      }

      const remaining = Math.ceil(aura.left / 1000);
      if (remaining > 0) {
        const label = formatDuration(remaining);
        ctx.font = `bold 10px ${NUMBER_FONT}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "white";
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.strokeText(label, x + iconSize / 2, y + iconSize + timerHeight - 2);
        ctx.fillText(label, x + iconSize / 2, y + iconSize + timerHeight - 2);
      }

      x += iconSize + gap;
    }
  }
  ctx.restore();
}

/** Same cast bar as players, above the head. */
function drawCastBar(ctx: CanvasRenderingContext2D, c: CreatureView, headY: number): void {
  if (!c.cast) return;
  const total = Math.max(1, c.cast.endsAt - c.cast.startedAt);
  const progress = Math.max(0, Math.min(1, (performance.now() - c.cast.startedAt) / total));
  const barWidth = 110;
  const barHeight = 10;
  const barX = c.renderX - barWidth / 2;
  const barY = headY - 6;

  ctx.fillStyle = "rgba(8, 8, 16, 0.9)";
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(160, 150, 130, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 3);
  ctx.stroke();

  ctx.fillStyle = "rgba(212, 168, 38, 0.95)";
  ctx.beginPath();
  ctx.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, barHeight - 2, 2);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.beginPath();
  ctx.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, (barHeight - 2) / 2, [2, 2, 0, 0]);
  ctx.fill();

  const label = c.cast.spell.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  ctx.font = "bold 10px 'Comic Relief'";
  ctx.fillStyle = "#e8e0d0";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = 3;
  ctx.fillText(label, c.renderX, barY - 5);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
}
