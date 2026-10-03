// Glowing particles drawn this frame on the game canvas, which sits under the ambience overlay (a multiply darkening),
// so at night their glow is darkened with the scene. Every particle renderer (NPCs, players, projectiles, effects)
// queues the glowing sprites it draws, with the transform it drew them with; the light layer (lightmap.ts) draws the
// queue again above the ambience each frame and empties it. So exactly what was drawn shines, whatever drew it
// (USER FEEDBACK 2026-10-03: "The glow never appears to be over the ambience layer": only NPC particles were redrawn,
// and not those flagged invisible that a time window still shows).

export type GlowDraw = { img: CanvasImageSource; m: DOMMatrix; x: number; y: number; w: number; h: number; a: number };

let queue: GlowDraw[] = [];

/** Queues one glowing sprite as just drawn: m is the drawing context's transform (getTransform(), once per batch). */
export function queueGlow(m: DOMMatrix, img: CanvasImageSource, x: number, y: number, w: number, h: number, a: number): void {
  if (a > 0.003) queue.push({ img, m, x, y, w, h, a });
}

/** This frame's queue, emptied for the next frame. */
export function takeGlows(): GlowDraw[] {
  const out = queue;
  queue = [];
  return out;
}
