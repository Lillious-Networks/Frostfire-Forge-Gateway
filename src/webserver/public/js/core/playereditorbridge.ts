// Player editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which checks permission, validates
// and applies each change, then answers with the player as they now stand.
// List changes (items, equipment, friends...) are sent as they are made; the
// forms (stats, currency, location, permissions) are sent by their own Apply.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the player editor's own: the accounts in the side pane, the cards of
// each tab, the item picker and its conversation with the server.
import { qualityOf } from "./itemframe.js";
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { coinWords, COPPER_PER_GOLD, COPPER_PER_SILVER, FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import {
  askText, avatar, button, card, confirmDialog, count, el, empty, forbid, icon, iconButton, listed, note, num, openDialog, pill, searchBox, setBusy,
  shown, switchControl, tag, thumb, toast, words, type ButtonOptions, type IconName,
} from "./toolkit.js";

type Form = "stats" | "currency" | "location" | "permissions";
type Account = { username: string; userid: number; online: boolean };
type InventoryItem = PlayerEditorSnapshot["inventory"][number];
/** What asked for a change: the control that waits for the answer, and what to say once the server has made it. */
type Origin = { fk: string; done: string };

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "stats", label: "Stats" },
  { id: "inventory", label: "Inventory" },
  { id: "equipment", label: "Equipment" },
  { id: "collections", label: "Collections" },
  { id: "social", label: "Social" },
  { id: "quests", label: "Quests" },
  { id: "access", label: "Access" },
];

/** The form each action applies, so its Apply button settles once the server has it. */
const FORM_OF: Record<string, Form> = {
  "stats.set": "stats",
  "currency.set": "currency",
  "location.set": "location",
  "permissions.set": "permissions",
};

/**
 * Where each kind of change is made: the tab, and the card on it. What the
 * server refuses is said in that card, under the controls that asked.
 */
const PLACES: Array<[action: string, tab: string, card: string]> = [
  ["stats.", "stats", "stats"],
  ["currency.", "overview", "currency"],
  ["location.", "overview", "location"],
  ["inventory.", "inventory", "inventory"],
  ["equipment.", "equipment", "equipment"],
  ["collectable.", "collections", "mounts"],
  ["spell.", "collections", "spells"],
  ["friend.", "social", "friends"],
  ["guild.", "social", "guild"],
  ["party.", "social", "party"],
  ["quest.forget", "quests", "completed"],
  ["quest.", "quests", "active"],
  ["permissions.", "access", "permissions"],
  ["admin.", "access", "role"],
];

/**
 * The server answers a refused form in sentences, not by field, and starts
 * each with the field's own label ("Max health must be..."). This says which
 * field of which form a sentence is about, so the field can be marked. A
 * sentence that matches nothing is still shown in the form's card.
 */
const PROBLEM_FIELDS: Array<[RegExp, string]> = [
  [/^Level /, "stats.level"],
  [/^XP /, "stats.xp"],
  [/^Health /, "stats.health"],
  [/^Max health /, "stats.max_health"],
  [/^Mana /, "stats.stamina"],
  [/^Max mana /, "stats.max_stamina"],
  [/^Damage /, "stats.stat_damage"],
  [/^Armor /, "stats.stat_armor"],
  [/^Critical chance /, "stats.stat_critical_chance"],
  [/^Critical damage /, "stats.stat_critical_damage"],
  [/^Avoidance /, "stats.stat_avoidance"],
  [/^X /, "location.x"],
  [/^Y /, "location.y"],
  [/^That map /, "location.map"],
  [/^That is not a direction/, "location.direction"],
  [/^(Gold|Silver|Copper) /, "currency.total"],
];

const DEAD_STATES = ["Alive", "Dead, awaiting release", "Ghost"];

/** The ways a player can face, written for reading. */
const FACING: Record<string, string> = {
  down: "Down", up: "Up", left: "Left", right: "Right",
  downleft: "Down and left", downright: "Down and right", upleft: "Up and left", upright: "Up and right",
};

/** With no answer for this long, a request is given up on. */
const ANSWER_WITHIN_MS = 15000;
/** The editor opens on one player: the page keeps its loading shapes this long for them to arrive. */
const OPENING_MS = 1500;

/** "Rare equipment · Helmet": what kind of item it is. */
function kindOf(item: { quality?: unknown; type?: unknown; equipment_slot?: unknown }): string {
  const kind = `${words(qualityOf(item.quality))} ${String(item.type || "item")}`;
  return item.equipment_slot ? `${kind} · ${words(item.equipment_slot)}` : kind;
}

class PlayerEditorBridge {
  private options: PlayerEditorOptions | null = null;
  private snapshot: PlayerEditorSnapshot | null = null;
  private assetServerUrl = "";
  private tab = "overview";

  /** Side pane: who is online, or the accounts matching the search. */
  private players: Account[] = [];
  private playersTruncated = 0;
  /** The server has answered at least once. */
  private heard = false;
  /** The server said this admin may not use the editor. */
  private denied = false;
  /** The player the editor was opened on has arrived, or has had long enough to. */
  private opened = false;

  /** What the forms hold until Apply. Currency is one copper total, as the money field edits it. */
  private drafts = {
    stats: {} as Record<string, number | null>,
    currency: { total: 0 },
    location: { map: "", x: 0, y: 0, direction: "down" } as Record<string, string | number | null>,
    permissions: new Set<string>(),
  };
  /** Forms with edits that have not been applied. */
  private dirty = new Set<Form>();
  private applyButtons = new Map<Form, HTMLButtonElement>();

  /** The load or change waiting for its answer: one at a time, so each answer is the latest state. */
  private pending: (Origin & { what: string; target?: string }) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The open item picker, fed by the server's search results. */
  private picker: { paint(result: any): void } | null = null;

  /** What the server refused, by the card it was asked from. It stands until a change goes through or the player is loaded again. */
  private refusals = new Map<string, string[]>();
  /** The same by field, for the sentences that are about one field of a form. */
  private fieldErrors: Record<string, string> = {};
  private errorSlots = new Map<string, HTMLElement>();

  private pageEl = document.getElementById("tl-page")!;
  /** The open player's state in the top bar: online, admin, banned and so on. */
  private flagsEl = el("span", "pl-flags");
  private reloadBtn = button("Reload", () => {
    if (this.snapshot) void this.select(this.snapshot.username, "reload");
  }, { icon: "refresh", kind: "quiet", fold: true, tip: "Reload this player from the server" });

  private shell = new EditorShell({
    tool: "Player Editor", noun: "player", icon: "user", tabs: TABS,
    // The search asks the server: the client never holds every account.
    onSearch: () => this.searchPlayers(),
    // Players are not made, copied or deleted here, and nothing waits for one Save, so the editor
    // has none of those buttons. Ctrl+S applies the form the keyboard is in.
    onSave: () => this.applyFocused(),
    saveButton: false,
    onTab: (id) => this.switchTab(id),
  });

  private fields = new FieldRenderer({ rerender: () => this.renderPage() });

  constructor() {
    // The player's own state sits beside their name, before the state of the editor's changes.
    document.querySelector("#tl-topbar .tl-record-state")?.before(this.flagsEl);
    const search = document.querySelector<HTMLInputElement>("#tl-side .tl-search input");
    if (search) {
      search.placeholder = "Search every account";
      search.setAttribute("aria-label", "Search every account by username");
    }
    this.chrome();
    this.shell.waiting(() => this.searchPlayers());
    this.shell.connect((msg) => this.onMessage(msg));
    if (this.shell.standalone) return;
    this.searchPlayers();
  }

