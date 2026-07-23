import { canvas, ctx, progressBar, loadingScreen } from "../core/ui";
import { invalidateTilesetLookupCache, recordChunkLoadTime, clearChunkTracking } from "./renderer.js";
import pako from "../libs/pako.js";
import { config } from "../web/global.js";
import { SHADOW_MAX_OFFSET } from "./shadows.js";

const PLAYER_Z_INDEX = config?.PLAYER_Z_INDEX;
declare global {
  interface Window {
    mapData?: any;
  }
}

// A "cut" is a point in the zIndex order where baked tile rendering must pause so
// something dynamic can be drawn between tile layers: either a shadow layer's
// silhouette (drawn at the shadow layer's own zIndex) or the player/NPC/entity
// pass (at PLAYER_Z_INDEX). Tile layers with zIndex <= key render below the cut.
export interface LayerCut {
  key: number;
  shadowZ: number | null;
  player: boolean;
}

export function computeLayerCuts(layers: Array<{ name: string; zIndex: number }>): LayerCut[] {
  const shadowNames: string[] | null = window.mapData?.shadowLayerNames || null;
  const shadowNameSet = new Set((shadowNames || []).map((n) => n.toLowerCase()));
  const shadowZs = new Set<number>();
  for (const l of layers) {
    if (l.name && shadowNameSet.has(l.name.toLowerCase())) shadowZs.add(Number(l.zIndex));
  }
  // Shadow cuts sit just below the nearest rendered tile layer beneath the
  // shadow's own zIndex, so the silhouette draws under the object it is attached
  // to even when the object's base spans the layer directly below (e.g. tall
  // grass split across two layers). Falls back to just below the shadow's own
  // zIndex when no rendered layer exists beneath it.
  const renderedZs: number[] = [];
  for (const l of layers) {
    const name = l.name ? l.name.toLowerCase() : '';
    if (name.includes('collision') || name.includes('nopvp') || name.includes('no-pvp') || name.includes('shadow')) continue;
    if (shadowNameSet.has(name)) continue;
    renderedZs.push(Number(l.zIndex));
  }

  const cuts: LayerCut[] = [...shadowZs].map((z) => {
    let prevZ = -Infinity;
    for (const rz of renderedZs) {
      if (rz < z && rz > prevZ) prevZ = rz;
    }
    const key = prevZ === -Infinity ? z - 0.5 : prevZ - 0.5;
    return { key, shadowZ: z, player: false };
  });
  // Player cut sits just below PLAYER_Z_INDEX so tiles at PLAYER_Z_INDEX render above players.
  cuts.push({ key: Number(PLAYER_Z_INDEX) - 0.5, shadowZ: null, player: true });
  // On equal keys, shadows draw before the player pass.
  cuts.sort((a, b) => a.key - b.key || (a.player ? 1 : 0) - (b.player ? 1 : 0));
  return cuts;
}

export function segmentIndexForZ(z: number, cuts: LayerCut[]): number {
  let i = 0;
  while (i < cuts.length && z > cuts[i].key) i++;
  return i;
}

function getBaseGID(gid: number): number { return gid & 0x0FFFFFFF; }

function getTileFlags(gid: number): { flipH: boolean; flipV: boolean; flipD: boolean } {
  return {
    flipH: (gid & 0x80000000) !== 0,
    flipV: (gid & 0x40000000) !== 0,
    flipD: (gid & 0x20000000) !== 0,
  };
}

