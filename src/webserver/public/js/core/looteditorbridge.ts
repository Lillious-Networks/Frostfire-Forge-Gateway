// Loot table editor popup. Talks to the game window over postMessage; the game
// window turns each change into a server command straight away, so there is
// no Save: every add, edit and remove is sent as it is made.
import { itemFrame } from "./itemframe.js";

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

/** Lowest drop chance: 0 = never drops (keeps the entry without it rolling). */
const MIN_CHANCE = 0;

class LootEditorBridge {
  private tables: any[] = [];
  private selectedTableId: number | null = null;
  private selectedTableData: any = null;
  private tq = "";
  private itemsByName: Map<string, any> = new Map();
  /** A table just created by name: select it once it shows up in the list. */
  private pendingSelectName: string | null = null;

  private tableListEl = document.getElementById("le-table-list")!;
  private itemListEl = document.getElementById("le-item-list")!;
  private itemSearchInput = document.getElementById("le-inp-item-name") as HTMLInputElement;
  private itemResultsEl = document.getElementById("le-item-results")!;

  constructor() {
    document.getElementById("le-btn-refresh")!.addEventListener("click", () => {
      this.send({ type: "refresh" });
      this.status("Reloading...");
    });

    const tableSearch = document.getElementById("le-table-search") as HTMLInputElement;
    tableSearch.addEventListener("input", () => {
      this.tq = tableSearch.value.toLowerCase();
      this.renderTables();
    });

    this.itemSearchInput.addEventListener("input", () => this.filterItems());
    this.itemSearchInput.addEventListener("focus", () => this.filterItems());
    document.addEventListener("click", (e) => {
      if (!this.itemResultsEl.contains(e.target as Node) && e.target !== this.itemSearchInput) {
        this.itemResultsEl.style.display = "none";
      }
    });

    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  private send(msg: any): void { if (window.opener) window.opener.postMessage(msg, "*"); }

  private status(text: string): void {
    const el = document.getElementById("le-status");
    if (el) el.textContent = text;
  }

  /** Item icon in its quality frame (shared with the rest of the game). */
  private iconWrap(iconUrl: string, quality: string, size: number): HTMLElement {
    return itemFrame(iconUrl, quality, size);
  }

  private filterItems(): void {
    const q = this.itemSearchInput.value.trim().toLowerCase();
    if (!q) { this.itemResultsEl.style.display = "none"; return; }
    this.itemResultsEl.innerHTML = "";
    let count = 0;
    for (const [name, data] of this.itemsByName) {
      if (name.toLowerCase().indexOf(q) === -1) continue;
      if (count >= 20) break;
      const quality = data.quality || "common";
      const el = document.createElement("div");
      el.className = "le-item-result";
      el.appendChild(this.iconWrap(data.iconUrl || "", quality, 34));
      const label = document.createElement("span");
      label.className = "editor-item-label le-result-name";
      label.textContent = name;
      const qualityEl = document.createElement("span");
      qualityEl.className = "le-result-quality";
      qualityEl.textContent = quality;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "le-add-btn";
      add.textContent = "Add";
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!this.selectedTableId) return;
        this.send({ type: "addItem", tableId: this.selectedTableId, itemName: name, quality, minQty: 1, maxQty: 1, chance: 100 });
        this.itemSearchInput.value = "";
        this.itemResultsEl.style.display = "none";
        this.status(`Adding ${name}...`);
      });
      el.appendChild(label);
      el.appendChild(qualityEl);
      el.appendChild(add);
      this.itemResultsEl.appendChild(el);
      count++;
    }
    this.itemResultsEl.style.display = count > 0 ? "block" : "none";
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window.opener) return;
    const m = e.data;
    switch (m.type) {
      case "init":
        this.tables = m.tables || [];
        if (m.itemCache) this.itemsByName = m.itemCache;
        this.renderTables();
        if (m.selectedTable) this.selectTable(m.selectedTable);
        break;
      case "tableListUpdate":
        this.tables = m.tables || [];
        if (m.itemCache) this.itemsByName = m.itemCache;
        this.status("Up to date");
        this.syncSelection();
        this.renderTables();
        break;
      case "tableSelectUpdate":
        if (m.table) {
          this.selectedTableId = m.table.id;
          this.selectedTableData = m.table;
          this.populateForm();
          this.renderTables();
        }
        break;
      case "close": window.close(); break;
    }
  }

  /** After a list refresh: follow a just-created table, refresh or drop the open one. */
  private syncSelection(): void {
    if (this.pendingSelectName) {
      const created = this.tables.find((t: any) => t.name === this.pendingSelectName);
      if (created) {
        this.pendingSelectName = null;
        this.selectTable(created);
        return;
      }
    }
    if (this.selectedTableId === null) return;
    const fresh = this.tables.find((t: any) => t.id === this.selectedTableId);
    if (fresh) {
      this.selectedTableData = fresh;
    } else {
      // Deleted (here or by someone else): close it.
      this.selectedTableId = null;
      this.selectedTableData = null;
    }
    this.populateForm();
  }

  private renderTables(): void {
    this.tableListEl.innerHTML = "";
    // New tables start from a pinned row at the top of the list.
    const newRow = document.createElement("div");
    newRow.className = "editor-item ce-new-row";
    newRow.title = "New loot table";
    const newLabel = document.createElement("span");
    newLabel.className = "editor-item-label";
    newLabel.textContent = "+ New loot table";
    newRow.appendChild(newLabel);
    newRow.addEventListener("click", () => this.promptNewTable());
    this.tableListEl.appendChild(newRow);

    for (const t of this.tables) {
      const label = `#${t.id} ${t.name}`;
      if (this.tq && label.toLowerCase().indexOf(this.tq) === -1) continue;
      const el = document.createElement("div");
      el.className = "editor-item" + (t.id === this.selectedTableId ? " active" : "");
      el.title = label;
      const text = document.createElement("span");
      text.className = "editor-item-label";
      text.textContent = label;
      const count = document.createElement("span");
      count.className = "editor-item-icon";
      count.textContent = `(${t.items?.length || 0})`;
      count.title = `${t.items?.length || 0} drops`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ce-row-delete";
      del.title = `Delete ${label}`;
      del.setAttribute("aria-label", `Delete ${label}`);
      del.innerHTML = TRASH_ICON;
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.confirmDeleteTable(t);
      });
      el.appendChild(text);
      el.appendChild(count);
      el.appendChild(del);
      el.addEventListener("click", () => this.selectTable(t));
      this.tableListEl.appendChild(el);
    }
  }

  private selectTable(t: any): void {
    this.selectedTableId = t.id;
    this.selectedTableData = this.tables.find((x: any) => x.id === t.id) || t;
    this.populateForm();
    this.send({ type: "selectTable", id: t.id });
    this.renderTables();
  }

  /** A modal with one text box; `onOk` gets the trimmed value. */
  private modal(title: string, message: string, okLabel: string, danger: boolean, input: { placeholder: string } | null, onOk: (value: string) => void): void {
    const overlay = document.createElement("div");
    overlay.className = "editor-modal-overlay";
    const box = document.createElement("div");
    box.className = "editor-modal-box";
    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = message;
    box.appendChild(h);
    box.appendChild(p);
    let field: HTMLInputElement | null = null;
    if (input) {
      field = document.createElement("input");
      field.type = "text";
      field.maxLength = 64;
      field.spellcheck = false;
      field.placeholder = input.placeholder;
      box.appendChild(field);
    }
    const actions = document.createElement("div");
    actions.className = "editor-modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = danger ? "btn-danger" : "btn-primary";
    ok.textContent = okLabel;
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const submit = () => {
      const value = field ? field.value.trim() : "";
      if (field && !value) { field.focus(); return; }
      close();
      onOk(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    cancel.addEventListener("click", close);
    ok.addEventListener("click", submit);
    (field ?? ok).focus();
  }

  private promptNewTable(): void {
    this.modal("New loot table", "Name it after what drops it, e.g. \"Wolf drops\".", "Create", false, { placeholder: "Table name" }, (typed) => {
      // The game window sends this inside a quoted server command.
      const name = typed.replace(/"/g, "").trim();
      if (!name) return;
      this.pendingSelectName = name;
      this.send({ type: "createTable", name });
      this.status(`Creating ${name}...`);
    });
  }

  private confirmDeleteTable(t: any): void {
    const drops = t.items?.length || 0;
    this.modal(
      "Delete loot table",
      `Delete #${t.id} ${t.name} and its ${drops} drop${drops === 1 ? "" : "s"}? Creatures using it stop dropping these items.`,
      "Delete",
      true,
      null,
      () => {
        if (this.selectedTableId === t.id) {
          this.selectedTableId = null;
          this.selectedTableData = null;
          this.populateForm();
        }
        this.send({ type: "deleteTable", id: t.id });
        this.status("Deleting...");
      }
    );
  }

  /** Show the open table, or the empty state when none is open. */
  private populateForm(): void {
    const t = this.selectedTableData;
    const panels = document.getElementById("le-panels")!;
    const empty = document.getElementById("le-empty")!;
    panels.hidden = !t;
    empty.hidden = !!t;
    if (!t) return;
    const drops = t.items?.length || 0;
    document.getElementById("le-display-name")!.textContent = t.name || "Loot table";
    document.getElementById("le-display-id")!.textContent = t.id ? `#${t.id}` : "—";
    document.getElementById("le-display-count")!.textContent = `${drops} drop${drops === 1 ? "" : "s"}`;
    this.renderItems();
  }

  private renderItems(): void {
    this.itemListEl.innerHTML = "";
    const items = this.selectedTableData?.items || [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-empty";
      empty.textContent = "No drops yet: search for an item above and add it.";
      this.itemListEl.appendChild(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "le-drop-row le-drop-head";
    for (const text of ["", "Item", "Min", "Max", "Chance %", ""]) {
      const cell = document.createElement("span");
      cell.textContent = text;
      head.appendChild(cell);
    }
    this.itemListEl.appendChild(head);

    for (const it of items) {
      const row = document.createElement("div");
      row.className = "le-drop-row";
      row.appendChild(this.iconWrap(this.itemsByName.get(it.item_name)?.iconUrl || "", it.quality || "common", 38));
      const name = document.createElement("span");
      name.className = "le-drop-name";
      name.textContent = it.item_name;
      name.title = it.item_name;
      row.appendChild(name);

      const number = (value: number, min: number, max: number, step: number, label: string) => {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "editor-form-input";
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.setAttribute("aria-label", `${label} for ${it.item_name}`);
        row.appendChild(input);
        return input;
      };
      const minInput = number(it.min_quantity ?? 1, 1, 999, 1, "Minimum amount");
      const maxInput = number(it.max_quantity ?? 1, 1, 999, 1, "Maximum amount");
      const chanceInput = number(it.drop_chance ?? 100, MIN_CHANCE, 100, 0.1, "Drop chance");

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ce-card-btn-x";
      remove.textContent = "×";
      remove.title = `Remove ${it.item_name}`;
      remove.setAttribute("aria-label", `Remove ${it.item_name}`);
      remove.addEventListener("click", () => {
        this.send({ type: "removeItem", itemId: it.id });
        this.status(`Removing ${it.item_name}...`);
      });
      row.appendChild(remove);

      // Sent when a box is left or changed; values are tidied first.
      let last = "";
      const onSave = () => {
        let minQty = parseInt(minInput.value) || 1;
        let maxQty = parseInt(maxInput.value) || 1;
        let chance = parseFloat(chanceInput.value);
        if (isNaN(chance) || chance < MIN_CHANCE) chance = MIN_CHANCE;
        if (chance > 100) chance = 100;
        if (minQty < 1) minQty = 1;
        if (maxQty < 1) maxQty = 1;
        if (minQty > maxQty) maxQty = minQty;
        minInput.value = String(minQty);
        maxInput.value = String(maxQty);
        chanceInput.value = String(chance);
        const key = `${minQty}|${maxQty}|${chance}`;
        const unchanged = key === `${it.min_quantity ?? 1}|${it.max_quantity ?? 1}|${it.drop_chance ?? 100}`;
        // change + blur both fire for one edit; send it once.
        if (unchanged || key === last) return;
        last = key;
        this.send({ type: "updateItem", itemId: it.id, tableId: this.selectedTableId, quality: it.quality || "common", minQty, maxQty, chance });
        this.status(`Saving ${it.item_name}...`);
      };
      for (const input of [minInput, maxInput, chanceInput]) {
        input.addEventListener("change", onSave);
        input.addEventListener("blur", onSave);
      }
      this.itemListEl.appendChild(row);
    }
  }
}

new LootEditorBridge();
