// Spell editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the spell editor's own: its fields, the server's rules repeated so a
// slip is caught before the round trip, the effects of a spell as a list of
// cards, and its conversation with the server.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, nameList, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, empty, forbid, icon, iconButton, listed, noticeDialog, setBusy, shown, tag, thumb, toast } from "./toolkit.js";

/** Limits of a numeric field, as the server sends and enforces them. */
interface NumberRule {
  label: string;
  min?: number;
  max?: number;
  /** Decimal places kept; 0 for whole numbers. */
  decimals?: number;
}

interface EffectFieldRule extends NumberRule {
  key: string;
  hint: string;
  initial?: number | boolean;
  /** Only used, and only shown, while the effect's "stackable" is on. */
  whenStackable?: boolean;
}

interface EffectTypeRule {
  type: string;
  label: string;
  summary: string;
  fields: EffectFieldRule[];
}

/** The same rule the server applies to a new spell's name. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _'-]*$/;
const EFFECT_KEYS = ["value", "duration", "interval", "stackable", "max_stacks", "target_particles"];
/** Damage and healing over time share one timer per spell: a spell has one or the other. */
const PERIODIC_TYPES = ["damage_over_time", "heal_over_time"];
/** Which tab shows each field that is not on the General tab. */
const TARGETING_FIELDS = ["aoe_radius", "ground_aoe", "ground_duration", "is_thrown", "charge_distance", "teleport_behind"];
const TABS = [
  { id: "general", label: "General" },
  { id: "targeting", label: "Targeting" },
  { id: "effects", label: "Effects" },
];
const TAB_TITLES: Record<string, string> = { general: "General", targeting: "Targeting", effects: "Effects" };

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Blank counts as 0, as it does on the server. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

/** The server's own check, repeated here so a slip is caught before the round trip. */
function numberError(value: unknown, rule: NumberRule): string | null {
  const n = toNumber(value);
  const decimals = rule.decimals ?? 0;
  if (!Number.isFinite(n)) return `${rule.label} must be a number.`;
  if (decimals === 0 && !Number.isInteger(n)) return `${rule.label} must be a whole number.`;
  const scaled = n * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return `${rule.label} can have at most ${decimals} decimal places.`;
  const min = rule.min ?? 0;
  const max = rule.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max) return `${rule.label} must be between ${min} and ${max}.`;
  return null;
}

/** The names in a comma-separated particle list. */
const particleList = nameList;

/**
 * The server names what a number is counted in at the end of its label:
 * "Duration (seconds)", "Slow %". Here the unit is written inside the field,
 * so the label is the words before it.
 */
function unitOf(label: string): { label: string; unit?: string } {
  const worded = /^(.*\S)\s+\((seconds|pixels)\)$/.exec(label);
  if (worded) return { label: worded[1], unit: worded[2] };
  const percent = /^(.*\S)\s+%$/.exec(label);
  return percent ? { label: percent[1], unit: "%" } : { label };
}

const seconds = (n: number): string => `${n} ${n === 1 ? "second" : "seconds"}`;
const pixels = (n: number): string => `${n} ${n === 1 ? "pixel" : "pixels"}`;

class SpellEditorBridge {
  private data: any = {
    spellCount: 0, types: ["spell"], numbers: {}, effectTypes: [], maxEffects: 10,
    limits: { name: 64, description: 255, particles: 500 }, icons: [], particles: [],
  };
  /** The server's first answer has arrived. */
  private ready = false;
  private tab = "general";
  /** Name of the spell being edited, or null for a new one. */
  private originalName: string | null = null;
  private draft: any = null;
  /** Counts the records opened, so the page knows a redraw from a different record. */
  private opened = 0;
  /** Last search results. An empty search lists every spell. */
  private results: any[] = [];
  private truncated = 0;
  private searched = false;
  private dirty = false;
  /** The last save was refused and nothing has been changed since. */
  private refused = false;
  /** Problems by field ("damage", "effects.0.value"), from this window's own checks or the server's. */
  private fieldErrors: Record<string, string> = {};
  /** What the server refused that is not about one field. */
  private otherProblems: string[] = [];
  /** How many spells there are in all: the server's count when the editor opened, kept in step with what is saved and deleted here. */
  private total = 0;

  /** The request waiting for its result; a second one waits too. `adds` is a save of a spell that was not there before. */
  private pending: { kind: "save" | "delete" | "learn"; packet: string; name: string; adds: boolean } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** The parts of the page that follow the fields as they are typed in. */
  private summaryEl: HTMLElement | null = null;
  private codeEl: HTMLElement | null = null;
  private headThumb: { key: string; node: HTMLElement } | null = null;

  private shell = new EditorShell({
    tool: "Spell Editor", noun: "spell", icon: "wand", tabs: TABS,
    onSearch: () => this.runSearch(),
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicate(this.openRow()),
    onDelete: () => void this.deleteEntry(this.openRow()),
    onTab: (id) => this.switchTab(id),
  });

