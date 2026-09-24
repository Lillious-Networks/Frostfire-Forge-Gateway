// Item editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
import { applyItemFrame } from "./itemframe.js";

type FieldType = "text" | "textarea" | "number" | "select" | "checkbox" | "asset";

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
  options?: () => AssetOption[];
  assets?: () => AssetOption[];
  hint?: string;
  /** Re-render the form after this field changes (fields that reveal others). */
  rerender?: boolean;
}

// Fallbacks so the dropdowns are never empty, even if the server's option lists
// arrive late or an item carries a value that is no longer offered.
const DEFAULT_TYPES = ["consumable", "equipment", "material", "quest", "miscellaneous"];
const DEFAULT_QUALITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const DEFAULT_SLOTS = [
  "helmet", "necklace", "shoulderguards", "cape", "chestplate", "wristguards", "gloves",
  "belt", "pants", "boots", "ring_1", "ring_2", "trinket_1", "trinket_2", "weapon", "bag",
];

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const QUALITY_COLORS: Record<string, string> = {
  common: "#ffffff",
  uncommon: "#1eff00",
  rare: "#0070dd",
  epic: "#a335ee",
  legendary: "#ff8000",
};

class ItemEditorBridge {
  private data: any = { types: [], qualities: [], slots: [], icons: [], itemCount: 0 };
  private tab = "general";
  /** Name of the item being edited, or null for a new one. */
  private originalName: string | null = null;
  private draft: any = null;
  /** Last search results; the editor never holds the whole item table. */
  private results: any[] = [];
  private truncated = 0;
  private searched = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  private listEl = document.getElementById("ie-list")!;
  private fieldsEl = document.getElementById("ie-form-fields")!;
  private extraEl = document.getElementById("ie-extra")!;
  private errorsEl = document.getElementById("ie-errors")!;
  private statusEl = document.getElementById("ie-status")!;
  private searchInput = document.getElementById("ie-search") as HTMLInputElement;

