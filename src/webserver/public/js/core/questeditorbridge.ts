// Quest editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// Mirrors itemeditorbridge.ts; quests are edited by search, never browsed.
import { FieldRenderer, type AssetOption } from "./editorfields.js";

class QuestEditorBridge {
  private data: any = { objectiveTypes: [], repeatableValues: [], creatures: [], items: [], npcs: [], maps: [], questCount: 0, quests: [] };
  private itemPicker = new FieldRenderer({
    assetOptions: () => this.itemRewardOptions(),
    rerender: () => this.renderForm(),
  });
  private tab = "general";
  /** Id of the quest being edited, or null for a new one. */
  private editingId: number | null = null;
  private draft: any = null;
  /** Last search results; the editor never holds the whole quest table. */
  private results: any[] = [];
  private truncated = 0;
  private searched = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  private listEl = document.getElementById("qe-list")!;
  private fieldsEl = document.getElementById("qe-form-fields")!;
  private extraEl = document.getElementById("qe-extra")!;
  private errorsEl = document.getElementById("qe-errors")!;
  private statusEl = document.getElementById("qe-status")!;
  private searchInput = document.getElementById("qe-search") as HTMLInputElement;

  constructor() {
    document.getElementById("btn-save")!.addEventListener("click", () => this.save());
    document.getElementById("btn-new")!.addEventListener("click", () => this.newEntry());
    document.getElementById("btn-duplicate")!.addEventListener("click", () => this.duplicate());
    document.getElementById("btn-delete")!.addEventListener("click", () => this.deleteEntry());
    // Searching asks the server; the client never holds every quest.
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
      this.data = { ...this.data, ...msg.data };
      this.renderList();
      this.renderForm();
      this.status(`${this.data.questCount ?? 0} quests - select one or search to narrow down`);
      // Populate the list immediately; an empty query browses everything.
      this.runSearch();
    } else if (msg.type === "results") {
      this.results = Array.isArray(msg.data?.quests) ? msg.data.quests : [];
      this.truncated = Number(msg.data?.truncated) || 0;
      this.searched = true;
      // A save re-runs the search; keep editing the quest that came back.
      if (this.editingId !== null && !this.dirty) {
        const fresh = this.results.find((q: any) => Number(q.id) === this.editingId);
        if (fresh) this.draft = JSON.parse(JSON.stringify(fresh));
      }
      this.renderList();
      if (this.draft) this.renderForm();
    } else if (msg.type === "result") {
      this.saving = false;
      if (msg.ok) {
        this.dirty = false;
        this.showErrors([]);
        this.status("Saved");
        if (msg.id !== undefined && msg.id !== null) this.editingId = Number(msg.id);
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

  // ------------------------------------------------------------------ data

  private creatureOptions(): Array<{ value: string; label: string }> {
    return (this.data.creatures ?? []).map((c: any) => ({ value: String(c.id), label: `#${c.id} ${c.name}` }));
  }

  // Only NPCs flagged as quest givers can have quests assigned to them.
  private npcOptions(questGiversOnly = false): Array<{ value: string; label: string }> {
    return (this.data.npcs ?? [])
      .filter((n: any) => !questGiversOnly || n.quest_giver === true || n.quest_giver === 1)
      .map((n: any) => ({ value: String(n.id), label: `#${n.id} ${n.name} (${n.map})` }));
  }

  /** The draft itself can never be its own prerequisite or chain target. */
  private selfQuestId(): number | null {
    const fromTracker = this.editingId === null || this.editingId === undefined ? null : Number(this.editingId);
    if (Number.isFinite(fromTracker)) return fromTracker as number;
    const fromDraft = this.draft?.id === null || this.draft?.id === undefined ? null : Number(this.draft.id);
    return Number.isFinite(fromDraft) ? (fromDraft as number) : null;
  }

  private questOptions(includeIds: number[] = []): Array<{ value: string; label: string }> {
    const excludeId = this.selfQuestId();
    const include = new Set(includeIds.map(Number).filter((n) => Number.isFinite(n)));
    const all = [...(this.data.quests ?? []), ...this.results.filter((q: any) => !(this.data.quests ?? []).some((k: any) => Number(k.id) === Number(q.id)))];
    return all
      .filter((q: any) => include.has(Number(q.id)) || excludeId === null || Number(q.id) !== excludeId)
      .map((q: any) => ({ value: String(q.id), label: `#${q.id} ${q.name}` }));
  }

  private iconUrlFor(name: unknown): string | null {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const bare = wanted.replace(/\.(png|jpg|jpeg|gif)$/i, "");
    const base = this.data.assetServerUrl;
    return base ? `${base}/icon?name=${encodeURIComponent(bare)}` : null;
  }

  /** Item entries are { name, icon }; older payloads may carry bare names. */
  private itemNameOf(entry: unknown): string {
    if (typeof entry === "string") return entry;
    return String((entry as any)?.name ?? "");
  }

  private itemRewardOptions(): AssetOption[] {
    return (this.data.items ?? []).map((entry: unknown) => {
      const name = this.itemNameOf(entry);
      const icon = typeof entry === "string" ? null : ((entry as any)?.icon ?? null);
      return { value: name, label: name, image: icon ? this.iconUrlFor(icon) : null };
    });
  }

  private newClientKey(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `draft-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }

  private blank(): any {
    return {
      id: null,
      clientKey: this.newClientKey(),
      name: "New Quest",
      zone: "",
      offer_text: "",
      description: "",
      progress_text: "",
      completion_text: "",
      required_level: 1,
      quest_level: 0,
      xp_reward: 0,
      copper_reward: 0,
      repeatable: "none",
      next_quest_id: null,
      sort_order: 0,
      objectives: [],
      rewards: [],
      prerequisites: [],
      givers: [],
      enders: [],
    };
  }

  // ------------------------------------------------------------------ form

  private switchTab(tab: string): void {
    this.tab = tab;
    document.querySelectorAll(".editor-tab-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    this.renderForm();
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
    // With no query the server returns nothing; the list only fills on search.
    this.send({ type: "request", packet: "QUEST_EDITOR_SEARCH", data: { query } });
  }

  private renderList(): void {
    const quests = this.results;
    this.listEl.innerHTML = "";
    if (quests.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No quests match that search.";
      this.listEl.appendChild(empty);
      return;
    }
    for (const quest of quests) {
      const row = document.createElement("div");
      row.className = "editor-item" + (Number(quest.id) === this.editingId ? " active" : "");
      row.title = `#${quest.id} ${quest.name}`;
      const label = document.createElement("span");
      label.className = "editor-item-label";
      label.textContent = `#${quest.id} ${quest.name}`;
      row.appendChild(label);
      row.addEventListener("click", () => this.select(Number(quest.id)));
      this.listEl.appendChild(row);
    }
    if (this.truncated > 0) {
      const more = document.createElement("div");
      more.className = "editor-empty";
      more.textContent = `${this.truncated} more match - narrow the search.`;
      this.listEl.appendChild(more);
    }
  }

  private select(id: number): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    // Kill a pending debounced search: its results would re-render the list
    // mid-click and swallow the selection.
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    const quest = this.results.find((q: any) => Number(q.id) === id)
      ?? (this.data.quests ?? []).find((q: any) => Number(q.id) === id);
    if (!quest) return;
    this.editingId = id;
    this.draft = JSON.parse(JSON.stringify(quest));
    this.draft.objectives = this.draft.objectives || [];
    this.draft.rewards = this.draft.rewards || [];
    this.draft.prerequisites = (this.draft.prerequisites || []).map(Number);
    // NPC links are edited alongside the quest but loaded lazily: keep
    // whatever the draft carries, defaulting to empty.
    this.draft.givers = this.draft.givers || [];
    this.draft.enders = this.draft.enders || [];
    this.dirty = false;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
  }

