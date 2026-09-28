// WebGL2 tilemap renderer. Tile layers are drawn straight from per-chunk
// tile-id textures and a shared tile atlas, so loading or editing a chunk is a
// small texture upload instead of a Canvas2D bake. Each pass renders into a
// hidden GL canvas and is copied into the 2D canvas it belongs to, which keeps
// the existing canvas stack (entities, ghosts, lights, weather) unchanged.

import { getGL, beginCanvasPass, type GLState } from "./context.js";
import { getMapResources, getChunkTexture, sweepChunks, updateAnimations, type MapResources } from "./resources.js";
import { MAX_SLICES_PER_DRAW, MAX_BLUR_TAPS, MAX_OCCLUDERS } from "./shaders.js";

export { setMap, invalidateChunk } from "./resources.js";

interface LayerCut { key: number; shadowZ: number | null; player: boolean }

export interface ShadowParams { offsetX: number; offsetY: number; alpha: number }

export interface MapPassOptions {
  phase: "below" | "above";
  target: CanvasRenderingContext2D;
  // World px -> target CSS px translation (camera offset, already rounded).
  offsetX: number;
  offsetY: number;
  visibleChunks: Array<{ x: number; y: number }>;
  cuts: LayerCut[];
  // World rect the map is clipped to.
  clip: { minX: number; minY: number; maxX: number; maxY: number };
  // Sun shadow for this frame, or null when shadows are off (night, storms).
  shadow: ShadowParams | null;
  // Fade-in alpha of a chunk by key.
  chunkAlpha: (key: string) => number;
  // Editor layer visibility; null outside the editor.
  isLayerVisible: ((name: string) => boolean) | null;
  // On-screen characters for y-sorting, nearest first, in world px: sprite box
  // minX, minY, maxX, maxY, then the feet line.
  occluders: Array<[number, number, number, number, number]>;
  now: number;
}

// Pack up to MAX_OCCLUDERS character boxes and feet lines for the tile shader.
const occluderBuffer = new Float32Array(MAX_OCCLUDERS * 4);
const occluderFeetBuffer = new Float32Array(MAX_OCCLUDERS);
function packOccluders(occluders: MapPassOptions["occluders"]): number {
  const count = Math.min(MAX_OCCLUDERS, occluders.length);
  for (let i = 0; i < count; i++) {
    const o = occluders[i];
    occluderBuffer[i * 4] = o[0];
    occluderBuffer[i * 4 + 1] = o[1];
    occluderBuffer[i * 4 + 2] = o[2];
    occluderBuffer[i * 4 + 3] = o[3];
    occluderFeetBuffer[i] = o[4];
  }
  return count;
}

// Shadow silhouettes are eroded by this much at their base (see TRIM_FS).
const SHADOW_BLUR_SIGMA = 2;
const SHADOW_BLUR_TAPS = Math.min(MAX_BLUR_TAPS, Math.ceil(SHADOW_BLUR_SIGMA * 3));
const SHADOW_WEIGHTS = (() => {
  const w: number[] = [];
  for (let i = 0; i <= MAX_BLUR_TAPS; i++) w.push(i <= SHADOW_BLUR_TAPS ? Math.exp(-(i * i) / (2 * SHADOW_BLUR_SIGMA * SHADOW_BLUR_SIGMA)) : 0);
  const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
  return new Float32Array(w.map((v) => v / total));
})();

let shadowMaxOffset = 14;
// SHADOW_MAX_OFFSET lives in shadows.ts; it's passed in to keep this module free
// of game imports.
export function setShadowMaxOffset(value: number): void {
  shadowMaxOffset = value;
}

// Layers that never render as tiles.
function isHiddenLayerName(name: string): boolean {
  const n = name ? name.toLowerCase() : "";
  return n.includes("collision") || n.includes("nopvp") || n.includes("no-pvp") || n.includes("shadow");
}

// Index of the segment a layer's zIndex falls into (see computeLayerCuts).
function segmentIndexForZ(z: number, cuts: LayerCut[]): number {
  let i = 0;
  while (i < cuts.length && z > cuts[i].key) i++;
  return i;
}