  constructor() {
    document.getElementById("btn-save")!.addEventListener("click", () => this.save());
    // Field edits flag changes without re-rendering; refresh the save icon
    // after any edit (the field's own handler has run by the time this does).
    for (const type of ["input", "change", "click"]) {
      document.addEventListener(type, () => queueMicrotask(() => this.updateSaveIcon()));
    }
    // Searching asks the server; the client never holds every item.
    this.searchInput.addEventListener("input", () => this.queueSearch());
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.runSearch();
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
      this.renderList();
      this.renderForm();
      this.status(`${this.data.itemCount ?? 0} items - search to edit one`);
    } else if (msg.type === "results") {
      this.results = Array.isArray(msg.data?.items) ? msg.data.items : [];
      this.truncated = Number(msg.data?.truncated) || 0;
      this.searched = true;
      // A save re-runs the search; keep editing the item that came back.
      if (this.originalName && !this.dirty) {
        const fresh = this.results.find((i: any) => i.name === this.originalName);
        if (fresh) this.draft = JSON.parse(JSON.stringify(fresh));
      }
      this.renderList();
      if (this.draft) this.renderForm();
    } else if (msg.type === "result") {
      // Only the pending save/delete's own result counts.
      if (!this.pending || (msg.action && msg.action !== this.pending.packet)) {
        if (!msg.ok) this.showErrors(msg.errors || ["Action failed."]);
        return;
      }
      const kind = this.pending.kind;
      this.endRequest();
      if (msg.ok) {
        this.showErrors([]);
        if (kind === "delete") {
          // The reply names the deleted item: never adopt it as the open one,
          // and leave the open item's unsaved edits alone.
          this.status("Deleted");
        } else {
          this.dirty = false;
          this.status("Saved");
          if (msg.name) this.originalName = msg.name;
        }
        this.updateSaveIcon();
        this.runSearch();
      } else {
        this.showErrors(msg.errors || ["Save failed."]);
        this.status("Not saved");
      }
    } else if (msg.type === "updated") {
      this.status(`Updated by ${msg.by}`);
      if (this.searched) this.runSearch();
    }
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
  }

  private showErrors(errors: string[]): void {
    this.errorsEl.hidden = errors.length === 0;
    this.errorsEl.innerHTML = errors.map(() => `<div class="editor-error-line"></div>`).join("");
    this.errorsEl.querySelectorAll(".editor-error-line").forEach((el, i) => {
      el.textContent = errors[i];
    });
  }

  // ------------------------------------------------------------------ fields

  private iconAssets(): AssetOption[] {
    return [
      { value: "", label: "None" },
      ...(this.data.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image })),
    ];
  }

  private pick(values: string[], fallback: string[] = []): () => AssetOption[] {
    const list = values?.length ? values : fallback;
    return () => list.map((v) => ({ value: v, label: v }));
  }

  private fields(): Field[] {
    const isEquipment = this.draft?.type === "equipment";
    switch (this.tab) {
      case "equipment":
        return [
          { key: "equipable", label: "Equipable", type: "checkbox", rerender: true, hint: "Can be worn from the inventory." },
          ...(this.draft?.equipable
            ? ([
                { key: "equipment_slot", label: "Slot", type: "select", options: this.pick(this.data.slots ?? [], DEFAULT_SLOTS), rerender: true },
                { key: "level_requirement", label: "Level requirement", type: "number", hint: "Players below this level can't equip it." },
              ] as Field[])
            : []),
        ];
      case "stats":
        return [
          { key: "stat_armor", label: "Armor", type: "number" },
          { key: "stat_damage", label: "Damage", type: "number" },
          { key: "stat_health", label: "Health", type: "number" },
          { key: "stat_stamina", label: "Stamina", type: "number" },
          { key: "stat_critical_chance", label: "Critical chance %", type: "number" },
          { key: "stat_critical_damage", label: "Critical damage %", type: "number" },
          { key: "stat_avoidance", label: "Avoidance", type: "number" },
        ];
      default:
        return [
          { key: "name", label: "Name", type: "text", hint: "Must be unique: items are looked up by name." },
          { key: "type", label: "Type", type: "select", options: this.pick(this.data.types ?? [], DEFAULT_TYPES), rerender: true },
          { key: "quality", label: "Quality", type: "select", options: this.pick(this.data.qualities ?? [], DEFAULT_QUALITIES), rerender: true, hint: "Sets the colour of its name and icon frame." },
          { key: "icon", label: "Icon", type: "asset", assets: () => this.iconAssets() },
          ...(isEquipment ? [] : ([{ key: "level_requirement", label: "Level requirement", type: "number" }] as Field[])),
          { key: "description", label: "Description", type: "textarea", hint: "Shown in the item's tooltip." },
        ];
    }
  }

  /** Weapon / bag fields, shown in their own card under the slot. */
  private slotFields(): { title: string; fields: Field[] } | null {
    if (this.tab !== "equipment" || !this.draft?.equipable) return null;
    if (this.draft.equipment_slot === "weapon") {
      return {
        title: "Weapon",
        fields: [
          { key: "damage_min", label: "Damage min (per swing)", type: "number", hint: "Leave both empty to use the Damage stat instead." },
          { key: "damage_max", label: "Damage max (per swing)", type: "number" },
          { key: "attack_speed_ms", label: "Swing speed (ms)", type: "number", hint: "Time between swings. Lower is faster." },
        ],
      };
    }
    if (this.draft.equipment_slot === "bag") {
      return { title: "Bag", fields: [{ key: "bag_slots", label: "Bag slots", type: "number", hint: "Extra inventory slots it gives." }] };
    }
    return null;
  }

  private blank(): any {
    return {
      name: "New Item", quality: "common", type: "miscellaneous", description: "", icon: "",
      stat_armor: null, stat_damage: null, stat_critical_chance: null, stat_critical_damage: null,
      stat_health: null, stat_stamina: null, stat_avoidance: null, level_requirement: 1,
      equipable: false, equipment_slot: null, bag_slots: null,
      damage_min: null, damage_max: null, attack_speed_ms: null,
    };
  }

  // ------------------------------------------------------------------ render

  private switchTab(tab: string): void {
    this.tab = tab;
    document.querySelectorAll(".editor-tab-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    this.renderForm();
  }

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

  /** Debounced so typing does not send a packet per keystroke. */
  private queueSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runSearch(), 200);
  }

  private runSearch(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    const query = this.searchInput.value.trim();
    // With no query the server returns only the item being edited.
    this.send({ type: "request", packet: "ITEM_EDITOR_SEARCH", data: { query, name: this.originalName } });
  }

  private renderList(): void {
    const items = this.results;
    this.listEl.innerHTML = "";
    // New items start from a pinned row at the top of the list.
    const newRow = document.createElement("div");
    newRow.className = "editor-item ce-new-row" + (this.draft && this.originalName === null ? " active" : "");
    newRow.title = "New item";
    const newLabel = document.createElement("span");
    newLabel.className = "editor-item-label";
    newLabel.textContent = "+ New item";
    newRow.appendChild(newLabel);
    newRow.addEventListener("click", () => this.newEntry());
    this.listEl.appendChild(newRow);
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = this.searched ? "No items match that search." : "Search for an item to edit it.";
      this.listEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "editor-item" + (item.name === this.originalName ? " active" : "");
      row.title = `${item.name} (${item.type})`;

      const thumb = document.createElement("span");
      thumb.className = "ce-asset-thumb";
      applyItemFrame(thumb, item.quality);
      const image = this.iconFor(item.icon);
      if (image) {
        const img = document.createElement("img");
        img.src = image;
        img.alt = "";
        img.loading = "lazy";
        thumb.appendChild(img);
      }

      const label = document.createElement("span");
      label.className = "editor-item-label";
      label.textContent = item.name;
      // Quality colours match the in-game item tooltips.
      label.style.color = QUALITY_COLORS[item.quality] || "#ffffff";

      row.appendChild(thumb);
      row.appendChild(label);
      row.appendChild(this.rowAction("ce-row-copy", COPY_ICON, `Duplicate ${item.name}`, () => this.duplicate(item)));
      row.appendChild(this.rowAction("ce-row-delete", TRASH_ICON, `Delete ${item.name}`, () => this.deleteEntry(item)));
      row.addEventListener("click", () => this.select(item.name));
      this.listEl.appendChild(row);
    }
    if (this.truncated > 0) {
      const more = document.createElement("div");
      more.className = "editor-empty";
      more.textContent = `${this.truncated} more match - narrow the search.`;
      this.listEl.appendChild(more);
    }
  }

  private select(name: string): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    const item = this.results.find((i: any) => i.name === name);
    if (!item) return;
    this.originalName = name;
    this.draft = JSON.parse(JSON.stringify(item));
    this.dirty = false;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
  }

  private newEntry(): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.originalName = null;
    this.draft = this.blank();
    this.dirty = true;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
    this.status("New item - fill it in and save");
  }

  /** Icon button on a list row; acts on that row's item without selecting it. */
  private rowAction(className: string, icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = icon;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** Start a new, unsaved item copied from a list row. */
  private duplicate(item: any): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    const copy = JSON.parse(JSON.stringify(item));
    copy.name = `${copy.name} copy`;
    this.originalName = null;
    this.draft = copy;
    this.dirty = true;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
    this.status("Copy made - rename it and save");
  }

  private renderForm(): void {
    this.fieldsEl.innerHTML = "";
    this.extraEl.innerHTML = "";
    document.getElementById("btn-save")!.hidden = !this.draft;
    this.updateSaveIcon();
    if (!this.draft) {
      this.fieldsEl.innerHTML = `<div class="editor-empty">Search for an item, or create one from the top of the list.</div>`;
      return;
    }

    // Which item this is, in its quality colour, above every tab.
    const heading = document.createElement("div");
    heading.className = "editor-page-title";
    heading.textContent = this.draft.name || "New item";
    heading.style.color = QUALITY_COLORS[this.draft.quality] || "#ffffff";
    const sub = document.createElement("span");
    sub.className = "editor-page-sub";
    sub.textContent = `${this.draft.quality || "common"} ${this.draft.type || "item"}${this.originalName === null ? " · not saved yet" : ""}`;
    heading.appendChild(sub);
    this.fieldsEl.appendChild(heading);

    const titles: Record<string, [string, string?]> = {
      general: ["Item"],
      equipment: ["Equipping"],
      stats: ["Stats", "Bonuses the wearer gets while it is equipped"],
    };
    const [title, subtitle] = titles[this.tab] ?? ["Details"];
    const grid = this.card(this.fieldsEl, title, subtitle);
    for (const field of this.fields()) grid.appendChild(this.renderField(field));

    const slot = this.slotFields();
    if (slot) {
      const slotGrid = this.card(this.fieldsEl, slot.title);
      for (const field of slot.fields) slotGrid.appendChild(this.renderField(field));
      if (slot.title === "Weapon") this.renderWeaponSummary(slotGrid);
    }
  }

  /** A titled card appended to `parent`; returns its field grid. */
  private card(parent: HTMLElement, title: string, sub?: string): HTMLElement {
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
      head.appendChild(subEl);
    }
    card.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "editor-card-grid";
    card.appendChild(grid);
    parent.appendChild(card);
    return grid;
  }

  private renderField(field: Field): HTMLElement {
    const wrap = this.renderFieldBody(field);
    if (field.hint) {
      const hint = document.createElement("div");
      hint.className = "editor-field-hint";
      hint.textContent = field.hint;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  private renderFieldBody(field: Field): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field" + (field.type === "textarea" ? " ce-field-wide" : "");
    const value = this.draft[field.key];

    if (field.type === "checkbox") {
      wrap.classList.add("ce-field-check");
      const line = document.createElement("label");
      line.className = "editor-form-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      cb.addEventListener("change", () => {
        this.draft[field.key] = cb.checked;
        this.dirty = true;
        if (field.rerender) this.renderForm();
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

    if (field.type === "asset") {
      wrap.appendChild(this.renderAssetField(field));
      return wrap;
    }

    if (field.type === "select") {
      const select = document.createElement("select");
      select.className = "editor-form-input";
      const options = field.options?.() ?? [];
      const current = String(value ?? "");
      // Show the stored value even if it is not one of the offered options,
      // so an unexpected value is visible instead of silently blank.
      if (current && !options.some((o) => String(o.value) === current)) {
        options.unshift({ value: current, label: current });
      }
      for (const option of options) {
        const el = document.createElement("option");
        el.value = String(option.value);
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = current;
      select.addEventListener("change", () => {
        this.draft[field.key] = select.value;
        this.dirty = true;
        if (field.rerender) this.renderForm();
      });
      wrap.appendChild(select);
      return wrap;
    }

    const input = field.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    input.className = "editor-form-input";
    input.spellcheck = false;
    if (input instanceof HTMLInputElement) input.type = field.type === "number" ? "number" : "text";
    else input.rows = 3;
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      if (field.type === "number") this.draft[field.key] = input.value === "" ? null : Number(input.value);
      else this.draft[field.key] = input.value;
      this.dirty = true;
    });
    wrap.appendChild(input);
    return wrap;
  }

  /** Asset fields open a searchable popup so icons can be seen, not typed. */
  private renderAssetField(field: Field): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ce-asset-button";

    const paint = () => {
      const current = this.draft[field.key];
      button.innerHTML = "";
      const thumb = document.createElement("span");
      thumb.className = "ce-asset-thumb";
      // Framed in the quality being edited, as it will look in game.
      applyItemFrame(thumb, this.draft.quality);
      const image = this.iconFor(current);
      if (image) {
        const img = document.createElement("img");
        img.src = image;
        img.alt = "";
        thumb.appendChild(img);
      }
      const text = document.createElement("span");
      text.className = "ce-asset-name";
      text.textContent = current ? String(current) : "None";
      button.appendChild(thumb);
      button.appendChild(text);
    };
    paint();

    button.addEventListener("click", () => {
      this.openAssetPicker(field.label, field.assets?.() ?? [], (option) => {
        this.draft[field.key] = option.value;
        this.dirty = true;
        paint();
        this.renderList();
      });
    });
    return button;
  }

  private openAssetPicker(title: string, options: AssetOption[], onPick: (option: AssetOption) => void): void {
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
        const thumb = document.createElement("span");
        thumb.className = "ce-asset-thumb";
        if (option.image) {
          const img = document.createElement("img");
          img.src = option.image;
          img.alt = "";
          img.loading = "lazy";
          thumb.appendChild(img);
        }
        const text = document.createElement("span");
        text.className = "ce-asset-name";
        text.textContent = option.label;
        row.appendChild(thumb);
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

  /** What the weapon actually does in combat, so the numbers are not abstract. */
  private renderWeaponSummary(parent: HTMLElement): void {
    if (this.draft?.equipment_slot !== "weapon") return;
    const min = Number(this.draft.damage_min) || 0;
    const max = Number(this.draft.damage_max) || 0;
    const speed = Number(this.draft.attack_speed_ms) || 2000;
    const box = document.createElement("div");
    box.className = "editor-summary";
    if (min <= 0 && max <= 0) {
      box.textContent = "No damage range set: swings fall back to the item's damage stat.";
    } else {
      const dps = ((min + max) / 2) / (speed / 1000);
      box.textContent =
        `${min}-${max} damage every ${(speed / 1000).toFixed(1)}s (${dps.toFixed(1)} per second before stats). ` +
        `Damage stats are scaled by swing speed, so this weapon gets ${(speed / 2000).toFixed(2)}x of them.`;
    }
    box.classList.add("ce-field-wide");
    parent.appendChild(box);
  }

  // ----------------------------------------------------------------- actions

  /** The save/delete waiting for its result; a second one waits too. */
  private pending: { kind: "save" | "delete"; packet: string } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private save(): void {
    if (!this.draft) return;
    if (this.pending) return this.status("Saving...");
    this.beginRequest("save", "ITEM_EDITOR_SAVE", { ...this.draft, originalName: this.originalName });
    this.status("Saving...");
  }

  /** Delete an item from its list row. Closes it if it is the open one. */
  private deleteEntry(item: any): void {
    const name = String(item?.name ?? "");
    if (!name) return;
    if (this.pending) return this.status("Saving...");
    if (!confirm(`Delete ${name}? Players holding it keep a broken reference.`)) return;
    if (this.originalName === name) {
      this.draft = null;
      this.originalName = null;
      this.dirty = false;
      this.renderForm();
    }
    this.beginRequest("delete", "ITEM_EDITOR_DELETE", { name });
    this.status("Deleting...");
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any): void {
    this.pending = { kind, packet };
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (e.g. permissions): don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.packet !== packet) return;
      this.endRequest();
      this.status("No response from the server - try again");
    }, 15000);
    this.send({ type: "request", packet, data });
    this.updateSaveIcon();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.updateSaveIcon();
  }

  /** Save icon: faded with nothing to save, highlighted with unsaved changes. */
  private updateSaveIcon(): void {
    const btn = document.getElementById("btn-save");
    if (!btn) return;
    const changes = !!this.draft && this.dirty;
    btn.classList.toggle("has-changes", changes);
    btn.classList.toggle("saving", !!this.pending);
    btn.title = this.pending ? "Saving..." : changes ? "Save changes (Ctrl+S)" : "No unsaved changes";
  }
}

new ItemEditorBridge();
