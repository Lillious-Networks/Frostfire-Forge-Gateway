// The window an editor lives in: the workbench of css/tools.css. The control
// panel is a dashboard; an editor is a place to open one record out of many,
// change it and save it, and this draws the parts every editor has in the same
// place: the list of records down the side, what is open and how it stands
// across the top with what can be done to it, the tabs of a large record, and
// the page with its form and, beside it, a preview or summary.
//
// An editor's own script (its "bridge") owns the record and the conversation
// with the game window. It tells the shell what to show; the shell tells it
// what the admin asked for.
//
// ------------------------------ how to use ------------------------------
//
// The page (see itemeditor.html) holds the empty workbench: #tl-side,
// #tl-topbar, #tl-banner, #tl-tabs, #tl-page. Then:
//
//   const shell = new EditorShell({
//     tool: "Item Editor", noun: "item", icon: "box",
//     tabs: [{ id: "general", label: "General" }, ...],      // leave out for a record that fits one page
//     onSearch: (query) => ...,     // typed in the search field (200 ms after the last key, or Enter)
//     liveSearch: true,             // for a list held whole in the window: onSearch at every key instead
//     onNew: () => ..., onSave: () => ..., onDuplicate: () => ..., onDelete: () => ...,
//     onTab: (id) => ...,
//   });
//   shell.connect((msg) => ...);    // listen to the game window, and tell it this window is ready
//
// New, Duplicate, Delete and Save are each there when the editor says what
// they do, and left out when it does not: an NPC is placed, not copied, so the
// NPC editor gives no onDuplicate. `saveButton: false` is for an editor whose
// changes are sent as they are made: no Save button, and Ctrl+S still calls
// onSave. Each button carries data-act: "new", "duplicate", "delete", "save".
//
// An editor of several kinds of record (the creature editor: creatures, patrol
// paths, link groups, spawn pools) gives `kinds` in place of noun, icon and tabs:
//     kinds: [{ id: "templates", label: "Creatures", noun: "creature", icon: "paw", tabs: [...] }, ...],
//     onKind: (id) => ...,
// They are listed above the list, each button carrying data-kind; the list,
// the search field, New and the tabs then speak of the kind in view.
//   shell.setKind("paths")                       the kind in view
//   shell.setCounts({ templates: 34, ... })      how many records each kind has (null hides them)
//   await shell.leave("Frost Wolf")              -> "save" | "discard" | "stay": asked on the way to another kind
//
// Side pane
//   shell.setCount(1204)                         how many records there are in all (null hides it)
//   shell.setList({ rows, loading?, empty?, foot? })
//        rows: [{ id, name, note?, thumb?, tags?, selected?, actions?: [{ icon, label, danger?, onClick }], onOpen }]
//        empty: { icon?, title, text? } shown when there are no rows;  foot: a line under the list ("37 more match...")
//        A redraw keeps the list where it was scrolled to and the focus on the row it was on.
//   shell.showSelected()                         brings the open record's row into view
//   shell.query                                  what is in the search field now
//   shell.takeQuery()                            the same, when sending a search yourself (a search still waiting on the typing is forgotten)
//   shell.clearQuery()                           empties the search field
//   shell.sideFoot                               room under the list for what belongs to the whole window, not to one record
//
// Top bar
//   shell.setRecord({ title, note?, thumb? } | null)        what is open
//   shell.setState(state | null, label?)         how it stands, in the words every editor uses:
//        "saved" Saved · "unsaved" Unsaved changes · "new" Not saved yet · "saving" Saving · "deleting" Deleting ·
//        "loading" Loading · "error" Not saved · "unconfirmed" Not confirmed · "readonly" Read-only
//        `label` is for an editor where the usual words would be wrong ("Changes save automatically").
//   shell.setActions({ open, dirty?, busy?, canSave?, canDuplicate?, canDelete?, why?, deleteTip?, extra? })
//        The buttons never move: one that does not apply is greyed out, and
//        why: { save?, duplicate?, delete? } says so in its tooltip. Save is green while there is
//        something to save. extra: buttons of this editor only, placed before them.
//   Order, left to right: the editor's own buttons, Duplicate, Delete, a rule, Save.
//
// Tabs, banner, page
//   shell.setTabs("general", { stats: 2 }, { spawns: 6 })
//        the tab in view, how many problems each tab has, and how many things a tab lists; null hides the tabs
//   shell.setBanner({ tone, icon, text, action? } | null)    one line under the top bar: "info" | "warning" | "danger"
//   const { main, aside } = shell.page(key, { aside?, readOnly? })
//        empties the page and hands back where the cards go. `key` names what is shown (record and tab): while it stays
//        the same, a redraw keeps the scrolling and puts the keyboard back in the very control it was in, with the caret
//        where it stood. A control that is not in a field is found again by a data-keep mark of its own.
//   shell.screen(icon, title, text)              a page with only a reason on it; returns the box, to add a button to
//   shell.idle(text, none?)                      that page while no record is open: "No item open" over `text`, or,
//                                                given `none` (there are no records at all), "There are no items yet" over it
//   shell.setProblems(lines)                     what is wrong, summarised at the top of the page ([] clears it)
//   shell.focusField(path) / shell.reveal(selector)
//   shell.waiting(retry) / shell.arrived()       the loading shapes until the first answer; after 12 s, why and "Try again".
//                                                Call arrived() on the first answer: it turns the search field and New on.
//   shell.refused(lines, retry?)                 the server would not open the editor for this admin: its words, on the page
//
// Questions and answers
//   await shell.discard("Iron Sword")            "Discard your changes?" before leaving a record with unsaved changes
//   await shell.confirmDelete("Iron Sword", "…") the same question every editor asks before deleting
//   toast("Saved Iron Sword.") from toolkit.ts   the result of what was asked for
//   Ctrl+S (Cmd+S) calls onSave.
//
// The conversation with the game window is not changed by any of this: the
// shell only wraps window.opener.postMessage and the "message" event, and it
// ignores messages that do not come from the window that opened this one.
import { button, confirmDialog, el, empty, icon, iconButton, leaveDialog, num, pill, screen, searchBox, setBusy, thumb, tooltip, type IconName } from "./toolkit.js";

