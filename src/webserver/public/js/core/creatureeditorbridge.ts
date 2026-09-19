// Creature editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.

type FieldType = "text" | "number" | "select" | "checkbox" | "flags" | "readonly" | "sheet" | "asset" | "money";

/** Coin denominations, as the currency system uses them: 100 copper per silver, 100 silver per gold. */
const COPPER_PER_SILVER = 100;
const COPPER_PER_GOLD = 100 * COPPER_PER_SILVER;

interface AssetOption {
  value: string | number;
  label: string;
  /** Preview image URL, when the asset has one. */
  image?: string | null;
}

interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: () => Array<{ value: string | number; label: string }>;
  /** For "asset" fields: the browsable list shown in the picker popup. */
  assets?: () => AssetOption[];
  step?: number;
  hint?: string;
  /** For "sheet" fields: which sprite sheet slot to browse. */
  slot?: string;
  /** Re-render the form after this field changes (fields that reveal other fields). */
  rerender?: boolean;
  /** For "asset" and "sheet" fields: a text-only list, no image column. */
  noIcons?: boolean;
  /** Start a new row of the form grid at this field. */
  newRow?: boolean;
}

const CREATURE_FLAGS: Array<{ bit: number; label: string }> = [
  { bit: 1 << 0, label: "No taunt" },
  { bit: 1 << 1, label: "Immune stun" },
  { bit: 1 << 2, label: "Immune root/slow" },
  { bit: 1 << 3, label: "No XP" },
  { bit: 1 << 4, label: "No leash" },
  { bit: 1 << 5, label: "Never flee" },
  { bit: 1 << 6, label: "Can swim" },
  { bit: 1 << 7, label: "Detect stealth" },
  { bit: 1 << 8, label: "No social aggro" },
];

const pick = (values: string[]) => () => values.map((v) => ({ value: v, label: v }));

/**
 * Checkboxes always come after the other fields, and the full-width flag grid
 * last of all; within each group the declared order is kept.
 */
function orderFields(fields: Field[]): Field[] {
  const rank = (field: Field) => (field.type === "flags" ? 2 : field.type === "checkbox" ? 1 : 0);
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field);
}

/** Tabs that edit one creature: the same creature list, and selection carries across. */
const TEMPLATE_TABS = new Set(["templates", "appearance", "rewards", "abilities"]);

class CreatureEditorBridge {
  private data: any = { templates: [], abilities: [], spawns: [], patrolPaths: [], linkGroups: [], pools: [], spells: [], lootTables: [], maps: [], triggers: [], targetModes: [], spriteSheets: {}, icons: [] };
  private tab = "templates";
  private selectedId: number | null = null;
  private draft: any = null;
  private search = "";
  private dirty = false;
  /** The selected creature's abilities being edited on the Abilities tab. */
  private abilityDraft: any[] = [];
  private abilitiesDirty = false;
  /** Which save is in flight, so its result clears the right flag. */
  private pendingSave: "template" | "abilities" | "other" | null = null;

  private listEl = document.getElementById("ce-list")!;
  private listTitle = document.getElementById("ce-list-title")!;
  private fieldsEl = document.getElementById("ce-form-fields")!;
  private extraEl = document.getElementById("ce-extra")!;
  private errorsEl = document.getElementById("ce-errors")!;
  private statusEl = document.getElementById("ce-status")!;
  private searchInput = document.getElementById("ce-search") as HTMLInputElement;

