// Particle editor popup. Talks to the game window over postMessage; the game
// window (js/core/particleeditor.ts) passes what is asked on to the server.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the particle editor's own: its settings, the rules for its names,
// its conversation with the game window, and the live preview, which runs the
// particle the way the game does.
//
// The server never answers a request from here by name: the game window asks
// it for the list again a moment after each change, and passes that on. So
// what was asked for is checked against the lists that follow, and the result
// (done, or not done) is said once it is known. Nothing is sent to find out.
import { EditorShell, type ListRow } from "./tooleditor.js";
import { FieldRenderer, type AssetOption, type Field } from "./toolfields.js";
import { askText, button, card, confirmDialog, count, el, icon, iconButton, note, num, setIcon, tag, toast, tooltip, type AskOptions } from "./toolkit.js";
import { colourField, colourValue, rangeValue, sliderField, timeField, timeValue } from "./particleeditorparts.js";

const WIND_BURST_CYCLE = 3000;
const WIND_BURST_RAMP_UP = 400;
const WIND_BURST_HOLD = 200;
const WIND_BURST_RAMP_DOWN = 400;

class WindBurstTracker {
  private windBurstIntensity: number = 0;
  private windBurstTimer: number = 0;

  update(deltaTimeMs: number): void {
    this.windBurstTimer += deltaTimeMs;
    if (this.windBurstTimer >= WIND_BURST_CYCLE) { this.windBurstTimer -= WIND_BURST_CYCLE; }
    const rup = WIND_BURST_RAMP_UP, hld = rup + WIND_BURST_HOLD, rdn = hld + WIND_BURST_RAMP_DOWN;
    if (this.windBurstTimer < rup) this.windBurstIntensity = (this.windBurstTimer / WIND_BURST_RAMP_UP) * Math.sin(Math.PI / 2);
    else if (this.windBurstTimer < hld) this.windBurstIntensity = 1;
    else if (this.windBurstTimer < rdn) this.windBurstIntensity = Math.cos(((this.windBurstTimer - hld) / WIND_BURST_RAMP_DOWN) * Math.PI / 2);
    else this.windBurstIntensity = 0;
  }
  getIntensity(): number { return this.windBurstIntensity; }
  reset(): void { this.windBurstTimer = 0; this.windBurstIntensity = 0; }
}
const windBurst = new WindBurstTracker();

function calculateWindSpeed(baseWindSpeed: number, burstIntensity: number): number { return baseWindSpeed + baseWindSpeed * burstIntensity * 0.5; }
function applyWindVelocity(vx: number, vy: number, windSpeed: number, windDirection: string | null, maxVelX: number, maxVelY: number): { vx: number; vy: number } {
  let newVx: number;
  if (windDirection && windSpeed > 0 && (windDirection === "left" || windDirection === "right")) {
    const rad = (windDirection === "left" ? 180 : 0) * (Math.PI / 180);
    newVx = Math.min(Math.max(vx, -maxVelX + Math.cos(rad) * windSpeed * 0.5), maxVelX + Math.cos(rad) * windSpeed * 0.5);
  } else { newVx = Math.min(Math.max(vx, -maxVelX), maxVelX); }
  return { vx: newVx, vy: Math.min(Math.max(vy, -maxVelY), maxVelY) };
}
function getWindBias(windSpeed: number, windDirection: string | null): { x: number; y: number } {
  const bias = { x: 0, y: 0 };
  if (windDirection && (windDirection === "left" || windDirection === "right")) { bias.x = Math.cos((windDirection === "left" ? 180 : 0) * Math.PI / 180) * windSpeed * 0.5; }
  return bias;
}

/** The settings that are set with a slider, and what each slider can hold. */
const RANGES = {
  size: { min: 1, max: 512, step: 1 },
  opacity: { min: 0, max: 1, step: 0.01 },
  brightness: { min: 0, max: 5, step: 0.05 },
  glow_intensity: { min: 0, max: 10, step: 0.1 },
  glow_radius: { min: 0, max: 512, step: 1 },
} as const;

/** With no particles in the first list, how long to wait for a list that has some before saying there are none. */
const EMPTY_WAIT_MS = 1500;
/**
 * How long what was asked for may take to show in a list before it is called not done. The game window asks the server
 * for the list 300 to 400 ms after passing a change on, so a list that has it is here well within this.
 */
const GIVE_UP_MS = 2500;

/** A whole number as the game stores one: what is not a number is 0. */
const whole = (value: unknown): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
};
const real = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** 1.6667 -> "1.67", 0.1 -> "0.1", 12.34 -> "12.3": a few digits, and no zeros that say nothing. */
function few(value: number): string {
  if (Math.abs(value) >= 100) return num(value);
  return value.toFixed(Math.abs(value) < 10 ? 2 : 1).replace(/\.?0+$/, "");
}
const seconds = (ms: number): string => `${few(ms / 1000)} s`;

/** Something asked of the server that the list has not shown yet. */
interface Awaited {
  kind: "create" | "rename" | "duplicate" | "delete";
  /** The name the list should gain (or, for a delete, lose). */
  name: string;
  done: string;
  /** What is said when it did not happen, and why that is likely when the server's own list came back without it. */
  failed: string;
  why: string;
  /** A list has come back since, and it was not as asked. */
  listed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

class ParticleEditorBridge {
  private particles: any[] = [];
  private selectedParticleName: string | null = null;
  private previewParticles: any[] = [];
  private lastEmitInterval: number = 0;
  private animFrameId: number | null = null;
  private lastFrameTime: number = 0;

  /** A particle to select once the list (re)arrives: one just created, renamed or duplicated. */
  private pendingSelect: string | null = null;
  /** The form holds edits that have not been saved. */
  private dirty: boolean = false;
  /** The settings in the form, as normalize() shapes them. The fields edit this in place. */
  private form: any;
  /** Counts the particles opened, so the page knows a redraw from a different one; and which the page shows now. */
  private opened = 0;
  private shownName: string | null = null;
  /** The list has arrived, or it is clear by now that there is nothing in it. */
  private loaded = false;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;
  private awaited: Awaited[] = [];

