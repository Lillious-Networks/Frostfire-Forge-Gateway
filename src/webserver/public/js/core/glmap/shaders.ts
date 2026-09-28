// GLSL (WebGL2 / GLSL ES 3.00) sources for the tilemap renderer.

// Max layers drawn by one instanced call; longer runs are split into batches.
export const MAX_SLICES_PER_DRAW = 32;

// Max Gaussian taps on each side of the centre texel (blur radius 3 sigma).
export const MAX_BLUR_TAPS = 8;

// Max characters depth-sorted against the y-sorted layer per frame.
export const MAX_OCCLUDERS = 64;

// Max tiles scanned down a column to find the bottom of a y-sorted object.
const MAX_STACK_TILES = 16;

// One quad per chunk layer. The quad covers the chunk's world rect; the layer
// (texture array slice) comes from uSlices[gl_InstanceID].
export const TILE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;

uniform vec2 uOrigin;     // chunk top-left, world px
uniform vec2 uSize;       // chunk size, world px
uniform vec2 uScale;      // world px -> target px
uniform vec2 uTranslate;  // world px -> target px
uniform vec2 uViewport;   // target size, px
uniform float uFlipY;     // -1 when drawing to the canvas, 1 into a framebuffer
uniform int uSlices[${MAX_SLICES_PER_DRAW}];

out vec2 vLocal;
out vec2 vWorld;
flat out int vSlice;

void main() {
  vLocal = aCorner * uSize;
  vWorld = uOrigin + vLocal;
  vSlice = uSlices[gl_InstanceID];
  vec2 clip = (vWorld * uScale + uTranslate) / uViewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, clip.y * uFlipY, 0.0, 1.0);
}
`;

// Resolves the tile under each pixel: chunk tile id -> (animation-aware) atlas
// cell via the remap table -> Tiled flip flags -> atlas texel. Everything is
// texelFetch, so there is no filtering and no bleeding between atlas cells.
export const TILE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
precision highp usampler2D;
precision mediump sampler2DArray;

uniform usampler2DArray uChunk;
uniform usampler2D uRemap;
uniform sampler2DArray uAtlas;

uniform vec2 uTile;          // map tile size, px (atlas cells are this size)
uniform ivec2 uChunkTiles;   // chunk size, tiles
uniform int uRemapWidth;
uniform int uRemapSize;      // number of remap entries (max gid + 1)
uniform int uAtlasCols;
uniform int uAtlasRows;
uniform vec4 uClip;          // world rect: minX, minY, maxX, maxY
uniform float uAlpha;
uniform int uSilhouette;     // 1 = output alpha only (shadow silhouettes)

// Y-sorting against characters (the PLAYER_Z_INDEX layer). A tile's object is
// the unbroken vertical stack of tiles it belongs to on its layer; its base is
// the stack's bottom edge. A character whose sprite box overlaps the pixel and
// whose feet are above that base is behind the object.
//   uYSort 0: off
//   uYSort 1: draw only pixels with no character behind them (under characters)
//   uYSort 2: draw only pixels with a character behind them (over characters)
uniform int uYSort;
uniform int uOccluderCount;
uniform vec4 uOccluders[${MAX_OCCLUDERS}];      // sprite box: minX, minY, maxX, maxY (world px)
uniform float uOccluderFeet[${MAX_OCCLUDERS}];  // feet line, world y
uniform usampler2DArray uChunkBelow;       // chunk below, for stacks crossing its edge
uniform int uHasBelow;
uniform int uBelowSlice;

in vec2 vLocal;
in vec2 vWorld;
flat in int vSlice;

out vec4 outColor;

float objectBase(ivec2 t) {
  int by = t.y;
  for (int i = 0; i < ${MAX_STACK_TILES}; i++) {
    int ny = by + 1;
    uint v;
    if (ny < uChunkTiles.y) {
      v = texelFetch(uChunk, ivec3(t.x, ny, vSlice), 0).r;
    } else if (uHasBelow == 1 && ny - uChunkTiles.y < uChunkTiles.y) {
      v = texelFetch(uChunkBelow, ivec3(t.x, ny - uChunkTiles.y, uBelowSlice), 0).r;
    } else {
      break;
    }
    if (v == 0u) break;
    by = ny;
  }
  vec2 origin = vWorld - vLocal;
  return origin.y + float(by + 1) * uTile.y;
}

bool characterBehind(float baseY) {
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= uOccluderCount) break;
    vec4 o = uOccluders[i];
    if (vWorld.x >= o.x && vWorld.x < o.z && vWorld.y >= o.y && vWorld.y < o.w && uOccluderFeet[i] < baseY) return true;
  }
  return false;
}

void main() {
  if (vWorld.x < uClip.x || vWorld.y < uClip.y || vWorld.x >= uClip.z || vWorld.y >= uClip.w) discard;

  vec2 tf = vLocal / uTile;
  ivec2 t = ivec2(floor(tf));
  if (t.x < 0 || t.y < 0 || t.x >= uChunkTiles.x || t.y >= uChunkTiles.y) discard;

  uint raw = texelFetch(uChunk, ivec3(t, vSlice), 0).r;
  if (raw == 0u) discard;

  if (uYSort != 0) {
    bool behind = characterBehind(objectBase(t));
    if ((uYSort == 2) != behind) discard;
  }

  int gid = int(raw & 0x0FFFFFFFu);
  if (gid >= uRemapSize) discard;
  uint cellPlus = texelFetch(uRemap, ivec2(gid % uRemapWidth, gid / uRemapWidth), 0).r;
  if (cellPlus == 0u) discard;
  int cell = int(cellPlus) - 1;

  // Tiled applies the diagonal flip first, then H/V. Sampling inverts that:
  // undo H and V on the destination coords, then undo the diagonal (swap).
  vec2 f = fract(tf);
  if ((raw & 0x80000000u) != 0u) f.x = 1.0 - f.x;
  if ((raw & 0x40000000u) != 0u) f.y = 1.0 - f.y;
  if ((raw & 0x20000000u) != 0u) f = f.yx;

  int perPage = uAtlasCols * uAtlasRows;
  int page = cell / perPage;
  int within = cell - page * perPage;
  ivec2 cellXY = ivec2(within % uAtlasCols, within / uAtlasCols);
  ivec2 tileSize = ivec2(uTile);
  ivec2 inTile = clamp(ivec2(floor(f * uTile)), ivec2(0), tileSize - 1);
  vec4 c = texelFetch(uAtlas, ivec3(cellXY * tileSize + inTile, page), 0);

  if (uSilhouette == 1) {
    outColor = vec4(0.0, 0.0, 0.0, c.a);
  } else {
    outColor = c * uAlpha;
  }
}
`;

