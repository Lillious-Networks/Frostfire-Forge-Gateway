// Quest editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// Mirrors itemeditorbridge.ts; quests are edited by search, never browsed.
import { FieldRenderer, type AssetOption } from "./editorfields.js";

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

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
    // Field edits flag changes without re-rendering; refresh the save icon
    // after any edit (the field's own handler has run by the time this does).
    for (const type of ["input", "change", "click"]) {
      document.addEventListener(type, () => queueMicrotask(() => this.updateSaveIcon()));
    }
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
      const kind = this.pending;
      this.endRequest();
      if (msg.ok) {
        this.showErrors([]);
        if (kind === "delete") {
          // Deleting a row leaves the open quest's unsaved edits alone.
          this.status("Deleted");
        } else {
          this.dirty = false;
          this.status("Saved");
          if (msg.id !== undefined && msg.id !== null) this.editingId = Number(msg.id);
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
      // No quality from the server (an older server build) leaves the icon unframed
      // rather than showing every item as common.
      const quality = typeof entry === "string" ? null : ((entry as any)?.quality ?? null);
      return { value: name, label: name, image: icon ? this.iconUrlFor(icon) : null, quality };
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
    // New quests start from a pinned row at the top of the list.
    const newRow = document.createElement("div");
    newRow.className = "editor-item ce-new-row" + (this.draft && this.editingId === null ? " active" : "");
    newRow.title = "New quest";
    const newLabel = document.createElement("span");
    newLabel.className = "editor-item-label";
    newLabel.textContent = "+ New quest";
    newRow.appendChild(newLabel);
    newRow.addEventListener("click", () => this.newEntry());
    this.listEl.appendChild(newRow);
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
      row.appendChild(this.rowAction("ce-row-copy", COPY_ICON, `Duplicate #${quest.id} ${quest.name}`, () => this.duplicate(quest)));
      row.appendChild(this.rowAction("ce-row-delete", TRASH_ICON, `Delete #${quest.id} ${quest.name}`, () => this.deleteEntry(quest)));
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
    this.draft = this.editableCopy(quest);
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

  /** A detached, fully-shaped copy of a quest for the form to edit. */
  private editableCopy(quest: any): any {
    const draft = JSON.parse(JSON.stringify(quest));
    draft.objectives = draft.objectives || [];
    draft.rewards = draft.rewards || [];
    draft.prerequisites = (draft.prerequisites || []).map(Number);
    // NPC links are edited alongside the quest but loaded lazily: keep
    // whatever the draft carries, defaulting to empty.
    draft.givers = draft.givers || [];
    draft.enders = draft.enders || [];
    return draft;
  }

  /** Icon button on a list row; acts on that row's quest without selecting it. */
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

  /** Start a new, unsaved quest copied from a list row. */
  private duplicate(quest: any): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    const copy = this.editableCopy(quest);
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
    document.getElementById("btn-save")!.hidden = !this.draft;
    this.updateSaveIcon();
    if (!this.draft) {
      this.fieldsEl.innerHTML = `<div class="editor-empty">Select a quest, or create one from the top of the list.</div>`;
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

  /**
   * A titled card holding a grid of fields. `subtitle` summarises the card;
   * `onRemove` adds a × to the header (objectives, item rewards).
   */
  private card(title: string, subtitle?: string, onRemove?: { title: string; run: () => void }): HTMLElement {
    const card = document.createElement("div");
    card.className = "editor-card";
    const head = document.createElement("div");
    head.className = "editor-card-head";
    const titleEl = document.createElement("span");
    titleEl.className = "editor-card-title";
    titleEl.textContent = title;
    head.appendChild(titleEl);
    if (subtitle) {
      const sub = document.createElement("span");
      sub.className = "editor-card-sub";
      sub.textContent = subtitle;
      sub.title = subtitle;
      head.appendChild(sub);
    }
    if (onRemove) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ce-card-btn-x";
      remove.textContent = "×";
      remove.title = onRemove.title;
      remove.setAttribute("aria-label", onRemove.title);
      remove.addEventListener("click", onRemove.run);
      head.appendChild(remove);
    }
    card.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "editor-card-grid";
    card.appendChild(grid);
    this.fieldsEl.appendChild(card);
    return grid;
  }

  /** A short explanation under a field. */
  private hinted(field: HTMLElement, hint: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-field-hint";
    el.textContent = hint;
    field.appendChild(el);
    return field;
  }

  private wide(field: HTMLElement): HTMLElement {
    field.classList.add("ce-field-wide");
    return field;
  }

  private addButton(label: string, onClick: () => void): void {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ce-card-btn editor-add-btn";
    add.textContent = `+ ${label}`;
    add.addEventListener("click", onClick);
    this.fieldsEl.appendChild(add);
  }

  private renderGeneralTab(): void {
    const d = this.draft;
    const repeatables = (this.data.repeatableValues?.length ? this.data.repeatableValues : ["none", "repeatable", "daily"])
      .map((v: string) => ({ value: v, label: v }));

    const basics = this.card("Basics");
    basics.appendChild(this.textRow("Name", d.name, (v) => (d.name = v)));
    basics.appendChild(this.hinted(this.textRow("Zone", d.zone, (v) => (d.zone = v)), "Groups the quest in the player's log."));
    basics.appendChild(this.numberRow("Required level", d.required_level, (v) => (d.required_level = v)));
    basics.appendChild(this.hinted(this.numberRow("Quest level", d.quest_level, (v) => (d.quest_level = v)), "Sets its difficulty colour. 0 = same as required level."));
    basics.appendChild(this.selectRow("Repeatable", d.repeatable, repeatables, (v) => (d.repeatable = v)));
    basics.appendChild(this.hinted(this.numberRow("Sort order", d.sort_order, (v) => (d.sort_order = v)), "Lower numbers are listed first."));

    const dialogue = this.card("Dialogue", "What the player reads");
    dialogue.appendChild(this.wide(this.hinted(this.textRow("Offer text", d.offer_text, (v) => (d.offer_text = v), 4), "Shown when the NPC offers the quest.")));
    dialogue.appendChild(this.wide(this.hinted(this.textRow("Log description", d.description, (v) => (d.description = v), 3), "Shown in the quest log while the quest is active.")));
    dialogue.appendChild(this.wide(this.hinted(this.textRow("Progress text", d.progress_text, (v) => (d.progress_text = v), 3), "Shown when talking to the NPC before the objectives are done.")));
    dialogue.appendChild(this.wide(this.hinted(this.textRow("Completion text", d.completion_text, (v) => (d.completion_text = v), 3), "Shown when the quest is turned in.")));

    const chain = this.card("Quest chain");
    chain.appendChild(this.hinted(
      this.selectRow("Next quest", d.next_quest_id, this.questOptions(), (v) => (d.next_quest_id = v === "" ? null : Number(v)), true),
      "Offered right after this one is turned in."
    ));
    chain.appendChild(this.wide(this.hinted(
      this.pickerRow("Prerequisites", d.prerequisites, this.questOptions((d.prerequisites || []).map(Number)), (v) => (d.prerequisites = v)),
      "Quests that must be completed before this one is offered."
    )));

    const npcs = this.card("NPCs", "Only NPCs marked as quest givers can be picked");
    npcs.appendChild(this.wide(this.pickerRow("Given by", d.givers, this.npcOptions(true), (v) => (d.givers = v))));
    npcs.appendChild(this.wide(this.pickerRow("Turned in to", d.enders, this.npcOptions(true), (v) => (d.enders = v))));
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
      // Optional point: leave all three empty to complete on entering the map.
      const coords = document.createElement("div");
      coords.className = "qe-coords";
      for (const [key, label] of [["target_x", "X"], ["target_y", "Y"], ["target_radius", "Radius"]] as Array<[string, string]>) {
        coords.appendChild(this.numberRow(label, objective[key], (v) => (objective[key] = v)));
      }
      wrap.appendChild(coords);
      this.hinted(wrap, "Leave X, Y and Radius empty to complete on entering the map. A radius needs both X and Y.");
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
    if (d.objectives.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No objectives: the quest can be turned in straight away. Add one below.";
      this.fieldsEl.appendChild(empty);
    }
    d.objectives.forEach((objective: any, index: number) => {
      const grid = this.card(`Objective ${index + 1}`, this.objectiveSummary(objective), {
        title: "Remove objective",
        run: () => {
          d.objectives.splice(index, 1);
          this.dirty = true;
          this.renderForm();
        },
      });
      grid.appendChild(this.selectRow("Type", objective.type, types, (v) => {
        objective.type = v;
        objective.target = "";
        this.dirty = true;
        this.renderForm();
      }));
      grid.appendChild(this.numberRow("Required count", objective.required_count, (v) => (objective.required_count = v)));
      grid.appendChild(this.targetEditor(objective, () => this.renderForm()));
      grid.appendChild(this.wide(this.hinted(
        this.textRow("Display text (optional)", objective.description, (v) => (objective.description = v)),
        "Replaces the generated line in the quest log, e.g. \"Wolf pelts collected\"."
      )));
    });
    this.addButton("Add objective", () => {
      d.objectives.push({ type: "kill", target: "", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null });
      this.dirty = true;
      this.renderForm();
    });
  }

  /** "Kill · Rat × 3": what an objective asks for, for its card header. */
  private objectiveSummary(objective: any): string {
    const target = String(objective.target ?? "");
    const named = (options: Array<{ value: string; label: string }>) =>
      options.find((o) => o.value === target)?.label.replace(/^#\d+\s*/, "") || target;
    const what =
      objective.type === "kill" ? named(this.creatureOptions())
      : objective.type === "talk" ? named(this.npcOptions())
      : target;
    const type = String(objective.type ?? "");
    const verb = type.charAt(0).toUpperCase() + type.slice(1);
    const count = Number(objective.required_count) > 1 ? ` × ${objective.required_count}` : "";
    return what ? `${verb} · ${what}${count}` : verb;
  }

  private renderRewardsTab(): void {
    const d = this.draft;
    d.rewards = d.rewards || [];
    // XP and currency are rewards, not quest metadata: they live here next to
    // the item rewards so authors set the whole payout in one place.
    const payout = this.card("Experience & money");
    payout.appendChild(this.numberRow("XP reward", d.xp_reward, (v) => (d.xp_reward = v)));
    payout.appendChild(this.moneyRow("Money reward", d.copper_reward, (v) => (d.copper_reward = v)));

    if (d.rewards.length > 0) {
      const note = document.createElement("div");
      note.className = "editor-field-hint";
      note.textContent = "Item rewards marked as a choice: the player picks one of them. All others are always given.";
      this.fieldsEl.appendChild(note);
    }
    d.rewards.forEach((reward: any, index: number) => {
      const name = this.itemNameOf(reward.item_name ?? reward);
      const summary = `${name || "No item picked"}${Number(reward.quantity) > 1 ? ` × ${reward.quantity}` : ""}${reward.is_choice ? " · choice" : ""}`;
      const grid = this.card(`Item reward ${index + 1}`, summary, {
        title: "Remove reward",
        run: () => {
          d.rewards.splice(index, 1);
          this.dirty = true;
          this.renderForm();
        },
      });
      grid.appendChild(this.wide(this.itemPicker.renderField(
        { key: "item_name", label: "Item", type: "asset", assets: () => this.itemRewardOptions(), searchFirst: true },
        reward,
        () => { this.dirty = true; }
      )));
      grid.appendChild(this.numberRow("Quantity", reward.quantity, (v) => (reward.quantity = v)));
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
      line.appendChild(document.createTextNode("Player's choice"));
      wrap.appendChild(line);
      grid.appendChild(wrap);
    });
    this.addButton("Add item reward", () => {
      d.rewards.push({ item_name: "", quantity: 1, is_choice: false });
      this.dirty = true;
      this.renderForm();
    });
  }

  // ----------------------------------------------------------------- actions

  // A second save while one is in flight would interleave delete+insert
  // cycles on the server and duplicate every objective and reward. The
  // result doesn't name its request, so remember which one is pending.
  private pending: "save" | "delete" | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private save(): void {
    if (!this.draft) return;
    if (this.pending) return this.status("Saving...");
    const payload = { ...this.draft };
    if (this.editingId !== null) payload.id = this.editingId;
    this.beginRequest("save", "QUEST_EDITOR_SAVE", payload);
    this.status("Saving...");
  }

  /** Delete a quest from its list row. Closes it if it is the open one. */
  private deleteEntry(quest: any): void {
    const id = Number(quest?.id);
    if (!Number.isFinite(id)) return;
    if (this.pending) return this.status("Saving...");
    if (!confirm(`Delete quest #${id} ${quest.name}? Players on it lose it.`)) return;
    if (this.editingId === id) {
      this.draft = null;
      this.editingId = null;
      this.dirty = false;
      this.renderForm();
    }
    this.beginRequest("delete", "QUEST_EDITOR_DELETE", { questId: id });
    this.status("Deleting...");
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any): void {
    this.pending = kind;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (e.g. permissions): don't leave Save blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending !== kind) return;
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

new QuestEditorBridge();