  /** The asset server's sprites a particle can emit in place of its round dot, and where they are fetched from. */
  private sprites: string[] = [];
  private assetServerUrl: string = "";
  /** The sprites loaded for the preview: null while one loads, and when the asset server has none by that name. */
  private images = new Map<string, HTMLImageElement | null>();
  /** The sprites the asset server turned out not to have. */
  private missingImages = new Set<string>();

  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private paused = false;
  /** How much the preview is shrunk to fit a large particle (1 = full size), and what the page last said it was. */
  private previewScale = 1;
  private saidScale = "";

  /** The parts of the page that follow the settings as they are changed. */
  private stageEl: HTMLElement | null = null;
  private factsEl: HTMLElement | null = null;
  private scheduleEl: HTMLElement | null = null;
  private imageNoteEl: HTMLElement | null = null;
  private staticNotes: HTMLElement[] = [];
  private headSwatch = this.swatch(null, true);
  private renameBtn: HTMLButtonElement;
  private revertBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;

  private shell = new EditorShell({
    tool: "Particle Editor", noun: "particle", icon: "sparkle",
    // The whole list is here: searching only narrows what is shown, at every key.
    onSearch: () => this.renderList(),
    liveSearch: true,
    onNew: () => void this.newParticle(),
    onSave: () => this.saveParticle(),
    onDuplicate: () => void this.duplicate(this.findParticle(this.selectedParticleName ?? "")),
    onDelete: () => void this.deleteParticle(this.selectedParticleName ?? ""),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.previewCanvas = el("canvas", "pe-canvas");
    this.previewCanvas.width = 200;
    this.previewCanvas.height = 200;
    this.previewCanvas.setAttribute("role", "img");
    this.previewCanvas.setAttribute("aria-label", "Live preview of the particle");
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.form = this.settled(this.normalize({ name: "" }));

    this.renameBtn = button("Rename", () => void this.rename(this.selectedParticleName ?? ""), { icon: "pencil", kind: "quiet", fold: true, tip: "Give this particle another name" });
    this.revertBtn = button("Revert", () => this.resetForm(), { icon: "undo", kind: "quiet", fold: true });
    this.pauseBtn = iconButton("pause", "Pause the preview", () => this.togglePause());

    this.shell.waiting(() => this.send({ type: "requestParticles" }));
    this.startPreviewLoop();
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private send(msg: any): void { this.shell.send(msg); }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "init": this.handleInit(msg.particles || []); break;
      case "particleData": this.loadParticle(msg.particle); break;
      case "sprites": this.setSprites(msg.sprites || [], msg.assetServerUrl || ""); break;
      case "close": window.close(); break;
    }
  }

  // ------------------------------------------------------------------ images

  /** The sprites to choose from arrived: the Image field offers them, and the one chosen stays chosen. */
  private setSprites(sprites: string[], assetServerUrl: string): void {
    this.sprites = sprites;
    this.assetServerUrl = assetServerUrl;
    if (this.loaded && this.selectedParticleName) this.renderForm();
  }

  private spriteUrl(name: string): string | null {
    return this.assetServerUrl ? `${this.assetServerUrl}/sprite?name=${encodeURIComponent(name)}` : null;
  }

  /** What the Image field offers: "None" (the round particle), then the asset server's sprites. */
  private imageAssets(): AssetOption[] {
    const chosen = String(this.form.image || "");
    // a particle's image the asset server does not list (the file was removed) is still shown, so saving keeps it
    const names = chosen && !this.sprites.includes(chosen) ? [chosen, ...this.sprites] : this.sprites;
    return [{ value: "", label: "None (round particle)" }, ...names.map((n) => ({ value: n, label: n, image: this.spriteUrl(n) }))];
  }

  /** The loaded sprite of a name for the preview (as the game's particleimages.ts), or null. */
  private imageOf(name: string): HTMLImageElement | null {
    if (!name || !this.assetServerUrl) return null;
    const known = this.images.get(name);
    if (known !== undefined) return known;
    this.images.set(name, null);
    fetch(`${this.assetServerUrl}/sprite?name=${encodeURIComponent(name)}`).then(async (res) => {
      if (!res.ok || res.headers.get("X-Asset-Fallback")) return void this.imageMissing(name);
      const img = new Image(), src = URL.createObjectURL(await res.blob());
      await new Promise<void>((done, fail) => { img.onload = () => done(); img.onerror = () => fail(new Error("not an image")); img.src = src; });
      if (img.naturalWidth > 0 && img.naturalHeight > 0) this.images.set(name, img);
      else this.imageMissing(name);
    }).catch(() => this.imageMissing(name) /* no image: the preview shows the dot, as the game does */);
    return null;
  }

  private imageMissing(name: string): void {
    this.missingImages.add(name);
    this.paintImageNote();
  }

  // -------------------------------------------------------------------- list

  /** The particle list (re)arrived: after opening, and after every create, rename, duplicate or delete. */
  private handleInit(particles: any[]): void {
    const open = this.selectedParticleName;
    let drawn = false;
    this.particles = particles;
    if (this.particles.length === 0) this.send({ type: "requestParticles" });
    if (!this.loaded) {
      // An empty first list may only mean that the game window has not heard from the server yet.
      if (this.particles.length > 0) this.setLoaded();
      else this.emptyTimer ??= setTimeout(() => this.setLoaded(), EMPTY_WAIT_MS);
    }
    if (this.pendingSelect && this.findParticle(this.pendingSelect)) {
      this.selectedParticleName = this.pendingSelect;
      this.pendingSelect = null;
      this.loadParticle(this.findParticle(this.selectedParticleName));
      drawn = true;
    } else if (this.selectedParticleName && !this.findParticle(this.selectedParticleName) && !this.pendingSelect) {
      // The open particle is gone (deleted here or elsewhere): close it.
      this.selectedParticleName = null;
      this.dirty = false;
    }
    if (!this.selectedParticleName && !this.pendingSelect && this.particles.length > 0) {
      this.selectedParticleName = this.particles[0].name;
      this.loadParticle(this.particles[0]);
      drawn = true;
    }
    this.settle();
    this.renderList();
    if (!drawn && open !== this.selectedParticleName) this.renderForm();
    else this.chrome();
  }

