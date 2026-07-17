import { getEffectiveTime } from "./ambience.js";
import { getWeatherType } from "./renderer.js";

export const SHADOW_MAX_OFFSET = 14;

interface ShadowParams {
  offsetX: number;
  offsetY: number;
  alpha: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function smoothWindow(hour24: number): number {
  const fadeInStart = 5, fadeInEnd = 7;
  const fadeOutStart = 17, fadeOutEnd = 19;

  if (hour24 < fadeInStart || hour24 > fadeOutEnd) return 0;
  if (hour24 < fadeInEnd) {
    return smoothstep((hour24 - fadeInStart) / (fadeInEnd - fadeInStart));
  }
  if (hour24 > fadeOutStart) {
    return 1 - smoothstep((hour24 - fadeOutStart) / (fadeOutEnd - fadeOutStart));
  }
  return 1;
}

export function getShadowParams(): ShadowParams {
  const { hours, minutes } = getEffectiveTime();
  const hour24 = hours + minutes / 60;

  const sunAng = (hour24 - 12) * Math.PI / 12;
  const len = smoothstep(Math.abs(Math.sin(sunAng)));

  const fade = smoothWindow(hour24);

  return {
    offsetX: -SHADOW_MAX_OFFSET * Math.sin(sunAng),
    offsetY: SHADOW_MAX_OFFSET * len,
    alpha: 0.35 * len * fade,
  };
}

export function renderShadows(
  ctx: CanvasRenderingContext2D,
  visibleChunks: Array<{ x: number; y: number }>,
  shadowZ: number,
  offsetX: number,
  offsetY: number
): void {
  if (!window.mapData) return;

  if (getWeatherType() === "thunderstorm") return;

  const params = getShadowParams();
  if (params.alpha < 0.005) return;

  ctx.save();
  ctx.globalAlpha = params.alpha;

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;

  for (const chunk of visibleChunks) {
    const chunkData = window.mapData.loadedChunks.get(`${chunk.x}-${chunk.y}`);
    if (!chunkData) continue;

    const shadowLayers = chunkData.shadowLayers;
    if (!shadowLayers || shadowLayers.length === 0) continue;

    const ox = chunk.x * chunkPixelSize + params.offsetX + offsetX;
    const oy = chunk.y * chunkPixelSize + params.offsetY + offsetY;

    for (const sl of shadowLayers) {
      if (sl.zIndex !== shadowZ) continue;
      ctx.drawImage(sl.canvas, ox, oy);
    }
  }

  ctx.restore();
}
