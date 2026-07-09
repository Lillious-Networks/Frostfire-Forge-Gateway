import { lightCanvas, lightCtx } from "./ui.js";
import { getNightFactor } from "./ambience.js";
import Cache from "./cache.js";

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

function ensureCanvasSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (lightCanvas.width !== w || lightCanvas.height !== h) {
    lightCanvas.width = w;
    lightCanvas.height = h;
    lightCanvas.style.width = window.innerWidth + "px";
    lightCanvas.style.height = window.innerHeight + "px";
  }
  return dpr;
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

// Draw the additive light map. Lights come from glowing particles on NPCs and
// entities (glow_intensity > 0). Only active at night; scales with darkness so
// glow "emits light" once the ambience overlay darkens the scene.
export function renderLightMap(camX: number, camY: number) {
  if (!lightCtx) return;

  const night = getNightFactor();
  const dpr = ensureCanvasSize();

  lightCtx.setTransform(1, 0, 0, 1, 0, 0);
  lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);

  if (night < 0.01) return;

  lightCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lightCtx.globalCompositeOperation = "lighter";

  const halfW = window.innerWidth / 2;
  const halfH = window.innerHeight / 2;

  const sources: Array<{ src: any; offX: number; offY: number }> = [];
  // NPC particles render centered at position + (16, 24) (see npc.ts); entity
  // particles render at the raw position (see entity.ts). Match those offsets so
  // the glow lines up with the particles.
  for (const npc of cache.npcs) sources.push({ src: npc, offX: 16, offY: 24 });
  for (const entity of cache.entities) sources.push({ src: entity, offX: 0, offY: 0 });

  for (const { src, offX, offY } of sources) {
    if (!src.particles || !src.position) continue;

    // One light per emitter (not per particle) so many particles don't stack
    // into a blown-out blob. Use the strongest glowing particle config.
    let best: any = null;
    for (const particle of src.particles) {
      const glow = particle.glow_intensity || 0;
      if (glow <= 0 || particle.visible === false) continue;
      if (!best || glow > (best.glow_intensity || 0)) best = particle;
    }
    if (!best) continue;

    const glow = best.glow_intensity || 0;
    const size = best.size || 5;

    // Skip small / weak-glow emitters (e.g. fireflies) so they stay crisp and
    // are not washed out by a halo. Only larger, strongly glowing particles
    // cast a subtle night light.
    if (size < 6 || glow < 1) continue;

    const sx = src.position.x + offX - camX + halfW;
    const sy = src.position.y + offY - camY + halfH;

    // Small halo tied to the emitter's own size; faint additive wash.
    const radius = size * 2 + glow * 6;
    const intensity = Math.min(0.18, 0.03 + glow * 0.03) * night;
    if (intensity <= 0.001) continue;

    if (sx + radius < 0 || sx - radius > window.innerWidth ||
        sy + radius < 0 || sy - radius > window.innerHeight) continue;

    const tex = getLightTexture(best.color || "#ffffff");
    lightCtx.globalAlpha = intensity;
    lightCtx.drawImage(tex, sx - radius, sy - radius, radius * 2, radius * 2);
  }

  lightCtx.globalAlpha = 1;
  lightCtx.globalCompositeOperation = "source-over";
}