  /** The first list is in (or there is none to come): the window can be used. */
  private setLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.shell.arrived();
    this.renderList();
    this.renderForm();
  }

  private findParticle(name: string): any { for (const p of this.particles) { if (p.name === name) return p; } return null; }

  /** "Static light", or "Emitter": what kind of particle it is, in a word or two. */
  private kindOf(p: any): string {
    const d = this.normalize(p);
    return (d.static_light ? "Static light" : "Emitter") + (d.image ? ` · ${d.image}` : "");
  }

  /** A particle as a mark: a dot in its colour, haloed if it glows; a picture mark if it emits a sprite. */
  private swatch(p: any, large = false): HTMLElement {
    const box = el("span", "tl-thumb pe-swatch" + (large ? " tl-thumb-lg" : ""));
    box.setAttribute("aria-hidden", "true");
    if (p) this.paintSwatch(box, p);
    return box;
  }

  private paintSwatch(box: HTMLElement, p: any): void {
    const d = this.normalize(p);
    const large = box.classList.contains("tl-thumb-lg");
    box.style.setProperty("--pe-colour", colourValue(d.color));
    box.classList.toggle("has-glow", Number(d.glow_intensity) > 0);
    box.classList.toggle("has-image", !!d.image);
    const dot = el("span", "pe-dot");
    if (d.image) box.replaceChildren(icon("image", large ? 18 : 14), dot);
    else box.replaceChildren(dot);
  }

