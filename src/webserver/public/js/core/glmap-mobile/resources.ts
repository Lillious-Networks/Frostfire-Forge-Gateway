import { getAllGL } from "./context.js";

function resourcesFor(s: any) {
  let r = surfaceResources.get(s.id);
  if (!r || r.generation !== s.generation) {
    r = { generation: s.generation, map: null, failed: false, chunks: new Map };
    surfaceResources.set(s.id, r);
  }
  return r;
}
function currentFrame(entry: any, now: any) {
  const frames = entry.frames;
  if (entry.totalDuration <= 0)
    return frames[0].cellPlus;
  let t = now % entry.totalDuration;
  for (const frame of frames) {
    if (t < frame.duration)
      return frame.cellPlus;
    t -= frame.duration;
  }
  return frames[frames.length - 1].cellPlus;
}
function freeMapResources(s: any) {
  const r = resourcesFor(s);
  if (r.map) {
    s.gl.deleteTexture(r.map.atlas);
    s.gl.deleteTexture(r.map.remap);
  }
  r.map = null;
  r.failed = false;
}
function createAtlasTexture(s: any, width: any, height: any, pages: any) {
  const gl = s.gl;
  const atlas = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, atlas);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, pages);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return atlas;
}
function buildMapResources(s: any) {
  if (!mapSource)
    return null;
  const { mapData, sources } = mapSource;
  const gl = s.gl;
  gl.getError();
  const tw = mapData.tilewidth;
  const th = mapData.tileheight;
  let maxGid = 0;
  for (let i = 0;i < mapData.tilesets.length; i++) {
    const ts = mapData.tilesets[i];
    if (sources[i])
      maxGid = Math.max(maxGid, ts.firstgid + ts.tilecount - 1);
  }
  const remapSize = maxGid + 1;
  const tileSources = new Array(remapSize);
  const animDefs = new Map;
  for (let i = 0;i < mapData.tilesets.length; i++) {
    const ts = mapData.tilesets[i];
    const source = sources[i];
    if (!source)
      continue;
    const cols = Math.floor(ts.imagewidth / ts.tilewidth);
    if (cols <= 0)
      continue;
    for (let local = 0;local < ts.tilecount; local++) {
      tileSources[ts.firstgid + local] = {
        source,
        sx: local % cols * ts.tilewidth,
        sy: Math.floor(local / cols) * ts.tileheight,
        sw: ts.tilewidth,
        sh: ts.tileheight
      };
    }
    if (!Array.isArray(ts.tiles))
      continue;
    for (const tile of ts.tiles) {
      const anim = tile.animation;
      if (!Array.isArray(anim) || anim.length === 0)
        continue;
      animDefs.set(ts.firstgid + tile.id, anim.map((frame) => ({
        gid: ts.firstgid + frame.tileid,
        duration: frame.duration || 0
      })));
    }
  }
  const pageSize = Math.min(s.maxTextureSize, ATLAS_PAGE_SIZE);
  const atlasCols = Math.max(1, Math.floor(pageSize / tw));
  const atlasRows = Math.max(1, Math.floor(pageSize / th));
  const atlas = createAtlasTexture(s, atlasCols * tw, atlasRows * th, 1);
  const remapWidth = Math.min(4096, Math.max(1, remapSize));
  const remapRows = Math.ceil(remapSize / remapWidth);
  const remapData = new Uint32Array(remapWidth * remapRows);
  const remap = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, remap);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, remapWidth, remapRows);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, remapWidth, remapRows, gl.RED_INTEGER, gl.UNSIGNED_INT, remapData);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    console.error(`glmap: map texture setup failed (GL error 0x${error.toString(16)}; atlas page ${atlasCols * tw}x${atlasRows * th}, remap ${remapWidth}x${remapRows})`);
  }
  return {
    generation: s.generation,
    tileWidth: tw,
    tileHeight: th,
    atlas,
    atlasCols,
    atlasRows,
    atlasPages: 1,
    nextCell: 0,
    cellOf: new Int32Array(remapSize).fill(-1),
    sources: tileSources,
    animDefs,
    remap,
    remapWidth,
    remapSize,
    remapData,
    animated: []
  };
}
function growAtlas(s: any, res: any, cells: any) {
  const gl = s.gl;
  const perPage = res.atlasCols * res.atlasRows;
  let pages = res.atlasPages;
  while (pages * perPage < cells)
    pages *= 2;
  pages = Math.min(pages, s.maxArrayLayers);
  if (pages * perPage < cells) {
    console.error(`glmap: tile atlas full (${res.atlasPages} pages, GPU limit ${s.maxArrayLayers})`);
    return false;
  }
  const pageW = res.atlasCols * res.tileWidth;
  const pageH = res.atlasRows * res.tileHeight;
  const next = createAtlasTexture(s, pageW, pageH, pages);
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
  for (let page = 0;page < res.atlasPages; page++) {
    gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, res.atlas, 0, page);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, page, 0, 0, pageW, pageH);
  }
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(res.atlas);
  res.atlas = next;
  res.atlasPages = pages;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, next);
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT_OFFSET);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, next);
  return true;
}
function packTiles(s: any, res: any, gids: any) {
  const gl = s.gl;
  if (res.nextCell + gids.length > res.atlasPages * res.atlasCols * res.atlasRows && !growAtlas(s, res, res.nextCell + gids.length)) {
    return;
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, res.atlas);
  const tw = res.tileWidth;
  const th = res.tileHeight;
  const cols = res.atlasCols;
  const perPage = cols * res.atlasRows;
  const pageW = cols * tw;
  const first = res.nextCell;
  res.nextCell += gids.length;
  for (let i = 0;i < gids.length; i++)
    res.cellOf[gids[i]] = first + i;
  if (!stagingCanvas) {
    stagingCanvas = document.createElement("canvas");
    stagingCtx = stagingCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!stagingCtx) {
    console.error("glmap: could not create the tile staging canvas");
    return;
  }
  let i = 0;
  while (i < gids.length) {
    const page = Math.floor((first + i) / perPage);
    const pageEnd = Math.min(gids.length, (page + 1) * perPage - first);
    const rowStart = Math.floor((first + i - page * perPage) / cols);
    const rowEnd = Math.floor((first + pageEnd - 1 - page * perPage) / cols);
    const bandH = (rowEnd - rowStart + 1) * th;
    if (stagingCanvas.width < pageW || stagingCanvas.height < bandH) {
      stagingCanvas.width = Math.max(stagingCanvas.width, pageW);
      stagingCanvas.height = Math.max(stagingCanvas.height, bandH);
    }
    stagingCtx.clearRect(0, 0, pageW, bandH);
    stagingCtx.imageSmoothingEnabled = false;
    for (let k = i;k < pageEnd; k++) {
      const within = first + k - page * perPage;
      const tile = res.sources[gids[k]];
      try {
        stagingCtx.drawImage(tile.source, tile.sx, tile.sy, tile.sw, tile.sh, within % cols * tw, (Math.floor(within / cols) - rowStart) * th, tw, th);
      } catch { /* skip a tile whose image failed to load */ }
    }
    const pixels = stagingCtx.getImageData(0, 0, pageW, bandH).data;
    for (let p = 0;p < pixels.length; p += 4) {
      const a = pixels[p + 3];
      if (a === 255)
        continue;
      pixels[p] = (pixels[p] * a + 127) / 255 | 0;
      pixels[p + 1] = (pixels[p + 1] * a + 127) / 255 | 0;
      pixels[p + 2] = (pixels[p + 2] * a + 127) / 255 | 0;
    }
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, pageW);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, bandH);
    for (let row = rowStart;row <= rowEnd; row++) {
      const firstInRow = Math.max(first + i - page * perPage, row * cols);
      const lastInRow = Math.min(first + pageEnd - 1 - page * perPage, row * cols + cols - 1);
      const col0 = firstInRow - row * cols;
      const colCount = lastInRow - firstInRow + 1;
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, col0 * tw);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, (row - rowStart) * th);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, col0 * tw, row * th, page, colCount * tw, th, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    i = pageEnd;
  }
}
function ensureTiles(s: any, res: any, gids: any) {
  const pending: any = [];
  const queued = new Set;
  const want = (gid: any) => {
    if (gid <= 0 || gid >= res.remapSize || res.cellOf[gid] >= 0 || queued.has(gid) || !res.sources[gid])
      return;
    queued.add(gid);
    pending.push(gid);
  };
  const newAnimated = [];
  for (const gid of gids) {
    const frames = res.animDefs.get(gid);
    if (frames) {
      if (!res.animated.some((a: any) => a.gid === gid))
        newAnimated.push(gid);
      for (const f of frames)
        want(f.gid);
    } else {
      want(gid);
    }
  }
  if (pending.length === 0 && newAnimated.length === 0)
    return;
  const gl = s.gl;
  const prevUnit = gl.getParameter(gl.ACTIVE_TEXTURE);
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT_OFFSET);
  if (pending.length > 0)
    packTiles(s, res, pending);
  let minGid = Infinity, maxGid = -Infinity;
  const touch = (gid: any, cellPlus: any) => {
    res.remapData[gid] = cellPlus;
    minGid = Math.min(minGid, gid);
    maxGid = Math.max(maxGid, gid);
  };
  for (const gid of pending) {
    if (!res.animDefs.has(gid) && res.cellOf[gid] >= 0)
      touch(gid, res.cellOf[gid] + 1);
  }
  for (const gid of newAnimated) {
    const frames = res.animDefs.get(gid).map((f: any) => ({
      cellPlus: f.gid < res.remapSize && res.cellOf[f.gid] >= 0 ? res.cellOf[f.gid] + 1 : 0,
      duration: f.duration
    }));
    res.animated.push({ gid, frames, totalDuration: frames.reduce((sum: any, f: any) => sum + f.duration, 0), shown: -1 });
    touch(gid, frames[0].cellPlus);
  }
  if (maxGid >= 0) {
    const row0 = Math.floor(minGid / res.remapWidth);
    const row1 = Math.floor(maxGid / res.remapWidth);
    gl.bindTexture(gl.TEXTURE_2D, res.remap);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row0, res.remapWidth, row1 - row0 + 1, gl.RED_INTEGER, gl.UNSIGNED_INT, res.remapData.subarray(row0 * res.remapWidth, (row1 + 1) * res.remapWidth));
  }
  gl.activeTexture(prevUnit);
}
export function setMap(mapData: any, sources: any) {
  for (const s of getAllGL()) {
    freeMapResources(s);
    releaseAllChunks(s);
  }
  mapSource = { mapData, sources };
}
function tryBuildMapResources(s: any) {
  let res = null;
  try {
    res = buildMapResources(s);
  } catch (error) {
    console.error(`glmap: failed to build the tile atlas (${s.id})`, error);
  }
  return res;
}
export function getMapResources(s: any) {
  const r = resourcesFor(s);
  if (r.map)
    return r.map;
  if (!mapSource || mapSource.mapData !== window.mapData || r.failed)
    return null;
  r.map = tryBuildMapResources(s);
  r.failed = !r.map;
  return r.map;
}
export function updateAnimations(s: any, res: any, now: any) {
  if (res.animated.length === 0)
    return;
  const gl = s.gl;
  const texel = new Uint32Array(1);
  let bound = false;
  for (const entry of res.animated) {
    const cellPlus = currentFrame(entry, now);
    if (cellPlus === entry.shown)
      continue;
    entry.shown = cellPlus;
    if (!bound) {
      gl.bindTexture(gl.TEXTURE_2D, res.remap);
      bound = true;
    }
    texel[0] = cellPlus;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, entry.gid % res.remapWidth, Math.floor(entry.gid / res.remapWidth), 1, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, texel);
  }
}
export function invalidateChunk(chunk: any) {
  chunkVersions.set(chunk, (chunkVersions.get(chunk) ?? 0) + 1);
}
// A chunk's tile ids as the GPU takes them, and which tiles it uses. The same for every surface (the ground, what is
// over the players, the minimap), so it is worked out for the first of them that asks and handed to the others:
// each used to walk every cell of every layer again for itself. Let go of once every surface has taken it.
function chunkTilesFor(s: any, chunk: any, version: any, width: any, height: any, layers: any) {
  let held = chunkTiles.get(chunk);
  if (!held || held.version !== version || held.width !== width || held.height !== height || held.layerCount !== layers.length) {
    const cells = width * height;
    const data = new Uint32Array(cells * layers.length);
    const used = new Set;
    for (let li = 0;li < layers.length; li++) {
      const src = layers[li]?.data;
      if (!src)
        continue;
      const base = li * cells;
      const n = Math.min(cells, src.length);
      for (let i = 0;i < n; i++) {
        const raw = src[i] >>> 0;
        data[base + i] = raw;
        if (raw !== 0)
          used.add(raw & 268435455);
      }
    }
    held = { version, width, height, layerCount: layers.length, data, used, takenBy: new Set };
    chunkTiles.set(chunk, held);
  }
  held.takenBy.add(s.id);
  if (held.takenBy.size >= getAllGL().length)
    chunkTiles.delete(chunk);
  return held;
}
function chunkEntryIsCurrent(entry: any, version: any, width: any, height: any, layerCount: any) {
  return !!entry && entry.version === version && entry.width === width && entry.height === height && entry.layerCount === layerCount;
}
// Whether the chunk has still to be put on this surface's GPU, or has changed since it was.
export function chunkNeedsUpload(s: any, chunk: any) {
  const width = chunk.width | 0;
  const height = chunk.height | 0;
  const layers = Array.isArray(chunk.layers) ? chunk.layers : [];
  if (width <= 0 || height <= 0 || layers.length === 0)
    return false;
  return !chunkEntryIsCurrent(resourcesFor(s).chunks.get(chunk), chunkVersions.get(chunk) ?? 0, width, height, layers.length);
}
// The chunk's texture on this surface. Putting a chunk there is the dear part of a frame (its tiles are read back
// from a canvas, which Safari is slow at), and walking into new ground brings a row of chunks at once, on every
// surface: all in one frame, that was a stutter (USER REPORT 2026-10-07: "Map rendering is a bit laggy on mobile
// safari", "Just while walking into a new area"). So a pass puts one chunk there at most (index.ts says which, with
// `mayUpload`): without it, a chunk that is not there yet is not drawn this frame, and one that has changed is drawn
// as it was.
export function getChunkTexture(s: any, chunk: any, mayUpload = true) {
  const width = chunk.width | 0;
  const height = chunk.height | 0;
  const layers = Array.isArray(chunk.layers) ? chunk.layers : [];
  if (width <= 0 || height <= 0 || layers.length === 0)
    return null;
  const gl = s.gl;
  const version = chunkVersions.get(chunk) ?? 0;
  const chunks = resourcesFor(s).chunks;
  let entry = chunks.get(chunk);
  if (chunkEntryIsCurrent(entry, version, width, height, layers.length)) {
    return entry;
  }
  if (!mayUpload)
    return entry && entry.width === width && entry.height === height && entry.layerCount === layers.length ? entry : null;
  const { data, used } = chunkTilesFor(s, chunk, version, width, height, layers);
  const res = resourcesFor(s).map;
  if (res)
    ensureTiles(s, res, used);
  if (!entry || entry.width !== width || entry.height !== height || entry.layerCount !== layers.length) {
    if (entry)
      gl.deleteTexture(entry.texture);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32UI, width, height, layers.length);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    entry = { generation: s.generation, texture, width, height, layerCount: layers.length, version };
    chunks.set(chunk, entry);
  } else {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, entry.texture);
    entry.version = version;
  }
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, layers.length, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
  return entry;
}
export function sweepChunks(s: any, loadedChunks: any) {
  const chunks = resourcesFor(s).chunks;
  if (chunks.size === 0)
    return;
  const live = new Set(loadedChunks ? loadedChunks.values() : []);
  for (const [chunk, entry] of chunks) {
    if (live.has(chunk))
      continue;
    s.gl.deleteTexture(entry.texture);
    chunks.delete(chunk);
  }
}
function releaseAllChunks(s: any) {
  const chunks = resourcesFor(s).chunks;
  for (const entry of chunks.values())
    s.gl.deleteTexture(entry.texture);
  chunks.clear();
}
const ATLAS_PAGE_SIZE = 1024, UPLOAD_UNIT_OFFSET = 4;
let mapSource: any = null, stagingCanvas: any = null, stagingCtx: any = null;
const surfaceResources: Map<any, any> = new Map();
const chunkTiles: WeakMap<any, any> = new WeakMap();
const chunkVersions: WeakMap<any, any> = new WeakMap();