function drawRotatedTile(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  srcX: number, srcY: number, srcW: number, srcH: number,
  destX: number, destY: number, destW: number, destH: number,
  flipH: boolean, flipV: boolean, flipD: boolean
): void {
  const hasFlags = flipH || flipV || flipD;
  if (!hasFlags) {
    ctx.drawImage(image, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
    return;
  }

  const cx = destX + destW / 2;
  const cy = destY + destH / 2;

  // Tiled's exact approach:
  // 1. If anti-diagonal: set rotation=90°, swap H↔V and invert H flag
  // 2. Translate to center, rotate, scale (negatives for flips)
  let rot = 0;
  let effH = flipH;
  let effV = flipV;

  if (flipD) {
    rot = Math.PI / 2;
    effH = flipV;           // original V becomes horizontal after 90° rotation
    effV = !flipH;          // original H becomes vertical, inverted
  }

  ctx.save();
  ctx.translate(cx, cy);
  if (rot !== 0) ctx.rotate(rot);
  ctx.scale(effH ? -1 : 1, effV ? -1 : 1);
  ctx.drawImage(image, srcX, srcY, srcW, srcH, -destW / 2, -destH / 2, destW, destH);
  ctx.restore();
}

export { getBaseGID, getTileFlags, drawRotatedTile };

interface AnimationFrame {
  tileid: number;
  duration: number;
}

interface AnimatedTile {
  segment: number;
  zIndex: number;
  destX: number;
  destY: number;
  tilesetIndex: number;
  tileset: any;
  animation: AnimationFrame[];
  totalDuration: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
}

interface ChunkData {
  chunkX: number;
  chunkY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: Array<{
    name: string;
    zIndex: number;
    data: number[];
    width: number;
    height: number;
    locked?: boolean;
  }>;
  canvas?: HTMLCanvasElement;
  segmentCanvases?: HTMLCanvasElement[];
  animatedTiles?: AnimatedTile[];
  shadowLayers?: Array<{ canvas: HTMLCanvasElement; zIndex: number }>;
}

export default async function loadMap(metadata: any): Promise<boolean> {
    if (!(window as any).__suppressLoadingScreen) {
      if (loadingScreen) {
        loadingScreen.style.display = "flex";
        loadingScreen.style.opacity = "1";
        loadingScreen.style.transition = "0s";
        progressBar.style.width = "0%";
      }
    }

    if (window.mapData) {
      for (const chunkData of window.mapData.loadedChunks.values()) {
        disposeChunkCanvases(chunkData);
      }
      window.mapData.loadedChunks.clear();
      clearChunkTracking();
    }

    // Handle both old and new message formats
    let mapName: string;
    let spawnX: number;
    let spawnY: number;
    let mapWidth: number;
    let mapHeight: number;
    let tilewidth: number;
    let tileheight: number;
    let tilesets: any[] = [];

    if (metadata && typeof metadata === 'object' && 'name' in metadata && !Array.isArray(metadata)) {
      // New format: metadata object from server
      // { name, assetServerUrl, width, height, tilewidth, tileheight, spawnX, spawnY, direction, chunks }
      mapName = metadata.name;
      spawnX = metadata.spawnX || 0;
      spawnY = metadata.spawnY || 0;
      mapWidth = metadata.width;
      mapHeight = metadata.height;
      tilewidth = metadata.tilewidth || 32;
      tileheight = metadata.tileheight || 32;
      tilesets = metadata.tilesets || [];
    } else if (metadata && Array.isArray(metadata)) {
      // Old format: [{ data: compressed }, mapName, spawnX, spawnY]
      const data = metadata;
      if (data[0] && typeof data[0] === 'object' && data[0].data) {
        //@ts-expect-error - Imported via HTML
        const inflated = pako.inflate(
          new Uint8Array(new Uint8Array(data[0].data)),
          { to: "string" }
        );
        const mapData = inflated ? JSON.parse(inflated) : null;
        if (!mapData) {
          throw new Error("Failed to parse map data");
        }
        mapName = data[1];
        spawnX = data[2] || 0;
        spawnY = data[3] || 0;
        mapWidth = mapData.width;
        mapHeight = mapData.height;
        tilewidth = mapData.tilewidth;
        tileheight = mapData.tileheight;
      } else {
        throw new Error("Invalid LOAD_MAP array format");
      }
    } else {
      console.error("Invalid LOAD_MAP message format:", metadata);
      throw new Error("LOAD_MAP message must include map metadata object with name, width, height, tilewidth, tileheight");
    }

    if (!mapName) {
      throw new Error("Map name is missing from LOAD_MAP message");
    }

    // Store asset server URL for chunk loading
    const assetServerUrl = metadata?.assetServerUrl || "";
    (window as any).__assetServerUrl = assetServerUrl;

    progressBar.style.width = "10%";

    const images = await loadTilesets(tilesets);
    if (!images.length) {
      console.warn("No tileset images loaded, continuing with empty tilesets");
    }

    progressBar.style.width = "30%";

    // Dynamic chunk sizing: maintain consistent chunk pixel size (~1024px²) regardless of tile size
    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
      16: 64,   // 16px tiles → 64 tile chunks = 1024�-1024px
      32: 32,   // 32px tiles → 32 tile chunks = 1024�-1024px
      64: 16,   // 64px tiles → 16 tile chunks = 1024�-1024px
    };
    const CHUNK_SIZE = CHUNK_SIZE_CONFIG[tilewidth] || 32; // Default to 32 if tile size not in config
    const chunksX = Math.ceil(mapWidth / CHUNK_SIZE);
    const chunksY = Math.ceil(mapHeight / CHUNK_SIZE);

    // Extract object layers from metadata
    const objectLayers = metadata?.objectLayers || [];

    // Check for preloaded chunks from warp preloading
    const preloadedMapData = (window as any).__preloadedMaps?.[mapName];
    const preloadedChunks = new Map(preloadedMapData?.loadedChunks || []);

    window.mapData = {
      name: mapName,
      width: mapWidth,
      height: mapHeight,
      tilewidth: tilewidth,
      tileheight: tileheight,
      tilesets: tilesets,
      infinite: (metadata?.infinite === true),
      minTileX: 0,
      minTileY: 0,
      minChunkX: 0,
      minChunkY: 0,
      images: images,
      chunksX: chunksX,
      chunksY: chunksY,
      chunkSize: CHUNK_SIZE,
      loadedChunks: preloadedChunks,
      spawnX: spawnX,
      spawnY: spawnY,
      warps: metadata?.warps || null,
      graveyards: metadata?.graveyards || null,
      shadowLayerNames: metadata?.shadowLayerNames || null,
      objectLayers: objectLayers,
      requestChunk: async (chunkX: number, chunkY: number) => {
        return await requestChunk(chunkX, chunkY);
      },
      getChunkCanvas: (chunkX: number, chunkY: number) => {
        return getChunkCanvas(chunkX, chunkY);
      },
    };

    // Preloaded chunks skip re-baking, so seed the layer cuts from their layer
    // structure; otherwise cuts are computed during the first chunk bake.
    for (const preloadedChunk of preloadedChunks.values()) {
      const layers = (preloadedChunk as any)?.layers;
      if (Array.isArray(layers)) {
        window.mapData.layerCuts = computeLayerCuts(layers);
        break;
      }
    }

    // Invalidate tileset lookup cache for the new map
    invalidateTilesetLookupCache();

    const { initializeCamera } = await import('./renderer.js');
    initializeCamera(spawnX, spawnY);

    progressBar.style.width = "40%";

    const chunkPixelSize = CHUNK_SIZE * window.mapData.tilewidth;
    const spawnChunkX = Math.floor(spawnX / chunkPixelSize);
    const spawnChunkY = Math.floor(spawnY / chunkPixelSize);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = chunkPixelSize;

    const chunksNeededX = Math.ceil((viewportWidth + padding * 2) / chunkPixelSize / 2);
    const chunksNeededY = Math.ceil((viewportHeight + padding * 2) / chunkPixelSize / 2);

    const chunksToLoad: Array<{x: number, y: number}> = [];
    for (let dy = -chunksNeededY; dy <= chunksNeededY; dy++) {
      for (let dx = -chunksNeededX; dx <= chunksNeededX; dx++) {
        const chunkX = spawnChunkX + dx;
        const chunkY = spawnChunkY + dy;
        if (chunkX >= 0 && chunkY >= 0 && chunkX < chunksX && chunkY < chunksY) {
          chunksToLoad.push({ x: chunkX, y: chunkY });
        }
      }
    }

    const totalChunks = chunksToLoad.length;
    let loadedCount = 0;

    const chunkPromises = chunksToLoad.map(chunk =>
      requestChunk(chunk.x, chunk.y).then(chunkData => {
        if (chunkData && chunkData.canvas) {
          loadedCount++;

          const chunkProgress = 40 + (loadedCount / totalChunks) * 50;
          progressBar.style.width = `${chunkProgress}%`;
        }
        return chunkData;
      })
    );

    await Promise.all(chunkPromises);

    const allChunksLoaded = chunksToLoad.every(chunk => {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      return window.mapData.loadedChunks.has(chunkKey);
    });

    if (!allChunksLoaded) {

      for (const chunk of chunksToLoad) {
        const chunkKey = `${chunk.x}-${chunk.y}`;
        if (!window.mapData.loadedChunks.has(chunkKey)) {
          await requestChunk(chunk.x, chunk.y);
        }
      }
    }

    if (window.mapData.loadedChunks.size > 0) {
      if (!(window as any).__preloadedMaps) {
        (window as any).__preloadedMaps = {};
      }
      if (!(window as any).__preloadedMaps[mapName]) {
        (window as any).__preloadedMaps[mapName] = {
          name: mapName,
          width: mapWidth,
          height: mapHeight,
          tilewidth: tilewidth,
          tileheight: tileheight,
          chunkSize: CHUNK_SIZE,
          loadedChunks: new Map(),
        };
      }
      const canonical = (window as any).__preloadedMaps[mapName].loadedChunks;
      for (const [key, value] of window.mapData.loadedChunks.entries()) { 
        canonical.set(key, value);
      }
    }

    progressBar.style.width = "100%";

    const rawDpr = window.devicePixelRatio || 1;
    const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const dpr = isTouchDevice ? Math.min(rawDpr, 2) : rawDpr;

    const bodyStyle = getComputedStyle(document.body);
    const displayWidth = parseFloat(bodyStyle.width) || window.innerWidth;
    const displayHeight = parseFloat(bodyStyle.height) || window.innerHeight;

    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;


    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.right = "0";
    canvas.style.bottom = "0";
    canvas.style.backgroundColor = "#000000";

    canvas.style.width = displayWidth + "px";
    canvas.style.height = displayHeight + "px";

    canvas.style.display = "block";

    if (ctx) {

      if (isTouchDevice) {
        const mobileZoom = 0.85;
        ctx.scale(dpr * mobileZoom, dpr * mobileZoom);

        ctx.translate((displayWidth * (1 - mobileZoom)) / (2 * mobileZoom),
                      (displayHeight * (1 - mobileZoom)) / (2 * mobileZoom));
      } else {
        ctx.scale(dpr, dpr);
      }

    }

    await new Promise(resolve => setTimeout(resolve, 1500));

    return true;
}