// z-sorted layer indices per chunk, cached on the layers array.
const sortedLayerCache = new WeakMap<any[], number[]>();
function sortedLayerIndices(layers: any[]): number[] {
  let order = sortedLayerCache.get(layers);
  if (!order || order.length !== layers.length) {
    order = layers.map((_, i) => i).sort((a, b) => Number(layers[a].zIndex) - Number(layers[b].zIndex));
    sortedLayerCache.set(layers, order);
  }
  return order;
}

interface Transform { scaleX: number; scaleY: number; translateX: number; translateY: number; width: number; height: number; flipY: number }

function useTileProgram(s: GLState, res: MapResources, t: Transform, clip: MapPassOptions["clip"]): void {
  const gl = s.gl;
  const p = s.tile;
  gl.useProgram(p.program);
  gl.uniform2f(p.u("uScale"), t.scaleX, t.scaleY);
  gl.uniform2f(p.u("uTranslate"), t.translateX, t.translateY);
  gl.uniform2f(p.u("uViewport"), t.width, t.height);
  gl.uniform1f(p.u("uFlipY"), t.flipY);
  gl.uniform2f(p.u("uTile"), res.tileWidth, res.tileHeight);
  gl.uniform1i(p.u("uRemapWidth"), res.remapWidth);
  gl.uniform1i(p.u("uRemapSize"), res.remapSize);
  gl.uniform1i(p.u("uAtlasCols"), res.atlasCols);
  gl.uniform1i(p.u("uAtlasRows"), res.atlasRows);
  gl.uniform4f(p.u("uClip"), clip.minX, clip.minY, clip.maxX, clip.maxY);
  gl.uniform1i(p.u("uChunk"), 0);
  gl.uniform1i(p.u("uRemap"), 1);
  gl.uniform1i(p.u("uAtlas"), 2);
  gl.uniform1i(p.u("uChunkBelow"), 3);
  gl.uniform1i(p.u("uYSort"), 0);
  gl.uniform1i(p.u("uHasBelow"), 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, res.remap);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, res.atlas);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindVertexArray(s.quad);
}

const sliceBuffer = new Int32Array(MAX_SLICES_PER_DRAW);

// Draw the given layer slices of one chunk (tile program already bound).
function drawChunkSlices(s: GLState, chunk: any, originX: number, originY: number, res: MapResources,
  slices: number[], alpha: number, silhouette: boolean): void {
  if (slices.length === 0) return;
  const gl = s.gl;
  // Chunk textures live on unit 0; an upload binds on the active unit.
  gl.activeTexture(gl.TEXTURE0);
  const gpu = getChunkTexture(s, chunk);
  if (!gpu) return;
  const p = s.tile;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
  gl.uniform2f(p.u("uOrigin"), originX, originY);
  gl.uniform2f(p.u("uSize"), gpu.width * res.tileWidth, gpu.height * res.tileHeight);
  gl.uniform2i(p.u("uChunkTiles"), gpu.width, gpu.height);
  gl.uniform1f(p.u("uAlpha"), alpha);
  gl.uniform1i(p.u("uSilhouette"), silhouette ? 1 : 0);
  for (let start = 0; start < slices.length; start += MAX_SLICES_PER_DRAW) {
    const count = Math.min(MAX_SLICES_PER_DRAW, slices.length - start);
    for (let i = 0; i < count; i++) sliceBuffer[i] = slices[start + i];
    gl.uniform1iv(p.u("uSlices"), sliceBuffer);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }
}

