import { config } from "../web/global.js";

/**
 * The images particles emit in place of their round dot (USER REQUEST 2026-10-04: "Allow particles to choose an image
 * to emit rather than a particle"). A particle's `image` names a sprite of the asset server (assets/sprites, served by
 * /sprite?name=). Each is fetched once; until it has loaded, and when the asset server has no sprite by that name, the
 * particle is drawn as its dot.
 */
const images = new Map<string, HTMLImageElement | null>();

/** The asset server's URL of a sprite. */
export function particleImageUrl(name: string, base: string = config.ASSET_SERVER_URL || (window as any).__assetServerUrl || ""): string {
  return `${base}/sprite?name=${encodeURIComponent(name)}`;
}

async function load(key: string, url: string) {
  try {
    const res = await fetch(url);
    // (the asset server answers a name it does not have with its placeholder icon, marked by this header)
    if (!res.ok || res.headers.get("X-Asset-Fallback")) return;
    const img = new Image(), src = URL.createObjectURL(await res.blob());
    await new Promise<void>((done, fail) => { img.onload = () => done(); img.onerror = () => fail(new Error("not an image")); img.src = src; });
    if (img.naturalWidth > 0 && img.naturalHeight > 0) images.set(key, img);
  } catch {
    // no image: the particle stays its dot
  }
}

/** The loaded image of a particle's `image`, or null: none set, not loaded yet, or no such sprite. */
export function particleImage(name: unknown, base?: string): HTMLImageElement | null {
  const key = typeof name === "string" ? name.trim() : "";
  if (!key) return null;
  const known = images.get(key);
  if (known !== undefined) return known;
  images.set(key, null);
  void load(key, particleImageUrl(key, base));
  return null;
}