  private renderList(): void {
    if (!this.loaded) return;
    const q = this.shell.query.toLowerCase();
    const rows: ListRow[] = [];
    for (const p of this.particles) {
      const name = String(p.name);
      if (q && name.toLowerCase().indexOf(q) === -1) continue;
      const selected = name === this.selectedParticleName;
      const d = this.normalize(p);
      const tags: HTMLElement[] = [];
      if (selected && this.dirty) tags.push(tag("Unsaved", "warning"));
      else if (!d.visible && !d.affected_by_time) tags.push(tag("Hidden", "muted"));
      rows.push({
        id: name, name, note: this.kindOf(p), selected, thumb: this.swatch(p), tags,
        actions: [
          { icon: "pencil", label: `Rename ${name}`, onClick: () => void this.rename(name) },
          { icon: "copy", label: `Duplicate ${name}`, onClick: () => void this.duplicate(p) },
          { icon: "trash", label: `Delete ${name}`, danger: true, onClick: () => void this.deleteParticle(name) },
        ],
        onOpen: () => void this.selectParticle(name),
      });
    }
    this.shell.setCount(this.particles.length);
    this.shell.setList({
      rows,
      empty: q
        ? { icon: "search", title: "No particles match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "No particles yet", text: "Start the first one with New particle." },
      foot: q && rows.length > 0 && rows.length < this.particles.length ? `${num(rows.length)} of ${count(this.particles.length, "particle")} match` : "",
    });
  }

  // ---------------------------------------------------------------- settings

  /** A stored particle in the shape getFormData() gives, with the defaults filled in. */
  private normalize(p: any): any {
    const toBool = (val: any) => val === true || val === 1 || val === "true" || val === "1";
    const xy = (val: any) => {
      if (typeof val === "string") { const parts = val.split(","); return { x: Number(parts[0]) || 0, y: Number(parts[1]) || 0 }; }
      return { x: Number(val?.x) || 0, y: Number(val?.y) || 0 };
    };
    return {
      name: p.name, size: p.size ?? 5, opacity: p.opacity ?? 0.8, brightness: p.brightness ?? 1, color: p.color || "#ffffff",
      zIndex: p.zIndex ?? p.zindex ?? 0, glow_intensity: p.glow_intensity ?? 0, glow_radius: p.glow_radius ?? 0,
      static_light: toBool(p.static_light), visible: p.visible != null ? toBool(p.visible) : true,
      velocity: xy(p.velocity), gravity: xy(p.gravity), spread: xy(p.spread), localposition: xy(p.localposition),
      affected_by_weather: toBool(p.affected_by_weather),
      lifetime: p.lifetime ?? 1000, interval: p.interval ?? 100, amount: p.amount ?? 10, staggertime: p.staggertime ?? 0,
      affected_by_time: toBool(p.affected_by_time), time_on: p.time_on || "", time_off: p.time_off || "",
      image: typeof p.image === "string" ? p.image.trim() : "",
    };
  }

  /**
   * The settings as the form's controls hold them: a slider keeps its number
   * within its ends and on its steps, the colour field keeps "#rrggbb", a time
   * field keeps a time or nothing.
   */
  private settled(d: any): any {
    for (const [key, range] of Object.entries(RANGES)) d[key] = rangeValue(d[key], range.min, range.max, range.step);
    d.color = colourValue(d.color);
    d.time_on = timeValue(d.time_on);
    d.time_off = timeValue(d.time_off);
    return d;
  }

  private loadParticle(p: any): void {
    if (!p) return;
    this.updatePreview();
    this.form = this.settled(this.normalize(p));
    this.dirty = false;
    // Another particle starts at the top of its page; the same one put back keeps its place.
    if (this.shownName !== this.selectedParticleName) {
      this.shownName = this.selectedParticleName;
      this.opened++;
    }
    this.renderForm();
  }

  /** The settings in the form, as they are sent to be saved and as the preview runs them. */
  private getFormData(): any {
    const f = this.form;
    const xy = (val: any) => ({ x: real(val?.x), y: real(val?.y) });
    return {
      name: this.selectedParticleName || "", size: whole(f.size), opacity: real(f.opacity), brightness: real(f.brightness), color: f.color,
      zIndex: whole(f.zIndex), glow_intensity: real(f.glow_intensity), glow_radius: real(f.glow_radius), static_light: !!f.static_light, visible: !!f.visible,
      velocity: xy(f.velocity), gravity: xy(f.gravity),
      spread: xy(f.spread), localposition: xy(f.localposition),
      affected_by_weather: !!f.affected_by_weather,
      lifetime: whole(f.lifetime), interval: whole(f.interval), amount: whole(f.amount), staggertime: real(f.staggertime),
      affected_by_time: !!f.affected_by_time,
      time_on: f.time_on, time_off: f.time_off, scale: 1, currentLife: 0, initialVelocity: { x: 0, y: 0 }, weather: {},
      image: f.image || null,
    };
  }

  /** A setting was changed: the preview starts over with it, and there is something to save. */
  private touched(): void {
    this.updatePreview();
    this.paintLive();
    if (!this.selectedParticleName) return;
    const was = this.dirty;
    this.dirty = true;
    this.chrome();
    // The open row says it has unsaved changes.
    if (!was) this.renderList();
  }

  // ------------------------------------------------------------------ render

  /** The top bar: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const { shell } = this;
    const name = this.selectedParticleName;
    if (!name) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false });
      return;
    }
    this.paintSwatch(this.headSwatch, this.form);
    shell.setRecord({ title: name, note: this.kindOf(this.form), thumb: this.headSwatch });
    shell.setState(this.dirty ? "unsaved" : "saved");
    this.revertBtn.disabled = !this.dirty;
    tooltip(this.revertBtn, this.dirty ? "Put back the settings as they were last saved" : "No unsaved changes");
    shell.setActions({ open: true, dirty: this.dirty, extra: [this.renameBtn, this.revertBtn] });
  }

  /**
   * The page: the settings as cards, and the preview beside them. Drawn when a
   * particle is opened, put back or closed; a setting that changes only
   * repaints the parts that follow it.
   */
  private renderForm(): void {
    this.chrome();
    this.stageEl = this.factsEl = this.scheduleEl = this.imageNoteEl = null;
    this.staticNotes = [];
    if (!this.loaded) return;
    if (!this.selectedParticleName) {
      const box = this.shell.idle("Pick a particle on the left to change it, or start a new one.", this.particles.length ? null : "Start the first one.");
      box.appendChild(button("New particle", () => void this.newParticle(), { icon: "plus", kind: "primary" }));
      return;
    }
    const { main, aside } = this.shell.page(`particle:${this.opened}`, { aside: true });
    // The preview stays beside the form at every width (css/particleeditor.css).
    main.parentElement?.classList.add("pe-work");
    const f = this.form;
    const touch = () => this.touched();
    const field = (def: Field, target: any = f) => this.fields.renderField(def, target, touch);
    const slider = (key: keyof typeof RANGES, label: string, unit = "", hint = "") => sliderField({ key, label, ...RANGES[key], unit, hint }, f, touch);
    const grid = (parent: HTMLElement, ...nodes: HTMLElement[]) => {
      const box = el("div", "tl-fields");
      box.append(...nodes);
      parent.appendChild(box);
      return box;
    };
    /** A vector, as its X and its Y side by side. */
    const pair = (key: string, label: string, unit: string, hint = "") => [
      field({ key: "x", path: `${key}.x`, label: `${label} X`, type: "number", step: 0.1, unit, hint }, f[key]),
      field({ key: "y", path: `${key}.y`, label: `${label} Y`, type: "number", step: 0.1, unit }, f[key]),
    ];
    const unused = (parent: HTMLElement) => {
      const box = note("Static light is on, so nothing is emitted: these settings are kept, and not used.", "plain");
      this.staticNotes.push(box);
      parent.appendChild(box);
    };

    const look = this.section(main, "Look", "What each particle looks like");
    look.append(slider("size", "Size", "px"), slider("opacity", "Opacity", "", "0 cannot be seen; 1 is solid."));
    grid(look,
      colourField({ key: "color", label: "Colour" }, f, touch),
      field({ key: "zIndex", label: "Z-index", type: "number", step: 1, hint: "Its place in the drawing order." }),
      field({ key: "visible", label: "Visible", type: "switch", hint: "Off, the game does not draw it. A time window, when one is set, decides instead." }),
    );

    const light = this.section(main, "Light and glow", "The light it gives off, and the soft halo around each particle");
    light.append(
      slider("brightness", "Brightness", "×", "Light the whole particle gives off, day and night. 1 is as drawn; above 1 is brighter."),
      slider("glow_intensity", "Glow intensity", "", "How strong the halo is. At 0 there is none."),
      slider("glow_radius", "Glow radius", "px", "How far the halo reaches. At 0 it is sized from the particle."),
    );
    grid(light, field({ key: "static_light", label: "Static light", type: "switch", wide: true, hint: "One steady light at the particle's position: no emission, lifetime, movement or spread." }));

    const image = this.section(main, "Image", "A sprite in place of the round particle");
    grid(image, field({
      key: "image", label: "Image", type: "asset", wide: true, assets: () => this.imageAssets(), fallback: "image",
      hint: "A sprite from the asset server (assets/sprites), as wide as Size. The colour then only tints the glow.",
    }));
    this.imageNoteEl = el("div");
    image.appendChild(this.imageNoteEl);

    const emission = this.section(main, "Emission", "How often particles appear, how many, and for how long");
    unused(emission);
    const rate = grid(emission,
      field({ key: "lifetime", label: "Lifetime", type: "number", min: 1, step: 1, unit: "ms", hint: "How long each particle lasts." }),
      field({ key: "interval", label: "Interval", type: "number", min: 1, step: 1, unit: "frames", hint: "Frames from one particle to the next. The game counts 60 a second." }),
      field({ key: "amount", label: "Max amount", type: "number", min: 1, step: 1, hint: "The most that are alive at once." }),
      field({ key: "staggertime", label: "Stagger time", type: "number", min: 0, step: 0.1, unit: "ms", hint: "Each lasts up to this much longer, at random, so they do not all fade together." }),
    );
    rate.classList.add("tl-fields-2");
    const start = el("div", "tl-group");
    start.append(el("div", "tl-group-title", "Where they start"), el("p", "pe-group-lead", "Measured from what emits them. X grows to the right, Y grows downward."));
    grid(start, ...pair("localposition", "Position", "px"), ...pair("spread", "Spread", "px", "Each starts at random within this width.")).classList.add("tl-fields-2");
    emission.appendChild(start);

    const motion = this.section(main, "Motion", "How particles move once they are out");
    unused(motion);
    grid(motion, ...pair("velocity", "Velocity", "px/s", "The speed each starts with."), ...pair("gravity", "Gravity", "px/s²", "A steady pull, added every second.")).classList.add("tl-fields-2");

    const time = this.section(main, "Time and weather", "When it shows, and whether the wind moves it");
    grid(time, field({ key: "affected_by_time", label: "Affected by time", type: "switch", wide: true, hint: "Only show it for part of the day, by the server's clock." }));
    grid(time, timeField({ key: "time_on", label: "Shows from" }, f, touch), timeField({ key: "time_off", label: "Until" }, f, touch)).classList.add("tl-fields-2");
    this.scheduleEl = el("div");
    time.appendChild(this.scheduleEl);
    grid(time, field({ key: "affected_by_weather", label: "Affected by weather", type: "switch", wide: true, hint: "The wind pushes it sideways in the game. The preview has no wind." }));

    this.renderPreviewCard(aside);
    this.paintLive();
    this.paintImageNote();
  }

  /** A titled card appended to `parent`; returns where its fields go. */
  private section(parent: HTMLElement, title: string, lead: string): HTMLElement {
    const { body } = card(parent, title, lead);
    body.classList.add("pe-body");
    return body;
  }

  /** The live preview, with its own controls, and what the settings add up to. */
  private renderPreviewCard(aside: HTMLElement): void {
    const { root, tools, body } = card(aside, "Preview", "Runs as the game runs it");
    root.classList.add("pe-preview");
    tools.append(this.pauseBtn, iconButton("restart", "Start the preview over", () => this.updatePreview()));
    this.stageEl = el("div", "pe-stage");
    const frame = el("div", "pe-stage-frame");
    frame.appendChild(this.previewCanvas);
    this.stageEl.append(frame, el("p", "pe-caption"));
    this.factsEl = el("div", "tl-facts tl-facts-inline");
    body.append(this.stageEl, this.factsEl);
    this.saidScale = "";
    this.paintPause();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.paintPause();
  }

  private paintPause(): void {
    const label = this.paused ? "Run the preview" : "Pause the preview";
    setIcon(this.pauseBtn, this.paused ? "play" : "pause");
    this.pauseBtn.setAttribute("aria-label", label);
    tooltip(this.pauseBtn, label);
    this.stageEl?.classList.toggle("is-paused", this.paused);
    this.paintCaption();
  }

  /** Under the preview: what the cross is, and how much the picture is shrunk when the particle is too large for it. */
  private paintCaption(): void {
    const caption = this.stageEl?.querySelector(".pe-caption");
    if (!caption) return;
    const scale = this.previewScale < 1 ? `Shown at ${Math.max(1, Math.round(this.previewScale * 100))}% to fit.` : "Shown at full size.";
    const said = `${this.paused ? "Paused. " : ""}The cross marks what it is attached to. ${scale}`;
    if (said === this.saidScale) return;
    this.saidScale = said;
    caption.textContent = said;
  }

  /** The parts of the page that say what the settings add up to. */
  private paintLive(): void {
    const d = this.getFormData();
    for (const box of this.staticNotes) box.hidden = !d.static_light;

    if (this.factsEl) {
      // As the game runs it: an interval is counted in frames at 60 a second, and nothing is ever 0.
      const every = ((d.interval || 1) / 60) * 1000;
      const life = d.lifetime || 1000;
      const longest = life + Math.max(0, d.staggertime || 0);
      const most = d.amount || 1;
      const steady = Math.max(1, Math.round((life + longest) / 2 / every));
      const facts: Array<[string, string, string?]> = d.static_light
        ? [["Kind", "Steady light"], ["Emits", "Nothing"], ["Alive at once", "1"], ["Lasts", "Always on"]]
        : [
            ["Kind", "Emitter"],
            ["Emits", `1 every ${seconds(every)}`],
            ["Alive at once", steady >= most ? num(most) : `About ${num(steady)}`, steady >= most ? "Max amount is the limit" : `${num(most)} at most`],
            ["Each lasts", longest > life ? `${few(life / 1000)} to ${seconds(longest)}` : seconds(life)],
          ];
      this.factsEl.replaceChildren(...facts.map(([label, value, more]) => {
        const fact = el("div", "tl-fact");
        fact.append(el("div", "tl-fact-label", label), el("div", "tl-fact-value", value));
        if (more) fact.appendChild(el("div", "tl-fact-note", more));
        return fact;
      }));
    }

    if (this.scheduleEl) {
      const on = String(d.time_on || ""), off = String(d.time_off || "");
      let said: string;
      if (!d.affected_by_time) said = "Not on a schedule: it shows whenever Visible is on.";
      else if (!on || !off) said = "Set both times. Until then it is not on a schedule, and shows whenever Visible is on.";
      else if (on === off) said = "Both times are the same, so it shows all day.";
      else said = on < off ? `Shows from ${on} until ${off} each day.` : `Shows from ${on} until ${off} the next morning.`;
      this.scheduleEl.replaceChildren(note(`${said} In darkness weather a scheduled particle always shows.`, "plain", "clock"));
    }
  }

  /** Under the Image field: said when the asset server turns out not to have the sprite chosen. */
  private paintImageNote(): void {
    if (!this.imageNoteEl) return;
    const name = String(this.form.image || "");
    this.imageNoteEl.replaceChildren();
    this.imageNoteEl.hidden = !(name && this.missingImages.has(name));
    if (!this.imageNoteEl.hidden) this.imageNoteEl.appendChild(note(`The asset server has no sprite named ${name}. Until it does, the game and this preview show the round particle in its place.`, "warning"));
  }

  // ----------------------------------------------------------------- opening

  /** True when the open particle can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.selectedParticleName || this.shell.discard(this.selectedParticleName);
  }

  private async selectParticle(name: string): Promise<void> {
    if (name === this.selectedParticleName) return;
    if (!(await this.mayLeave())) return;
    const p = this.findParticle(name);
    if (!p) return;
    this.selectedParticleName = name;
    this.loadParticle(p);
    this.renderList();
  }

  private resetForm(): void {
    const name = this.selectedParticleName;
    const p = this.findParticle(name ?? "");
    if (p) this.loadParticle(p);
    else this.updatePreview();
    this.renderList();
    if (name) toast(`Put ${name} back as it was last saved.`);
  }

  // ----------------------------------------------------------------- actions

  private saveParticle(): void {
    if (!this.selectedParticleName) return;
    const data = this.getFormData();
    this.send({ type: "saveParticle", particle: data });
    const idx = this.particles.findIndex((p) => p.name === data.name);
    if (idx >= 0) this.particles[idx] = data;
    this.dirty = false;
    this.chrome();
    this.renderList();
    toast(`Saved ${data.name}.`);
  }

  /** Asks for a particle's name. The box is marked pe-ask: it is this editor's one question that is not a yes or no. */
  private askName(question: AskOptions): Promise<string | null> {
    return askText({ ...question, className: "pe-ask" });
  }

  /** What is wrong with a name for a particle, or null. `except` is the particle being renamed, which may keep its own. */
  private nameProblem(name: string, except = ""): string | null {
    if (!name) return "Type a name first.";
    if (name.includes(",")) return "Names cannot contain commas.";
    if (this.particles.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.name !== except)) return "A particle with that name already exists.";
    return null;
  }

