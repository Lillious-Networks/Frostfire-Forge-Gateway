// Creature editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.

import { FieldRenderer, orderFields, pick, sheetOptions, type AssetOption, type Field } from "./editorfields.js";

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

/** Tabs that edit one creature: the same creature list, and selection carries across. */
const TEMPLATE_TABS = new Set(["templates", "appearance", "rewards", "abilities", "spawns"]);

type SaveKind = "template" | "abilities" | "spawn" | "spawnDelete" | "delete" | "other";

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

class CreatureEditorBridge {
  private data: any = { templates: [], abilities: [], spawns: [], patrolPaths: [], linkGroups: [], pools: [], spells: [], lootTables: [], maps: [], triggers: [], targetModes: [], spriteSheets: {}, icons: [] };
  private fieldRenderer = new FieldRenderer({
    assetOptions: (field, value) => this.assetOptionsFor(field, value),
    rerender: () => this.renderForm(),
    flags: CREATURE_FLAGS,
  });
  private tab = "templates";
  private selectedId: number | null = null;
  private draft: any = null;
  private search = "";
  private dirty = false;
  /** The selected creature's abilities being edited on the Abilities tab. */
  private abilityDraft: any[] = [];
  private abilitiesDirty = false;
  /**
   * The spawn open on the selected creature's Spawns tab. Its creature is
   * implied (the selected one), so it has no creature picker.
   */
  private spawnDraft: any = null;
  private spawnDirty = false;
  /** Which save is in flight, so its result clears the right flag. */
  private pendingSave: SaveKind | null = null;
  /**
   * Packet of the save/delete in flight. Save waits for its result: a new
   * entry has no id until then, so a second Save would insert it again.
   */
  private pendingPacket: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Section to open once the in-flight save succeeds (Save in the leave prompt). */
  private afterSaveTab: string | null = null;

  private listEl = document.getElementById("ce-list")!;
  private listTitle = document.getElementById("ce-list-title")!;
  private fieldsEl = document.getElementById("ce-form-fields")!;
  private extraEl = document.getElementById("ce-extra")!;
  private errorsEl = document.getElementById("ce-errors")!;
  private statusEl = document.getElementById("ce-status")!;
  private searchInput = document.getElementById("ce-search") as HTMLInputElement;