export type RecordState = "saved" | "unsaved" | "new" | "saving" | "deleting" | "loading" | "error" | "unconfirmed" | "readonly";

/** One kind of record, in an editor of several. */
export interface Kind {
  id: string;
  /** Its name in the list of kinds and over the list of records: "Patrol paths". */
  label: string;
  /** What one record is called, lower case: "patrol path". */
  noun: string;
  /** What several are called. The noun with an s unless given. */
  plural?: string;
  /** The icon that stands for a record with no picture of its own. */
  icon: IconName;
  /** The tabs of a record too large for one page. */
  tabs?: Array<{ id: string; label: string }>;
}

export interface EditorOptions {
  /** The window's name: "Item Editor". */
  tool: string;
  /** What one record is called, lower case: "item". Not needed with `kinds`. */
  noun?: string;
  /** What several are called. The noun with an s unless given. */
  plural?: string;
  /** The icon that stands for a record with no picture of its own. Not needed with `kinds`. */
  icon?: IconName;
  /** The tabs of a record too large for one page. */
  tabs?: Array<{ id: string; label: string }>;
  /** The kinds of record, for an editor of several: in place of noun, plural, icon and tabs. */
  kinds?: Kind[];
  /** A kind was picked in the list of kinds. The editor answers with setKind once it has left what was open. */
  onKind?(id: string): void;
  onSearch(query: string): void;
  /** The list is held whole in this window: a search is answered at every key, not 200 ms after the last. */
  liveSearch?: boolean;
  /** Each of these buttons is there when the editor says what it does. */
  onNew?(): void;
  onSave?(): void;
  onDuplicate?(): void;
  onDelete?(): void;
  /** False where every change is sent as it is made: no Save button, and Ctrl+S still calls onSave. */
  saveButton?: boolean;
  onTab?(id: string): void;
}

export interface ListRow {
  id: string;
  name: string;
  /** A second line: what kind of record it is. */
  note?: string;
  thumb?: HTMLElement;
  tags?: HTMLElement[];
  selected?: boolean;
  /** What can be done to this row without opening it. */
  actions?: Array<{ icon: IconName; label: string; danger?: boolean; onClick(): void }>;
  onOpen(): void;
}

export interface ListState {
  rows: ListRow[];
  /** The first answer has not come yet. */
  loading?: boolean;
  /** What to say when there are no rows. */
  empty?: { icon?: IconName; title: string; text?: string };
  /** A line under the list. */
  foot?: string;
}

export interface ActionState {
  /** A record is open. */
  open: boolean;
  /** It has changes that are not saved. */
  dirty?: boolean;
  /** Which request is waiting for the server's answer. */
  busy?: "save" | "delete" | "other" | null;
  /** False where the open record cannot be saved, copied or deleted here. True unless said. */
  canSave?: boolean;
  canDuplicate?: boolean;
  canDelete?: boolean;
  /** Why each of those is off, for its tooltip: "It has not been saved, so there is nothing to delete." */
  why?: { save?: string; duplicate?: string; delete?: string };
  /** What Delete does to this record, for its tooltip, when "Delete this item" would be wrong (one never saved is discarded). */
  deleteTip?: string;
  /** Buttons of this editor only, placed before the standard ones. */
  extra?: HTMLElement[];
}

export interface Banner {
  tone: "info" | "warning" | "danger";
  icon: IconName;
  text: string;
  action?: { label: string; onClick(): void };
}