  private async newParticle(): Promise<void> {
    if (!(await this.mayLeave())) return;
    const name = await this.askName({
      title: "New particle", body: "It starts as a small white dot. Its name is what NPCs, spells and mounts refer to it by.",
      label: "Name", okLabel: "Create particle", icon: "sparkle", check: (n) => this.nameProblem(n),
    });
    if (name === null) return;
    this.dirty = false;
    this.pendingSelect = name;
    this.send({ type: "createParticle", name });
    this.expect("create", name, `Created ${name}.`, `${name} was not created.`, "The server did not add it. Your account may not be allowed to edit particles.");
    this.chrome();
    this.renderList();
  }

  /** Rename: the server renames the particle and the NPCs, spells and mounts that use it. */
  private async rename(from: string): Promise<void> {
    if (!from) return;
    // The renamed particle is reloaded from the server, which drops unsaved edits.
    if (from === this.selectedParticleName && this.dirty) {
      const agreed = await confirmDialog({
        title: "Rename and lose your changes?",
        body: `Renaming reloads ${from} from the server, so what you changed and have not saved is lost.`,
        okLabel: "Discard and rename", cancelLabel: "Keep editing",
      });
      if (!agreed) return;
    }
    const to = await this.askName({
      title: `Rename ${from}`, body: "The NPCs, spells and mounts that use it are moved to the new name with it.",
      label: "New name", value: from, okLabel: "Rename", check: (n) => this.nameProblem(n, from),
    });
    if (to === null || to === from) return;
    // It may have gone while the question was open.
    if (!this.findParticle(from)) return void toast(`${from} is no longer in the list, so it was not renamed.`, "error");
    if (from === this.selectedParticleName) { this.pendingSelect = to; this.dirty = false; }
    this.send({ type: "renameParticle", from, to });
    this.expect("rename", to, `Renamed ${from} to ${to}.`, `${from} was not renamed.`, "The server still lists it under that name. Your account may not be allowed to edit particles.");
    this.chrome();
    this.renderList();
  }

