// GPU copies of the current map's data:
//  - the tile atlas: every tileset tile, scaled to the map tile size, packed
//    into the cells of a texture array (built once per map);
//  - the remap table: tile gid -> 1 + atlas cell currently shown for it (0 =
//    no tile). Animated tiles have their entry rewritten when the frame
//    changes, so animation costs nothing per drawn tile;
//  - one R32UI texture array per loaded chunk (one slice per layer) holding
//    the raw Tiled gids, flip bits included.

import { getGL, getGeneration, type GLState } from "./context.js";

interface AnimationFrame { tileid: number; duration: number }

interface AnimatedEntry {
  gid: number;
  frames: Array<{ cellPlus: number; duration: number }>;
  totalDuration: number;
  shown: number;
}

export interface MapResources {
  generation: number;
  tileWidth: number;
  tileHeight: number;
  atlas: WebGLTexture;
  atlasCols: number;
  atlasRows: number;
  remap: WebGLTexture;
  remapWidth: number;
  remapSize: number;
  animated: AnimatedEntry[];
}

interface ChunkGPU {
  generation: number;
  texture: WebGLTexture;
  width: number;
  height: number;
  layerCount: number;
  version: number;
}

let mapSource: { mapData: any; sources: Array<CanvasImageSource | null> } | null = null;
let mapResources: MapResources | null = null;

const chunkGPU = new Map<object, ChunkGPU>();
const chunkVersions = new WeakMap<object, number>();

// Tiled animations are expressed in the tileset's local tile ids.
function currentFrame(entry: AnimatedEntry, now: number): number {
  const frames = entry.frames;
  if (entry.totalDuration <= 0) return frames[0].cellPlus;
  let t = now % entry.totalDuration;
  for (const frame of frames) {
    if (t < frame.duration) return frame.cellPlus;
    t -= frame.duration;
  }
  return frames[frames.length - 1].cellPlus;
}

function freeMapResources(s: GLState | null): void {
  if (mapResources && s && mapResources.generation === getGeneration()) {
    s.gl.deleteTexture(mapResources.atlas);
    s.gl.deleteTexture(mapResources.remap);
  }
  mapResources = null;
}

function buildMapResources(s: GLState): MapResources | null {
  if (!mapSource) return null;
  const { mapData, sources } = mapSource;
  const gl = s.gl;
  const tw = mapData.tilewidth;
  const th = mapData.tileheight;

  // Every drawable tile, in gid order. A later tileset overwrites an earlier
  // one on overlapping gids, as the Canvas2D lookup map did.
  const tiles: Array<{ gid: number; source: CanvasImageSource; sx: number; sy: number; sw: number; sh: number }> = [];
  let maxGid = 0;
  for (let i = 0; i < mapData.tilesets.length; i++) {
    const ts = mapData.tilesets[i];
    const source = sources[i];
    if (!source) continue;
    const cols = Math.floor(ts.imagewidth / ts.tilewidth);
    if (cols <= 0) continue;
    for (let local = 0; local < ts.tilecount; local++) {
      const gid = ts.firstgid + local;
      tiles.push({
        gid,
        source,
        sx: (local % cols) * ts.tilewidth,
        sy: Math.floor(local / cols) * ts.tileheight,
        sw: ts.tilewidth,
        sh: ts.tileheight,
      });
      if (gid > maxGid) maxGid = gid;
    }
  }

  const maxSize = Math.min(s.maxTextureSize, 4096);
  const count = Math.max(1, tiles.length);
  const atlasCols = Math.max(1, Math.min(Math.floor(maxSize / tw), Math.ceil(Math.sqrt(count))));
  const atlasRows = Math.max(1, Math.min(Math.floor(maxSize / th), Math.ceil(count / atlasCols)));
  const perPage = atlasCols * atlasRows;
  const pages = Math.ceil(count / perPage);
  if (pages > s.maxArrayLayers) {
    console.error(`glmap: tile atlas needs ${pages} pages, GPU supports ${s.maxArrayLayers}`);
    return null;
  }

  const pageW = atlasCols * tw;
  const pageH = atlasRows * th;
  const atlas = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, pageW, pageH, pages);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Pack each page on a CPU canvas (nearest-neighbour scaling to the map tile
  // size, like the old drawRotatedTile path), then upload it premultiplied.
  const pageCanvas = document.createElement("canvas");
  pageCanvas.width = pageW;
  pageCanvas.height = pageH;
  const pageCtx = pageCanvas.getContext("2d", { willReadFrequently: true })!;
  const remapSize = maxGid + 1;
  const remapWidth = Math.min(4096, Math.max(1, remapSize));
  const remapRows = Math.ceil(remapSize / remapWidth);
  const remapData = new Uint32Array(remapWidth * remapRows);

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  for (let page = 0; page < pages; page++) {
    pageCtx.clearRect(0, 0, pageW, pageH);
    pageCtx.imageSmoothingEnabled = false;
    const start = page * perPage;
    const end = Math.min(tiles.length, start + perPage);
    for (let cell = start; cell < end; cell++) {
      const tile = tiles[cell];
      const within = cell - start;
      try {
        pageCtx.drawImage(tile.source, tile.sx, tile.sy, tile.sw, tile.sh,
          (within % atlasCols) * tw, Math.floor(within / atlasCols) * th, tw, th);
      } catch {
        continue;
      }
      remapData[tile.gid] = cell + 1;
    }
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, page, pageW, pageH, 1, gl.RGBA, gl.UNSIGNED_BYTE, pageCanvas);
  }
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  pageCanvas.width = 0;
  pageCanvas.height = 0;

  // Animated tiles (Tiled `tiles[].animation`), resolved to atlas cells.
  const animated: AnimatedEntry[] = [];
  for (let i = 0; i < mapData.tilesets.length; i++) {
    const ts = mapData.tilesets[i];
    if (!sources[i] || !Array.isArray(ts.tiles)) continue;
    for (const tile of ts.tiles) {
      const anim: AnimationFrame[] | undefined = tile.animation;
      if (!Array.isArray(anim) || anim.length === 0) continue;
      const frames = anim.map((frame) => ({
        cellPlus: remapData[ts.firstgid + frame.tileid] ?? 0,
        duration: frame.duration || 0,
      }));
      const gid = ts.firstgid + tile.id;
      if (gid >= remapSize) continue;
      animated.push({
        gid,
        frames,
        totalDuration: frames.reduce((sum, f) => sum + f.duration, 0),
        shown: remapData[gid],
      });
    }
  }

  const remap = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, remap);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, remapWidth, remapRows);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, remapWidth, remapRows, gl.RED_INTEGER, gl.UNSIGNED_INT, remapData);

  return {
    generation: getGeneration(),
    tileWidth: tw,
    tileHeight: th,
    atlas,
    atlasCols,
    atlasRows,
    remap,
    remapWidth,
    remapSize,
    animated,
  };
}