  private newEntry(): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.editingId = null;
    this.draft = this.blank();
    this.dirty = true;
    this.showErrors([]);
    this.renderList();
    this.renderForm();
    this.status("New quest - fill it in and save");
  }

  private duplicate(): void {
    if (!this.draft) return this.status("Select a quest first");
    const copy = JSON.parse(JSON.stringify(this.draft));
    copy.id = null;
    copy.clientKey = this.newClientKey();
    copy.name = `${copy.name} copy`;
    this.editingId = null;
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
      this.fieldsEl.innerHTML = `<div class="editor-empty">Select a quest, or press New.</div>`;
      return;
    }
    if (this.tab === "objectives") this.renderObjectivesTab();
    else if (this.tab === "rewards") this.renderRewardsTab();
    else this.renderGeneralTab();
  }

  private textRow(label: string, value: any, onInput: (v: string) => void, rows = 1): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field" + (rows > 1 ? " ce-field-wide" : "");
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = label;
    wrap.appendChild(lab);
    const input = rows > 1 ? document.createElement("textarea") : document.createElement("input");
    input.className = "editor-form-input";
    input.spellcheck = false;
    if (input instanceof HTMLTextAreaElement) input.rows = rows;
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      onInput(input.value);
      this.dirty = true;
    });
    wrap.appendChild(input);
    return wrap;
  }

  // Gold, silver and copper inputs for an amount stored as a single copper
  // total, mirroring the creature editor's money fields and coin icons.
  private moneyRow(label: string, value: any, onInput: (v: number) => void): HTMLElement {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const wrap = document.createElement("div");
    wrap.className = "ce-field ce-field-wide";
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = label;
    wrap.appendChild(lab);
    const row = document.createElement("div");
    row.className = "ce-money";
    const coins = [
      { name: "Gold", cls: "gold", amount: Math.floor(total / 10000), max: null as number | null },
      { name: "Silver", cls: "silver", amount: Math.floor((total % 10000) / 100), max: 99 as number | null },
      { name: "Copper", cls: "copper", amount: total % 100, max: 99 as number | null },
    ];
    const inputs: HTMLInputElement[] = [];
    const write = () => {
      const [gold, silver, copper] = inputs.map((input) => Math.max(0, Math.floor(Number(input.value) || 0)));
      onInput(gold * 10000 + silver * 100 + copper);
      this.dirty = true;
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
      input.setAttribute("aria-label", `${label} ${coin.name.toLowerCase()}`);
      input.addEventListener("input", write);
      input.addEventListener("change", () => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        input.value = String(coin.max === null ? n : Math.min(coin.max, n));
        write();
      });
      inputs.push(input);
      part.appendChild(input);
      const unit = document.createElement("span");
      unit.className = `currency-icon currency-icon-${coin.cls} ce-money-icon`;
      part.title = coin.name;
      part.appendChild(unit);
      row.appendChild(part);
    }
    wrap.appendChild(row);
    return wrap;
  }

  private numberRow(label: string, value: any, onInput: (v: number | null) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field";
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = label;
    wrap.appendChild(lab);
    const input = document.createElement("input");
    input.className = "editor-form-input";
    input.type = "number";
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      onInput(input.value === "" ? null : Number(input.value));
      this.dirty = true;
    });
    wrap.appendChild(input);
    return wrap;
  }

  private selectRow(label: string, value: any, options: Array<{ value: string; label: string }>, onChange: (v: string) => void, allowEmpty = false, emptyLabel = "None"): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field";
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = label;
    wrap.appendChild(lab);
    const select = document.createElement("select");
    select.className = "editor-form-input";
    const current = String(value ?? "");
    const opts = [...options];
    if (allowEmpty) opts.unshift({ value: "", label: emptyLabel });
    if (current && !opts.some((o) => String(o.value) === current)) {
      opts.unshift({ value: current, label: current });
    }
    for (const option of opts) {
      const el = document.createElement("option");
      el.value = String(option.value);
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.value = current;
    select.addEventListener("change", () => {
      onChange(select.value);
      this.dirty = true;
    });
    wrap.appendChild(select);
    return wrap;
  }

  // Multi-pick as click-to-open searchable popup with toggle rows. A native
  // multi-select cannot be used here: select.editor-form-input is pinned to
  // 29px height, which collapses it into a broken single row.
  private pickerSummary(selected: number[], options: Array<{ value: string; label: string }>): string {
    if (selected.length === 0) return "None - click to pick";
    const names = selected.map((id) => options.find((o) => Number(o.value) === id)?.label || `#${id}`);
    const text = names.join(", ");
    return `${selected.length} selected: ${text.length > 64 ? text.slice(0, 64) + "…" : text}`;
  }

  private pickerRow(label: string, selected: number[], options: Array<{ value: string; label: string }>, onChange: (v: number[]) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field ce-field-wide";
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = label;
    wrap.appendChild(lab);
    let current = (selected || []).map(Number).filter((n) => Number.isFinite(n));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ce-asset-button";
    const paint = () => {
      button.innerHTML = "";
      const text = document.createElement("span");
      text.className = "ce-asset-name";
      text.textContent = this.pickerSummary(current, options);
      button.appendChild(text);
    };
    paint();
    button.addEventListener("click", () => {
      this.openMultiPicker(label, options, current, (next) => {
        current = next;
        onChange([...next]);
        this.dirty = true;
        paint();
      });
    });
    wrap.appendChild(button);
    return wrap;
  }

  private openMultiPicker(title: string, options: Array<{ value: string; label: string }>, selectedIn: number[], onPick: (selected: number[]) => void): void {
    let selected = [...selectedIn];
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
    const footer = document.createElement("div");
    footer.className = "editor-modal-actions";
    const count = document.createElement("span");
    count.style.marginRight = "auto";
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Done";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };

    const paintCount = () => {
      count.textContent = `${selected.length} selected`;
    };

    const paintList = () => {
      const query = search.value.toLowerCase();
      list.innerHTML = "";
      const matches = options.filter((o) => !query || o.label.toLowerCase().includes(query));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "editor-empty";
        empty.textContent = options.length === 0 ? "Nothing to pick yet." : "Nothing matches that search.";
        list.appendChild(empty);
        return;
      }
      const chosen = new Set(selected);
      for (const option of matches) {
        const row = document.createElement("div");
        row.className = "ce-asset-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = chosen.has(Number(option.value));
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          const id = Number(option.value);
          if (cb.checked) {
            if (!selected.includes(id)) selected.push(id);
          } else {
            selected = selected.filter((n) => n !== id);
          }
          onPick([...selected]);
          paintCount();
        });
        const text = document.createElement("span");
        text.className = "ce-asset-name";
        text.textContent = option.label;
        row.appendChild(cb);
        row.appendChild(text);
        row.addEventListener("click", () => {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change"));
        });
        list.appendChild(row);
      }
    };

    search.addEventListener("input", paintList);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    done.addEventListener("click", close);

    box.appendChild(heading);
    box.appendChild(search);
    box.appendChild(list);
    footer.appendChild(count);
    footer.appendChild(done);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintCount();
    paintList();
    search.focus();
  }

  private renderGeneralTab(): void {
    const d = this.draft;
    const repeatables = (this.data.repeatableValues?.length ? this.data.repeatableValues : ["none", "repeatable", "daily"])
      .map((v: string) => ({ value: v, label: v }));
    this.fieldsEl.appendChild(this.textRow("Name", d.name, (v) => (d.name = v)));
    this.fieldsEl.appendChild(this.textRow("Zone", d.zone, (v) => (d.zone = v)));
    this.fieldsEl.appendChild(this.textRow("Offer text", d.offer_text, (v) => (d.offer_text = v), 3));
    this.fieldsEl.appendChild(this.textRow("Log description", d.description, (v) => (d.description = v), 3));
    this.fieldsEl.appendChild(this.textRow("Progress text", d.progress_text, (v) => (d.progress_text = v), 3));
    this.fieldsEl.appendChild(this.textRow("Completion text", d.completion_text, (v) => (d.completion_text = v), 3));
    this.fieldsEl.appendChild(this.numberRow("Required level", d.required_level, (v) => (d.required_level = v)));
    this.fieldsEl.appendChild(this.numberRow("Quest level (0 = required)", d.quest_level, (v) => (d.quest_level = v)));
    this.fieldsEl.appendChild(this.selectRow("Repeatable", d.repeatable, repeatables, (v) => (d.repeatable = v)));
    this.fieldsEl.appendChild(this.selectRow("Next quest (chain)", d.next_quest_id, this.questOptions(), (v) => (d.next_quest_id = v === "" ? null : Number(v)), true));
    this.fieldsEl.appendChild(this.numberRow("Sort order", d.sort_order, (v) => (d.sort_order = v)));
    this.fieldsEl.appendChild(this.pickerRow("Prerequisites", d.prerequisites, this.questOptions((d.prerequisites || []).map(Number)), (v) => (d.prerequisites = v)));
    this.fieldsEl.appendChild(this.pickerRow("Quests given", d.givers, this.npcOptions(true), (v) => (d.givers = v)));
    this.fieldsEl.appendChild(this.pickerRow("Quests ended", d.enders, this.npcOptions(true), (v) => (d.enders = v)));
  }

  private targetEditor(objective: any, onChange: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field ce-field-wide";
    const lab = document.createElement("label");
    lab.className = "editor-form-label";
    lab.textContent = "Target";
    wrap.appendChild(lab);
    const type = objective.type;
    if (type === "kill") {
      const select = document.createElement("select");
      select.className = "editor-form-input";
      for (const option of this.creatureOptions()) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = String(objective.target ?? "");
      if (select.selectedIndex < 0 && select.options.length > 0) select.selectedIndex = 0;
      objective.target = select.value;
      select.addEventListener("change", () => {
        objective.target = select.value;
        this.dirty = true;
        onChange();
      });
      wrap.appendChild(select);
    } else if (type === "talk") {
      const select = document.createElement("select");
      select.className = "editor-form-input";
      for (const option of this.npcOptions()) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = String(objective.target ?? "");
      if (select.selectedIndex < 0 && select.options.length > 0) select.selectedIndex = 0;
      objective.target = select.value;
      select.addEventListener("change", () => {
        objective.target = select.value;
        this.dirty = true;
        onChange();
      });
      wrap.appendChild(select);
    } else if (type === "explore") {
      const select = document.createElement("select");
      select.className = "editor-form-input";
      const maps: string[] = this.data.maps ?? [];
      for (const map of maps) {
        const el = document.createElement("option");
        el.value = map;
        el.textContent = map;
        select.appendChild(el);
      }
      if (objective.target && !maps.includes(objective.target)) {
        const el = document.createElement("option");
        el.value = objective.target;
        el.textContent = objective.target;
        select.appendChild(el);
      }
      select.value = String(objective.target ?? "");
      select.addEventListener("change", () => {
        objective.target = select.value;
        this.dirty = true;
        onChange();
      });
      wrap.appendChild(select);
      const coords = document.createElement("div");
      coords.style.display = "flex";
      coords.style.gap = "6px";
      for (const [key, label] of [["target_x", "X"], ["target_y", "Y"], ["target_radius", "Radius"]] as Array<[string, string]>) {
        const input = document.createElement("input");
        input.className = "editor-form-input";
        input.type = "number";
        input.placeholder = label;
        input.title = label + " (radius needs X and Y)";
        input.value = objective[key] === null || objective[key] === undefined ? "" : String(objective[key]);
        input.addEventListener("input", () => {
          objective[key] = input.value === "" ? null : Number(input.value);
          this.dirty = true;
        });
        coords.appendChild(input);
      }
      wrap.appendChild(coords);
    } else {
      // collect: item names are free text with a datalist of known items.
      const input = document.createElement("input");
      input.className = "editor-form-input";
      input.setAttribute("list", "qe-item-list");
      input.value = String(objective.target ?? "");
      input.addEventListener("input", () => {
        objective.target = input.value;
        this.dirty = true;
      });
      wrap.appendChild(input);
      let datalist = document.getElementById("qe-item-list") as HTMLDataListElement | null;
      if (!datalist) {
        datalist = document.createElement("datalist");
        datalist.id = "qe-item-list";
        document.body.appendChild(datalist);
      }
      datalist.innerHTML = "";
      for (const entry of this.data.items ?? []) {
        const option = document.createElement("option");
        option.value = this.itemNameOf(entry);
        datalist.appendChild(option);
      }
    }
    return wrap;
  }

  private renderObjectivesTab(): void {
    const d = this.draft;
    d.objectives = d.objectives || [];
    const types = (this.data.objectiveTypes?.length ? this.data.objectiveTypes : ["kill", "collect", "talk", "explore"])
      .map((v: string) => ({ value: v, label: v }));
    d.objectives.forEach((objective: any, index: number) => {
      const box = document.createElement("div");
      box.className = "editor-form-section";
      const header = document.createElement("div");
      header.className = "ce-ability-header";
      const title = document.createElement("span");
      title.className = "ce-ability-title";
      title.textContent = `Objective ${index + 1} (${objective.type})`;
      header.appendChild(title);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ce-card-btn-x";
      remove.textContent = "×";
      remove.title = "Remove objective";
      remove.addEventListener("click", () => {
        d.objectives.splice(index, 1);
        this.dirty = true;
        this.renderForm();
      });
      header.appendChild(remove);
      box.appendChild(header);
      box.appendChild(this.selectRow("Type", objective.type, types, (v) => {
        objective.type = v;
        objective.target = "";
        this.dirty = true;
        this.renderForm();
      }));
      box.appendChild(this.targetEditor(objective, () => this.renderForm()));
      box.appendChild(this.numberRow("Required count", objective.required_count, (v) => (objective.required_count = v)));
      box.appendChild(this.textRow("Display override", objective.description, (v) => (objective.description = v)));
      this.fieldsEl.appendChild(box);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add objective";
    add.addEventListener("click", () => {
      d.objectives.push({ type: "kill", target: "", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null });
      this.dirty = true;
      this.renderForm();
    });
    this.fieldsEl.appendChild(add);
  }

  private renderRewardsTab(): void {
    const d = this.draft;
    d.rewards = d.rewards || [];
    // XP and currency are rewards, not quest metadata: they live here next to
    // the item rewards so authors set the whole payout in one place.
    this.fieldsEl.appendChild(this.numberRow("XP reward", d.xp_reward, (v) => (d.xp_reward = v)));
    this.fieldsEl.appendChild(this.moneyRow("Money reward", d.copper_reward, (v) => (d.copper_reward = v)));
    d.rewards.forEach((reward: any, index: number) => {
      const box = document.createElement("div");
      box.className = "editor-form-section";
      const header = document.createElement("div");
      header.className = "sidebar-section-header";
      header.textContent = `Reward ${index + 1}${reward.is_choice ? " (choice)" : ""}`;
      box.appendChild(header);
      box.appendChild(this.itemPicker.renderField(
        { key: "item_name", label: "Reward item", type: "asset", assets: () => this.itemRewardOptions(), searchFirst: true },
        reward,
        () => { this.dirty = true; }
      ));
      box.appendChild(this.numberRow("Quantity", reward.quantity, (v) => (reward.quantity = v)));
      const wrap = document.createElement("div");
      wrap.className = "ce-field ce-field-check";
      const line = document.createElement("label");
      line.className = "editor-form-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!reward.is_choice;
      cb.addEventListener("change", () => {
        reward.is_choice = cb.checked;
        this.dirty = true;
        this.renderForm();
      });
      line.appendChild(cb);
      line.appendChild(document.createTextNode(" Choice (player picks one of these)"));
      wrap.appendChild(line);
      box.appendChild(wrap);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove reward";
      remove.addEventListener("click", () => {
        d.rewards.splice(index, 1);
        this.dirty = true;
        this.renderForm();
      });
      box.appendChild(remove);
      this.fieldsEl.appendChild(box);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add reward";
    add.addEventListener("click", () => {
      d.rewards.push({ item_name: "", quantity: 1, is_choice: false });
      this.dirty = true;
      this.renderForm();
    });
    this.fieldsEl.appendChild(add);
  }

  // ----------------------------------------------------------------- actions

  // A second save while one is in flight would interleave delete+insert
  // cycles on the server and duplicate every objective and reward.
  private saving = false;

  private save(): void {
    if (!this.draft || this.saving) return;
    this.saving = true;
    const payload = { ...this.draft };
    if (this.editingId !== null) payload.id = this.editingId;
    this.send({ type: "request", packet: "QUEST_EDITOR_SAVE", data: payload });
    this.status("Saving...");
  }

  private deleteEntry(): void {
    if (this.editingId === null) return this.status("Select a saved quest first");
    if (!confirm(`Delete quest #${this.editingId}? Players on it lose it.`)) return;
    this.send({ type: "request", packet: "QUEST_EDITOR_DELETE", data: { questId: this.editingId } });
    this.draft = null;
    this.editingId = null;
    this.dirty = false;
  }
}

new QuestEditorBridge();