  private request(packet: string, data: any): void {
    this.shell.send({ type: "request", packet, data });
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      const asked = this.pending;
      const before = this.snapshot?.username;
      const lost = this.dirty.size > 0;
      this.endRequest();
      this.hear();
      this.denied = false;
      this.options = msg.data.options;
      this.assetServerUrl = msg.data.assetServerUrl || "";
      this.dirty.clear();
      this.clearRefusals();
      this.setSnapshot(msg.data.snapshot);
      this.opened = true;
      const now = msg.data.snapshot.username;
      if (before && before !== now) {
        // A question about the last player is not one about this player.
        this.closeDialogs();
        // Opened from the game (/player edit, the player's menu), not from this window's list.
        if (asked?.what !== "load") toast(`${shown(now)} was opened from the game.${lost ? `\nWhat was not applied to ${shown(before)} was dropped.` : ""}`, lost ? "warning" : "info");
      }
      this.render();
      // Who is online may have changed since the list was fetched.
      this.searchPlayers();
    } else if (msg.type === "results") {
      if (msg.data?.kind === "items") {
        this.picker?.paint(msg.data);
      } else if (msg.data?.kind === "players" && msg.data.query === this.shell.query.toLowerCase()) {
        this.players = Array.isArray(msg.data.players) ? msg.data.players : [];
        this.playersTruncated = Number(msg.data.truncated) || 0;
        const first = !this.heard;
        this.hear();
        this.renderList();
        if (first) this.renderPage();
      }
    } else if (msg.type === "result") {
      const asked = this.pending;
      this.endRequest();
      this.hear();
      if (msg.denied) return this.deny(msg.errors);
      const action = String(msg.action ?? "");
      if (msg.ok) {
        const form = FORM_OF[action];
        if (form) this.dirty.delete(form);
        this.clearRefusals();
        toast(asked?.what === action && asked.done ? asked.done : "Saved.");
      } else {
        const lines: string[] = msg.errors?.length ? msg.errors : ["The change was refused."];
        if (action === "load") this.notOpened(asked?.target, lines);
        else this.refuse(action, lines);
      }
      // Sent with a refusal too: the editor always shows what the server has.
      if (msg.snapshot) this.setSnapshot(msg.snapshot);
      this.opened = true;
      this.render();
      // After the page has put its scrolling back.
      if (!msg.ok && action !== "load") queueMicrotask(() => this.pointOut(action));
    }
  }

  /** The server has answered: it is there, and the accounts can be searched. */
  private hear(): void {
    if (this.heard) return;
    this.heard = true;
    this.shell.arrived();
    // The player the editor was opened on comes with the first answers: wait a moment before saying nobody is open.
    setTimeout(() => {
      if (this.opened) return;
      this.opened = true;
      if (!this.snapshot && !this.denied) this.renderPage();
    }, OPENING_MS);
  }

  /** The server will not let this admin use the editor: the page says so, in its words. */
  private deny(lines?: string[]): void {
    this.denied = true;
    this.snapshot = null;
    this.options = null;
    this.players = [];
    this.dirty.clear();
    this.clearRefusals();
    this.closeDialogs();
    this.chrome();
    this.shell.setCount(null);
    this.shell.refused(lines?.length ? lines : ["You don't have permission to use the player editor."], () => {
      this.denied = false;
      this.heard = false;
      this.opened = false;
      this.searchPlayers();
    });
  }

  /** Forms with unapplied edits keep them; the rest follow the server. */
  private setSnapshot(snapshot: PlayerEditorSnapshot): void {
    this.snapshot = snapshot;
    if (!this.dirty.has("stats")) this.drafts.stats = { ...snapshot.stats };
    if (!this.dirty.has("currency")) {
      const { gold, silver, copper } = snapshot.currency;
      this.drafts.currency = { total: gold * COPPER_PER_GOLD + silver * COPPER_PER_SILVER + copper };
    }
    if (!this.dirty.has("location")) this.drafts.location = { ...snapshot.location };
    if (!this.dirty.has("permissions")) this.drafts.permissions = new Set(snapshot.permissions);
  }

  // ---------------------------------------------------------------- requests

  /** False while an earlier load or change is still waiting for its answer. */
  private begin(pending: Origin & { what: string; target?: string }): boolean {
    if (this.pending) {
      toast("Still waiting for the server to answer the last request.", "warning");
      return false;
    }
    this.pending = pending;
    // No answer ever comes if the connection drops: don't stay blocked forever.
    this.pendingTimer = setTimeout(() => {
      this.endRequest();
      const lines = ["The server did not answer in time, so nothing was confirmed."];
      if (pending.what === "load") this.notOpened(pending.target, lines);
      else this.refuse(pending.what, lines);
      this.render();
      if (pending.what !== "load") queueMicrotask(() => this.pointOut(pending.what));
    }, ANSWER_WITHIN_MS);
    return true;
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
  }

  private load(target: string, fk: string): void {
    if (!this.begin({ what: "load", fk, done: "", target })) return;
    this.request("PLAYER_EDITOR_LOAD", { target });
    this.chrome();
    if (!this.snapshot) this.renderPage();
  }

  /** Ask the server to change the open player. False when it was not asked: nobody is open, or an answer is still awaited. */
  private act(action: string, data: Record<string, unknown>, origin: Origin): boolean {
    if (!this.snapshot || !this.begin({ what: action, ...origin })) return false;
    // What was wrong with the last try from here is about to be answered again.
    const place = this.placeOf(action);
    if (place) this.clearRefusal(place.card);
    this.request("PLAYER_EDITOR_ACTION", { ...data, target: this.snapshot.username, action });
    const control = this.pageEl.querySelector<HTMLElement>(`[data-fk="${CSS.escape(origin.fk)}"]`);
    if (control instanceof HTMLButtonElement) setBusy(control, true);
    this.chrome();
    return true;
  }

  private searchPlayers(): void {
    this.request("PLAYER_EDITOR_SEARCH", { kind: "players", query: this.shell.takeQuery() });
  }

  /** Open (or reload) a player from the list. */
  private async select(username: string, fk = `open:${username}`): Promise<void> {
    if (this.dirty.size > 0 && this.snapshot && !(await this.shell.discard(shown(this.snapshot.username)))) return;
    this.load(username, fk);
  }

  /** True while the player a question was asked about is still the one open. */
  private still(who: string): boolean {
    if (this.snapshot?.username === who) return true;
    toast(`${shown(who)} is no longer the player open here, so nothing was changed.`, "error");
    return false;
  }

  /** Questions left open are closed: they were asked about a player who is not the one open any more. */
  private closeDialogs(): void {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
  }

  // ---------------------------------------------------------------- refusals

  private placeOf(action: string): { tab: string; card: string } | null {
    const place = PLACES.find(([prefix]) => action.startsWith(prefix));
    return place ? { tab: place[1], card: place[2] } : null;
  }

  /** The server would not make a change: it is kept to be said in the card the change was asked from. */
  private refuse(action: string, lines: string[]): void {
    const place = this.placeOf(action);
    if (!place || !this.snapshot) return toast(lines.join("\n"), "error");
    this.refusals.set(place.card, lines);
    const form = FORM_OF[action];
    if (!form) return;
    for (const line of lines) {
      const path = PROBLEM_FIELDS.find(([pattern, field]) => field.startsWith(`${form}.`) && pattern.test(line))?.[1];
      if (path) this.fieldErrors[path] ??= line;
    }
  }

  /**
   * Once the page is drawn with a refusal: if the place it is said in cannot
   * be seen (another tab is in view, or it is further down a long list), it
   * is said in the corner too.
   */
  private pointOut(action: string): void {
    const card = this.placeOf(action)?.card;
    const lines = card ? this.refusals.get(card) : undefined;
    if (!card || !lines) return;
    const slot = this.errorSlots.get(card);
    const within = this.pageEl.getBoundingClientRect();
    const at = slot?.isConnected ? slot.getBoundingClientRect() : null;
    if (!at || at.top < within.top || at.bottom > within.bottom) toast(lines.join("\n"), "error");
  }

  /** A player could not be opened: there is no card to say it in. */
  private notOpened(target: string | undefined, lines: string[]): void {
    toast(`${target ? shown(target) : "The player"} was not opened\n${lines.join(" ")}`, "error");
  }

  private clearRefusal(key: string): void {
    if (!this.refusals.delete(key)) return;
    for (const path of Object.keys(this.fieldErrors)) if (path.startsWith(`${key}.`)) delete this.fieldErrors[path];
    this.paintRefusal(key);
  }

  /** Nothing is wrong any more: a change went through, or the player was loaded again. */
  private clearRefusals(): void {
    this.refusals.clear();
    this.fieldErrors = {};
  }

  /** Where the refusals of one card are shown: under its controls. */
  private errorSlot(key: string): HTMLElement {
    const slot = el("div", "tl-error");
    slot.setAttribute("role", "alert");
    this.errorSlots.set(key, slot);
    this.paintRefusal(key);
    return slot;
  }

  private paintRefusal(key: string): void {
    const slot = this.errorSlots.get(key);
    if (!slot) return;
    const lines = this.refusals.get(key) ?? [];
    slot.hidden = lines.length === 0;
    slot.replaceChildren();
    if (!lines.length) return;
    slot.appendChild(icon("alert", 15));
    const said = el("div");
    for (const line of lines) said.appendChild(el("div", "", line));
    slot.appendChild(said);
  }

  /** How many refused sentences stand on each tab, so a tab that is not in view shows there is something to read. */
  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [key, lines] of this.refusals) {
      const tab = PLACES.find(([, , card]) => card === key)?.[1];
      if (tab) counts[tab] = (counts[tab] ?? 0) + lines.length;
    }
    return counts;
  }

  // ------------------------------------------------------------------ assets

  private iconUrl(name: unknown, folder: "icon" | "sprite" = "icon"): string | null {
    const bare = String(name ?? "").trim().replace(/\.(png|jpg|jpeg|gif)$/i, "");
    if (!bare || !this.assetServerUrl) return null;
    return `${this.assetServerUrl}/${folder}?name=${encodeURIComponent(bare)}`;
  }

  /** An item's icon in its rarity frame. */
  private itemThumb(item: { icon?: unknown; quality?: unknown } | null | undefined, size: "" | "lg" = "lg"): HTMLElement {
    return thumb(this.iconUrl(item?.icon), { size, quality: item?.quality ?? "common", fallback: "box" });
  }

  // --------------------------------------------------------------- side pane

  private renderList(): void {
    if (!this.heard || this.denied) return;
    const searching = this.shell.query !== "";
    const title = document.getElementById("tl-list-title");
    if (title) title.textContent = searching ? "Accounts" : "Online players";
    this.shell.setCount(searching ? null : this.players.length + this.playersTruncated);
    const rows: ListRow[] = this.players.map((player) => {
      const tags: HTMLElement[] = [];
      if (player.username === this.options?.editor) tags.push(tag("You", "you"));
      // With nothing searched for, everyone listed is online.
      if (searching) tags.push(player.online ? tag("Online", "good") : tag("Offline", "muted"));
      return {
        id: player.username, name: shown(player.username), note: `Account ${player.userid}`, thumb: avatar(player.username), tags,
        selected: player.username === this.snapshot?.username,
        onOpen: () => void this.select(player.username),
      };
    });
    this.shell.setList({
      rows,
      empty: searching
        ? { icon: "search", title: "No account matches that search", text: "Check the spelling, or search for less of the name." }
        : { icon: "players", title: "Nobody is online", text: "Search above to find any account, online or not." },
      foot: this.playersTruncated > 0 ? `${count(this.playersTruncated, "more account matches", "more accounts match")}. Narrow the search to see them.` : "",
    });
  }

  // ----------------------------------------------------------------- top bar

  /** The top bar and the tabs: who is open, how they stand, and how the editor's changes stand. */
  private chrome(): void {
    const s = this.snapshot;
    const { shell } = this;
    setBusy(this.reloadBtn, this.pending?.fk === "reload");
    if (!s) {
      shell.setRecord(null);
      shell.setState(this.pending?.what === "load" ? "loading" : null);
      this.flagsEl.replaceChildren();
      shell.setActions({ open: false });
      shell.setTabs(null);
      return;
    }
    shell.setRecord({ title: shown(s.username), note: `Account ${s.userid} · level ${num(s.stats.level)}`, thumb: avatar(s.username, true) });
    const flags: HTMLElement[] = [pill(s.online ? "Online" : "Offline", s.online ? "good" : "")];
    if (s.online) flags[0].title = `Online on ${s.location.map}`;
    if (s.username === this.options?.editor) flags.push(tag("You", "you"));
    if (s.isAdmin) flags.push(tag("Admin", "", "shield"));
    if (s.isGuest) flags.push(tag("Guest", "", "user"));
    if (s.banned) flags.push(tag("Banned", "danger", "ban"));
    if (s.dead === 1) flags.push(tag("Dead", "danger"));
    if (s.dead === 2) flags.push(tag("Ghost", "danger"));
    this.flagsEl.replaceChildren(...flags);
    this.paintState();
    shell.setActions({ open: true, extra: [this.reloadBtn] });
    shell.setTabs(this.tab, this.problemsByTab());
  }

  /** How what the editor has changed stands: on its way, refused, waiting to be applied, or all with the server. */
  private paintState(): void {
    if (!this.snapshot) return;
    const state: RecordState = this.pending ? (this.pending.what === "load" ? "loading" : "saving") : this.refusals.size ? "error" : this.dirty.size ? "unsaved" : "saved";
    // A form here is applied, not saved, and what is shown is the player as the server has them: the two states that say so in this editor's words.
    this.shell.setState(state, state === "unsaved" ? "Unapplied changes" : state === "saved" ? "Up to date" : undefined);
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    this.chrome();
    this.renderPage();
  }

  private render(): void {
    this.chrome();
    this.renderList();
    this.renderPage();
  }

  // -------------------------------------------------------------------- page

  private renderPage(): void {
    if (!this.heard || this.denied) return;
    const s = this.snapshot;
    const options = this.options;
    this.errorSlots.clear();
    this.applyButtons.clear();
    if (!s || !options) {
      // Someone is on their way: the shapes of what is loading.
      if (!this.opened || this.pending?.what === "load") {
        const { main } = this.shell.page("loading");
        main.setAttribute("aria-busy", "true");
        main.append(el("div", "tl-skeleton tl-skeleton-tile"), el("div", "tl-skeleton tl-skeleton-block"));
        return;
      }
      this.shell.screen("user", "No player open", "Pick a player on the left, or search for any account by its username. In the game, /player edit and a player's menu open them here too.");
      return;
    }

    // A redraw puts the keyboard back on the control it was on.
    const active = document.activeElement as HTMLElement | null;
    const focus = this.pageEl.contains(active) ? active?.closest<HTMLElement>("[data-fk]")?.dataset.fk : undefined;
    const self = s.username === options.editor;
    const { main } = this.shell.page(`${s.username}:${this.tab}`, { readOnly: self && this.tab === "access" });
    switch (this.tab) {
      case "stats": this.renderStats(main, s); break;
      case "inventory": this.renderInventory(main, s); break;
      case "equipment": this.renderEquipment(main, s, options); break;
      case "collections": this.renderCollections(main, s, options); break;
      case "social": this.renderSocial(main, s, options); break;
      case "quests": this.renderQuests(main, s, options); break;
      case "access": this.renderAccess(main, s, options, self); break;
      default: this.renderOverview(main, s, options);
    }
    if (focus) main.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }

  /** A titled card with a place under its controls for what the server refuses there. */
  private section(parent: HTMLElement, key: string, title: string, lead = ""): { root: HTMLElement; tools: HTMLElement; body: HTMLElement } {
    const made = card(parent, title, lead);
    made.root.appendChild(this.errorSlot(key));
    return made;
  }

  /** A button that asks the server for something: it shows a spinner while its answer is on the way. */
  private action(label: string, fk: string, onClick: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
    const btn = button(label, onClick, opts);
    btn.dataset.fk = fk;
    if (this.pending?.fk === fk) setBusy(btn, true);
    return btn;
  }

  /** The same as an icon: taking one thing off a list. */
  private removeButton(label: string, fk: string, onClick: () => void, name: IconName = "close"): HTMLButtonElement {
    const btn = iconButton(name, label, onClick, { danger: true, size: 15 });
    btn.dataset.fk = fk;
    return btn;
  }

  /** One row of a list card: a picture, a name with a note under it, then its controls. */
  private row(parent: HTMLElement, picture: HTMLElement | null, title: string, noteText: string, controls: HTMLElement[], tags: HTMLElement[] = []): HTMLElement {
    const row = el("div", "tl-row");
    if (picture) row.appendChild(picture);
    const said = el("div", "tl-row-words");
    const line = el("span", "pl-row-line");
    const name = el("span", "tl-row-title", title);
    name.title = title;
    line.append(name, ...tags);
    said.appendChild(line);
    if (noteText) said.appendChild(el("span", "tl-row-note", noteText));
    row.appendChild(said);
    const side = el("div", "tl-row-controls");
    side.append(...controls);
    row.appendChild(side);
    parent.appendChild(row);
    return row;
  }

  private rows(parent: HTMLElement): HTMLElement {
    const list = el("div", "tl-rows pl-list");
    parent.appendChild(list);
    return list;
  }

  private fact(parent: HTMLElement, label: string, value: string, noteText = ""): void {
    const item = el("div", "tl-fact");
    item.append(el("dt", "tl-fact-label", label), el("dd", "tl-fact-value", value));
    if (noteText) item.appendChild(el("dd", "tl-fact-note", noteText));
    parent.appendChild(item);
  }

  /** The fields of one form, each with the problem the server reported for it. */
  private renderFields(parent: HTMLElement, form: Form, target: any, fields: Field[]): void {
    for (const field of fields) {
      const path = `${form}.${field.key}`;
      const wrap: HTMLElement = this.fields.renderField({ ...field, path }, target, () => this.touch(form, path, wrap), { error: this.fieldErrors[path] });
      parent.appendChild(wrap);
    }
  }

  /** A form was edited: there is something to apply, and a field's old problem no longer describes it. */
  private touch(form: Form, path?: string, wrap?: HTMLElement): void {
    this.dirty.add(form);
    this.applyButtons.get(form)?.classList.add("tl-btn-primary");
    const fixed = path ? this.fieldErrors[path] : undefined;
    if (path && fixed) {
      // Its sentence leaves the card with its mark.
      delete this.fieldErrors[path];
      setFieldError(wrap ?? null, null);
      const left = (this.refusals.get(form) ?? []).filter((line) => line !== fixed);
      if (left.length) this.refusals.set(form, left);
      else this.refusals.delete(form);
      this.paintRefusal(form);
      this.shell.setTabs(this.tab, this.problemsByTab());
    }
    this.paintState();
  }

  /** The form's Apply button, lit while the form has edits the server has not been sent. */
  private applyButton(form: Form, label: string, onApply: () => void): HTMLButtonElement {
    const btn = this.action(label, `apply:${form}`, onApply, { icon: "check" });
    btn.classList.toggle("tl-btn-primary", this.dirty.has(form));
    this.applyButtons.set(form, btn);
    return btn;
  }

  private applyRow(parent: HTMLElement, form: Form, label: string, onApply: () => void, hint = ""): HTMLElement {
    const row = el("div", "pl-foot");
    row.appendChild(this.applyButton(form, label, onApply));
    if (hint) row.appendChild(el("span", "pl-foot-hint", hint));
    parent.appendChild(row);
    return row;
  }

  /** Ctrl+S: apply the form the keyboard is in, if it has something to apply. */
  private applyFocused(): void {
    const form = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-form]")?.dataset.form as Form | undefined;
    if (form && this.dirty.has(form)) this.applyButtons.get(form)?.click();
  }

  // ---------------------------------------------------------------- overview

  private renderOverview(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions): void {
    const name = shown(s.username);
    if (s.dead) main.appendChild(note("This player is dead: their location and stats cannot be changed until they are revived.", "warning"));

    const account = card(main, "Account");
    const facts = el("dl", "tl-facts tl-facts-grid");
    this.fact(facts, "Account number", String(s.userid));
    this.fact(facts, "Status", s.online ? "Online" : "Offline", s.online ? `Connection ${s.sessionId}, on ${s.location.map}` : "");
    this.fact(facts, "Role", s.isAdmin ? "Admin" : s.isGuest ? "Guest" : "Player");
    this.fact(facts, "State", DEAD_STATES[s.dead] ?? DEAD_STATES[0]);
    this.fact(facts, "Banned", s.banned ? "Yes" : "No");
    this.fact(facts, "Bags", listed(Object.values(s.bags).filter((bag): bag is string => !!bag)) || "None");
    account.body.appendChild(facts);

    const pair = el("div", "pl-pair");
    main.appendChild(pair);

    const location = this.section(pair, "location", "Location", s.online ? "Applying moves them straight away." : "Where they will log in.");
    location.root.dataset.form = "location";
    const map = options.maps.find((m) => m.name === this.drafts.location.map);
    const place = el("div", "tl-fields tl-fields-2");
    this.renderFields(place, "location", this.drafts.location, [
      { key: "map", label: "Map", type: "select", options: () => options.maps.map((m) => ({ value: m.name, label: m.name })), rerender: true },
      { key: "direction", label: "Facing", type: "select", options: () => options.directions.map((d) => ({ value: d, label: FACING[d] ?? words(d) })) },
      { key: "x", label: "X", type: "number", unit: "px", hint: map ? `0 to ${num(map.width)}` : "" },
      { key: "y", label: "Y", type: "number", unit: "px", hint: map ? `0 to ${num(map.height)}` : "" },
    ]);
    location.body.appendChild(place);
    this.applyRow(location.body, "location", "Move player", () => {
      const to = this.drafts.location;
      this.act("location.set", { ...to }, { fk: "apply:location", done: s.online ? `Moved ${name} to ${to.map}.` : `${name} will log in on ${to.map}.` });
    });

    const money = this.section(pair, "currency", "Currency", `They can hold up to ${num(options.limits.currency.gold)} gold.`);
    money.root.dataset.form = "currency";
    const purse = el("div", "tl-fields");
    this.renderFields(purse, "currency", this.drafts.currency, [{ key: "total", label: "Balance", type: "money", wide: true, hint: "Gold, silver and copper. 100 copper make a silver, 100 silver a gold." }]);
    money.body.appendChild(purse);
    this.applyRow(money.body, "currency", "Apply currency", () => {
      const total = Math.max(0, Math.floor(Number(this.drafts.currency.total) || 0));
      const coins = {
        gold: Math.floor(total / COPPER_PER_GOLD),
        silver: Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER),
        copper: total % COPPER_PER_SILVER,
      };
      this.act("currency.set", coins, { fk: "apply:currency", done: `${name} now has ${coinWords(total)}.` });
    });
  }

  // ------------------------------------------------------------------- stats

  private renderStats(main: HTMLElement, s: PlayerEditorSnapshot): void {
    if (s.dead) main.appendChild(note("This player is dead: their stats cannot be changed until they are revived.", "warning"));
    const stats = this.drafts.stats;
    const withGear = (key: string) => (s.totals ? `With equipment: ${num(s.totals[key])}` : "");
    const group = (parent: HTMLElement, title: string, lead: string, columns: string, fields: Field[]) => {
      const made = card(parent, title, lead);
      made.root.dataset.form = "stats";
      const grid = el("div", columns ? `tl-fields ${columns}` : "tl-fields");
      this.renderFields(grid, "stats", stats, fields);
      made.body.appendChild(grid);
    };

    const pair = el("div", "pl-pair pl-pair-lead");
    main.appendChild(pair);
    group(pair, "Level", `Level ${num(s.stats.level)} needs ${num(s.stats.max_xp)} XP.`, "pl-fields-1", [
      { key: "level", label: "Level", type: "number", hint: "A new level sets the XP it needs and the base health and mana." },
      { key: "xp", label: "XP", type: "number", hint: "Below what the level needs." },
    ]);
    group(pair, "Health and mana", s.totals ? `With equipment their maximums are ${num(s.totals.max_health)} health and ${num(s.totals.max_stamina)} mana.` : "Equipment adds to the maximums.", "tl-fields-2", [
      { key: "health", label: "Health", type: "number" },
      { key: "max_health", label: "Max health", type: "number" },
      { key: "stamina", label: "Mana", type: "number" },
      { key: "max_stamina", label: "Max mana", type: "number" },
    ]);
    group(main, "Base stats", "What they have before equipment.", "pl-fields-5", [
      { key: "stat_damage", label: "Damage", type: "number", hint: withGear("stat_damage") },
      { key: "stat_armor", label: "Armor", type: "number", unit: "%", hint: withGear("stat_armor") },
      { key: "stat_critical_chance", label: "Critical chance", type: "number", unit: "%", hint: withGear("stat_critical_chance") },
      { key: "stat_critical_damage", label: "Critical damage", type: "number", unit: "%", hint: withGear("stat_critical_damage") },
      { key: "stat_avoidance", label: "Avoidance", type: "number", unit: "%", hint: withGear("stat_avoidance") },
    ]);

    // One Apply for the three cards above, with what the server refused of them.
    const bar = el("section", "pl-bar");
    bar.dataset.form = "stats";
    this.applyRow(bar, "stats", "Apply stats", () => {
      // Only what was edited: the server leaves the rest as the player has it now.
      const changed: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (value !== s.stats[key]) changed[key] = value;
      }
      const total = Object.keys(changed).length;
      if (total === 0) return toast("No stat was changed.");
      this.act("stats.set", { stats: changed }, { fk: "apply:stats", done: `Changed ${count(total, "stat")} of ${shown(s.username)}.` });
    }, "Only the stats you changed are sent. The rest stay as they are now.");
    bar.appendChild(this.errorSlot("stats"));
    main.appendChild(bar);
  }

  // --------------------------------------------------------------- inventory

  private renderInventory(main: HTMLElement, s: PlayerEditorSnapshot): void {
    const who = s.username;
    const name = shown(who);
    const made = this.section(main, "inventory", "Inventory", `${num(s.inventory.length)} of ${count(s.inventorySlots, "slot")} used.`);
    made.root.classList.add("tl-card-flush");
    made.tools.appendChild(this.action("Add item", "inventory.add", () => {
      this.openItemPicker("Add an item", null, (item) => {
        if (this.still(who)) this.act("inventory.add", { item: item.name, quantity: 1 }, { fk: "inventory.add", done: `Gave ${name} 1 ${item.name}.` });
      });
    }, { icon: "plus" }));
    if (s.inventory.length === 0) return void empty(made.body, "bag", "The inventory is empty", "Give them an item with the button above.");

    const table = el("table", "tl-table tl-table-plain tl-table-edit pl-items");
    const cols = el("colgroup");
    for (const cls of ["", "pl-col-amount", "pl-col-end"]) cols.appendChild(el("col", cls));
    const head = el("tr");
    for (const text of ["Item", "Amount", ""]) {
      const cell = el("th", "", text);
      cell.scope = "col";
      // The last column holds each item's way out; it has no heading to read, only a name.
      if (!text) cell.setAttribute("aria-label", "Remove");
      head.appendChild(cell);
    }
    const thead = el("thead");
    thead.appendChild(head);
    const body = el("tbody");
    table.append(cols, thead, body);
    made.body.appendChild(table);

    for (const item of s.inventory) {
      const line = el("tr");
      const about = el("div", "tl-item");
      const said = el("span", "tl-item-words");
      const top = el("span", "pl-row-line");
      // Quality colours match the in-game item tooltips.
      const label = el("span", "pl-item-name tl-quality-text", item.name);
      label.dataset.quality = qualityOf(item.quality);
      label.title = item.name;
      top.appendChild(label);
      if (item.equipped) top.appendChild(tag("Equipped", "info"));
      if (!item.known) top.appendChild(tag("No longer exists", "warning"));
      said.append(top, el("span", "tl-item-note", item.known ? kindOf(item) : "Its item was deleted: it can only be removed."));
      about.append(this.itemThumb(item), said);
      const first = el("td");
      first.appendChild(about);

      const fk = `inventory.set:${item.name}`;
      const quantity = el("input", "tl-input tl-input-number");
      quantity.type = "number";
      quantity.min = "0";
      quantity.step = "1";
      quantity.value = String(item.quantity);
      quantity.dataset.fk = fk;
      quantity.setAttribute("aria-label", `Amount of ${item.name}`);
      if (!item.known) forbid(quantity, "This item no longer exists: it can only be removed.");
      quantity.addEventListener("change", () => {
        const wanted = Number(quantity.value);
        const sent = quantity.value !== "" && Number.isInteger(wanted) && wanted >= 0 && wanted !== item.quantity
          && this.act("inventory.set", { item: item.name, quantity: wanted }, { fk, done: wanted === 0 ? `Took ${item.name} from ${name}.` : `${name} now has ${num(wanted)} of ${item.name}.` });
        // Not a whole number, or not sent: the box shows what they have.
        if (!sent) quantity.value = String(item.quantity);
      });
      const second = el("td");
      second.appendChild(quantity);

      const last = el("td", "tl-table-end");
      last.appendChild(this.removeButton(`Remove ${item.name}`, `inventory.remove:${item.name}`, () => void this.removeItem(who, item), "trash"));
      line.append(first, second, last);
      body.appendChild(line);
    }
  }

  private async removeItem(who: string, item: InventoryItem): Promise<void> {
    // An item that is no longer in the game cannot be given back.
    if (!item.known) {
      const agreed = await confirmDialog({
        title: `Remove ${item.name}?`,
        body: `${item.name} no longer exists as an item, so ${shown(who)} cannot be given it back once it is removed.`,
        okLabel: "Remove item",
      });
      if (!agreed || !this.still(who)) return;
    }
    this.act("inventory.remove", { item: item.name }, { fk: `inventory.remove:${item.name}`, done: `Took ${item.name} from ${shown(who)}.` });
  }

  // --------------------------------------------------------------- equipment

  private renderEquipment(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions): void {
    const who = s.username;
    const name = shown(who);
    const made = this.section(main, "equipment", "Equipment", "Equipping gives them the item if they do not have it.");
    const grid = el("div", "pl-slots");
    made.body.appendChild(grid);
    for (const slot of options.slots) {
      const worn = s.equipment[slot];
      const item = worn ? s.inventory.find((i) => i.name.toLowerCase() === worn.toLowerCase()) : null;
      const place = words(slot);
      const tile = el("div", "pl-slot" + (worn ? "" : " is-empty"));
      const said = el("div", "pl-slot-words");
      const held = el("span", "pl-slot-name" + (worn ? " tl-quality-text" : ""), worn || "Empty");
      if (worn) {
        held.dataset.quality = qualityOf(item?.quality);
        held.title = worn;
      }
      said.append(el("span", "pl-slot-label", place), held);
      tile.append(worn ? this.itemThumb(item) : thumb(null, { size: "lg" }), said);
      const fk = `equipment.equip:${slot}`;
      tile.appendChild(this.action(worn ? "Change" : "Equip", fk, () => {
        this.openItemPicker(`Equip: ${place}`, slot, (picked) => {
          if (this.still(who)) this.act("equipment.equip", { slot, item: picked.name }, { fk, done: `Equipped ${picked.name} on ${name}.` });
        });
      }, { small: true }));
      if (worn) {
        tile.appendChild(this.removeButton(`Unequip ${worn}`, `equipment.unequip:${slot}`, () => {
          this.act("equipment.unequip", { slot }, { fk: `equipment.unequip:${slot}`, done: `Unequipped ${worn} from ${name}.` });
        }));
      }
      grid.appendChild(tile);
    }
  }

  // ------------------------------------------------------------- collections

  private renderCollections(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions): void {
    const who = s.username;
    const name = shown(who);
    const pair = el("div", "pl-pair");
    main.appendChild(pair);

    const mounts = this.section(pair, "mounts", "Mounts and collectables");
    const owned = new Set(s.collectables.filter((c) => c.type === "mount").map((c) => c.item.toLowerCase()));
    const mountChoices: AssetOption[] = options.mounts
      .filter((m) => !owned.has(m.name.toLowerCase()))
      .map((m) => ({ value: m.name, label: m.name, image: this.iconUrl(m.icon) }));
    const addMount = this.action("Add mount", "collectable.add", () => {
      this.fields.openAssetPicker("Add a mount", mountChoices, (option) => {
        if (this.still(who)) this.act("collectable.add", { type: "mount", item: option.value }, { fk: "collectable.add", done: `Gave ${name} the mount ${option.label}.` });
      }, { icons: true, fallback: "paw" });
    }, { icon: "plus" });
    if (mountChoices.length === 0) forbid(addMount, options.mounts.length ? "They already have every mount." : "There are no mounts in the game.");
    mounts.tools.appendChild(addMount);
    if (s.collectables.length === 0) empty(mounts.body, "paw", "Nothing collected", "Give them a mount with the button above.");
    else {
      const list = this.rows(mounts.body);
      for (const have of s.collectables) {
        const fk = `collectable.remove:${have.type}:${have.item}`;
        this.row(list, thumb(this.iconUrl(have.icon), { size: "lg", fallback: "paw" }), have.item, words(have.type), [
          this.removeButton(`Remove ${have.item}`, fk, () => {
            this.act("collectable.remove", { type: have.type, item: have.item }, { fk, done: `Took the ${have.type} ${have.item} from ${name}.` });
          }),
        ], have.known ? [] : [tag("No longer exists", "warning")]);
      }
    }

    const spells = this.section(pair, "spells", "Spells");
    const spellIcon = (spell: string) => this.iconUrl(options.spells.find((known) => known.name === spell)?.icon, "sprite");
    const spellChoices: AssetOption[] = options.spells
      .filter((spell) => !s.spells.includes(spell.name))
      .map((spell) => ({ value: spell.name, label: spell.name, image: this.iconUrl(spell.icon, "sprite") }));
    const teach = this.action("Teach spell", "spell.learn", () => {
      this.fields.openAssetPicker("Teach a spell", spellChoices, (option) => {
        if (this.still(who)) this.act("spell.learn", { spell: option.value }, { fk: "spell.learn", done: `${name} now knows ${option.label}.` });
      }, { icons: true, fallback: "wand" });
    }, { icon: "plus" });
    if (spellChoices.length === 0) forbid(teach, options.spells.length ? "They already know every spell." : "There are no spells in the game.");
    spells.tools.appendChild(teach);
    if (s.spells.length === 0) empty(spells.body, "wand", "No spells learned", "Teach them one with the button above.");
    else {
      const list = this.rows(spells.body);
      for (const spell of s.spells) {
        const fk = `spell.unlearn:${spell}`;
        this.row(list, thumb(spellIcon(spell), { size: "lg", fallback: "wand" }), spell, "", [
          this.removeButton(`Unlearn ${spell}`, fk, () => {
            this.act("spell.unlearn", { spell }, { fk, done: `${name} no longer knows ${spell}.` });
          }),
        ]);
      }
    }
  }

  // ------------------------------------------------------------------ social

  /** People named in a card, each as a tag; the one who leads is marked. */
  private members(parent: HTMLElement, usernames: string[], leader: string): void {
    const list = el("div", "tl-tags pl-members");
    for (const member of usernames) list.appendChild(member === leader ? tag(`${shown(member)} · leader`, "info") : tag(shown(member)));
    parent.appendChild(list);
  }

  private renderSocial(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions): void {
    const who = s.username;
    const name = shown(who);
    const pair = el("div", "pl-pair");
    main.appendChild(pair);

    const guild = this.section(pair, "guild", "Guild", s.guild ? `${s.guild.name} · led by ${shown(s.guild.leader)}` : "");
    if (s.guild) {
      const g = s.guild;
      const total = count(g.members.length, "member");
      guild.body.appendChild(el("div", "pl-group-count", total));
      this.members(guild.body, g.members, g.leader);
      const controls = el("div", "tl-actions");
      if (g.leader === s.username) {
        controls.appendChild(this.action("Disband guild", "guild.disband", () => void this.disband(who, g.name, total), { kind: "danger" }));
      } else {
        controls.append(
          this.action("Make leader", "guild.lead", () => this.act("guild.lead", {}, { fk: "guild.lead", done: `${name} now leads ${g.name}.` })),
          this.action("Remove from guild", "guild.leave", () => this.act("guild.leave", {}, { fk: "guild.leave", done: `Removed ${name} from ${g.name}.` }), { kind: "danger" }));
      }
      guild.body.appendChild(controls);
    } else {
      const choices: AssetOption[] = options.guilds.map((g) => ({ value: g.name, label: `${g.name} (${count(g.members, "member")}, led by ${shown(g.leader)})` }));
      const join = this.action("Add to guild", "guild.join", () => {
        this.fields.openAssetPicker("Add to a guild", choices, (option) => {
          if (this.still(who)) this.act("guild.join", { guild: option.value }, { fk: "guild.join", done: `Added ${name} to ${option.value}.` });
        }, { icons: false });
      }, { icon: "plus" });
      if (choices.length === 0) forbid(join, "There are no guilds to add them to.");
      guild.tools.appendChild(join);
      empty(guild.body, "shield", "Not in a guild", "Add them to an existing guild with the button above.");
    }

    const party = this.section(pair, "party", "Party", s.party ? `Led by ${shown(s.party.leader)}` : "");
    if (s.party) {
      party.body.appendChild(el("div", "pl-group-count", count(s.party.members.length, "member")));
      this.members(party.body, s.party.members, s.party.leader);
      const controls = el("div", "tl-actions");
      controls.appendChild(this.action("Remove from party", "party.leave", () => this.act("party.leave", {}, { fk: "party.leave", done: `Removed ${name} from the party.` }), { kind: "danger" }));
      party.body.appendChild(controls);
    } else {
      party.tools.appendChild(this.action("Add to a party", "party.join", () => void this.askName(who, {
        title: "Add to a party", body: "Whose party? If that player has none, they lead a new one.", okLabel: "Add to party", icon: "players",
      }, (username) => this.act("party.join", { username }, { fk: "party.join", done: `Added ${name} to ${shown(username)}'s party.` })), { icon: "plus" }));
      empty(party.body, "players", "Not in a party", "Parties do not outlive a server restart.");
    }

    const friends = this.section(main, "friends", "Friends", "Added and removed on both players' lists.");
    friends.tools.appendChild(this.action("Add friend", "friend.add", () => void this.askName(who, {
      title: "Add a friend", body: "The username of the player to befriend.", okLabel: "Add friend", icon: "heart",
    }, (username) => this.act("friend.add", { username }, { fk: "friend.add", done: `${name} and ${shown(username)} are now friends.` })), { icon: "plus" }));
    if (s.friends.length === 0) return void empty(friends.body, "heart", "No friends yet", "Add one with the button above.");
    const people = el("div", "pl-people");
    friends.body.appendChild(people);
    for (const friend of s.friends) {
      const fk = `friend.remove:${friend}`;
      const person = el("div", "pl-person");
      const label = el("span", "pl-person-name", shown(friend));
      label.title = shown(friend);
      person.append(avatar(friend), label, this.removeButton(`Remove ${shown(friend)}`, fk, () => {
        this.act("friend.remove", { username: friend }, { fk, done: `${name} and ${shown(friend)} are no longer friends.` });
      }));
      people.appendChild(person);
    }
  }

  private async disband(who: string, guild: string, members: string): Promise<void> {
    const agreed = await confirmDialog({ title: `Disband ${guild}?`, body: `All ${members} lose their guild, and it cannot be brought back.`, okLabel: "Disband guild" });
    if (!agreed || !this.still(who)) return;
    this.act("guild.disband", {}, { fk: "guild.disband", done: `Disbanded ${guild}.` });
  }

  /** Ask for another player's username, then do something with it for the player the question was about. */
  private async askName(who: string, question: { title: string; body: string; okLabel: string; icon: IconName }, onOk: (username: string) => void): Promise<void> {
    const username = await askText({ ...question, label: "Username", maxLength: 64 });
    if (username && this.still(who)) onOk(username);
  }

  // ------------------------------------------------------------------ quests

  private renderQuests(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions): void {
    const who = s.username;
    const name = shown(who);
    const pair = el("div", "pl-pair pl-pair-main");
    main.appendChild(pair);

    const active = this.section(pair, "active", "Active quests", "Completing a quest here grants no rewards.");
    const taken = new Set(s.quests.active.map((q) => q.id));
    const choices: AssetOption[] = options.quests
      .filter((q) => !taken.has(q.id))
      .map((q) => ({ value: q.id, label: `${q.name} (level ${num(q.level)})` }));
    const start = this.action("Start a quest", "quest.accept", () => {
      this.fields.openAssetPicker("Start a quest", choices, (option) => {
        const quest = options.quests.find((q) => q.id === Number(option.value));
        if (this.still(who)) this.act("quest.accept", { questId: Number(option.value) }, { fk: "quest.accept", done: `Started ${quest?.name ?? "the quest"} for ${name}.` });
      }, { icons: false });
    }, { icon: "plus" });
    if (choices.length === 0) forbid(start, options.quests.length ? "Every quest is already in their log." : "There are no quests in the game.");
    active.tools.appendChild(start);
    if (s.quests.active.length === 0) empty(active.body, "scroll", "No quests in progress", "Start one for them with the button above.");
    else {
      const list = this.rows(active.body);
      for (const quest of s.quests.active) {
        const progress = quest.objectives.map((o) => `${o.label} ${num(o.count)} of ${num(o.required)}`);
        const done = `quest.complete:${quest.id}`;
        const gone = `quest.abandon:${quest.id}`;
        this.row(list, null, quest.name, progress.join(" · "), [
          this.action("Complete", done, () => this.act("quest.complete", { questId: quest.id }, { fk: done, done: `Completed ${quest.name} for ${name}. No rewards were given.` }), { small: true }),
          this.removeButton(`Remove ${quest.name} from the log`, gone, () => void this.abandon(who, quest)),
        ], [quest.state === "ready" ? tag("Ready to turn in", "good") : tag("In progress", "muted")]);
      }
    }

    const completed = this.section(pair, "completed", "Completed quests", "Forgetting one lets them take it again.");
    if (s.quests.completed.length === 0) return void empty(completed.body, "check", "No quests completed");
    const list = this.rows(completed.body);
    for (const quest of s.quests.completed) {
      const fk = `quest.forget:${quest.id}`;
      this.row(list, null, quest.name, "", [
        this.action("Forget", fk, () => this.act("quest.forget", { questId: quest.id }, { fk, done: `${name} can take ${quest.name} again.` }), { small: true }),
      ]);
    }
  }

  private async abandon(who: string, quest: PlayerEditorSnapshot["quests"]["active"][number]): Promise<void> {
    // Progress on a quest cannot be put back from here.
    const made = quest.objectives.filter((o) => o.count > 0).map((o) => `${o.label} ${num(o.count)} of ${num(o.required)}`);
    if (made.length) {
      const agreed = await confirmDialog({
        title: `Remove ${quest.name} from the log?`,
        body: `${shown(who)} loses their progress on it (${listed(made)}). It can be started again, from nothing.`,
        okLabel: "Remove quest",
      });
      if (!agreed || !this.still(who)) return;
    }
    this.act("quest.abandon", { questId: quest.id }, { fk: `quest.abandon:${quest.id}`, done: `Removed ${quest.name} from ${shown(who)}'s log.` });
  }

  // ------------------------------------------------------------------ access

  private renderAccess(main: HTMLElement, s: PlayerEditorSnapshot, options: PlayerEditorOptions, self: boolean): void {
    const name = shown(s.username);
    if (self) main.appendChild(note("This is you: your own role and permissions are not yours to change.", "", "lock"));

    const role = this.section(main, "role", "Role", "They are reconnected when their role changes.");
    const toggle = switchControl(s.isAdmin, "Admin", (on) => void this.setAdmin(s, on, toggle));
    toggle.dataset.fk = "admin.set";
    if (this.pending?.fk === "admin.set") setBusy(toggle, true);
    if (self) forbid(toggle, "That is you.");
    this.row(this.rows(role.body), null, "Admin", s.isAdmin ? `${name} has the admin role.` : `${name} does not have the admin role.`, [toggle]);

    const permissions = this.section(main, "permissions", "Permissions", "You can only give out permissions you hold yourself.");
    permissions.root.dataset.form = "permissions";
    const draft = this.drafts.permissions;
    // A permission the player holds is listed even if it is no longer a known type, so it can be taken away.
    const names = [...new Set([...options.permissionTypes, ...s.permissions])];
    if (names.length === 0) return void empty(permissions.body, "key", "No permissions are defined on this server");
    const change = el("p", "pl-change");
    const held = (total: number) => (total ? count(total, "permission") : "no permissions");
    const paintChange = () => {
      const gained = [...draft].filter((p) => !s.permissions.includes(p));
      const lost = s.permissions.filter((p) => !draft.has(p));
      const parts = [gained.length ? `gains ${listed(gained)}` : "", lost.length ? `loses ${listed(lost)}` : ""].filter(Boolean);
      change.textContent = parts.length ? `When applied, ${name} ${parts.join(" and ")}.` : `${name} holds ${held(s.permissions.length)}. Nothing is ticked differently.`;
      change.classList.toggle("is-changed", parts.length > 0);
    };
    const list = el("div", "tl-checks pl-permissions");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", `Permissions of ${name}`);
    for (const permission of names) {
      const label = el("label", "tl-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = draft.has(permission);
      box.disabled = self;
      box.dataset.fk = `permission:${permission}`;
      box.addEventListener("change", () => {
        if (box.checked) draft.add(permission);
        else draft.delete(permission);
        this.touch("permissions");
        paintChange();
      });
      const known = options.permissionTypes.includes(permission);
      if (!known) label.classList.add("is-unknown");
      label.title = known ? permission : `${permission}: no longer a permission the server knows. Untick it to take it away.`;
      label.append(box, el("span", "", permission));
      list.appendChild(label);
    }
    permissions.body.appendChild(list);
    if (self) return;
    paintChange();
    permissions.body.appendChild(change);
    this.applyRow(permissions.body, "permissions", "Apply permissions", () => {
      this.act("permissions.set", { permissions: [...draft] }, { fk: "apply:permissions", done: `${name} now holds ${held(draft.size)}.` });
    });
  }

  private async setAdmin(s: PlayerEditorSnapshot, on: boolean, toggle: HTMLButtonElement): Promise<void> {
    const name = shown(s.username);
    const agreed = await confirmDialog(on
      ? { title: `Make ${name} an admin?`, body: `${name} gets the admin role, and is reconnected so that their game picks it up.`, okLabel: "Make admin", danger: false }
      : { title: `Remove ${name}'s admin role?`, body: `${name} loses the admin role, and is reconnected so that their game picks it up.`, okLabel: "Remove admin" });
    const sent = agreed && this.still(s.username)
      && this.act("admin.set", { value: on }, { fk: "admin.set", done: on ? `${name} is now an admin.` : `${name} is no longer an admin.` });
    // Not asked for after all: the switch goes back to how they stand.
    if (!sent) toggle.setAttribute("aria-checked", String(s.isAdmin));
    else setBusy(toggle, true);
  }

  // ------------------------------------------------------------------ pickers

  /**
   * Item browser searched on the server, which holds the item table. With a
   * `slot` it lists what fits that slot; without one, nothing until a name is typed.
   */
  private openItemPicker(title: string, slot: string | null, onPick: (item: any) => void): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dialog = openDialog(title, {
      onClose: () => {
        if (timer) clearTimeout(timer);
        this.picker = null;
      },
    });
    const list = el("div", "pl-picks");
    const found = el("span", "tl-muted");
    let items: any[] = [];
    const ask = () => this.request("PLAYER_EDITOR_SEARCH", { kind: "items", query: search.input.value.trim(), slot });
    const choose = (item: any) => {
      dialog.close();
      onPick(item);
    };
    const say = (name: IconName, heading: string, text: string) => {
      const box = el("div", "tl-empty");
      box.append(icon(name, 22), el("div", "tl-empty-title", heading), el("div", "tl-empty-text", text));
      dialog.body.appendChild(box);
      found.textContent = "";
    };

    const paint = (result: any) => {
      // An answer to an earlier keystroke: a newer one is on its way.
      if (result && result.query !== search.input.value.trim().toLowerCase()) return;
      list.replaceChildren();
      dialog.body.querySelector(".tl-empty")?.remove();
      items = Array.isArray(result?.items) ? result.items : [];
      const typed = search.input.value.trim() !== "";
      if (items.length === 0) {
        if (!result && slot) return say("clock", "Reading the items", `Looking for what goes in the ${words(slot).toLowerCase()} slot.`);
        if (!typed && !slot) return say("search", "Type to search", "Type part of an item's name to list the items that match.");
        if (!typed) return say("box", "Nothing fits this slot", `No item in the game goes in the ${words(slot).toLowerCase()} slot.`);
        return say("search", "Nothing matches that search", "Check the spelling, or search for less of the name.");
      }
      for (const item of items) {
        const row = el("button", "pl-pick");
        row.type = "button";
        row.title = item.name;
        const said = el("span", "pl-pick-words");
        const label = el("span", "pl-pick-name tl-quality-text", item.name);
        label.dataset.quality = qualityOf(item.quality);
        const level = Number(item.level_requirement) > 1 ? ` · level ${num(Number(item.level_requirement))}` : "";
        said.append(label, el("span", "pl-pick-note", `${kindOf(item)}${level}`));
        row.append(this.itemThumb(item), said);
        row.addEventListener("click", () => choose(item));
        list.appendChild(row);
      }
      found.textContent = result.truncated > 0
        ? `${count(items.length, "item")} listed, ${count(result.truncated, "more matches", "more match")}. Type more of the name.`
        : count(items.length, "item");
    };

    const search = searchBox(slot ? "Search what fits this slot" : "Search items by name", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(ask, 200);
    });
    // Enter takes the only match, so a full name can be typed and taken.
    search.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && items.length === 1) choose(items[0]);
    });
    dialog.tools.append(search.root, found);
    dialog.body.appendChild(list);
    this.picker = { paint };
    paint(null);
    if (slot) ask();
    search.input.focus();
  }
}

new PlayerEditorBridge();