// Called by loadMap once the tilesets are decoded. `sources` is parallel to
// mapData.tilesets (null for a tileset whose image failed to load).
export function setMap(mapData: any, sources: Array<CanvasImageSource | null>): void {
  const s = getGL();
  freeMapResources(s);
  releaseAllChunks();
  mapSource = { mapData, sources };
  if (s) mapResources = buildMapResources(s);
}

// Current map resources, rebuilt after a context restore.
export function getMapResources(s: GLState): MapResources | null {
  if (mapResources && mapResources.generation === getGeneration()) return mapResources;
  if (!mapSource || mapSource.mapData !== window.mapData) return null;
  mapResources = buildMapResources(s);
  return mapResources;
}

// Advance animated tiles to the frame for `now` (ms), uploading only entries
// whose frame changed.
export function updateAnimations(s: GLState, res: MapResources, now: number): void {
  if (res.animated.length === 0) return;
  const gl = s.gl;
  const texel = new Uint32Array(1);
  let bound = false;
  for (const entry of res.animated) {
    const cellPlus = currentFrame(entry, now);
    if (cellPlus === entry.shown) continue;
    entry.shown = cellPlus;
    if (!bound) {
      gl.bindTexture(gl.TEXTURE_2D, res.remap);
      bound = true;
    }
    texel[0] = cellPlus;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, entry.gid % res.remapWidth, Math.floor(entry.gid / res.remapWidth),
      1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, texel);
  }
}

// Mark a chunk's tile data as changed (editor paint, undo, restored snapshot);
// it is re-uploaded the next time it is drawn.
export function invalidateChunk(chunk: object): void {
  chunkVersions.set(chunk, (chunkVersions.get(chunk) ?? 0) + 1);
}

// The chunk's tile-id texture, uploaded (or re-uploaded) on demand.
export function getChunkTexture(s: GLState, chunk: any): ChunkGPU | null {
  const width = chunk.width | 0;
  const height = chunk.height | 0;
  const layers: any[] = Array.isArray(chunk.layers) ? chunk.layers : [];
  if (width <= 0 || height <= 0 || layers.length === 0) return null;

  const gl = s.gl;
  const version = chunkVersions.get(chunk) ?? 0;
  let entry = chunkGPU.get(chunk);
  if (entry && entry.generation !== getGeneration()) {
    chunkGPU.delete(chunk);
    entry = undefined;
  }
  if (entry && entry.version === version && entry.width === width &&
      entry.height === height && entry.layerCount === layers.length) {
    return entry;
  }

  const cells = width * height;
  const data = new Uint32Array(cells * layers.length);
  for (let li = 0; li < layers.length; li++) {
    const src = layers[li]?.data;
    if (!src) continue;
    const base = li * cells;
    const n = Math.min(cells, src.length);
    for (let i = 0; i < n; i++) data[base + i] = src[i] >>> 0;
  }

  if (!entry || entry.width !== width || entry.height !== height || entry.layerCount !== layers.length) {
    if (entry) gl.deleteTexture(entry.texture);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32UI, width, height, layers.length);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    entry = { generation: getGeneration(), texture, width, height, layerCount: layers.length, version };
    chunkGPU.set(chunk, entry);
  } else {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, entry.texture);
    entry.version = version;
  }
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, layers.length,
    gl.RED_INTEGER, gl.UNSIGNED_INT, data);
  return entry;
}

// Free textures of chunks that are no longer in loadedChunks. loadedChunks is
// mutated from many places (unload, map change, RELOAD_CHUNKS, editor), so the
// GPU side reconciles against it instead of relying on unload hooks.
export function sweepChunks(s: GLState, loadedChunks: Map<string, any> | undefined): void {
  if (chunkGPU.size === 0) return;
  const live = new Set<object>(loadedChunks ? loadedChunks.values() : []);
  for (const [chunk, entry] of chunkGPU) {
    if (live.has(chunk)) continue;
    if (entry.generation === getGeneration()) s.gl.deleteTexture(entry.texture);
    chunkGPU.delete(chunk);
  }
}

function releaseAllChunks(): void {
  const s = getGL();
  for (const entry of chunkGPU.values()) {
    if (s && entry.generation === getGeneration()) s.gl.deleteTexture(entry.texture);
  }
  chunkGPU.clear();
}
