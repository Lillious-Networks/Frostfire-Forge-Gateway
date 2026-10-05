// Loot table editor popup. Talks to the game window over postMessage; the game
// window passes each change on to the server as a request of its own, so
// there is no Save: every add, edit and remove is sent as it is made.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the loot table editor's own: the table of rows that is edited in
// place, the field that adds an item, and its conversation with the game
// window.
//
// The server answers each change with whether it was made, why not when it
// was not, and the tables as they stand afterwards: the window is drawn again
// from that list. One thing is asked of the server at a time; what is asked
// meanwhile is sent when the answer has come, so every list is newer than the
// one before it.
import { qualityOf } from "./itemframe.js";
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { askText, button, card, count, el, empty, icon, iconButton, setBusy, thumb, toast, words } from "./toolkit.js";

type LootRow = { id: number; item_name: string; min_quantity?: number | null; max_quantity?: number | null; drop_chance?: number | null; quality?: string | null };
type LootTable = { id: number; name: string; items?: LootRow[] };

/** A change that has been made here, until the server has answered it. */
interface Change {
  /** The request the game window passes on to the server, and what it carries. */
  packet: string;
  data: Record<string, unknown>;
  /** The number it is sent under: the server hands it back with its answer. */
  request: number;
  /** What was not done, said over the server's reason: "Wolf Pelt was not added to Bandit Camp". */
  refused: string;
  /** Said in the corner once it is done, for what the page does not make plain by itself. */
  done?: string;
  /** Run once it is answered, with the answer, or given up on, with null. */
  after?(answer: any): void;
}

/** Lowest drop chance: 0 = never drops (keeps the entry without it rolling). */
const MIN_CHANCE = 0;
/** How many matches the item search lists. */
const SUGGEST_LIMIT = 20;
/** With no answer for this long, a request is given up on. */
const ANSWER_WITHIN_MS = 15000;

const lower = (value: unknown) => String(value ?? "").toLowerCase();
const nameOf = (table: LootTable | null | undefined) => String(table?.name || "Loot table");
const rowsOf = (table: LootTable | null | undefined): LootRow[] => table?.items ?? [];
/** "Table 12 · 3 rows": the number admins know a table by in commands, and how much is in it. */
const aboutOf = (table: LootTable) => `Table ${table.id} · ${rowsOf(table).length ? count(rowsOf(table).length, "row") : "no rows"}`;

class LootEditorBridge {
  private tables: LootTable[] = [];
  private selectedTableId: number | null = null;
  private selectedTableData: LootTable | null = null;
  /** The game window's own list of items, by name: what the item search looks through. */
  private itemsByName: Map<string, any> = new Map();
  /** The tables have been listed at least once. */
  private ready = false;

  /**
   * What has been asked of the server and not answered yet, in the order asked:
   * changes, and "reload" for the tables read again because the admin asked.
   * Only the first is with the server.
   */
  private asked: Array<Change | "reload"> = [];
  private requests = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** How the last change ended: made, refused, or given up on with no answer. It stands until the server next answers, or, when refused, until another table is opened. */
  private ended: "saved" | "error" | "unconfirmed" = "saved";
  /** Rows and tables sent to be removed: a row is greyed out, and neither can be asked for again, until the server has answered. */
  private leavingRows = new Set<number>();
  private leavingTables = new Set<number>();

  /** The table drawn on the page, and its rows by id: a new list updates them in place, so a field being typed in is left alone. */
  private drawn: { id: number; body: HTMLElement; none: HTMLElement; table: HTMLElement; rows: Map<number, { root: HTMLElement; update(row: LootRow): void }> } | null = null;
  /** What Ctrl+S sends: the row whose field the keyboard is in. */
  private commits = new WeakMap<Element, () => void>();
  private reloadBtn = button("Reload", () => this.reload(), { icon: "refresh", kind: "quiet", fold: true, tip: "Read the tables again from the server" });