  /** Duplicate: a copy of a list row's particle under a new name; the open one is copied with the settings currently in the form. */
  private async duplicate(source: any): Promise<void> {
    if (!source?.name) return;
    const from = String(source.name);
    // The copy is opened once it is made, which leaves the particle that is open now.
    if (from !== this.selectedParticleName && !(await this.mayLeave())) return;
    const taken = (n: string) => this.particles.some((p) => p.name.toLowerCase() === n.toLowerCase());
    let suggestion = `${from} Copy`;
    for (let k = 2; taken(suggestion); k++) suggestion = `${from} Copy ${k}`;
    const open = from === this.selectedParticleName;
    const name = await this.askName({
      title: `Duplicate ${from}`, body: open ? "The copy starts with the settings in the form now, saved or not." : "The copy starts with its settings as they were last saved.",
      label: "Name of the copy", value: suggestion, okLabel: "Duplicate", icon: "copy", check: (n) => this.nameProblem(n),
    });
    if (name === null) return;
    const stillOpen = from === this.selectedParticleName;
    this.pendingSelect = name;
    this.dirty = false;
    this.send({ type: "duplicateParticle", particle: { ...(stillOpen ? this.getFormData() : this.normalize(source)), name } });
    this.expect("duplicate", name, `Copied ${from} as ${name}.`, `${name} was not created.`, "The server did not add the copy. Your account may not be allowed to edit particles.");
    this.chrome();
    this.renderList();
  }

