import { canvas, ctx, progressBar, loadingScreen } from "../core/ui";
import { recordChunkLoadTime, clearChunkTracking } from "./renderer.js";
import pako from "../libs/pako.js";
import { config } from "../web/global.js";
import { setMap } from "./glmap/index.js";
import { setMap as setMapMobile } from "./glmap-mobile/index.js";
import { MOBILE_RENDERER } from "./renderpath.js";

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
}

// Decoded tileset images persist across map changes so warping back to a
// recently visited map skips the fetch + pako inflate + image decode entirely.
const tilesetImageCache = new Map<string, Promise<HTMLImageElement>>();
const TILESET_IMAGE_CACHE_MAX = 8;

// Tileset <img> elements can have their decoded pixels discarded by the browser
// and re-decoded synchronously on drawImage; an ImageBitmap stays decoded, so
// the tile atlas is packed from it when available.
const tilesetBitmaps = new WeakMap<HTMLImageElement, ImageBitmap>();

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

    const mapVersion = metadata?.mapVersion || '';
    if (mapVersion) {
      const cachedVersion = await getCachedMapVersion(mapName);
      if (cachedVersion !== mapVersion) {
        await clearMapCache(mapName);
        await setCachedMapVersion(mapName, mapVersion);
      }
    }

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
      // the map's sections, when it has them (rectangles in tiles: the cave systems of a world's underworld); the
      // world map shows only the one the player is in (worldmap.ts)
      sections: Array.isArray(metadata?.sections) ? metadata.sections : null,
      // the inside of a building (a house's room): no world map there, and the minimap stays zoomed all the way in
      interior: metadata?.interior === true,
      objectLayers: objectLayers,
      requestChunk: async (chunkX: number, chunkY: number) => {
        return await requestChunk(chunkX, chunkY);
      },
    };

    // Seed the layer cuts from preloaded chunks' layer structure; otherwise
    // they're computed when the first chunk loads.
    for (const preloadedChunk of preloadedChunks.values()) {
      const layers = (preloadedChunk as any)?.layers;
      if (Array.isArray(layers)) {
        window.mapData.layerCuts = computeLayerCuts(layers);
        break;
      }
    }

    // Build the GPU tile atlas for this map's tilesets.
    if (MOBILE_RENDERER) {
      // Mobile packs the atlas from the <img> elements (no ImageBitmaps).
      setMapMobile(window.mapData, images.map((img) =>
        img && img.complete && img.naturalWidth > 0 ? img : null
      ));
    } else {
      setMap(window.mapData, images.map((img) =>
        img && img.complete && img.naturalWidth > 0 ? (tilesetBitmaps.get(img) ?? img) : null
      ));
    }

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

    // Nearest chunks first so the spawn area is ready before the outer ring.
    chunksToLoad.sort((a, b) => {
      const da = (a.x - spawnChunkX) ** 2 + (a.y - spawnChunkY) ** 2;
      const db = (b.x - spawnChunkX) ** 2 + (b.y - spawnChunkY) ** 2;
      return da - db;
    });

    const totalChunks = chunksToLoad.length;
    let loadedCount = 0;

    const chunkPromises = chunksToLoad.map(chunk =>
      requestChunk(chunk.x, chunk.y).then(chunkData => {
        if (chunkData) {
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
    // Mobile: the map is drawn by #map-below underneath this canvas.
    canvas.style.backgroundColor = MOBILE_RENDERER ? "transparent" : "#000000";

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
              void saveChunkToCache(mapName, chunk.x, chunk.y, chunkData);
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

  const tilesetPromises = tilesets.map(async (tileset) => {
    const name = tileset.image.split("/").pop();

    const cached = tilesetImageCache.get(name);
    if (cached) return await cached;

    const assetServerUrl = (window as any).__assetServerUrl || "";
    if (!assetServerUrl) {
      throw new Error("Asset server URL not configured - cannot load tilesets");
    }

    const imagePromise = (async () => {
      const response = await fetch(`${assetServerUrl}/tileset?name=${encodeURIComponent(name)}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch tileset ${name}: ${response.statusText}`);
      }
      const tilesetData = await response.json();
      const compressedBase64 = tilesetData.data;
      const compressedBytes = base64ToUint8Array(compressedBase64);

      //@ts-expect-error - Imported via HTML
      const inflatedBytes = pako.inflate(compressedBytes);
      const blob = new Blob([inflatedBytes], { type: "image/png" });

      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        const objectUrl = URL.createObjectURL(blob);

        image.onload = () => {
          URL.revokeObjectURL(objectUrl);
          if (image.complete && image.naturalWidth > 0) resolve(image);
          else reject(new Error(`Image loaded but invalid: ${name}`));
        };

        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error(`Failed to load tileset image: ${name}`));
        };

        image.src = objectUrl;

        setTimeout(() => {
          if (!image.complete)
            reject(new Error(`Timeout loading tileset image: ${name}`));
        }, 15000);
      });

      // Mobile packs the atlas from the <img> element instead.
      if (!MOBILE_RENDERER) {
        try {
          tilesetBitmaps.set(image, await createImageBitmap(blob));
        } catch {
          // Fall back to drawing from the <img> element.
        }
      }

      return image;
    })();

    // Failed decodes must not poison the cache permanently.
    imagePromise.catch(() => tilesetImageCache.delete(name));

    tilesetImageCache.set(name, imagePromise);
    if (tilesetImageCache.size > TILESET_IMAGE_CACHE_MAX) {
      const oldest = tilesetImageCache.keys().next().value;
      if (oldest !== undefined) tilesetImageCache.delete(oldest);
    }

    return await imagePromise;
  });

  return Promise.all(tilesetPromises);
}

