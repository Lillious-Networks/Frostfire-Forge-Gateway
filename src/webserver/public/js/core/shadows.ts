import { getEffectiveTime, isDarkness } from "./ambience.js";

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

  // "darkness" weather: no sun, no shadows
  const fade = isDarkness() ? 0 : smoothWindow(hour24);

  return {
    offsetX: -SHADOW_MAX_OFFSET * Math.sin(sunAng),
    offsetY: SHADOW_MAX_OFFSET * len,
    alpha: 0.35 * len * fade,
  };
}
