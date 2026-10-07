// Item editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the item editor's own: its fields, its rules and its conversation
// with the server.
import { qualityOf } from "./itemframe.js";
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { FieldRenderer, coinWords, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, note, noticeDialog, shown, tag, thumb, toast, words } from "./toolkit.js";

// Fallbacks so the dropdowns are never empty, even if the server's option lists
// arrive late or an item carries a value that is no longer offered.
const DEFAULT_TYPES = ["consumable", "equipment", "material", "quest", "miscellaneous"];
const DEFAULT_QUALITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const DEFAULT_SLOTS = [
  "helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves",
  "belt", "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "bag",
];

const TABS = [
  { id: "general", label: "General" },
  { id: "equipment", label: "Equipment" },
  { id: "stats", label: "Stats" },
];

/** The stats an item can give, in the order they are listed, with what each is counted in. */
const STATS: Array<[key: string, label: string, unit?: string]> = [
  ["stat_armor", "Armor"],
  ["stat_damage", "Damage"],
  ["stat_health", "Health"],
  ["stat_stamina", "Stamina"],
  ["stat_critical_chance", "Critical chance", "%"],
  ["stat_critical_damage", "Critical damage", "%"],
  ["stat_avoidance", "Avoidance"],
];

/**
 * The server answers a refused save in sentences, not by field. Each of its
 * sentences is about one field: this says which, so that field can be marked
 * and its tab pointed at. A sentence that matches nothing is still shown at
 * the top of the page.
 */
