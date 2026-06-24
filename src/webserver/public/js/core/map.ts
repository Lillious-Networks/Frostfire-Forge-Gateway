import { canvas, ctx, progressBar, loadingScreen } from "../core/ui";
import { invalidateTilesetLookupCache, recordChunkLoadTime } from "./renderer.js";
import pako from "../libs/pako.js";
import { config } from "../web/global.js";

const PLAYER_Z_INDEX = config?.PLAYER_Z_INDEX;
declare global {
  interface Window {
    mapData?: any;
  }
}

interface AnimationFrame {
  tileid: number;
  duration: number;
}

interface AnimatedTile {
  layerGroup: 'lower' | 'upper';
  zIndex: number;
  destX: number;
  destY: number;
  tilesetIndex: number;
  tileset: any;
  animation: AnimationFrame[];
  totalDuration: number;
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
  }>;
  canvas?: HTMLCanvasElement;
  lowerCanvas?: HTMLCanvasElement;
  upperCanvas?: HTMLCanvasElement;
  animatedTiles?: AnimatedTile[];
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
      window.mapData.loadedChunks.clear();
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

    await clearMapCache(mapName);
    progressBar.style.width = "10%";

    const images = await loadTilesets(tilesets);
    if (!images.length) {
      console.warn("No tileset images loaded, continuing with empty tilesets");
    }

    progressBar.style.width = "30%";

    // Dynamic chunk sizing: maintain consistent chunk pixel size (~1024px²) regardless of tile size
    const CHUNK_SIZE_CONFIG: { [key: number]: number } = {
      16: 64,   // 16px tiles → 64 tile chunks = 1024×1024px
      32: 32,   // 32px tiles → 32 tile chunks = 1024×1024px
      64: 16,   // 64px tiles → 16 tile chunks = 1024×1024px
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
      images: images,
      chunksX: chunksX,
      chunksY: chunksY,
      chunkSize: CHUNK_SIZE,
      loadedChunks: preloadedChunks,
      spawnX: spawnX,
      spawnY: spawnY,
      warps: metadata?.warps || null,
      graveyards: metadata?.graveyards || null,
      objectLayers: objectLayers,
      requestChunk: async (chunkX: number, chunkY: number) => {
        return await requestChunk(chunkX, chunkY);
      },
      getChunkCanvas: (chunkX: number, chunkY: number) => {
        return getChunkCanvas(chunkX, chunkY);
      },
      getChunkLowerCanvas: (chunkX: number, chunkY: number) => {
        return getChunkLowerCanvas(chunkX, chunkY);
      },
      getChunkUpperCanvas: (chunkX: number, chunkY: number) => {
        return getChunkUpperCanvas(chunkX, chunkY);
      },
    };

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

async function requestChunk(chunkX: number, chunkY: number): Promise<ChunkData | null> {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;

  const existingChunk = window.mapData.loadedChunks.get(chunkKey);
  if (existingChunk && existingChunk.canvas && existingChunk.lowerCanvas && existingChunk.upperCanvas) {
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

    const { lowerCanvas, upperCanvas } = await renderChunkToCanvas(chunkData);
    chunkData.lowerCanvas = lowerCanvas;
    chunkData.upperCanvas = upperCanvas;
    chunkData.canvas = lowerCanvas;

    window.mapData.loadedChunks.set(chunkKey, chunkData);

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

async function renderChunkToCanvas(chunkData: ChunkData): Promise<{lowerCanvas: HTMLCanvasElement, upperCanvas: HTMLCanvasElement}> {
  if (!window.mapData) throw new Error("Map data not initialized");

  const pixelWidth = chunkData.width * window.mapData.tilewidth;
  const pixelHeight = chunkData.height * window.mapData.tileheight;

  const lowerCanvas = document.createElement("canvas");
  const upperCanvas = document.createElement("canvas");

  lowerCanvas.width = pixelWidth;
  lowerCanvas.height = pixelHeight;
  upperCanvas.width = pixelWidth;
  upperCanvas.height = pixelHeight;

  const lowerCtx = lowerCanvas.getContext("2d", { willReadFrequently: false, alpha: true });
  const upperCtx = upperCanvas.getContext("2d", { willReadFrequently: false, alpha: true });

  if (!lowerCtx || !upperCtx) throw new Error("Failed to get canvas context");

  lowerCtx.imageSmoothingEnabled = false;
  upperCtx.imageSmoothingEnabled = false;
  lowerCtx.clearRect(0, 0, pixelWidth, pixelHeight);
  upperCtx.clearRect(0, 0, pixelWidth, pixelHeight);

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
    if (layerName.includes('collision') || layerName.includes('nopvp') || layerName.includes('no-pvp')) {
      continue;
    }

    const ctx = layer.zIndex < Number(PLAYER_Z_INDEX) ? lowerCtx : upperCtx;

    let tileCount = 0;

    for (let y = 0; y < chunkData.height; y++) {
      for (let x = 0; x < chunkData.width; x++) {
        const tileIndex = layer.data[y * chunkData.width + x];
        if (tileIndex === 0) continue;

        // Animated tiles are not baked into the static chunk canvas; they are
        // recorded here and drawn per-frame by the renderer on top of this layer group.
        const animInfo = animatedTileLookup.get(tileIndex);
        if (animInfo) {
          animatedTiles.push({
            layerGroup: layer.zIndex < Number(PLAYER_Z_INDEX) ? 'lower' : 'upper',
            zIndex: layer.zIndex,
            destX: x * window.mapData.tilewidth,
            destY: y * window.mapData.tileheight,
            tilesetIndex: animInfo.tilesetIndex,
            tileset: animInfo.tileset,
            animation: animInfo.animation,
            totalDuration: animInfo.totalDuration,
          });
          continue;
        }

        // Use fast O(1) tileset lookup
        const tilesetInfo = tilesetLookupMap.get(tileIndex);
        if (!tilesetInfo) continue;

        const tileset = tilesetInfo.tileset;
        const image = tilesetInfo.image;

        const localTileIndex = tileIndex - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
        const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

        try {
          ctx.drawImage(
            image,
            tileX, tileY,
            tileset.tilewidth, tileset.tileheight,
            x * window.mapData.tilewidth,
            y * window.mapData.tileheight,
            window.mapData.tilewidth, window.mapData.tileheight
          );
        } catch (drawError) {
            console.error(`Error drawing tile at (${x}, ${y}) in layer "${layer.name}":`, drawError);
        }

        tileCount++;

        // Yield to browser every TILES_PER_FRAME tiles to keep frame rate smooth
        if (tileCount % TILES_PER_FRAME === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }

  // Order animated tiles by layer zIndex so stacked animations draw correctly.
  animatedTiles.sort((a, b) => a.zIndex - b.zIndex);
  chunkData.animatedTiles = animatedTiles;

  return { lowerCanvas, upperCanvas };
}

function getChunkCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.canvas || null;
}

function getChunkLowerCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.lowerCanvas || null;
}

function getChunkUpperCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.upperCanvas || null;
}

export { clearMapCache, renderChunkToCanvas, clearChunkFromCache, isChunkCached };
