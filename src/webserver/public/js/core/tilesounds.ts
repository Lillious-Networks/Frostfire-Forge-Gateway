import { playEffect, loadEffect } from "./audio.js";

/**
 * Sounds of the tiles the player walks on. A tile gives its footstep sound as a Tiled custom tile property on the
 * map's tileset, `footstep_sound` = the audio file's name ("footstep sand"), so a map painted by hand sounds right too
 * and a new sound needs no client change. While the player walks, the sound of the tile under the feet plays once per
 * step, through the Effects volume (audio.ts).
 */
const GID_MASK = 0x1fffffff;
/** the tile property that names a tile's footstep sound */
export const FOOTSTEP_PROPERTY = "footstep_sound";
/** how far the player walks between two steps (px), and the least time between them (ms: a fast mount does not rattle) */
const STEP_PX = 44, STEP_MIN_MS = 190;
/** standing still this long ends the walk: the next walk starts with a step right away */
const STOP_MS = 180;
/** a step's own level under the Effects slider, and how much each step varies in level */
const STEP_VOLUME = 0.6, VOLUME_SPREAD = 0.2;
/**
 * Every step at its own pitch, as feet land differently each time (USER REQUEST 2026-10-03: "footstep sounds I want at
 * random pitches to simulate walking"; at +-8 % they all sounded the same): up to PITCH_DOWN semitones lower or
 * PITCH_UP higher, and at least PITCH_APART semitones from the step before, so two in a row never sound alike.
 * (USER FEEDBACK 2026-10-04, "it sounds too high when it's at it's random peak": the top was 3 semitones up, a step
 * played 19 % fast; it is 1 now, 6 %. The low end is as it was.)
 */
const PITCH_DOWN = 3, PITCH_UP = 1, PITCH_APART = 1;
/** the feet: where the player's shadow is drawn, below the sprite's middle (player.ts) */
const FEET_Y = 16;

let tableFor: { tilesets: any[] | null; table: Map<number, string> } = { tilesets: null, table: new Map() };
/** gid -> footstep sound, from the tile properties of the map's tilesets (rebuilt when the map changes) */
function soundTable(): Map<number, string> {
  const tilesets = window.mapData?.tilesets ?? null;
  if (tableFor.tilesets === tilesets) return tableFor.table;
  const table = new Map<number, string>();
  for (const ts of tilesets ?? []) for (const t of ts?.tiles ?? []) {
    const p = (t.properties ?? []).find((q: any) => String(q.name).toLowerCase() === FOOTSTEP_PROPERTY);
    if (p && typeof p.value === "string" && p.value.trim()) table.set(Number(ts.firstgid) + Number(t.id), p.value.trim());
  }
  tableFor = { tilesets, table };
  for (const name of new Set(table.values())) void loadEffect(name); // ready before the first step, when sound is allowed
  return table;
}

/**
 * The footstep sound at a world position: of the tiles drawn there (every layer but collision and no-pvp), the topmost
 * that has one. A tile without one is passed over, so a flower on the sand still sounds like sand, and a roof or a
 * tree's crown over the player changes nothing. The layers above the player count too: the top of a tall grass tuft or
 * a bush is drawn over the player who stands in it (USER REQUEST 2026-10-03: "when walking over or in tall grass or
 * bushes").
 */
export function footstepSoundAt(x: number, y: number): string | null {
  const map = window.mapData, table = soundTable();
  if (!map?.loadedChunks || !table.size) return null;
  const tw = map.tilewidth || 16, th = map.tileheight || 16, size = Number(map.chunkSize) || 0;
  if (!size) return null;
  const tx = Math.floor(x / tw), ty = Math.floor(y / th), cx = Math.floor(tx / size), cy = Math.floor(ty / size);
  const chunk: any = map.loadedChunks.get(`${cx}-${cy}`);
  if (!chunk?.layers) return null;
  const lx = tx - cx * size, ly = ty - cy * size, w = Number(chunk.width) || size;
  if (lx < 0 || ly < 0 || lx >= w || ly >= (Number(chunk.height) || size)) return null;
  let best: string | null = null, bestZ = -Infinity;
  for (const layer of chunk.layers) {
    if (!layer?.data || /collision|nopvp/i.test(String(layer.name ?? ""))) continue;
    const sound = table.get(layer.data[ly * w + lx] & GID_MASK), z = Number(layer.zIndex) || 0;
    if (sound && z >= bestZ) { best = sound; bestZ = z; }
  }
  return best;
}

let last: { x: number; y: number; map: string } | null = null;
let walked = 0, lastMoveAt = 0, lastStepAt = 0, lastPitch = 0;

/** The next step's playback rate: a random pitch out of the range left when PITCH_APART round the last one is taken out. */
function stepRate(): number {
  const lo = -PITCH_DOWN, hi = PITCH_UP;
  const gapLo = Math.max(lo, lastPitch - PITCH_APART), gapHi = Math.min(hi, lastPitch + PITCH_APART);
  const below = gapLo - lo, r = Math.random() * (below + hi - gapHi);
  const pitch = r < below ? lo + r : gapHi + (r - below);
  lastPitch = pitch;
  return 2 ** (pitch / 12);
}

/** Call once a frame with the player this client controls: plays the footsteps of the walk (`now`: the frame's time, ms). */
export function updateTileSounds(player: any, now: number = performance.now()) {
  const pos = player?.position;
  // A player an admin is dragging is carried, not walking (canmove is false from DRAG_PLAYER_START to DRAG_PLAYER_STOP)
  if (!pos || player.isDead || player.isGhost || player.canmove === false) { last = null; return; }
  const map = String(window.mapData?.name ?? "");
  // The walk is measured along its longer axis: the server moves a walker its speed on each axis a tick, so a diagonal
  // covers 1.41 times the ground of a straight walk in the same time, at the same pace of the legs (USER FEEDBACK
  // 2026-10-03, "Diagonal movement doubles the audio": by straight-line distance the steps came every 6 ticks on a
  // diagonal against 8 on a straight walk, each on top of the one before).
  const moved = last && last.map === map ? Math.max(Math.abs(pos.x - last.x), Math.abs(pos.y - last.y)) : 0;
  last = { x: pos.x, y: pos.y, map };
  // a jump (a warp, a teleport, a server correction) is not a walk
  if (moved <= 0.01 || moved > STEP_PX) return;
  // after a stop the first step comes at once
  if (now - lastMoveAt > STOP_MS) walked = STEP_PX;
  lastMoveAt = now;
  walked += moved;
  if (walked < STEP_PX || now - lastStepAt < STEP_MIN_MS) return;
  walked = 0; lastStepAt = now;
  const sound = footstepSoundAt(pos.x, pos.y + FEET_Y);
  if (sound) playEffect(sound, { volume: STEP_VOLUME * (1 - VOLUME_SPREAD * Math.random()), rate: stepRate() });
}
