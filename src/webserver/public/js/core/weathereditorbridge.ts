// Weather editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the weather editor's own: its fields, the server's rules repeated so
// a slip is caught before the round trip, what the game draws for a weather of
// each name, and its conversation with the server. There are few weathers, so
// the list is held whole here: every answer of the server carries it afresh.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, setFieldError, type Field } from "./toolfields.js";
import { button, card, count, el, listed, note, noticeDialog, shown, tag, thumb, toast, type IconName } from "./toolkit.js";

/** Limits of a numeric field, as the server sends and enforces them. */
interface NumberRule {
  label: string;
  min: number;
  max: number;
}

interface Weather {
  name: string;
  temperature: number | null;
  humidity: number | null;
  wind_speed: number | null;
  wind_direction: string;
  precipitation: number | null;
  ambience: number | null;
}

/** A world with the weather it is set to and the one it shows: the same, but for a world on "random". */
interface WorldWeather {
  name: string;
  weather: string;
  showing: string;
}

/** The same rule the server applies to a new weather's name. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const NUMBER_KEYS = ["temperature", "humidity", "wind_speed", "precipitation", "ambience"] as const;

/**
 * What the game draws for a weather, which it picks by the weather's name
 * (weather.ts, ambience.ts and the WEATHER cases of socket.ts in the game
 * client): how much falls is its precipitation, and rain falls as snow below
 * 32 degrees. A name that is not here draws no rain and no snow.
 */
