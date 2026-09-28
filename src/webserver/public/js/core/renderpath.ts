// Chooses the map rendering path once, at startup.
//
// Desktop uses glmap/ (one hidden WebGL canvas, copied into the 2D canvases).
// Mobile uses glmap-mobile/ (one WebGL canvas per surface placed in the page,
// no canvas->canvas copies, smaller atlas pages) which iOS Safari needs.
//
// Override for testing: ?renderer=mobile or ?renderer=desktop
function detectMobileRenderer(): boolean {
  try {
    const override = new URLSearchParams(window.location.search).get("renderer");
    if (override === "mobile") return true;
    if (override === "desktop") return false;
  } catch {
    // Fall through to device detection.
  }
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  // iPadOS 13+ reports itself as a Mac; a Mac has no multi-touch screen.
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

export const MOBILE_RENDERER: boolean = detectMobileRenderer();

export function isMobileRenderer(): boolean {
  return MOBILE_RENDERER;
}