export async function preloadChunks(data: any): Promise<void> {
  if (!window.mapData) return;

  const { mapName, chunks, tilewidth, tileheight, width, height } = data;

  let preloadMapData = (window as any).__preloadedMaps?.[mapName];

  if (!preloadMapData) {
    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
      16: 64,
      32: 32,
      64: 16,
    };
    const actualChunkSize = CHUNK_SIZE_CONFIG[tilewidth] || 32;

    preloadMapData = {
      name: mapName,
      width: width,
      height: height,
      tilewidth: tilewidth,
      tileheight: tileheight,
      chunkSize: actualChunkSize,
      loadedChunks: new Map<string, ChunkData>(),
    };

    if (!(window as any).__preloadedMaps) {
      (window as any).__preloadedMaps = {};
    }
    (window as any).__preloadedMaps[mapName] = preloadMapData;
  }

  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;

      if (!preloadMapData.loadedChunks.has(chunkKey)) {
        try {
          const chunkData = await requestChunkViaAssetServer(mapName, chunk.x, chunk.y);
          if (chunkData) {
            preloadMapData.loadedChunks.set(chunkKey, chunkData);
            try {
              await saveChunkToCache(mapName, chunk.x, chunk.y, chunkData);
            } catch (err) {
              // Cache save error is non-fatal
            }
          }
        } catch (err) {
          console.warn(`Failed to preload chunk ${chunkKey} for map ${mapName}: ${err}`);
        }
      }
    }
  }
}

async function loadTilesets(tilesets: any[]): Promise<HTMLImageElement[]> {
  if (!tilesets?.length) throw new Error("No tilesets found");

  const base64ToUint8Array = (base64: string) => {
    const raw = atob(base64);
    const uint8Array = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++)
      uint8Array[i] = raw.charCodeAt(i);
    return uint8Array;
  };

  const uint8ArrayToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const tilesetPromises = tilesets.map(async (tileset) => {
    const name = tileset.image.split("/").pop();

    const assetServerUrl = (window as any).__assetServerUrl || "";
    if (!assetServerUrl) {
      throw new Error("Asset server URL not configured - cannot load tilesets");
    }

    const response = await fetch(`${assetServerUrl}/tileset?name=${encodeURIComponent(name)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch tileset ${name}: ${response.statusText}`);
    }
    const tilesetData = await response.json();
    const compressedBase64 = tilesetData.data;
    const compressedBytes = base64ToUint8Array(compressedBase64);

    //@ts-expect-error - Imported via HTML
    const inflatedBytes = pako.inflate(compressedBytes);
    const imageBase64 = uint8ArrayToBase64(inflatedBytes);

    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";

      image.onload = () => {
        if (image.complete && image.naturalWidth > 0) resolve(image);
        else reject(new Error(`Image loaded but invalid: ${name}`));
      };

      image.onerror = () => {
        reject(new Error(`Failed to load tileset image: ${name}`));
      };

      image.src = `data:image/png;base64,${imageBase64}`;

      setTimeout(() => {
        if (!image.complete)
          reject(new Error(`Timeout loading tileset image: ${name}`));
      }, 15000);
    });
  });

  return Promise.all(tilesetPromises);
}

const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CACHE_DB_NAME = 'map-chunk-cache';
const CACHE_DB_VERSION = 1;

function getCacheKey(mapName: string, chunkX: number, chunkY: number): string {
  return `chunk_${mapName}_${chunkX}_${chunkY}`;
}

let cacheDbPromise: Promise<IDBDatabase> | null = null;

function getCacheDB(): Promise<IDBDatabase> {
  if (cacheDbPromise) return cacheDbPromise;

  cacheDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      cacheDbPromise = null;
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      cacheDbPromise = null;
      reject(request.error);
    };
  });

  return cacheDbPromise;
}

