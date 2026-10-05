// The order characters are drawn in, and who a click lands on. Whoever stands
// further south (feet lower on the screen) is nearer the viewer and covers
// those behind - the rule the y-sorted tile layer follows - so nobody is on top
// of everybody else wherever they stand.

export type Depth = {
  /** World y of the line the character touches the ground at. */
  feet: number;
  /** The viewer's own character: on top of anyone standing on the very same line. */
  own?: boolean;
};

export type Standing = Depth & { draw: () => void };

/**
 * A player touches the ground where the shadow is drawn (player.ts show()),
 * this far below the anchor.
 */
export const PLAYER_FEET = 16;

// The visible character inside a player's 64px frame, in pixels from the
// anchor: measured on the default body and head sheets with their animation
// offsets, on foot (head top to feet). The engine picks left-click targets
// with the same box (src/systems/playerpick.ts).
const BODY = { halfWidth: 12, up: 18, down: 21 };

const order = (a: Depth, b: Depth) => Math.round(a.feet) - Math.round(b.feet) || Number(!!a.own) - Number(!!b.own);

/**
 * Sorts back to front, in place. Feet are compared in whole pixels and equal
 * feet keep the order they came in, so two characters walking side by side do
 * not swap places from frame to frame.
 */
export function backToFront<T extends Depth>(standing: T[]): T[] {
  return standing.sort(order);
}

/** The one backToFront would put last: on top where they overlap. */
export function frontmost<T extends Depth>(standing: T[]): T | undefined {
  let top: T | undefined;
  for (const s of standing) if (!top || order(top, s) <= 0) top = s;
  return top;
}

/**
 * Who a click at (x, y) lands on, out of the characters within reach of it:
 * the one drawn on top of those whose body is under the point, or the nearest
 * when it misses every body.
 */
export function clicked<T extends Depth & { x: number; y: number }>(inReach: T[], x: number, y: number): T | undefined {
  const onBody = inReach.filter((c) => Math.abs(x - c.x) <= BODY.halfWidth && y >= c.y - BODY.up && y <= c.y + BODY.down);
  if (onBody.length > 0) return frontmost(onBody);
  let nearest: T | undefined;
  let nearestSq = Infinity;
  for (const c of inReach) {
    const distSq = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (distSq < nearestSq) {
      nearest = c;
      nearestSq = distSq;
    }
  }
  return nearest;
}
