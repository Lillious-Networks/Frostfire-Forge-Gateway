/**
 * The pixels of an emissive light field (lightmap.ts), computed in floats.
 *
 * The field is one texel per tile: a colour-dodge colour at alpha = the light's amount. Scaling that up on a canvas loses
 * it where the light is faint: a canvas keeps colour premultiplied in 8 bits, so at alpha 6 / 255 a dodge colour of 0.93
 * (a dark cave: the gain back to daylight is large, the colour close to 1) is stored as 6 / 6 = 1, which colour-dodge
 * clips to white, and at alpha 22 it is 20 / 22, a third less light than at alpha 21 (USER FEEDBACK 2026-10-03, "a
 * slight band on the outside of the edges": measured, the light was up to 46 % off and fell 16 times on its way up to
 * the lava, with a red rim where only red clipped). So the same scaling is done here in floats, and each pixel is
 * written opaque: colour-dodge at alpha 1 is a plain gain 1 / (1 - c), with all 8 bits on c. The last bit is dithered,
 * so the steps of c (0.4 % of the light at gain 2, 5 % at gain 12) do not show as contours either. A gain that 8 bits
 * hold exactly is written as it is, without dither: `exactGain` gives the nearest such gain, which lightmap.ts uses for
 * the emissive tiles themselves, so a lava lake is lit evenly, without the dither's grain.
 */

/** how close to a whole 8-bit value counts as that value (float rounding of an exact gain) */
const EXACT = 1e-3;

/** The gain nearest to `gain` that an opaque colour-dodge pixel holds exactly (255 / (255 - n), n whole). */
export function exactGain(gain: number): number {
  return 255 / (255 - Math.round(255 * (1 - 1 / Math.max(1, gain))));
}

/** Bilinear resize of an interleaved float image, as a canvas drawImage scales one (pixel centres, edges clamped). */
function resize(src: Float32Array, sw: number, sh: number, dw: number, dh: number, ch: number): Float32Array {
  const dst = new Float32Array(dw * dh * ch);
  for (let y = 0; y < dh; y++) {
    const v = Math.max(0, Math.min(sh - 1, (y + 0.5) * sh / dh - 0.5)), y0 = Math.floor(v), y1 = Math.min(sh - 1, y0 + 1), fy = v - y0;
    for (let x = 0; x < dw; x++) {
      const u = Math.max(0, Math.min(sw - 1, (x + 0.5) * sw / dw - 0.5)), x0 = Math.floor(u), x1 = Math.min(sw - 1, x0 + 1), fx = u - x0;
      const i00 = (y0 * sw + x0) * ch, i01 = (y0 * sw + x1) * ch, i10 = (y1 * sw + x0) * ch, i11 = (y1 * sw + x1) * ch, o = (y * dw + x) * ch;
      // alpha is the last channel: nothing to blend where no light reaches
      if (!src[i00 + ch - 1] && !src[i01 + ch - 1] && !src[i10 + ch - 1] && !src[i11 + ch - 1]) continue;
      for (let k = 0; k < ch; k++) {
        const top = src[i00 + k]! + (src[i01 + k]! - src[i00 + k]!) * fx, bottom = src[i10 + k]! + (src[i11 + k]! - src[i10 + k]!) * fx;
        dst[o + k] = top + (bottom - top) * fy;
      }
    }
  }
  return dst;
}

/** A dither threshold, 0..1, per pixel: the R2 sequence (plastic number), an even spread without clumps or stripes. */
function dither(x: number, y: number): number {
  const n = 0.7548776662466927 * x + 0.5698402909980532 * y;
  return n - Math.floor(n);
}

/**
 * `texels` (w x h, four floats each: the dodge colour's r, g, b premultiplied by the light's amount, then the amount)
 * scaled up to ow x oh RGBA pixels: 1 px per tile, to 4 px, to the size asked (two bilinear steps: fewer diamonds than
 * one), then per pixel the gain the light gives each channel, as an opaque colour-dodge colour.
 */
export function spillPixels(texels: Float32Array, w: number, h: number, ow: number, oh: number): Uint8ClampedArray {
  const light = resize(resize(texels, w, h, w * 4, h * 4, 4), w * 4, h * 4, ow, oh, 4), out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const i = (y * ow + x) * 4, amount = light[i + 3]!;
    out[i + 3] = 255;
    if (amount <= 0) continue;
    // the threshold kept EXACT clear of 0 and 1, so a whole value stays that value whatever the pixel
    const d = EXACT + dither(x, y) * (1 - 2 * EXACT);
    for (let k = 0; k < 3; k++) {
      // blended at its amount, a dodge colour c gives the gain 1 + amount * c / (1 - c); opaque, that gain is 1 / (1 - c')
      const c = light[i + k]! / amount, gain = 1 + amount * c / (1 - c);
      out[i + k] = Math.floor(255 * (1 - 1 / gain) + d);
    }
  }
  return out;
}
