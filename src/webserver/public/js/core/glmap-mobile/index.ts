// Mobile map renderer, used only when renderpath.ts selects it (iOS/Android,
// or ?renderer=mobile). Desktop uses ../glmap/. Each map pass renders into its
// own WebGL canvas placed in the page (#map-below / #map-above / #minimap-map)
// at a whole-number scale, so there are no canvas->canvas copies.
import { getGL, getSurfaceCanvas, beginCanvasPass } from "./context.js";
import { getMapResources, getChunkTexture, chunkNeedsUpload, sweepChunks, updateAnimations } from "./resources.js";
import { MAX_SLICES_PER_DRAW, MAX_BLUR_TAPS, MAX_OCCLUDERS } from "./shaders.js";

export { setMap, invalidateChunk } from "./resources.js";

function packOccluders(occluders: any) {
  const count = Math.min(MAX_OCCLUDERS, occluders.length);
  for (let i = 0;i < count; i++) {
    const o = occluders[i];
    occluderBuffer[i * 4] = o[0];
    occluderBuffer[i * 4 + 1] = o[1];
    occluderBuffer[i * 4 + 2] = o[2];
    occluderBuffer[i * 4 + 3] = o[3];
    occluderFeetBuffer[i] = o[4];
  }
  return count;
}
export function setShadowMaxOffset(value: any) {
  shadowMaxOffset = value;
}
function isHiddenLayerName(name: any) {
  const n = name ? name.toLowerCase() : "";
  return n.includes("collision") || n.includes("nopvp") || n.includes("no-pvp") || n.includes("shadow");
}
function segmentIndexForZ(z: any, cuts: any) {
  let i = 0;
  while (i < cuts.length && z > cuts[i].key)
    i++;
  return i;
}
function sortedLayerIndices(layers: any) {
  let order = sortedLayerCache.get(layers);
  if (!order || order.length !== layers.length) {
    order = layers.map((_: any, i: any) => i).sort((a: any, b: any) => Number(layers[a].zIndex) - Number(layers[b].zIndex));
    sortedLayerCache.set(layers, order);
  }
  return order;
}
function useTileProgram(s: any, res: any, t: any, clip: any) {
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
// Puts one chunk on the GPU, and no more: of those given that are not there yet (or have changed), the one nearest
// the middle of the view. The others wait for the passes after it, one each, and are not drawn until their turn
// (one that has changed is drawn as it was). See getChunkTexture (resources.ts) for why: a row of new chunks
// prepared in one frame was a stutter on a phone. Chunks are asked for a whole chunk beyond the screen's edge, so
// walking finds them ready before they come into sight.
function uploadOneChunk(s: any, chunks: any, centreX: any, centreY: any, chunkPixelSize: any) {
  let next = null;
  let nearest = Infinity;
  for (const c of chunks) {
    if (!chunkNeedsUpload(s, c.data))
      continue;
    const distance = Math.hypot((c.x + 0.5) * chunkPixelSize - centreX, (c.y + 0.5) * chunkPixelSize - centreY);
    if (distance < nearest) {
      nearest = distance;
      next = c.data;
    }
  }
  if (next)
    getChunkTexture(s, next, true);
}
function drawChunkSlices(s: any, chunk: any, originX: any, originY: any, res: any, slices: any, alpha: any, silhouette: any) {
  if (slices.length === 0)
    return;
  const gl = s.gl;
  gl.activeTexture(gl.TEXTURE0);
  const gpu = getChunkTexture(s, chunk, false);
  if (!gpu)
    return;
  const p = s.tile;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, gpu.texture);
  gl.uniform2f(p.u("uOrigin"), originX, originY);
  gl.uniform2f(p.u("uSize"), gpu.width * res.tileWidth, gpu.height * res.tileHeight);
  gl.uniform2i(p.u("uChunkTiles"), gpu.width, gpu.height);
  gl.uniform1f(p.u("uAlpha"), alpha);
  gl.uniform1i(p.u("uSilhouette"), silhouette ? 1 : 0);
  for (let start = 0;start < slices.length; start += MAX_SLICES_PER_DRAW) {
    const count = Math.min(MAX_SLICES_PER_DRAW, slices.length - start);
    for (let i = 0;i < count; i++)
      sliceBuffer[i] = slices[start + count - 1 - i];
    gl.uniform1iv(p.u("uLayers"), sliceBuffer);
    gl.uniform1i(p.u("uLayerCount"), count);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
function drawYSortLayers(s: any, res: any, c: any, slices: any, mode: any, alpha: any) {
  const mapData = window.mapData;
  const gl = s.gl;
  const p = s.tile;
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  const below = mapData.loadedChunks.get(`${c.x}-${c.y + 1}`);
  let belowGPU = null;
  if (below) {
    gl.activeTexture(gl.TEXTURE3);
    belowGPU = getChunkTexture(s, below, false);
    if (belowGPU)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, belowGPU.texture);
    gl.activeTexture(gl.TEXTURE0);
  }
  gl.uniform1i(p.u("uYSort"), mode);
  for (const slice of slices) {
    const name = c.data.layers[slice]?.name;
    const belowSlice = belowGPU && below.width === c.data.width ? below.layers.findIndex((l: any) => l?.name === name) : -1;
    gl.uniform1i(p.u("uHasBelow"), belowSlice >= 0 ? 1 : 0);
    gl.uniform1i(p.u("uBelowSlice"), Math.max(0, belowSlice));
    drawChunkSlices(s, c.data, c.x * chunkPixelSize, c.y * chunkPixelSize, res, [slice], alpha, false);
  }
  gl.uniform1i(p.u("uYSort"), 0);
  gl.uniform1i(p.u("uHasBelow"), 0);
}
function getShadowTargets(s: any, width: any, height: any) {
  const gl = s.gl;
  let shadowTargets = shadowTargetsBySurface.get(s.id);
  if (shadowTargets && shadowTargets.generation !== s.generation)
    shadowTargets = undefined;
  if (shadowTargets && shadowTargets.width >= width && shadowTargets.height >= height) {
    return shadowTargets;
  }
  if (shadowTargets) {
    for (const t of shadowTargets.tex)
      gl.deleteTexture(t);
    for (const f of shadowTargets.fbo)
      gl.deleteFramebuffer(f);
  }
  const w = Math.ceil(width / 256) * 256;
  const h = Math.ceil(height / 256) * 256;
  const make = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error(`glmap: shadow framebuffer ${w}x${h} incomplete (0x${status.toString(16)})`);
    }
    return [tex, fbo];
  };
  const a = make();
  const b = make();
  shadowTargets = { generation: s.generation, width: w, height: h, tex: [a[0], b[0]], fbo: [a[1], b[1]] };
  shadowTargetsBySurface.set(s.id, shadowTargets);
  return shadowTargets;
}
function bindTarget(s: any, fbo: any, width: any, height: any) {
  const gl = s.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, width, height);
  gl.scissor(0, 0, width, height);
}
function renderShadowCut(s: any, res: any, opts: any, canvasT: any, shadowZ: any, shadow: any, chunks: any) {
  const mapData = window.mapData;
  const names = mapData?.shadowLayerNames;
  if (!names || names.length === 0)
    return;
  const shadowNames = new Set(names.map((n: any) => n.toLowerCase()));
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
  bindTarget(s, targets.fbo[0], width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const fboT = { scaleX: 1, scaleY: 1, translateX: -originX, translateY: -originY, width, height, flipY: 1 };
  useTileProgram(s, res, fboT, opts.clip);
  let any = false;
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  for (const c of chunks) {
    const layers = c.data.layers;
    const slices = [];
    for (let i = 0;i < layers.length; i++) {
      const l = layers[i];
      if (l?.name && shadowNames.has(l.name.toLowerCase()) && Number(l.zIndex) === shadowZ)
        slices.push(i);
    }
    if (slices.length === 0)
      continue;
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
  bindTarget(s, targets.fbo[1], width, height);
  gl.useProgram(s.trim.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[0]);
  gl.uniform1i(s.trim.u("uSrc"), 0);
  gl.uniform1i(s.trim.u("uTrim"), bottomTrim);
  gl.uniform2i(s.trim.u("uSize"), width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
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
  beginCanvasRegion(s, canvasT.width, canvasT.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const p = s.shadowComposite;
  gl.useProgram(p.program);
  gl.bindTexture(gl.TEXTURE_2D, targets.tex[1]);
  gl.uniform1i(p.u("uShadow"), 0);
  gl.uniform1f(p.u("uAlpha"), shadow.alpha);
  gl.uniform4f(p.u("uClip"), opts.clip.minX, opts.clip.minY, opts.clip.maxX, opts.clip.maxY);
  gl.uniform2f(p.u("uOrigin"), originX + shadow.offsetX, originY + shadow.offsetY);
  gl.uniform2f(p.u("uSize"), width, height);
  gl.uniform2f(p.u("uUvScale"), width / targets.width, height / targets.height);
  gl.uniform2f(p.u("uScale"), canvasT.scaleX, canvasT.scaleY);
  gl.uniform2f(p.u("uTranslate"), canvasT.translateX, canvasT.translateY);
  gl.uniform2f(p.u("uViewport"), canvasT.width, canvasT.height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  useTileProgram(s, res, canvasT, opts.clip);
}
function beginCanvasRegion(s: any, width: any, height: any) {
  const gl = s.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.scissor(0, 0, width, height);
}
function placeSurface(s: any, anchor: any, id: any, background: any, backingW: any, backingH: any, scaleToAnchor: any) {
  const c = s.canvas;
  const style = c.style;
  if (c.parentNode !== anchor.parentNode || c.nextSibling !== anchor) {
    anchor.parentNode?.insertBefore(c, anchor);
    c.id = id;
    style.position = "fixed";
    style.top = "0";
    style.left = "0";
    style.margin = "0";
    style.padding = "0";
    style.pointerEvents = "none";
    style.background = background;
    const z = getComputedStyle(anchor).zIndex;
    style.zIndex = z === "auto" ? "" : z;
  }
  const cssPerAnchorPx = (parseFloat(anchor.style.width) || anchor.clientWidth) / anchor.width;
  const width = `${backingW * scaleToAnchor * cssPerAnchorPx}px`;
  const height = `${backingH * scaleToAnchor * cssPerAnchorPx}px`;
  if (style.width !== width)
    style.width = width;
  if (style.height !== height)
    style.height = height;
  if (style.filter !== anchor.style.filter)
    style.filter = anchor.style.filter;
}
export function setMapVisible(visible: any) {
  if (visible === mapVisible)
    return;
  mapVisible = visible;
  for (const id of ["below", "above"]) {
    const canvas = getSurfaceCanvas(id);
    if (canvas)
      canvas.style.display = visible ? "" : "none";
  }
}
export function renderMapPass(opts: any) {
  const mapData = window.mapData;
  const s = getGL(opts.phase);
  if (!s || !mapData)
    return;
  const target = opts.target;
  const m = target.getTransform();
  const intScale = Math.max(1, Math.ceil(m.a - 0.001));
  const toTarget = m.a / intScale;
  const width = Math.ceil(target.canvas.width / toTarget);
  const height = Math.ceil(target.canvas.height / toTarget);
  placeSurface(s, target.canvas, `map-${opts.phase}`, opts.phase === "below" ? "#000" : "transparent", width, height, toTarget);
  const gl = s.gl;
  beginCanvasPass(s, width, height);
  const finish = () => gl.disable(gl.SCISSOR_TEST);
  const res = getMapResources(s);
  if (!res)
    return finish();
  sweepChunks(s, mapData.loadedChunks);
  updateAnimations(s, res, opts.now);
  const cuts = opts.cuts;
  let playerCutIndex = cuts.findIndex((c: any) => c.player);
  if (playerCutIndex === -1)
    playerCutIndex = cuts.length;
  const startSegment = opts.phase === "below" ? 0 : playerCutIndex + 1;
  const endSegment = opts.phase === "below" ? playerCutIndex : cuts.length;
  if (startSegment > endSegment)
    return finish();
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  const chunks: any = [];
  for (const v of opts.visibleChunks) {
    const key = `${v.x}-${v.y}`;
    const data = mapData.loadedChunks.get(key);
    if (data)
      chunks.push({ key, data, x: v.x, y: v.y });
  }
  if (chunks.length === 0)
    return finish();
  const canvasT = {
    scaleX: intScale,
    scaleY: m.d / toTarget,
    translateX: (m.a * opts.offsetX + m.e) / toTarget,
    translateY: (m.d * opts.offsetY + m.f) / toTarget,
    width,
    height,
    flipY: -1
  };
  const ySortZ = playerCutIndex < cuts.length ? cuts[playerCutIndex].key + 0.5 : null;
  const perChunkSegments: any = [];
  const perChunkYSort: any = [];
  for (const c of chunks) {
    const layers = c.data.layers || [];
    const bySegment = new Map;
    const ySorted = [];
    for (const i of sortedLayerIndices(layers)) {
      const layer = layers[i];
      if (!layer || isHiddenLayerName(layer.name))
        continue;
      if (opts.isLayerVisible && !opts.isLayerVisible(layer.name))
        continue;
      const z = Number(layer.zIndex);
      if (z === ySortZ) {
        ySorted.push(i);
        continue;
      }
      const seg = segmentIndexForZ(z, cuts);
      if (seg < startSegment || seg > endSegment)
        continue;
      let list = bySegment.get(seg);
      if (!list)
        bySegment.set(seg, list = []);
      list.push(i);
    }
    perChunkSegments.push(bySegment);
    perChunkYSort.push(ySorted);
  }
  // Only chunks this pass draws something of are put on its GPU: a map with nothing over the players keeps none on
  // the surface over them. (A shadow is drawn from layers of its own, not counted above: with one in this pass,
  // every chunk is taken.)
  let shadowInPass = false;
  for (let segment = startSegment;segment <= endSegment && segment < cuts.length; segment++) {
    if (cuts[segment].shadowZ !== null && opts.shadow)
      shadowInPass = true;
  }
  uploadOneChunk(s, shadowInPass ? chunks : chunks.filter((_: any, ci: any) => perChunkSegments[ci].size > 0 || perChunkYSort[ci].length > 0),
    (width / 2 - canvasT.translateX) / canvasT.scaleX, (height / 2 - canvasT.translateY) / canvasT.scaleY, chunkPixelSize);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  useTileProgram(s, res, canvasT, opts.clip);
  gl.uniform1i(s.tile.u("uOccluderCount"), packOccluders(opts.occluders));
  gl.uniform4fv(s.tile.u("uOccluders"), occluderBuffer);
  gl.uniform1fv(s.tile.u("uOccluderFeet"), occluderFeetBuffer);
  const drawYSorted = (mode: any) => {
    for (let ci = 0;ci < chunks.length; ci++) {
      if (perChunkYSort[ci].length === 0)
        continue;
      const alpha = opts.chunkAlpha(chunks[ci].key);
      if (alpha <= 0)
        continue;
      drawYSortLayers(s, res, chunks[ci], perChunkYSort[ci], mode, alpha);
    }
  };
  for (let segment = startSegment;segment <= endSegment; segment++) {
    if (opts.phase === "above" && segment === startSegment)
      drawYSorted(2);
    for (let ci = 0;ci < chunks.length; ci++) {
      const slices = perChunkSegments[ci].get(segment);
      if (!slices || slices.length === 0)
        continue;
      const c = chunks[ci];
      const alpha = opts.chunkAlpha(c.key);
      if (alpha <= 0)
        continue;
      drawChunkSlices(s, c.data, c.x * chunkPixelSize, c.y * chunkPixelSize, res, slices, alpha, false);
    }
    if (segment < cuts.length && cuts[segment].shadowZ !== null && opts.shadow) {
      renderShadowCut(s, res, opts, canvasT, cuts[segment].shadowZ, opts.shadow, chunks);
    }
  }
  if (opts.phase === "below")
    drawYSorted(1);
  finish();
}
function placeMinimapSurface(s: any, anchor: any) {
  const c = s.canvas;
  if (c.parentNode === anchor.parentNode && c.nextSibling === anchor)
    return;
  anchor.parentNode?.insertBefore(c, anchor);
  c.id = "minimap-map";
  c.style.zIndex = "0";
  c.style.pointerEvents = "none";
  c.style.clipPath = "circle(48.8%)";
}
export function renderMinimapMap(anchor: any, worldLeft: any, worldTop: any, worldWidth: any, worldHeight: any, isLayerVisible: any) {
  const mapData = window.mapData;
  const s = getGL("minimap");
  if (!s || !mapData)
    return;
  placeMinimapSurface(s, anchor);
  const gl = s.gl;
  const width = Math.max(1, Math.ceil(worldWidth));
  const height = Math.max(1, Math.ceil(worldHeight));
  beginCanvasPass(s, width, height, [10 / 255, 10 / 255, 10 / 255, 1]);
  const finish = () => gl.disable(gl.SCISSOR_TEST);
  const res = getMapResources(s);
  if (!res)
    return finish();
  sweepChunks(s, mapData.loadedChunks);
  updateAnimations(s, res, performance.now());
  const chunkPixelSize = mapData.chunkSize * mapData.tilewidth;
  const clip = {
    minX: (mapData.minTileX ?? 0) * mapData.tilewidth,
    minY: (mapData.minTileY ?? 0) * mapData.tileheight,
    maxX: mapData.width * mapData.tilewidth,
    maxY: mapData.height * mapData.tileheight
  };
  const scaleX = width / worldWidth;
  const scaleY = height / worldHeight;
  const t = { scaleX, scaleY, translateX: -worldLeft * scaleX, translateY: -worldTop * scaleY, width, height, flipY: -1 };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  useTileProgram(s, res, t, clip);
  const inView = [];
  for (const chunk of mapData.loadedChunks.values()) {
    const cx = chunk.chunkX * chunkPixelSize;
    const cy = chunk.chunkY * chunkPixelSize;
    const cw = chunk.width * mapData.tilewidth;
    const ch = chunk.height * mapData.tileheight;
    if (cx + cw < worldLeft || cx > worldLeft + worldWidth || cy + ch < worldTop || cy > worldTop + worldHeight)
      continue;
    inView.push({ data: chunk, x: chunk.chunkX, y: chunk.chunkY });
  }
  uploadOneChunk(s, inView, worldLeft + worldWidth / 2, worldTop + worldHeight / 2, chunkPixelSize);
  for (const { data: chunk } of inView) {
    const cx = chunk.chunkX * chunkPixelSize;
    const cy = chunk.chunkY * chunkPixelSize;
    const layers = chunk.layers || [];
    const slices = [];
    for (const i of sortedLayerIndices(layers)) {
      const layer = layers[i];
      if (!layer || isHiddenLayerName(layer.name))
        continue;
      if (isLayerVisible && !isLayerVisible(layer.name))
        continue;
      slices.push(i);
    }
    drawChunkSlices(s, chunk, cx, cy, res, slices, 1, false);
  }
  finish();
}
let shadowMaxOffset = 14, mapVisible = true;
const occluderBuffer = new Float32Array(MAX_OCCLUDERS * 4);
const occluderFeetBuffer = new Float32Array(MAX_OCCLUDERS);
const SHADOW_BLUR_SIGMA = 2;
const SHADOW_BLUR_TAPS = Math.min(MAX_BLUR_TAPS, Math.ceil(SHADOW_BLUR_SIGMA * 3));
const SHADOW_WEIGHTS = (() => {
  const w = [];
  for (let i = 0;i <= MAX_BLUR_TAPS; i++)
    w.push(i <= SHADOW_BLUR_TAPS ? Math.exp(-(i * i) / (2 * SHADOW_BLUR_SIGMA * SHADOW_BLUR_SIGMA)) : 0);
  const total = w[0] + 2 * w.slice(1).reduce((a, b) => a + b, 0);
  return new Float32Array(w.map((v) => v / total));
})();
const sortedLayerCache: WeakMap<any, any> = new WeakMap();
const sliceBuffer = new Int32Array(MAX_SLICES_PER_DRAW);
const shadowTargetsBySurface: Map<any, any> = new Map();
