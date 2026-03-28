import { canvas, ctx, progressBar, loadingScreen } from "../core/ui";
import pako from "../libs/pako.js";

declare global {
  interface Window {
    mapData?: any;
  }
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
}

export default async function loadMap(metadata: any): Promise<boolean> {
    if (loadingScreen) {
      loadingScreen.style.display = "flex";
      loadingScreen.style.opacity = "1";
      loadingScreen.style.transition = "0s";
      progressBar.style.width = "0%";
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
        tilesets = mapData.tilesets || [];
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

    clearMapCache(mapName);
    progressBar.style.width = "10%";

    const images = await loadTilesets(tilesets);
    if (!images.length) {
      console.warn("No tileset images loaded, continuing with empty tilesets");
    }

    progressBar.style.width = "30%";

    const CHUNK_SIZE = tilewidth;
    const chunksX = Math.ceil(mapWidth / CHUNK_SIZE);
    const chunksY = Math.ceil(mapHeight / CHUNK_SIZE);

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
      loadedChunks: new Map<string, ChunkData>(),
      spawnX: spawnX,
      spawnY: spawnY,
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

    progressBar.style.width = "100%";

    const dpr = window.devicePixelRatio || 1;

    const actualHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const fullHeight = actualHeight;
    canvas.width = window.innerWidth * dpr;
    canvas.height = fullHeight * dpr;

    const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

    document.documentElement.style.setProperty('--viewport-height', `${actualHeight}px`);

    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.backgroundColor = "#000000";

    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = fullHeight + "px";

    canvas.style.display = "block";

    if (ctx) {

      if (isTouchDevice) {
        const mobileZoom = 0.85;
        ctx.scale(dpr * mobileZoom, dpr * mobileZoom);

        ctx.translate((window.innerWidth * (1 - mobileZoom)) / (2 * mobileZoom),
                      (fullHeight * (1 - mobileZoom)) / (2 * mobileZoom));
      } else {
        ctx.scale(dpr, dpr);
      }

    }

    await new Promise(resolve => setTimeout(resolve, 1500));

    return true;
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

function getCacheKey(mapName: string, chunkX: number, chunkY: number): string {
  return `chunk_${mapName}_${chunkX}_${chunkY}`;
}

function saveChunkToCache(mapName: string, chunkX: number, chunkY: number, chunkData: ChunkData): void {
  try {
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    const cacheData = {
      timestamp: Date.now(),
      data: chunkData,
    };
    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
  } catch (error) {
    console.error("Error saving chunk to cache:", error);
  }
}

function clearChunkFromCache(mapName: string, chunkX: number, chunkY: number): void {
  try {
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    localStorage.removeItem(cacheKey);
  } catch (error) {
    console.error("Error clearing chunk from cache:", error);
  }
}

function loadChunkFromCache(mapName: string, chunkX: number, chunkY: number): ChunkData | null {
  try {
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    const cached = localStorage.getItem(cacheKey);

    if (!cached) return null;

    const cacheData = JSON.parse(cached);
    const age = Date.now() - cacheData.timestamp;

    if (age > CACHE_EXPIRY_MS) {
      localStorage.removeItem(cacheKey);
      return null;
    }

    return cacheData.data;
  } catch (error) {
    return null;
  }
}

function clearMapCache(mapName?: string): void {
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (mapName) {

        if (key.startsWith(`chunk_${mapName}_`)) {
          localStorage.removeItem(key);
        }
      } else {

        if (key.startsWith('chunk_')) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch (error) {
    console.error("Error clearing map cache:", error);
  }
}

async function requestChunk(chunkX: number, chunkY: number): Promise<ChunkData | null> {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;

  if (window.mapData.loadedChunks.has(chunkKey)) {
    return window.mapData.loadedChunks.get(chunkKey)!;
  }

  if (chunkX < 0 || chunkY < 0 || chunkX >= window.mapData.chunksX || chunkY >= window.mapData.chunksY) {
    return null;
  }

  try {

    const cachedChunkData = loadChunkFromCache(window.mapData.name, chunkX, chunkY);
    let chunkData: ChunkData | null;

    if (cachedChunkData) {

      chunkData = cachedChunkData;
    } else {

      try {
        chunkData = await requestChunkViaAssetServer(window.mapData.name, chunkX, chunkY);
        if (!chunkData) {
          return null;
        }

        saveChunkToCache(window.mapData.name, chunkX, chunkY, chunkData);
      } catch (error) {
        return null;
      }
    }

    const { lowerCanvas, upperCanvas } = await renderChunkToCanvas(chunkData);
    chunkData.lowerCanvas = lowerCanvas;
    chunkData.upperCanvas = upperCanvas;
    chunkData.canvas = lowerCanvas;

    window.mapData.loadedChunks.set(chunkKey, chunkData);

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

  const PLAYER_Z_INDEX = 3;

  for (let layerIdx = 0; layerIdx < sortedLayers.length; layerIdx++) {
    const layer = sortedLayers[layerIdx];

    const layerName = layer.name ? layer.name.toLowerCase() : '';
    if (layerName.includes('collision') || layerName.includes('nopvp') || layerName.includes('no-pvp')) {
      continue;
    }

    const ctx = layer.zIndex < PLAYER_Z_INDEX ? lowerCtx : upperCtx;

    const BATCH_SIZE = 100;
    let tileCount = 0;

    for (let y = 0; y < chunkData.height; y++) {
      for (let x = 0; x < chunkData.width; x++) {
        const tileIndex = layer.data[y * chunkData.width + x];
        if (tileIndex === 0) continue;

        const tileset = window.mapData.tilesets.find(
          (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
        );
        if (!tileset) continue;

        const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
        if (!image || !image.complete || image.naturalWidth === 0) continue;

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

        if (tileCount % BATCH_SIZE === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }

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

export { clearMapCache, renderChunkToCanvas, clearChunkFromCache };
