import { lightCanvas, lightCtx, lightDodgeCanvas, lightDodgeCtx } from "./ui.js";
import { getNightFactor, getAmbientLevel } from "./ambience.js";
import Cache from "./cache.js";
import { particleBrightness } from "./npc.js";
import { takeGlows } from "./glowqueue.js";

const cache = Cache.getInstance();

// Baked radial light sprites (soft falloff), one per color, reused via drawImage.
const LIGHT_TEX_SIZE = 256;
const lightTexCache = new Map<string, HTMLCanvasElement>();

function getLightTexture(color: string): HTMLCanvasElement {
  const cached = lightTexCache.get(color);
  if (cached) return cached;

  const c = document.createElement("canvas");
  c.width = LIGHT_TEX_SIZE;
  c.height = LIGHT_TEX_SIZE;
  const g = c.getContext("2d")!;
  const half = LIGHT_TEX_SIZE / 2;
  const { r, gr, b } = parseColor(color);
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, `rgba(${r},${gr},${b},0.85)`);
  grad.addColorStop(0.25, `rgba(${r},${gr},${b},0.5)`);
  grad.addColorStop(0.55, `rgba(${r},${gr},${b},0.18)`);
  grad.addColorStop(0.8, `rgba(${r},${gr},${b},0.05)`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, LIGHT_TEX_SIZE, LIGHT_TEX_SIZE);
  lightTexCache.set(color, c);
  return c;
}

// The light layers are the game canvas's twins: same backing size and CSS size, drawn with the same transform (device
// pixel ratio, and on touch devices the 0.85 zoom), so a light lands exactly on its particle on every device.
function matchGameCanvas(game: HTMLCanvasElement, target: HTMLCanvasElement) {
  if (target.width !== game.width || target.height !== game.height) {
    target.width = game.width;
    target.height = game.height;
  }
  if (target.style.width !== game.style.width) target.style.width = game.style.width;
  if (target.style.height !== game.style.height) target.style.height = game.style.height;
}

function parseColor(color: string): { r: number; gr: number; b: number } {
  if (!color) return { r: 255, gr: 255, b: 255 };
  if (color[0] === "#") {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 0xff, gr: (n >> 8) & 0xff, b: n & 0xff };
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return { r: parts[0] || 255, gr: parts[1] || 255, b: parts[2] || 255 };
  }
  return { r: 255, gr: 255, b: 255 };
}

// ---------------------------------------------------------------- emissive tiles
// Tiles that give off light: Tiled custom tile properties on the map's tilesets (emissive_color, emissive_intensity,
// emissive_radius = how far past the tile the light reaches, in px), e.g. the underworld's lava and glow pools.
// One continuous light field over the darkened scene (light-dodge canvas, colour-dodge: a gain on what the ambience
// darkened): full on the emissive tiles, which show at their own daylight colours, then fading with the distance past
// their edge, white at the edge and turning to the light's colour further out. One field, so the light has no step
// anywhere (USER FEEDBACK 2026-10-03, "Still seeing a hard edge": measured across a lava edge, the emissive tiles,
// redrawn apart from the floor light, were lit 1.12 against 0.85 on the floor pixel next to them, a dark line where the
// floor light had been cut out under the tiles).
interface Emissive { color: string; intensity: number; radius: number }
const GID_MASK = 0x1fffffff;
let emissiveFor: { tilesets: any[] | null; table: Map<number, Emissive> } = { tilesets: null, table: new Map() };
/** A chunk's emissive tiles: index in the chunk (y * width + x) -> what the tile gives off. */
const chunkEmissive = new WeakMap<object, Map<number, Emissive>>();
/** The light a chunk's tiles receive, per tile (the chunk plus a one-tile margin, so scaling it up blends into the
 * neighbouring chunks' light): amount 0..1, how far it has turned from white to its colour (0..1) and the emissive tile
 * it comes from. Built from the emissive tiles of the chunk and its 8 neighbours, so the light crosses chunk borders
 * without seams; rebuilt when a neighbour (un)loads. */