  private fields = new FieldRenderer({
    rerender: () => this.renderForm(),
    assetOptions: (_field, value) => this.iconOptions(value),
    missingImage: () => this.missingIcon(),
  });

  constructor() {
    this.shell.waiting(() => this.askForLists());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  /** What the game window asks for when it opens the editor: the rules and the lists the fields pick from. */
  private askForLists(): void {
    this.shell.send({ type: "request", packet: "SPELL_EDITOR_LIST", data: null });
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.data = { ...this.data, ...msg.data };
      this.ready = true;
      this.shell.arrived();
      this.total = Number(this.data.spellCount) || 0;
      this.shell.setCount(this.total);
      this.renderList();
      this.renderForm();
      if (!this.searched) this.runSearch();
    } else if (msg.type === "results") {
      this.results = Array.isArray(msg.data?.spells) ? msg.data.spells : [];
      this.truncated = Number(msg.data?.truncated) || 0;
      this.searched = true;
      // A save re-runs the search; follow the open spell as the server now holds it.
      if (this.originalName !== null && msg.data?.name === this.originalName && !this.dirty && !this.pending) {
        if (msg.data.open) {
          this.draft = this.toDraft(msg.data.open);
        } else {
          // Deleted from another editor.
          toast(`${this.originalName} was deleted in another editor, so it has been closed here.`);
          this.draft = null;
          this.originalName = null;
          this.refused = false;
          this.clearProblems();
        }
        this.renderForm();
      }
      this.renderList();
    } else if (msg.type === "result") {
      // Only the pending request's own result counts.
      if (!this.pending || (msg.action && msg.action !== this.pending.packet)) {
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        return;
      }
      const { kind, name, adds } = this.pending;
      this.endRequest();
      if (kind === "save") this.onSaveResult(msg, adds);
      else if (kind === "delete") this.onDeleteResult(msg, name);
      else this.onLearnResult(msg);
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed a spell. The list shows it as it is now.`);
      if (this.searched) this.runSearch();
    }
  }

  private onSaveResult(msg: any, added: boolean): void {
    if (!msg.ok) {
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
    if (msg.name) this.originalName = msg.name;
    if (added) this.shell.setCount(++this.total);
    toast(`Saved ${this.originalName ?? "the spell"}.`);
    this.renderForm();
    this.runSearch();
  }

  private onDeleteResult(msg: any, asked: string): void {
    if (!msg.ok) {
      // The reply says where the spell is still used: something to read, so it stays until it is closed.
      const lines: string[] = msg.errors?.length ? msg.errors : ["The server refused to delete it."];
      void noticeDialog(`${asked} was not deleted`, lines);
      return;
    }
    // The reply names the deleted spell: never adopt it as the open one, and
    // leave another open spell's unsaved edits alone.
    if (msg.name && msg.name === this.originalName) {
      this.draft = null;
      this.originalName = null;
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
      this.renderForm();
    }
    this.total = Math.max(0, this.total - 1);
    this.shell.setCount(this.total);
    toast(`Deleted ${msg.name ?? asked}.`);
    this.runSearch();
  }

  private onLearnResult(msg: any): void {
    if (!msg.ok) return toast(["The spell was not learned.", ...(msg.errors ?? [])].join("\n"), "error");
    toast(`You learned ${msg.name ?? "the spell"}. It is in your spell book.`);
  }

  /**
   * Something the server refused that no request here was waiting for. Before
   * its first answer, that is the editor itself being refused: the page says
   * so. After, it is said on the open spell, or in the corner.
   */
  private report(lines: string[]): void {
    if (!this.ready) this.shell.refused(lines, () => this.askForLists());
    else if (this.draft) {
      this.otherProblems = lines;
      this.shell.setProblems(this.problemLines());
    } else toast(lines.join("\n"), "error");
  }

  // ------------------------------------------------------------------ rules

  private get readOnly(): boolean {
    return !!this.draft?.plugin && this.originalName !== null;
  }

  private numberRule(key: string): NumberRule | undefined {
    return this.data.numbers?.[key];
  }

  private effectRule(type: unknown): EffectTypeRule | undefined {
    return (this.data.effectTypes ?? []).find((rule: EffectTypeRule) => rule.type === type);
  }

  /** Which tab a field path is edited on. */
  private tabOf(path: string): string {
    if (path.startsWith("effects")) return "effects";
    return TARGETING_FIELDS.includes(path) ? "targeting" : "general";
  }

  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of Object.keys(this.fieldErrors)) counts[this.tabOf(path)] = (counts[this.tabOf(path)] ?? 0) + 1;
    return counts;
  }

  /** An effect with only the fields its type uses: what the server stores. */
  private cleanEffect(effect: any): any {
    const rule = this.effectRule(effect?.type);
    const clean: any = { type: String(effect?.type ?? ""), value: 0 };
    if (!rule) return clean;
    for (const field of rule.fields) {
      if (field.key === "stackable") {
        if (effect.stackable === true) clean.stackable = true;
      } else if (field.key === "target_particles") {
        const names = particleList(effect.target_particles);
        if (names.length) clean.target_particles = names.join(",");
      } else if (!field.whenStackable || effect.stackable === true) {
        clean[field.key] = toNumber(effect[field.key]);
      }
    }
    return clean;
  }

  private cleanEffects(): any[] {
    return (this.draft?.effects ?? []).map((effect: any) => this.cleanEffect(effect));
  }

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const add = (field: string, message: string) => {
      errors[field] ??= message;
    };
    const d = this.draft;
    const limits = this.data.limits ?? {};

    if (this.originalName === null) {
      const name = String(d.name ?? "").trim();
      if (!name) add("name", "Name is required.");
      else if (name.length > (limits.name ?? 64)) add("name", `Name must be ${limits.name ?? 64} characters or fewer.`);
      else if (!NAME_PATTERN.test(name)) add("name", "Name can hold letters, digits, spaces, underscores, hyphens and apostrophes.");
    }
    for (const [key, rule] of Object.entries(this.data.numbers ?? {}) as [string, NumberRule][]) {
      const message = numberError(d[key], rule);
      if (message) add(key, message);
    }
    const description = String(d.description ?? "").trim();
    if (description.length > (limits.description ?? 255)) add("description", `Description must be ${limits.description ?? 255} characters or fewer.`);
    if (description.includes("\\")) add("description", "Description cannot hold backslashes.");

    const known: string[] = this.data.particles ?? [];
    const missing = (value: unknown) => particleList(value).find((name) => !known.some((k) => lower(k) === lower(name)));
    const lost = missing(d.particles);
    if (lost) add("particles", `Particle "${lost}" does not exist.`);

    const effects: any[] = Array.isArray(d.effects) ? d.effects : [];
    if (effects.length > (this.data.maxEffects ?? 10)) add("effects", `A spell can have at most ${this.data.maxEffects ?? 10} effects.`);
    const seen = new Set<string>();
    effects.forEach((effect, index) => {
      const at = `effects.${index}`;
      const rule = this.effectRule(effect?.type);
      if (!rule) return add(`${at}.type`, "Effect type is not valid.");
      if (seen.has(rule.type)) add(`${at}.type`, `Only one ${rule.label} effect per spell: a second one replaces the first.`);
      else if (PERIODIC_TYPES.includes(rule.type) && PERIODIC_TYPES.some((t) => seen.has(t))) {
        add(`${at}.type`, "A spell cannot both damage and heal over time: they share one timer and the second replaces the first.");
      }
      seen.add(rule.type);
      for (const field of rule.fields) {
        if (field.key === "stackable") continue;
        if (field.key === "target_particles") {
          const gone = missing(effect.target_particles);
          if (gone) add(`${at}.target_particles`, `Particle "${gone}" does not exist.`);
        } else if (!field.whenStackable || effect.stackable === true) {
          const message = numberError(effect[field.key], field);
          if (message) add(`${at}.${field.key}`, message);
        }
      }
    });

    const settled = !Object.keys(errors).some((f) => f === "damage" || f === "aoe_radius" || f.startsWith("effects"));
    if (settled && toNumber(d.damage) === 0 && effects.length === 0) {
      add("damage", "A spell with no damage, no healing and no effects cannot be cast: give it one of them.");
    }
    if (settled && d.ground_aoe && toNumber(d.aoe_radius) <= 0) {
      add("aoe_radius", "A ground-targeted spell needs an area radius: with none it hits nothing.");
    }
    return errors;
  }

  /**
   * The summary at the top of the page: where the marked fields are, or, when
   * no field is marked, what the server said that is not about one field. It
   * is worked out again as fields are put right.
   */
  private problemLines(): string[] {
    const fields = Object.keys(this.fieldErrors);
    if (fields.length === 0) return this.otherProblems;
    const tabs = [...new Set(fields.map((f) => this.tabOf(f)))];
    const lines = [`${count(fields.length, "field needs", "fields need")} fixing, on ${listed(tabs.map((t) => TAB_TITLES[t]))}.`];
    if (this.fieldErrors.effects) lines.push(this.fieldErrors.effects);
    return lines;
  }

  /** Nothing is wrong any more: a save went through, or another spell is opened. */
  private clearProblems(): void {
    this.fieldErrors = {};
    this.otherProblems = [];
    this.shell.setProblems([]);
  }

  /** A save was refused, here or by the server: say so at the top, and show a tab that has a problem. */
  private showProblems(serverErrors: string[] = []): void {
    this.otherProblems = serverErrors;
    const tabs = [...new Set(Object.keys(this.fieldErrors).map((f) => this.tabOf(f)))];
    // Show a tab that has a problem, unless the one in view already does.
    if (tabs.length && !tabs.includes(this.tab)) this.tab = tabs[0];
    this.shell.setProblems(this.problemLines());
    this.renderForm();
  }

  // ---------------------------------------------------------------- options

  /**
   * Icon URL for a stored icon name: the sprite of that name, which is what
   * the hotbar and the spell book draw (the server sends them
   * /sprite?name=<icon>). The listed sprites win, but a spell whose icon is not
   * in the list (different case, an extension, or the list failed to load)
   * still gets a URL built the same way.
   */
  private iconFor(name: unknown): string | null {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const bare = wanted.replace(/\.(png|jpg|jpeg|gif)$/i, "");
    const listed = (this.data.icons ?? []).find((i: any) => lower(i.name) === lower(bare));
    if (listed?.image) return listed.image;
    const base = this.data.assetServerUrl;
    return base ? `${base}/sprite?name=${encodeURIComponent(bare)}` : null;
  }

  /** As the hotbar does: a sprite that fails to load shows the missing icon. */
  private missingIcon(): string | null {
    return this.data.assetServerUrl ? `${this.data.assetServerUrl}/icon?name=missing_icon` : null;
  }

  /** A spell's picture: its sprite, the missing icon if that will not load, and a wand where there is none. */
  private thumbOf(spell: any, size: "" | "lg" | "xl" = ""): HTMLElement {
    return thumb(this.iconFor(spell?.icon), { size, fallback: "wand", missing: this.missingIcon() });
  }

  /** The icon picker lists the asset server's sprites (what the hotbar draws), not the icons folder. */
  private iconOptions(current: unknown): AssetOption[] {
    const options: AssetOption[] = [
      { value: "", label: "None" },
      ...(this.data.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image })),
    ];
    const name = String(current ?? "");
    if (name && !options.some((o) => o.value === name)) {
      options.push({ value: name, label: `${name} (not on the asset server)`, image: this.iconFor(name) });
    }
    return options;
  }

  private typeOptions(): Array<{ value: string; label: string }> {
    const types: string[] = this.data.types?.length ? this.data.types : ["spell"];
    const options = types.map((t) => ({ value: t, label: t }));
    const current = String(this.draft?.type ?? "");
    // A stored value that is no longer offered stays visible instead of showing blank.
    if (current && !types.includes(current)) options.push({ value: current, label: `${current} (saved as "${types[0]}")` });
    return options;
  }

  /**
   * The effect types still free for the effect at `index` (or for a new one):
   * those no other effect of the spell has, counting damage and healing over
   * time as one.
   */
  private freeEffectTypes(index = -1): EffectTypeRule[] {
    const others: string[] = (this.draft?.effects ?? []).filter((_: any, i: number) => i !== index).map((e: any) => e.type);
    const periodic = others.some((t) => PERIODIC_TYPES.includes(t));
    return (this.data.effectTypes ?? []).filter(
      (rule: EffectTypeRule) => !others.includes(rule.type) && !(periodic && PERIODIC_TYPES.includes(rule.type))
    );
  }

  /** The types an effect can be changed to, with its own first if the game no longer knows it. */
  private effectTypeOptions(index: number): Array<{ value: string; label: string }> {
    const type = String(this.draft?.effects?.[index]?.type ?? "");
    const options = this.freeEffectTypes(index).map((rule) => ({ value: rule.type, label: rule.label }));
    if (type && !options.some((o) => o.value === type)) {
      const known = this.effectRule(type);
      options.unshift({ value: type, label: known ? known.label : `${type} (unknown)` });
    }
    return options;
  }

  private blank(): any {
    return {
      name: "new_spell", damage: 10, mana: 5, range: 600, type: "spell", cast_time: 2, cooldown: 5, can_move: 0,
      description: "", icon: "", effects: [], particles: null, aoe_radius: 0, ground_aoe: 0, ground_duration: 0,
      is_thrown: 0, charge_distance: 0, teleport_behind: 0,
    };
  }

  /** A fresh effect of `type`, filled with that type's starting values. */
  private blankEffect(type: string, keep: any = {}): any {
    const effect: any = { type };
    for (const field of this.effectRule(type)?.fields ?? []) {
      if (field.key === "target_particles") {
        if (keep.target_particles) effect.target_particles = keep.target_particles;
      } else if (field.initial !== undefined) effect[field.key] = field.initial;
    }
    return effect;
  }

  /** An editable copy of a spell from the server. */
  private toDraft(spell: any): any {
    const draft = clone(spell);
    if (!Array.isArray(draft.effects)) draft.effects = [];
    return draft;
  }

  // ------------------------------------------------------------------ search

  private runSearch(): void {
    // The open spell comes back with every search, whether or not it matches.
    this.shell.send({ type: "request", packet: "SPELL_EDITOR_SEARCH", data: { query: this.shell.takeQuery(), name: this.originalName } });
  }

  /** The row of the open spell as the list holds it, or the open spell itself where the search does not list it. */
  private openRow(): any {
    return this.results.find((s: any) => s.name === this.originalName) ?? this.draft;
  }

  /** A spell in a few words, under its name in the list: what it does on hit, and how many effects it has. */
  private kindOf(spell: any): string {
    const damage = toNumber(spell?.damage) || 0;
    const effects = Array.isArray(spell?.effects) ? spell.effects.length : 0;
    const hit = damage > 0 ? `${damage} damage` : damage < 0 ? `Heals ${-damage}` : "No damage";
    return effects > 0 ? `${hit} · ${count(effects, "effect")}` : hit;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    if (!this.searched) return this.shell.setList({ rows: [], loading: true });
    const rows: ListRow[] = [];
    // A spell that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.originalName === null) {
      rows.push({
        id: "\u0000new", name: String(this.draft.name || "New spell"), note: "Not saved yet", selected: true,
        thumb: this.thumbOf(this.draft), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const spell of this.results) {
      rows.push({
        id: String(spell.name), name: String(spell.name), note: this.kindOf(spell), selected: spell.name === this.originalName,
        thumb: this.thumbOf(spell),
        tags: spell.plugin ? [tag("Plugin", "muted", "plug")] : [],
        actions: [
          { icon: "copy", label: `Duplicate ${spell.name}`, onClick: () => void this.duplicate(spell) },
          // Plugin spells live in memory only: there is nothing to delete.
          ...(spell.plugin ? [] : [{ icon: "trash" as const, label: `Delete ${spell.name}`, danger: true, onClick: () => void this.deleteEntry(spell) }]),
        ],
        onOpen: () => void this.select(spell.name),
      });
    }
    this.shell.setList({
      rows,
      empty: this.shell.query
        ? { icon: "search", title: "No spells match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "There are no spells yet", text: "Start the first one with New spell." },
      foot: this.truncated > 0 ? `${count(this.truncated, "more spell matches", "more spells match")}. Narrow the search to see them.` : "",
    });
  }

  /** The top bar, the banner and the tabs: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setTabs(null);
      shell.setBanner(null);
      return;
    }
    const saved = this.originalName !== null;
    // The picture is only drawn again when it changes, not at every key typed.
    if (this.headThumb?.key !== String(d.icon)) this.headThumb = { key: String(d.icon), node: this.thumbOf(d, "lg") };
    shell.setRecord({ title: this.titleOf(d), note: this.readOnly ? "Plugin spell" : "Spell", thumb: this.headThumb.node });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.readOnly ? "readonly" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);

    // Teaches the open spell to the admin's own character, to try it out.
    const learn = button("Learn", () => this.learn(), {
      icon: "book", kind: "quiet", fold: true,
      tip: !saved || this.dirty ? "Save the spell first, then you can learn it" : "Teach this spell to your own character, to try it out",
    });
    learn.disabled = !saved || this.dirty || (!!this.pending && this.pending.kind !== "learn");
    setBusy(learn, this.pending?.kind === "learn");
    const deleting = this.pending?.kind === "delete" && this.pending.name === this.originalName;
    shell.setActions({
      open: true, dirty: this.dirty && !this.readOnly, extra: [learn],
      busy: this.pending ? (this.pending.kind === "save" ? "save" : deleting ? "delete" : "other") : null,
      canSave: !this.readOnly, canDuplicate: saved, canDelete: saved && !this.readOnly,
      why: {
        save: "A plugin spell cannot be saved here",
        duplicate: "Save it first, then it can be copied",
        delete: this.readOnly ? "A plugin spell cannot be deleted here" : "It has not been saved, so there is nothing to delete",
      },
    });
    shell.setTabs(this.tab, this.problemsByTab());
    shell.setBanner(this.readOnly
      ? {
          tone: "info", icon: "plug",
          text: "This spell comes from a plugin, so it cannot be changed or deleted here. Duplicate it to make a copy of your own that can be edited and saved.",
          action: { label: "Duplicate it", onClick: () => void this.duplicate(this.openRow()) },
        }
      : null);
  }

  /** What the open spell is called while its name field may be empty. */
  private titleOf(spell: any): string {
    return String(spell?.name ?? "").trim() || (this.originalName === null ? "New spell" : "Unnamed spell");
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    this.renderForm();
  }

  private renderForm(): void {
    this.chrome();
    this.summaryEl = this.codeEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Pick a spell from the list on the left, or start a new one.", this.total === 0 ? "Start the first one." : null);
      box.appendChild(button("New spell", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}:${this.tab}`, { aside: true, readOnly: this.readOnly });

    if (this.tab === "effects") this.renderEffects(main);
    else if (this.tab === "targeting") this.renderTargeting(main);
    else this.renderGeneral(main);

    if (this.readOnly) {
      // Whatever is left that could change it: the buttons of the effects.
      for (const control of main.querySelectorAll<HTMLInputElement>("input, select, textarea, button")) control.disabled = true;
    }

    // What the numbers add up to in game, beside the form on every tab.
    const { body } = card(aside, "In plain words", "What these numbers do in the game");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.append(el("span", "tl-preview-name", this.titleOf(this.draft)), el("span", "tl-preview-kind", this.readOnly ? "Plugin spell" : "Spell"));
    head.append(this.thumbOf(this.draft, "xl"), said);
    this.summaryEl = el("div", "tl-summary");
    body.append(head, this.summaryEl);
    this.paintLive();
  }