async function saveChunkToCache(mapName: string, chunkX: number, chunkY: number, chunkData: ChunkData): Promise<void> {
  try {
    const db = await getCacheDB();
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    const cacheEntry = { id: cacheKey, timestamp: Date.now(), data: chunkData };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const request = store.put(cacheEntry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error saving chunk to cache:", error);
  }
}

async function clearChunkFromCache(mapName: string, chunkX: number, chunkY: number): Promise<void> {
  try {
    const db = await getCacheDB();
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const request = store.delete(cacheKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error clearing chunk from cache:", error);
  }
}

async function loadChunkFromCache(mapName: string, chunkX: number, chunkY: number): Promise<ChunkData | null> {
  try {
    const db = await getCacheDB();
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);

    const cacheEntry = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const request = store.get(cacheKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!cacheEntry) return null;

    const age = Date.now() - cacheEntry.timestamp;
    if (age > CACHE_EXPIRY_MS) {
      clearChunkFromCache(mapName, chunkX, chunkY);
      return null;
    }

    return cacheEntry.data;
  } catch (error) {
    return null;
  }
}

async function clearMapCache(mapName?: string): Promise<void> {
  try {
    const db = await getCacheDB();
    const prefix = mapName ? `chunk_${mapName}_` : 'chunk_';
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const request = store.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error("Error clearing map cache:", error);
  }
}

async function isChunkCached(mapName: string, chunkX: number, chunkY: number): Promise<boolean> {
  try {
    const db = await getCacheDB();
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);

    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const request = store.getKey(cacheKey);
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

// Grow the map bounds if a loaded chunk contains tiles beyond the current width or
// height, so persisted out-of-border content renders on reload even when the
// LOAD_MAP dimensions are stale (otherwise renderMap would clip it away).
function growBoundsForChunk(chunkData: any): void {
  if (!window.mapData || !chunkData || !Array.isArray(chunkData.layers)) return;
  const cs = window.mapData.chunkSize;
  const baseX = (chunkData.chunkX || 0) * cs;
  const baseY = (chunkData.chunkY || 0) * cs;
  const cw = chunkData.width || cs;
  if (cw <= 0) return;

  let maxLocalX = -1;
  let maxLocalY = -1;
  for (const layer of chunkData.layers) {
    if (!Array.isArray(layer.data)) continue;
    const data = layer.data;
    for (let i = 0; i < data.length; i++) {
      if (!data[i]) continue;
      const lx = i % cw;
      const ly = (i - lx) / cw;
      if (lx > maxLocalX) maxLocalX = lx;
      if (ly > maxLocalY) maxLocalY = ly;
    }
  }
  if (maxLocalX < 0) return;

  const needW = baseX + maxLocalX + 1;
  const needH = baseY + maxLocalY + 1;
  let changed = false;
  if (needW > window.mapData.width) { window.mapData.width = needW; changed = true; }
  if (needH > window.mapData.height) { window.mapData.height = needH; changed = true; }
  if (changed) {
    window.mapData.chunksX = Math.ceil(window.mapData.width / cs);
    window.mapData.chunksY = Math.ceil(window.mapData.height / cs);
  }
}

async function requestChunk(chunkX: number, chunkY: number): Promise<ChunkData | null> {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;

  const existingChunk = window.mapData.loadedChunks.get(chunkKey);
  if (existingChunk && existingChunk.canvas && existingChunk.segmentCanvases) {
    return existingChunk;
  }

  if (chunkX < 0 || chunkY < 0 || chunkX >= window.mapData.chunksX || chunkY >= window.mapData.chunksY) {
    return null;
  }

  try {

    const cachedChunkData = await loadChunkFromCache(window.mapData.name, chunkX, chunkY);
    let chunkData: ChunkData | null;

    if (cachedChunkData) {

      chunkData = cachedChunkData;
    } else {

      try {
        chunkData = await requestChunkViaAssetServer(window.mapData.name, chunkX, chunkY);
        if (!chunkData) {
          return null;
        }

        await saveChunkToCache(window.mapData.name, chunkX, chunkY, chunkData);
      } catch (error) {
        return null;
      }
    }

    const { segmentCanvases } = await renderChunkToCanvas(chunkData);
    chunkData.segmentCanvases = segmentCanvases;
    chunkData.canvas = segmentCanvases[0];

    bakeChunkShadowEdges(chunkData);
    window.mapData.loadedChunks.set(chunkKey, chunkData);

    // If this chunk carries shadow tiles at its edge, already-baked neighbors
    // need their silhouettes re-baked to include them in their aprons.
    if (hasShadowTilesNearBorder(chunkData)) {
      rebakeNeighborShadowEdges(chunkX, chunkY);
    }

    // Keep persisted out-of-border content visible on reload even if the LOAD_MAP
    // dimensions are stale: grow the bounds to include this chunk's content.
    growBoundsForChunk(chunkData);

    const preloadCache = (window as any).__preloadedMaps?.[window.mapData.name]?.loadedChunks;
    if (preloadCache) {
      preloadCache.set(chunkKey, chunkData);
    }

    // Record chunk load time for fade-in effect
    recordChunkLoadTime(chunkKey);

    return chunkData;
  } catch (error) {
    return null;
  }
}

async function requestChunkViaAssetServer(mapName: string, chunkX: number, chunkY: number): Promise<ChunkData | null> {
  if (!window.mapData) {
    throw new Error("Map data not initialized");
  }

  const chunkSize = window.mapData.chunkSize;
  const assetServerUrl = (window as any).__assetServerUrl || "";

  try {
    const chunkUrl = `${assetServerUrl}/map-chunk?map=${encodeURIComponent(mapName)}&x=${chunkX}&y=${chunkY}&size=${chunkSize}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(chunkUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch chunk: ${response.statusText}`);
    }

    const chunkData: ChunkData = await response.json();

    // Ensure chunk has proper structure
    if (!chunkData.layers) {
      chunkData.layers = [];
    }

    return chunkData;
  } catch (error) {
    console.error(`Error fetching chunk ${chunkX},${chunkY} from asset server:`, error);
    throw error;
  }
}