type SpillField = { amount: Float32Array; tint: Float32Array; from: (Emissive | null)[]; w: number; h: number };
type ChunkSpill = { neighbours: unknown[]; field: SpillField | null; level: string; light: HTMLCanvasElement | null };
const chunkSpill = new WeakMap<object, ChunkSpill>();
/** light canvas pixels per world pixel (the light is smooth: half resolution is plenty) */
const SPILL_SCALE = 0.5;
/** the light's colour at full tint: this much white mixed in, so lit tiles keep their own colours readable */
const SPILL_WHITE = 0.25;
/** tiles past the edge over which the light turns from white (the emissive tile's own daylight) to its colour */
const SPILL_TINT_TILES = 2;
/** How bright an emissive tile of emissive_intensity 3 gets, between the darkness (0) and its daylight colours (1); other
 * intensities in proportion, up to the daylight colours (3 / EMISSIVE_PEAK, about 3.5); its light past it starts there
 * too (USER FEEDBACK 2026-10-03: at full daylight "they are too bright"; at 0.65 "little bit brighter"; at 0.75
 * "brighter"; pools, then capped at intensity 3, "brighter" again). */
const EMISSIVE_PEAK = 0.85;

/** Tiled colours are #AARRGGBB (or #RRGGBB); the light wants #RRGGBB. */
function tiledColor(v: unknown): string {
  const s = String(v ?? "#ffffff");
  return /^#[0-9a-f]{8}$/i.test(s) ? "#" + s.slice(3) : /^#[0-9a-f]{6}$/i.test(s) ? s : "#ffffff";
}

function emissiveTable(): Map<number, Emissive> {
  const tilesets = window.mapData?.tilesets ?? null;
  if (emissiveFor.tilesets === tilesets) return emissiveFor.table;
  const table = new Map<number, Emissive>();
  for (const ts of tilesets ?? []) {
    for (const t of ts?.tiles ?? []) {
      const props = new Map<string, any>((t.properties ?? []).map((p: any) => [String(p.name).toLowerCase(), p.value]));
      const intensity = Number(props.get("emissive_intensity")) || 0;
      if (intensity <= 0) continue;
      table.set(Number(ts.firstgid) + Number(t.id), { color: tiledColor(props.get("emissive_color")), intensity, radius: Number(props.get("emissive_radius")) || 48 });
    }
  }
  emissiveFor = { tilesets, table };
  return table;
}

function chunkLayers(chunk: any): any[] {
  return (chunk.layers ?? []).filter((l: any) => l?.data && !/collision|nopvp/i.test(String(l.name ?? "")));
}

/** A chunk's first tile (x, y). Chunks from the asset server carry only chunkX / chunkY (no startX / startY). */
function chunkOrigin(chunk: any): { x: number; y: number } {
  const size = Number(window.mapData?.chunkSize) || Number(chunk.width) || 0;
  return {
    x: Number.isFinite(Number(chunk.startX)) ? Number(chunk.startX) : Number(chunk.chunkX) * size,
    y: Number.isFinite(Number(chunk.startY)) ? Number(chunk.startY) : Number(chunk.chunkY) * size,
  };
}

function emissiveOf(chunk: any, table: Map<number, Emissive>): Map<number, Emissive> {
  const hit = chunkEmissive.get(chunk);
  if (hit) return hit;
  const out = new Map<number, Emissive>();
  for (const l of chunkLayers(chunk)) for (let k = 0; k < l.data.length; k++) {
    const e = l.data[k] ? table.get(l.data[k] & GID_MASK) : undefined;
    if (e && (!out.has(k) || e.intensity > out.get(k)!.intensity)) out.set(k, e);
  }
  chunkEmissive.set(chunk, out);
  return out;
}

/** The chunk and its 8 neighbours (row by row, the chunk in the middle), undefined where none is loaded. */
function neighboursOf(chunk: any): unknown[] {
  const size = Number(window.mapData?.chunkSize) || Number(chunk.width) || 1, o = chunkOrigin(chunk);
  const cx = Number.isFinite(Number(chunk.chunkX)) ? Number(chunk.chunkX) : Math.floor(o.x / size);
  const cy = Number.isFinite(Number(chunk.chunkY)) ? Number(chunk.chunkY) : Math.floor(o.y / size);
  const out: unknown[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    out.push(dx || dy ? window.mapData?.loadedChunks?.get(`${cx + dx}-${cy + dy}`) : chunk);
  }
  return out;
}

/** The light each tile of a chunk receives: full on emissive tiles; past them, fading with the distance from the edge
 * of the nearest emissive tile (its own or a neighbour's) to nothing at that tile's emissive_radius. Its brightness is
 * the tile's emissive_intensity (3 = EMISSIVE_PEAK, about 3.5 = daylight colours). null when no light reaches the
 * chunk. */
