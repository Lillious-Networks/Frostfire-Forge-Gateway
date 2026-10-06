/**
 * The current map's baked image (the asset server's /worldmap: one pixel per tile, baked at server start), shared by
 * the minimap and the full world map (M). Loaded once per map; asking for it starts the load.
 */
let image: HTMLImageElement | null = null;
let imageMap = "";
let state: "idle" | "loading" | "ready" | "missing" = "idle";
/**
 * Tiles one pixel of the image covers along each axis. 1 for every map baked a pixel per tile; a world too large for
 * that (the 10240 x 10240 continent) is baked smaller by a whole factor, read here from the image's size against the
 * map's.
 */
let scale = 1;

function currentMap(): string {
  return String(window.mapData?.name ?? "").replace(/\.json$/i, "");
}

function scaleOf(img: HTMLImageElement): number {
  const tiles = Number(window.mapData?.width) || 0;
  const ratio = img.naturalWidth > 0 ? tiles / img.naturalWidth : 1, whole = Math.round(ratio);
  return whole >= 2 && Math.abs(ratio - whole) < 0.01 ? whole : 1;
}

/**
 * A world's image is several tiles to a pixel (scale > 1): too coarse close up. Its full-detail pieces are regions of
 * DETAIL_TILES tiles a side at one pixel per tile, which the asset server bakes on request (/worldmap?name&rx&ry).
 * Shared by the world map zoomed in and the minimap zoomed out. Kept while the map stays the same, the oldest dropped
 * past DETAIL_KEEP (a piece is 4 MB once decoded). Null while a piece loads.
 */
export const DETAIL_TILES = 1024;
const DETAIL_KEEP = 24;
const detail = new Map<string, { img: HTMLImageElement; ready: boolean }>();
export function mapDetailPiece(rx: number, ry: number): HTMLImageElement | null {
  const name = currentMap(), key = `${name}:${rx},${ry}`;
  let piece = detail.get(key);
  if (!piece) {
    for (const k of detail.keys()) if (!k.startsWith(`${name}:`)) detail.delete(k);
    const img = new Image();
    piece = { img, ready: false };
    const made = piece;
    img.crossOrigin = "anonymous";
    img.onload = () => { made.ready = true; };
    img.src = `${(window as any).__assetServerUrl || ""}/worldmap?name=${encodeURIComponent(name)}&rx=${rx}&ry=${ry}`;
    detail.set(key, piece);
    if (detail.size > DETAIL_KEEP) { const oldest = detail.keys().next().value; if (oldest !== undefined) detail.delete(oldest); }
  }
  return piece.ready ? piece.img : null;
}

/** The baked image of the current map, null while it loads or when the server has none (`state` says which). */
export function bakedMap(): { image: HTMLImageElement | null; state: typeof state; map: string; scale: number } {
  const name = currentMap();
  if (name && name !== imageMap) {
    imageMap = name; image = null; state = "loading"; scale = 1;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { if (imageMap === name) { image = img; scale = scaleOf(img); state = "ready"; } };
    img.onerror = () => { if (imageMap === name) state = "missing"; };
    img.src = `${(window as any).__assetServerUrl || ""}/worldmap?name=${encodeURIComponent(name)}`;
  }
  return { image: imageMap === name ? image : null, state: name ? state : "idle", map: name, scale: imageMap === name ? scale : 1 };
}