async function renderChunkToCanvas(chunkData: ChunkData, skipYield: boolean = false): Promise<{segmentCanvases: HTMLCanvasElement[]}> {
  if (!window.mapData) throw new Error("Map data not initialized");

  const pixelWidth = chunkData.width * window.mapData.tilewidth;
  const pixelHeight = chunkData.height * window.mapData.tileheight;

  const cuts = computeLayerCuts(chunkData.layers);
  window.mapData.layerCuts = cuts;

  disposeChunkCanvases(chunkData);

  const segmentCanvases: HTMLCanvasElement[] = [];
  const segmentCtxs: CanvasRenderingContext2D[] = [];
  for (let i = 0; i <= cuts.length; i++) {
    const segCanvas = document.createElement("canvas");
    segCanvas.width = pixelWidth;
    segCanvas.height = pixelHeight;
    const segCtx = segCanvas.getContext("2d", { willReadFrequently: false, alpha: true });
    if (!segCtx) throw new Error("Failed to get canvas context");
    segCtx.imageSmoothingEnabled = false;
    segCtx.clearRect(0, 0, pixelWidth, pixelHeight);
    segmentCanvases.push(segCanvas);
    segmentCtxs.push(segCtx);
  }

  const sortedLayers = [...chunkData.layers].sort((a, b) => a.zIndex - b.zIndex);

  const TILES_PER_FRAME = 50; // Balanced: render 50 tiles per frame for speed without lag

  // Build fast tileset lookup map: tileIndex -> {tileset, image}
  const tilesetLookupMap = new Map<number, { tileset: any; image: HTMLImageElement }>();
  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    const img = window.mapData.images[i];
    if (img && img.complete && img.naturalWidth > 0) {
      for (let tileIdx = ts.firstgid; tileIdx < ts.firstgid + ts.tilecount; tileIdx++) {
        tilesetLookupMap.set(tileIdx, { tileset: ts, image: img });
      }
    }
  }

  // Build animated tile lookup from Tiled tileset `tiles[].animation` definitions.
  // Keyed by global tile id (firstgid + local id). Empty for maps with no animations.
  const animatedTileLookup = new Map<number, { tilesetIndex: number; tileset: any; animation: AnimationFrame[]; totalDuration: number }>();
  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    if (!Array.isArray(ts.tiles)) continue;
    for (const tile of ts.tiles) {
      if (!Array.isArray(tile.animation) || tile.animation.length === 0) continue;
      const totalDuration = tile.animation.reduce((sum: number, frame: AnimationFrame) => sum + (frame.duration || 0), 0);
      animatedTileLookup.set(ts.firstgid + tile.id, {
        tilesetIndex: i,
        tileset: ts,
        animation: tile.animation,
        totalDuration,
      });
    }
  }

  const animatedTiles: AnimatedTile[] = [];

  for (let layerIdx = 0; layerIdx < sortedLayers.length; layerIdx++) {
    const layer = sortedLayers[layerIdx];

    const layerName = layer.name ? layer.name.toLowerCase() : '';
    if (layerName.includes('collision') || layerName.includes('nopvp') || layerName.includes('no-pvp') || layerName.includes('shadow')) {
      continue;
    }

    const tileEditor = (window as any).tileEditor;
    if (tileEditor?.isActive && !tileEditor.isLayerVisible(layer.name)) {
      continue;
    }

    const layerZ = Number(layer.zIndex);
    const segment = segmentIndexForZ(layerZ, cuts);
    const ctx = segmentCtxs[segment];

    let tileCount = 0;

    for (let y = 0; y < chunkData.height; y++) {
      for (let x = 0; x < chunkData.width; x++) {
        const tileIndex = layer.data[y * chunkData.width + x];
        if (tileIndex === 0) continue;

        const baseGID = getBaseGID(tileIndex);
        const { flipH, flipV, flipD } = getTileFlags(tileIndex);

        // Animated tiles are not baked into the static chunk canvas; they are
        // recorded here and drawn per-frame by the renderer on top of this layer group.
        const animInfo = animatedTileLookup.get(baseGID);
        if (animInfo) {
          animatedTiles.push({
            segment,
            zIndex: layer.zIndex,
            destX: x * window.mapData.tilewidth,
            destY: y * window.mapData.tileheight,
            tilesetIndex: animInfo.tilesetIndex,
            tileset: animInfo.tileset,
            animation: animInfo.animation,
            totalDuration: animInfo.totalDuration,
            rotation: flipD ? 1 : flipH && flipV ? 2 : 0,
            flipH, flipV, flipD,
          });
          continue;
        }

        // Use fast O(1) tileset lookup
        const tilesetInfo = tilesetLookupMap.get(baseGID);
        if (!tilesetInfo) continue;

        const tileset = tilesetInfo.tileset;
        const image = tilesetInfo.image;

        const localTileIndex = baseGID - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const srcX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
        const srcY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

        const destX = x * window.mapData.tilewidth;
        const destY = y * window.mapData.tileheight;
        const tileW = window.mapData.tilewidth;
        const tileH = window.mapData.tileheight;

        try {
          drawRotatedTile(ctx, image, srcX, srcY, tileset.tilewidth, tileset.tileheight, destX, destY, tileW, tileH, flipH, flipV, flipD);
        } catch (drawError) {
            console.error(`Error drawing tile at (${x}, ${y}) in layer "${layer.name}":`, drawError);
        }

        tileCount++;

        // Yield to browser every TILES_PER_FRAME tiles to keep frame rate smooth
        if (!skipYield && tileCount % TILES_PER_FRAME === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }

  // Order animated tiles by layer zIndex so stacked animations draw correctly.
  animatedTiles.sort((a, b) => a.zIndex - b.zIndex);
  chunkData.animatedTiles = animatedTiles;

  return { segmentCanvases };
}

// Incrementally re-composite specific cells of an already-baked chunk. Used by the
// tile editor so placing/erasing a tile only redraws the affected cells instead of
// re-baking the entire chunk (which is far too expensive for interactive editing).
// Mirrors the per-cell logic of renderChunkToCanvas (layer filtering, lower/upper
// split, animated-tile handling) so results match a full re-bake.
export function redrawChunkCells(chunkData: ChunkData, cells: Array<{ x: number; y: number }>): void {
  if (!window.mapData || !chunkData.segmentCanvases || chunkData.segmentCanvases.length === 0) return;

  const cuts: LayerCut[] = window.mapData.layerCuts || computeLayerCuts(chunkData.layers);
  const segmentCtxs: CanvasRenderingContext2D[] = [];
  for (const segCanvas of chunkData.segmentCanvases) {
    const segCtx = segCanvas.getContext("2d");
    if (!segCtx) return;
    segCtx.imageSmoothingEnabled = false;
    segmentCtxs.push(segCtx);
  }

  const tilewidth = window.mapData.tilewidth;
  const tileheight = window.mapData.tileheight;

  const tilesetLookupMap = new Map<number, { tileset: any; image: HTMLImageElement }>();
  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    const img = window.mapData.images[i];
    if (img && img.complete && img.naturalWidth > 0) {
      for (let tileIdx = ts.firstgid; tileIdx < ts.firstgid + ts.tilecount; tileIdx++) {
        tilesetLookupMap.set(tileIdx, { tileset: ts, image: img });
      }
    }
  }

  const animatedTileLookup = new Map<number, { tilesetIndex: number; tileset: any; animation: AnimationFrame[]; totalDuration: number }>();
  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    if (!Array.isArray(ts.tiles)) continue;
    for (const tile of ts.tiles) {
      if (!Array.isArray(tile.animation) || tile.animation.length === 0) continue;
      const totalDuration = tile.animation.reduce((sum: number, frame: AnimationFrame) => sum + (frame.duration || 0), 0);
      animatedTileLookup.set(ts.firstgid + tile.id, { tilesetIndex: i, tileset: ts, animation: tile.animation, totalDuration });
    }
  }

  const sortedLayers = [...chunkData.layers].sort((a, b) => a.zIndex - b.zIndex);
  if (!chunkData.animatedTiles) chunkData.animatedTiles = [];

  for (const cell of cells) {
    const { x, y } = cell;
    if (x < 0 || y < 0 || x >= chunkData.width || y >= chunkData.height) continue;

    const px = x * tilewidth;
    const py = y * tileheight;

    for (const segCtx of segmentCtxs) {
      segCtx.clearRect(px, py, tilewidth, tileheight);
    }

    // Drop animated-tile records previously registered at this cell.
    chunkData.animatedTiles = chunkData.animatedTiles.filter((at) => !(at.destX === px && at.destY === py));

    for (const layer of sortedLayers) {
      const layerName = layer.name ? layer.name.toLowerCase() : '';
      if (layerName.includes('collision') || layerName.includes('nopvp') || layerName.includes('no-pvp') || layerName.includes('shadow')) continue;

      const tileEditor = (window as any).tileEditor;
      if (tileEditor?.isActive && !tileEditor.isLayerVisible(layer.name)) continue;

      const tileIndex = layer.data[y * chunkData.width + x];
      if (tileIndex === 0) continue;

      const baseGID = getBaseGID(tileIndex);
      const { flipH, flipV, flipD } = getTileFlags(tileIndex);

      const segment = Math.min(segmentIndexForZ(Number(layer.zIndex), cuts), segmentCtxs.length - 1);

      const animInfo = animatedTileLookup.get(baseGID);
      if (animInfo) {
        chunkData.animatedTiles.push({
          segment,
          zIndex: layer.zIndex,
          destX: px,
          destY: py,
          tilesetIndex: animInfo.tilesetIndex,
          tileset: animInfo.tileset,
          animation: animInfo.animation,
          totalDuration: animInfo.totalDuration,
          rotation: flipD ? 1 : flipH && flipV ? 2 : 0,
          flipH, flipV, flipD,
        });
        continue;
      }

      const tilesetInfo = tilesetLookupMap.get(baseGID);
      if (!tilesetInfo) continue;

      const tileset = tilesetInfo.tileset;
      const image = tilesetInfo.image;
      const localTileIndex = baseGID - tileset.firstgid;
      const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
      const srcX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
      const srcY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

      const targetCtx = segmentCtxs[segment];
      try {
        drawRotatedTile(targetCtx, image, srcX, srcY, tileset.tilewidth, tileset.tileheight, px, py, tilewidth, tileheight, flipH, flipV, flipD);
      } catch (drawError) {
        console.error(`Error drawing tile at (${x}, ${y}) in layer "${layer.name}":`, drawError);
      }
    }
  }

  chunkData.animatedTiles.sort((a, b) => a.zIndex - b.zIndex);
  bakeChunkShadowEdges(chunkData);

  // Edits touching the chunk's edge can change what neighboring chunks see in
  // their silhouette aprons, so re-bake their shadow edges too.
  const touchesBorder = cells.some((c) =>
    c.x <= 0 || c.y <= 0 || c.x >= chunkData.width - 1 || c.y >= chunkData.height - 1
  );
  if (touchesBorder) {
    const chunkX = chunkData.chunkX ?? Math.floor(chunkData.startX / chunkData.width);
    const chunkY = chunkData.chunkY ?? Math.floor(chunkData.startY / chunkData.height);
    rebakeNeighborShadowEdges(chunkX, chunkY);
  }
}