function spillField(chunk: any, neighbours: unknown[], table: Map<number, Emissive>, tw: number): SpillField | null {
  const w = Number(chunk.width) || 0, h = Number(chunk.height) || 0, o = chunkOrigin(chunk);
  let reach = 0;
  for (const e of table.values()) if (e.radius > reach) reach = e.radius;
  const P = Math.ceil(reach / tw) + 1, gw = w + 2 * P, gh = h + 2 * P;
  const dist = new Float32Array(gw * gh).fill(Infinity), src: (Emissive | null)[] = new Array(gw * gh).fill(null);
  let any = false;
  for (const nb of neighbours as any[]) {
    if (!nb) continue;
    const no = chunkOrigin(nb), nw = Number(nb.width) || w, ox = no.x - o.x + P, oy = no.y - o.y + P;
    for (const [k, e] of emissiveOf(nb, table)) {
      const x = ox + (k % nw), y = oy + ((k / nw) | 0);
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      dist[y * gw + x] = 0; src[y * gw + x] = e; any = true;
    }
  }
  if (!any) return null;
  // distances in tiles (8 neighbours, diagonal 1.414: close to round), each tile lit by its nearest emissive tile
  const relax = (i: number, j: number, c: number) => { if (dist[j]! + c < dist[i]!) { dist[i] = dist[j]! + c; src[i] = src[j]!; } };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (x > 0) relax(i, i - 1, 1);
    if (y > 0) { relax(i, i - gw, 1); if (x > 0) relax(i, i - gw - 1, 1.414); if (x < gw - 1) relax(i, i - gw + 1, 1.414); }
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x;
    if (x < gw - 1) relax(i, i + 1, 1);
    if (y < gh - 1) { relax(i, i + gw, 1); if (x < gw - 1) relax(i, i + gw + 1, 1.414); if (x > 0) relax(i, i + gw - 1, 1.414); }
  }
  const fw = w + 2, fh = h + 2, amount = new Float32Array(fw * fh), tint = new Float32Array(fw * fh), from: (Emissive | null)[] = new Array(fw * fh).fill(null);
  let lit = false;
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const gi = (y - 1 + P) * gw + (x - 1 + P), e = src[gi], fi = y * fw + x;
    if (!e) continue;
    // distance from the emissive tile's edge to this tile's middle (the field is sampled at tile middles)
    const d = Math.max(0, dist[gi]! - 0.5), f = dist[gi] === 0 ? 1 : Math.max(0, 1 - d / Math.max(1, e.radius / tw));
    if (f <= 0) continue;
    amount[fi] = f * f * Math.min(1, EMISSIVE_PEAK * e.intensity / 3);
    tint[fi] = dist[gi] === 0 ? 0 : Math.min(1, d / SPILL_TINT_TILES);
    from[fi] = e;
    lit = true;
  }
  return lit ? { amount, tint, from, w: fw, h: fh } : null;
}

/** The light canvas of a spill field for the current ambience level A (what the ambience overlay leaves of the scene):
 * per tile a colour-dodge colour at alpha = the light's amount, lifting the darkened scene to A + amount x (1 - A) x
 * tint, i.e. back to its daylight colours on emissive tiles (amount 1, white), less and more coloured further out.
 * Scaled up smoothly (1 px per tile, then two bilinear steps, fewer diamonds). */
function spillCanvas(field: SpillField, level: [number, number, number], tw: number, th: number): HTMLCanvasElement {
  const { w, h } = field, px = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const e = field.from[i];
    if (!e || field.amount[i]! <= 0) continue;
    const n = parseInt(e.color.slice(1), 16), col = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (let k = 0; k < 3; k++) {
      const full = SPILL_WHITE + (1 - SPILL_WHITE) * (col[k]! / 255), tint = 1 + (full - 1) * field.tint[i]!;
      // colour-dodge: backdrop / (1 - c); blended at alpha a the gain is 1 + a * c / (1 - c), so c / (1 - c) = G
      const a = Math.max(0.05, Math.min(0.95, level[k]!)), G = (1 - a) * tint / a;
      px.data[i * 4 + k] = Math.round(255 * G / (1 + G));
    }
    px.data[i * 4 + 3] = Math.round(255 * field.amount[i]!);
  }
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  small.getContext("2d")!.putImageData(px, 0, 0);
  const mid = document.createElement("canvas");
  mid.width = w * 4; mid.height = h * 4;
  const mg = mid.getContext("2d")!;
  mg.imageSmoothingEnabled = true; mg.drawImage(small, 0, 0, mid.width, mid.height);
  const s = SPILL_SCALE, out = document.createElement("canvas");
  out.width = Math.ceil(w * tw * s); out.height = Math.ceil(h * th * s);
  const og = out.getContext("2d")!;
  og.imageSmoothingEnabled = true; og.drawImage(mid, 0, 0, out.width, out.height);
  return out;
}

