// How a map's markers are drawn.
//
// On the minimap, an inn or a cave is its icon on a pale pin with a dark rim, so it reads on any
// ground. The icons alone, a brown door and a dark cave mouth, are lost on grass, roofs and rock
// under the minimap's tint. The pin's point stands on the spot it marks.
//
// On the world map, a house is its own picture, standing on its door, and a cave is a cave mouth
// over the way in.

/** The pin's round head, in minimap px. */
export const PIN_RADIUS = 13;
/** How far the head's middle is above the spot marked: the head, and the point under it. */
export const PIN_LIFT = PIN_RADIUS + 6;
/** The most room the icon takes inside the head. It keeps the picture's own shape. */
const ICON_WIDTH = 18;
const ICON_HEIGHT = 19;

/** How tall (screen px) a picture is drawn on the world map: no smaller zoomed out, no bigger zoomed in. */
const PICTURE_MIN = 16, PICTURE_MAX = 36;

/**
 * Draws a marker's picture on the world map (a house, a cave): bigger as the map is zoomed in
 * (`zoom`: screen px per tile), within what stays readable and does not bury a town. It stands on
 * (x, y), as a house does on its door, or with `centred` has its middle there, as a cave mouth has
 * over the way in. The picture is drawn as it is, with nothing behind it (USER REQUEST 2026-10-06:
 * "the world map icons don't need any blur behind them"). Answers where its top is, for a label.
 */
export function drawMapPicture(ctx: CanvasRenderingContext2D, picture: HTMLImageElement, x: number, y: number, zoom: number, centred = false): number {
  // A whole number of px, so one size is one stamp (below) and not a new one for every step of a zoom.
  const tall = Math.round(Math.max(PICTURE_MIN, Math.min(PICTURE_MAX, 14 + zoom * 5)));
  const stamp = pictureStamp(picture, tall);
  const top = centred ? y - tall / 2 : y - tall;
  ctx.drawImage(stamp.canvas, Math.round(x - stamp.width / 2), Math.round(top), stamp.width, stamp.height);
  return top;
}

interface Stamp { canvas: HTMLCanvasElement; width: number; height: number }
const stamps = new Map<string, Stamp>();

/**
 * A picture at one size, scaled down once and kept. A world has hundreds of houses and caves on its
 * map at a time: scaling the full picture down for each of them, every frame, cost far more than
 * the frame had (USER REPORT 2026-10-06: "World map is SUPER laggy with all the icons on it").
 * Stamping the kept copy costs next to nothing.
 */
function pictureStamp(picture: HTMLImageElement, tall: number): Stamp {
  // Drawn at the screen's own pixels, so it is as sharp as the map under it.
  const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const key = `${picture.src}|${tall}|${density}`;
  const kept = stamps.get(key);
  if (kept) return kept;

  const width = Math.max(1, Math.round(tall * (picture.naturalWidth / picture.naturalHeight))), height = tall;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * density);
  canvas.height = Math.ceil(height * density);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
  }
  const stamp = { canvas, width, height };
  stamps.set(key, stamp);
  return stamp;
}

/** Draws a pin with its point at (x, y). `icon` is drawn in it once it has loaded. */
export function drawMapPin(ctx: CanvasRenderingContext2D, icon: HTMLImageElement | null, x: number, y: number): void {
  const cy = y - PIN_LIFT;
  const r = PIN_RADIUS;
  ctx.save();

  // One outline round the head and its point: the point's sides leave the head a little below its middle.
  const spread = Math.PI / 5;
  ctx.beginPath();
  ctx.arc(x, cy, r, Math.PI / 2 + spread, Math.PI / 2 - spread + Math.PI * 2);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = "#FFF1DA";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#2b1a0c";
  ctx.stroke();

  if (icon && icon.complete && icon.naturalWidth > 0 && icon.naturalHeight > 0) {
    const fit = Math.min(ICON_WIDTH / icon.naturalWidth, ICON_HEIGHT / icon.naturalHeight);
    // A picture smaller than the room it has (the 16 px coin) is drawn at a whole number of times
    // its size, on whole pixels, so its pixels stay even and sharp. A bigger one is drawn at a
    // fraction of its size and smoothed, so no rows of it are dropped.
    const small = fit >= 1;
    const scale = small ? Math.floor(fit) : fit;
    const width = icon.naturalWidth * scale;
    const height = icon.naturalHeight * scale;
    ctx.imageSmoothingEnabled = !small;
    ctx.imageSmoothingQuality = "high";
    const left = x - width / 2, top = cy - height / 2;
    ctx.drawImage(icon, small ? Math.round(left) : left, small ? Math.round(top) : top, width, height);
  }
  ctx.restore();
}
