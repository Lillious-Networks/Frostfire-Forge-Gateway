// Creature editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// The window itself is the workbench of the tool windows, drawn by
// tooleditor.ts as an editor of several kinds of record; this file holds what
// is the creature editor's own: its four kinds of record, their fields and
// rules, the tools that act in the game window, and the conversation with the
// server.
//
// It is four editors in one. Creatures are the large one: a creature has
// pages (General, Appearance, Rewards) and two lists of records of its own,
// its abilities and its spawn points, each saved by its own request when Save
// is pressed. Patrol paths, link groups and spawn pools are what spawn points
// refer to, and fit one page each.
import { EditorShell, type Kind, type ListRow, type RecordState } from "./tooleditor.js";
import { coins, FieldRenderer, orderFields, setFieldError, sheetOptions, type AssetOption, type Field, type Option } from "./toolfields.js";
import { button, card, count, duration, el, empty, icon, iconButton, note, noticeDialog, num, pill, short, shown, subcard, svg, switchControl, tag, thumb, titleCount, toast, tooltip, words } from "./toolkit.js";

const CREATURE_FLAGS: Array<{ bit: number; label: string }> = [
  { bit: 1 << 0, label: "Cannot be taunted" },
  { bit: 1 << 1, label: "Immune to stun" },
  { bit: 1 << 2, label: "Immune to root and slow" },
  { bit: 1 << 3, label: "Gives no XP" },
  { bit: 1 << 4, label: "No leash" },
  { bit: 1 << 5, label: "Never flees" },
  { bit: 1 << 6, label: "Can swim" },
  { bit: 1 << 7, label: "Detects stealth" },
  { bit: 1 << 8, label: "No social aggro" },
];

type KindId = "templates" | "paths" | "linkGroups" | "pools";
type TabId = "general" | "appearance" | "rewards" | "abilities" | "spawns";
type SaveKind = "template" | "abilities" | "spawn" | "spawnDelete" | "delete" | "other";
/** The parts of what is open that are saved by a request each: the record's own fields, a creature's abilities, its open spawn point. */
type Part = "record" | "abilities" | "spawn";

/** The pages of a creature. The other kinds fit one page. */
const TABS: Array<{ id: TabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "rewards", label: "Rewards" },
  { id: "abilities", label: "Abilities" },
  { id: "spawns", label: "Spawns" },
];

const KINDS: Kind[] = [
  { id: "templates", label: "Creatures", noun: "creature", icon: "paw", tabs: TABS },
  { id: "paths", label: "Patrol paths", noun: "patrol path", icon: "route" },
  { id: "linkGroups", label: "Link groups", noun: "link group", icon: "link" },
  { id: "pools", label: "Spawn pools", noun: "spawn pool", icon: "layers" },
];

const PACKET: Record<KindId, string> = { templates: "TEMPLATE", paths: "PATH", linkGroups: "LINKGROUP", pools: "POOL" };

const RANKS = ["normal", "elite", "rare", "rare_elite", "boss"];
const CREATURE_TYPES = ["beast", "humanoid", "undead", "elemental", "demon", "dragonkin", "critter", "mechanical"];
/** What an animated creature wears, in the slots players wear them. */
const WORN: Array<[key: string, label: string, slot: string]> = [
  ["sprite_helmet", "Helmet", "helmet"],
  ["sprite_shoulderguards", "Shoulders", "shoulderguards"],
  ["sprite_neck", "Neck", "neck"],
  ["sprite_hands", "Gloves", "hands"],
  ["sprite_chest", "Chest", "chest"],
  ["sprite_feet", "Boots", "feet"],
  ["sprite_legs", "Pants", "legs"],
  ["sprite_weapon", "Weapon", "weapon"],
];

/** When an ability is used, in plain words. The server's own word is kept for one it adds later. */
const TRIGGER_WORDS: Record<string, string> = {
  combat_timer: "On a timer, in a fight",
  hp_below: "Once its health is low",
  on_aggro: "When a fight starts",
  on_death: "When it dies",
  on_evade: "When it gives up and resets",
  target_casting: "While its target is casting",
  ooc_timer: "On a timer, out of a fight",
};
const TARGET_WORDS: Record<string, string> = {
  current: "Its current target",
  random: "A random player it is fighting",
  random_not_top: "A random player, not its current target",
  farthest: "The farthest player it is fighting",
  lowest_hp_ally: "The most wounded creature nearby",
  self: "Itself",
};
const MOVEMENT_WORDS: Record<string, string> = { idle: "Idle", wander: "Wander", patrol: "Patrol" };
const LAYER_WORDS: Record<string, string> = { per_layer: "Per layer", shared: "Shared" };

/**
 * The server answers a refused save in sentences, not by field. Each of its
 * sentences is about one field: these say which, so that field can be marked
 * and its tab pointed at. A sentence that matches nothing is still shown at
 * the top of the page.
 */