  private shell = new EditorShell({
    tool: "Loot Table Editor", noun: "loot table", icon: "bag",
    // The tables are all here: searching only narrows the list, at every key.
    onSearch: () => this.renderList(),
    liveSearch: true,
    onNew: () => void this.newTable(),
    // Every change is sent as it is made, so there is no Save button and nothing to copy;
    // Ctrl+S sends the row being typed in without leaving it.
    onSave: () => this.commits.get(document.activeElement as Element)?.(),
    saveButton: false,
    onDelete: () => void this.deleteTable(this.selectedTableData),
  });

  constructor() {
    this.chrome();
    this.shell.waiting(() => this.shell.send({ type: "refresh" }));
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private send(msg: any): void {
    this.shell.send(msg);
  }

  private onMessage(m: any): void {
    switch (m.type) {
      case "init":
        this.tables = m.tables || [];
        if (m.itemCache instanceof Map) this.itemsByName = m.itemCache;
        // The game window answers at once with what it holds, which is nothing until the server's list arrives.
        if (this.tables.length === 0 && !this.ready) break;
        this.arrived();
        this.renderList();
        if (m.selectedTable) this.selectTable(m.selectedTable);
        else this.renderPage();
        break;
      case "tableListUpdate":
        this.tables = m.tables || [];
        if (m.itemCache instanceof Map) this.itemsByName = m.itemCache;
        this.arrived();
        // The page is drawn again from the server's own tables: nothing on it is left unsaved or in doubt.
        this.ended = "saved";
        // The answer to Reload, when that is what is with the server.
        if (this.asked[0] === "reload") this.next();
        this.syncSelection();
        this.renderList();
        break;
      case "result":
        this.answered(m);
        break;
      case "tableSelectUpdate":
        if (m.table) {
          this.selectedTableId = m.table.id;
          this.selectedTableData = m.table;
          this.renderPage();
          this.renderList();
        }
        break;
      case "close":
        window.close();
        break;
    }
  }

  private arrived(): void {
    if (this.ready) return;
    this.ready = true;
    this.shell.arrived();
  }

  // --------------------------------------------------------------- changes

  /** Make a change: it is sent now, or once what was asked before it has been answered. */
  private change(change: Omit<Change, "request">): void {
    this.ask({ ...change, request: ++this.requests });
  }

  private reload(): void {
    if (!this.ready || this.asked.includes("reload")) return;
    this.ask("reload");
  }

  private ask(what: Change | "reload"): void {
    this.asked.push(what);
    if (this.asked.length === 1) this.sendFirst();
    this.chrome();
  }

  private sendFirst(): void {
    const first = this.asked[0];
    if (!first) return;
    // No answer ever comes if the connection drops: don't stay waiting forever.
    this.pendingTimer = setTimeout(() => this.giveUp(), ANSWER_WITHIN_MS);
    if (first === "reload") this.send({ type: "refresh" });
    else this.send({ type: "request", packet: first.packet, data: { ...first.data, request: first.request } });
  }

  /** What was asked first has been answered: what was asked after it is sent. */
  private next(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.asked.shift();
    this.sendFirst();
  }

  /** The server's answer to a change: whether it was made, why not when it was not, and the tables as they now stand. */
  private answered(m: any): void {
    // The tables come with every answer but one that says this admin may not change them.
    if (Array.isArray(m.tables)) this.tables = m.tables;
    if (m.itemCache instanceof Map) this.itemsByName = m.itemCache;
    const first = this.asked[0];
    const mine = first && first !== "reload" && first.request === m.request ? first : null;
    const reasons: string[] = m.errors?.length ? m.errors : ["The server gave no reason."];
    this.ended = m.ok ? "saved" : "error";
    if (mine) {
      this.next();
      mine.after?.(m);
      if (!m.ok) toast(`${mine.refused}\n${reasons.join("\n")}`, "error");
      else if (mine.done) toast(mine.done);
    } else if (!m.ok) {
      // The answer to a change that was given up on: it was refused after all.
      toast(reasons.join("\n"), "error");
    }
    this.syncSelection();
    this.renderList();
  }

  /** No answer came. Nothing is known of what was sent, and what was asked after it was never sent. */
  private giveUp(): void {
    this.pendingTimer = null;
    const dropped = this.asked;
    this.asked = [];
    const changes = dropped.filter((what): what is Change => what !== "reload");
    for (const change of changes) change.after?.(null);
    if (changes.length) this.ended = "unconfirmed";
    toast(changes.length ? "The server did not answer in time, so nothing was confirmed." : "The server did not answer in time, so the tables were not read again.", "error");
    this.renderList();
    this.renderPage();
  }

  /** After a list: bring the open table up to date, or close it when the server no longer has it. */
  private syncSelection(): void {
    if (this.selectedTableId !== null) {
      const fresh = this.tables.find((t) => t.id === this.selectedTableId);
      if (fresh) {
        this.selectedTableData = fresh;
      } else {
        // Deleted by someone else: close it.
        toast(`${nameOf(this.selectedTableData)} is no longer on the server, so it was closed.`, "warning");
        this.selectedTableId = null;
        this.selectedTableData = null;
      }
    }
    this.renderPage();
  }

  // ------------------------------------------------------------- side pane

  private renderList(): void {
    if (!this.ready) return;
    const query = this.shell.query.toLowerCase();
    const rows: ListRow[] = [];
    for (const t of this.tables) {
      if (query && !`#${t.id} ${t.name}`.toLowerCase().includes(query)) continue;
      rows.push({
        id: String(t.id), name: nameOf(t), note: aboutOf(t), selected: t.id === this.selectedTableId,
        actions: [{ icon: "trash", label: `Delete ${nameOf(t)}`, danger: true, onClick: () => void this.deleteTable(t) }],
        onOpen: () => this.selectTable(t),
      });
    }
    this.shell.setCount(this.tables.length);
    this.shell.setList({
      rows,
      empty: query
        ? { icon: "search", title: "No loot table matches that search", text: "Check the spelling, or search for less of the name. A table's number finds it too." }
        : { title: "There are no loot tables yet", text: "Create the first one with the button above, then add items to it." },
    });
  }

  private selectTable(t: LootTable): void {
    // One that is being deleted is not opened again.
    if (this.leavingTables.has(t.id)) return;
    // What was refused was refused of the table that was open: it is not said of the next one.
    if (t.id !== this.selectedTableId && this.ended === "error") this.ended = "saved";
    this.selectedTableId = t.id;
    this.selectedTableData = this.tables.find((x) => x.id === t.id) || t;
    this.renderPage();
    this.send({ type: "selectTable", id: t.id });
    this.renderList();
  }

  private async newTable(): Promise<void> {
    const name = await askText({ title: "New loot table", body: "Name it after what drops it, for example “Wolf drops”.", label: "Table name", okLabel: "Create table", icon: "bag", maxLength: 64 });
    if (!name) return;
    this.change({
      packet: "LOOT_EDITOR_CREATE_TABLE", data: { name },
      refused: `${name} was not created`,
      done: `Created ${name}.`,
      // The answer says which table was made: it is opened.
      after: (answer) => {
        const created = answer?.ok ? this.tables.find((t) => t.id === answer.id) : null;
        if (created) this.selectTable(created);
      },
    });
  }

  /** Delete a table, from its list row or the top bar. The open one stays open until the server has deleted it. */
  private async deleteTable(t: LootTable | null): Promise<void> {
    if (!t || this.leavingTables.has(t.id)) return;
    const name = nameOf(t);
    const rows = rowsOf(t).length;
    const gone = rows ? `The table and its ${count(rows, "row")} are removed for good.` : "The table is removed for good.";
    if (!(await this.shell.confirmDelete(name, `${gone} Creatures and chests that roll their drops from it stop dropping these items.`))) return;
    if (this.leavingTables.has(t.id)) return;
    this.leavingTables.add(t.id);
    this.change({
      packet: "LOOT_EDITOR_DELETE_TABLE", data: { id: t.id },
      refused: `${name} was not deleted`,
      done: `Deleted ${name}.`,
      after: (answer) => {
        this.leavingTables.delete(t.id);
        // Deleted from here: it is closed without being said to have gone.
        if (answer?.ok && this.selectedTableId === t.id) {
          this.selectedTableId = null;
          this.selectedTableData = null;
        }
      },
    });
  }

  /** The open table is being deleted: nothing more is asked of it until the server has answered. */
  private get leaving(): boolean {
    return this.selectedTableId !== null && this.leavingTables.has(this.selectedTableId);
  }

  // --------------------------------------------------------------- top bar

  /** The top bar: what is open, whether its changes have reached the server, and what can be done to it. */
  private chrome(): void {
    const t = this.selectedTableData;
    const { shell } = this;
    const waiting = this.asked.some((what) => what !== "reload");
    this.reloadBtn.disabled = !this.ready;
    setBusy(this.reloadBtn, this.asked.includes("reload"));
    if (!t) {
      shell.setRecord(null);
      // With nothing open there is still a change to wait for: a table being created or deleted.
      shell.setState(waiting ? "saving" : null);
      shell.setActions({ open: false, extra: [this.reloadBtn] });
      return;
    }
    shell.setRecord({ title: nameOf(t), note: aboutOf(t), thumb: thumb(null, { size: "lg", fallback: "bag" }) });
    const state: RecordState = this.leaving ? "deleting" : waiting ? "saving" : this.ended;
    shell.setState(state, state === "saved" ? "Changes save automatically" : undefined);
    shell.setActions({ open: true, busy: this.leaving ? "delete" : null, extra: [this.reloadBtn] });
  }

  // ------------------------------------------------------------------ page

  /** Show the open table, or the empty state when none is open. */
  private renderPage(): void {
    this.chrome();
    if (!this.ready) return;
    const t = this.selectedTableData;
    if (!t) {
      this.drawn = null;
      const box = this.shell.idle("Pick a loot table on the left to edit its rows, or create a new one.",
        this.tables.length === 0 ? "A loot table lists the items a creature or a chest can drop, and how often. Create the first one to start." : null);
      box.appendChild(button("New loot table", () => void this.newTable(), { icon: "plus", kind: "primary" }));
      return;
    }
    // The same table as is on the page: its rows are brought up to date where they stand.
    if (this.drawn?.id === t.id && this.drawn.body.isConnected) return this.syncRows(t);

    const { main } = this.shell.page(`table:${t.id}`);
    const made = card(main, "Rows", "Each row rolls its chance on its own. The amount that drops is picked between the fewest and the most.");
    made.root.classList.add("tl-card-flush");
    made.tools.appendChild(this.addField());

    const table = el("table", "tl-table tl-table-plain tl-table-edit le-rows");
    const cols = el("colgroup");
    for (const name of ["", "le-col-num", "le-col-num", "le-col-chance", "le-col-end"]) cols.appendChild(el("col", name));
    const head = el("tr");
    for (const text of ["Item", "Fewest", "Most", "Chance", ""]) {
      const cell = el("th", "", text);
      cell.scope = "col";
      // The last column holds each row's way out; it has no heading to read, only a name.
      if (!text) cell.setAttribute("aria-label", "Remove");
      head.appendChild(cell);
    }
    const thead = el("thead");
    thead.appendChild(head);
    const body = el("tbody");
    table.append(cols, thead, body);
    const none = el("div");
    empty(none, "bag", "This table has no rows yet", "Search for an item above to add the first one. A new row starts as one item that always drops.");
    made.body.append(table, none);
    this.drawn = { id: t.id, body, none, table, rows: new Map() };
    this.syncRows(t);
  }

  /** Bring the rows on the page up to date with the table: new ones added, gone ones taken away, the rest updated where they stand. */
  private syncRows(t: LootTable): void {
    const drawn = this.drawn;
    if (!drawn) return;
    const items = rowsOf(t);
    const kept = new Set(items.map((it) => it.id));
    for (const [id, row] of drawn.rows) {
      if (kept.has(id)) continue;
      row.root.remove();
      drawn.rows.delete(id);
    }
    let after: HTMLElement | null = null;
    for (const it of items) {
      let row = drawn.rows.get(it.id);
      if (row) row.update(it);
      else drawn.rows.set(it.id, (row = this.row(it)));
      row.root.classList.toggle("is-leaving", this.leavingRows.has(it.id));
      // Kept in the server's order.
      const next: Element | null = after ? after.nextElementSibling : drawn.body.firstElementChild;
      if (next !== row.root) drawn.body.insertBefore(row.root, next);
      after = row.root;
    }
    drawn.table.hidden = items.length === 0;
    drawn.none.hidden = items.length > 0;
  }

  /** One row of the table: the item, then its numbers, each sent when its box is left or changed. */
  private row(first: LootRow): { root: HTMLElement; update(row: LootRow): void } {
    let it = first;
    const root = el("tr");
    const item = el("div", "tl-item");
    const said = el("span", "tl-item-words");
    const name = el("span", "le-item-name tl-quality-text", it.item_name);
    name.title = it.item_name;
    const kind = el("span", "tl-item-note");
    said.append(name, kind);
    const cell = el("td");
    cell.appendChild(item);
    root.appendChild(cell);
    let picture = "";
    const paintItem = () => {
      const quality = qualityOf(it.quality || "common");
      name.dataset.quality = quality;
      kind.textContent = words(quality);
      // The picture is only drawn again when it changes, not at every list.
      const url = this.itemsByName.get(it.item_name)?.iconUrl || "";
      if (picture === `${url}|${quality}` && item.childElementCount) return;
      picture = `${url}|${quality}`;
      item.replaceChildren(thumb(url || null, { size: "lg", quality, fallback: "box" }), said);
    };
    paintItem();

    const number = (min: number, max: number, step: number, label: string, unit = "") => {
      const input = el("input", "tl-input tl-input-number");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.setAttribute("aria-label", `${label} of ${it.item_name}`);
      const td = el("td");
      if (unit) {
        const box = el("div", "tl-affix");
        box.append(input, el("span", "tl-affix-unit", unit));
        td.appendChild(box);
      } else td.appendChild(input);
      root.appendChild(td);
      return input;
    };
    const minInput = number(1, 999, 1, "Fewest");
    const maxInput = number(1, 999, 1, "Most");
    const chanceInput = number(MIN_CHANCE, 100, 0.1, "Chance to drop, in percent,", "%");
    const inputs = [minInput, maxInput, chanceInput];
    const stored = () => [it.min_quantity ?? 1, it.max_quantity ?? 1, it.drop_chance ?? 100];

    const remove = iconButton("trash", `Remove ${it.item_name}`, () => {
      if (this.leaving || this.leavingRows.has(it.id)) return;
      const id = it.id;
      this.leavingRows.add(id);
      root.classList.add("is-leaving");
      this.change({
        packet: "LOOT_EDITOR_REMOVE_ITEM", data: { itemId: id },
        refused: `${it.item_name} was not removed from ${nameOf(this.selectedTableData)}`,
        after: () => this.leavingRows.delete(id),
      });
    }, { danger: true, size: 15 });
    const end = el("td", "tl-table-end");
    end.appendChild(remove);
    root.appendChild(end);

    // Sent when a box is left or changed; values are tidied first.
    let last = "";
    /** Changes of this row's numbers that the server has not answered yet. */
    let unanswered = 0;
    /** One of them was not made: the boxes go back to what the server holds, the one being typed in too. */
    let putBack = false;
    const onSave = () => {
      if (!root.isConnected || this.leaving || this.leavingRows.has(it.id)) return;
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
      const unchanged = key === stored().join("|");
      // change + blur both fire for one edit; send it once.
      if (unchanged || key === last) return;
      last = key;
      unanswered++;
      this.change({
        packet: "LOOT_EDITOR_UPDATE_ITEM", data: { itemId: it.id, minQuantity: minQty, maxQuantity: maxQty, dropChance: chance },
        refused: `${it.item_name} was not changed`,
        after: (answer) => {
          unanswered--;
          if (!answer?.ok) putBack = true;
        },
      });
    };
    for (const input of inputs) {
      input.addEventListener("change", onSave);
      input.addEventListener("blur", onSave);
      this.commits.set(input, onSave);
    }

    const update = (next: LootRow) => {
      it = next;
      paintItem();
      // While a later change of this row is still to be answered, its boxes keep what was typed for it.
      if (unanswered > 0 && !putBack) return;
      last = "";
      const values = stored();
      // A box being typed in keeps what is in it; it is compared with the server's value when it is left.
      inputs.forEach((input, i) => {
        if (putBack || document.activeElement !== input) input.value = String(values[i]);
      });
      putBack = false;
    };
    update(it);
    return { root, update };
  }

  /**
   * The field that adds an item to the open table: the game window's items are
   * searched as it is typed in and the matches listed under it. Picking one
   * adds it as one item that always drops; its numbers are then edited in its row.
   */
  private addField(): HTMLElement {
    const wrap = el("div", "tl-suggest-wrap le-add");
    const list = el("div", "tl-suggest");
    list.hidden = true;
    const input = el("input", "tl-input");
    input.type = "text";
    input.placeholder = "Add an item: type its name";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Add an item to this table: type its name");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    const box = el("div", "tl-search");
    box.append(icon("plus", 15), input);

    const show = (on: boolean) => {
      list.hidden = !on;
      input.setAttribute("aria-expanded", String(on));
    };
    const add = (name: string) => {
      const tableId = this.selectedTableId;
      if (!tableId || this.leaving) return;
      // The server gives the row the item's own quality.
      this.change({
        packet: "LOOT_EDITOR_ADD_ITEM", data: { tableId, itemName: name, minQuantity: 1, maxQuantity: 1, dropChance: 100 },
        refused: `${name} was not added to ${nameOf(this.selectedTableData)}`,
      });
      input.value = "";
      show(false);
      input.focus();
    };
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return show(false);
      list.replaceChildren();
      const inTable = new Set(rowsOf(this.selectedTableData).map((r) => lower(r.item_name)));
      let shownCount = 0;
      let more = 0;
      for (const [name, data] of this.itemsByName) {
        if (name.toLowerCase().indexOf(q) === -1) continue;
        if (shownCount >= SUGGEST_LIMIT) {
          more++;
          continue;
        }
        const quality = data.quality || "common";
        const row = el("button", "tl-suggest-row");
        row.type = "button";
        row.title = `Add ${name} to this table`;
        const label = el("span", "tl-suggest-name tl-quality-text", name);
        label.dataset.quality = qualityOf(quality);
        const go = el("span", "le-add-go");
        go.append(icon("plus", 13), el("span", "", "Add"));
        row.append(
          thumb(data.iconUrl || null, { quality, fallback: "box" }), label,
          el("span", "tl-suggest-note", inTable.has(lower(name)) ? `${words(qualityOf(quality))} · in this table` : words(qualityOf(quality))), go);
        row.addEventListener("click", () => add(name));
        list.appendChild(row);
        shownCount++;
      }
      // Only what the game window has seen can be found: it holds the items of the admin's own character.
      if (shownCount === 0) list.appendChild(el("div", "tl-suggest-none", "No item you are carrying has that in its name. Only the items in your own inventory can be found here."));
      if (more > 0) list.appendChild(el("div", "tl-suggest-none", `${count(more, "more match", "more matches")}. Type more of the name.`));
      show(true);
    };
    input.addEventListener("input", paint);
    input.addEventListener("focus", paint);
    input.addEventListener("keydown", (e) => {
      const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
      if (e.key === "Escape") show(false);
      // Enter takes the only match, so a full name can be typed and added.
      if (e.key === "Enter" && !list.hidden && rows.length === 1) rows[0].click();
      if (e.key === "ArrowDown" && !list.hidden) {
        e.preventDefault();
        rows[0]?.focus();
      }
    });
    list.addEventListener("keydown", (e) => {
      const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        show(false);
        input.focus();
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (e.key === "ArrowUp" && at <= 0) input.focus();
      else rows[Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
    });
    wrap.addEventListener("focusout", (e) => {
      if (!wrap.contains(e.relatedTarget as Node | null)) show(false);
    });
    wrap.append(box, list);
    return wrap;
  }
}

new LootEditorBridge();