/** A chunk's light canvas (chunk plus a one-tile margin), or null when no light reaches it. Cached; rebuilt when a
 * neighbouring chunk (un)loads or the ambience level changes. */
function spillOf(chunk: any, table: Map<number, Emissive>, tw: number, th: number, level: [number, number, number]): HTMLCanvasElement | null {
  const neighbours = neighboursOf(chunk), key = level.map((v) => Math.round(v * 64)).join(",");
  let hit = chunkSpill.get(chunk);
  if (!hit || hit.neighbours.some((n, i) => n !== neighbours[i])) {
    hit = { neighbours, field: spillField(chunk, neighbours, table, tw), level: "", light: null };
    chunkSpill.set(chunk, hit);
  }
  if (hit.field && hit.level !== key) { hit.light = spillCanvas(hit.field, level, tw, th); hit.level = key; }
  return hit.field ? hit.light : null;
}

let lastFrame = { spillDrawn: 0, glowsQueued: 0, particlesDrawn: 0 };
// Console switches for finding which light source draws what: window.__lightLayers.spill / .npcWash / .particles =
// false hides that source (all on by default).
const lightLayers = { spill: true, npcWash: true, particles: true };
(window as any).__lightLayers = lightLayers;
// Console diagnostic: window.__lightDebug() -> what the light layer sees right now.
(window as any).__lightDebug = () => {
  const table = emissiveTable(), tw = window.mapData?.tilewidth || 16, th = window.mapData?.tileheight || 16;
  let chunks = 0, spillChunks = 0;
  for (const chunk of window.mapData?.loadedChunks?.values?.() ?? []) {
    chunks++;
    if (spillOf(chunk, table, tw, th, getAmbientLevel())) spillChunks++;
  }
  const tilesets = (window.mapData?.tilesets ?? []).map((t: any) => ({ image: t.image, firstgid: t.firstgid, tilesWithProperties: (t.tiles ?? []).length }));
  return { version: 5, lastFrame, spillChunks, map: window.mapData?.name, night: getNightFactor(), ambientLevel: getAmbientLevel(), emissiveTiles: table.size, loadedChunks: chunks, tilesets, lightCanvas: { w: lightCanvas.width, h: lightCanvas.height, css: lightCanvas.style.width } };
};

