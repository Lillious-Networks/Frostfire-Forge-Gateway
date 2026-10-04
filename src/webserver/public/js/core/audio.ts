import { effectsSlider, mutedCheckbox } from "./ui.js";

/**
 * Sound effects. A sound is an audio file of the asset server (its assets/audio folder), asked for by name with or
 * without its extension ("footstep sand"), fetched and decoded once, then played from memory as often as needed.
 * How loud: the pause menu's Effects slider (0-100) and its Muted box, read at every play, so a change is heard at once.
 *
 * The files are decoded from their bytes (decodeAudioData), whatever their name says: the game's footstep ".wav" files
 * are AAC in an MP4 container (measured 2026-10-03: "ftypM4A"), which an <audio> element served as audio/wav may refuse.
 */

// A browser only lets a page make sound after the user has touched it, so the audio context is made on the first key
// press or click; until then nothing plays (and nothing is fetched).
let audio: AudioContext | null = null;
function unlock() {
  if (!audio) {
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    try { audio = new Ctor(); } catch { return; }
  }
  if (audio.state === "suspended") audio.resume().catch(() => {});
}
for (const type of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(type, unlock, { capture: true, passive: true });

/** The Effects slider as a gain, 0..1: nothing when muted; squared, so the lower half of the slider is not all "loud". */
export function effectsVolume(): number {
  if (mutedCheckbox?.checked) return 0;
  const v = Math.min(100, Math.max(0, Number(effectsSlider?.value) || 0)) / 100;
  return v * v;
}

/**
 * Every sound is brought to the same loudness when it is loaded: its loudest sample to PEAK of full scale (measured
 * 2026-10-03: the footstep files peak at 0.017 - 0.053 of full scale, "footstep sand" at 0.017: played as recorded it
 * could not be heard). A file that is next to silent is raised by BOOST_MAX at most.
 */
const PEAK = 0.7, BOOST_MAX = 80;
interface Sound { buffer: AudioBuffer; boost: number }
function measured(buffer: AudioBuffer): Sound {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
  return { buffer, boost: peak > 0 ? Math.min(BOOST_MAX, PEAK / peak) : 1 };
}

/** name (lower case) -> the decoded sound, null when the server has none (asked once only), or its load in progress */
const sounds = new Map<string, Sound | null | Promise<Sound | null>>();

/** Fetches and decodes a sound; null when it cannot be had or no sound may be made yet. */
export function loadEffect(name: string): Promise<Sound | null> {
  const key = name.trim().toLowerCase(), ctx = audio;
  if (!key || !ctx) return Promise.resolve(null);
  const hit = sounds.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const load = fetch(`${(window as any).__assetServerUrl || ""}/audio?name=${encodeURIComponent(key)}`)
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`audio "${name}": ${res.status}`))))
    .then((bytes) => ctx.decodeAudioData(bytes))
    .then(measured)
    .catch((err) => { console.warn(`[audio] ${err?.message ?? err}`); return null; })
    .then((sound) => { sounds.set(key, sound); return sound; });
  sounds.set(key, load);
  return load;
}

/**
 * Plays a sound effect once. `volume` (0..1) is the sound's own level under the Effects slider, `rate` its speed and
 * pitch (1 = as recorded). A sound not loaded yet starts loading and is skipped this time (a footstep that comes late
 * is worse than one missing). Returns whether it played.
 */
export function playEffect(name: string, opts: { volume?: number; rate?: number } = {}): boolean {
  const ctx = audio, gain = effectsVolume() * Math.min(1, Math.max(0, opts.volume ?? 1));
  if (!ctx || ctx.state !== "running" || gain <= 0) return false;
  const sound = sounds.get(name.trim().toLowerCase());
  if (sound === undefined) { void loadEffect(name); return false; }
  if (!sound || sound instanceof Promise) return false;
  const source = ctx.createBufferSource(), level = ctx.createGain();
  source.buffer = sound.buffer;
  source.playbackRate.value = opts.rate ?? 1;
  level.gain.value = gain * sound.boost;
  source.connect(level).connect(ctx.destination);
  source.start();
  return true;
}