const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CACHE_DB_NAME = 'map-chunk-cache';
const CACHE_DB_VERSION = 2;

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
      if (!db.objectStoreNames.contains('versions')) {
        db.createObjectStore('versions', { keyPath: 'mapName' });
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
    // Store only the serializable tile data: the live chunk object gains
    // canvases while it bakes, which IndexedDB can't structured-clone.
    const data = {
      chunkX: chunkData.chunkX,
      chunkY: chunkData.chunkY,
      startX: chunkData.startX,
      startY: chunkData.startY,
      width: chunkData.width,
      height: chunkData.height,
      tilewidth: chunkData.tilewidth,
      tileheight: chunkData.tileheight,
      layers: chunkData.layers,
    };
    const cacheEntry = { id: cacheKey, timestamp: Date.now(), data };

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

async function getCachedMapVersion(mapName: string): Promise<string | null> {
  try {
    const db = await getCacheDB();
    const entry = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction('versions', 'readonly');
      const store = tx.objectStore('versions');
      const req = store.get(mapName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return entry?.version || null;
  } catch {
    return null;
  }
}

async function setCachedMapVersion(mapName: string, version: string): Promise<void> {
  try {
    const db = await getCacheDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('versions', 'readwrite');
      const store = tx.objectStore('versions');
      const req = store.put({ mapName, version });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch { /* ignore */ }
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
  // A LOAD_MAP while this request is in flight replaces window.mapData; the
  // result then belongs to a map that's gone and must not be installed.
  const mapData = window.mapData;

  const chunkKey = `${chunkX}-${chunkY}`;

  // Chunks placed in loadedChunks directly (warp preloading, editor-created
  // chunks) are drawable as-is; they only need installing once.
  const existingChunk = mapData.loadedChunks.get(chunkKey);
  if (existingChunk) {
    if (!installedChunks.has(existingChunk)) installChunk(mapData, chunkKey, existingChunk);
    return existingChunk;
  }

  if (chunkX < 0 || chunkY < 0 || chunkX >= mapData.chunksX || chunkY >= mapData.chunksY) {
    return null;
  }

  try {

    const cachedChunkData = await loadChunkFromCache(mapData.name, chunkX, chunkY);
    if (window.mapData !== mapData) return null;
    let chunkData: ChunkData | null;

    if (cachedChunkData) {

      chunkData = cachedChunkData;
    } else {

      try {
        chunkData = await requestChunkViaAssetServer(mapData.name, chunkX, chunkY);
        if (window.mapData !== mapData) return null;
        if (!chunkData) {
          return null;
        }

        // Cache write is fire-and-forget: blocking the bake on an IndexedDB
        // transaction adds avoidable latency to every chunk load.
        void saveChunkToCache(mapData.name, chunkX, chunkY, chunkData);
      } catch (error) {
        return null;
      }
    }

    // Nothing to bake: the WebGL map renderer draws straight from the chunk's
    // tile data, uploading it the first time the chunk is on screen.
    mapData.loadedChunks.set(chunkKey, chunkData);
    installChunk(mapData, chunkKey, chunkData);

    const preloadCache = (window as any).__preloadedMaps?.[mapData.name]?.loadedChunks;
    if (preloadCache) {
      preloadCache.set(chunkKey, chunkData);
    }

    return chunkData;
  } catch (error) {
    return null;
  }
}

const installedChunks = new WeakSet<object>();

// One-time setup for a chunk entering loadedChunks.
function installChunk(mapData: any, chunkKey: string, chunkData: ChunkData): void {
  installedChunks.add(chunkData);
  if (Array.isArray(chunkData.layers)) mapData.layerCuts = computeLayerCuts(chunkData.layers);
  // Keep persisted out-of-border content visible on reload even if the LOAD_MAP
  // dimensions are stale: grow the bounds to include this chunk's content.
  growBoundsForChunk(chunkData);
  // Record chunk load time for fade-in effect
  recordChunkLoadTime(chunkKey);
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
      // The status code is spelled out: HTTP/2 and HTTP/3 carry no status text.
      const detail = (await response.text().catch(() => "")).slice(0, 120);
      throw new Error(`Failed to fetch chunk: ${response.status} ${response.statusText} ${detail}`.trim());
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

  if (!window.mapData.layerCuts) window.mapData.layerCuts = computeLayerCuts(layers);

  const chunk: any = {
    chunkX, chunkY,
    startX: chunkX * chunkSize,
    startY: chunkY * chunkSize,
    width: chunkSize,
    height: chunkSize,
    tilewidth: window.mapData.tilewidth,
    tileheight: window.mapData.tileheight,
    layers,
  };

  window.mapData.loadedChunks.set(`${chunkX}-${chunkY}`, chunk);
  installedChunks.add(chunk);
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


export { clearMapCache, clearChunkFromCache, isChunkCached };