// Draw one chunk's y-sorted layers (tile program bound, occluders set). mode 1
// draws the pixels characters stand in front of (the 'below' pass), mode 2 the
// pixels covering a character standing behind the object (the 'above' pass).
function drawYSortLayers(s: GLState, res: MapResources, c: { data: any; x: number; y: number },
  slices: number[], mode: 1 | 2, alpha: number): void {
  const mapData = window.mapData;
  const gl = s.gl;
  const p = s.tile;
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  // Objects can continue into the chunk below; bind it so the base search can
  // follow the stack across the edge.
  const below = mapData.loadedChunks.get(`${c.x}-${c.y + 1}`);
  let belowGPU = null;
  if (below) {
    gl.activeTexture(gl.TEXTURE3);
    belowGPU = getChunkTexture(s, below);
    if (belowGPU) gl.bindTexture(gl.TEXTURE_2D_ARRAY, belowGPU.texture);
    gl.activeTexture(gl.TEXTURE0);
  }
  gl.uniform1i(p.u("uYSort"), mode);
  for (const slice of slices) {
    const name = c.data.layers[slice]?.name;
    const belowSlice = belowGPU && below.width === c.data.width
      ? below.layers.findIndex((l: any) => l?.name === name)
      : -1;
    gl.uniform1i(p.u("uHasBelow"), belowSlice >= 0 ? 1 : 0);
    gl.uniform1i(p.u("uBelowSlice"), Math.max(0, belowSlice));
    drawChunkSlices(s, c.data, c.x * chunkPixelSize, c.y * chunkPixelSize, res, [slice], alpha, false);
  }
  gl.uniform1i(p.u("uYSort"), 0);
  gl.uniform1i(p.u("uHasBelow"), 0);
}

// ---- Shadow framebuffers ----

interface ShadowTargets { width: number; height: number; tex: [WebGLTexture, WebGLTexture]; fbo: [WebGLFramebuffer, WebGLFramebuffer] }
let shadowTargets: ShadowTargets | null = null;
let shadowTargetsGL: WebGL2RenderingContext | null = null;

function getShadowTargets(s: GLState, width: number, height: number): ShadowTargets {
  const gl = s.gl;
  if (shadowTargets && shadowTargetsGL === gl && shadowTargets.width >= width && shadowTargets.height >= height) {
    return shadowTargets;
  }
  if (shadowTargets && shadowTargetsGL === gl) {
    for (const t of shadowTargets.tex) gl.deleteTexture(t);
    for (const f of shadowTargets.fbo) gl.deleteFramebuffer(f);
  }
  // Round up so small window resizes don't reallocate every time.
  const w = Math.ceil(width / 256) * 256;
  const h = Math.ceil(height / 256) * 256;
  const make = (): [WebGLTexture, WebGLFramebuffer] => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return [tex, fbo];
  };
  const a = make();
  const b = make();
  shadowTargets = { width: w, height: h, tex: [a[0], b[0]], fbo: [a[1], b[1]] };
  shadowTargetsGL = gl;
  return shadowTargets;
}

function bindTarget(s: GLState, fbo: WebGLFramebuffer, width: number, height: number): void {
  const gl = s.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, width, height);
  gl.scissor(0, 0, width, height);
}