  constructor() {
    document.getElementById("btn-save")!.addEventListener("click", () => this.save());
    // Field edits flag changes without re-rendering; refresh the save icon
    // after any edit (the field's own handler has run by the time this does).
    for (const type of ["input", "change", "click"]) {
      document.addEventListener(type, () => queueMicrotask(() => this.updateSaveIcon()));
    }
    (document.getElementById("chk-debug") as HTMLInputElement).addEventListener("change", (e) => {
      this.send({ type: "debug", on: (e.target as HTMLInputElement).checked });
    });
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value.toLowerCase();
      this.renderList();
    });
    document.querySelectorAll(".editor-tab-btn, .ce-section-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.requestTab(btn.getAttribute("data-tab")!));
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
      // Same for the open spawn; one deleted elsewhere closes.
      if (this.spawnDraft?.id && !this.spawnDirty) {
        const fresh = (this.data.spawns ?? []).find((s: any) => s.id === this.spawnDraft.id);
        this.spawnDraft = fresh ? JSON.parse(JSON.stringify(fresh)) : null;
      }
      this.renderList();
      this.renderForm();
      this.status("Loaded");
    } else if (msg.type === "result") {
      // Only the in-flight save/delete's own result counts: others (Go to)
      // must not clear unsaved changes or release the pending save.
      if (!this.pendingPacket || (msg.action && msg.action !== this.pendingPacket)) {
        if (!msg.ok) this.showErrors(msg.errors || ["Action failed."]);
        return;
      }
      const saved = this.pendingSave;
      this.endRequest();
      if (msg.ok) {
        if (saved === "abilities") {
          this.abilitiesDirty = false;
        } else if (saved === "spawn") {
          this.spawnDirty = false;
          // A new spawn now exists: later saves must update it, not insert again.
          if (msg.id && this.spawnDraft && !this.spawnDraft.id) this.spawnDraft.id = msg.id;
        } else if (saved === "spawnDelete") {
          // The open spawn only closes if it was the one deleted (cleared in deleteSpawn).
        } else if (saved === "delete") {
          // Deleting a list entry leaves the open entry's unsaved edits alone.
        } else {
          this.dirty = false;
          if (msg.id && this.draft) {
            this.selectedId = msg.id;
            // A new entry now exists: later saves must update it, not insert again.
            if (!this.draft.id) this.draft.id = msg.id;
          }
        }
        const deleted = saved === "delete" || saved === "spawnDelete";
        // One Save covers the whole creature: fields first (a new creature
        // needs its id), then abilities, then the open spawn.
        if (!deleted && this.saveNextDirty()) return;
        this.showErrors([]);
        this.status(deleted ? "Deleted" : "Saved");
        this.updateSaveIcon();
        this.send({ type: "request", packet: "CREATURE_EDITOR_LIST", data: null });
        // Saved from the leave prompt: now go where the user was heading.
        const next = this.afterSaveTab;
        this.afterSaveTab = null;
        if (next) this.switchTab(next);
      } else {
        // A failed save keeps the user here, with the errors, instead of leaving.
        this.afterSaveTab = null;
        this.showErrors(msg.errors || ["Save failed."]);
        this.status("Not saved");
      }
    } else if (msg.type === "updated") {
      this.status(`Updated by ${msg.by}`);
      this.send({ type: "request", packet: "CREATURE_EDITOR_LIST", data: null });
    } else if (msg.type === "pointPicked") {
      // The game window collected a world position / path for the current draft.
      if (msg.what === "spawn" && this.spawnDraft) {
        this.spawnDraft.x = msg.x;
        this.spawnDraft.y = msg.y;
        this.spawnDraft.map = msg.map;
        this.spawnDirty = true;
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
      case "spawns":
        // Drawn as cards (renderAbilities / renderSpawns), not as form fields.
        return [];
      case "rewards":
      case "appearance":
        return this.templateSectionFields(this.tab, none);
      case "paths":
        return [
          { key: "map", label: "Map", type: "asset", assets: () => this.data.maps.map((m: string) => ({ value: m, label: m })) },
          { key: "loop", label: "Loop", type: "checkbox", hint: "Walks back to the first point. Otherwise it walks back and forth." },
        ];
      case "linkGroups":
        return [{ key: "name", label: "Name", type: "text", hint: "Spawns in the same link group are pulled together." }];
      case "pools":
        return [
          { key: "max_active", label: "Max alive at once", type: "number", hint: "How many of the pool's spawn points can be alive together." },
          { key: "rare_chance_pct", label: "Rare chance %", type: "number", hint: "Chance a respawn is the rare creature instead. Never two rares at once." },
          { key: "rare_template_id", label: "Rare creature", type: "asset", assets: templateOptions },
        ];
      default:
        return [
          { key: "name", label: "Name", type: "text" },
          { key: "subname", label: "Title", type: "text", hint: "Shown under the name, e.g. <Blacksmith>." },
          { key: "level_min", label: "Level min", type: "number", hint: "Each spawn picks a level between min and max." },
          { key: "level_max", label: "Level max", type: "number" },
          { key: "rank", label: "Rank", type: "select", options: pick(["normal", "elite", "rare", "rare_elite", "boss"]) },
          { key: "creature_type", label: "Type", type: "select", options: pick(["beast", "humanoid", "undead", "elemental", "demon", "dragonkin", "critter", "mechanical"]) },
          { key: "stance", label: "Stance", type: "select", options: pick(["aggressive", "neutral", "passive"]), hint: "Aggressive attacks players who come close. Neutral fights back. Passive runs when hit." },
          { key: "health_base", label: "Health at level 1", type: "number" },
          { key: "health_per_level", label: "Health per level", type: "number", hint: "Added for each level above 1." },
          { key: "armor", label: "Armor", type: "number" },
          { key: "ranged", label: "Keeps its distance (stops at range)", type: "checkbox" },
          { key: "move_speed_walk", label: "Walk speed (yd/s)", type: "number", step: 0.1, hint: "Used when idle, wandering or patrolling." },
          { key: "move_speed_run", label: "Run speed (yd/s)", type: "number", step: 0.1, hint: "Used when chasing or fleeing." },
          { key: "leash_override", label: "Leash range (yards)", type: "number", hint: "How far it chases from where the fight started before resetting. Empty = 60." },
          { key: "aggro_radius_override", label: "Aggro radius (yards)", type: "number", hint: "Empty = 20. Grows or shrinks 1 yard per level of difference to the player." },
          { key: "assist_radius", label: "Assist radius (yards)", type: "number", hint: "Idle allies this close join in when it is pulled." },
          { key: "call_for_help_radius", label: "Call for help radius (yards)", type: "number", hint: "Idle allies this close join in when it flees." },
          { key: "flee_at_hp_pct", label: "Flee at health %", type: "number", hint: "0 = never flees." },
          { key: "flee_duration_ms", label: "Flee duration (ms)", type: "number" },
          { key: "regen_ooc", label: "Regenerates out of combat", type: "checkbox" },
          { key: "flags", label: "Flags", type: "flags" },
        ];
    }
  }

  /** Fields of one spawn. The creature is implied: the one selected. */
  private spawnFields(): Field[] {
    const none = { value: 0, label: "None" };
    return [
          { key: "map", label: "Map", type: "asset", noIcons: true, assets: () => this.data.maps.map((m: string) => ({ value: m, label: m })) },
          { key: "x", label: "X", type: "number" },
          { key: "y", label: "Y", type: "number" },
          { key: "direction", label: "Facing", type: "select", options: pick(["down", "up", "left", "right"]) },
          { key: "layer_policy", label: "Layers", type: "select", options: pick(["per_layer", "shared"]), hint: "per_layer: one creature on every layer. shared: one creature all layers see." },
          { key: "respawn_min_s", label: "Respawn min (s)", type: "number", hint: "Respawn time is picked between min and max." },
          { key: "respawn_max_s", label: "Respawn max (s)", type: "number" },
          { key: "movement_type", label: "Movement", type: "select", options: pick(["idle", "wander", "patrol"]) },
          { key: "wander_radius", label: "Wander radius (yards)", type: "number", hint: "Only used with wander movement." },
          { key: "patrol_path_id", label: "Patrol path", type: "asset", noIcons: true, hint: "Only used with patrol movement.", assets: () => [none, ...this.data.patrolPaths.map((p: any) => ({ value: p.id, label: `#${p.id} ${p.map}` }))] },
          { key: "link_group_id", label: "Link group", type: "asset", noIcons: true, hint: "Linked spawns are pulled together.", assets: () => [none, ...this.data.linkGroups.map((g: any) => ({ value: g.id, label: g.name }))] },
          { key: "pool_id", label: "Spawn pool", type: "asset", noIcons: true, hint: "Caps how many spawns in the pool are alive at once.", assets: () => [none, ...this.data.pools.map((p: any) => ({ value: p.id, label: `#${p.id}` }))] },
    ];
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
          { key: "xp_mult", label: "XP multiplier", type: "number", step: 0.1, hint: "1 = normal XP for its level." },
          { key: "loot_table_id", label: "Loot table", type: "asset", noIcons: true, hint: "Items rolled into its corpse.", assets: () => [none, ...this.data.lootTables.map((t: any) => ({ value: t.id, label: t.name }))] },
          { key: "gold_min", label: "Money min", type: "money", newRow: true, hint: "Money dropped is picked between min and max." },
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
          { key: "scale", label: "Scale", type: "number", step: 0.1, hint: "1 = normal size. Bigger creatures also reach further in melee." },
        ];
      }
    }
  }

  private assetOptionsFor(field: Field, value: unknown): AssetOption[] {
    return field.type === "sheet"
      ? sheetOptions(this.data.spriteSheets, field.slot || "other", String(value ?? ""))
      : field.assets?.() ?? [];
  }

  private blank(): any {
    switch (this.tab) {
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
  private blankSpawn(): any {
    const mine = (this.data.spawns ?? []).filter((s: any) => s.template_id === this.draft?.id);
    const map = mine[mine.length - 1]?.map ?? this.data.maps[0] ?? "";
    return { id: 0, map, x: 0, y: 0, direction: "down", layer_policy: "per_layer", respawn_min_s: 120, respawn_max_s: 180, wander_radius: 0, movement_type: "idle", patrol_path_id: 0, link_group_id: 0, pool_id: 0 };
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

  /**
   * A tab or section click. Moving between a creature's own pages keeps its
   * edits; moving to another section drops the selection, so unsaved changes
   * get a Save / Discard / Cancel prompt first.
   */
  private requestTab(tab: string): void {
    if (tab === this.tab) return;
    const sameTemplate = TEMPLATE_TABS.has(this.tab) && TEMPLATE_TABS.has(tab);
    if (sameTemplate || !this.hasUnsaved || !this.draft) {
      this.switchTab(tab);
      return;
    }
    if (this.pendingPacket) {
      this.status("Saving...");
      return;
    }
    this.promptUnsaved(tab);
  }

  private promptUnsaved(tab: string): void {
    const overlay = document.createElement("div");
    overlay.className = "editor-modal-overlay";
    const box = document.createElement("div");
    box.className = "editor-modal-box";
    box.innerHTML =
      '<h3>Unsaved changes</h3><p></p><div class="editor-modal-actions">' +
      '<button type="button" data-choice="cancel">Cancel</button>' +
      '<button type="button" class="btn-danger" data-choice="discard">Discard</button>' +
      '<button type="button" class="btn-primary" data-choice="save">Save</button></div>';
    const name = TEMPLATE_TABS.has(this.tab) ? this.draft?.name : null;
    box.querySelector("p")!.textContent = `Save your changes${name ? ` to ${name}` : ""} before leaving?`;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    box.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const choice = btn.getAttribute("data-choice");
        close();
        if (choice === "discard") {
          this.switchTab(tab);
        } else if (choice === "save") {
          // Leave only once the server confirms; a failed save stays put.
          this.afterSaveTab = tab;
          this.save();
          // Nothing was actually sent (nothing to save): just go.
          if (!this.pendingPacket) {
            this.afterSaveTab = null;
            this.switchTab(tab);
          }
        }
      });
    });
    (box.querySelector('[data-choice="save"]') as HTMLElement).focus();
  }

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
      this.spawnDraft = null;
      this.spawnDirty = false;
      this.showErrors([]);
    }
    const creature = TEMPLATE_TABS.has(tab);
    document.querySelectorAll(".editor-tab-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    document.querySelectorAll(".ce-section-btn").forEach((b) => {
      const section = b.getAttribute("data-tab");
      b.classList.toggle("active", creature ? section === "templates" : section === tab);
    });
    // A creature's pages only make sense in the Creatures section.
    document.getElementById("editor-tab-bar")!.hidden = !creature;
    this.listTitle.textContent = creature
      ? "Creatures"
      : (document.querySelector(`.ce-section-btn[data-tab="${tab}"]`) as HTMLElement)?.textContent ?? "Entries";
    this.renderList();
    this.renderForm();
  }

  private renderList(): void {
    const entries = this.collection.filter((e: any) => !this.search || this.label(e).toLowerCase().includes(this.search));
    this.listEl.innerHTML = "";
    // Every section creates entries from a pinned row at the top of its list.
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
        if (this.hasUnsaved && !confirm("Discard unsaved changes?")) return;
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
      row.appendChild(this.rowDeleteButton(`Delete ${this.label(entry)}`, () => this.deleteEntry(entry)));
      row.addEventListener("click", () => this.select(entry.id));
      this.listEl.appendChild(row);
    }
  }

  /** Trash icon on a list row; deletes that row's entry without selecting it. */
  private rowDeleteButton(title: string, onDelete: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-row-delete";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = TRASH_ICON;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete();
    });
    return btn;
  }

  private select(id: number): void {
    if (this.hasUnsaved && !confirm("Discard unsaved changes?")) return;
    this.selectedId = id;
    this.draft = JSON.parse(JSON.stringify(this.collection.find((e: any) => e.id === id) ?? this.blank()));
    this.dirty = false;
    this.abilitiesDirty = false;
    this.spawnDraft = null;
    this.spawnDirty = false;
    this.loadAbilityDraft();
    this.showErrors([]);
    this.renderList();
    this.renderForm();
  }

  /** Label of the pinned creation row at the top of the current section's list. */
  private newRowLabel(): string {
    switch (this.tab) {
      case "paths": return "New patrol path";
      case "linkGroups": return "New link group";
      case "pools": return "New spawn pool";
      default: return "New creature";
    }
  }

  private newEntry(): void {
    // A new creature starts on its General page, whichever creature page was open.
    if (TEMPLATE_TABS.has(this.tab) && this.tab !== "templates") this.switchTab("templates");
    this.selectedId = 0;
    this.draft = this.blank();
    this.dirty = true;
    this.abilityDraft = [];
    this.abilitiesDirty = false;
    this.spawnDraft = null;
    this.spawnDirty = false;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
    this.status("New entry - fill it in and save");
  }

  private renderForm(): void {
    this.updateChrome();
    this.fieldsEl.innerHTML = "";
    this.extraEl.innerHTML = "";
    if (!this.draft) {
      this.fieldsEl.innerHTML = `<div class="editor-empty">Select an entry, or create one from the top of the list.</div>`;
      return;
    }
    // Live point updates re-render the form while a wait box may be focused;
    // remember it so typing there is not interrupted.
    const focusedWait = (document.activeElement as HTMLElement | null)?.dataset?.waitIndex ?? null;

    // Which entry this is, on every page (the pages without a name field too).
    const heading = document.createElement("div");
    heading.className = "editor-page-title";
    heading.textContent = this.pageTitle();
    const sub = document.createElement("span");
    sub.className = "editor-page-sub";
    sub.textContent = this.draft.id ? `#${this.draft.id}` : "not saved yet";
    heading.appendChild(sub);
    this.fieldsEl.appendChild(heading);
    // What the creature ends up with in game, before the details.
    if (this.tab === "templates" && this.draft.id) this.renderTemplateSummary();

    for (const group of this.formCards()) {
      const grid = this.card(this.fieldsEl, group.title, group.sub);
      for (const field of orderFields(group.fields)) grid.appendChild(this.renderField(field));
    }
    if (this.tab === "paths") this.renderPathPoints(focusedWait);
    if (this.tab === "abilities") this.renderAbilities();
    if (this.tab === "spawns") this.renderSpawns();
  }

  private pageTitle(): string {
    if (TEMPLATE_TABS.has(this.tab)) return this.draft.name || "New creature";
    switch (this.tab) {
      case "paths": return this.draft.id ? `Patrol path on ${this.draft.map || "?"}` : "New patrol path";
      case "linkGroups": return this.draft.name || "New link group";
      case "pools": return this.draft.id ? "Spawn pool" : "New spawn pool";
      default: return "Entry";
    }
  }

  /** The current page's fields, grouped into titled cards. */
  private formCards(): Array<{ title: string; sub?: string; fields: Field[] }> {
    const fields = this.fields();
    if (fields.length === 0) return [];
    if (this.tab !== "templates") {
      const titles: Record<string, string> = {
        appearance: "Appearance", rewards: "Rewards", paths: "Patrol path", linkGroups: "Link group", pools: "Spawn pool",
      };
      return [{ title: titles[this.tab] ?? "Details", fields }];
    }
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const taken = new Set<string>();
    const take = (keys: string[]) => keys.map((k) => byKey.get(k)).filter((f): f is Field => !!f && !taken.has(f.key) && !!taken.add(f.key));
    const groups: Array<{ title: string; sub?: string; fields: Field[] }> = [
      { title: "Identity", fields: take(["name", "subname", "level_min", "level_max", "rank", "creature_type"]) },
      { title: "Combat", fields: take(["stance", "health_base", "health_per_level", "armor", "ranged"]) },
      { title: "Movement", fields: take(["move_speed_walk", "move_speed_run", "leash_override"]) },
      { title: "Awareness", sub: "How it notices players and gets help", fields: take(["aggro_radius_override", "assist_radius", "call_for_help_radius"]) },
      { title: "Fleeing & recovery", fields: take(["flee_at_hp_pct", "flee_duration_ms", "regen_ooc"]) },
      { title: "Flags", fields: take(["flags"]) },
    ];
    // A field added to fields() but not to a group above still shows up.
    groups.push({ title: "Other", fields: fields.filter((f) => !taken.has(f.key)) });
    return groups.filter((group) => group.fields.length > 0);
  }

  /**
   * A titled card appended to `parent`; returns its field grid. `action` goes
   * at the right of the header (a × or a button).
   */
  private card(parent: HTMLElement, title: string, sub?: string, action?: HTMLElement): HTMLElement {
    const card = document.createElement("div");
    card.className = "editor-card";
    const head = document.createElement("div");
    head.className = "editor-card-head";
    const titleEl = document.createElement("span");
    titleEl.className = "editor-card-title";
    titleEl.textContent = title;
    head.appendChild(titleEl);
    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "editor-card-sub";
      subEl.textContent = sub;
      subEl.title = sub;
      head.appendChild(subEl);
    }
    if (action) head.appendChild(action);
    card.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "editor-card-grid";
    card.appendChild(grid);
    parent.appendChild(card);
    return grid;
  }

  private removeButton(title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-card-btn-x";
    btn.textContent = "×";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private addButton(parent: HTMLElement, label: string, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-card-btn editor-add-btn";
    btn.textContent = `+ ${label}`;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  /**
   * The selected creature's spawn points: a list to pick from, and the picked
   * one's fields. The toolbar Save stores it along with the creature.
   */
  private renderSpawns(): void {
    if (!this.draft.id) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "Save this creature before adding spawn points.";
      this.extraEl.appendChild(empty);
      return;
    }
    const mine = (this.data.spawns ?? []).filter((s: any) => s.template_id === this.draft.id);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "ce-card-btn";
    add.textContent = "+ New spawn";
    add.addEventListener("click", () => {
      if (this.spawnDirty && !confirm("Discard unsaved spawn changes?")) return;
      this.spawnDraft = this.blankSpawn();
      this.spawnDirty = true;
      this.renderForm();
      this.status("New spawn - place it in the world, then save");
    });
    const listGrid = this.card(this.extraEl, `Spawn points (${mine.length})`, "Where this creature appears in the world", add);

    const list = document.createElement("div");
    list.className = "ce-spawn-list ce-field-wide";
    listGrid.appendChild(list);
    for (const spawn of mine) {
      const row = document.createElement("div");
      row.className = "editor-item" + (this.spawnDraft?.id === spawn.id ? " active" : "");
      const text = document.createElement("span");
      text.className = "editor-item-label";
      text.textContent = `#${spawn.id} ${spawn.map} (${spawn.x}, ${spawn.y})`;
      row.appendChild(text);
      row.appendChild(this.rowDeleteButton(`Delete spawn #${spawn.id}`, () => this.deleteSpawn(spawn)));
      row.addEventListener("click", () => {
        if (this.spawnDraft?.id === spawn.id) return;
        if (this.spawnDirty && !confirm("Discard unsaved spawn changes?")) return;
        this.spawnDraft = JSON.parse(JSON.stringify(spawn));
        this.spawnDirty = false;
        this.renderForm();
      });
      list.appendChild(row);
    }
    if (mine.length === 0 && !this.spawnDraft) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No spawn points: this creature never appears in the world.";
      list.appendChild(empty);
    }

    if (!this.spawnDraft) return;
    // Saved spawns are deleted from their list row; a new one can only be discarded.
    let discard: HTMLElement | undefined;
    if (!this.spawnDraft.id) {
      discard = document.createElement("button");
      (discard as HTMLButtonElement).type = "button";
      discard.className = "ce-card-btn ce-card-btn-danger";
      discard.textContent = "Discard";
      discard.addEventListener("click", () => {
        this.spawnDraft = null;
        this.spawnDirty = false;
        this.renderForm();
      });
    }
    const where = this.spawnDraft.map ? `${this.spawnDraft.map} (${this.spawnDraft.x}, ${this.spawnDraft.y})` : undefined;
    const grid = this.card(this.extraEl, this.spawnDraft.id ? `Spawn #${this.spawnDraft.id}` : "New spawn (unsaved)", where, discard);
    const touch = () => {
      this.spawnDirty = true;
    };
    for (const field of orderFields(this.spawnFields())) {
      grid.appendChild(this.renderField(field, this.spawnDraft, touch));
      // World placement sits with the position it sets.
      if (field.key === "y") grid.appendChild(this.renderSpawnActions());
    }
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
      const remove = this.removeButton("Remove ability", () => {
        this.abilityDraft.splice(index, 1);
        touch();
        this.renderForm();
      });
      const grid = this.card(this.extraEl, `Ability ${index + 1}`, `${spellName(Number(ability.spell_id))} · ${ability.trigger}`, remove);
      for (const field of orderFields(this.abilityFields())) grid.appendChild(this.renderField(field, ability, touch));
    });

    this.addButton(this.extraEl, "Add ability", () => {
      this.abilityDraft.push(this.blankAbility());
      touch();
      this.renderForm();
    });
  }

  /**
   * Buttons and tabs that act on the current entry stay hidden until something
   * is selected or being created, instead of opening blank menus.
   */
  private updateChrome(): void {
    const has = !!this.draft;
    document.getElementById("btn-save")!.hidden = !has;
    document
      .querySelectorAll('.editor-tab-btn[data-tab="appearance"], .editor-tab-btn[data-tab="rewards"], .editor-tab-btn[data-tab="abilities"], .editor-tab-btn[data-tab="spawns"]')
      .forEach((btn) => ((btn as HTMLElement).hidden = !has));
    this.updateSaveIcon();
  }

  /** Save icon: faded with nothing to save, highlighted with unsaved changes. */
  private updateSaveIcon(): void {
    const btn = document.getElementById("btn-save");
    if (!btn) return;
    const changes = !!this.draft && this.hasUnsaved;
    btn.classList.toggle("has-changes", changes);
    btn.classList.toggle("saving", !!this.pendingPacket);
    btn.title = this.pendingPacket ? "Saving..." : changes ? "Save changes (Ctrl+S)" : "No unsaved changes";
  }

  /**
   * One form field. It edits `target[field.key]` (the selected entry's draft
   * unless given, e.g. an ability card's own ability) and calls `touch` on change.
   */
  private renderField(field: Field, target: any = this.draft, touch: () => void = () => { this.dirty = true; }): HTMLElement {
    return this.fieldRenderer.renderField(field, target, touch);
  }

  /** Place in World / Go To, shown under the spawn's map and position. */
  private renderSpawnActions(): HTMLElement {
    const row = document.createElement("div");
    row.className = "ce-field ce-field-wide ce-spawn-actions";
    const place = document.createElement("button");
    place.type = "button";
    place.className = "ce-card-btn";
    place.textContent = "Place in World";
    place.title = "Click in the game window to set this spawn's map and position";
    place.addEventListener("click", () => this.placeSpawn());
    const goto = document.createElement("button");
    goto.type = "button";
    goto.className = "ce-card-btn";
    goto.textContent = "Go To";
    goto.disabled = !this.spawnDraft?.id;
    goto.title = this.spawnDraft?.id ? "Teleport to this spawn" : "Save the spawn first";
    goto.addEventListener("click", () => this.goto());
    row.appendChild(place);
    row.appendChild(goto);
    return row;
  }

  private renderPathPoints(focusWait: string | null = null): void {
    const points = this.draft.points || [];
    const draw = document.createElement("button");
    draw.type = "button";
    draw.className = "ce-card-btn";
    draw.textContent = "Draw Path";
    draw.title = "Draw points in the world";
    draw.addEventListener("click", () => this.drawPath());
    const grid = this.card(this.extraEl, `Points (${points.length})`, "Wait = how long it pauses at the point (ms)", draw);
    const rows = document.createElement("div");
    rows.className = "ce-point-list ce-field-wide";
    grid.appendChild(rows);
    if (points.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No points yet: press Draw Path and click in the game window.";
      rows.appendChild(empty);
    }
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
      const remove = this.removeButton(`Remove point #${i + 1}`, () => {
        points.splice(i, 1);
        this.dirty = true;
        this.renderForm();
      });
      row.appendChild(label);
      row.appendChild(wait);
      row.appendChild(remove);
      rows.appendChild(row);
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
    const min = Number(t.level_min);
    const max = Number(t.level_max);
    // A fixed-level creature has one health value; a range shows both ends.
    const healthText = min === max
      ? `Health ${health(min)} at level ${min}.`
      : `Health ${health(min)} at level ${min}, ${health(max)} at level ${max}.`;
    box.textContent =
      `${healthText} ` +
      `${abilities} abilit${abilities === 1 ? "y" : "ies"}, ${spawns} spawn point${spawns === 1 ? "" : "s"}.` +
      (abilities === 0 ? " No abilities: this creature cannot attack." : "");
    this.fieldsEl.appendChild(box);
  }

  // ----------------------------------------------------------------- actions

  private packetFor(action: "SAVE" | "DELETE"): string {
    const suffix: Record<string, string> = {
      templates: "TEMPLATE",
      appearance: "TEMPLATE",
      rewards: "TEMPLATE",
      abilities: "TEMPLATE",
      spawns: "TEMPLATE",
      paths: "PATH",
      linkGroups: "LINKGROUP",
      pools: "POOL",
    };
    return `CREATURE_EDITOR_${action}_${suffix[this.tab]}`;
  }

  /** Anything on the current entry (creature fields, abilities, open spawn) not yet saved. */
  private get hasUnsaved(): boolean {
    return this.dirty || this.abilitiesDirty || this.spawnDirty;
  }

  private save(): void {
    if (!this.draft) return;
    if (this.pendingPacket) {
      this.status("Saving...");
      return;
    }
    if (TEMPLATE_TABS.has(this.tab)) {
      // The creature's own fields go first when changed (a new creature needs
      // its id); abilities and the open spawn follow from the result handler.
      if (this.dirty || !this.draft.id) this.sendEntry("template");
      else if (!this.saveNextDirty()) this.status("Nothing to save");
      return;
    }
    this.sendEntry("other");
  }

  /** Send the creature's next unsaved part (abilities, then the open spawn). */
  private saveNextDirty(): boolean {
    if (!TEMPLATE_TABS.has(this.tab) || !this.draft?.id) return false;
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
    this.beginRequest(kind, this.packetFor("SAVE"), this.withNullLinks(this.draft));
    this.status("Saving...");
  }

  /** The selected creature's whole ability list, saved as one. */
  private sendAbilities(): void {
    this.beginRequest("abilities", "CREATURE_EDITOR_SAVE_ABILITIES", { template_id: this.draft.id, abilities: this.abilityDraft });
    this.status("Saving abilities...");
  }

  /** The open spawn, always bound to the selected creature. */
  private sendSpawn(): void {
    this.beginRequest("spawn", "CREATURE_EDITOR_SAVE_SPAWN", { ...this.withNullLinks(this.spawnDraft), template_id: this.draft.id });
    this.status("Saving spawn...");
  }

  /** Delete a saved spawn from its list row. Closes it if it is the open one. */
  private deleteSpawn(spawn: any): void {
    if (!spawn?.id) return;
    if (this.pendingPacket) {
      this.status("Saving...");
      return;
    }
    if (!confirm(`Delete spawn #${spawn.id}? Its creature is removed from the world.`)) return;
    if (this.spawnDraft?.id === spawn.id) {
      this.spawnDraft = null;
      this.spawnDirty = false;
    }
    this.beginRequest("spawnDelete", "CREATURE_EDITOR_DELETE_SPAWN", { id: spawn.id });
    this.renderForm();
    this.status("Deleting spawn...");
  }

  private beginRequest(kind: SaveKind, packet: string, data: any): void {
    this.pendingSave = kind;
    this.pendingPacket = packet;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (e.g. permissions): don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pendingPacket !== packet) return;
      this.endRequest();
      this.afterSaveTab = null;
      this.status("No response from the server - try again");
      this.updateSaveIcon();
    }, 15000);
    this.send({ type: "request", packet, data });
    this.updateSaveIcon();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingPacket = null;
    this.pendingSave = null;
    this.updateSaveIcon();
  }

  /** Delete a list entry from its row. Closes it if it is the open one. */
  private deleteEntry(entry: any): void {
    if (!entry?.id) return;
    if (this.pendingPacket) {
      this.status("Saving...");
      return;
    }
    const what = TEMPLATE_TABS.has(this.tab)
      ? `creature "${entry.name}"? Its spawn points and creatures in the world are removed too.`
      : `${this.label(entry)}? Creatures using it are removed too.`;
    if (!confirm(`Delete ${what}`)) return;
    if (this.selectedId === entry.id) {
      this.draft = null;
      this.selectedId = null;
      this.dirty = false;
      this.abilityDraft = [];
      this.abilitiesDirty = false;
      this.spawnDraft = null;
      this.spawnDirty = false;
    }
    this.beginRequest("delete", this.packetFor("DELETE"), { id: entry.id });
    this.renderList();
    this.renderForm();
    this.status("Deleting...");
  }

  private placeSpawn(): void {
    if (this.tab !== "spawns" || !this.spawnDraft) {
      this.status("Open a creature's Spawns tab and select or add a spawn first");
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
    if (this.tab !== "spawns" || !this.spawnDraft?.id) {
      this.status("Select a saved spawn first");
      return;
    }
    this.send({ type: "request", packet: "CREATURE_EDITOR_ACTION", data: { action: "goto", spawnId: this.spawnDraft.id } });
  }
}

new CreatureEditorBridge();
