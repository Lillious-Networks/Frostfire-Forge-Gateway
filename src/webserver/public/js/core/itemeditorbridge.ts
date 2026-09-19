// Item editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.

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
    document.getElementById("btn-new")!.addEventListener("click", () => this.newEntry());
    document.getElementById("btn-duplicate")!.addEventListener("click", () => this.duplicate());
    document.getElementById("btn-delete")!.addEventListener("click", () => this.deleteEntry());
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
      if (msg.ok) {
        this.dirty = false;
        this.showErrors([]);
        this.status("Saved");
        if (msg.name) this.originalName = msg.name;
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
          { key: "equipable", label: "Equipable", type: "checkbox", rerender: true },
          ...(this.draft?.equipable
            ? ([
                { key: "equipment_slot", label: "Slot", type: "select", options: this.pick(this.data.slots ?? [], DEFAULT_SLOTS), rerender: true },
                { key: "level_requirement", label: "Level requirement", type: "number" },
              ] as Field[])
            : []),
          ...(this.draft?.equipment_slot === "weapon"
            ? ([
                { key: "damage_min", label: "Damage min (per swing)", type: "number" },
                { key: "damage_max", label: "Damage max (per swing)", type: "number" },
                { key: "attack_speed_ms", label: "Swing speed (ms)", type: "number" },
              ] as Field[])
            : []),
          ...(this.draft?.equipment_slot === "bag" ? ([{ key: "bag_slots", label: "Bag slots", type: "number" }] as Field[]) : []),
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
          { key: "name", label: "Name", type: "text" },
          { key: "type", label: "Type", type: "select", options: this.pick(this.data.types ?? [], DEFAULT_TYPES), rerender: true },
          { key: "quality", label: "Quality", type: "select", options: this.pick(this.data.qualities ?? [], DEFAULT_QUALITIES) },
          { key: "icon", label: "Icon", type: "asset", assets: () => this.iconAssets() },
          { key: "description", label: "Description", type: "textarea" },
          ...(isEquipment ? [] : ([{ key: "level_requirement", label: "Level requirement", type: "number" }] as Field[])),
        ];
    }
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

  private duplicate(): void {
    if (!this.draft) return this.status("Select an item first");
    const copy = JSON.parse(JSON.stringify(this.draft));
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
    if (!this.draft) {
      this.fieldsEl.innerHTML = `<div class="editor-empty">Select an item, or press New.</div>`;
      return;
    }
    for (const field of this.fields()) this.fieldsEl.appendChild(this.renderField(field));
    if (this.tab === "equipment") this.renderWeaponSummary();
  }

  private renderField(field: Field): HTMLElement {
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
  private renderWeaponSummary(): void {
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
    this.extraEl.appendChild(box);
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft) return;
    this.send({ type: "request", packet: "ITEM_EDITOR_SAVE", data: { ...this.draft, originalName: this.originalName } });
    this.status("Saving...");
  }

  private deleteEntry(): void {
    if (!this.originalName) return this.status("Select a saved item first");
    if (!confirm(`Delete ${this.originalName}? Players holding it keep a broken reference.`)) return;
    this.send({ type: "request", packet: "ITEM_EDITOR_DELETE", data: { name: this.originalName } });
    this.draft = null;
    this.originalName = null;
    this.dirty = false;
  }
}

new ItemEditorBridge();