  constructor() {
    document.getElementById("btn-save")!.addEventListener("click", () => this.save());
    document.getElementById("btn-new")!.addEventListener("click", () => this.toolbarNew());
    document.getElementById("btn-delete")!.addEventListener("click", () => this.deleteEntry());
    document.getElementById("btn-place")!.addEventListener("click", () => this.placeSpawn());
    document.getElementById("btn-goto")!.addEventListener("click", () => this.goto());
    (document.getElementById("chk-debug") as HTMLInputElement).addEventListener("change", (e) => {
      this.send({ type: "debug", on: (e.target as HTMLInputElement).checked });
    });
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value.toLowerCase();
      this.renderList();
    });
    document.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")!));
    });
    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.save();
      }
    });
    window.addEventListener("beforeunload", () => this.send({ type: "editorClosed" }));
    // Backup for the game page closing us on unload: if the game tab is gone,
    // this editor has nothing to talk to, so close.
    if (window.opener) {
      setInterval(() => {
        if (!window.opener || window.opener.closed) window.close();
      }, 1000);
    }
    this.send({ type: "bridgeReady" });
  }

  private send(msg: any): void {
    if (window.opener) window.opener.postMessage(msg, "*");
  }

  private onMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    if (msg.type === "data") {
      this.data = msg.data;
      // Fresh ability ids from the server, unless there are edits to keep.
      if (!this.abilitiesDirty) this.loadAbilityDraft();
      this.renderList();
      this.renderForm();
      this.status("Loaded");
    } else if (msg.type === "result") {
      const saved = this.pendingSave;
      this.pendingSave = null;
      if (msg.ok) {
        if (saved === "abilities") this.abilitiesDirty = false;
        else this.dirty = false;
        if (msg.id && this.draft) {
          this.selectedId = msg.id;
          // A new entry now exists: later saves must update it, not insert again.
          if (!this.draft.id && saved !== "abilities") this.draft.id = msg.id;
        }
        // Creature saved first; its abilities follow now that it has an id.
        if (saved === "template" && this.abilitiesDirty && this.draft?.id) {
          this.sendAbilities();
          return;
        }
        this.showErrors([]);
        this.status("Saved");
        this.send({ type: "request", packet: "CREATURE_EDITOR_LIST", data: null });
      } else {
        this.showErrors(msg.errors || ["Save failed."]);
        this.status("Not saved");
      }
    } else if (msg.type === "updated") {
      this.status(`Updated by ${msg.by}`);
      this.send({ type: "request", packet: "CREATURE_EDITOR_LIST", data: null });
    } else if (msg.type === "pointPicked") {
      // The game window collected a world position / path for the current draft.
      if (msg.what === "spawn" && this.draft) {
        this.draft.x = msg.x;
        this.draft.y = msg.y;
        this.draft.map = msg.map;
        this.renderForm();
        this.status("Position set - remember to save");
      } else if (msg.what === "path" && this.draft) {
        this.draft.points = msg.points;
        this.draft.map = msg.map;
        // Drawn points are unsaved edits: switching entries must confirm first.
        this.dirty = true;
        this.renderForm();
        const n = Array.isArray(msg.points) ? msg.points.length : 0;
        this.status(`${n} point(s) — save when done`);
      }
    }
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
  }

  private showErrors(errors: string[]): void {
    this.errorsEl.hidden = errors.length === 0;
    this.errorsEl.innerHTML = errors.map((e) => `<div class="editor-error-line"></div>`).join("");
    this.errorsEl.querySelectorAll(".editor-error-line").forEach((el, i) => {
      el.textContent = errors[i];
    });
  }

  // ------------------------------------------------------------- collections

  private get collection(): any[] {
    switch (this.tab) {
      case "spawns": return this.data.spawns;
      case "paths": return this.data.patrolPaths;
      case "linkGroups": return this.data.linkGroups;
      case "pools": return this.data.pools;
      default: return this.data.templates;
    }
  }

  private templateName(id: number): string {
    return this.data.templates.find((t: any) => t.id === id)?.name ?? `#${id}`;
  }

  private label(entry: any): string {
    switch (this.tab) {
      case "spawns":
        return `${this.templateName(entry.template_id)} @ ${entry.map} ${entry.x},${entry.y}`;
      case "paths":
        return `#${entry.id} ${entry.map} (${entry.points?.length ?? 0} points)`;
      case "linkGroups":
        return `#${entry.id} ${entry.name}`;
      case "pools":
        return `#${entry.id} max ${entry.max_active}${entry.rare_template_id ? ` rare ${this.templateName(entry.rare_template_id)}` : ""}`;
      default:
        return `${entry.name}${entry.subname ? ` <${entry.subname}>` : ""} (lvl ${entry.level_min}-${entry.level_max})`;
    }
  }

  private fields(): Field[] {
    const none = { value: 0, label: "None" };
    const templateOptions = (): AssetOption[] => [none, ...this.data.templates.map((t: any) => ({ value: t.id, label: t.name }))];
    switch (this.tab) {
      case "abilities":
        // Drawn as one card per ability (renderAbilities), not as form fields.
        return [];
      case "spawns":
        return [
          { key: "template_id", label: "Creature", type: "asset", noIcons: true, assets: templateOptions },
          { key: "map", label: "Map", type: "asset", noIcons: true, assets: () => this.data.maps.map((m: string) => ({ value: m, label: m })) },
          { key: "x", label: "X", type: "number" },
          { key: "y", label: "Y", type: "number" },
          { key: "direction", label: "Facing", type: "select", options: pick(["down", "up", "left", "right"]) },
          { key: "layer_policy", label: "Layers", type: "select", options: pick(["per_layer", "shared"]) },
          { key: "respawn_min_s", label: "Respawn min (s)", type: "number" },
          { key: "respawn_max_s", label: "Respawn max (s)", type: "number" },
          { key: "movement_type", label: "Movement", type: "select", options: pick(["idle", "wander", "patrol"]) },
          { key: "wander_radius", label: "Wander radius (yards)", type: "number" },
          { key: "patrol_path_id", label: "Patrol path", type: "asset", noIcons: true, assets: () => [none, ...this.data.patrolPaths.map((p: any) => ({ value: p.id, label: `#${p.id} ${p.map}` }))] },
          { key: "link_group_id", label: "Link group", type: "asset", noIcons: true, assets: () => [none, ...this.data.linkGroups.map((g: any) => ({ value: g.id, label: g.name }))] },
          { key: "pool_id", label: "Spawn pool", type: "asset", noIcons: true, assets: () => [none, ...this.data.pools.map((p: any) => ({ value: p.id, label: `#${p.id}` }))] },
        ];
      case "rewards":
      case "appearance":
        return this.templateSectionFields(this.tab, none);
      case "paths":
        return [
          { key: "map", label: "Map", type: "asset", assets: () => this.data.maps.map((m: string) => ({ value: m, label: m })) },
          { key: "loop", label: "Loop (otherwise walks back and forth)", type: "checkbox" },
        ];
      case "linkGroups":
        return [{ key: "name", label: "Name", type: "text" }];
      case "pools":
        return [
          { key: "max_active", label: "Max active at once", type: "number" },
          { key: "rare_chance_pct", label: "Rare chance %", type: "number" },
          { key: "rare_template_id", label: "Rare creature", type: "asset", assets: templateOptions },
        ];
      default:
        return [
          { key: "name", label: "Name", type: "text" },
          { key: "subname", label: "Title", type: "text" },
          { key: "level_min", label: "Level min", type: "number" },
          { key: "level_max", label: "Level max", type: "number" },
          { key: "rank", label: "Rank", type: "select", options: pick(["normal", "elite", "rare", "rare_elite", "boss"]) },
          { key: "creature_type", label: "Type", type: "select", options: pick(["beast", "humanoid", "undead", "elemental", "demon", "dragonkin", "critter", "mechanical"]) },
          { key: "stance", label: "Stance", type: "select", options: pick(["aggressive", "neutral", "passive"]) },
          { key: "health_base", label: "Health base", type: "number" },
          { key: "health_per_level", label: "Health per level", type: "number" },
          { key: "armor", label: "Armor", type: "number" },
          { key: "ranged", label: "Keeps its distance (stops at range)", type: "checkbox" },
          { key: "move_speed_walk", label: "Walk speed (yd/s)", type: "number", step: 0.1 },
          { key: "move_speed_run", label: "Run speed (yd/s)", type: "number", step: 0.1 },
          { key: "aggro_radius_override", label: "Aggro radius override (yards)", type: "number" },
          { key: "assist_radius", label: "Assist radius (yards)", type: "number" },
          { key: "call_for_help_radius", label: "Call for help radius (yards)", type: "number" },
          { key: "flee_at_hp_pct", label: "Flee at health %", type: "number" },
          { key: "flee_duration_ms", label: "Flee duration (ms)", type: "number" },
          { key: "leash_override", label: "Leash override (yards)", type: "number" },
          { key: "regen_ooc", label: "Regenerates out of combat", type: "checkbox" },
          { key: "flags", label: "Flags", type: "flags" },
        ];
    }
  }

  /** Fields of one ability card. The creature is implied: the one selected. */
  private abilityFields(): Field[] {
    return [
      { key: "spell_id", label: "Spell", type: "asset", rerender: true, assets: () => this.data.spells.map((s: any) => ({ value: s.id, label: s.name, image: s.icon })) },
      { key: "trigger", label: "Trigger", type: "select", options: () => this.data.triggers.map((t: string) => ({ value: t, label: t })) },
      { key: "trigger_value", label: "Trigger value (health % for hp_below)", type: "number" },
      { key: "initial_cd_min_ms", label: "Initial delay min (ms)", type: "number" },
      { key: "initial_cd_max_ms", label: "Initial delay max (ms)", type: "number" },
      { key: "cooldown_min_ms", label: "Cooldown min (ms)", type: "number" },
      { key: "cooldown_max_ms", label: "Cooldown max (ms)", type: "number" },
      { key: "chance_pct", label: "Chance %", type: "number" },
      { key: "target_mode", label: "Target", type: "select", options: () => this.data.targetModes.map((t: string) => ({ value: t, label: t })) },
      { key: "max_range", label: "Max range (yards, 0 = spell range)", type: "number" },
      { key: "priority", label: "Priority", type: "number" },
      { key: "interruptible", label: "Interruptible", type: "checkbox" },
    ];
  }

  /** Fields for the template sections split out of the Templates tab. */
  private templateSectionFields(tab: "rewards" | "appearance", none: AssetOption): Field[] {
    switch (tab) {
      case "rewards":
        return [
          { key: "xp_mult", label: "XP multiplier", type: "number", step: 0.1 },
          { key: "loot_table_id", label: "Loot table", type: "asset", noIcons: true, assets: () => [none, ...this.data.lootTables.map((t: any) => ({ value: t.id, label: t.name }))] },
          { key: "gold_min", label: "Money min", type: "money", newRow: true },
          { key: "gold_max", label: "Money max", type: "money" },
        ];
      case "appearance": {
        const spriteType = String(this.draft?.sprite_type ?? "none");
        return [
          { key: "sprite_type", label: "Sprite type", type: "select", options: pick(["animated", "static", "none"]), rerender: true },
          ...(spriteType === "static"
            ? [{
                key: "sprite",
                label: "Static image",
                type: "asset",
                assets: () => [
                  { value: "", label: "None" },
                  ...(this.data.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image })),
                ],
              } as Field]
            : []),
          ...(spriteType === "animated"
            ? ([
                { key: "sprite", label: "Body sheet", type: "sheet", slot: "body", noIcons: true },
                { key: "sprite_head", label: "Head sheet", type: "sheet", slot: "head", noIcons: true },
                { key: "sprite_helmet", label: "Helmet", type: "sheet", slot: "helmet" },
                { key: "sprite_shoulderguards", label: "Shoulders", type: "sheet", slot: "shoulderguards" },
                { key: "sprite_neck", label: "Neck", type: "sheet", slot: "neck" },
                { key: "sprite_hands", label: "Gloves", type: "sheet", slot: "hands" },
                { key: "sprite_chest", label: "Chest", type: "sheet", slot: "chest" },
                { key: "sprite_feet", label: "Boots", type: "sheet", slot: "feet" },
                { key: "sprite_legs", label: "Pants", type: "sheet", slot: "legs" },
                { key: "sprite_weapon", label: "Weapon", type: "sheet", slot: "weapon" },
              ] as Field[])
            : []),
          { key: "scale", label: "Scale", type: "number", step: 0.1 },
        ];
      }
    }
  }

  /** Sprite sheets the asset server reported for a slot, plus whatever the template already uses. */
  private sheetOptions(slot: string, current: string): AssetOption[] {
    const sheets: Array<{ name: string; image: string | null }> = this.data.spriteSheets?.[slot] ?? [];
    const options: AssetOption[] = [
      { value: "", label: "None" },
      ...sheets.map((sheet) => ({ value: sheet.name, label: sheet.name, image: sheet.image })),
    ];
    if (current && !sheets.some((sheet) => sheet.name === current)) {
      options.push({ value: current, label: `${current} (not on the asset server)` });
    }
    return options;
  }

  private assetOptionsFor(field: Field, value: unknown): AssetOption[] {
    return field.type === "sheet" ? this.sheetOptions(field.slot || "other", String(value ?? "")) : field.assets?.() ?? [];
  }

  /**
   * Asset fields open a searchable popup rather than a dropdown: asset lists get
   * long, and a dropdown cannot show the images.
   */
  private renderAssetField(field: Field, target: any, touch: () => void): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ce-asset-button";

    const paint = () => {
      const current = target[field.key];
      const match = this.assetOptionsFor(field, current).find((o) => String(o.value) === String(current ?? ""));
      button.innerHTML = "";
      if (!field.noIcons) {
        const thumb = document.createElement("span");
        thumb.className = "ce-asset-thumb";
        if (match?.image) {
          const img = document.createElement("img");
          img.src = match.image;
          img.alt = "";
          img.loading = "lazy";
          thumb.appendChild(img);
        }
        button.appendChild(thumb);
      }
      const text = document.createElement("span");
      text.className = "ce-asset-name";
      text.textContent = match?.label ?? (current ? String(current) : "None");
      button.appendChild(text);
    };
    paint();

    button.addEventListener("click", () => {
      this.openAssetPicker(field.label, this.assetOptionsFor(field, target[field.key]), !field.noIcons, (option) => {
        target[field.key] = option.value;
        touch();
        if (field.rerender) this.renderForm();
        else paint();
      });
    });
    return button;
  }

  /** Searchable asset browser. With `icons`, entries show their image when they have one. */
  private openAssetPicker(title: string, options: AssetOption[], icons: boolean, onPick: (option: AssetOption) => void): void {
    const overlay = document.createElement("div");
    overlay.className = "editor-modal-overlay";
    const box = document.createElement("div");
    box.className = "editor-modal-box ce-asset-picker";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search...";
    search.spellcheck = false;
    const list = document.createElement("div");
    list.className = "ce-asset-list";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };

    const paintList = () => {
      const query = search.value.toLowerCase();
      list.innerHTML = "";
      const matches = options.filter((o) => !query || o.label.toLowerCase().includes(query));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "editor-empty";
        empty.textContent = "Nothing matches that search.";
        list.appendChild(empty);
        return;
      }
      for (const option of matches) {
        const row = document.createElement("div");
        row.className = "ce-asset-row";
        if (icons) {
          const thumb = document.createElement("span");
          thumb.className = "ce-asset-thumb";
          if (option.image) {
            const img = document.createElement("img");
            img.src = option.image;
            img.alt = "";
            img.loading = "lazy";
            thumb.appendChild(img);
          }
          row.appendChild(thumb);
        }
        const text = document.createElement("span");
        text.className = "ce-asset-name";
        text.textContent = option.label;
        row.appendChild(text);
        row.addEventListener("click", () => {
          onPick(option);
          close();
        });
        list.appendChild(row);
      }
    };

    search.addEventListener("input", paintList);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);

    box.appendChild(heading);
    box.appendChild(search);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintList();
    search.focus();
  }

  private blank(): any {
    switch (this.tab) {
      case "spawns":
        return { id: 0, template_id: this.data.templates[0]?.id ?? 0, map: this.data.maps[0] ?? "", x: 0, y: 0, direction: "down", layer_policy: "per_layer", respawn_min_s: 120, respawn_max_s: 180, wander_radius: 0, movement_type: "idle", patrol_path_id: 0, link_group_id: 0, pool_id: 0 };
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

  /** A new ability for the selected creature (bound to it when saved). */
  private blankAbility(): any {
    return { id: 0, spell_id: this.data.spells[0]?.id ?? 0, trigger: "combat_timer", trigger_value: 0, initial_cd_min_ms: 3000, initial_cd_max_ms: 6000, cooldown_min_ms: 8000, cooldown_max_ms: 12000, chance_pct: 100, target_mode: "current", max_range: 30, interruptible: true, priority: 0 };
  }

  /** The selected creature's saved abilities, as an editable copy. */
  private loadAbilityDraft(): void {
    const id = this.draft?.id;
    this.abilityDraft = id && TEMPLATE_TABS.has(this.tab)
      ? JSON.parse(JSON.stringify((this.data.abilities ?? []).filter((a: any) => a.template_id === id)))
      : [];
  }

  // ------------------------------------------------------------------ render

  private switchTab(tab: string): void {
    // Templates, Appearance, Rewards and Abilities all edit the same creature:
    // moving between them keeps the selection and any unsaved edits.
    const sameTemplate = TEMPLATE_TABS.has(this.tab) && TEMPLATE_TABS.has(tab);
    this.tab = tab;
    if (!sameTemplate) {
      this.selectedId = null;
      this.draft = null;
      this.dirty = false;
      this.abilityDraft = [];
      this.abilitiesDirty = false;
      this.showErrors([]);
    }
    document.querySelectorAll(".editor-tab-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    this.listTitle.textContent = TEMPLATE_TABS.has(tab)
      ? "Templates"
      : (document.querySelector(`.editor-tab-btn[data-tab="${tab}"]`) as HTMLElement)?.textContent ?? "Entries";
    this.renderList();
    this.renderForm();
  }

  private renderList(): void {
    const entries = this.collection.filter((e: any) => !this.search || this.label(e).toLowerCase().includes(this.search));
    this.listEl.innerHTML = "";
    // Non-creature tabs create entries from a pinned row, not the toolbar:
    // the toolbar New button always starts a creature.
    const newLabel = this.newRowLabel();
    if (newLabel) {
      const row = document.createElement("div");
      row.className = "editor-item ce-new-row" + (this.selectedId === 0 && this.draft ? " active" : "");
      const text = document.createElement("span");
      text.className = "editor-item-label";
      text.textContent = `+ ${newLabel}`;
      row.title = newLabel;
      row.appendChild(text);
      row.addEventListener("click", () => {
        if ((this.dirty || this.abilitiesDirty) && !confirm("Discard unsaved changes?")) return;
        this.newEntry();
      });
      this.listEl.appendChild(row);
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "editor-item" + (entry.id === this.selectedId ? " active" : "");
      const text = document.createElement("span");
      text.className = "editor-item-label";
      text.textContent = this.label(entry);
      row.title = text.textContent;
      row.appendChild(text);
      row.addEventListener("click", () => this.select(entry.id));
      this.listEl.appendChild(row);
    }
  }

  private select(id: number): void {
    if ((this.dirty || this.abilitiesDirty) && !confirm("Discard unsaved changes?")) return;
    this.selectedId = id;
    this.draft = JSON.parse(JSON.stringify(this.collection.find((e: any) => e.id === id) ?? this.blank()));
    this.dirty = false;
    this.abilitiesDirty = false;
    this.loadAbilityDraft();
    this.showErrors([]);
    this.renderList();
    this.renderForm();
  }

  /** Creation row for tabs whose entries are not creatures (toolbar New is creatures only). */
  private newRowLabel(): string | null {
    switch (this.tab) {
      case "spawns": return "New spawn";
      case "paths": return "New patrol path";
      case "linkGroups": return "New link group";
      case "pools": return "New spawn pool";
      default: return null;
    }
  }

  private newEntry(): void {
    this.selectedId = 0;
    this.draft = this.blank();
    this.dirty = true;
    this.abilityDraft = [];
    this.abilitiesDirty = false;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
    this.status("New entry - fill it in and save");
  }

  /** The toolbar New button always starts a creature, whatever the tab is. */
  private toolbarNew(): void {
    if ((this.dirty || this.abilitiesDirty) && !confirm("Discard unsaved changes?")) return;
    if (!TEMPLATE_TABS.has(this.tab)) this.switchTab("templates");
    this.newEntry();
  }

  private renderForm(): void {
    this.updateChrome();
    this.fieldsEl.innerHTML = "";
    this.extraEl.innerHTML = "";
    if (!this.draft) {
      this.fieldsEl.innerHTML = `<div class="editor-empty">Select an entry, or press New.</div>`;
      return;
    }
    // Live point updates re-render the form while a wait box may be focused;
    // remember it so typing there is not interrupted.
    const focusedWait = (document.activeElement as HTMLElement | null)?.dataset?.waitIndex ?? null;

    const idRow = document.createElement("div");
    idRow.className = "ce-field ce-field-wide";
    idRow.innerHTML = `<label class="editor-form-label">ID</label><div class="editor-display-name"></div>`;
    // Tabs without a name field: show whose section this is.
    const showName = TEMPLATE_TABS.has(this.tab) && this.tab !== "templates";
    idRow.querySelector(".editor-display-name")!.textContent =
      `${this.draft.id || "new"}${showName && this.draft.name ? ` (${this.draft.name})` : ""}`;
    this.fieldsEl.appendChild(idRow);

    for (const field of orderFields(this.fields())) this.fieldsEl.appendChild(this.renderField(field));
    if (this.tab === "paths") this.renderPathPoints(focusedWait);
    if (this.tab === "templates" && this.draft.id) this.renderTemplateSummary();
    if (this.tab === "abilities") this.renderAbilities();
  }

  /**
   * The selected creature's abilities, one card each, edited together and
   * saved together with the Save button.
   */
  private renderAbilities(): void {
    const touch = () => {
      this.abilitiesDirty = true;
    };
    const spellName = (id: number) => this.data.spells.find((s: any) => s.id === id)?.name ?? `Spell ${id}`;

    if (this.abilityDraft.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No abilities: this creature cannot attack. Add one below.";
      this.extraEl.appendChild(empty);
    }

    this.abilityDraft.forEach((ability, index) => {
      const card = document.createElement("div");
      card.className = "ce-ability";

      const header = document.createElement("div");
      header.className = "ce-ability-header";
      const title = document.createElement("span");
      title.className = "ce-ability-title";
      title.textContent = `${index + 1}. ${spellName(Number(ability.spell_id))}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ce-card-btn ce-card-btn-danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        this.abilityDraft.splice(index, 1);
        touch();
        this.renderForm();
      });
      header.appendChild(title);
      header.appendChild(remove);
      card.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "ce-ability-fields";
      for (const field of orderFields(this.abilityFields())) grid.appendChild(this.renderField(field, ability, touch));
      card.appendChild(grid);
      this.extraEl.appendChild(card);
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "ce-card-btn ce-ability-add";
    add.textContent = "Add ability";
    add.addEventListener("click", () => {
      this.abilityDraft.push(this.blankAbility());
      touch();
      this.renderForm();
    });
    this.extraEl.appendChild(add);
  }

  /**
   * Buttons and tabs that act on the current entry stay hidden until something
   * is selected or being created, instead of opening blank menus.
   */
  private updateChrome(): void {
    const has = !!this.draft;
    for (const id of ["btn-save", "btn-delete", "btn-place", "btn-goto"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = !has;
    }
    document
      .querySelectorAll('.editor-tab-btn[data-tab="appearance"], .editor-tab-btn[data-tab="rewards"], .editor-tab-btn[data-tab="abilities"]')
      .forEach((btn) => ((btn as HTMLElement).hidden = !has));
  }

  /**
   * One form field. It edits `target[field.key]` (the selected entry's draft
   * unless given, e.g. an ability card's own ability) and calls `touch` on change.
   */
  private renderField(field: Field, target: any = this.draft, touch: () => void = () => { this.dirty = true; }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field"
      + (field.type === "flags" ? " ce-field-wide" : "")
      + (field.type === "money" ? " ce-field-money" : "")
      + (field.newRow ? " ce-field-row-start" : "");
    const value = target[field.key];

    if (field.type === "checkbox") {
      wrap.classList.add("ce-field-check");
      const line = document.createElement("label");
      line.className = "editor-form-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      cb.addEventListener("change", () => {
        target[field.key] = cb.checked;
        touch();
      });
      line.appendChild(cb);
      line.appendChild(document.createTextNode(` ${field.label}`));
      wrap.appendChild(line);
      return wrap;
    }

    const label = document.createElement("label");
    label.className = "editor-form-label";
    label.textContent = field.label;
    wrap.appendChild(label);

    if (field.type === "flags") {
      const box = document.createElement("div");
      box.className = "editor-flags";
      for (const flag of CREATURE_FLAGS) {
        const id = `flag-${flag.bit}`;
        const line = document.createElement("label");
        line.className = "editor-form-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = id;
        cb.checked = (Number(value) & flag.bit) !== 0;
        cb.addEventListener("change", () => {
          target[field.key] = cb.checked ? Number(target[field.key]) | flag.bit : Number(target[field.key]) & ~flag.bit;
          touch();
        });
        line.appendChild(cb);
        line.appendChild(document.createTextNode(` ${flag.label}`));
        box.appendChild(line);
      }
      wrap.appendChild(box);
      return wrap;
    }

    if (field.type === "asset" || field.type === "sheet") {
      wrap.appendChild(this.renderAssetField(field, target, touch));
      return wrap;
    }

    if (field.type === "money") {
      wrap.appendChild(this.renderMoneyField(field, value, target, touch));
      return wrap;
    }

    if (field.type === "select") {
      const options = field.options?.() ?? [];
      const select = document.createElement("select");
      select.className = "editor-form-input";
      for (const option of options) {
        const el = document.createElement("option");
        el.value = String(option.value);
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = String(value ?? "");
      select.addEventListener("change", () => {
        const raw = select.value;
        target[field.key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
        touch();
        if (field.rerender) this.renderForm();
      });
      wrap.appendChild(select);
      return wrap;
    }

    const input = document.createElement("input");
    input.className = "editor-form-input";
    input.type = field.type === "number" ? "number" : "text";
    input.spellcheck = false;
    if (field.step) input.step = String(field.step);
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      if (field.type === "number") target[field.key] = input.value === "" ? null : Number(input.value);
      else target[field.key] = input.value;
      touch();
    });
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * Gold, silver and copper inputs for an amount stored as a single copper
   * total (what the server keeps and drops). Silver and copper are 0-99; each
   * edit writes the combined total back to the draft.
   */
  private renderMoneyField(field: Field, value: unknown, target: any, touch: () => void): HTMLElement {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const row = document.createElement("div");
    row.className = "ce-money";

    const coins = [
      { name: "Gold", cls: "gold", amount: Math.floor(total / COPPER_PER_GOLD), max: null },
      { name: "Silver", cls: "silver", amount: Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER), max: 99 },
      { name: "Copper", cls: "copper", amount: total % COPPER_PER_SILVER, max: 99 },
    ];
    const inputs: HTMLInputElement[] = [];
    const write = () => {
      const [gold, silver, copper] = inputs.map((input) => Math.max(0, Math.floor(Number(input.value) || 0)));
      target[field.key] = gold * COPPER_PER_GOLD + silver * COPPER_PER_SILVER + copper;
      touch();
    };

    for (const coin of coins) {
      const part = document.createElement("label");
      part.className = `ce-money-part ce-money-${coin.cls}`;
      const input = document.createElement("input");
      input.className = "editor-form-input";
      input.type = "number";
      input.min = "0";
      if (coin.max !== null) input.max = String(coin.max);
      input.step = "1";
      input.value = String(coin.amount);
      input.setAttribute("aria-label", `${field.label} ${coin.name.toLowerCase()}`);
      input.addEventListener("input", write);
      // On leaving the box, tidy it: whole numbers, and silver/copper capped at 99.
      input.addEventListener("change", () => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        input.value = String(coin.max === null ? n : Math.min(coin.max, n));
        write();
      });
      inputs.push(input);
      part.appendChild(input);
      // The same coin icons as the in-game currency display (game.css).
      const unit = document.createElement("span");
      unit.className = `currency-icon currency-icon-${coin.cls} ce-money-icon`;
      part.title = coin.name;
      part.appendChild(unit);
      row.appendChild(part);
    }
    return row;
  }

  private renderPathPoints(focusWait: string | null = null): void {
    const points = this.draft.points || [];
    const headRow = document.createElement("div");
    headRow.className = "ce-points-head";
    const header = document.createElement("div");
    header.className = "sidebar-section-header";
    header.textContent = `Points (${points.length})`;
    headRow.appendChild(header);
    const draw = document.createElement("button");
    draw.type = "button";
    draw.className = "ce-card-btn";
    draw.textContent = "Draw Path";
    draw.title = "Draw points in the world";
    draw.addEventListener("click", () => this.drawPath());
    headRow.appendChild(draw);
    this.extraEl.appendChild(headRow);
    points.forEach((p: any, i: number) => {
      const row = document.createElement("div");
      row.className = "ce-point-row";
      const label = document.createElement("span");
      label.className = "ce-point-label";
      label.textContent = `#${i + 1}: ${p.x}, ${p.y}`;
      const wait = document.createElement("input");
      wait.className = "editor-form-input";
      wait.type = "number";
      wait.value = String(p.wait_ms ?? 0);
      wait.title = "Wait at this point (ms)";
      wait.dataset.waitIndex = String(i);
      wait.addEventListener("input", () => {
        p.wait_ms = Number(wait.value) || 0;
        this.dirty = true;
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "editor-danger-btn";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        points.splice(i, 1);
        this.dirty = true;
        this.renderForm();
      });
      row.appendChild(label);
      row.appendChild(wait);
      row.appendChild(remove);
      this.extraEl.appendChild(row);
    });
    // A live update rebuilt the list under a focused wait box: hand focus back
    // so typing continues where it left off.
    if (focusWait !== null) {
      this.extraEl.querySelector<HTMLInputElement>(`input[data-wait-index="${focusWait}"]`)?.focus();
    }
  }

  /** Read-only summary of what a template ends up with in game. */
  private renderTemplateSummary(): void {
    const t = this.draft;
    const abilities = this.data.abilities.filter((a: any) => a.template_id === t.id).length;
    const spawns = this.data.spawns.filter((s: any) => s.template_id === t.id).length;
    const health = (level: number) => Math.round(Number(t.health_base) + Number(t.health_per_level) * (level - 1));
    const box = document.createElement("div");
    box.className = "editor-summary";
    box.textContent =
      `Health ${health(Number(t.level_min))} at level ${t.level_min}, ${health(Number(t.level_max))} at level ${t.level_max}. ` +
      `${abilities} abilit${abilities === 1 ? "y" : "ies"}, ${spawns} spawn point${spawns === 1 ? "" : "s"}.` +
      (abilities === 0 ? " No abilities: this creature cannot attack." : "");
    this.extraEl.appendChild(box);
  }

  // ----------------------------------------------------------------- actions

  private packetFor(action: "SAVE" | "DELETE"): string {
    const suffix: Record<string, string> = {
      templates: "TEMPLATE",
      appearance: "TEMPLATE",
      rewards: "TEMPLATE",
      abilities: "TEMPLATE",
      spawns: "SPAWN",
      paths: "PATH",
      linkGroups: "LINKGROUP",
      pools: "POOL",
    };
    return `CREATURE_EDITOR_${action}_${suffix[this.tab]}`;
  }

  private save(): void {
    if (!this.draft) return;
    if (TEMPLATE_TABS.has(this.tab)) {
      // The creature's own fields go first when changed (a new creature needs
      // its id); its abilities follow from the result handler.
      if (this.dirty || !this.draft.id) this.sendEntry("template");
      else if (this.abilitiesDirty) this.sendAbilities();
      else this.status("Nothing to save");
      return;
    }
    this.sendEntry("other");
  }

  private sendEntry(kind: "template" | "other"): void {
    const payload = { ...this.draft };
    // The server treats 0 as "no relation" for optional links.
    for (const key of ["patrol_path_id", "link_group_id", "pool_id", "loot_table_id", "rare_template_id"]) {
      if (payload[key] === 0) payload[key] = null;
    }
    this.pendingSave = kind;
    this.send({ type: "request", packet: this.packetFor("SAVE"), data: payload });
    this.status("Saving...");
  }

  /** The selected creature's whole ability list, saved as one. */
  private sendAbilities(): void {
    this.pendingSave = "abilities";
    this.send({
      type: "request",
      packet: "CREATURE_EDITOR_SAVE_ABILITIES",
      data: { template_id: this.draft.id, abilities: this.abilityDraft },
    });
    this.status("Saving abilities...");
  }

  private deleteEntry(): void {
    if (!this.draft?.id) return;
    if (!confirm("Delete this entry? Creatures using it are removed too.")) return;
    this.pendingSave = "other";
    this.send({ type: "request", packet: this.packetFor("DELETE"), data: { id: this.draft.id } });
    this.draft = null;
    this.selectedId = null;
    this.abilityDraft = [];
    this.abilitiesDirty = false;
    this.updateChrome();
  }

  private placeSpawn(): void {
    if (this.tab !== "spawns" || !this.draft) {
      this.status("Open the Spawns tab and select or create a spawn first");
      return;
    }
    this.send({ type: "placeSpawn" });
    this.status("Click in the game window to place the spawn");
  }

  private drawPath(): void {
    if (this.tab !== "paths" || !this.draft) {
      this.status("Open the Patrol Paths tab and select or create a path first");
      return;
    }
    this.send({ type: "drawPath", points: this.draft.points || [] });
    this.status("Click in the game window to add points — they appear below as you click (Enter/Esc to finish)");
  }

  private goto(): void {
    if (this.tab !== "spawns" || !this.draft?.id) {
      this.status("Select a saved spawn first");
      return;
    }
    this.send({ type: "request", packet: "CREATURE_EDITOR_ACTION", data: { action: "goto", spawnId: this.draft.id } });
  }
}

new CreatureEditorBridge();