const PROBLEM_FIELDS: Array<[RegExp, string]> = [
  [/^(Name |An item with that name)/, "name"],
  [/^Type /, "type"],
  [/^Quality /, "quality"],
  [/^Description /, "description"],
  [/^Equipable items need/, "equipment_slot"],
  [/^Only equipment can be equipable/, "equipable"],
  [/^Level requirement /, "level_requirement"],
  [/^Bag slots /, "bag_slots"],
  [/^Minimum damage /, "damage_min"],
  [/^Maximum damage /, "damage_max"],
  [/^Attack speed /, "attack_speed_ms"],
  [/^Weapon damage and speed only apply/, "equipment_slot"],
  [/^Vendor sell price /, "sell_price"],
  [/^(What a consumable restores|A consumable must restore)/, "restore_health"],
  [/is already the home item/, "teleports_home"],
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class ItemEditorBridge {
  private data: any = { types: [], qualities: [], slots: [], icons: [], itemCount: 0 };
  /** The server's first answer has arrived. */
  private ready = false;
  private tab = "general";
  /** Name of the item being edited, or null for a new one. */
  private originalName: string | null = null;
  private draft: any = null;
  /** Counts the records opened, so the page knows a redraw from a different record. */
  private opened = 0;
  /** Last search results; the editor never holds the whole item table. */
  private results: any[] = [];
  private truncated = 0;
  private searched = false;
  private dirty = false;
  /** The last save was refused and nothing has been changed since. */
  private refused = false;
  /** What the server said was wrong with the last save, sentence by sentence: the summary at the top of the page. */
  private problems: string[] = [];
  /** The same by field, for the sentences that are about one field. */
  private fieldErrors: Record<string, string> = {};

  /** How many items there are in all: the server's count when the editor opened, kept in step with what is saved and deleted here. */
  private total = 0;

  /** The save/delete waiting for its result; a second one waits too. `adds` is a save of an item that was not there before. */
  private pending: { kind: "save" | "delete"; packet: string; name: string; adds: boolean } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** The parts of the page that follow the fields as they are typed in. */
  private asideEl: HTMLElement | null = null;
  private weaponEl: HTMLElement | null = null;
  private headThumb: { key: string; node: HTMLElement } | null = null;

  private shell = new EditorShell({
    tool: "Item Editor", noun: "item", icon: "box", tabs: TABS,
    // Searching asks the server; the client never holds every item.
    onSearch: () => this.runSearch(),
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicate(this.openRow()),
    onDelete: () => void this.deleteEntry(this.openRow()),
    onTab: (id) => this.switchTab(id),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderForm() });

  constructor() {
    this.shell.waiting(() => this.shell.send({ type: "request", packet: "ITEM_EDITOR_LIST", data: null }));
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.data = msg.data;
      this.ready = true;
      this.shell.arrived();
      this.total = Number(this.data.itemCount) || 0;
      this.shell.setCount(this.total);
      this.renderList();
      this.renderForm();
    } else if (msg.type === "results") {
      this.results = Array.isArray(msg.data?.items) ? msg.data.items : [];
      this.truncated = Number(msg.data?.truncated) || 0;
      this.searched = true;
      // A save re-runs the search; keep editing the item that came back.
      if (this.originalName && !this.dirty) {
        const fresh = this.results.find((i: any) => i.name === this.originalName);
        if (fresh) this.draft = clone(fresh);
      }
      this.renderList();
      if (this.draft) this.renderForm();
    } else if (msg.type === "result") {
      // Only the pending save/delete's own result counts.
      if (!this.pending || (msg.action && msg.action !== this.pending.packet)) {
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        return;
      }
      const { kind, name, adds } = this.pending;
      this.endRequest();
      if (kind === "delete") this.onDeleteResult(msg, name);
      else this.onSaveResult(msg, adds);
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed an item. The list shows it as it is now.`);
      if (this.searched) this.runSearch();
    }
  }

  private onSaveResult(msg: any, added: boolean): void {
    if (!msg.ok) {
      this.problems = msg.errors?.length ? msg.errors : ["The server refused the save."];
      this.refused = true;
      this.fieldErrors = this.fieldsOf(this.problems);
      // Show a tab that has a problem, unless the one in view already does.
      const tabs = [...new Set(Object.keys(this.fieldErrors).map((key) => this.tabOf(key)))];
      if (tabs.length && !tabs.includes(this.tab)) this.tab = tabs[0];
      this.shell.setProblems(this.problems);
      this.renderForm();
      return;
    }
    this.dirty = false;
    this.refused = false;
    this.clearProblems();
    if (msg.name) this.originalName = msg.name;
    if (added) this.shell.setCount(++this.total);
    toast(`Saved ${this.originalName ?? "the item"}.`);
    this.renderForm();
    this.runSearch();
  }

  private onDeleteResult(msg: any, name: string): void {
    // The reply names the deleted item: never adopt it as the open one, and
    // leave the open item's unsaved edits alone.
    // Why it was refused is something to read, so it stays until it is closed.
    if (!msg.ok) return void noticeDialog(`${name} was not deleted`, msg.errors?.length ? msg.errors : ["The server refused to delete it."]);
    this.total = Math.max(0, this.total - 1);
    this.shell.setCount(this.total);
    toast(`Deleted ${name}.`);
    this.runSearch();
  }

  /** Something the server refused that no request here was waiting for: said on the open item, or in the corner. */
  private report(lines: string[]): void {
    if (!this.draft) return toast(lines.join("\n"), "error");
    this.problems = lines;
    this.shell.setProblems(lines);
  }

  /** Nothing is wrong any more: a save went through, or another item is opened. */
  private clearProblems(): void {
    this.problems = [];
    this.fieldErrors = {};
    this.shell.setProblems([]);
  }

  // ------------------------------------------------------------------- rules

  /** Which field each of the server's sentences is about. */
  private fieldsOf(lines: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const field = PROBLEM_FIELDS.find(([pattern]) => pattern.test(line))?.[1];
      if (field) fields[field] ??= line;
    }
    return fields;
  }

  /** Which tab a field is edited on. */
  private tabOf(key: string): string {
    if (key.startsWith("stat_")) return "stats";
    if (key === "level_requirement") return this.draft?.type === "equipment" ? "equipment" : "general";
    return ["equipable", "equipment_slot", "damage_min", "damage_max", "attack_speed_ms", "bag_slots"].includes(key) ? "equipment" : "general";
  }

  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of Object.keys(this.fieldErrors)) counts[this.tabOf(key)] = (counts[this.tabOf(key)] ?? 0) + 1;
    return counts;
  }

  // ------------------------------------------------------------------ fields

  /**
   * The icons to pick from. The one the item has is framed in the quality
   * being edited, as it will look in game, and is offered even when it is not
   * in the list (different case, an extension, or the list failed to load).
   */
  private iconAssets(): AssetOption[] {
    const current = String(this.draft?.icon ?? "");
    const quality = this.draft?.quality;
    const options: AssetOption[] = [
      { value: "", label: "None" },
      ...(this.data.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image, ...(i.name === current ? { quality } : {}) })),
    ];
    if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current, image: this.iconFor(current), quality });
    return options;
  }

  /** The words of the game written for reading: "ring_1" is listed as "Ring 1", and stored as it was. */
  private choices(values: string[], fallback: string[] = []): () => Array<{ value: string; label: string }> {
    const list = values?.length ? values : fallback;
    return () => list.map((v) => ({ value: v, label: words(v) }));
  }

  private tabFields(): Field[] {
    const isEquipment = this.draft?.type === "equipment";
    switch (this.tab) {
      case "equipment":
        return [
          { key: "equipable", label: "Equipable", type: "switch", rerender: true, hint: "Can be worn from the inventory." },
          ...(this.draft?.equipable
            ? ([
                { key: "equipment_slot", label: "Slot", type: "select", options: this.choices(this.data.slots ?? [], DEFAULT_SLOTS), rerender: true },
                { key: "level_requirement", label: "Level requirement", type: "number", hint: "Players below this level can't equip it." },
              ] as Field[])
            : []),
        ];
      case "stats":
        return STATS.map(([key, label, unit]) => ({ key, label, type: "number", unit }) as Field);
      default:
        return [
          { key: "name", label: "Name", type: "text", hint: "Must be unique: items are looked up by name." },
          { key: "type", label: "Type", type: "select", options: this.choices(this.data.types ?? [], DEFAULT_TYPES), rerender: true },
          { key: "quality", label: "Quality", type: "select", options: this.choices(this.data.qualities ?? [], DEFAULT_QUALITIES), rerender: true, hint: "Sets the colour of its name and icon frame." },
          { key: "icon", label: "Icon", type: "asset", assets: () => this.iconAssets(), fallback: "box" },
          ...(isEquipment ? [] : ([{ key: "level_requirement", label: "Level requirement", type: "number" }] as Field[])),
          { key: "sell_price", label: "Vendor sell price", type: "money", hint: "What a vendor pays for one. Nothing at all means vendors will not buy it. Quest items are never bought." },
          { key: "description", label: "Description", type: "textarea", hint: "Shown in the item's tooltip." },
        ];
    }
  }

  /** Weapon / bag fields, shown in their own card under the slot. */
  private slotFields(): { title: string; lead: string; fields: Field[] } | null {
    if (this.tab !== "equipment" || !this.draft?.equipable) return null;
    if (this.draft.equipment_slot === "weapon") {
      return {
        title: "Weapon",
        lead: "What a swing of it does",
        fields: [
          { key: "damage_min", label: "Minimum damage per swing", type: "number", hint: "Leave both empty to use the Damage stat instead." },
          { key: "damage_max", label: "Maximum damage per swing", type: "number" },
          { key: "attack_speed_ms", label: "Swing speed", type: "number", unit: "ms", hint: "Its attack speed: milliseconds between swings. Lower is faster." },
        ],
      };
    }
    if (this.draft.equipment_slot === "bag") {
      return { title: "Bag", lead: "", fields: [{ key: "bag_slots", label: "Bag slots", type: "number", hint: "Extra inventory slots it gives." }] };
    }
    return null;
  }

  /** What using a consumable does, shown in its own card under the item. */
  private useFields(): Field[] | null {
    if (this.tab !== "general" || this.draft?.type !== "consumable") return null;
    return [
      {
        key: "teleports_home", label: "Home item", type: "switch", rerender: true,
        hint: "Takes its player to their home inn after a 10 second cast, once an hour. It is never used up and cannot be deleted, traded or sold. Every player is given it, and only one item can be it.",
      },
      // The home item only takes its player home.
      ...(this.draft.teleports_home
        ? []
        : ([
            { key: "restore_health", label: "Restores health", type: "number", hint: "Given at once when it is used, up to the most the player can have." },
            { key: "restore_stamina", label: "Restores stamina", type: "number" },
          ] as Field[])),
      { key: "no_combat", label: "Cannot be used in combat", type: "switch", hint: "For food and the like: players in a fight are told it cannot be used." },
    ];
  }

  private blank(): any {
    return {
      name: "New Item", quality: "common", type: "miscellaneous", description: "", icon: "",
      stat_armor: null, stat_damage: null, stat_critical_chance: null, stat_critical_damage: null,
      stat_health: null, stat_stamina: null, stat_avoidance: null, level_requirement: 1,
      equipable: false, equipment_slot: null, bag_slots: null,
      damage_min: null, damage_max: null, attack_speed_ms: null,
      // What a vendor pays for one, in copper.
      sell_price: 1,
      // What using it does, when it is a consumable.
      restore_health: null, restore_stamina: null, no_combat: false, teleports_home: false,
    };
  }

  // ------------------------------------------------------------------ search

  /**
   * Icon URL for a stored icon name. The listed icons win, but an item whose
   * icon is not in the list (different case, an extension, or the list failed to
   * load) still gets a URL built the same way the game builds item icons.
   */
  private iconFor(name: unknown): string | null {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const bare = wanted.replace(/\.(png|jpg|jpeg|gif)$/i, "");
    const listed = (this.data.icons ?? []).find((i: any) => String(i.name).toLowerCase() === bare.toLowerCase());
    if (listed?.image) return listed.image;
    const base = this.data.assetServerUrl;
    return base ? `${base}/icon?name=${encodeURIComponent(bare)}` : null;
  }

  private runSearch(): void {
    // With no query the server returns only the item being edited.
    this.shell.send({ type: "request", packet: "ITEM_EDITOR_SEARCH", data: { query: this.shell.takeQuery(), name: this.originalName } });
  }

  /** "Rare equipment": what kind of item it is, in two words. */
  private kindOf(item: any): string {
    return `${words(item?.quality || "common")} ${String(item?.type || "item")}`;
  }

  /** What the open item is called while its name field may be empty. */
  private titleOf(item: any): string {
    return String(item?.name ?? "").trim() || (this.originalName === null ? "New item" : "Unnamed item");
  }

  /** The row of the open item as the list holds it, or the open item itself where the search does not list it. */
  private openRow(): any {
    return this.results.find((i: any) => i.name === this.originalName) ?? this.draft;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    const rows: ListRow[] = [];
    // An item that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.originalName === null) {
      rows.push({
        id: "\u0000new", name: this.titleOf(this.draft), note: "Not saved yet", selected: true,
        thumb: thumb(this.iconFor(this.draft.icon), { quality: this.draft.quality, fallback: "box" }),
        tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const item of this.results) {
      rows.push({
        id: String(item.name), name: String(item.name), note: this.kindOf(item), selected: item.name === this.originalName,
        thumb: thumb(this.iconFor(item.icon), { quality: item.quality, fallback: "box" }),
        actions: [
          { icon: "copy", label: `Duplicate ${item.name}`, onClick: () => void this.duplicate(item) },
          { icon: "trash", label: `Delete ${item.name}`, danger: true, onClick: () => void this.deleteEntry(item) },
        ],
        onOpen: () => void this.select(item.name),
      });
    }
    this.shell.setList({
      rows,
      empty: this.searched && this.shell.query
        ? { icon: "search", title: "No items match that search", text: "Check the spelling, or search for less of the name." }
        : { icon: "search", title: "Search for an item to edit it", text: "Type part of its name above. Only the items that match are listed." },
      foot: this.truncated > 0 ? `${count(this.truncated, "more item matches", "more items match")}. Narrow the search to see them.` : "",
    });
  }

  /** The top bar and the tabs: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setTabs(null);
      return;
    }
    // The picture is only drawn again when it changes, not at every key typed.
    const key = `${d.icon}|${d.quality}`;
    if (this.headThumb?.key !== key) this.headThumb = { key, node: thumb(this.iconFor(d.icon), { size: "lg", quality: d.quality, fallback: "box" }) };
    shell.setRecord({ title: this.titleOf(d), note: this.kindOf(d), thumb: this.headThumb.node });
    const state: RecordState = this.pending?.kind === "save" ? "saving" : this.refused ? "error" : this.originalName === null ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    const saved = this.originalName !== null;
    shell.setActions({
      open: true, dirty: this.dirty, busy: this.pending ? (this.pending.kind === "save" ? "save" : "other") : null, canDuplicate: saved, canDelete: saved,
      why: { duplicate: "Save it first, then it can be copied", delete: "It has not been saved, so there is nothing to delete" },
    });
    shell.setTabs(this.tab, this.problemsByTab());
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    this.renderForm();
  }

  private renderForm(): void {
    this.chrome();
    this.asideEl = this.weaponEl = null;
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Search for an item on the left to edit it, or start a new one.", this.total === 0 ? "Start the first one." : null);
      box.appendChild(button("New item", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    const { main, aside } = this.shell.page(`${this.opened}:${this.tab}`, { aside: true });

    const titles: Record<string, [string, string?]> = {
      general: ["Item"],
      equipment: ["Equipping"],
      stats: ["Stats", "Bonuses the wearer gets while it is equipped"],
    };
    const [title, lead] = titles[this.tab] ?? ["Details"];
    const grid = this.section(main, title, lead);
    for (const field of this.tabFields()) grid.appendChild(this.field(field));

    const use = this.useFields();
    if (use) {
      const useGrid = this.section(main, "Using it", "What happens when a player uses one from their bags or hotbar");
      for (const field of use) useGrid.appendChild(this.field(field));
    }

    const slot = this.slotFields();
    if (slot) {
      const slotGrid = this.section(main, slot.title, slot.lead);
      for (const field of slot.fields) slotGrid.appendChild(this.field(field));
      if (slot.title === "Weapon") {
        this.weaponEl = el("div", "tl-field-wide");
        slotGrid.appendChild(this.weaponEl);
        this.paintWeapon();
      }
    }

    this.asideEl = aside;
    this.paintAside();
  }

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /** One field of the open item, with the problem the server reported for it. */
  private field(field: Field): HTMLElement {
    const wrap = this.fields.renderField(field, this.draft, () => this.touched(field.key, wrap), { error: this.fieldErrors[field.key] });
    return wrap;
  }

  /** A field was edited: there is something to save, and its old problem no longer describes it. */
  private touched(key: string, wrap: HTMLElement): void {
    this.dirty = true;
    this.refused = false;
    const fixed = this.fieldErrors[key];
    if (fixed) {
      // Its sentence leaves the summary with its mark.
      delete this.fieldErrors[key];
      setFieldError(wrap, null);
      this.problems = this.problems.filter((line) => line !== fixed);
      this.shell.setProblems(this.problems, false);
    }
    this.chrome();
    this.paintWeapon();
    this.paintAside();
  }

  /** What the weapon actually does in combat, so the numbers are not abstract. */
  private paintWeapon(): void {
    if (!this.weaponEl || this.draft?.equipment_slot !== "weapon") return;
    const min = Number(this.draft.damage_min) || 0;
    const max = Number(this.draft.damage_max) || 0;
    const speed = Number(this.draft.attack_speed_ms) || 2000;
    let text: string;
    if (min <= 0 && max <= 0) text = "No damage range set: swings fall back to the item's damage stat.";
    else {
      const dps = ((min + max) / 2) / (speed / 1000);
      text = `${min} to ${max} damage every ${(speed / 1000).toFixed(1)} seconds: ${dps.toFixed(1)} per second before stats. `
        + `Damage stats are scaled by swing speed, so this weapon gets ${(speed / 2000).toFixed(2)} times their value.`;
    }
    this.weaponEl.replaceChildren(note(text, "plain", "sword"));
  }

  /** The item at a glance, beside the form: its icon in its frame, its name in its colour, and what it gives. */
  private paintAside(): void {
    const d = this.draft;
    if (!this.asideEl || !d) return;
    this.asideEl.replaceChildren();
    const { body } = card(this.asideEl, "At a glance", "The item as its fields describe it");
    const box = el("div", "tl-preview");
    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    const name = el("span", "tl-preview-name tl-quality-text", this.titleOf(d));
    name.dataset.quality = qualityOf(d.quality);
    const slot = d.equipable && d.equipment_slot ? ` · ${words(d.equipment_slot)}` : "";
    said.append(name, el("span", "tl-preview-kind", `${this.kindOf(d)}${slot}`));
    head.append(thumb(this.iconFor(d.icon), { size: "xl", quality: d.quality, fallback: "box" }), said);
    box.appendChild(head);

    const line = (text: string, kind = "") => box.appendChild(el("div", "tl-preview-line" + (kind ? ` tl-preview-line-${kind}` : ""), text));
    const min = Number(d.damage_min) || 0;
    const max = Number(d.damage_max) || 0;
    if (d.equipable && d.equipment_slot === "weapon" && (min > 0 || max > 0)) {
      line(`${min} to ${max} damage, one swing every ${((Number(d.attack_speed_ms) || 2000) / 1000).toFixed(1)} seconds`);
    }
    if (d.equipable && d.equipment_slot === "bag" && Number(d.bag_slots) > 0) line(`${count(Number(d.bag_slots), "extra inventory slot")}`);
    for (const [key, label, unit] of STATS) {
      const value = Number(d[key]);
      if (d[key] === null || d[key] === undefined || d[key] === "" || !value) continue;
      line(`${value > 0 ? "+" : "−"}${Math.abs(value)}${unit ?? ""} ${label}`, value > 0 ? "good" : "bad");
    }
    if (Number(d.level_requirement) > 1) line(`Requires level ${Number(d.level_requirement)}`, "faint");
    // What a vendor pays: one copper when nothing is set, and nothing for a quest item or a price of none.
    const price = d.sell_price === null || d.sell_price === undefined || d.sell_price === "" ? 1 : Math.max(0, Math.floor(Number(d.sell_price) || 0));
    const isHome = d.type === "consumable" && !!d.teleports_home;
    if (d.type === "consumable") {
      const gives = [Number(d.restore_health) > 0 ? `${Number(d.restore_health)} health` : "", Number(d.restore_stamina) > 0 ? `${Number(d.restore_stamina)} stamina` : ""].filter(Boolean);
      if (isHome) line("Use: returns its player to their home inn", "good");
      else if (gives.length) line(`Use: restores ${gives.join(" and ")}`, "good");
      else line("Does nothing when used yet", "bad");
      if (d.no_combat) line("Cannot be used in combat", "faint");
    }
    line(
      isHome ? "Stays with its player: it cannot be sold, traded or deleted"
        : d.type === "quest" ? "Quest item: vendors do not buy it" : price > 0 ? `Sells to a vendor for ${coinWords(price)}` : "Vendors do not buy it",
      "faint",
    );
    if (String(d.description ?? "").trim()) box.appendChild(el("div", "tl-preview-text", String(d.description).trim()));
    body.appendChild(box);
  }

  // ----------------------------------------------------------------- opening

  /** True when the open item can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.titleOf(this.draft));
  }

  private open(draft: any, originalName: string | null, dirty: boolean): void {
    this.originalName = originalName;
    // The table keeps these two as 0 or 1: a switch is on or off.
    for (const flag of ["no_combat", "teleports_home"]) draft[flag] = draft[flag] === true || Number(draft[flag]) === 1;
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
    const item = this.results.find((i: any) => i.name === name);
    if (!item) return;
    this.open(clone(item), name, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.tab = "general";
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  /** Start a new, unsaved item copied from a list row. */
  private async duplicate(item: any): Promise<void> {
    if (!item || !(await this.mayLeave())) return;
    const copy = clone(item);
    copy.name = `${copy.name} copy`;
    this.tab = "general";
    this.open(copy, null, true);
    // The copy needs a name of its own before it can be saved.
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    this.beginRequest("save", "ITEM_EDITOR_SAVE", { ...this.draft, originalName: this.originalName }, String(this.draft.name ?? ""));
  }

  /** Delete an item, from its list row or the top bar. Closes it if it is the open one. */
  private async deleteEntry(item: any): Promise<void> {
    const name = String(item?.name ?? "");
    if (!name || this.pending) return;
    if (!(await this.shell.confirmDelete(name, "It is removed from the game for good. Players who are holding one are left with a broken item."))) return;
    if (this.pending) return;
    if (this.originalName === name) {
      this.draft = null;
      this.originalName = null;
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
      this.renderForm();
    }
    this.beginRequest("delete", "ITEM_EDITOR_DELETE", { name }, name);
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any, name: string): void {
    this.pending = { kind, packet, name, adds: kind === "save" && this.originalName === null };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (e.g. permissions): don't leave Save blocked forever.
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

new ItemEditorBridge();