  /** Delete a particle, from its list row or the top bar. Closes it if it is the open one. */
  private async deleteParticle(name: string): Promise<void> {
    if (!name) return;
    if (!(await this.shell.confirmDelete(name, "NPCs, spells and mounts that use it lose the effect. It cannot be brought back."))) return;
    const open = name === this.selectedParticleName;
    if (open) { this.selectedParticleName = null; this.dirty = false; }
    this.particles = this.particles.filter((p) => p.name !== name);
    this.renderList();
    this.send({ type: "deleteParticle", name });
    this.expect("delete", name, `Deleted ${name}.`, `${name} was not deleted.`, "The server still lists it. Your account may not be allowed to edit particles.");
    if (open) this.renderForm();
  }

  // ------------------------------------------------ what was asked, and came of it

  /** Watch the lists that follow for what was just asked of the server, to say whether it was done. */
  private expect(kind: Awaited["kind"], name: string, done: string, failed: string, why: string): void {
    const entry: Awaited = { kind, name, done, failed, why, listed: false, timer: setTimeout(() => this.giveUp(entry), GIVE_UP_MS) };
    this.awaited.push(entry);
  }

  private forget(entry: Awaited): void {
    clearTimeout(entry.timer);
    this.awaited = this.awaited.filter((a) => a !== entry);
  }

  private met(entry: Awaited): boolean {
    const listed = !!this.findParticle(entry.name);
    return entry.kind === "delete" ? !listed : listed;
  }

  /**
   * A list arrived: what it shows as done is said. One that does not show it is not the last word (it may have been
   * on its way already), so what is still missing is only noted, and given until its time is up.
   */
  private settle(): void {
    for (const entry of [...this.awaited]) {
      if (this.met(entry)) {
        this.forget(entry);
        toast(entry.done);
      } else entry.listed = true;
    }
  }

  /** Its time is up and no list has shown it: it was not done, as far as this window can tell. */
  private giveUp(entry: Awaited): void {
    if (!this.awaited.includes(entry)) return;
    this.forget(entry);
    // The last particle was deleted: the game window passes on no list with nothing in it, so none was ever going to come.
    if (entry.kind === "delete" && this.particles.length === 0) return toast(entry.done);
    // Nothing is going to arrive under that name: stop waiting to open it.
    if (entry.kind !== "delete" && this.pendingSelect === entry.name) this.pendingSelect = null;
    toast(`${entry.failed}\n${entry.listed ? entry.why : "The game window has not sent the list again since. Check that your game is still connected."}`, "error");
    this.renderList();
    this.chrome();
  }

  // ----------------------------------------------------------------- preview

  private updatePreview(): void { this.previewParticles = []; this.lastEmitInterval = 0; }

