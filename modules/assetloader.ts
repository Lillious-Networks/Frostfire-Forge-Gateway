import path from "path";
import fs from "fs";
import log from "./logger";
import assetCache from "../services/assetCache";
import zlib from "zlib";

// Hard-coded asset paths
const assetPath = path.join(import.meta.dir, "..", "public");
const TILESETS_PATH = "tilesets";
const MAPS_PATH = "maps";

// Start total asset loading timer
const assetLoadingStartTime = performance.now();

// Load tilesets
async function loadTilesets() {
  const now = performance.now();
  const tilesets = [] as TilesetData[];
  const tilesetDir = path.join(assetPath, TILESETS_PATH);

  if (!fs.existsSync(tilesetDir)) {
    throw new Error(`Tilesets directory not found at ${tilesetDir}`);
  }

  const tilesetFiles = fs.readdirSync(tilesetDir);
  tilesetFiles.forEach((file) => {
    // Read raw file as Buffer
    const tilesetData = fs.readFileSync(path.join(tilesetDir, file));
    // Compress using gzip
    const compressedData = zlib.gzipSync(tilesetData);

    const originalSize = tilesetData.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Loaded tileset: ${file}`);
    log.debug(`Compressed tileset: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    tilesets.push({ name: file, data: compressedData });
  });

  // Store as Base64 strings to work with JSON.stringify in Redis
  await assetCache.add(
    "tilesets",
    tilesets.map(t => ({
      name: t.name,
      data: t.data.toString("base64") // encode buffer as base64
    }))
  );

  log.success(`Loaded ${tilesets.length} tileset(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

// Load maps
function loadAllMaps() {
  const now = performance.now();
  const mapDir = path.join(assetPath, MAPS_PATH);
  const maps: MapData[] = [];

  if (!fs.existsSync(mapDir)) throw new Error(`Maps directory not found at ${mapDir}`);

  const mapFiles = fs.readdirSync(mapDir).filter(f => f.endsWith(".json"));
  if (mapFiles.length === 0) throw new Error("No maps found in the maps directory");

  for (const file of mapFiles) {
    const map = processMapFile(file);
    if (map) {
      maps.push(map);
    }
  }

  assetCache.add("maps", maps);
  log.success(`Loaded ${maps.length} map(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

function processMapFile(file: string): MapData | null {
  const mapDir = path.join(assetPath, MAPS_PATH);
  const fullPath = path.join(mapDir, file);
  const parsed = tryParse(fs.readFileSync(fullPath, "utf-8"));

  if (!parsed) {
    log.error(`Failed to parse ${file} as a map`);
    return null;
  }

  const jsonString = JSON.stringify(parsed);
  const compressedData = zlib.gzipSync(jsonString);

  log.debug(`Loaded map: ${file}`);
  log.debug(`Compressed map: ${file}
  - Original: ${jsonString.length} bytes
  - Compressed: ${compressedData.length} bytes
  - Compression Ratio: ${(jsonString.length / compressedData.length).toFixed(2)}x
  - Compression Savings: ${(((jsonString.length - compressedData.length) / jsonString.length) * 100).toFixed(2)}%`);

  return {
    name: file,
    data: parsed,
    compressed: compressedData,
  };
}

function tryParse(data: string): any {
  try {
    return JSON.parse(data);
  } catch (e: any) {
    log.error(e);
    return null;
  }
}

// Export initialization function
export async function initializeAssets() {
  await loadTilesets();
  loadAllMaps();

  const assetLoadingEndTime = performance.now();
  const totalAssetLoadingTime = (assetLoadingEndTime - assetLoadingStartTime).toFixed(2);
  log.success(`✔ All assets loaded successfully in ${totalAssetLoadingTime}ms`);
}

// Types
interface TilesetData {
  name: string;
  data: Buffer;
}

interface MapData {
  name: string;
  data: any;
  compressed: Buffer;
}
