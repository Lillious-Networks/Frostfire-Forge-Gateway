// Smooth display of server-authoritative movement.
//
// The server steps every mover a fixed distance ~30 times a second, but the
// steps reach the client unevenly: datagrams bunch up and gap, badly so on
// phones and Wi-Fi. Chasing each step as it lands makes a sprite (and the
// camera that follows it) lurch. Instead every step is kept with the time the
// server sent it, and players are drawn slightly in the past, interpolating
// between the two steps around that moment. The server's own send clock sets
// the pace, so network jitter no longer shows up as speed changes.

export interface MoveSample {
  t: number;
  x: number;
  y: number;
}

/** Server movement tick. */
const TICK_MS = 1000 / 30;
/** A jump this far between steps is a teleport or warp: snap, never glide. */
const TELEPORT_PX = 100;
const MAX_SAMPLES = 8;
/** No step for this long means the mover had stopped. */
const IDLE_GAP_MS = 200;
/** Bounds on how far in the past players are drawn. */
const MIN_DELAY_MS = 45;
const MAX_DELAY_MS = 250;

// Client time = server send time + offset. The offset is the smallest one seen
// (the least-delayed packet); it creeps up slowly so a server clock step or
// drift is found again instead of being stuck on an old minimum.
let clockOffset: number | null = null;
const OFFSET_CREEP_MS = 0.02;
// How late packets arrive beyond the least-delayed one: a max that decays.
let lateness = 0;
const LATENESS_DECAY = 0.995;

/**
 * Timeline time for a step the server sent at `serverSendMs` (Date.now() on the
 * server), arriving now. Without a send time (a packet that carries none) the
 * arrival time is used.
 */
export function sampleTime(serverSendMs: number | null, now: number = performance.now()): number {
  if (serverSendMs === null || !Number.isFinite(serverSendMs)) return now;
  const observed = now - serverSendMs;
  clockOffset = clockOffset === null ? observed : Math.min(observed, clockOffset + OFFSET_CREEP_MS);
  lateness = Math.max(observed - clockOffset, lateness * LATENESS_DECAY);
  return serverSendMs + clockOffset;
}

/**
 * How far in the past to draw: one server tick (so the next step has always
 * arrived) plus the current arrival jitter.
 */
export function interpolationDelay(): number {
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, TICK_MS + lateness + 8));
}

// The delay in use eases toward interpolationDelay(): jumping straight to a
// longer delay would throw the render clock backwards and freeze or reverse
// everyone for a moment. Easing plays movement at most 10% slow or fast.
let currentDelay = MIN_DELAY_MS;
let lastClockAt: number | null = null;
const MAX_DELAY_SLEW = 0.1;

/** The moment to draw movers at, for a frame at `now`. Call once per frame. */
export function renderTime(now: number = performance.now()): number {
  const elapsed = lastClockAt === null ? 0 : Math.max(0, Math.min(100, now - lastClockAt));
  lastClockAt = now;
  const target = interpolationDelay();
  const step = elapsed * MAX_DELAY_SLEW;
  currentDelay += Math.max(-step, Math.min(step, target - currentDelay));
  return now - currentDelay;
}

/**
 * Record a server position for a mover. Returns false for a step older than one
 * already recorded (datagrams can arrive out of order): it is dropped, and the
 * caller should not apply it either.
 */
export function pushSample(samples: MoveSample[], x: number, y: number, t: number): boolean {
  const last = samples[samples.length - 1];
  if (last) {
    if (t < last.t) return false;
    if (Math.hypot(x - last.x, y - last.y) > TELEPORT_PX) {
      samples.length = 0;
    } else {
      if (t === last.t) t += 0.01;
      // Starting to move after standing still: the step began one tick ago
      // from where the mover stood, not back when it last moved. A shorter gap
      // is lost or late packets while moving, and is interpolated straight over.
      if (t - last.t > IDLE_GAP_MS && (x !== last.x || y !== last.y)) {
        samples.push({ t: t - TICK_MS, x: last.x, y: last.y });
      }
    }
  }
  samples.push({ t, x, y });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return true;
}

/**
 * Position to draw at `renderTime`. Holds at the newest step rather than
 * guessing past it, so a stop never overshoots and snaps back.
 */
export function positionAt(samples: MoveSample[], renderTime: number): { x: number; y: number } | null {
  const n = samples.length;
  if (n === 0) return null;
  if (renderTime <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[n - 1];
  if (renderTime >= last.t) return { x: last.x, y: last.y };
  for (let i = n - 1; i > 0; i--) {
    const a = samples[i - 1];
    if (a.t <= renderTime) {
      const b = samples[i];
      const f = (renderTime - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  return { x: last.x, y: last.y };
}

/** Test hook: forget the learned clock. */
export function resetMovementClock(): void {
  clockOffset = null;
  lateness = 0;
  currentDelay = MIN_DELAY_MS;
  lastClockAt = null;
}