// Full-framebuffer quad for the shadow post passes.
export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
void main() {
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Keep a silhouette pixel only if the silhouette also exists uTrim px below it
// (row index grows with world y in the shadow framebuffers).
export const TRIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uTrim;
uniform ivec2 uSize;  // rendered region; texels beyond it are stale
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = uSize;
  float a = texelFetch(uSrc, p, 0).a;
  ivec2 q = p + ivec2(0, uTrim);
  float b = q.y < size.y ? texelFetch(uSrc, q, 0).a : 0.0;
  outColor = vec4(0.0, 0.0, 0.0, a * b);
}
`;

// One direction of a separable Gaussian blur on the alpha channel.
export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uTaps;
uniform float uWeights[${MAX_BLUR_TAPS + 1}];
uniform ivec2 uSize;  // rendered region; texels beyond it are stale
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = uSize;
  float sum = texelFetch(uSrc, p, 0).a * uWeights[0];
  for (int i = 1; i <= ${MAX_BLUR_TAPS}; i++) {
    if (i > uTaps) break;
    ivec2 a = p + uDir * i;
    ivec2 b = p - uDir * i;
    if (a.x < size.x && a.y < size.y) sum += texelFetch(uSrc, a, 0).a * uWeights[i];
    if (b.x >= 0 && b.y >= 0) sum += texelFetch(uSrc, b, 0).a * uWeights[i];
  }
  outColor = vec4(0.0, 0.0, 0.0, sum);
}
`;

// Draws the blurred shadow framebuffer back into the map pass as translucent
// black, over the world rect uOrigin..uOrigin+uSize (already sun-offset).
export const SHADOW_COMPOSITE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform vec2 uScale;
uniform vec2 uTranslate;
uniform vec2 uViewport;
uniform vec2 uUvScale;  // rendered region / framebuffer texture size
out vec2 vUv;
out vec2 vWorld;
void main() {
  vUv = aCorner * uUvScale;
  vWorld = uOrigin + aCorner * uSize;
  vec2 clip = (vWorld * uScale + uTranslate) / uViewport * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const SHADOW_COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uShadow;
uniform float uAlpha;
uniform vec4 uClip;
in vec2 vUv;
in vec2 vWorld;
out vec4 outColor;
void main() {
  if (vWorld.x < uClip.x || vWorld.y < uClip.y || vWorld.x >= uClip.z || vWorld.y >= uClip.w) discard;
  float a = texture(uShadow, vUv).a * uAlpha;
  outColor = vec4(0.0, 0.0, 0.0, a);
}
`;