  private renderGeneral(main: HTMLElement): void {
    const spell = this.section(main, "Spell");
    const existing = this.originalName !== null;
    const name = this.field(
      {
        key: "name", label: "Name", type: "text",
        hint: existing
          ? "Fixed once saved: players, hotbars and creatures refer to the spell by it. Duplicate the spell to make a renamed copy."
          : "Must be unique. Players, hotbars and creatures refer to the spell by it, so it cannot be changed after the first save.",
      },
      this.draft, "name"
    );
    if (existing) (name.querySelector("input") as HTMLInputElement).disabled = true;
    spell.appendChild(name);
    spell.appendChild(this.field(
      { key: "icon", label: "Icon", type: "asset", fallback: "wand", hint: "The sprite shown in the spell book and on the hotbar. The projectile that flies is the asset server's icon of the same name." },
      this.draft, "icon"
    ));
    spell.appendChild(this.field(
      { key: "type", label: "Type", type: "select", options: () => this.typeOptions(), hint: 'A category label. "spell" is the only one the game knows.' },
      this.draft, "type"
    ));
    spell.appendChild(this.field(
      {
        key: "description", label: "Description", type: "textarea", maxLength: this.data.limits?.description ?? 255,
        hint: `Tooltip text in the spell book. Up to ${this.data.limits?.description ?? 255} characters.`,
      },
      this.draft, "description"
    ));

    const casting = this.section(main, "Casting", "What it costs and what it does on hit");
    casting.appendChild(this.number("damage", "Damage", "Base damage on hit, raised by the caster's level and damage stat. A negative number heals instead. 0 is fine for a spell that only has effects."));
    casting.appendChild(this.number("mana", "Mana cost", "Percent of the caster's base stamina: the stamina their level gives, not counting gear.", "%"));
    casting.appendChild(this.number("range", "Range", "Longest distance to the target. 0 falls back to 100.", "pixels"));
    casting.appendChild(this.number("cast_time", "Cast time", "How long the cast bar takes. 0 is instant. Fractions work: 1.5.", "seconds"));
    casting.appendChild(this.number("cooldown", "Cooldown", "Whole seconds before it can be cast again.", "seconds"));
    casting.appendChild(this.field(
      { key: "can_move", label: "Cast while moving", type: "switch", hint: "Off: the caster must stand still, moving cancels the cast, and the cast can be interrupted." },
      this.draft, "can_move"
    ));

    const looks = this.section(main, "Looks");
    looks.appendChild(this.particles("Particles", "Drawn on the projectile or the cast. Made in the particle editor.", this.draft, "particles", "particles"));
  }