/** How a record stands, in the words every editor uses for it. */
const STATES: Record<RecordState, { level: string; mark: IconName | "dot"; label: string }> = {
  saved: { level: "", mark: "check", label: "Saved" },
  unsaved: { level: "warning", mark: "dot", label: "Unsaved changes" },
  new: { level: "warning", mark: "dot", label: "Not saved yet" },
  saving: { level: "wait", mark: "dot", label: "Saving" },
  deleting: { level: "wait", mark: "dot", label: "Deleting" },
  loading: { level: "wait", mark: "dot", label: "Loading" },
  error: { level: "danger", mark: "alert", label: "Not saved" },
  // Asked for, and no answer came: it may or may not have been done.
  unconfirmed: { level: "danger", mark: "alert", label: "Not confirmed" },
  readonly: { level: "", mark: "lock", label: "Read-only" },
};

/** With no answer for this long, the page says the server is not answering. */
const WAIT_MS = 12000;
const SEARCH_WAIT_MS = 200;
/** What in a field takes the keyboard. */
const CONTROLS = "input, select, textarea, button";

/** A window's name inside a sentence: "the item editor", "the NPC editor". A word in capitals stays as it is. */
const inSentence = (tool: string): string => tool.split(" ").map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toLowerCase() + word.slice(1))).join(" ");

export class EditorShell {
  /** Opened by hand, not from the game: there is no game window to talk to. */
  readonly standalone = !window.opener;
  /** Under the list: room for what belongs to the whole window, not to one record. */
  readonly sideFoot = el("div", "tl-side-foot");

  private kinds: Kind[];
  private kind: Kind;
  private sideEl = document.getElementById("tl-side")!;
  private topEl = document.getElementById("tl-topbar")!;
  private bannerEl = document.getElementById("tl-banner")!;
  private tabsEl = document.getElementById("tl-tabs")!;
  private pageEl = document.getElementById("tl-page")!;
  /** The whole window: where it is said that the list of records is out, on a window too small to have it beside the page. */
  private appEl = document.querySelector<HTMLElement>(".tl-app-editor");

  private navEl = el("nav", "tl-nav");
  private navCounts = new Map<string, HTMLElement>();
  private listTitle = el("h2", "tl-list-title");
  private countEl = el("span", "tl-count");
  private searchInput!: HTMLInputElement;
  private addBtn: HTMLButtonElement | null = null;
  private listEl = el("div", "tl-list");
  private footEl = el("div", "tl-list-foot");
  private thumbSlot = el("span", "tl-record-thumb");
  private titleEl = el("h1", "tl-title");
  private noteEl = el("span", "tl-record-note");
  private stateEl = el("span", "tl-record-state");
  private extraEl = el("span", "tl-inline");
  private saveBtn: HTMLButtonElement | null = null;
  private copyBtn: HTMLButtonElement | null = null;
  private deleteBtn: HTMLButtonElement | null = null;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private pageKey = "";
  private problems: string[] = [];
  private problemsEl: HTMLElement | null = null;