// Render one shadow cut: silhouettes of the shadow layers at shadowZ, eroded at
// the base, blurred, then composited into the canvas pass as translucent black
// at the sun offset. Mirrors the old per-chunk bake, but in screen space, so
// shapes crossing chunk borders need no special handling.
function renderShadowCut(s: GLState, res: MapResources, opts: MapPassOptions, canvasT: Transform,
  shadowZ: number, shadow: ShadowParams, chunks: Array<{ key: string; data: any; x: number; y: number }>): void {
  const mapData = window.mapData;
  const names: string[] | null = mapData?.shadowLayerNames;
  if (!names || names.length === 0) return;
  const shadowNames = new Set(names.map((n) => n.toLowerCase()));

  // Visible world rect plus a margin wide enough for the sun offset, base trim
  // and blur, at one texel per world pixel (so the blur matches the old look
  // regardless of devicePixelRatio).
  const bottomTrim = shadowMaxOffset + 2;
  const pad = bottomTrim + 4;
  const worldLeft = -canvasT.translateX / canvasT.scaleX;
  const worldTop = -canvasT.translateY / canvasT.scaleY;
  const originX = Math.floor(worldLeft - pad);
  const originY = Math.floor(worldTop - pad);
  const width = Math.ceil(canvasT.width / canvasT.scaleX + pad * 2) + 1;
  const height = Math.ceil(canvasT.height / canvasT.scaleY + pad * 2) + 1;
  const targets = getShadowTargets(s, width, height);
  const gl = s.gl;

  // 1. Silhouettes into A.
  bindTarget(s, targets.fbo[0], width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const fboT: Transform = { scaleX: 1, scaleY: 1, translateX: -originX, translateY: -originY, width, height, flipY: 1 };
  useTileProgram(s, res, fboT, opts.clip);
  let any = false;
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  for (const c of chunks) {
    const layers: any[] = c.data.layers;
    const slices: number[] = [];
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l?.name && shadowNames.has(l.name.toLowerCase()) && Number(l.zIndex) === shadowZ) slices.push(i);
    }
    if (slices.length === 0) continue;
    any = true;
    drawChunkSlices(s, c.data, c.x * chunkPixelSize, c.y * chunkPixelSize, res, slices, 1, true);
  }
  if (!any) {
    // Nothing to shadow: leave the offscreen framebuffer and restore the canvas
    // pass state, or every later draw in this pass would land offscreen.
    beginCanvasRegion(s, canvasT.width, canvasT.height);
    useTileProgram(s, res, canvasT, opts.clip);
    return;
  }

  gl.disable(gl.BLEND);
  gl.bindVertexArray(s.quad);

  // 2. Erode the base: A -> B.
  bindTarget(s, targets.fbo[1], width, height);
  gl.useProgram(s.trim.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[0]);
  gl.uniform1i(s.trim.u("uSrc"), 0);
  gl.uniform1i(s.trim.u("uTrim"), bottomTrim);
  gl.uniform2i(s.trim.u("uSize"), width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // 3/4. Separable Gaussian blur: B -> A (horizontal), A -> B (vertical).
  gl.useProgram(s.blur.program);
  gl.uniform1i(s.blur.u("uSrc"), 0);
  gl.uniform1i(s.blur.u("uTaps"), SHADOW_BLUR_TAPS);
  gl.uniform1fv(s.blur.u("uWeights"), SHADOW_WEIGHTS);
  gl.uniform2i(s.blur.u("uSize"), width, height);
  bindTarget(s, targets.fbo[0], width, height);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[1]);
  gl.uniform2i(s.blur.u("uDir"), 1, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  bindTarget(s, targets.fbo[1], width, height);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[0]);
  gl.uniform2i(s.blur.u("uDir"), 0, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // 5. Composite into the canvas pass at the sun offset.
  beginCanvasRegion(s, canvasT.width, canvasT.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const p = s.shadowComposite;
  gl.useProgram(p.program);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[1]);
  gl.uniform1i(p.u("uShadow"), 0);
  gl.uniform1f(p.u("uAlpha"), shadow.alpha);
  gl.uniform4f(p.u("uClip"), opts.clip.minX, opts.clip.minY, opts.clip.maxX, opts.clip.maxY);
  // The framebuffer texture may be larger than the region rendered into.
  gl.uniform2f(p.u("uOrigin"), originX + shadow.offsetX, originY + shadow.offsetY);
  gl.uniform2f(p.u("uSize"), width, height);
  gl.uniform2f(p.u("uUvScale"), width / targets.width, height / targets.height);
  gl.uniform2f(p.u("uScale"), canvasT.scaleX, canvasT.scaleY);
  gl.uniform2f(p.u("uTranslate"), canvasT.translateX, canvasT.translateY);
  gl.uniform2f(p.u("uViewport"), canvasT.width, canvasT.height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Back to the tile program for the next segment.
  useTileProgram(s, res, canvasT, opts.clip);
}

// Re-target the canvas region without clearing it (after an offscreen pass).
function beginCanvasRegion(s: GLState, width: number, height: number): void {
  const gl = s.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const y = s.canvas.height - height;
  gl.viewport(0, y, width, height);
  gl.scissor(0, y, width, height);
}

function copyToTarget(s: GLState, target: CanvasRenderingContext2D, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number, identity: boolean): void {
  target.save();
  if (identity) target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = "source-over";
  target.drawImage(s.canvas, 0, 0, sw, sh, dx, dy, dw, dh);
  target.restore();
}

// Render the 'below' (under entities) or 'above' (over entities) map pass and
// draw it onto opts.target.
export function renderMapPass(opts: MapPassOptions): void {
  const s = getGL();
  const mapData = window.mapData;
  if (!s || !mapData) return;
  const res = getMapResources(s);
  if (!res) return;

  const gl = s.gl;
  if (opts.phase === "below") {
    // Once per frame: free chunks that left loadedChunks, advance animations.
    sweepChunks(s, mapData.loadedChunks);
    updateAnimations(s, res, opts.now);
  }

  const cuts = opts.cuts;
  let playerCutIndex = cuts.findIndex((c) => c.player);
  if (playerCutIndex === -1) playerCutIndex = cuts.length;
  const startSegment = opts.phase === "below" ? 0 : playerCutIndex + 1;
  const endSegment = opts.phase === "below" ? playerCutIndex : cuts.length;
  if (startSegment > endSegment) return;

  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  const chunks: Array<{ key: string; data: any; x: number; y: number }> = [];
  for (const v of opts.visibleChunks) {
    const key = `${v.x}-${v.y}`;
    const data = mapData.loadedChunks.get(key);
    if (data) chunks.push({ key, data, x: v.x, y: v.y });
  }
  if (chunks.length === 0) return;

  const target = opts.target;
  const width = target.canvas.width;
  const height = target.canvas.height;
  const m = target.getTransform();
  const canvasT: Transform = {
    scaleX: m.a,
    scaleY: m.d,
    translateX: m.a * opts.offsetX + m.e,
    translateY: m.d * opts.offsetY + m.f,
    width,
    height,
    flipY: -1,
  };

  // Layers at PLAYER_Z_INDEX (the player cut sits 0.5 below it) are y-sorted
  // against characters: split per pixel between the end of the 'below' pass and
  // the start of the 'above' pass instead of always covering characters.
  const ySortZ = playerCutIndex < cuts.length ? cuts[playerCutIndex].key + 0.5 : null;

  // Per chunk: which layer slices fall into each segment of this pass, and the
  // y-sorted layer slices.
  const perChunkSegments: Array<Map<number, number[]>> = [];
  const perChunkYSort: number[][] = [];
  for (const c of chunks) {
    const layers: any[] = c.data.layers || [];
    const bySegment = new Map<number, number[]>();
    const ySorted: number[] = [];
    for (const i of sortedLayerIndices(layers)) {
      const layer = layers[i];
      if (!layer || isHiddenLayerName(layer.name)) continue;
      if (opts.isLayerVisible && !opts.isLayerVisible(layer.name)) continue;
      const z = Number(layer.zIndex);
      if (z === ySortZ) {
        ySorted.push(i);
        continue;
      }
      const seg = segmentIndexForZ(z, cuts);
      if (seg < startSegment || seg > endSegment) continue;
      let list = bySegment.get(seg);
      if (!list) bySegment.set(seg, list = []);
      list.push(i);
    }
    perChunkSegments.push(bySegment);
    perChunkYSort.push(ySorted);
  }

  beginCanvasPass(s, width, height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  useTileProgram(s, res, canvasT, opts.clip);
  gl.uniform1i(s.tile.u("uOccluderCount"), packOccluders(opts.occluders));
  gl.uniform4fv(s.tile.u("uOccluders"), occluderBuffer);
  gl.uniform1fv(s.tile.u("uOccluderFeet"), occluderFeetBuffer);

  // Y-sorted layers, per chunk, at the given pass position.
  const drawYSorted = (mode: 1 | 2): boolean => {
    let any = false;
    for (let ci = 0; ci < chunks.length; ci++) {
      if (perChunkYSort[ci].length === 0) continue;
      const alpha = opts.chunkAlpha(chunks[ci].key);
      if (alpha <= 0) continue;
      drawYSortLayers(s, res, chunks[ci], perChunkYSort[ci], mode, alpha);
      any = true;
    }
    return any;
  };

  let drew = false;
  for (let segment = startSegment; segment <= endSegment; segment++) {
    // Over characters: the y-sorted layer is the lowest layer of the first
    // 'above' segment.
    if (opts.phase === "above" && segment === startSegment && drawYSorted(2)) drew = true;
    for (let ci = 0; ci < chunks.length; ci++) {
      const slices = perChunkSegments[ci].get(segment);
      if (!slices || slices.length === 0) continue;
      const c = chunks[ci];
      const alpha = opts.chunkAlpha(c.key);
      if (alpha <= 0) continue;
      drawChunkSlices(s, c.data, c.x * chunkPixelSize, c.y * chunkPixelSize, res, slices, alpha, false);
      drew = true;
    }
    if (segment < cuts.length && cuts[segment].shadowZ !== null && opts.shadow) {
      renderShadowCut(s, res, opts, canvasT, cuts[segment].shadowZ as number, opts.shadow, chunks);
      drew = true;
    }
  }
  // Under characters: on top of everything else in the 'below' pass.
  if (opts.phase === "below" && drawYSorted(1)) drew = true;

  gl.disable(gl.SCISSOR_TEST);
  if (drew) copyToTarget(s, target, width, height, 0, 0, width, height, true);
}

// Draw every tile layer of the loaded chunks covering the world rect onto the
// minimap buffer. Rendered at one pixel per world pixel and scaled into the
// destination by the 2D context (with its smoothing), like the old chunk
// canvases were.
export function renderMinimapMap(target: CanvasRenderingContext2D, worldLeft: number, worldTop: number,
  worldWidth: number, worldHeight: number, dx: number, dy: number, dw: number, dh: number,
  isLayerVisible: ((name: string) => boolean) | null): void {
  const s = getGL();
  const mapData = window.mapData;
  if (!s || !mapData) return;
  const res = getMapResources(s);
  if (!res) return;

  const width = Math.max(1, Math.ceil(worldWidth));
  const height = Math.max(1, Math.ceil(worldHeight));
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  const clip = {
    minX: (mapData.minTileX ?? 0) * mapData.tilewidth,
    minY: (mapData.minTileY ?? 0) * mapData.tileheight,
    maxX: mapData.width * mapData.tilewidth,
    maxY: mapData.height * mapData.tileheight,
  };
  const t: Transform = { scaleX: 1, scaleY: 1, translateX: -worldLeft, translateY: -worldTop, width, height, flipY: -1 };

  const gl = s.gl;
  beginCanvasPass(s, width, height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  useTileProgram(s, res, t, clip);

  let drew = false;
  for (const chunk of mapData.loadedChunks.values()) {
    const cx = chunk.chunkX * chunkPixelSize;
    const cy = chunk.chunkY * chunkPixelSize;
    const cw = chunk.width * mapData.tilewidth;
    const ch = chunk.height * mapData.tileheight;
    if (cx + cw < worldLeft || cx > worldLeft + worldWidth || cy + ch < worldTop || cy > worldTop + worldHeight) continue;
    const layers: any[] = chunk.layers || [];
    const slices: number[] = [];
    for (const i of sortedLayerIndices(layers)) {
      const layer = layers[i];
      if (!layer || isHiddenLayerName(layer.name)) continue;
      if (isLayerVisible && !isLayerVisible(layer.name)) continue;
      slices.push(i);
    }
    drawChunkSlices(s, chunk, cx, cy, res, slices, 1, false);
    drew = drew || slices.length > 0;
  }

  gl.disable(gl.SCISSOR_TEST);
  // The rendered region is rounded up to whole pixels, so it covers slightly
  // more world than requested; scale the destination to match.
  if (drew) copyToTarget(s, target, width, height, dx, dy, dw * (width / worldWidth), dh * (height / worldHeight), false);
}