  private renderTargeting(main: HTMLElement): void {
    const area = this.section(main, "Area", "Leave the radius at 0 for a spell that hits one target");
    area.appendChild(this.number("aoe_radius", "Area radius", "With ground targeting off, the spell is cast around the caster and hits everyone within this distance of them. With it on, this is the size of the circle.", "pixels"));
    area.appendChild(this.field(
      { key: "ground_aoe", label: "Ground targeted", type: "switch", rerender: true, hint: "The caster clicks a spot on the ground instead of picking a target." },
      this.draft, "ground_aoe"
    ));
    if (this.draft.ground_aoe) {
      area.appendChild(this.number("ground_duration", "Ground duration", "How long a zone stays on the ground, hitting everyone inside once a second. 0 leaves no zone.", "seconds"));
      area.appendChild(this.field(
        { key: "is_thrown", label: "Thrown", type: "switch", hint: "The projectile arcs through the air to the spot." },
        this.draft, "is_thrown"
      ));
    }

    const movement = this.section(main, "Movement", "How the caster closes in before the spell lands");
    movement.appendChild(this.number("charge_distance", "Charge distance", "The caster dashes up to this far toward the target, stopping just short of them. 0 for no dash.", "pixels"));
    movement.appendChild(this.field(
      { key: "teleport_behind", label: "Teleport behind", type: "switch", hint: "The caster blinks to behind the target." },
      this.draft, "teleport_behind"
    ));
  }