const DRAWN: Record<string, { icon: IconName; short: string; long: string; ambience: boolean }> = {
  rainy: { icon: "cloud", short: "Rain", long: "Draws rain as heavy as Precipitation says, with splashes where it lands. Below 32 degrees it falls as snow.", ambience: false },
  thunderstorm: { icon: "bolt", short: "Rain, lightning, dark sky", long: "Draws rain as heavy as Precipitation says (snow below 32 degrees) and lightning strikes, turns shadows off and darkens the scene as much as Ambience says.", ambience: true },
  snowy: { icon: "sparkle", short: "Snow", long: "Draws snow as heavy as Precipitation says, which melts where it lands.", ambience: false },
  darkness: { icon: "moon", short: "Near-black scene", long: "Darkens the scene as much as Ambience says, with no sun and no shadows: lights and glowing particles carry it.", ambience: true },};

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The server's own check, repeated here so a slip is caught before the round trip. */
function numberError(value: unknown, rule: NumberRule): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${rule.label} must be a number.`;
  if (value < rule.min || value > rule.max) return `${rule.label} must be between ${rule.min} and ${rule.max}.`;
  return null;
}

class WeatherEditorBridge {
  private data: {
    weathers: Weather[]; worlds: WorldWeather[]; directions: string[]; numbers: Record<string, NumberRule>;
    nameMax: number; reserved: string[]; protected: string[]; fallback: string;
  } = {
    weathers: [], worlds: [], directions: ["none", "left", "right", "up", "down"], numbers: {},
    nameMax: 45, reserved: ["random", "none"], protected: ["clear"], fallback: "clear",
  };
  /** The server's first answer has arrived. */
  private ready = false;
  /** Name of the weather being edited, or null for a new one. */
  private originalName: string | null = null;
  private draft: Weather | null = null;
  /** Counts the records opened, so the page knows a redraw from a different record. */
  private opened = 0;
  private dirty = false;
  /** The last save was refused and nothing has been changed since. */
  private refused = false;
  /** Problems by field, from this window's own checks or the server's. */
  private fieldErrors: Record<string, string> = {};
  /** What the server refused that is not about one field. */
  private otherProblems: string[] = [];

  /** The request waiting for its result; a second one waits too. */
  private pending: { kind: "save" | "delete"; packet: string; name: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** The parts of the page that follow the fields as they are typed in. */
  private summaryEl: HTMLElement | null = null;
  private drawnEl: HTMLElement | null = null;
  private headThumb: { key: string; node: HTMLElement } | null = null;

  private shell = new EditorShell({
    tool: "Weather Editor", noun: "weather", plural: "weathers", icon: "cloud",
    // The list is held whole in this window: a search only filters it.
    liveSearch: true,
    onSearch: () => this.renderList(),
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicate(this.openRow()),
    onDelete: () => void this.deleteEntry(this.openRow()),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.askForList());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  /** What the game window asks for when it opens the editor: every weather, where each shows, and the rules. */
  private askForList(): void {
    this.shell.send({ type: "request", packet: "WEATHER_EDITOR_LIST", data: null });
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.adopt(msg.data);
      this.renderList();
      this.renderForm();
    } else if (msg.type === "result") {
      // Every answer to a change, made or refused, carries the weathers as they then stand.
      const mine = !!this.pending && (!msg.action || msg.action === this.pending.packet);
      if (!mine) {
        if (msg.data) this.adopt(msg.data);
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        this.renderList();
        if (this.ready) this.renderForm();
        return;
      }
      const { kind, name } = this.pending!;
      this.endRequest();
      if (kind === "save") this.onSaveResult(msg);
      else this.onDeleteResult(msg, name);
      this.renderList();
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed a weather. The list shows it as it is now.`);
      this.askForList();
    }
  }

  /**
   * Takes the server's weathers as the list, and follows the open weather as
   * the server now holds it, unless it has changes of this window's own.
   */
  private adopt(data: any, follow = true): void {
    if (!data || typeof data !== "object") return;
    this.data = { ...this.data, ...data };
    if (!Array.isArray(this.data.weathers)) this.data.weathers = [];
    if (!Array.isArray(this.data.worlds)) this.data.worlds = [];
    this.ready = true;
    this.shell.arrived();
    this.shell.setCount(this.data.weathers.length);
    if (!follow || this.originalName === null || this.dirty || this.pending) return;
    const now = this.find(this.originalName);
    if (now) this.draft = clone(now);
    else {
      // Deleted from another editor.
      toast(`${this.originalName} was deleted in another editor, so it has been closed here.`);
      this.draft = null;
      this.originalName = null;
      this.refused = false;
      this.clearProblems();
    }
  }

  private onSaveResult(msg: any): void {
    if (!msg.ok) {
      this.adopt(msg.data, false);
      this.refused = true;
      this.fieldErrors = msg.fields && typeof msg.fields === "object" ? msg.fields : {};
      this.showProblems(msg.errors?.length ? msg.errors : ["The server refused the save."]);
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
    if (msg.name) this.originalName = msg.name;
    this.adopt(msg.data);
    // What came of it besides: the worlds that were shown the change, or that none shows it.
    toast([`Saved ${this.originalName ?? "the weather"}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  private onDeleteResult(msg: any, asked: string): void {
    if (!msg.ok) {
      // The open weather's own edits are left alone; only the list follows.
      this.adopt(msg.data, false);
      const lines: string[] = msg.errors?.length ? msg.errors : ["The server refused to delete it."];
      void noticeDialog(`${asked} was not deleted`, [...lines, ...(msg.notes ?? [])]);
      this.renderForm();
      return;
    }
    // The reply names the deleted weather: never adopt it as the open one, and
    // leave another open weather's unsaved edits alone.
    if (msg.name && msg.name === this.originalName) {
      this.draft = null;
      this.originalName = null;
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
    }
    this.adopt(msg.data);
    toast([`Deleted ${msg.name ?? asked}.`, ...(msg.notes ?? [])].join("\n"));
    this.renderForm();
  }

  /**
   * Something the server refused that no request here was waiting for. Before
   * its first answer, that is the editor itself being refused: the page says
   * so. After, it is said on the open weather, or in the corner.
   */
  private report(lines: string[]): void {
    if (!this.ready) this.shell.refused(lines, () => this.askForList());
    else if (this.draft) {
      this.otherProblems = lines;
      this.shell.setProblems(this.problemLines());
    } else toast(lines.join("\n"), "error");
  }

  // ------------------------------------------------------------------ rules

  private find(name: string | null): Weather | undefined {
    return name === null ? undefined : this.data.weathers.find((w) => w.name === name);
  }

  /** Cannot be deleted: the server falls back to it by name. */
  private isProtected(name: unknown): boolean {
    return this.data.protected.includes(lower(name));
  }

  /** The worlds that show a weather now: those set to it, and those on "random" that settled on it. */
  private worldsShowing(name: unknown): WorldWeather[] {
    const wanted = String(name ?? "");
    return wanted ? this.data.worlds.filter((w) => w.showing === wanted) : [];
  }

  /** The worlds showing a weather, in words: "main", "wilds (random)". */
  private worldNames(name: unknown): string[] {
    return this.worldsShowing(name).map((w) => (w.weather === "random" ? `${w.name} (random)` : w.name));
  }

  /** The server's checks, run here first. The server runs them again and is the one that counts. */
  private validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const d = this.draft!;
    if (this.originalName === null) {
      const name = String(d.name ?? "").trim();
      const max = this.data.nameMax;
      if (!name) errors.name = "Name is required.";
      else if (name.length > max) errors.name = `Name must be ${max} characters or fewer.`;
      else if (!NAME_PATTERN.test(name)) errors.name = "Name can hold lower case letters, digits, underscores and hyphens, and starts with a letter or a digit.";
      else if (this.data.reserved.includes(name)) errors.name = `"${name}" is a word of the /weather command, not a weather.`;
      else if (this.data.weathers.some((w) => lower(w.name) === name)) errors.name = "A weather with that name already exists.";
    }
    if (!this.data.directions.includes(d.wind_direction)) errors.wind_direction = `Wind direction must be one of ${listed(this.data.directions)}.`;
    for (const key of NUMBER_KEYS) {
      const rule = this.data.numbers[key];
      const message = rule ? numberError(d[key], rule) : null;
      if (message) errors[key] = message;
    }
    return errors;
  }

  /** The summary at the top of the page: how many fields are marked, or what the server said that is not about one field. */
  private problemLines(): string[] {
    const fields = Object.keys(this.fieldErrors);
    return fields.length === 0 ? this.otherProblems : [`${count(fields.length, "field needs", "fields need")} fixing.`];
  }

  /** Nothing is wrong any more: a save went through, or another weather is opened. */
  private clearProblems(): void {
    this.fieldErrors = {};
    this.otherProblems = [];
    this.shell.setProblems([]);
  }

  /** A save was refused, here or by the server: say so at the top. */
  private showProblems(serverErrors: string[] = []): void {
    this.otherProblems = serverErrors;
    this.shell.setProblems(this.problemLines());
    this.renderForm();
  }

  private blank(): Weather {
    return { name: "new_weather", temperature: 68, humidity: 30, wind_speed: 0, wind_direction: "none", precipitation: 0, ambience: 0 };
  }

  /** The row of the open weather as the list holds it, or the open weather itself while it is not saved. */
  private openRow(): Weather | null {
    return this.find(this.originalName) ?? this.draft;
  }

  // ---------------------------------------------------------------- in words

  private drawnFor(name: unknown): (typeof DRAWN)[string] | undefined {
    const key = String(name ?? "").trim();
    return Object.hasOwn(DRAWN, key) ? DRAWN[key] : undefined;
  }

  private iconOf(weather: Weather | null): IconName {
    return this.drawnFor(weather?.name)?.icon ?? "cloud";
  }

  /** Whether the wind blows: it needs a direction and a speed above 0. */
  private blows(weather: Weather): boolean {
    return weather.wind_direction !== "none" && this.data.directions.includes(weather.wind_direction) && (Number(weather.wind_speed) || 0) > 0;
  }

  /** A weather in a few words, under its name in the list: what is drawn for it, and its wind. */
  private kindOf(weather: Weather): string {
    const drawn = this.drawnFor(weather.name)?.short ?? "No rain or snow";
    return this.blows(weather) ? `${drawn} · wind ${weather.wind_speed} ${weather.wind_direction}` : `${drawn} · no wind`;
  }

  /** What the game draws for the name as it stands, under the name field. */
  private drawnLine(): string {
    const name = String(this.draft?.name ?? "").trim();
    const drawn = this.drawnFor(name);
    if (drawn) return `A weather named ${name}. ${drawn.long}`;
    return name
      ? `A weather named ${name} draws no rain, no snow and no darkening, whatever its numbers say. It only carries its wind.`
      : "A weather with no name yet.";
  }

  /** What the fields add up to in the game, in plain words: one sentence to a line. */
  private summary(): string[] {
    const d = this.draft!;
    const drawn = this.drawnFor(d.name);
    const lines = [drawn ? drawn.long : "Draws no rain, no snow and no darkening: the game only does that for the names rainy, thunderstorm, snowy and darkness."];

    const speed = Number(d.wind_speed) || 0;
    if (this.blows(d)) {
      const sideways = d.wind_direction === "left" || d.wind_direction === "right";
      lines.push(
        `Wind of ${speed} blowing ${d.wind_direction}: wind streaks cross the screen that way` +
          (sideways
            ? ", and rain, snow and particles affected by weather are pushed with it."
            : ". Rain, snow and particles are only pushed left or right, so this wind does not move them.")
      );
    } else if (speed > 0) {
      lines.push(`A wind speed of ${speed} with no direction: no wind streaks, and rain and particles are not pushed. Pick a direction.`);
    } else if (d.wind_direction !== "none") {
      lines.push("A direction with a wind speed of 0: still air. Wind streaks need a speed above 0.");
    } else {
      lines.push("No wind: no wind streaks, and rain falls straight.");
    }

    const ambience = Number(d.ambience) || 0;
    if (drawn?.ambience) lines.push(`Ambience ${ambience}: the scene is darkened by ${Math.round(Math.min(1, Math.max(0, ambience)) * 100)}%.`);
    else if (ambience > 0) lines.push(`Ambience ${ambience} is stored, but only thunderstorm and darkness use it.`);

    const saved = this.originalName !== null;
    const worlds = saved ? this.worldNames(this.originalName) : [];
    if (worlds.length > 0) lines.push(`Showing now on ${listed(worlds)}. A save changes it there at once, for every player.`);
    else if (saved) lines.push(`No world shows it now. /weather ${this.originalName} sets the world you are in to it.`);
    else lines.push("Not saved yet. Once saved, /weather with its name sets the world you are in to it.");
    return lines;
  }

  // ------------------------------------------------------------------ render

  private thumbOf(weather: Weather | null, size: "" | "lg" | "xl" = ""): HTMLElement {
    return thumb(null, { size, fallback: this.iconOf(weather) });
  }

  private renderList(): void {
    if (!this.ready) return;
    const wanted = lower(this.shell.query);
    const rows: ListRow[] = [];
    // A weather that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.originalName === null) {
      rows.push({
        id: "\u0000new", name: String(this.draft.name || "New weather"), note: "Not saved yet", selected: true,
        thumb: this.thumbOf(this.draft), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const weather of this.data.weathers) {
      if (wanted && !lower(weather.name).includes(wanted)) continue;
      const worlds = this.worldsShowing(weather.name);
      const locked = this.isProtected(weather.name);
      rows.push({
        id: weather.name, name: weather.name, note: this.kindOf(weather), selected: weather.name === this.originalName,
        thumb: this.thumbOf(weather),
        tags: [
          ...(worlds.length > 0 ? [tag(worlds.length === 1 ? worlds[0].name : count(worlds.length, "world"), "", "globe")] : []),
          ...(locked ? [tag("Kept", "muted", "lock")] : []),
        ],
        actions: [
          { icon: "copy", label: `Duplicate ${weather.name}`, onClick: () => void this.duplicate(weather) },
          // The server falls back to it by name: there is no deleting it.
          ...(locked ? [] : [{ icon: "trash" as const, label: `Delete ${weather.name}`, danger: true, onClick: () => void this.deleteEntry(weather) }]),
        ],
        onOpen: () => void this.select(weather.name),
      });
    }
    this.shell.setList({
      rows,
      empty: wanted
        ? { icon: "search", title: "No weathers match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "There are no weathers yet", text: "Start the first one with New weather." },
    });
  }

  /** The top bar and the banner: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setBanner(null);
      return;
    }
    const saved = this.originalName !== null;
    const locked = saved && this.isProtected(this.originalName);
    // The picture is only drawn again when it changes, not at every key typed.
    const key = this.iconOf(d);
    if (this.headThumb?.key !== key) this.headThumb = { key, node: this.thumbOf(d, "lg") };
    shell.setRecord({ title: this.titleOf(d), note: "Weather", thumb: this.headThumb.node });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);

    const deleting = this.pending?.kind === "delete" && this.pending.name === this.originalName;
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (this.pending.kind === "save" ? "save" : deleting ? "delete" : "other") : null,
      canSave: true, canDuplicate: saved, canDelete: saved && !locked,
      why: {
        duplicate: "Save it first, then it can be copied",
        delete: locked
          ? `${this.originalName} cannot be deleted: it is what a world with no weather shows, and what a world falls back to`
          : "It has not been saved, so there is nothing to delete",
      },
    });
    const worlds = saved ? this.worldNames(this.originalName) : [];
    shell.setBanner(worlds.length > 0
      ? { tone: "info", icon: "globe", text: `Showing now on ${listed(worlds)}. A save changes it there at once, for every player.` }
      : null);
  }

  /** What the open weather is called while its name field may be empty. */
  private titleOf(weather: Weather): string {
    return String(weather?.name ?? "").trim() || (this.originalName === null ? "New weather" : "Unnamed weather");
  }

  private renderForm(): void {
    this.chrome();
    this.summaryEl = this.drawnEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Pick a weather from the list on the left, or start a new one.", this.data.weathers.length === 0 ? "Start the first one." : null);
      box.appendChild(button("New weather", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}`, { aside: true });
    const existing = this.originalName !== null;

    const naming = this.section(main, "Weather", "Its name decides what the game draws");
    const name = this.field(
      {
        key: "name", label: "Name", type: "text", maxLength: this.data.nameMax, wide: true,
        hint: existing
          ? "Fixed once saved: worlds refer to the weather by it, and the game picks what to draw by it. Duplicate the weather to make a renamed copy."
          : "Lower case letters, digits, underscores and hyphens. Must be unique, and cannot be changed after the first save: worlds refer to the weather by it.",
      },
      "name"
    );
    if (existing) (name.querySelector("input") as HTMLInputElement).disabled = true;
    naming.appendChild(name);
    // Said where the name is typed, not left to be found out: the numbers below draw nothing on their own.
    const drawn = note([
      "The game picks what it draws by this name. The numbers below only shape it.",
      "rainy and thunderstorm draw rain, as heavy as Precipitation says, and snow instead below 32 degrees. snowy draws snow. thunderstorm and darkness darken the scene, by as much as Ambience says. thunderstorm also has lightning.",
      "Any other name draws no rain, no snow and no darkening: it only carries its wind. The real weather (/weather weather_api) is not a weather of this list.",
    ]);
    drawn.classList.add("tl-field-wide");
    this.drawnEl = el("div", "tl-note-title");
    drawn.querySelector(".tl-note-words")?.prepend(this.drawnEl);
    naming.appendChild(drawn);

    const wind = this.section(main, "Wind", "Draws wind streaks, slants rain and snow, and pushes particles that are affected by weather");
    wind.appendChild(this.number("wind_speed", "Wind speed", "0 is still air. The seeded thunderstorm blows at 25. Gusts add up to half as much again."));
    wind.appendChild(this.field(
      {
        key: "wind_direction", label: "Wind direction", type: "segmented", asText: true,
        options: () => this.data.directions.map((d) => ({ value: d, label: d.charAt(0).toUpperCase() + d.slice(1) })),
        hint: "Wind streaks need a direction and a speed above 0, and follow all four. Rain, snow and particles are only pushed left or right.",
      },
      "wind_direction"
    ));

    const sky = this.section(main, "Sky");
    sky.appendChild(this.number("ambience", "Ambience", "How much thunderstorm and darkness darken the scene: 0 not at all, 1 fully black. No other name uses it.", 0.05));

    const climate = this.section(main, "Climate", "Temperature and precipitation shape the rain and snow of the names that draw them. Humidity is only stored");
    climate.appendChild(this.number("temperature", "Temperature", "Degrees Fahrenheit: clear is 68. Below 32, rain falls as snow."));
    climate.appendChild(this.number("humidity", "Humidity", "Percent of moisture in the air.", 1, "%"));
    climate.appendChild(this.number("precipitation", "Precipitation", "How much rain or snow falls: 80 is the seeded thunderstorm, 100 a quarter more, and never less than a drizzle. It does not make rain fall on its own: the name does.", 1, "%"));

    // What the fields add up to in the game, beside the form.
    const { body } = card(aside, "In plain words", "What this weather does in the game");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.append(el("span", "tl-preview-name", this.titleOf(this.draft)), el("span", "tl-preview-kind", "Weather"));
    head.append(this.thumbOf(this.draft, "xl"), said);
    this.summaryEl = el("div", "tl-summary");
    body.append(head, this.summaryEl);
    this.paintLive();
  }

  /** The parts that follow the fields as they change: what the name draws, and the summary beside the form. */
  private paintLive(): void {
    if (!this.draft) return;
    if (this.drawnEl) this.drawnEl.textContent = this.drawnLine();
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary().map((line) => el("p", "", line)));
  }

  // ------------------------------------------------------------------ fields

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /** One form field editing the open weather, with any problem reported for it shown beneath. */
  private field(field: Field, path: string): HTMLElement {
    const wrap = this.fields.renderField({ ...field, path }, this.draft, () => this.touched(path, wrap), { error: this.fieldErrors[path] });
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
    // The unsaved weather's row carries its name.
    if (path === "name") this.renderList();
  }

  /** A numeric column, with the server's limits for it. */
  private number(key: string, label: string, hint: string, step = 1, unit?: string): HTMLElement {
    const rule = this.data.numbers[key];
    const range = rule ? ` From ${rule.min} to ${rule.max}.` : "";
    return this.field({ key, label, type: "number", hint: hint + range, unit, min: rule?.min, max: rule?.max, step }, key);
  }

  // ----------------------------------------------------------------- opening

  /** True when the open weather can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.titleOf(this.draft));
  }

  private open(draft: Weather, originalName: string | null, dirty: boolean): void {
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
    if (name === this.originalName || !(await this.mayLeave())) return;
    const weather = this.find(name);
    if (!weather) return;
    this.open(clone(weather), name, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  /** Start a new, unsaved weather copied from a list row. This is how a weather gets a new name. */
  private async duplicate(weather: Weather | null): Promise<void> {
    if (!weather || !(await this.mayLeave())) return;
    const copy = clone(weather);
    copy.name = `${copy.name}_copy`.slice(0, this.data.nameMax);
    this.open(copy, null, true);
    // The copy needs a name of its own before it can be saved.
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    this.fieldErrors = this.validate();
    if (Object.keys(this.fieldErrors).length > 0) {
      this.refused = true;
      this.showProblems();
      return;
    }
    const d = this.draft;
    this.beginRequest("save", "WEATHER_EDITOR_SAVE", {
      name: String(d.name ?? "").trim(), temperature: d.temperature, humidity: d.humidity, wind_speed: d.wind_speed,
      wind_direction: d.wind_direction, precipitation: d.precipitation, ambience: d.ambience, originalName: this.originalName,
    }, String(d.name ?? ""));
  }

  /** Delete a weather, from its list row or the top bar. The worlds that use it fall back, and the question says which. */
  private async deleteEntry(weather: Weather | null): Promise<void> {
    const name = String(weather?.name ?? "");
    if (!name || this.pending || !this.find(name) || this.isProtected(name)) return;
    const fallback = this.data.fallback;
    const worlds = this.worldNames(name);
    const drawn = this.drawnFor(name);
    const agreed = await this.shell.confirmDelete(name, [
      "This cannot be undone.",
      worlds.length > 0
        ? `${listed(worlds)} ${worlds.length === 1 ? "shows" : "show"} it now. Every world that uses it is set to ${fallback}, and a world on random that settled on it shows ${fallback} until its weather next changes. The players there see it at once.`
        : `No world shows it now. A world that is set to it is set to ${fallback}.`,
      ...(drawn ? [`The game draws something of its own for the name ${name} (${lower(drawn.short)}). A new weather of that name would get it again.`] : []),
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "WEATHER_EDITOR_DELETE", { name }, name);
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server drops the packet outright:
    // don't leave the buttons blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      if (kind === "save") this.refused = true;
      this.chrome();
      toast("The server did not answer in time, so nothing was confirmed.", "error");
      // What the server holds now says whether it was done.
      this.askForList();
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

new WeatherEditorBridge();
