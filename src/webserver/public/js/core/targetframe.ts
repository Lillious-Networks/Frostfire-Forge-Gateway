// Unit frames: the ui-nameplate.png panel. One shows whatever the player has
// targeted (another player or a creature); on touch devices a second shows the
// player themselves, in place of the desktop health and stamina bars. Both are
// read-only views of state the rest of the client already tracks.
import Cache from "./cache.js";
import { creatures, parseCreatureTarget, levelColor } from "./creature.js";
import { getLayerStillFrame } from "./layeredAnimation.js";

const cache = Cache.getInstance();

/**
 * Part of a 64px head frame used as the portrait. Starting the crop lower than
 * the top of the head lifts the head up inside the circle.
 */
const PORTRAIT_CROP = { x: 16, y: 12, w: 32, h: 32 };

/** Layers that make up a humanoid portrait, drawn in this order. */
const PORTRAIT_LAYERS = ["head", "armor_helmet"];

interface UnitView {
  /** Identifies the unit, so the portrait is only redrawn when it changes. */
  id: string;
  name: string;
  level: string;
  levelColor: string;
  health: number;
  maxHealth: number;
  /** Barrier absorb on top of health; 0 when none. */
  absorb: number;
  /** Mana (stamina); null for creatures, which have none. */
  stamina: number | null;
  maxStamina: number;
  /** Layered animation to take the head from, if the unit has one. */
  anim: any | null;
  /** Single image for static-sprite creatures. */
  image: HTMLImageElement | null;
}