  /** The spell's effects, one card each, in the order they are applied. */
  private renderEffects(main: HTMLElement): void {
    const effects: any[] = this.draft.effects;
    if (effects.length === 0) {
      const none = el("section", "tl-card");
      empty(none, "sparkle", "No effects", this.readOnly ? "The spell only does its damage or healing." : "The spell only does its damage or healing. Add an effect below to make it do more.");
      main.appendChild(none);
    }

    effects.forEach((effect, index) => {
      const at = `effects.${index}`;
      const rule = this.effectRule(effect.type);
      const part = card(main, `Effect ${index + 1} · ${rule ? rule.label : "Unknown type"}`, rule ? rule.summary : "The game does not know this effect type. Pick another, or remove it.");
      part.tools.append(...this.effectActions(index));
      const grid = el("div", "tl-fields");
      part.body.appendChild(grid);
      grid.appendChild(this.field(
        { key: "type", label: "Type", type: "select", options: () => this.effectTypeOptions(index), rerender: true },
        effect, `${at}.type`,
        // A different type reads different fields: start from that type's own values.
        () => {
          const fresh = this.blankEffect(effect.type, effect);
          for (const key of EFFECT_KEYS) delete effect[key];
          Object.assign(effect, fresh);
          for (const path of Object.keys(this.fieldErrors)) if (path.startsWith(`${at}.`)) delete this.fieldErrors[path];
        }
      ));
      for (const field of rule?.fields ?? []) {
        const path = `${at}.${field.key}`;
        if (field.whenStackable && effect.stackable !== true) continue;
        if (field.key === "target_particles") {
          grid.appendChild(this.particles(field.label, field.hint, effect, "target_particles", path));
        } else if (field.key === "stackable") {
          grid.appendChild(this.field({ key: field.key, label: field.label, type: "switch", hint: field.hint, rerender: true }, effect, path));
        } else {
          grid.appendChild(this.field({ key: field.key, type: "number", hint: field.hint, ...unitOf(field.label), ...this.limits(field) }, effect, path));
        }
      }
    });

    if (!this.readOnly) {
      const max = this.data.maxEffects ?? 10;
      const unused = this.freeEffectTypes();
      const add = button("Add effect", () => {
        effects.push(this.blankEffect(unused[0].type));
        this.dirty = true;
        this.refused = false;
        this.renderForm();
      }, { icon: "plus", add: true });
      main.appendChild(add);
      const why = effects.length >= max ? `A spell can have at most ${max} effects.` : unused.length === 0 ? "Every effect type is already on this spell." : "";
      if (why) {
        forbid(add, why);
        const said = el("p", "tl-why");
        said.append(icon("lock", 13), el("span", "", why));
        main.appendChild(said);
      }
    }

    // What the effects column will hold, for anyone who knows the format.
    const stored = card(main, "As it is saved", "The effects exactly as the server stores them. This follows what you change above; it cannot be edited here.");
    this.codeEl = el("pre", "tl-code");
    this.codeEl.tabIndex = 0;
    this.codeEl.setAttribute("aria-label", "The effects as they are saved");
    stored.body.appendChild(this.codeEl);
  }