  private colorToRgba(color: string, alpha: number): string {
    let r = 255, g = 255, b = 255;
    if (color && color[0] === "#") {
      let hex = color.slice(1);
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const n = parseInt(hex, 16);
      if (!isNaN(n)) { r = (n >> 16) & 0xff; g = (n >> 8) & 0xff; b = n & 0xff; }
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  private addFeatheredStops(gradient: CanvasGradient, color: string): void {
    gradient.addColorStop(0, this.colorToRgba(color, 0.55));
    gradient.addColorStop(0.15, this.colorToRgba(color, 0.4));
    gradient.addColorStop(0.35, this.colorToRgba(color, 0.2));
    gradient.addColorStop(0.6, this.colorToRgba(color, 0.07));
    gradient.addColorStop(1, this.colorToRgba(color, 0));
  }

  private startPreviewLoop(): void {
    if (this.animFrameId) return;
    // Every frame, like the game: the particle clock below is capped at one 60 FPS frame.
    const loop = () => {
      if (!this.paused) this.renderPreview();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** The last sprite baked, and the settings it was baked from. */
  private sprite: { key: string; canvas: HTMLCanvasElement; half: number; blend: GlobalCompositeOperation } | null = null;

  /**
   * The particle's sprite, baked exactly as the game bakes it (npc.ts getParticleSprite): the glow halo out to its
   * reach stacked once per unit of Intensity, the feathered core, then the whole stacked once per unit of Brightness.
   * Keep the two in step: the preview is only right while this matches. With an image (once it has loaded) the image
   * takes the core's place, Size px wide at its own proportions, and the sprite is drawn as it is, not added as light.
   */
  private getSprite(color: string, radius: number, glowIntensity: number, glowRadius: number, brightness: number, image: string = ""): { canvas: HTMLCanvasElement; half: number; blend: GlobalCompositeOperation } {
    const img = this.imageOf(image);
    const key = `${color}|${radius}|${glowIntensity}|${glowRadius}|${brightness}|${img ? image : ""}`;
    if (this.sprite?.key === key) return this.sprite;
    const imgW = img ? Math.max(1, radius * 2) : 0, imgH = img ? Math.max(1, imgW * img.naturalHeight / img.naturalWidth) : 0;
    const body = img ? Math.max(imgW, imgH) / 2 : radius;
    const reach = glowIntensity > 0 ? (glowRadius > 0 ? glowRadius : Math.max(6, body * 2)) : 0;
    const outer = body + reach, sizeCss = Math.ceil(2 * outer) + 2, half = sizeCss / 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sizeCss); canvas.height = Math.max(1, sizeCss);
    const sctx = canvas.getContext("2d")!;
    sctx.globalCompositeOperation = "lighter";
    if (glowIntensity > 0) {
      const halo = sctx.createRadialGradient(half, half, 0, half, half, outer), edge = Math.min(0.95, body / outer);
      halo.addColorStop(0, this.colorToRgba(color, 0.5)); halo.addColorStop(edge, this.colorToRgba(color, 0.32));
      halo.addColorStop(edge + (1 - edge) * 0.35, this.colorToRgba(color, 0.12)); halo.addColorStop(edge + (1 - edge) * 0.7, this.colorToRgba(color, 0.03));
      halo.addColorStop(1, this.colorToRgba(color, 0)); sctx.fillStyle = halo;
      const whole = Math.floor(glowIntensity), frac = glowIntensity - whole;
      for (let g = 0; g < whole + (frac > 0 ? 1 : 0); g++) { sctx.globalAlpha = g < whole ? 0.5 : frac * 0.5; sctx.fillRect(0, 0, sizeCss, sizeCss); }
    }
    sctx.globalAlpha = 1;
    if (img) {
      sctx.globalCompositeOperation = "source-over"; sctx.imageSmoothingEnabled = false;
      sctx.drawImage(img, half - imgW / 2, half - imgH / 2, imgW, imgH);
    } else {
      const grad = sctx.createRadialGradient(half, half, 0, half, half, radius); this.addFeatheredStops(grad, color);
      sctx.fillStyle = grad; sctx.beginPath(); sctx.arc(half, half, radius, 0, Math.PI * 2); sctx.fill();
    }
    let out = canvas;
    if (brightness !== 1) {
      out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height;
      const bctx = out.getContext("2d")!;
      bctx.globalCompositeOperation = "lighter";
      const whole = Math.floor(brightness), frac = brightness - whole;
      for (let b = 0; b < whole + (frac > 0 ? 1 : 0); b++) { bctx.globalAlpha = b < whole ? 1 : frac; bctx.drawImage(canvas, 0, 0); }
    }
    this.sprite = { key, canvas: out, half, blend: img ? "source-over" : "lighter" };
    return this.sprite;
  }

  /**
   * The particle as the game runs it (npc.ts updateParticle, the same in sourceparticles.ts): same clock, emission,
   * spread, physics, fade and sprite. The crosshair is the point it is attached to; +X is right and +Y is down.
   */
  private renderPreview(): void {
    if (!this.previewCtx) return;
    const ctx = this.previewCtx, canvas = this.previewCanvas, pData = this.getFormData();
    ctx.fillStyle = "#222"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.selectedParticleName) return;
    const radius = (pData.size || 5) / 2, glowIntensity = pData.glow_intensity || 0;
    const brightness = Number.isFinite(pData.brightness) ? Math.max(0, pData.brightness) : 1;
    ctx.save();
    // big particles (size and glow radius go to 512) are shown zoomed out to fit the preview
    {
      const reach = glowIntensity > 0 ? (pData.glow_radius > 0 ? pData.glow_radius : Math.max(6, radius * 2)) : 0;
      const extent = radius + reach + Math.max(Math.abs(pData.localposition.x), Math.abs(pData.localposition.y)) + Math.max(Math.abs(pData.spread.x), Math.abs(pData.spread.y)) * 0.5;
      const k = Math.min(1, (Math.min(canvas.width, canvas.height) / 2 - 4) / Math.max(1, extent));
      if (k < 1) { ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(k, k); ctx.translate(-canvas.width / 2, -canvas.height / 2); }
      // (said under the preview)
      if (k !== this.previewScale) { this.previewScale = k; this.paintCaption(); }
    }

    // the game's clock: the frame delta capped at one 60 FPS frame, driving emission, aging and physics alike
    const now = performance.now(), dt = Math.min((now - this.lastFrameTime) / 1000, 0.01667); this.lastFrameTime = now;
    const originX = canvas.width / 2, originY = canvas.height / 2;
    const sprite = this.getSprite(pData.color || "white", radius, glowIntensity, pData.glow_radius || 0, brightness, pData.image || "");
    ctx.globalCompositeOperation = sprite.blend;

    // a static light: one steady light at the particle's position, nothing emitted
    if (pData.static_light) {
      this.previewParticles.length = 0; this.lastEmitInterval = 0;
      ctx.globalAlpha = pData.opacity ?? 1;
      ctx.drawImage(sprite.canvas, originX + pData.localposition.x - sprite.half, originY + pData.localposition.y - sprite.half, sprite.half * 2, sprite.half * 2);
    } else {
      const emitInt = (pData.interval || 1) / 60 * 1000; this.lastEmitInterval += dt * 1000;
      while (this.lastEmitInterval >= emitInt && this.previewParticles.length < (pData.amount || 1)) {
        const randExt = Math.random() * (pData.staggertime || 0), baseLife = pData.lifetime || 1000;
        const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any;
        const wBias = getWindBias(wd?.wind_speed || 0, wd?.wind_direction || null);
        this.previewParticles.push({
          x: pData.localposition.x + (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.x * 0.5,
          y: pData.localposition.y + (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.y * 0.5,
          vx: pData.velocity.x + wBias.x, vy: pData.velocity.y + wBias.y,
          lifetime: baseLife + randExt, currentLife: baseLife + randExt,
        });
        this.lastEmitInterval -= emitInt;
      }

      windBurst.update(dt * 1000);
      let wSpd = 0, wDir: string | null = null;
      if (pData.affected_by_weather) { const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any; wSpd = calculateWindSpeed(wd?.wind_speed || 0, windBurst.getIntensity()); wDir = wd?.wind_direction || null; }
      const maxVelX = Math.abs(pData.velocity.x) || 1, maxVelY = Math.abs(pData.velocity.y) || 1;
      for (let i = this.previewParticles.length - 1; i >= 0; i--) {
        const pp = this.previewParticles[i]; pp.currentLife -= dt * 1000;
        if (pp.currentLife <= 0) { this.previewParticles.splice(i, 1); continue; }
        pp.vy += pData.gravity.y * dt; pp.vx += pData.gravity.x * dt;
        const nv = applyWindVelocity(pp.vx, pp.vy, wSpd, wDir, maxVelX, maxVelY); pp.vx = nv.vx; pp.vy = nv.vy;
        pp.x += pp.vx * dt; pp.y += pp.vy * dt;
        const fIn = pp.lifetime * 0.4, fOut = pp.lifetime * 0.4; let alpha: number;
        if (pp.lifetime - pp.currentLife < fIn) alpha = ((pp.lifetime - pp.currentLife) / fIn) * pData.opacity;
        else if (pp.currentLife < fOut) alpha = (pp.currentLife / fOut) * pData.opacity; else alpha = pData.opacity;
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite.canvas, originX + pp.x - sprite.half, originY + pp.y - sprite.half, sprite.half * 2, sprite.half * 2);
      }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

new ParticleEditorBridge();