// Draw the light map. Lights come from emissive tiles and from glowing particles on NPCs and entities
// (glow_intensity > 0). Only active at night; scales with darkness so glow "emits light" once the ambience overlay
// darkens the scene.
export function renderLightMap(game: HTMLCanvasElement, base: DOMMatrix, offsetX: number, offsetY: number) {
  // this frame's glowing particle draws, taken (emptied) even when the night is off so the queue never grows
  const glows = takeGlows();
  if (!lightCtx) return;

  const night = getNightFactor();
  matchGameCanvas(game, lightCanvas);
  lightCtx.setTransform(1, 0, 0, 1, 0, 0);
  lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
  if (lightDodgeCtx) {
    matchGameCanvas(game, lightDodgeCanvas);
    lightDodgeCtx.setTransform(1, 0, 0, 1, 0, 0);
    lightDodgeCtx.clearRect(0, 0, lightDodgeCanvas.width, lightDodgeCanvas.height);
  }

  if (night < 0.01) return;

  // world coordinates, as the game canvas draws them: its base transform, then the camera offset
  lightCtx.setTransform(base);
  lightCtx.translate(offsetX, offsetY);
  lightCtx.globalCompositeOperation = "lighter";

  // the visible world rectangle (the base transform may zoom), for culling
  const inv = base.inverse();
  const tl = inv.transformPoint(new DOMPoint(0, 0)), br = inv.transformPoint(new DOMPoint(game.width, game.height));
  const viewL = tl.x - offsetX, viewT = tl.y - offsetY, viewR = br.x - offsetX, viewB = br.y - offsetY;

  // emissive tiles of the loaded chunks (lava, glow pools, ...) and the light they cast: one field per chunk, drawn
  // cropped to the chunk (its margin only blends it into the neighbours)
  let spillDrawn = 0;
  const table = emissiveTable();
  if (lightDodgeCtx && lightLayers.spill && table.size && window.mapData?.loadedChunks) {
    lightDodgeCtx.setTransform(base);
    lightDodgeCtx.translate(offsetX, offsetY);
    lightDodgeCtx.imageSmoothingEnabled = true;
    lightDodgeCtx.globalAlpha = 1; // the field is computed for the ambience level: no night scaling on top
    const tw = window.mapData.tilewidth || 16, th = window.mapData.tileheight || 16, level = getAmbientLevel(), s = SPILL_SCALE;
    for (const chunk of window.mapData.loadedChunks.values()) {
      const o = chunkOrigin(chunk), cx0 = o.x * tw, cy0 = o.y * th, cx1 = cx0 + chunk.width * tw, cy1 = cy0 + chunk.height * th;
      if (cx1 < viewL || cx0 > viewR || cy1 < viewT || cy0 > viewB) continue;
      const light = spillOf(chunk, table, tw, th, level);
      if (!light) continue;
      lightDodgeCtx.drawImage(light, tw * s, th * s, chunk.width * tw * s, chunk.height * th * s, cx0, cy0, chunk.width * tw, chunk.height * th);
      spillDrawn++;
    }
  }

  lastFrame = { spillDrawn, glowsQueued: glows.length, particlesDrawn: 0 };

  const sources: Array<{ src: any; offX: number; offY: number }> = [];
  // NPC particles render centered at position + (16, 24) (see npc.ts). Match
  // that offset so the glow lines up with the particles.
  for (const npc of cache.npcs) sources.push({ src: npc, offX: 16, offY: 24 });

  const now = performance.now();
  if (lightLayers.npcWash) for (const { src, offX, offY } of sources) {
    if (!src.particles || !src.position) continue;

    // One light per emitter (not per particle) so many particles don't stack
    // into a blown-out blob. Use the strongest glowing particle config shown this frame (npc.ts: its time window or
    // visible flag).
    let best: any = null;
    for (const particle of src.particles) {
      const glow = particle.glow_intensity || 0;
      if (glow <= 0 || now - (src.particlesLitAt?.[particle.name || ""] ?? -1e9) > 250) continue;
      if (!best || glow > (best.glow_intensity || 0)) best = particle;
    }
    if (!best) continue;

    const glow = best.glow_intensity || 0;
    const size = best.size || 5;

    // Skip small / weak-glow emitters (e.g. fireflies) so they stay crisp and
    // are not washed out by a halo. Only larger, strongly glowing particles
    // cast a subtle night light.
    if (size < 6 || glow < 1) continue;

    const sx = src.position.x + offX;
    const sy = src.position.y + offY;

    // The light reaches as far as the particle's glow (its Radius setting, else twice its size, as npc.ts glowReach)
    // plus its size; Intensity only makes it brighter.
    const reach = Number(best.glow_radius) > 0 ? Number(best.glow_radius) : Math.max(6, size);
    const radius = size + reach * 2;
    const intensity = Math.min(1, Math.min(0.7, 0.04 * glow) * particleBrightness(best)) * night;
    if (intensity <= 0.001) continue;

    if (sx + radius < viewL || sx - radius > viewR ||
        sy + radius < viewT || sy - radius > viewB) continue;

    const tex = getLightTexture(best.color || "#ffffff");
    lightCtx.globalAlpha = intensity;
    lightCtx.drawImage(tex, sx - radius, sy - radius, radius * 2, radius * 2);
  }

  // The glowing particles themselves, again, on this overlay: the game canvas they are drawn on sits under the
  // ambience overlay (a multiply darkening), so at night their glow was darkened with the scene. Drawn here (screen
  // blend, above the ambience) they shine over it, more the darker it is: every glowing sprite any renderer drew this
  // frame (glowqueue.ts), with the transform it was drawn with, at the alpha it was drawn at.
  let particlesDrawn = 0;
  if (lightLayers.particles) for (const g of glows) {
    lightCtx.setTransform(g.m);
    lightCtx.globalAlpha = Math.min(1, g.a * night);
    lightCtx.drawImage(g.img, g.x, g.y, g.w, g.h);
    particlesDrawn++;
  }
  lastFrame.particlesDrawn = particlesDrawn;

  lightCtx.globalAlpha = 1;
  lightCtx.globalCompositeOperation = "source-over";
}