const TEMPLATE_PROBLEMS: Array<[RegExp, string]> = [
  [/^Name /, "name"],
  [/^Minimum level /, "level_min"],
  [/^Maximum level /, "level_max"],
  [/^Stance /, "stance"],
  [/^Rank /, "rank"],
  [/^Base health /, "health_base"],
  [/^Scale /, "scale"],
  [/^Flee health /, "flee_at_hp_pct"],
  [/^Maximum money /, "gold_max"],
  [/^Sprite type /, "sprite_type"],
  [/^A sprite name is required/, "sprite"],
  [/^Loot table /, "loot_table_id"],
];
const ABILITY_PROBLEMS: Array<[RegExp, string]> = [
  [/^Spell /, "spell_id"],
  [/^Trigger /, "trigger"],
  [/^Target mode /, "target_mode"],
  [/^Maximum cooldown /, "cooldown_max_ms"],
  [/^Maximum initial delay /, "initial_cd_max_ms"],
  [/^Chance /, "chance_pct"],
  [/^Health threshold /, "trigger_value"],
];
const SPAWN_PROBLEMS: Array<[RegExp, string]> = [
  [/^Map /, "map"],
  [/^Position must be numeric/, "x"],
  [/^That position is inside collision/, "x"],
  [/^Layer policy /, "layer_policy"],
  [/^Movement type /, "movement_type"],
  [/^Maximum respawn /, "respawn_max_s"],
  [/^Wander movement needs/, "wander_radius"],
  [/^Patrol (path|movement) /, "patrol_path_id"],
  [/^Link group /, "link_group_id"],
  [/^Spawn pool /, "pool_id"],
];
const OTHER_PROBLEMS: Record<Exclude<KindId, "templates">, Array<[RegExp, string]>> = {
  paths: [[/^Map /, "map"]],
  linkGroups: [[/^Link group name /, "name"]],
  pools: [[/^Max active /, "max_active"], [/^Rare chance /, "rare_chance_pct"], [/^Rare template /, "rare_template_id"]],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** 8000 -> "8", 2500 -> "2.5": milliseconds, said in seconds. */
const secs = (ms: unknown): string => short((Number(ms) || 0) / 1000);
/** "8 s", or "8 to 12 s" when the two ends differ. */
const span = (from: string, to: string, unit: string): string => (from === to ? `${from} ${unit}` : `${from} to ${to} ${unit}`);
/** A position in the world. */
const where = (x: unknown, y: unknown): string => `${num(Number(x) || 0)}, ${num(Number(y) || 0)}`;

/** The words of the game written for reading, stored as they were: "rare_elite" is listed as "Rare elite". */
const choices = (values: string[], said: Record<string, string> = {}) => (): Option[] => values.map((value) => ({ value, label: said[value] ?? words(value) }));

class CreatureEditorBridge {
  private data: any = { templates: [], abilities: [], spawns: [], patrolPaths: [], linkGroups: [], pools: [], spells: [], lootTables: [], maps: [], triggers: [], targetModes: [], spriteSheets: {}, icons: [] };
  /** The server's first answer has arrived. */
  private ready = false;
  private kind: KindId = "templates";
  private tab: TabId = "general";
  private selectedId: number | null = null;
  private draft: any = null;
  /** Counts the records opened, so the page knows a redraw from a different record. */
  private opened = 0;
  private dirty = false;
  /** The selected creature's abilities being edited on the Abilities tab. */
  private abilityDraft: any[] = [];
  private abilitiesDirty = false;
  /** Which abilities are opened to their fields, by position. */
  private openAbilities = new Set<number>();
  /**
   * The spawn open on the selected creature's Spawns tab. Its creature is
   * implied (the selected one), so it has no creature picker.
   */
  private spawnDraft: any = null;
  private spawnDirty = false;

  /**
   * The save or delete in flight. Save waits for its result: a new entry has
   * no id until then, so a second Save would insert it again. `draft` and
   * `spawn` are what it was sent for: its result only counts for them while
   * they are still the ones open.
   */
  private pending: { kind: SaveKind; packet: string; name: string; draft: any; spawn: any } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Kind to open once the in-flight save succeeds ("Save and leave" in the leave question). */
  private afterSaveKind: KindId | null = null;

  /** The last save was refused and nothing has been changed since. */
  private refused = false;
  /** What the server said was wrong with the last save, sentence by sentence, under a line that says which part it was. */
  private problemLead = "";
  private problems: string[] = [];
  /** The same by field, for the sentences that are about one field. */
  private fieldErrors: Record<string, string> = {};

  /** The parts of the page that follow the fields as they are typed in. */
  private live: Array<() => void> = [];
  private headThumb: { key: string; node: HTMLElement } | null = null;

  private shell = new EditorShell({
    tool: "Creature Editor",
    kinds: KINDS,
    onKind: (id) => void this.requestKind(id as KindId),
    // The lists are held whole: a search only filters what is shown, at every key.
    onSearch: () => this.renderList(),
    liveSearch: true,
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDelete: () => void this.deleteEntry(this.draft),
    onTab: (id) => this.switchTab(id as TabId),
  });

  private fields = new FieldRenderer({
    rerender: () => this.renderForm(),
    // Only sprite sheet fields come here: every other picker says what it offers itself.
    assetOptions: (field, value) => sheetOptions(this.data.spriteSheets, field.slot || "other", String(value ?? "")),
    flags: CREATURE_FLAGS,
  });

  constructor() {
    this.buildOverlay();
    this.shell.waiting(() => this.askForLists());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private askForLists(): void {
    this.shell.send({ type: "request", packet: "CREATURE_EDITOR_LIST", data: null });
  }

  /** The switch under the list: the overlay the game window draws over the world while this editor is open. */
  private buildOverlay(): void {
    const box = el("div", "ce-overlay");
    const toggle = switchControl(false, "Debug overlay in the game window", (on) => this.shell.send({ type: "debug", on }));
    toggle.dataset.act = "debug";
    toggle.disabled = this.shell.standalone;
    const title = el("label", "ce-overlay-title");
    title.append(icon("eye", 15), el("span", "", "Debug overlay"));
    title.addEventListener("click", () => {
      if (!toggle.disabled) toggle.click();
    });
    box.append(title, toggle, el("div", "ce-overlay-note", "Ranges, paths and threat, drawn over the game."));
    tooltip(title, "While it is on, the game window draws each nearby creature's aggro, assist, call for help, leash and wander ranges, the path it is walking and what it is doing, and lists the threat on the creature you have targeted.");
    this.shell.sideFoot.appendChild(box);
  }

  // ---------------------------------------------------------------- messages

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.data = msg.data ?? {};
      for (const key of ["templates", "abilities", "spawns", "patrolPaths", "linkGroups", "pools", "spells", "lootTables", "maps", "triggers", "targetModes", "icons"]) {
        if (!Array.isArray(this.data[key])) this.data[key] = [];
      }
      this.data.spriteSheets ??= {};
      if (!this.ready) {
        this.ready = true;
        this.shell.arrived();
      }
      // Fresh ability ids from the server, unless there are edits to keep.
      if (!this.abilitiesDirty) this.loadAbilityDraft();
      // Same for the open spawn; one deleted elsewhere closes.
      if (this.spawnDraft?.id && !this.spawnDirty) {
        const fresh = this.data.spawns.find((s: any) => s.id === this.spawnDraft.id);
        this.spawnDraft = fresh ? clone(fresh) : null;
      }
      this.renderList();
      this.renderForm();
    } else if (msg.type === "result") {
      this.onResult(msg);
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed the creature data. The lists show it as it is now.`);
      this.askForLists();
    } else if (msg.type === "pointPicked") {
      this.onPointPicked(msg);
    }
  }

  private onResult(msg: any): void {
    // Only the in-flight save/delete's own result counts: others (Go to)
    // must not clear unsaved changes or release the pending save.
    if (!this.pending || (msg.action && msg.action !== this.pending.packet)) {
      if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
      return;
    }
    const sent = this.pending;
    this.endRequest();
    const deleted = sent.kind === "delete" || sent.kind === "spawnDelete";
    // The record it was sent for is still the one open (another may have been opened while it was on its way).
    const here = sent.draft === this.draft;

    if (!msg.ok) {
      // A failed save keeps the admin here, with what is wrong, instead of leaving.
      this.afterSaveKind = null;
      const lines: string[] = msg.errors?.length ? msg.errors : [deleted ? "The server refused to delete it." : "The server refused the save."];
      // Why a delete was refused is something to read, so it stays until it is closed.
      if (deleted) return void noticeDialog(`${sent.name} was not deleted`, lines);
      if (!here) return void toast([`${sent.name} was not saved.`, ...lines].join("\n"), "error");
      this.showRefusal(sent.kind, lines);
      return;
    }

    if (sent.kind === "abilities") {
      if (here) this.abilitiesDirty = false;
    } else if (sent.kind === "spawn") {
      if (sent.spawn === this.spawnDraft) {
        this.spawnDirty = false;
        // A new spawn now exists: later saves must update it, not insert again.
        if (msg.id && this.spawnDraft && !this.spawnDraft.id) this.spawnDraft.id = msg.id;
      }
    } else if (!deleted && here) {
      // Deleting leaves the open entry and its unsaved edits alone; this is a save of the entry itself.
      this.dirty = false;
      if (msg.id && this.draft) {
        this.selectedId = msg.id;
        // A new entry now exists: later saves must update it, not insert again.
        if (!this.draft.id) this.draft.id = msg.id;
      }
    }
    // One Save covers the whole creature: fields first (a new creature
    // needs its id), then abilities, then the open spawn.
    if (!deleted && here && this.saveNextDirty()) return;

    if (!deleted && here) {
      this.refused = false;
      this.clearProblems();
    }
    toast(deleted ? `Deleted ${sent.name}.` : `Saved ${sent.name}.`);
    this.askForLists();
    // Saved from the leave question: now go where the admin was heading.
    const next = this.afterSaveKind;
    this.afterSaveKind = null;
    if (next) return this.switchKind(next);
    this.renderList();
    this.renderForm();
  }

  /** The game window collected a world position or a path for what is open. */
  private onPointPicked(msg: any): void {
    if (msg.what === "spawn" && this.spawnDraft) {
      this.spawnDraft.x = msg.x;
      this.spawnDraft.y = msg.y;
      this.spawnDraft.map = msg.map;
      this.spawnDirty = true;
      this.refused = false;
      for (const key of ["map", "x", "y"]) this.dropProblem(`spawn.${key}`);
      this.renderForm();
      toast(`Placed at ${where(msg.x, msg.y)} on ${msg.map}.`);
    } else if (msg.what === "path" && this.kind === "paths" && this.draft) {
      this.draft.points = msg.points;
      this.draft.map = msg.map;
      // Drawn points are unsaved edits: switching entries must confirm first.
      this.dirty = true;
      this.refused = false;
      this.dropPointProblems();
      this.renderForm();
    }
  }

  // ---------------------------------------------------------------- problems

  /** A save was refused: its sentences at the top of the page, on their fields, and counted on their tabs. */
  private showRefusal(kind: SaveKind, lines: string[]): void {
    this.refused = true;
    this.problems = lines;
    this.fieldErrors = {};
    // A creature is saved in up to three requests: say which of them this was.
    this.problemLead = kind === "abilities" ? "The abilities were not saved. The server said:" : kind === "spawn" ? "The spawn point was not saved. The server said:" : "";
    for (const line of lines) {
      const path = this.fieldOf(kind, line);
      if (path) this.fieldErrors[path] ??= line;
    }
    if (this.kind === "templates") {
      // Show a tab that has a problem, unless the one in view already does.
      const tabs = [...new Set(Object.keys(this.fieldErrors).map((path) => this.tabOf(path)))];
      if (tabs.length && !tabs.includes(this.tab)) this.tab = tabs[0];
      else if (!tabs.length && kind === "abilities") this.tab = "abilities";
      else if (!tabs.length && kind === "spawn") this.tab = "spawns";
      // An ability with a problem is opened to its fields.
      for (const path of Object.keys(this.fieldErrors)) {
        const at = /^abilities\.(\d+)\./.exec(path);
        if (at) this.openAbilities.add(Number(at[1]));
      }
    }
    this.renderForm();
    this.paintProblems(true);
  }

  /** Which field one of the server's sentences is about, as the path the page knows it by. */
  private fieldOf(kind: SaveKind, line: string): string | undefined {
    const find = (table: Array<[RegExp, string]>, text: string) => table.find(([pattern]) => pattern.test(text))?.[1];
    if (kind === "abilities") {
      // "Ability 2 (Fireball): Chance must be between 0 and 100."
      const at = /^Ability (\d+) \(.*?\): (.*)$/.exec(line);
      const key = at && find(ABILITY_PROBLEMS, at[2]);
      return at && key ? `abilities.${Number(at[1]) - 1}.${key}` : undefined;
    }
    if (kind === "spawn") {
      const key = find(SPAWN_PROBLEMS, line);
      return key ? `spawn.${key}` : undefined;
    }
    if (this.kind === "templates") return find(TEMPLATE_PROBLEMS, line);
    if (this.kind === "paths") {
      const at = /^Point (\d+) /.exec(line);
      if (at) return `points.${Number(at[1]) - 1}`;
    }
    return find(OTHER_PROBLEMS[this.kind], line);
  }

  /** Which page of a creature a field is edited on. */
  private tabOf(path: string): TabId {
    if (path.startsWith("abilities.")) return "abilities";
    if (path.startsWith("spawn.")) return "spawns";
    if (path.startsWith("sprite") || path === "scale") return "appearance";
    return ["xp_mult", "loot_table_id", "gold_min", "gold_max"].includes(path) ? "rewards" : "general";
  }

  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const path of Object.keys(this.fieldErrors)) counts[this.tabOf(path)] = (counts[this.tabOf(path)] ?? 0) + 1;
    return counts;
  }

  private paintProblems(show = false): void {
    this.shell.setProblems(this.problems.length ? [...(this.problemLead ? [this.problemLead] : []), ...this.problems] : [], show);
  }

  /** Nothing is wrong any more: a save went through, or another record is opened. */
  private clearProblems(): void {
    this.problemLead = "";
    this.problems = [];
    this.fieldErrors = {};
    this.shell.setProblems([]);
  }

  /** A field was put right, or changed: its sentence leaves the summary with its mark. Returns whether it had one. */
  private dropProblem(path: string): boolean {
    const fixed = this.fieldErrors[path];
    if (!fixed) return false;
    delete this.fieldErrors[path];
    this.problems = this.problems.filter((line) => line !== fixed);
    return true;
  }

  /** The points of the open path changed: what the server said about them no longer describes them. */
  private dropPointProblems(): void {
    for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("points.")) delete this.fieldErrors[path];
    this.problems = this.problems.filter((line) => !/point/i.test(line));
  }

  /** Something the server refused that no request here was waiting for (Go to, say): in the corner, in its words. */
  private report(lines: string[]): void {
    // Before the first lists it can only be the editor itself that was refused.
    if (!this.ready) return this.shell.refused(lines, () => this.askForLists());
    toast(lines.join("\n"), "error");
  }

  // ------------------------------------------------------------- collections

  private listOf(kind: KindId): any[] {
    switch (kind) {
      case "paths": return this.data.patrolPaths;
      case "linkGroups": return this.data.linkGroups;
      case "pools": return this.data.pools;
      default: return this.data.templates;
    }
  }

  private get collection(): any[] {
    return this.listOf(this.kind);
  }

  private get noun(): string {
    return KINDS.find((kind) => kind.id === this.kind)!.noun;
  }

  private templateName(id: number): string {
    return this.data.templates.find((t: any) => t.id === id)?.name ?? `Creature #${id}`;
  }

  private spellOf(id: unknown): any {
    return this.data.spells.find((s: any) => s.id === Number(id));
  }

  /** The saved spawn points of the open creature. */
  private mySpawns(): any[] {
    return this.draft?.id ? this.data.spawns.filter((s: any) => s.template_id === this.draft.id) : [];
  }

  /** "Level 5", or "Level 5 to 7". */
  private levels(t: any): string {
    const min = Number(t.level_min) || 0;
    const max = Number(t.level_max) || 0;
    return min === max ? `Level ${num(min)}` : `Level ${num(min)} to ${num(max)}`;
  }

  /** "Elite beast": what kind of creature it is, in two words. */
  private breed(t: any): string {
    const rank = String(t.rank || "normal");
    return words(`${rank === "normal" ? "" : `${rank} `}${t.creature_type || "creature"}`);
  }

  /** What an entry is called in its list, in the top bar and in what is said about it. `open` is the draft being edited. */
  private nameOf(kind: KindId, entry: any, open = false): string {
    switch (kind) {
      case "paths": return entry.id ? `Patrol path #${entry.id}` : "New patrol path";
      case "linkGroups": return String(entry.name ?? "").trim() || (entry.id && !open ? `Link group #${entry.id}` : entry.id ? "Unnamed link group" : "New link group");
      case "pools": return entry.id ? `Spawn pool #${entry.id}` : "New spawn pool";
      default: return String(entry.name ?? "").trim() || (entry.id ? "Unnamed creature" : "New creature");
    }
  }

  /** The second line of an entry: what sets it apart from the others of its kind. */
  private noteOf(kind: KindId, entry: any): string {
    switch (kind) {
      case "paths": {
        const points = entry.points?.length ?? 0;
        return `${entry.map || "No map"} · ${count(points, "point")}`;
      }
      case "linkGroups": {
        const members = this.data.spawns.filter((s: any) => entry.id && s.link_group_id === entry.id).length;
        return `#${entry.id} · ${count(members, "spawn point")}`;
      }
      case "pools": {
        const rare = entry.rare_template_id ? ` · rare: ${this.templateName(entry.rare_template_id)}` : "";
        return `Up to ${num(Number(entry.max_active) || 0)} alive${rare}`;
      }
      default:
        return `${this.levels(entry)} · ${this.breed(entry)}`;
    }
  }

  /** Everything a search looks through. It holds the row as the old editor wrote it, so what was found before still is. */
  private haystack(kind: KindId, entry: any): string {
    switch (kind) {
      case "paths": return `#${entry.id} ${entry.map} (${entry.points?.length ?? 0} points) patrol path`;
      case "linkGroups": return `#${entry.id} ${entry.name} link group`;
      case "pools": return `#${entry.id} max ${entry.max_active}${entry.rare_template_id ? ` rare ${this.templateName(entry.rare_template_id)}` : ""} spawn pool`;
      default: return `${entry.name}${entry.subname ? ` <${entry.subname}>` : ""} (lvl ${entry.level_min}-${entry.level_max}) ${entry.rank} ${entry.creature_type} #${entry.id}`;
    }
  }

  /** The picture of an icon the asset server listed, by the name a creature stores. */
  private iconImage(name: unknown): string | null {
    const wanted = String(name ?? "").trim().replace(/\.(png|jpg|jpeg|gif)$/i, "").toLowerCase();
    if (!wanted) return null;
    return this.data.icons.find((i: any) => String(i.name).toLowerCase() === wanted)?.image ?? null;
  }

  /** A creature with a still image shows it; anything else shows the icon of its kind. */
  private thumbOf(kind: KindId, entry: any, size: "" | "lg" | "xl" = ""): HTMLElement {
    if (kind !== "templates") return thumb(null, { size, fallback: KINDS.find((k) => k.id === kind)!.icon });
    return thumb(entry.sprite_type === "static" ? this.iconImage(entry.sprite) : null, { size, fallback: "paw" });
  }

  // ------------------------------------------------------------------ fields

  private mapAssets = (): AssetOption[] => this.data.maps.map((m: string) => ({ value: m, label: m }));

  private creatureFields(): Field[] {
    return [
      { key: "name", label: "Name", type: "text" },
      { key: "subname", label: "Title", type: "text", hint: "Shown under the name, like <Blacksmith>." },
      { key: "level_min", label: "Minimum level", type: "number", hint: "Each spawn picks a level between the two." },
      { key: "level_max", label: "Maximum level", type: "number" },
      { key: "rank", label: "Rank", type: "select", options: choices(RANKS) },
      { key: "creature_type", label: "Type", type: "select", options: choices(CREATURE_TYPES) },
      { key: "stance", label: "Stance", type: "segmented", wide: true, options: choices(["aggressive", "neutral", "passive"]), hint: "Aggressive attacks players who come close. Neutral fights back. Passive runs when hit." },
      { key: "health_base", label: "Health at level 1", type: "number", hint: "Its base health." },
      { key: "health_per_level", label: "Health per level", type: "number", hint: "Added for each level above 1." },
      { key: "armor", label: "Armor", type: "number" },
      { key: "ranged", label: "Keeps its distance", type: "switch", wide: true, hint: "Stops at range instead of closing in." },
      { key: "move_speed_walk", label: "Walk speed", type: "number", step: 0.1, unit: "yd/s", hint: "Used when idle, wandering or patrolling." },
      { key: "move_speed_run", label: "Run speed", type: "number", step: 0.1, unit: "yd/s", hint: "Used when chasing or fleeing." },
      { key: "leash_override", label: "Leash range", type: "number", unit: "yards", placeholder: "60", hint: "How far it chases from where the fight started before resetting. Empty means the usual 60." },
      { key: "aggro_radius_override", label: "Aggro radius", type: "number", unit: "yards", placeholder: "20", hint: "Empty means the usual 20. It grows or shrinks 1 yard per level of difference to the player." },
      { key: "assist_radius", label: "Assist radius", type: "number", unit: "yards", hint: "Idle allies this close join in when it is pulled." },
      { key: "call_for_help_radius", label: "Call for help radius", type: "number", unit: "yards", hint: "Idle allies this close join in when it flees." },
      { key: "flee_at_hp_pct", label: "Flee at health", type: "number", unit: "%", hint: "0 means it never flees." },
      { key: "flee_duration_ms", label: "Flee duration", type: "number", unit: "ms" },
      { key: "regen_ooc", label: "Regenerates out of combat", type: "switch", wide: true },
      { key: "flags", label: "Flags", type: "flags" },
    ];
  }

  private appearanceFields(): Field[] {
    const type = String(this.draft?.sprite_type ?? "none");
    return [
      { key: "sprite_type", label: "Sprite type", type: "segmented", wide: true, rerender: true, options: choices(["animated", "static", "none"]), hint: "Animated is built from sprite sheets, like a player. Static is one still image." },
      ...(type === "static"
        ? ([{
            key: "sprite", label: "Static image", type: "asset", fallback: "image",
            assets: () => [{ value: "", label: "None" }, ...this.data.icons.map((i: any) => ({ value: i.name, label: i.name, image: i.image }))],
          }] as Field[])
        : []),
      ...(type === "animated"
        ? ([
            { key: "sprite", label: "Body sheet", type: "sheet", slot: "body", noIcons: true },
            { key: "sprite_head", label: "Head sheet", type: "sheet", slot: "head", noIcons: true },
          ] as Field[])
        : []),
      { key: "scale", label: "Scale", type: "number", step: 0.1, hint: "1 is normal size. Bigger creatures also reach further in melee." },
    ];
  }

  private rewardFields(): Field[] {
    return [
      { key: "xp_mult", label: "XP multiplier", type: "number", step: 0.1, hint: "1 is the normal XP for its level." },
      { key: "loot_table_id", label: "Loot table", type: "asset", noIcons: true, hint: "Items rolled into its corpse.", assets: () => [{ value: 0, label: "None" }, ...this.data.lootTables.map((t: any) => ({ value: t.id, label: t.name }))] },
    ];
  }

  /** Fields of one spawn. The creature is implied: the one selected. */
  private spawnFields(): Record<"place" | "respawn" | "movement" | "grouping", Field[]> {
    const none = { value: 0, label: "None" };
    return {
      place: [
        { key: "map", label: "Map", type: "asset", noIcons: true, assets: this.mapAssets },
        { key: "x", label: "X", type: "number" },
        { key: "y", label: "Y", type: "number" },
        { key: "direction", label: "Facing", type: "segmented", options: choices(["down", "up", "left", "right"]) },
      ],
      respawn: [
        { key: "respawn_min_s", label: "Minimum respawn", type: "number", unit: "seconds", hint: "Each respawn waits a time picked between the two." },
        { key: "respawn_max_s", label: "Maximum respawn", type: "number", unit: "seconds" },
        { key: "layer_policy", label: "Layers", type: "segmented", options: choices(["per_layer", "shared"], LAYER_WORDS), hint: "Per layer: one creature on every layer. Shared: one creature all layers see." },
      ],
      movement: [
        { key: "movement_type", label: "Movement", type: "segmented", options: choices(["idle", "wander", "patrol"], MOVEMENT_WORDS) },
        { key: "wander_radius", label: "Wander radius", type: "number", unit: "yards", hint: "Only used with wander movement." },
        { key: "patrol_path_id", label: "Patrol path", type: "asset", noIcons: true, hint: "Only used with patrol movement. The path has to be on this spawn's map.", assets: () => [none, ...this.data.patrolPaths.map((p: any) => ({ value: p.id, label: `Path #${p.id} · ${p.map}` }))] },
      ],
      grouping: [
        { key: "link_group_id", label: "Link group", type: "asset", noIcons: true, hint: "Linked spawns are pulled together.", assets: () => [none, ...this.data.linkGroups.map((g: any) => ({ value: g.id, label: g.name }))] },
        { key: "pool_id", label: "Spawn pool", type: "asset", noIcons: true, hint: "Caps how many spawns in the pool are alive at once.", assets: () => [none, ...this.data.pools.map((p: any) => ({ value: p.id, label: `Pool #${p.id}` }))] },
      ],
    };
  }

  /** Fields of one ability. The creature is implied: the one selected. */
  private abilityFields(): Field[] {
    return [
      { key: "spell_id", label: "Spell", type: "asset", rerender: true, fallback: "wand", assets: () => this.data.spells.map((s: any) => ({ value: s.id, label: s.name, image: s.icon })) },
      { key: "trigger", label: "Trigger", type: "select", options: choices(this.data.triggers, TRIGGER_WORDS) },
      { key: "trigger_value", label: "Health threshold", type: "number", unit: "%", hint: "Only used by the low health trigger." },
      { key: "target_mode", label: "Target", type: "select", options: choices(this.data.targetModes, TARGET_WORDS) },
      { key: "initial_cd_min_ms", label: "Minimum initial delay", type: "number", unit: "ms", hint: "Wait before the first use, picked between the two." },
      { key: "initial_cd_max_ms", label: "Maximum initial delay", type: "number", unit: "ms" },
      { key: "cooldown_min_ms", label: "Minimum cooldown", type: "number", unit: "ms", hint: "Wait between uses, picked between the two." },
      { key: "cooldown_max_ms", label: "Maximum cooldown", type: "number", unit: "ms" },
      { key: "chance_pct", label: "Chance", type: "number", unit: "%", hint: "How often it is cast when its turn comes." },
      { key: "max_range", label: "Max range", type: "number", unit: "yards", hint: "0 uses the spell's own range." },
      { key: "priority", label: "Priority", type: "number", hint: "When several are ready at once, the highest goes first." },
      { key: "interruptible", label: "Interruptible", type: "switch", wide: true },
    ];
  }

  private newDraft(): any {
    switch (this.kind) {
      case "paths":
        return { id: 0, map: this.data.maps[0] ?? "", loop: true, points: [] };
      case "linkGroups":
        return { id: 0, name: "New group" };
      case "pools":
        return { id: 0, max_active: 1, rare_chance_pct: 0, rare_template_id: 0 };
      default:
        return { id: 0, name: "New Creature", subname: "", level_min: 1, level_max: 1, rank: "normal", creature_type: "beast", stance: "aggressive", health_base: 50, health_per_level: 10, armor: 0, damage_min: 1, damage_max: 3, attack_speed_ms: 2000, ranged: false, move_speed_walk: 2.5, move_speed_run: 7, aggro_radius_override: null, assist_radius: 10, call_for_help_radius: 15, flee_at_hp_pct: 0, flee_duration_ms: 4000, leash_override: null, regen_ooc: true, xp_mult: 1, loot_table_id: 0, gold_min: 0, gold_max: 0, sprite_type: "none", sprite: "", sprite_head: "", sprite_helmet: "", sprite_shoulderguards: "", sprite_neck: "", sprite_hands: "", sprite_chest: "", sprite_feet: "", sprite_legs: "", sprite_weapon: "", scale: 1, flags: 0 };
    }
  }

  /** A new spawn for the selected creature; its map defaults to where the last one was. */
  private newSpawn(): any {
    const mine = this.mySpawns();
    const map = mine[mine.length - 1]?.map ?? this.data.maps[0] ?? "";
    return { id: 0, map, x: 0, y: 0, direction: "down", layer_policy: "per_layer", respawn_min_s: 120, respawn_max_s: 180, wander_radius: 0, movement_type: "idle", patrol_path_id: 0, link_group_id: 0, pool_id: 0 };
  }

  /** A new ability for the selected creature (bound to it when saved). */
  private newAbility(): any {
    return { id: 0, spell_id: this.data.spells[0]?.id ?? 0, trigger: "combat_timer", trigger_value: 0, initial_cd_min_ms: 3000, initial_cd_max_ms: 6000, cooldown_min_ms: 8000, cooldown_max_ms: 12000, chance_pct: 100, target_mode: "current", max_range: 30, interruptible: true, priority: 0 };
  }

  /** The selected creature's saved abilities, as an editable copy. */
  private loadAbilityDraft(): void {
    const id = this.draft?.id;
    this.abilityDraft = id && this.kind === "templates" ? clone(this.data.abilities.filter((a: any) => a.template_id === id)) : [];
    for (const index of [...this.openAbilities]) if (index >= this.abilityDraft.length) this.openAbilities.delete(index);
  }

  // ----------------------------------------------------------------- opening

  /** Anything on the current entry (creature fields, abilities, open spawn) not yet saved. */
  private get hasUnsaved(): boolean {
    return this.dirty || this.abilitiesDirty || this.spawnDirty;
  }

  /** True when the open entry can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.hasUnsaved || !this.draft || this.shell.discard(this.nameOf(this.kind, this.draft, true));
  }

  private open(draft: any, id: number | null, dirty: boolean): void {
    this.selectedId = id;
    this.draft = draft;
    this.dirty = dirty;
    this.abilitiesDirty = false;
    this.spawnDraft = null;
    this.spawnDirty = false;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.openAbilities.clear();
    this.loadAbilityDraft();
    // A few abilities are shown opened to their fields; a long list starts folded, a line each.
    if (this.abilityDraft.length <= 2) this.abilityDraft.forEach((_, index) => this.openAbilities.add(index));
    this.renderList();
    this.renderForm();
  }

  /** Nothing is open any more. */
  private close(): void {
    this.selectedId = null;
    this.draft = null;
    this.dirty = false;
    this.abilityDraft = [];
    this.abilitiesDirty = false;
    this.spawnDraft = null;
    this.spawnDirty = false;
    this.refused = false;
    this.clearProblems();
  }

  private async select(id: number): Promise<void> {
    if (!(await this.mayLeave())) return;
    // It may have been deleted while the question was open.
    const entry = this.collection.find((e: any) => e.id === id);
    if (entry) this.open(clone(entry), id, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    // A new creature starts on its General page, whichever creature page was open.
    this.tab = "general";
    this.open(this.newDraft(), 0, true);
    if (this.kind === "templates" || this.kind === "linkGroups") this.shell.focusField("name");
  }

  /**
   * Another kind was picked in the navigation. That drops the selection, so
   * unsaved changes get a Save / Discard / Stay question first.
   */
  private async requestKind(kind: KindId): Promise<void> {
    if (kind === this.kind) return;
    if (!this.hasUnsaved || !this.draft) return this.switchKind(kind);
    if (this.pending) return void toast("Still saving. Try again in a moment.", "warning");
    const leaving = this.draft;
    const choice = await this.shell.leave(this.nameOf(this.kind, leaving, true));
    // What was open may have been saved or closed while the question was up.
    if (choice === "stay") return;
    if (choice === "discard" || this.draft !== leaving || !this.hasUnsaved) return this.switchKind(kind);
    if (this.pending) return void toast("Still saving. Try again in a moment.", "warning");
    // Leave only once the server confirms; a failed save stays put.
    this.afterSaveKind = kind;
    this.save();
    // Nothing was actually sent (nothing to save): just go.
    if (!this.pending) {
      this.afterSaveKind = null;
      this.switchKind(kind);
    }
  }

  private switchKind(kind: KindId): void {
    this.kind = kind;
    this.tab = "general";
    this.close();
    this.shell.setKind(kind);
    this.shell.clearQuery();
    this.renderList();
    this.renderForm();
  }

  /** The pages of a creature all edit the same creature: moving between them keeps it and any unsaved edits. */
  private switchTab(tab: TabId): void {
    this.tab = tab;
    this.renderForm();
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const { kind } = this;
    const { noun } = this;
    const all = this.collection;
    const query = this.shell.query.toLowerCase();
    const found = all.filter((entry: any) => !query || this.haystack(kind, entry).toLowerCase().includes(query));
    const rows: ListRow[] = [];
    // An entry that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && !this.draft.id) {
      rows.push({
        id: "new", name: this.nameOf(kind, this.draft, true), note: "Not saved yet", selected: true,
        thumb: this.thumbOf(kind, this.draft), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const entry of found) {
      const name = this.nameOf(kind, entry);
      rows.push({
        id: String(entry.id), name, note: this.noteOf(kind, entry), selected: entry.id === this.selectedId,
        thumb: this.thumbOf(kind, entry),
        actions: [{ icon: "trash", label: `Delete ${name}`, danger: true, onClick: () => void this.deleteEntry(entry) }],
        onOpen: () => void this.select(entry.id),
      });
    }
    this.shell.setCounts({ templates: this.data.templates.length, paths: this.data.patrolPaths.length, linkGroups: this.data.linkGroups.length, pools: this.data.pools.length });
    this.shell.setList({
      rows,
      empty: query
        ? { icon: "search", title: `No ${noun}s match that search`, text: "Check the spelling, or search for less of it." }
        : { title: `There are no ${noun}s yet`, text: `Start the first one with New ${noun}.` },
      foot: query && found.length > 0 && found.length < all.length ? `${num(found.length)} of ${count(all.length, noun)} match` : "",
    });
  }

  /** The top bar and the tabs: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell, kind } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setTabs(null);
      return;
    }
    // The picture is only drawn again when it changes, not at every key typed.
    const key = `${kind}|${d.sprite_type}|${d.sprite}`;
    if (this.headThumb?.key !== key) this.headThumb = { key, node: this.thumbOf(kind, d, "lg") };
    const note = kind === "templates" ? `${d.id ? `Creature #${d.id} · ` : ""}${this.levels(d)} · ${this.breed(d)}`
      : kind === "linkGroups" ? (d.id ? `Link group #${d.id}` : "Link group")
      : this.noteOf(kind, d);
    shell.setRecord({ title: this.nameOf(kind, d, true), note, thumb: this.headThumb.node });

    const sending = this.pending && this.pending.draft === d ? this.pending.kind : null;
    const saving = sending === "template" || sending === "abilities" || sending === "spawn" || sending === "other";
    const state: RecordState = saving ? "saving" : this.refused ? "error" : !d.id ? "new" : this.hasUnsaved ? "unsaved" : "saved";
    shell.setState(state);
    shell.setActions({
      open: true, dirty: this.hasUnsaved || !d.id, busy: this.pending ? (saving ? "save" : "other") : null, canDelete: !!d.id,
      why: { delete: "It has not been saved, so there is nothing to delete" },
    });
    if (kind === "templates") shell.setTabs(this.tab, this.problemsByTab(), { abilities: this.abilityDraft.length, spawns: this.mySpawns().length });
    else shell.setTabs(null);
  }

  private renderForm(): void {
    this.chrome();
    this.live = [];
    if (!this.ready) return;
    if (!this.draft) {
      const { noun } = this;
      const box = this.shell.idle(`Pick a ${noun} from the list on the left, or start a new one.`, this.collection.length === 0 ? "Start the first one." : null);
      box.appendChild(button(`New ${noun}`, () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    switch (this.kind) {
      case "paths": return this.renderPath();
      case "linkGroups": return this.renderLinkGroup();
      case "pools": return this.renderPool();
      default: return this.renderCreature();
    }
  }

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /**
   * One form field. It edits `target[field.key]`; `path` is where its problems
   * are reported and how the page finds it again, and `part` is what a change
   * to it leaves unsaved.
   */
  private field(def: Field, target: any = this.draft, path: string = def.key, part: Part = "record"): HTMLElement {
    const wrap = this.fields.renderField({ ...def, path }, target, () => this.touched(path, wrap, part), { error: this.fieldErrors[path] });
    return wrap;
  }

  /** A field was edited: there is something to save, and its old problem no longer describes it. */
  private touched(path: string, wrap: HTMLElement, part: Part): void {
    if (part === "abilities") this.abilitiesDirty = true;
    else if (part === "spawn") this.spawnDirty = true;
    else this.dirty = true;
    this.refused = false;
    if (this.dropProblem(path)) {
      setFieldError(wrap, null);
      this.paintProblems();
    }
    this.chrome();
    for (const paint of this.live) paint();
  }

  // ---------------------------------------------------------------- creature

  private renderCreature(): void {
    // The two lists of records take the whole width; the creature's own fields have the creature at a glance beside them.
    const lists = this.tab === "abilities" || this.tab === "spawns";
    const { main, aside } = this.shell.page(`templates:${this.opened}:${this.tab}`, { aside: !lists });
    if (this.tab === "abilities") return this.renderAbilities(main);
    if (this.tab === "spawns") return this.renderSpawns(main);
    if (this.tab === "appearance") this.renderAppearance(main);
    else if (this.tab === "rewards") this.renderRewards(main);
    else this.renderGeneral(main);

    const glance = card(aside, "At a glance", "The creature as its fields describe it");
    const paint = () => this.paintGlance(glance.body);
    this.live.push(paint);
    paint();
  }

  private renderGeneral(main: HTMLElement): void {
    const fields = this.creatureFields();
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const taken = new Set<string>();
    const take = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((f): f is Field => !!f && !taken.has(f.key) && !!taken.add(f.key));
    const groups: Array<{ title: string; lead?: string; fields: Field[] }> = [
      // The two levels stay side by side whether the card is two fields wide or three.
      { title: "Identity", fields: take(["name", "subname", "rank", "creature_type", "level_min", "level_max"]) },
      { title: "Combat", fields: take(["stance", "health_base", "health_per_level", "armor", "ranged"]) },
      { title: "Movement", fields: take(["move_speed_walk", "move_speed_run", "leash_override"]) },
      { title: "Awareness", lead: "How it notices players and gets help", fields: take(["aggro_radius_override", "assist_radius", "call_for_help_radius"]) },
      { title: "Fleeing and recovery", fields: take(["flee_at_hp_pct", "flee_duration_ms", "regen_ooc"]) },
      { title: "Exceptions", lead: "Where it does not behave as creatures usually do", fields: take(["flags"]) },
    ];
    // A field added to creatureFields() but not to a group above still shows up.
    groups.push({ title: "Other", fields: fields.filter((f) => !taken.has(f.key)) });
    for (const group of groups) {
      if (group.fields.length === 0) continue;
      const grid = this.section(main, group.title, group.lead);
      for (const field of orderFields(group.fields)) grid.appendChild(this.field(field));
    }
  }

  private renderAppearance(main: HTMLElement): void {
    const type = String(this.draft.sprite_type ?? "none");
    // Nothing to pick from: the asset server did not answer the game server when the editor was opened. Said before the pickers it empties.
    const sheets = Object.values(this.data.spriteSheets ?? {}).some((list: any) => list?.length);
    if (type === "animated" && !sheets) main.appendChild(note("The asset server listed no sprite sheets, so the pickers only offer what this creature already uses. Its sheets are kept as they are.", "warning"));
    if (type === "static" && this.data.icons.length === 0) main.appendChild(note("The asset server listed no images, so there are none to pick from. The image this creature has is kept as it is.", "warning"));
    const grid = this.section(main, "Sprite", "How it is drawn in the world");
    for (const field of this.appearanceFields()) grid.appendChild(this.field(field));
    if (type === "animated") {
      const worn = this.section(main, "Worn layers", "Equipment drawn over the body, in the slots players wear it");
      for (const [key, label, slot] of WORN) worn.appendChild(this.field({ key, label, type: "sheet", slot, fallback: "image" }));
    }
  }

  private renderRewards(main: HTMLElement): void {
    const loot = this.section(main, "Experience and loot");
    for (const field of this.rewardFields()) loot.appendChild(this.field(field));
    const money = this.section(main, "Money", "Dropped as coins: each kill gives an amount picked between the two");
    money.classList.add("tl-fields-2");
    money.appendChild(this.field({ key: "gold_min", label: "Minimum money", type: "money" }));
    money.appendChild(this.field({ key: "gold_max", label: "Maximum money", type: "money" }));
  }

  /** The creature at a glance, beside the form: what it is, and what its numbers add up to in game. */
  private paintGlance(body: HTMLElement): void {
    const t = this.draft;
    if (!t) return;
    const box = el("div", "tl-preview");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.appendChild(el("span", "tl-preview-name ce-glance-title", this.nameOf("templates", t, true)));
    if (String(t.subname ?? "").trim()) said.appendChild(el("span", "tl-preview-kind ce-subname", `<${String(t.subname).trim()}>`));
    said.appendChild(el("span", "tl-preview-kind", `${this.levels(t)} · ${this.breed(t)} · ${words(t.stance || "aggressive")}`));
    head.append(this.thumbOf("templates", t, "xl"), said);
    box.appendChild(head);

    // What an animated creature wears, slot by slot.
    if (t.sprite_type === "animated") {
      const layers = el("div", "ce-layers");
      for (const [key, label, slot] of WORN) {
        const name = String(t[key] ?? "").trim();
        if (!name) continue;
        const sheet = (this.data.spriteSheets?.[slot] ?? []).find((s: any) => s.name === name);
        layers.appendChild(tooltip(thumb(sheet?.image, { fallback: "image" }), `${label}: ${name}`));
      }
      if (layers.childElementCount) box.appendChild(layers);
    }

    const line = (text: string, kind = "") => box.appendChild(el("div", "tl-preview-line" + (kind ? ` tl-preview-line-${kind}` : ""), text));
    const health = (level: number) => num(Math.round(Number(t.health_base) + Number(t.health_per_level) * (level - 1)) || 0);
    const min = Number(t.level_min) || 0;
    const max = Number(t.level_max) || 0;
    // A fixed-level creature has one health value; a range shows both ends.
    line(min === max ? `${health(min)} health at level ${num(min)}` : `${health(min)} health at level ${num(min)}, ${health(max)} at level ${num(max)}`);

    const abilities = this.abilityDraft.length;
    if (abilities === 0) line("No abilities: this creature cannot attack", "bad");
    else line(count(abilities, "ability", "abilities"));

    const spawns = this.mySpawns();
    const rareOf = t.id ? this.data.pools.filter((p: any) => p.rare_template_id === t.id).map((p: any) => `#${p.id}`) : [];
    if (spawns.length) {
      const maps = new Set(spawns.map((s: any) => s.map)).size;
      line(`${count(spawns.length, "spawn point")} on ${count(maps, "map")}`);
    } else if (rareOf.length) {
      line(`No spawn points of its own; the rare creature of spawn pool ${rareOf.join(", ")}`, "faint");
    } else {
      line("No spawn points: it never appears in the world", "faint");
    }

    const low = Number(t.gold_min) || 0;
    const high = Number(t.gold_max) || 0;
    // The amounts are written as coins, with the kit's coin marks.
    const least = coins(low);
    const most = coins(high);
    if (!least && !most) line("Drops no money", "faint");
    else if (!least) line("Drops up to ").appendChild(most!);
    else if (!most || low === high) line("Drops ").appendChild(least);
    else line("Drops ").append(least, " to ", most);
    const table = t.loot_table_id ? this.data.lootTables.find((l: any) => l.id === Number(t.loot_table_id)) : null;
    if (table) line(`Loot table: ${table.name}`);
    else line(t.loot_table_id ? `Loot table #${t.loot_table_id}, which does not exist` : "No loot table", t.loot_table_id ? "bad" : "faint");
    body.replaceChildren(box);
  }

  // --------------------------------------------------------------- abilities

  /** What an ability does, in a line: when, at whom, how often. */
  private abilityLine(ability: any): string {
    const trigger = String(ability.trigger);
    const parts: string[] = [];
    if (trigger === "hp_below") parts.push(`At ${num(Number(ability.trigger_value) || 0)}% health or less`);
    else parts.push(TRIGGER_WORDS[trigger] ?? words(trigger));
    parts.push(TARGET_WORDS[String(ability.target_mode)] ?? words(ability.target_mode));
    // The timers repeat; the others are used once per fight, or once.
    if (["combat_timer", "target_casting", "ooc_timer"].includes(trigger)) parts.push(`every ${span(secs(ability.cooldown_min_ms), secs(ability.cooldown_max_ms), "s")}`);
    const chance = Number(ability.chance_pct);
    if (Number.isFinite(chance) && chance !== 100) parts.push(`${short(chance)}% of the time`);
    return parts.join(" · ");
  }

  /**
   * The selected creature's abilities, one to a line that opens to its
   * fields, edited together and saved together with the Save button.
   */
  private renderAbilities(main: HTMLElement): void {
    const list = this.abilityDraft;
    const part = card(main, "Abilities", "What it casts in a fight, and when. They are saved together, with the creature.");
    if (list.length > 1) {
      const all = list.every((_, index) => this.openAbilities.has(index));
      part.tools.appendChild(button(all ? "Fold all" : "Open all", () => {
        this.openAbilities.clear();
        if (!all) list.forEach((_, index) => this.openAbilities.add(index));
        this.renderForm();
      }, { kind: "quiet", small: true, icon: all ? "chevronUp" : "chevronDown" }));
    }
    if (list.length === 0) empty(part.body, "wand", "No abilities", "This creature cannot attack. Add one below.");
    const cards = el("div", "tl-subcards");
    list.forEach((ability, index) => cards.appendChild(this.abilityCard(ability, index)));
    part.body.appendChild(cards);

    const add = button("Add ability", () => {
      list.push(this.newAbility());
      this.openAbilities.add(list.length - 1);
      this.abilitiesDirty = true;
      this.refused = false;
      this.renderForm();
      this.shell.reveal(`[data-keep="abilities.${list.length - 1}"]`);
    }, { icon: "plus", add: true });
    add.dataset.act = "ability-add";
    part.body.appendChild(add);
  }

  private abilityCard(ability: any, index: number): HTMLElement {
    const at = `abilities.${index}`;
    const open = this.openAbilities.has(index);
    const wrong = Object.keys(this.fieldErrors).filter((path) => path.startsWith(`${at}.`)).length;
    const spell = this.spellOf(ability.spell_id);
    const { root: box, fold, lead, tools, body } = subcard({
      title: spell?.name ?? `Spell #${ability.spell_id}`, thumb: thumb(spell?.icon, { fallback: "wand" }), open, wrong: wrong > 0,
      onToggle: () => {
        if (open) this.openAbilities.delete(index);
        else this.openAbilities.add(index);
        this.renderForm();
      },
    });
    fold!.dataset.act = "ability-toggle";
    fold!.dataset.index = String(index);
    fold!.dataset.keep = at;

    if (!spell) tools.appendChild(tag("Spell not found", "danger"));
    if (wrong) tools.appendChild(tag(count(wrong, "problem"), "danger"));
    const remove = iconButton("trash", `Remove ability ${index + 1}`, () => {
      this.abilityDraft.splice(index, 1);
      // The ones after it move up a place: what was open stays open, and problems reported by place no longer line up.
      this.openAbilities = new Set([...this.openAbilities].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)));
      for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("abilities.")) this.dropProblem(path);
      this.abilitiesDirty = true;
      this.refused = false;
      this.renderForm();
      this.paintProblems();
    }, { danger: true, size: 15 });
    remove.dataset.act = "ability-remove";
    remove.dataset.index = String(index);
    tools.appendChild(remove);

    const paint = () => (lead.textContent = this.abilityLine(ability));
    this.live.push(paint);
    paint();

    if (open) {
      const grid = el("div", "tl-fields");
      for (const field of orderFields(this.abilityFields())) grid.appendChild(this.field(field, ability, `${at}.${field.key}`, "abilities"));
      body.appendChild(grid);
    }
    return box;
  }

  // ------------------------------------------------------------------ spawns

  /** How a spawn point's creature moves, in a few words. */
  private movementLine(spawn: any): string {
    if (spawn.movement_type === "wander") return `Wanders ${num(Number(spawn.wander_radius) || 0)} yards`;
    if (spawn.movement_type === "patrol") return spawn.patrol_path_id ? `Patrols path #${spawn.patrol_path_id}` : "Patrols, with no path";
    return spawn.movement_type === "idle" ? "Stands still" : words(spawn.movement_type);
  }

  /** A table inside a card, edge to edge. Returns its body, to add rows to. */
  private table(parent: HTMLElement, columns: Array<[label: string, cls?: string]>): HTMLElement {
    const wrap = el("div", "ce-table-wrap");
    const table = el("table", "tl-table tl-table-plain ce-table");
    const row = el("tr");
    for (const [label, cls] of columns) {
      const th = el("th", cls ?? "", label);
      th.scope = "col";
      // The last column holds a button per row and has no heading to show.
      if (!label) th.setAttribute("aria-label", "Actions");
      row.appendChild(th);
    }
    const head = el("thead");
    head.appendChild(row);
    const body = el("tbody");
    table.append(head, body);
    wrap.appendChild(table);
    parent.appendChild(wrap);
    return body;
  }

  private cell(row: HTMLElement, text: string, cls = ""): HTMLTableCellElement {
    const td = el("td", cls, text);
    if (cls.includes("ce-cell-name")) td.title = text;
    row.appendChild(td);
    return td;
  }

  /**
   * The selected creature's spawn points: a table to pick from, and under it
   * the picked one's fields. The Save button stores it along with the creature.
   */
  private renderSpawns(main: HTMLElement): void {
    if (!this.draft.id) {
      const first = el("section", "tl-card");
      const box = empty(first, "pin", "Save the creature first", "Spawn points belong to a saved creature. Once it is saved, this is where you say where it appears in the world.");
      box.appendChild(button("Save creature", () => this.save(), { icon: "save", kind: "primary" }));
      main.appendChild(first);
      return;
    }
    const mine = this.mySpawns();
    const list = card(main, "Spawn points", mine.length ? "Where this creature appears in the world. Pick one to change it." : "Where this creature appears in the world");
    list.root.classList.add("tl-card-flush");
    const add = button("New spawn point", () => void this.addSpawn(), { icon: "plus", small: true });
    add.dataset.act = "spawn-new";
    list.tools.appendChild(add);

    const unsavedNew = this.spawnDraft && !this.spawnDraft.id;
    if (mine.length === 0 && !unsavedNew) {
      const rareOf = this.data.pools.filter((p: any) => p.rare_template_id === this.draft.id).map((p: any) => `#${p.id}`);
      empty(list.body, "pin", "No spawn points", rareOf.length
        ? `It has no spawn points of its own. It can still appear as the rare creature of spawn pool ${rareOf.join(", ")}.`
        : "This creature never appears in the world. Add a spawn point, then place it in the game window.");
    } else {
      const rows = this.table(list.body, [["Spawn point"], ["Map"], ["X", "tl-num"], ["Y", "tl-num"], ["Movement"], ["Respawn"], [""]]);
      if (unsavedNew) {
        const row = el("tr", "is-selected");
        this.cell(row, "New spawn point", "ce-cell-main").colSpan = 6;
        row.lastElementChild!.appendChild(el("span", "", " "));
        row.lastElementChild!.appendChild(tag("Not saved yet", "warning"));
        this.cell(row, "", "ce-cell-act");
        rows.appendChild(row);
      }
      for (const spawn of mine) rows.appendChild(this.spawnRow(spawn));
    }
    if (this.spawnDraft) this.renderSpawnDetail(main);
  }

  private spawnRow(spawn: any): HTMLElement {
    const here = this.spawnDraft?.id === spawn.id;
    const row = el("tr", here ? "is-selected" : "");
    row.tabIndex = 0;
    row.dataset.spawn = String(spawn.id);
    row.dataset.keep = `spawn-row.${spawn.id}`;
    if (here) row.setAttribute("aria-current", "true");
    this.cell(row, `#${spawn.id}`, "ce-cell-main");
    this.cell(row, String(spawn.map ?? ""), "ce-cell-name");
    this.cell(row, num(Number(spawn.x) || 0), "tl-num");
    this.cell(row, num(Number(spawn.y) || 0), "tl-num");
    this.cell(row, this.movementLine(spawn));
    this.cell(row, span(duration(Number(spawn.respawn_min_s) || 0), duration(Number(spawn.respawn_max_s) || 0), "").trim());
    const remove = iconButton("trash", `Delete spawn point #${spawn.id}`, (e) => {
      e.stopPropagation();
      void this.deleteSpawn(spawn);
    }, { danger: true, size: 15 });
    remove.dataset.act = "spawn-delete";
    remove.dataset.spawn = String(spawn.id);
    this.cell(row, "", "ce-cell-act").appendChild(remove);
    const open = () => void this.openSpawn(spawn);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      open();
    });
    return row;
  }

  private renderSpawnDetail(main: HTMLElement): void {
    const spawn = this.spawnDraft;
    const part = card(main, spawn.id ? `Spawn point #${spawn.id}` : "New spawn point");
    part.root.id = "ce-spawn-detail";
    const lead = el("p", "tl-card-lead");
    part.root.querySelector(".tl-card-words")!.appendChild(lead);
    const state = el("span", "");
    part.tools.appendChild(state);
    // Saved spawns are deleted from their row; a new one can only be discarded.
    if (!spawn.id) {
      const discard = button("Discard", () => {
        this.spawnDraft = null;
        this.spawnDirty = false;
        for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("spawn.")) this.dropProblem(path);
        this.renderForm();
        this.paintProblems();
      }, { kind: "quiet-danger", small: true, icon: "close" });
      discard.dataset.act = "spawn-discard";
      part.tools.appendChild(discard);
    }
    const paint = () => {
      lead.textContent = spawn.map ? `${spawn.map} · ${where(spawn.x, spawn.y)}` : "Not placed on a map yet";
      state.replaceChildren(!spawn.id ? pill("Not saved yet", "warning") : this.spawnDirty ? pill("Unsaved changes", "warning") : pill("Saved", "", "check"));
    };
    this.live.push(paint);
    paint();

    const fields = this.spawnFields();
    const groups = el("div", "ce-groups");
    const group = (title: string, defs: Field[]): HTMLElement => {
      const box = el("div", "tl-group");
      const grid = el("div", "tl-fields");
      for (const field of defs) grid.appendChild(this.field(field, spawn, `spawn.${field.key}`, "spawn"));
      box.append(el("div", "tl-group-title", title), grid);
      groups.appendChild(box);
      return grid;
    };

    // World placement sits with the position it sets.
    const place = button("Place in world", () => this.placeSpawn(), { icon: "target" });
    place.dataset.act = "spawn-place";
    const goto = button("Go to", () => this.goto(), { icon: "pin" });
    goto.dataset.act = "spawn-goto";
    goto.disabled = !spawn.id;
    if (!spawn.id) tooltip(goto, "Save the spawn point first");
    group("Where", fields.place).appendChild(this.world([
      { title: "Place it by clicking in the game", note: "Press the button, then click in the game window where it should stand. The map and the position above are set from that click. Escape in the game cancels.", control: place },
      {
        title: "Go to this spawn point",
        note: spawn.id ? "Moves your character to where it is saved, on its map." : "Once the spawn point is saved, this moves your character to it.",
        control: goto,
      },
    ]));
    group("Respawn", fields.respawn);
    group("Movement", fields.movement);
    group("Grouping", fields.grouping);
    part.body.appendChild(groups);
  }

  /** What is done in the game window, not in this one: each with what it will do there, and its button. */
  private world(rows: Array<{ title: string; note: string; control: HTMLElement }>): HTMLElement {
    const box = el("div", "ce-world");
    const head = el("div", "ce-world-title");
    head.append(icon("external", 12), el("span", "", "In the game window"));
    const list = el("div", "tl-rows");
    for (const entry of rows) {
      const row = el("div", "tl-row");
      const said = el("div", "tl-row-words");
      said.append(el("div", "tl-row-title", entry.title), el("div", "tl-row-note", entry.note));
      const controls = el("div", "tl-row-controls");
      controls.appendChild(entry.control);
      row.append(said, controls);
      list.appendChild(row);
    }
    box.append(head, list);
    return box;
  }

  /** True when the open spawn can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeaveSpawn(): Promise<boolean> {
    if (!this.spawnDirty || !this.spawnDraft) return true;
    const name = this.spawnDraft.id ? `spawn point #${this.spawnDraft.id}` : "the new spawn point";
    return this.shell.discard(name);
  }

  private showSpawn(spawn: any, dirty: boolean): void {
    this.spawnDraft = spawn;
    this.spawnDirty = dirty;
    for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("spawn.")) this.dropProblem(path);
    this.renderForm();
    this.paintProblems();
    this.shell.reveal("#ce-spawn-detail");
  }

  private async addSpawn(): Promise<void> {
    const creature = this.draft;
    if (!(await this.mayLeaveSpawn()) || this.draft !== creature) return;
    this.showSpawn(this.newSpawn(), true);
  }

  private async openSpawn(spawn: any): Promise<void> {
    if (this.spawnDraft?.id === spawn.id) return;
    const creature = this.draft;
    if (!(await this.mayLeaveSpawn()) || this.draft !== creature) return;
    this.showSpawn(clone(spawn), false);
  }

  // ----------------------------------------------------------- patrol paths

  private renderPath(): void {
    const { main, aside } = this.shell.page(`paths:${this.opened}`, { aside: true });
    const path = this.section(main, "Path");
    // One picker and one switch: half the card each is room enough for a long map name.
    path.classList.add("tl-fields-2");
    path.appendChild(this.field({ key: "map", label: "Map", type: "asset", noIcons: true, assets: this.mapAssets }));
    path.appendChild(this.field({ key: "loop", label: "Loop", type: "switch", wide: true, hint: "Walks from the last point back to the first. Otherwise it walks back and forth." }));
    this.renderPoints(main);
    if (this.draft.id) {
      this.usedBy(main, "Spawn points on this path", "Set on a creature's Spawns tab", this.data.spawns.filter((s: any) => s.patrol_path_id === this.draft.id), "No spawn point patrols along this path yet. Give it to one on a creature's Spawns tab.");
    }

    const shape = card(aside, "Shape", "The points in the order it walks them");
    const paint = () => this.paintShape(shape.body);
    this.live.push(paint);
    paint();
  }

  private renderPoints(main: HTMLElement): void {
    const points: any[] = (this.draft.points ||= []);
    const part = card(main, "Points", "Where it walks, in order, and how long it stops at each");
    part.root.classList.add("tl-card-flush");
    titleCount(part.root, points.length);

    const draw = button("Draw path", () => this.drawPath(), { icon: "pencil" });
    draw.dataset.act = "path-draw";
    part.body.appendChild(this.world([{
      title: "Draw it by clicking in the game",
      note: "Press the button, then click in the game window to add points after the ones below; they appear here as you click. Shift+click adds a point with a 2 second wait. The path takes the map you are standing on. Enter or Escape in the game finishes, and so does saving.",
      control: draw,
    }]));

    if (points.length === 0) return void empty(part.body, "route", "No points yet", "Press Draw path, then click in the game window. A path needs at least two.");
    const rows = this.table(part.body, [["Point"], ["X", "tl-num"], ["Y", "tl-num"], ["Wait here"], [""]]);
    points.forEach((p, i) => {
      const wrong = this.fieldErrors[`points.${i}`];
      const row = el("tr", wrong ? "has-error" : "");
      if (wrong) row.title = wrong;
      this.cell(row, `#${i + 1}`, "ce-cell-main");
      this.cell(row, num(Number(p.x) || 0), "tl-num");
      this.cell(row, num(Number(p.y) || 0), "tl-num");
      const wait = el("input", "tl-input tl-input-number");
      wait.type = "number";
      wait.min = "0";
      wait.step = "100";
      wait.value = String(p.wait_ms ?? 0);
      wait.setAttribute("aria-label", `How long it waits at point ${i + 1}, in milliseconds`);
      wait.addEventListener("input", () => {
        p.wait_ms = Number(wait.value) || 0;
        this.dirty = true;
        this.refused = false;
        this.chrome();
        for (const paint of this.live) paint();
      });
      const box = el("div", "tl-affix");
      box.dataset.field = `points.${i}.wait_ms`;
      wait.style.paddingRight = "calc(2ch + 18px)";
      box.append(wait, el("span", "tl-affix-unit", "ms"));
      this.cell(row, "").appendChild(box);
      const remove = iconButton("trash", `Remove point #${i + 1}`, () => {
        points.splice(i, 1);
        this.dirty = true;
        this.refused = false;
        this.dropPointProblems();
        this.renderForm();
        this.paintProblems();
      }, { danger: true, size: 15 });
      remove.dataset.act = "point-remove";
      remove.dataset.index = String(i);
      this.cell(row, "", "ce-cell-act").appendChild(remove);
      rows.appendChild(row);
    });
  }

  /** The open path as it lies on its map: a small drawing of its points, and what they add up to. */
  private paintShape(body: HTMLElement): void {
    const points: any[] = (this.draft?.points ?? []).filter((p: any) => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)));
    const loop = !!this.draft?.loop;
    const parts: HTMLElement[] = [];
    if (points.length === 0) parts.push(el("div", "ce-plot-empty", "No points to draw yet"));
    else parts.push(this.plot(points, loop) as unknown as HTMLElement);

    const legend = el("div", "ce-legend");
    const key = (cls: string, text: string) => {
      const item = el("span");
      item.append(el("i", cls), el("span", "", text));
      legend.appendChild(item);
    };
    key("is-first", "Start");
    if (points.some((p) => Number(p.wait_ms) > 0)) key("is-waiting", "Waits here");
    if (points.length) parts.push(legend);

    const waits = points.reduce((sum, p) => sum + (Number(p.wait_ms) || 0), 0);
    const lines: string[] = [];
    if (points.length < 2) lines.push("A path needs at least two points before it can be saved.");
    else lines.push(loop ? `${count(points.length, "point")}, walked round and round.` : `${count(points.length, "point")}, walked to the end and back.`);
    if (waits > 0) lines.push(`It stands still for ${secs(waits)} s in all on the way.`);
    const summary = el("div", "tl-summary");
    for (const line of lines) summary.appendChild(el("p", "", line));
    parts.push(summary);
    body.replaceChildren(...parts);
  }

  private plot(points: any[], loop: boolean): SVGSVGElement {
    const W = 268;
    const H = 200;
    const pad = 24;
    const xs = points.map((p) => Number(p.x));
    const ys = points.map((p) => Number(p.y));
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const [wide, tall] = [maxX - minX, maxY - minY];
    const fit = Math.min(wide ? (W - pad * 2) / wide : Infinity, tall ? (H - pad * 2) / tall : Infinity);
    const scale = Number.isFinite(fit) ? fit : 1;
    const at = (p: any): [number, number] => [
      Math.round(((W - wide * scale) / 2 + (Number(p.x) - minX) * scale) * 10) / 10,
      Math.round(((H - tall * scale) / 2 + (Number(p.y) - minY) * scale) * 10) / 10,
    ];
    const node = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `The path's ${points.length} points, drawn in the order they are walked` });
    node.classList.add("ce-plot");
    const line = svg("polyline", { points: points.map((p) => at(p).join(",")).join(" ") });
    line.classList.add("ce-plot-line");
    node.appendChild(line);
    if (loop && points.length > 2) {
      const [x1, y1] = at(points[points.length - 1]);
      const [x2, y2] = at(points[0]);
      const back = svg("line", { x1, y1, x2, y2 });
      back.classList.add("ce-plot-line", "ce-plot-back");
      node.appendChild(back);
    }
    // Every point is numbered while there is room for the numbers; a long path names its ends.
    const numbered = points.length <= 16;
    points.forEach((p, i) => {
      const [x, y] = at(p);
      const dot = svg("circle", { cx: x, cy: y, r: i === 0 ? 4.5 : 3.5 });
      dot.classList.add("ce-plot-point");
      if (i === 0) dot.classList.add("is-first");
      else if (Number(p.wait_ms) > 0) dot.classList.add("is-waiting");
      node.appendChild(dot);
      if (!numbered && i !== 0 && i !== points.length - 1) return;
      const label = svg("text", { x, y: y < 20 ? y + 16 : y - 8, "text-anchor": "middle" });
      label.classList.add("ce-plot-label");
      label.textContent = String(i + 1);
      node.appendChild(label);
    });
    return node;
  }

  // ------------------------------------------------ link groups, spawn pools

  private renderLinkGroup(): void {
    const { main } = this.shell.page(`linkGroups:${this.opened}`);
    const group = this.section(main, "Link group");
    group.classList.add("tl-fields-2");
    group.appendChild(this.field({ key: "name", label: "Name", type: "text", hint: "Spawns in the same link group are pulled together." }));
    if (this.draft.id) {
      this.usedBy(main, "Spawn points in this group", "Set on a creature's Spawns tab", this.data.spawns.filter((s: any) => s.link_group_id === this.draft.id), "No spawn point is in this group yet. Put one in on a creature's Spawns tab.");
    }
  }

  private renderPool(): void {
    const { main } = this.shell.page(`pools:${this.opened}`);
    const pool = this.section(main, "Spawn pool");
    const fields: Field[] = [
      { key: "max_active", label: "Max alive at once", type: "number", hint: "How many of the pool's spawn points can be alive together." },
      { key: "rare_chance_pct", label: "Rare chance", type: "number", unit: "%", hint: "Chance a respawn is the rare creature instead. Never two rares at once." },
      { key: "rare_template_id", label: "Rare creature", type: "asset", noIcons: true, assets: () => [{ value: 0, label: "None" }, ...this.data.templates.map((t: any) => ({ value: t.id, label: t.name }))] },
    ];
    for (const field of fields) pool.appendChild(this.field(field));
    if (this.draft.id) {
      this.usedBy(main, "Spawn points in this pool", "Set on a creature's Spawns tab", this.data.spawns.filter((s: any) => s.pool_id === this.draft.id), "No spawn point is in this pool yet. Put one in on a creature's Spawns tab.");
    }
  }

  /** The spawn points that refer to the open entry: to read, not to change here. */
  private usedBy(main: HTMLElement, title: string, lead: string, spawns: any[], none: string): void {
    const part = card(main, title, lead);
    part.root.classList.add("tl-card-flush");
    titleCount(part.root, spawns.length);
    if (spawns.length === 0) return void empty(part.body, "pin", "None yet", none);
    const rows = this.table(part.body, [["Creature"], ["Spawn point"], ["Map"], ["X", "tl-num"], ["Y", "tl-num"]]);
    for (const spawn of spawns) {
      const row = el("tr");
      this.cell(row, this.templateName(spawn.template_id), "ce-cell-main ce-cell-name");
      this.cell(row, `#${spawn.id}`);
      this.cell(row, String(spawn.map ?? ""), "ce-cell-name");
      this.cell(row, num(Number(spawn.x) || 0), "tl-num");
      this.cell(row, num(Number(spawn.y) || 0), "tl-num");
      rows.appendChild(row);
    }
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    if (this.kind === "templates") {
      // The creature's own fields go first when changed (a new creature needs
      // its id); abilities and the open spawn follow from the result handler.
      if (this.dirty || !this.draft.id) this.sendEntry("template");
      else if (!this.saveNextDirty()) toast("Nothing has changed since it was last saved.");
      return;
    }
    this.sendEntry("other");
  }

  /** Send the creature's next unsaved part (abilities, then the open spawn). */
  private saveNextDirty(): boolean {
    if (this.kind !== "templates" || !this.draft?.id) return false;
    if (this.abilitiesDirty) {
      this.sendAbilities();
      return true;
    }
    if (this.spawnDirty && this.spawnDraft) {
      this.sendSpawn();
      return true;
    }
    return false;
  }

  /** The server treats 0 as "no relation" for optional links. */
  private withNullLinks(entry: any): any {
    const payload = { ...entry };
    for (const key of ["patrol_path_id", "link_group_id", "pool_id", "loot_table_id", "rare_template_id"]) {
      if (payload[key] === 0) payload[key] = null;
    }
    return payload;
  }

  private sendEntry(kind: "template" | "other"): void {
    this.beginRequest(kind, `CREATURE_EDITOR_SAVE_${PACKET[this.kind]}`, this.withNullLinks(this.draft), this.nameOf(this.kind, this.draft, true));
  }

  /** The selected creature's whole ability list, saved as one. */
  private sendAbilities(): void {
    this.beginRequest("abilities", "CREATURE_EDITOR_SAVE_ABILITIES", { template_id: this.draft.id, abilities: this.abilityDraft }, this.nameOf("templates", this.draft, true));
  }

  /** The open spawn, always bound to the selected creature. */
  private sendSpawn(): void {
    this.beginRequest("spawn", "CREATURE_EDITOR_SAVE_SPAWN", { ...this.withNullLinks(this.spawnDraft), template_id: this.draft.id }, this.nameOf("templates", this.draft, true));
  }

  /** Delete a saved spawn from its row. Closes it if it is the open one. */
  private async deleteSpawn(spawn: any): Promise<void> {
    if (!spawn?.id) return;
    if (this.pending) return void toast("Still saving. Try again in a moment.", "warning");
    const creature = this.draft;
    const agreed = await this.shell.confirmDelete(`spawn point #${spawn.id}`, `${this.templateName(spawn.template_id)} no longer appears at ${where(spawn.x, spawn.y)} on ${spawn.map}: the creature standing there is removed from the world.`, "spawn point");
    // Another request may have started, or the creature been left, while the question was open.
    if (!agreed || this.pending || this.draft !== creature) return;
    if (this.spawnDraft?.id === spawn.id) {
      this.spawnDraft = null;
      this.spawnDirty = false;
      for (const path of Object.keys(this.fieldErrors)) if (path.startsWith("spawn.")) this.dropProblem(path);
      this.paintProblems();
    }
    this.beginRequest("spawnDelete", "CREATURE_EDITOR_DELETE_SPAWN", { id: spawn.id }, `spawn point #${spawn.id}`);
    this.renderForm();
  }

  /** What deleting an entry means for the game, said before it is done. */
  private deleteWords(kind: KindId, entry: any): string[] {
    const using = (key: string) => this.data.spawns.filter((s: any) => s[key] === entry.id).length;
    const kept = (n: number, left: string) => `${n === 1 ? "It is" : "They are"} kept, ${left}.`;
    let first: string;
    if (kind === "templates") {
      const spawns = using("template_id");
      first = spawns
        ? `Its abilities and its ${count(spawns, "spawn point")} are deleted with it, and its creatures are removed from the world.`
        : "Its abilities are deleted with it. It has no spawn points, so nothing in the world changes.";
    } else if (kind === "paths") {
      const spawns = using("patrol_path_id");
      first = spawns ? `${count(spawns, "spawn point patrols", "spawn points patrol")} along it. ${kept(spawns, "without a path to walk")}` : "No spawn point patrols along it.";
    } else if (kind === "linkGroups") {
      const spawns = using("link_group_id");
      first = spawns ? `${count(spawns, "spawn point is", "spawn points are")} in it. ${kept(spawns, "and no longer pulled together")}` : "No spawn point is in it.";
    } else {
      const spawns = using("pool_id");
      first = spawns ? `${count(spawns, "spawn point is", "spawn points are")} in it. ${kept(spawns, "outside any pool")}` : "No spawn point is in it.";
    }
    return [first, "This cannot be undone."];
  }

  /** Delete an entry, from its row or the top bar. Closes it if it is the open one. */
  private async deleteEntry(entry: any): Promise<void> {
    if (!entry?.id) return;
    if (this.pending) return void toast("Still saving. Try again in a moment.", "warning");
    const { kind } = this;
    const name = this.nameOf(kind, entry);
    const agreed = await this.shell.confirmDelete(name, this.deleteWords(kind, entry));
    // Another request may have started, or another kind been opened, while the question was open.
    if (!agreed || this.pending || this.kind !== kind) return;
    if (this.selectedId === entry.id) this.close();
    this.beginRequest("delete", `CREATURE_EDITOR_DELETE_${PACKET[kind]}`, { id: entry.id }, name);
    this.renderList();
    this.renderForm();
  }

  private beginRequest(kind: SaveKind, packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name, draft: this.draft, spawn: this.spawnDraft };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (e.g. permissions): don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      const saving = kind !== "delete" && kind !== "spawnDelete";
      const here = this.pending.draft === this.draft;
      this.endRequest();
      this.afterSaveKind = null;
      if (saving && here) this.refused = true;
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

  // ----------------------------------------------------- in the game window

  private placeSpawn(): void {
    if (this.kind !== "templates" || !this.spawnDraft) return;
    this.shell.send({ type: "placeSpawn" });
    toast("Click in the game window to place the spawn point.");
  }

  private drawPath(): void {
    if (this.kind !== "paths" || !this.draft) return;
    this.shell.send({ type: "drawPath", points: this.draft.points || [] });
    toast("Click in the game window to add points. Enter or Escape there finishes.");
  }

  private goto(): void {
    if (this.kind !== "templates" || !this.spawnDraft?.id) return;
    this.shell.send({ type: "request", packet: "CREATURE_EDITOR_ACTION", data: { action: "goto", spawnId: this.spawnDraft.id } });
  }
}

new CreatureEditorBridge();