// Create an empty in-memory chunk, used by the editor when painting into the
// infinite zone beyond the currently-loaded chunks. Its layer structure is
// cloned from an existing loaded chunk so it matches the rest of the map.
function createEmptyChunk(chunkX: number, chunkY: number): any | null {
  if (!window.mapData) return null;
  const chunkSize = window.mapData.chunkSize;

  let template: any = null;
  for (const c of window.mapData.loadedChunks.values()) { template = c; break; }
  if (!template) return null;

  const layers = template.layers.map((l: any) => ({
    name: l.name,
    zIndex: l.zIndex,
    width: chunkSize,
    height: chunkSize,
    data: new Array(chunkSize * chunkSize).fill(0),
    locked: l.locked,
  }));

  const pixelW = chunkSize * window.mapData.tilewidth;
  const pixelH = chunkSize * window.mapData.tileheight;
  const cuts: LayerCut[] = window.mapData.layerCuts || computeLayerCuts(layers);
  const segmentCanvases: HTMLCanvasElement[] = [];
  for (let i = 0; i <= cuts.length; i++) {
    const segCanvas = document.createElement("canvas");
    segCanvas.width = pixelW;
    segCanvas.height = pixelH;
    segmentCanvases.push(segCanvas);
  }

  const chunk: any = {
    chunkX, chunkY,
    startX: chunkX * chunkSize,
    startY: chunkY * chunkSize,
    width: chunkSize,
    height: chunkSize,
    tilewidth: window.mapData.tilewidth,
    tileheight: window.mapData.tileheight,
    layers,
    segmentCanvases,
    canvas: segmentCanvases[0],
    animatedTiles: [],
  };

  window.mapData.loadedChunks.set(`${chunkX}-${chunkY}`, chunk);
  return chunk;
}

