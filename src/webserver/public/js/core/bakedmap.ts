/**
 * The current map's baked image (the asset server's /worldmap: one pixel per tile, baked at server start), shared by
 * the minimap and the full world map (M). Loaded once per map; asking for it starts the load.
 */
let image: HTMLImageElement | null = null;
let imageMap = "";
let state: "idle" | "loading" | "ready" | "missing" = "idle";

function currentMap(): string {
  return String(window.mapData?.name ?? "").replace(/\.json$/i, "");
}

/** The baked image of the current map, null while it loads or when the server has none (`state` says which). */
export function bakedMap(): { image: HTMLImageElement | null; state: typeof state; map: string } {
  const name = currentMap();
  if (name && name !== imageMap) {
    imageMap = name; image = null; state = "loading";
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { if (imageMap === name) { image = img; state = "ready"; } };
    img.onerror = () => { if (imageMap === name) state = "missing"; };
    img.src = `${(window as any).__assetServerUrl || ""}/worldmap?name=${encodeURIComponent(name)}`;
  }
  return { image: imageMap === name ? image : null, state: name ? state : "idle", map: name };
}