  /** Move up, move down and remove, in an effect card's header. */
  private effectActions(index: number): HTMLElement[] {
    const effects: any[] = this.draft.effects;
    const act = (name: "arrowUp" | "arrowDown" | "trash", label: string, enabled: boolean, change: () => void) => {
      const btn = iconButton(name, label, () => {
        change();
        this.dirty = true;
        this.refused = false;
        // Positions changed, so the problems reported by position no longer line up.
        for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("effects")) delete this.fieldErrors[path];
        this.renderForm();
      }, { danger: name === "trash", size: 15 });
      btn.disabled = !enabled;
      return btn;
    };
    const swap = (a: number, b: number) => {
      [effects[a], effects[b]] = [effects[b], effects[a]];
    };
    return [
      act("arrowUp", `Move effect ${index + 1} up`, index > 0, () => swap(index, index - 1)),
      act("arrowDown", `Move effect ${index + 1} down`, index < effects.length - 1, () => swap(index, index + 1)),
      act("trash", `Remove effect ${index + 1}`, true, () => effects.splice(index, 1)),
    ];
  }

  /** What the numbers add up to in game, in plain words: one sentence to a line. */
  private summary(): string[] {
    const d = this.draft;
    const damage = toNumber(d.damage) || 0;
    const radius = toNumber(d.aoe_radius) || 0;
    const range = toNumber(d.range) || 100;
    const castTime = toNumber(d.cast_time) || 0;
    const zone = toNumber(d.ground_duration) || 0;
    const heals = damage < 0;

    const what = damage > 0 ? `Deals ${damage} base damage` : heals ? `Heals ${-damage} base health` : "Does no damage or healing of its own";
    let who: string;
    if (radius > 0 && d.ground_aoe) {
      who = `within ${pixels(radius)} of a spot the caster clicks, up to ${pixels(range)} away`;
      if (zone > 0) who += `; the circle then stays for ${seconds(zone)} and hits again every second`;
    } else if (radius > 0) {
      who = heals
        ? `to the caster and the party members within ${pixels(radius)} of them`
        : `to everyone within ${pixels(radius)} of the caster, their party aside (the selected target is ignored)`;
    } else {
      who = `to one target within ${pixels(range)}`;
    }
    const lines = [`${what} ${who}.`];
    lines.push(
      `${castTime > 0 ? `Takes ${seconds(castTime)} to cast` : "Instant"}, with a cooldown of ${seconds(toNumber(d.cooldown) || 0)}. ` +
        `Costs ${toNumber(d.mana) || 0}% of base stamina, and ${d.can_move ? "can be cast while moving" : "the caster must stand still"}.`
    );
    if (radius > 0 && (toNumber(d.charge_distance) > 0 || d.teleport_behind)) {
      lines.push("Charge and teleport behind only happen on single-target spells: with an area radius they are ignored.");
    }
    const effects: any[] = d.effects ?? [];
    if (effects.length > 0) {
      lines.push(`Then applies ${listed(effects.map((e) => lower(this.effectRule(e.type)?.label ?? e.type)))}.`);
    }
    return lines;
  }

  /** The parts that follow the fields as they change: the summary beside the form, and the effects as stored. */
  private paintLive(): void {
    if (!this.draft) return;
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
    if (this.codeEl) this.codeEl.textContent = JSON.stringify(this.cleanEffects(), null, 2);
  }

  // ------------------------------------------------------------------ fields

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /** The limits of a number as the field's own: the browser's arrows and its own check follow them. */
  private limits(rule?: NumberRule): Pick<Field, "min" | "max" | "step"> {
    if (!rule) return {};
    return { min: rule.min, max: rule.max, step: (rule.decimals ?? 0) > 0 ? 0.1 : 1 };
  }

  /**
   * One form field editing `target[field.key]`, with any problem reported
   * under `path` shown beneath it. `onChange` runs before the form is told.
   */
  private field(field: Field, target: any, path: string, onChange?: () => void): HTMLElement {
    const wrap = this.fields.renderField({ ...field, path }, target, () => {
      onChange?.();
      this.touched(path, wrap);
    }, { error: this.fieldErrors[path], disabled: this.readOnly });
    return wrap;
  }

  /** The field was edited: there is something to save, and its old problem no longer describes it. */
  private touched(path: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    if (this.fieldErrors[path]) {
      delete this.fieldErrors[path];
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
  }

  /** A numeric spell column, with the server's limits for it. */
  private number(key: string, label: string, hint: string, unit?: string): HTMLElement {
    return this.field({ key, label, type: "number", hint, unit, ...this.limits(this.numberRule(key)) }, this.draft, key);
  }

  /**
   * A comma-separated list of particle names, shown as removable chips with a
   * searchable picker of the particles that exist.
   */
  private particles(label: string, hint: string, target: any, key: string, path: string): HTMLElement {
    const known: string[] = this.data.particles ?? [];
    return this.field({
      key, label, hint, type: "list", noun: "particle", noIcons: true,
      assets: () => known.map((k) => ({ value: k, label: k })),
      known: (name) => known.some((k) => lower(k) === lower(name)),
    }, target, path);
  }

  // ----------------------------------------------------------------- opening

  /** True when the open spell can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.titleOf(this.draft));
  }

  private open(draft: any, originalName: string | null, dirty: boolean): void {
    this.originalName = originalName;
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(name: string): Promise<void> {
    if (!(await this.mayLeave())) return;
    const spell = this.results.find((s: any) => s.name === name);
    if (!spell) return;
    this.open(this.toDraft(spell), name, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.tab = "general";
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  /** Start a new, unsaved spell copied from a list row. This is how a spell gets a new name. */
  private async duplicate(spell: any): Promise<void> {
    if (!spell || !(await this.mayLeave())) return;
    const copy = this.toDraft(spell);
    delete copy.id;
    delete copy.plugin;
    copy.name = `${copy.name}_copy`;
    this.tab = "general";
    this.open(copy, null, true);
    // The copy needs a name of its own before it can be saved.
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.readOnly || this.pending) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    this.beginRequest("save", "SPELL_EDITOR_SAVE", { ...this.draft, effects: this.cleanEffects(), originalName: this.originalName }, String(this.draft.name ?? ""));
  }

  /** Delete a spell, from its list row or the top bar. The server refuses while the spell is still in use. */
  private async deleteEntry(spell: any): Promise<void> {
    const name = String(spell?.name ?? "");
    if (!name || this.pending) return;
    const agreed = await this.shell.confirmDelete(name, ["This cannot be undone.", "A spell that a player still knows or a creature still casts is not deleted: the server says where it is still used."]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "SPELL_EDITOR_DELETE", { name }, name);
  }

  /** Teach the open, saved spell to the admin's own character. */
  private learn(): void {
    if (!this.draft || this.originalName === null || this.dirty || this.pending) return;
    this.beginRequest("learn", "SPELL_EDITOR_LEARN", { name: this.originalName }, this.originalName);
  }

  private beginRequest(kind: "save" | "delete" | "learn", packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name, adds: kind === "save" && this.originalName === null };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server drops the packet outright:
    // don't leave the buttons blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      toast("The server did not answer in time, so nothing was confirmed.", "error");
    }, 15000);
    this.shell.send({ type: "request", packet, data });
    this.chrome();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.chrome();
  }
}

new SpellEditorBridge();