// Ensure a tile at the given world-tile coords can be painted: grow the map's
// logical bounds (infinite maps only) and create the target chunk if missing.
// Returns the chunk + local coords, or null if not paintable (e.g. negative
// coords, which require origin re-basing and are not supported yet).
// Parse a "chunkX-chunkY" key, correctly handling negative indices.
export function parseChunkKey(key: string): [number, number] {
  const m = key.match(/^(-?\d+)-(-?\d+)$/);
  if (!m) return [0, 0];
  return [Number(m[1]), Number(m[2])];
}

// Ensure a tile at the given world-tile coords can be painted: grow the map's
// logical bounds in any direction (infinite maps only) and create the target
// chunk if missing. Existing content is never shifted while editing (no desync
// with server-authoritative positions); the origin is re-based to (0,0) only at
// save time. Returns the chunk + local coords, or null if not paintable.
export function ensureChunkForTile(worldTileX: number, worldTileY: number): { chunk: any; chunkX: number; chunkY: number; localX: number; localY: number } | null {
  if (!window.mapData) return null;

  const chunkSize = window.mapData.chunkSize;
  const chunkX = Math.floor(worldTileX / chunkSize);
  const chunkY = Math.floor(worldTileY / chunkSize);
  // Floor-mod keeps local coords in [0, chunkSize) even for negative world tiles.
  const localX = ((worldTileX % chunkSize) + chunkSize) % chunkSize;
  const localY = ((worldTileY % chunkSize) + chunkSize) % chunkSize;

  if (window.mapData.infinite) {
    if (window.mapData.minTileX === undefined) window.mapData.minTileX = 0;
    if (window.mapData.minTileY === undefined) window.mapData.minTileY = 0;

    // Grow the positive (right / down) extent.
    if (worldTileX + 1 > window.mapData.width) {
      window.mapData.width = worldTileX + 1;
      window.mapData.chunksX = Math.ceil(window.mapData.width / chunkSize);
    }
    if (worldTileY + 1 > window.mapData.height) {
      window.mapData.height = worldTileY + 1;
      window.mapData.chunksY = Math.ceil(window.mapData.height / chunkSize);
    }

    // Left/up expansion is disabled.
    if (worldTileX < 0 || worldTileY < 0) {
      return null;
    }
  } else if (worldTileX < 0 || worldTileY < 0 || worldTileX >= window.mapData.width || worldTileY >= window.mapData.height) {
    return null;
  }

  let chunk = window.mapData.loadedChunks.get(`${chunkX}-${chunkY}`);
  if (!chunk) {
    chunk = createEmptyChunk(chunkX, chunkY);
    if (!chunk) return null;
  }
  return { chunk, chunkX, chunkY, localX, localY };
}

function getChunkCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.canvas || null;
}

export function disposeChunkCanvases(chunkData: ChunkData): void {
  if (chunkData.segmentCanvases) {
    for (const c of chunkData.segmentCanvases) {
      c.width = 0;
      c.height = 0;
    }
    chunkData.segmentCanvases.length = 0;
  }
  if (chunkData.shadowLayers) {
    for (const sl of chunkData.shadowLayers) {
      sl.canvas.width = 0;
      sl.canvas.height = 0;
    }
    chunkData.shadowLayers = undefined;
  }
  chunkData.animatedTiles = [];
  chunkData.canvas = undefined;
}

async function rebakeAllChunks() {
  if (!window.mapData) return;

  const chunks = [...window.mapData.loadedChunks.values()];
  for (const chunkData of chunks) {
    try {
      const { segmentCanvases } = await renderChunkToCanvas(chunkData);
      chunkData.segmentCanvases = segmentCanvases;
      chunkData.canvas = segmentCanvases[0];
      bakeChunkShadowEdges(chunkData);
    } catch (error) {
      console.error('Error rebaking chunk:', error);
    }
  }
}