  constructor(private opts: EditorOptions) {
    // An editor of one kind of record is an editor of several with one kind and no list of them.
    this.kinds = opts.kinds ?? [{ id: "", label: opts.plural ?? `${opts.noun}s`, noun: opts.noun ?? "record", plural: opts.plural, icon: opts.icon ?? "list", tabs: opts.tabs }];
    this.kind = this.kinds[0];
    this.buildSide();
    this.buildTop();
    this.tabsEl.setAttribute("role", "tablist");
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Not from under a question that is waiting for its answer.
        if (!document.querySelector("dialog[open]")) opts.onSave?.();
      }
    });
    this.setKind(this.kind.id);
    this.setRecord(null);
    this.setState(null);
    this.setActions({ open: false });
    this.setTabs(null);
    this.setCount(null);
    this.showList(true);
  }

  private get noun(): string {
    return this.kind.noun;
  }

  private get plural(): string {
    return this.kind.plural ?? `${this.kind.noun}s`;
  }

  /** The window's name as it is written inside a sentence. */
  private get toolName(): string {
    return inSentence(this.opts.tool);
  }

  // ------------------------------------------------------------- game window

  /** Send a message to the game window that opened this editor. Nothing else is ever written to. */
  send(msg: any): void {
    if (window.opener) window.opener.postMessage(msg, "*");
  }

  /**
   * Listen to the game window and tell it this window is ready. Messages from
   * anywhere else are ignored. When this window closes the game window is
   * told; when the game window is gone, this one closes.
   */
  connect(onMessage: (msg: any) => void): void {
    if (this.standalone) {
      this.usable(false);
      this.setList({ rows: [], empty: { icon: "plug", title: "Not connected", text: `The ${this.plural} are listed here once the editor is opened from the game.` } });
      this.screen("plug", "This window opens from the game", `Log in to the game as an admin and open the ${this.toolName} from there. It stays connected to your game.`);
      return;
    }
    window.addEventListener("message", (e) => {
      if (e.source !== window.opener) return;
      if (e.data?.type) onMessage(e.data);
    });
    window.addEventListener("beforeunload", () => this.send({ type: "editorClosed" }));
    // Backup for the game page closing us on unload: if the game tab is gone,
    // this editor has nothing to talk to, so close.
    setInterval(() => {
      if (!window.opener || window.opener.closed) window.close();
    }, 1000);
    this.send({ type: "bridgeReady" });
  }

  /**
   * Until the server's first answer: the shapes of what is loading. If nothing
   * has come after a while, the page says so and offers to ask again.
   */
  waiting(retry: () => void): void {
    if (this.standalone) return;
    this.usable(false);
    this.setList({ rows: [], loading: true });
    this.pageEl.replaceChildren();
    this.pageKey = "";
    const inner = el("div", "tl-page-inner tl-work");
    inner.setAttribute("aria-busy", "true");
    inner.setAttribute("aria-label", "Loading");
    const main = el("div", "tl-work-main");
    main.append(el("div", "tl-skeleton tl-skeleton-block"), el("div", "tl-skeleton tl-skeleton-tile"));
    inner.appendChild(main);
    this.pageEl.appendChild(inner);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      this.setList({ rows: [], empty: { icon: "plug", title: "Nothing to list", text: "The server has not answered yet." } });
      const box = this.screen("plug", "The server is not answering", `Nothing has come back for the ${this.toolName} yet. Check that your game is still connected and that your account may use this editor, then try again.`);
      box.appendChild(button("Try again", () => {
        this.waiting(retry);
        retry();
      }, { icon: "refresh", kind: "primary" }));
    }, WAIT_MS);
  }

  /** The server has answered: it is there, and the list can be searched and added to. */
  arrived(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.usable(true);
  }

  /**
   * The server answered that this admin may not use the editor, or that it
   * could not open it: the page says so in the server's words. With `retry`
   * there is a button to ask again.
   */
  refused(lines: string[], retry?: () => void): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.usable(false);
    this.setList({ rows: [], empty: { icon: "lock", title: "Nothing to list", text: "The server did not open the editor." } });
    const box = this.screen("lock", `The ${this.toolName} did not open`, lines.join(" "));
    if (!retry) return;
    // Quieter than on the page for a server that does not answer: asking again seldom changes a refusal.
    box.appendChild(button("Try again", () => {
      this.waiting(retry);
      retry();
    }, { icon: "refresh" }));
  }

  /** The kinds, the search field and New work only while there is a server to ask. */
  private usable(on: boolean): void {
    this.searchInput.disabled = !on;
    if (this.addBtn) this.addBtn.disabled = !on;
    for (const item of this.navEl.querySelectorAll<HTMLButtonElement>(".tl-nav-item")) item.disabled = !on;
  }

  // --------------------------------------------------------------- side pane

  private buildSide(): void {
    const { opts } = this;
    const brand = el("div", "tl-brand");
    const mark = el("span", "tl-brand-mark");
    mark.appendChild(icon("flame", 18));
    const name = el("span", "tl-brand-words");
    name.append(el("span", "tl-brand-name", "Frostfire Forge"), el("span", "tl-brand-sub", opts.tool));
    brand.append(mark, name);

    // The kinds of record, as the control panel lists its pages.
    this.navEl.setAttribute("aria-label", "What to edit");
    for (const kind of opts.kinds ?? []) {
      const item = el("button", "tl-nav-item");
      item.type = "button";
      item.dataset.kind = kind.id;
      const count = el("span", "tl-count");
      this.navCounts.set(kind.id, count);
      item.append(icon(kind.icon, 17), el("span", "tl-nav-label", kind.label), count);
      item.addEventListener("click", () => opts.onKind?.(kind.id));
      this.navEl.appendChild(item);
    }
    // Up and down move through the kinds.
    this.navEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...this.navEl.querySelectorAll<HTMLElement>(".tl-nav-item")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    });

    const head = el("div", "tl-list-head");
    this.listTitle.id = "tl-list-title";
    head.append(this.listTitle, this.countEl);
    const search = searchBox("Search", () => {
      if (opts.liveSearch) return opts.onSearch(this.query);
      if (this.searchTimer) clearTimeout(this.searchTimer);
      // Waited for, so typing does not send a request per key.
      this.searchTimer = setTimeout(() => opts.onSearch(this.takeQuery()), SEARCH_WAIT_MS);
    });
    this.searchInput = search.input;
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !opts.liveSearch) opts.onSearch(this.takeQuery());
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.listEl.querySelector<HTMLElement>(".tl-list-open")?.focus();
      }
    });
    const tools = el("div", "tl-side-tools");
    tools.append(head, search.root);
    if (opts.onNew) {
      this.addBtn = button("New", () => {
        opts.onNew?.();
        this.showList(false);
      }, { icon: "plus", block: true });
      this.addBtn.dataset.act = "new";
      tools.appendChild(this.addBtn);
    }

    this.listEl.setAttribute("role", "list");
    this.listEl.setAttribute("aria-labelledby", this.listTitle.id);
    // Up and down move through the rows, as in any list.
    this.listEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = [...this.listEl.querySelectorAll<HTMLElement>(".tl-list-open")];
      const at = rows.indexOf((document.activeElement as HTMLElement)?.closest(".tl-list-row")?.querySelector(".tl-list-open") as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && at === 0) this.searchInput.focus();
      else rows[Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
    });
    this.footEl.hidden = true;
    this.sideEl.append(brand, ...(opts.kinds ? [this.navEl] : []), tools, this.listEl, this.footEl, this.sideFoot);
  }

  /** The kind in view: marked in the list of kinds, and named over the list, in the search field, on New and on the tabs. */
  setKind(id: string): void {
    this.kind = this.kinds.find((kind) => kind.id === id) ?? this.kind;
    for (const item of this.navEl.querySelectorAll<HTMLElement>(".tl-nav-item")) {
      const here = item.dataset.kind === this.kind.id;
      item.classList.toggle("is-active", here);
      if (here) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    const label = this.kind.label;
    this.listTitle.textContent = label;
    this.searchInput.placeholder = `Search ${this.plural}`;
    this.searchInput.setAttribute("aria-label", `Search ${this.plural}`);
    const said = this.addBtn?.querySelector("span");
    if (said) said.textContent = `New ${this.noun}`;
    this.sideEl.setAttribute("aria-label", label.charAt(0).toUpperCase() + label.slice(1));
    this.tabsEl.setAttribute("aria-label", `Parts of the ${this.noun}`);
  }

  /** How many records there are in all, beside the list's title. */
  setCount(total: number | null): void {
    this.countEl.hidden = total === null;
    this.countEl.textContent = total === null ? "" : num(total);
    this.countEl.title = total === null ? "" : `${num(total)} ${total === 1 ? this.noun : this.plural} in all`;
  }

  /** How many records each kind has, beside its name; the kind in view also beside the list's title. Null hides them. */
  setCounts(counts: Record<string, number> | null): void {
    for (const [id, node] of this.navCounts) {
      node.hidden = !counts;
      node.textContent = counts ? num(counts[id] ?? 0) : "";
    }
    this.setCount(counts ? counts[this.kind.id] ?? 0 : null);
  }

  /** What is in the search field now. */
  get query(): string {
    return this.searchInput.value.trim();
  }

  /** The same, for a search about to be sent: one still waiting on the typing to stop is forgotten. */
  takeQuery(): string {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    return this.query;
  }

  /** Empties the search field: what was looked for among one kind says nothing about another. */
  clearQuery(): void {
    this.takeQuery();
    this.searchInput.value = "";
  }

  /** The records found, one to a row, or why there are none. */
  setList(state: ListState): void {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".tl-list-row")?.dataset.id;
    const top = this.listEl.scrollTop;
    this.listEl.replaceChildren();
    this.footEl.hidden = !state.foot;
    this.footEl.textContent = state.foot ?? "";
    if (state.loading) {
      this.listEl.setAttribute("aria-busy", "true");
      for (let i = 0; i < 7; i++) this.listEl.appendChild(el("div", "tl-skeleton tl-skeleton-row"));
      return;
    }
    this.listEl.removeAttribute("aria-busy");
    if (state.rows.length === 0 && state.empty) {
      empty(this.listEl, state.empty.icon ?? this.kind.icon, state.empty.title, state.empty.text ?? "");
      return;
    }
    for (const entry of state.rows) {
      const row = el("div", "tl-list-row" + (entry.selected ? " is-selected" : ""));
      row.setAttribute("role", "listitem");
      row.dataset.id = entry.id;
      const open = el("button", "tl-list-open");
      open.type = "button";
      open.title = entry.note ? `${entry.name} (${entry.note})` : entry.name;
      if (entry.selected) open.setAttribute("aria-current", "true");
      const said = el("span", "tl-list-words");
      said.appendChild(el("span", "tl-list-name", entry.name));
      if (entry.note) said.appendChild(el("span", "tl-list-note", entry.note));
      open.append(entry.thumb ?? thumb(null, { fallback: this.kind.icon }), said);
      if (entry.tags?.length) {
        const tags = el("span", "tl-tags");
        tags.append(...entry.tags);
        open.appendChild(tags);
      }
      open.addEventListener("click", () => {
        entry.onOpen();
        this.showList(false);
      });
      row.appendChild(open);
      if (entry.actions?.length) {
        const actions = el("span", "tl-list-actions");
        for (const action of entry.actions) actions.appendChild(iconButton(action.icon, action.label, () => action.onClick(), { danger: action.danger, size: 15 }));
        row.appendChild(actions);
      }
      this.listEl.appendChild(row);
    }
    // The list is drawn again at every answer of the server: it stays where it was scrolled to.
    this.listEl.scrollTop = top;
    if (focused) this.listEl.querySelector<HTMLElement>(`.tl-list-row[data-id="${CSS.escape(focused)}"] .tl-list-open`)?.focus({ preventScroll: true });
  }

  /** Brings the open record's row into view, after it was opened from somewhere other than its row. */
  showSelected(): void {
    this.listEl.querySelector(".tl-list-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  // ----------------------------------------------------------------- top bar

  private buildTop(): void {
    const { opts } = this;
    const said = el("div", "tl-record-words");
    said.append(this.titleEl, this.noteEl);
    this.stateEl.setAttribute("role", "status");
    const record = el("div", "tl-record");
    record.append(this.thumbSlot, said, this.stateEl);

    const actions = el("div", "tl-topbar-actions");
    actions.appendChild(this.extraEl);
    if (opts.onDuplicate) {
      this.copyBtn = button("Duplicate", () => opts.onDuplicate?.(), { icon: "copy", kind: "quiet", fold: true });
      this.copyBtn.dataset.act = "duplicate";
      actions.appendChild(this.copyBtn);
    }
    if (opts.onDelete) {
      this.deleteBtn = button("Delete", () => opts.onDelete?.(), { icon: "trash", kind: "quiet-danger", fold: true });
      this.deleteBtn.dataset.act = "delete";
      actions.appendChild(this.deleteBtn);
    }
    if (opts.onSave && opts.saveButton !== false) {
      this.saveBtn = button("Save", () => opts.onSave?.(), { icon: "save" });
      this.saveBtn.dataset.act = "save";
      actions.append(el("span", "tl-topbar-rule"), this.saveBtn);
    }
    // On a small window (a phone, either way up) the list of records is not beside the page but slides over it
    // (css/tools.css): this button brings it out, and a tap beside it, on a record or on New puts it away.
    const toggle = iconButton("list", "Show the list", () => this.showList(true));
    toggle.classList.add("tl-list-toggle");
    this.topEl.append(toggle, record, actions);
    const scrim = el("div", "tl-scrim");
    scrim.addEventListener("click", () => this.showList(false));
    this.appEl?.appendChild(scrim);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.appEl?.classList.contains("is-list-open") && !document.querySelector("dialog[open]")) this.showList(false);
    });
  }

  /**
   * On a small window, where the list of records slides over the page: bring it out or put it away. It starts out,
   * as there is nothing open to look at yet. On a full window the list is always beside the page and this changes
   * nothing. USER REQUEST 2026-10-07: "Update other panels to work on mobile landscape and portrait".
   */
  showList(open: boolean): void {
    this.appEl?.classList.toggle("is-list-open", open);
  }

  /** What is open, in the top bar and in the window's title. Null when nothing is. */
  setRecord(record: { title: string; note?: string; thumb?: HTMLElement } | null): void {
    const { tool } = this.opts;
    document.title = record ? `${record.title} · ${tool}` : tool;
    this.titleEl.textContent = record ? record.title : `No ${this.noun} open`;
    this.titleEl.title = record ? record.title : "";
    this.noteEl.textContent = record?.note ?? "";
    this.noteEl.title = record?.note ?? "";
    this.noteEl.hidden = !this.noteEl.textContent;
    this.thumbSlot.hidden = !record?.thumb;
    // The picture is only put in again when it is another one, not at every key typed.
    if (record?.thumb !== this.thumbSlot.firstElementChild) this.thumbSlot.replaceChildren(...(record?.thumb ? [record.thumb] : []));
  }

  /**
   * How the open record stands: saved, changed, on its way to the server,
   * refused. Null when nothing is open. `label` replaces the usual words, for
   * an editor where they would be wrong.
   */
  setState(state: RecordState | null, label?: string): void {
    const text = state ? label ?? STATES[state].label : "";
    // Said again only when it changes: it is read out as a status.
    if (this.stateEl.dataset.state === `${state}:${text}`) return;
    this.stateEl.dataset.state = `${state}:${text}`;
    this.stateEl.replaceChildren();
    if (state) this.stateEl.appendChild(pill(text, STATES[state].level, STATES[state].mark));
  }

  /** Which of the top bar's buttons can be used now. They never move. */
  setActions(state: ActionState): void {
    const waiting = !!state.busy;
    const nothing = `No ${this.noun} is open`;
    if (this.saveBtn) {
      const canSave = state.open && state.canSave !== false;
      // The button that is waiting shows its spinner at full strength; the others are greyed out until the answer comes.
      this.saveBtn.disabled = !canSave || (waiting && state.busy !== "save");
      this.saveBtn.classList.toggle("tl-btn-primary", canSave && !!state.dirty);
      setBusy(this.saveBtn, state.busy === "save");
      tooltip(this.saveBtn, !state.open ? nothing : state.canSave === false ? state.why?.save ?? "This one cannot be saved here" : state.busy === "save" ? "Saving" : state.dirty ? "Save changes (Ctrl+S)" : "No unsaved changes");
    }
    if (this.copyBtn) {
      this.copyBtn.disabled = !state.open || state.canDuplicate === false || waiting;
      tooltip(this.copyBtn, !state.open ? nothing : state.canDuplicate === false ? state.why?.duplicate ?? "This one cannot be copied yet" : `Start a new ${this.noun} as a copy of this one`);
    }
    if (this.deleteBtn) {
      this.deleteBtn.disabled = !state.open || state.canDelete === false || (waiting && state.busy !== "delete");
      setBusy(this.deleteBtn, state.busy === "delete");
      tooltip(this.deleteBtn, !state.open ? nothing : state.canDelete === false ? state.why?.delete ?? "This one cannot be deleted here" : state.deleteTip ?? `Delete this ${this.noun}`);
    }
    this.extraEl.replaceChildren(...(state.extra ?? []));
    this.extraEl.hidden = !state.extra?.length;
  }

  // ------------------------------------------------------------ tabs, banner

  /**
   * The tab in view, how many problems each tab has (a tab with problems shows
   * their number, so a refused save points at where to look) and how many
   * things a tab lists. Null hides the tabs: nothing is open, or the kind in
   * view has none.
   */
  setTabs(active: string | null, problems: Record<string, number> = {}, counts: Record<string, number> = {}): void {
    const tabs = this.kind.tabs ?? [];
    this.tabsEl.hidden = active === null || tabs.length === 0;
    if (this.tabsEl.hidden) return void this.tabsEl.replaceChildren();
    const focused = (document.activeElement as HTMLElement | null)?.dataset.tab;
    this.tabsEl.replaceChildren();
    for (const tab of tabs) {
      const here = tab.id === active;
      const btn = el("button", "tl-tab");
      btn.type = "button";
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(here));
      btn.tabIndex = here ? 0 : -1;
      btn.appendChild(el("span", "", tab.label));
      const listed = counts[tab.id];
      if (listed !== undefined) btn.appendChild(el("span", "tl-count", num(listed)));
      const wrong = problems[tab.id] ?? 0;
      if (wrong > 0) {
        const mark = el("span", "tl-tab-mark", num(wrong));
        mark.title = wrong === 1 ? "1 problem on this tab" : `${num(wrong)} problems on this tab`;
        btn.appendChild(mark);
        btn.setAttribute("aria-label", `${tab.label}, ${mark.title}`);
      }
      btn.addEventListener("click", () => this.opts.onTab?.(tab.id));
      this.tabsEl.appendChild(btn);
    }
    if (focused) this.tabsEl.querySelector<HTMLElement>(`[data-tab="${CSS.escape(focused)}"]`)?.focus();
    if (this.tabsEl.dataset.keys) return;
    this.tabsEl.dataset.keys = "1";
    // Left and right move through the tabs and open the one they land on.
    this.tabsEl.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const all = [...this.tabsEl.querySelectorAll<HTMLElement>(".tl-tab")];
      const next = all[(all.indexOf(document.activeElement as HTMLElement) + step + all.length) % all.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.click();
    });
  }

  /** One line under the top bar, about the open record as a whole. Null takes it away. */
  setBanner(banner: Banner | null): void {
    this.bannerEl.replaceChildren();
    this.bannerEl.className = "tl-banner";
    this.bannerEl.hidden = !banner;
    if (!banner) return;
    this.bannerEl.classList.add(`tl-banner-${banner.tone}`);
    this.bannerEl.append(icon(banner.icon, 16), el("span", "", banner.text));
    if (banner.action) {
      const link = el("button", "tl-link", banner.action.label);
      link.type = "button";
      link.addEventListener("click", banner.action.onClick);
      this.bannerEl.appendChild(link);
    }
  }

  // -------------------------------------------------------------------- page

  /**
   * Empties the page and hands back where the cards go: `main` for the form,
   * `aside` for what stays in view beside it (only there with `aside`).
   * `key` names what is being shown, the record and the tab: while it stays
   * the same, a redraw keeps the scrolling and puts the keyboard back in the
   * very control it was in (the second coin box of an amount, the choice
   * picked among several), with the caret where it stood.
   */
  page(key: string, opts: { aside?: boolean; readOnly?: boolean } = {}): { main: HTMLElement; aside: HTMLElement } {
    const same = key === this.pageKey;
    const top = same ? this.pageEl.scrollTop : 0;
    const active = document.activeElement as HTMLElement | null;
    const wrap = same && active && this.pageEl.contains(active) ? active.closest<HTMLElement>("[data-field]") : null;
    const typed = (active instanceof HTMLInputElement && active.type === "text") || active instanceof HTMLTextAreaElement;
    const held = wrap && active ? {
      field: wrap.dataset.field!,
      at: [...wrap.querySelectorAll(CONTROLS)].indexOf(active),
      caret: typed ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : null,
    } : null;
    // A control that is not a field's (a row of a table, a fold) is found again by its own mark.
    const mark = same && !held && active && this.pageEl.contains(active) ? active.closest<HTMLElement>("[data-keep]")?.dataset.keep : undefined;
    this.pageKey = key;

    this.pageEl.replaceChildren();
    const inner = el("div", "tl-page-inner tl-work" + (opts.aside ? " has-aside" : "") + (opts.readOnly ? " is-readonly" : ""));
    const main = el("div", "tl-work-main");
    const aside = el("aside", "tl-work-aside");
    inner.appendChild(main);
    if (opts.aside) inner.appendChild(aside);
    this.pageEl.appendChild(inner);
    this.problemsEl = el("div", "tl-error");
    this.problemsEl.setAttribute("role", "alert");
    main.appendChild(this.problemsEl);
    this.paintProblems();

    // Once the caller has filled the page in.
    queueMicrotask(() => {
      this.pageEl.scrollTop = top;
      if (mark) this.pageEl.querySelector<HTMLElement>(`[data-keep="${CSS.escape(mark)}"]`)?.focus({ preventScroll: true });
      if (!held) return;
      const controls = [...(this.pageEl.querySelector<HTMLElement>(`[data-field="${CSS.escape(held.field)}"]`)?.querySelectorAll<HTMLElement>(CONTROLS) ?? [])];
      // Among choices, the one that is picked now; otherwise the control in the same place.
      const control = controls.find((c) => c.getAttribute("role") === "radio" && c.getAttribute("aria-checked") === "true") ?? controls[held.at] ?? controls[0];
      control?.focus({ preventScroll: true });
      if (held.caret && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
        try {
          control.setSelectionRange(held.caret[0], held.caret[1]);
        } catch {
          // Not a control that has a caret.
        }
      }
    });
    return { main, aside };
  }

  /** A page with nothing to show but a reason. Returns the box, to add a button to. */
  screen(name: IconName, title: string, text: string): HTMLElement {
    this.pageEl.replaceChildren();
    this.pageKey = "";
    this.problemsEl = null;
    return screen(this.pageEl, name, title, text);
  }

  /**
   * The page while no record is open: `text` says how to open or start one.
   * When there are no records at all the page says that instead, with `none`
   * as the sentence under it. Returns the box, to add the New button to.
   */
  idle(text: string, none: string | null = null): HTMLElement {
    return this.screen(this.kind.icon, none === null ? `No ${this.noun} open` : `There are no ${this.plural} yet`, none ?? text);
  }

  /**
   * What is wrong with the open record, summarised at the top of the page
   * whichever tab is in view. Fields carry their own problem; this says how
   * many there are and where, and anything that is not about one field.
   */
  setProblems(lines: string[], show = true): void {
    this.problems = lines;
    this.paintProblems();
    if (show && lines.length) this.pageEl.scrollTop = 0;
  }

  private paintProblems(): void {
    const box = this.problemsEl;
    if (!box) return;
    box.hidden = this.problems.length === 0;
    box.replaceChildren();
    if (!this.problems.length) return;
    box.appendChild(icon("alert", 15));
    const said = el("div");
    for (const line of this.problems) said.appendChild(el("div", "", line));
    box.appendChild(said);
  }

  /** Puts the keyboard in a field of the page, by its path, and selects what is in it. */
  focusField(path: string): void {
    const control = this.pageEl.querySelector<HTMLElement>(`[data-field="${CSS.escape(path)}"]`)?.querySelector<HTMLElement>(CONTROLS);
    control?.focus();
    if (control instanceof HTMLInputElement && control.type === "text") control.select();
  }

  /** Scrolls a part of the page into view, if it is not already. */
  reveal(selector: string): void {
    queueMicrotask(() => this.pageEl.querySelector(selector)?.scrollIntoView({ block: "nearest" }));
  }

  // --------------------------------------------------------------- questions

  /** Asked before leaving a record with changes that are not saved. True when they may be thrown away. */
  discard(name: string): Promise<boolean> {
    return confirmDialog({
      title: "Discard your changes?",
      body: `What you changed in ${name} has not been saved, and is lost if you leave it now.`,
      okLabel: "Discard changes",
      cancelLabel: "Keep editing",
    });
  }

  /**
   * Asked on the way to another kind of record while the open one has changes
   * that are not saved: save them first, throw them away, or stay.
   */
  leave(name: string): Promise<"save" | "discard" | "stay"> {
    return leaveDialog(name);
  }

  /** Asked before a record is deleted. `consequence` says what that means for the game. */
  confirmDelete(name: string, consequence: string | string[], noun = this.noun): Promise<boolean> {
    return confirmDialog({ title: `Delete ${name}?`, body: consequence, okLabel: `Delete ${noun}` });
  }
}