/** Same thresholds as the player health bars elsewhere in the HUD. */
function healthClass(pct: number): string {
  if (pct < 0.3) return "red";
  if (pct < 0.5) return "orange";
  if (pct < 0.8) return "yellow";
  return "green";
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** One frame on screen, bound to its root element by id. */
class UnitFrame {
  private root: HTMLElement | null = null;
  private portrait: HTMLCanvasElement | null = null;
  private portraitCtx: CanvasRenderingContext2D | null = null;
  private el: Record<string, HTMLElement | null> = {};
  /** Last rendered text state, so the DOM is only touched when something changes. */
  private lastKey = "";
  /** Unit whose portrait is on the canvas; retried until its image has loaded. */
  private portraitFor = "";

  constructor(private readonly rootId: string) {}

  private bind(): boolean {
    if (this.root) return true;
    this.root = document.getElementById(this.rootId);
    if (!this.root) return false;
    const pick = (cls: string) => this.root!.querySelector<HTMLElement>(`.${cls}`);
    this.portrait = this.root.querySelector<HTMLCanvasElement>(".uf-portrait");
    this.portraitCtx = this.portrait?.getContext("2d") ?? null;
    for (const cls of ["uf-name", "uf-level", "uf-health-fill", "uf-health-text", "uf-absorb", "uf-stamina-fill", "uf-stamina-text"]) {
      this.el[cls] = pick(cls);
    }
    return true;
  }

  /**
   * A still portrait: humanoids show their head and helmet, facing down, from
   * the idle pose - never animated. Static-sprite creatures show their image.
   * Returns false when nothing could be drawn yet (sheet still loading).
   */
  private drawPortrait(view: UnitView): boolean {
    if (!this.portrait || !this.portraitCtx) return true;
    const ctx = this.portraitCtx;
    const size = this.portrait.width;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;

    if (view.anim) {
      // The head must be ready; a helmet is optional and drawn over it.
      if (!getLayerStillFrame(view.anim.layers?.head, "idle_down")) return false;
      for (const name of PORTRAIT_LAYERS) {
        const layer = view.anim.layers?.[name];
        if (!layer) continue;
        const still = getLayerStillFrame(layer, "idle_down");
        // A helmet whose sheet is still loading: try again next frame.
        if (!still) return false;
        const sx = (PORTRAIT_CROP.x / 64) * still.width;
        const sy = (PORTRAIT_CROP.y / 64) * still.height;
        const sw = (PORTRAIT_CROP.w / 64) * still.width;
        const sh = (PORTRAIT_CROP.h / 64) * still.height;
        ctx.drawImage(still.image, sx, sy, sw, sh, 0, 0, size, size);
      }
      return true;
    }

    const img = view.image;
    if (img) {
      if (!img.complete || !img.naturalWidth) return false;
      const fit = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const w = img.naturalWidth * fit;
      const h = img.naturalHeight * fit;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    }
    // No sprite at all: an empty circle, nothing to wait for.
    return true;
  }

  /** Show a unit, or hide the frame with null. Cheap to call every frame. */
  render(view: UnitView | null): void {
    if (!this.bind() || !this.root) return;

    if (!view) {
      if (this.lastKey !== "") {
        this.root.classList.remove("visible");
        this.portraitCtx?.clearRect(0, 0, this.portrait!.width, this.portrait!.height);
        this.lastKey = "";
        this.portraitFor = "";
      }
      return;
    }

    // A unit whose equipment changes (a new helmet) gets a fresh portrait.
    const portraitId = `${view.id}|${view.anim?.layers?.armor_helmet?.spriteSheet?.name ?? ""}`;
    if (this.portraitFor !== portraitId && this.drawPortrait(view)) this.portraitFor = portraitId;

    const key = `${view.id}|${view.name}|${view.level}|${view.levelColor}|${view.health}|${view.maxHealth}|${view.absorb}|${view.stamina}|${view.maxStamina}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const { el } = this;
    if (el["uf-name"]) el["uf-name"].textContent = view.name;
    if (el["uf-level"]) {
      el["uf-level"].textContent = view.level;
      el["uf-level"].style.color = view.levelColor;
    }

    const pct = view.maxHealth > 0 ? clamp01(view.health / view.maxHealth) : 0;
    const fill = el["uf-health-fill"];
    if (fill) {
      fill.style.setProperty("--health-scale", String(pct));
      fill.className = `uf-health-fill ui ${healthClass(pct)}`;
    }
    el["uf-absorb"]?.style.setProperty("--absorb-scale", String(view.maxHealth > 0 ? clamp01(view.absorb / view.maxHealth) : 0));
    if (el["uf-health-text"]) el["uf-health-text"].textContent = view.maxHealth > 0 ? `${view.health} / ${view.maxHealth}` : "";

    // Players have mana; creatures do not, and the frame lays out differently.
    const hasMana = view.stamina !== null && view.maxStamina > 0;
    this.root.classList.toggle("has-mana", hasMana);
    if (hasMana) {
      el["uf-stamina-fill"]?.style.setProperty("--stamina-scale", String(clamp01(view.stamina! / view.maxStamina)));
      if (el["uf-stamina-text"]) el["uf-stamina-text"].textContent = `${view.stamina} / ${view.maxStamina}`;
    }
    this.root.classList.add("visible");
  }
}

// ------------------------------------------------------------ data sources

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function creatureView(playerLevel: number): UnitView | null {
  const id = parseCreatureTarget(cache.targetId);
  if (id === null) return null;
  const c = creatures.get(id);
  if (!c || c.state === "dead") return null;
  const skull = c.rank === "boss" || c.level - playerLevel >= 10;
  const elite = c.rank === "elite" || c.rank === "rare_elite" || c.rank === "boss";
  return {
    id: `c:${c.id}`,
    name: c.name,
    level: skull ? "??" : `${c.level}${elite ? "+" : ""}`,
    levelColor: skull ? "#ff2020" : levelColor(c.level, playerLevel),
    health: c.health,
    maxHealth: c.maxHealth,
    absorb: 0,
    stamina: null,
    maxStamina: 0,
    anim: c.anim,
    image: c.staticImage,
  };
}

function playerView(player: any): UnitView | null {
  if (!player?.stats) return null;
  const stats = player.stats;
  return {
    id: `p:${player.id}`,
    name: player.isGuest ? "Guest" : capitalize(String(player.username ?? "")),
    level: String(stats.level ?? ""),
    levelColor: "#ffffff",
    health: Number(stats.health) || 0,
    maxHealth: Number(stats.total_max_health || stats.max_health) || 0,
    absorb: Number(stats.absorbtion) || 0,
    stamina: Number(stats.stamina) || 0,
    maxStamina: Number(stats.total_max_stamina || stats.max_stamina) || 0,
    anim: player.layeredAnimation ?? null,
    image: null,
  };
}

const targetFrame = new UnitFrame("target-frame");
const selfFrame = new UnitFrame("self-frame");

/** Touch devices show the self frame; everywhere else it stays hidden. */
const touchQuery = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(hover: none) and (pointer: coarse)")
  : null;

/** Refresh both frames. Called every frame from the render loop. */
export function updateUnitFrames(self: any): void {
  const playerLevel = Number(self?.stats?.level) || 1;
  const targetedPlayer = Array.from(cache.players as Iterable<any>).find((p: any) => p?.targeted);
  targetFrame.render(creatureView(playerLevel) ?? playerView(targetedPlayer));
  // Skip the self frame's work entirely on desktop, where CSS hides it.
  selfFrame.render(touchQuery?.matches ? playerView(self) : null);
}