function bakeChunkShadowEdges(chunkData: ChunkData): void {
  if (!window.mapData) return;
  const shadowLayerNames = window.mapData.shadowLayerNames;
  if (!shadowLayerNames || shadowLayerNames.length === 0) {
    chunkData.shadowLayers = undefined;
    return;
  }

  const shadowNameSet = new Set(shadowLayerNames.map((n: string) => n.toLowerCase()));
  const shadowLayers = chunkData.layers.filter((l: any) =>
    l.name && shadowNameSet.has(l.name.toLowerCase())
  );
  if (shadowLayers.length === 0) {
    chunkData.shadowLayers = undefined;
    return;
  }

  const tw = window.mapData.tilewidth;
  const th = window.mapData.tileheight;
  const pw = chunkData.width * tw;
  const ph = chunkData.height * th;

  // Silhouettes are baked with a padded apron of neighbor-chunk tiles so the
  // bottom-edge trim and blur see shapes that continue across chunk borders;
  // the result is cropped back to the chunk rect so adjacent chunks never
  // overlap (which would double-darken the translucent shadows).
  const bottomTrim = SHADOW_MAX_OFFSET + 2;
  const pad = bottomTrim + 4;
  const cw = pw + pad * 2;
  const ch = ph + pad * 2;

  const chunkX = chunkData.chunkX ?? Math.floor(chunkData.startX / chunkData.width);
  const chunkY = chunkData.chunkY ?? Math.floor(chunkData.startY / chunkData.height);

  // Build O(1) tileset lookup
  const tsInfo = new Map<number, { tileset: any; image: HTMLImageElement }>();
  for (let i = 0; i < window.mapData.tilesets.length; i++) {
    const ts = window.mapData.tilesets[i];
    const img = window.mapData.images[i];
    if (!img || !img.complete || img.naturalWidth === 0) continue;
    for (let gid = ts.firstgid; gid < ts.firstgid + ts.tilecount; gid++) {
      tsInfo.set(gid, { tileset: ts, image: img });
    }
  }

  if (chunkData.shadowLayers) {
    for (const sl of chunkData.shadowLayers) {
      sl.canvas.width = 0;
      sl.canvas.height = 0;
    }
  }

  const canvases: Array<{ canvas: HTMLCanvasElement; zIndex: number }> = [];

  // Produce one silhouette canvas per shadow layer
  for (const sl of shadowLayers) {
    if (!sl.data) continue;

    // Gather this chunk's layer plus the same layer from any loaded neighbor
    // chunk, positioned so tiles near the shared border land in the apron.
    const sources: Array<{ data: number[]; w: number; h: number; offX: number; offY: number }> = [
      { data: sl.data, w: chunkData.width, h: chunkData.height, offX: pad, offY: pad },
    ];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const neighbor = window.mapData.loadedChunks.get(`${chunkX + dx}-${chunkY + dy}`);
        const nl = neighbor?.layers?.find((l: any) => l.name === sl.name);
        if (!nl?.data) continue;
        sources.push({
          data: nl.data,
          w: neighbor.width,
          h: neighbor.height,
          offX: pad + (dx === -1 ? -neighbor.width * tw : dx * pw),
          offY: pad + (dy === -1 ? -neighbor.height * th : dy * ph),
        });
      }
    }

    let sil: HTMLCanvasElement | null = null;
    let sctx: CanvasRenderingContext2D | null = null;

    for (const src of sources) {
      const startTx = Math.max(0, Math.floor(-src.offX / tw));
      const endTx = Math.min(src.w - 1, Math.ceil((cw - src.offX) / tw) - 1);
      const startTy = Math.max(0, Math.floor(-src.offY / th));
      const endTy = Math.min(src.h - 1, Math.ceil((ch - src.offY) / th) - 1);
      for (let y = startTy; y <= endTy; y++) {
        for (let x = startTx; x <= endTx; x++) {
          const gid = src.data[y * src.w + x];
          if (gid === 0) continue;
          const info = tsInfo.get(gid & 0x0FFFFFFF);
          if (!info) continue;
          if (!sctx || !sil) {
            sil = document.createElement('canvas');
            sil.width = cw; sil.height = ch;
            sctx = sil.getContext('2d')!;
            sctx.imageSmoothingEnabled = false;
          }
          const ts = info.tileset; const img = info.image;
          const li = (gid & 0x0FFFFFFF) - ts.firstgid;
          const tpr = Math.floor(ts.imagewidth / ts.tilewidth);
          sctx.drawImage(img,
            (li % tpr) * ts.tilewidth,
            Math.floor(li / tpr) * ts.tileheight,
            ts.tilewidth, ts.tileheight,
            src.offX + x * tw, src.offY + y * th, tw, th);
        }
      }
    }

    if (!sil || !sctx) continue;

    // Convert colored tiles to solid black silhouette
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = '#000000';
    sctx.fillRect(0, 0, cw, ch);

    // Objects don't cast from their base: erode the silhouette's bottom edges by
    // the maximum downward sun offset (+ blur radius), keeping only pixels that
    // still have silhouette material that far below them. This stops the
    // translated silhouette's bottom outline from protruding beneath the object.
    const trimmed = document.createElement('canvas');
    trimmed.width = cw; trimmed.height = ch;
    const tctx = trimmed.getContext('2d')!;
    tctx.drawImage(sil, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(sil, 0, -bottomTrim);

    // Blur for soft shadow edges
    const blurred = document.createElement('canvas');
    blurred.width = cw; blurred.height = ch;
    const bctx = blurred.getContext('2d')!;
    bctx.filter = 'blur(2px)';
    bctx.drawImage(trimmed, 0, 0);

    // Crop the apron away so the stored canvas maps 1:1 onto the chunk rect
    const cropped = document.createElement('canvas');
    cropped.width = pw; cropped.height = ph;
    const cctx = cropped.getContext('2d')!;
    cctx.drawImage(blurred, pad, pad, pw, ph, 0, 0, pw, ph);

    canvases.push({ canvas: cropped, zIndex: Number(sl.zIndex) });

    sil.width = 0; sil.height = 0;
    trimmed.width = 0; trimmed.height = 0;
    blurred.width = 0; blurred.height = 0;
  }

  chunkData.shadowLayers = canvases.length > 0 ? canvases : undefined;
}

// True when any shadow layer has a tile in the chunk's outermost tile ring -
// only then can this chunk's content affect a neighbor's baked silhouette apron.
function hasShadowTilesNearBorder(chunkData: ChunkData): boolean {
  const shadowLayerNames = window.mapData?.shadowLayerNames;
  if (!shadowLayerNames || shadowLayerNames.length === 0) return false;
  const shadowNameSet = new Set(shadowLayerNames.map((n: string) => n.toLowerCase()));
  const w = chunkData.width;
  const h = chunkData.height;
  for (const l of chunkData.layers) {
    if (!l.name || !shadowNameSet.has(l.name.toLowerCase()) || !l.data) continue;
    for (let x = 0; x < w; x++) {
      if (l.data[x] !== 0 || l.data[(h - 1) * w + x] !== 0) return true;
    }
    for (let y = 0; y < h; y++) {
      if (l.data[y * w] !== 0 || l.data[y * w + w - 1] !== 0) return true;
    }
  }
  return false;
}

// Re-bake the shadow silhouettes of loaded chunks adjacent to (chunkX, chunkY)
// so shapes spanning chunk borders pick up newly available neighbor context.
function rebakeNeighborShadowEdges(chunkX: number, chunkY: number): void {
  if (!window.mapData?.shadowLayerNames?.length) return;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbor = window.mapData.loadedChunks.get(`${chunkX + dx}-${chunkY + dy}`);
      if (neighbor) bakeChunkShadowEdges(neighbor);
    }
  }
}

export { clearMapCache, renderChunkToCanvas, clearChunkFromCache, isChunkCached, rebakeAllChunks, bakeChunkShadowEdges };
