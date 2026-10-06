// Control panel popup: the dashboard of the server's admins. It talks to the
// game window over postMessage; the game window forwards everything to the
// server. Every control here stands for one of the admin commands: the server
// checks who is asking and that command's own permission, runs it, and answers
// with what the command said and how things now stand. The panel asks again
// every few seconds to stay current, and is sent the readings its charts are
// drawn from as the server takes them.
import { LineChart, barList, columns, meter, shares, sparkline, type Bar, type Point } from "./controlpanelcharts.js";
import {
  ago, arrowKeys, avatar, clock, confirmDialog, count, dayAndTime, duration, el, empty, forbid, icon, listed, memory, num, screen, segments, short, shown, subcard,
  tag, titleCount, toast, type IconName,
} from "./toolkit.js";

type Page = "dashboard" | "players" | "reports" | "communication" | "server" | "world" | "items";
/** A mute as the server holds it: times are milliseconds since the epoch, and no `expires_at` is a mute until it is lifted. */
type Mute = { username: string; muted_by: string; reason: string | null; created_at: number; expires_at: number | null };
/** A player's report of another, with the reported player's lines that reached the one who reported. */
type Report = {
  id: number; reporter: string; target: string; category: string; details: string | null;
  chat_log: Array<{ at: number; channel: string; text: string }>;
  map: string | null; x: number | null; y: number | null; target_map: string | null; target_x: number | null; target_y: number | null;
  created_at: number; status: "open" | "resolved"; resolved_by: string | null; resolved_at: number | null; resolution: string | null;
};
type Range = "hour" | "six" | "day";
type SortKey = "username" | "level" | "map" | "status" | "onlineFor";
type LootTable = { id: number; name: string; items: ControlPanelLootRow[] };
type ItemSearch = { query: string; paint: (result: any) => void };
type Account = { username: string; userid: number; online: boolean };
/** Where an action was asked from: where its error is shown, and which button waits for the answer. */
type Origin = { key: string; fk?: string; done?: () => void };

const REFRESH_MS = 5000;
/** With no answer for this long, the panel says the server is not answering. */
const LOST_AFTER_MS = 16000;
const ANSWER_WITHIN_MS = 15000;
const NOT_ALLOWED = "You don't have permission to do that.";
const NOT_ANSWERING = "The server is not answering.";
/** What the server keeps: an hour of readings, a day of minutes, the last hundred actions. */
const RECENT_KEEP = 240;
const DAY_KEEP = 1440;
const ACTIVITY_KEEP = 100;
/** The server holds work back once it runs this late, and harder at twice that. */
const LAG_BEHIND_MS = 30;
const LAG_STRUGGLING_MS = 60;
const BROADCAST_MAX = 500;

const QUALITIES = ["common", "uncommon", "rare", "epic", "legendary"];
/** Who a message can be sent to: what the choice is called, and how the list of sent messages says it of another admin. */
const AUDIENCES: Array<[string, string, string]> = [
  ["ALL", "Everyone", "everyone"],
  ["MAP", "Everyone on your map", "everyone on their map"],
  ["ADMINS", "Admins on your map", "the admins on their map"],
];

const PAGES: Array<{ id: Page; label: string; icon: IconName; group: string; lead: string }> = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", group: "Overview", lead: "" },
  { id: "players", label: "Players", icon: "players", group: "People", lead: "Everyone online now. Pick a player to see their details and act on them, or search to find any account." },
  { id: "reports", label: "Reports", icon: "shield", group: "People", lead: "What players have reported about each other. The reported player is never told, and neither is a player you mute." },
  { id: "communication", label: "Communication", icon: "megaphone", group: "People", lead: "Messages from the admins to the players in the game." },
  { id: "server", label: "Server", icon: "server", group: "Operations", lead: "How the server is running, who may log in, and when it restarts." },
  { id: "world", label: "World", icon: "globe", group: "Operations", lead: "The maps of the game, their weather, and how you move through them." },
  { id: "items", label: "Items & Loot", icon: "box", group: "Operations", lead: "Items put into the world by hand, and the tables that chests and creatures drop from." },
];

const RANGES: Array<{ id: Range; label: string; seconds: number }> = [
  { id: "hour", label: "Last hour", seconds: 3600 },
  { id: "six", label: "6 hours", seconds: 21600 },
  { id: "day", label: "24 hours", seconds: 86400 },
];

/** What each action is called in the list of what admins did. */
const ACTION_LABELS: Record<string, string> = {
  "self.noclip": "Noclip", "self.stealth": "Stealth",
  "player.summon": "Summon", "player.goto": "Go to", "player.respawn": "Respawn", "player.revive": "Revive", "player.kill": "Kill",
  "player.kick": "Kick", "player.ban": "Ban", "player.unban": "Unban", "player.admin": "Admin role", "player.give": "Give item",
  "player.mute": "Mute", "player.unmute": "Unmute", "report.resolve": "Resolve report",
  "permission.add": "Give permission", "permission.remove": "Take permission away", "permission.set": "Set permissions", "permission.clear": "Clear permissions",
  "server.broadcast": "Message", "server.whitelist.add": "Add to whitelist", "server.whitelist.remove": "Remove from whitelist",
  "server.whitelist.on": "Turn whitelist on", "server.whitelist.off": "Turn whitelist off",
  "server.restart": "Schedule restart", "server.restart.cancel": "Cancel restart", "server.shutdown": "Shut down",
  "world.reloadmap": "Reload map", "world.warp": "Warp", "world.weather": "Weather",
  "item.drop": "Drop item", "chest.spawn": "Spawn chest",
  "loot.create": "New loot table", "loot.delete": "Delete loot table", "loot.additem": "Add loot row", "loot.removeitem": "Remove loot row", "loot.updateitem": "Change loot row",
};

/**
 * The commands that act on one player: what each is called, what it does in a
 * sentence, whether the player has to be online, and what is asked before one
 * that cannot be taken back.
 */
const PLAYER_ACTIONS: Record<string, { label: string; note: string; online?: boolean; confirm?: (name: string) => [string, string] }> = {
  "player.summon": { label: "Summon", note: "Bring them to where you are.", online: true },
  "player.goto": { label: "Go to", note: "Take yourself to where they are.", online: true },
  "player.respawn": { label: "Respawn", note: "Send them to the respawn point, alive and at full health." },
  "player.revive": { label: "Revive", note: "Bring them back to life where they are.", online: true },
  "player.kill": {
    label: "Kill", note: "They die where they stand.", online: true,
    confirm: (name) => [`Kill ${name}?`, `${name} dies where they stand and stays dead until they release their spirit or are revived.`],
  },
  "player.kick": {
    label: "Kick", note: "Disconnect them. They can log back in.", online: true,
    confirm: (name) => [`Kick ${name}?`, `${name} is disconnected from the server straight away and can log back in.`],
  },
  "player.ban": {
    label: "Ban", note: "Disconnect them and keep them out until they are unbanned.",
    confirm: (name) => [`Ban ${name}?`, `${name} is disconnected now and cannot log in again until they are unbanned.`],
  },
  "player.unban": { label: "Unban", note: "Let them log in again." },
  "player.unmute": { label: "Unmute", note: "Let everyone hear them again." },
};

/** How long a mute can be set to last. None is a mute until it is lifted. */
const MUTE_LENGTHS: Array<[string, string]> = [
  ["10m", "10 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"],
];
/** What each category of report is called. */
const REPORT_CATEGORIES: Record<string, string> = {
  harassment: "Harassment", spam: "Spam", cheating: "Cheating", name: "Offensive name", other: "Other",
};
/** Longest reason for a mute, or note on a report: what the server takes. */
const NOTE_MAX = 200;

class ControlPanel {
  private data: ControlPanelData | null = null;
  /** Which controls the server says this admin may use, by action. */
  private can: Record<string, boolean> = {};
  private options = { maps: [] as string[], weathers: [] as string[] };
  private accounts: ControlPanelData["accounts"] = null;
  /** The readings the charts are drawn from, oldest first, as the server sends them. */
  private history = { recent: [] as ControlPanelReading[], day: [] as ControlPanelReading[] };
  /** What admins did through the panel, oldest first. */
  private activity: ControlPanelActivity[] = [];

  private page: Page = "dashboard";
  private range: Range = "hour";
  /** Opened by hand, not from the game: there is no game window to talk to. */
  private standalone = !window.opener;
  /** The server refused the panel itself: nothing more is asked. */
  private denied = false;
  /** The server has stopped answering. */
  private lost = false;
  private lastAnswerAt = Date.now();
  /** The first full answer has arrived: what this admin may do is known. */
  private ready = false;

  /** The player the Players page shows the details of: a username as stored. They need not be online. */
  private selected = "";
  private filter = { text: "", role: "all" as "all" | "admins" | "guests", map: "" };
  private sort = { key: "username" as SortKey, down: false };
  /** Accounts that match the search, the offline ones included. */
  private matches: { query: string; players: Account[]; truncated: number } | null = null;
  private matchTimer: ReturnType<typeof setTimeout> | null = null;
  private permissions: { target: string; held: string[]; types: string[]; isAdmin: boolean } | null = null;
  private showPermissions = false;
  /** Whether the selected player is muted, and how many open reports name them. */
  private moderation: { target: string; mute: Mute | null; openReports: number } | null = null;
  /** The reports as last read: the open ones newest first, and the latest that were resolved. */
  private reportList: { open: Report[]; resolved: Report[] } | null = null;
  /** The report the Reports page shows in full. */
  private openReport = 0;
  private lootTables: LootTable[] | null = null;
  private openTable = 0;

  /** What the fields hold between redraws. */
  private drafts = {
    giveItem: "", giveAmount: 1, permission: "", held: new Set<string>(),
    muteLength: "", muteReason: "", resolveNote: "",
    broadcast: "", audience: "ALL", whitelist: "", weather: "", warp: "", reload: "",
    dropItem: "", dropAmount: 1, chestMode: "table" as "table" | "items", chestTable: 0, tableName: "",
    chest: [{ item: "", min: 1, max: 1, chance: 100 }],
    row: { item: "", min: 1, max: 1, chance: 100, quality: "common" },
  };

  /** The action waiting for its answer: one at a time, so each answer is the latest state. */
  private pending: { requestId: string; action: string; timer: ReturnType<typeof setTimeout>; origin: Origin } | null = null;
  private requests = 0;
  /** What went wrong, by the part of the page it went wrong in. */
  private errors = new Map<string, string[]>();
  private errorSlots = new Map<string, HTMLElement>();
  /** The item field being typed in, fed by the server's results. */
  private itemSearch: ItemSearch | null = null;
  private itemTimer: ReturnType<typeof setTimeout> | null = null;
  /** The parts of the open page that follow the server without redrawing the fields around them. */
  private live: Array<{ update: () => void; key?: () => string; last?: string }> = [];

  private navEl = document.getElementById("cp-nav")!;
  private topEl = document.getElementById("tl-topbar")!;
  private bannerEl = document.getElementById("tl-banner")!;
  private pageEl = document.getElementById("tl-page")!;
  private titleEl = el("h1", "tl-title");
  private statusEl = el("div", "cp-status");
  private updatedEl = el("span", "cp-updated");
  private viewerEl = el("div", "cp-viewer");
  private navCountEl = el("span", "tl-count");
  private navReportsEl = el("span", "tl-count");

  constructor() {
    this.buildShell();
    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => this.send({ type: "panelClosed" }));
    // Backup for the game page closing us on unload: if the game tab is gone,
    // this panel has nothing to talk to, so close.
    if (window.opener) {
      setInterval(() => {
        if (!window.opener || window.opener.closed) window.close();
      }, 1000);
    }
    this.paintChrome();
    this.renderPage();
    if (this.standalone) return;
    this.send({ type: "bridgeReady" });
    this.load(true);
    setInterval(() => this.load(false), REFRESH_MS);
    setInterval(() => this.tick(), 1000);
  }

  private send(msg: any): void {
    if (window.opener) window.opener.postMessage(msg, "*");
  }

  private request(packet: string, data: any): void {
    if (!this.denied) this.send({ type: "request", packet, data });
  }

  /**
   * `full` asks for everything: what this admin may do, what the map and
   * weather fields pick from, the whole history. A refresh says which readings
   * and actions it already holds and is sent the newer ones.
   */
  private load(full: boolean): void {
    const newest = (rows: ControlPanelReading[]) => (rows.length ? Number(rows[rows.length - 1][0]) : 0);
    const since = { recent: newest(this.history.recent), day: newest(this.history.day), activity: this.activity.length ? this.activity[this.activity.length - 1].seq : 0 };
    // Until the first full answer has arrived, every request asks for one: the panel cannot tell what this admin may do without it.
    this.request("CONTROL_PANEL_LOAD", full || !this.ready ? { full: true } : { full: false, since });
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== window.opener) return;
    const msg = event.data;
    if (!msg?.type) return;
    if (msg.type === "data") this.onData(msg.data);
    else if (msg.type === "results") this.onResults(msg.data);
    else if (msg.type === "result") this.onResult(msg);
  }

  private onData(data: ControlPanelData): void {
    const redraw = !this.data || !!data.can || this.lost;
    this.data = data;
    this.heard();
    if (data.can) {
      this.can = data.can;
      this.accounts = data.accounts ?? null;
      this.ready = true;
    }
    if (data.options) this.options = data.options;
    this.takeHistory(data, !!data.can);
    // A report came in or was resolved by someone else: the list on screen is read again.
    if (this.page === "reports" && data.reports && data.reports.open !== this.reportList?.open.length) this.askReports();
    this.paintChrome();
    if (redraw) this.renderPage();
    else this.refresh(false);
  }

  /** Adds the readings and actions the server sent to the ones held; a full answer replaces them. */
  private takeHistory(data: ControlPanelData, full: boolean): void {
    const add = (held: ControlPanelReading[], sent: ControlPanelReading[] | undefined, keep: number): ControlPanelReading[] => {
      if (!sent) return held;
      const newest = held.length && !full ? Number(held[held.length - 1][0]) : 0;
      return [...(full ? [] : held), ...sent.filter((row) => Number(row[0]) > newest)].slice(-keep);
    };
    if (data.history) {
      this.history = { recent: add(this.history.recent, data.history.recent, RECENT_KEEP), day: add(this.history.day, data.history.day, DAY_KEEP) };
    }
    if (data.activity) {
      const newest = this.activity.length && !full ? this.activity[this.activity.length - 1].seq : 0;
      this.activity = [...(full ? [] : this.activity), ...data.activity.filter((entry) => entry.seq > newest)].slice(-ACTIVITY_KEEP);
    }
  }

  private onResults(data: any): void {
    if (data?.kind === "permissions") {
      this.permissions = data;
      this.drafts.held = new Set(data.held);
      this.refresh(false);
    } else if (data?.kind === "lootTables") {
      this.lootTables = Array.isArray(data.tables) ? data.tables : [];
      if (this.page === "items") this.renderPage();
    } else if (data?.kind === "moderation") {
      this.moderation = { target: data.target, mute: data.mute ?? null, openReports: Number(data.openReports) || 0 };
      this.refresh(false);
    } else if (data?.kind === "reports") {
      this.reportList = { open: Array.isArray(data.open) ? data.open : [], resolved: Array.isArray(data.resolved) ? data.resolved : [] };
      if (this.page === "reports") this.renderPage();
    } else if (data?.kind === "players") {
      if (data.query !== this.filter.text.trim().toLowerCase()) return;
      this.matches = { query: data.query, players: data.players || [], truncated: data.truncated || 0 };
      this.refresh(true);
    } else if (data?.kind === "items" && this.itemSearch && data.query === this.itemSearch.query) {
      this.itemSearch.paint(data);
    }
  }

  private onResult(msg: any): void {
    this.heard();
    if (msg.denied) {
      // Not an admin any more: stop asking.
      this.denied = true;
      this.endRequest();
      this.paintChrome();
      this.renderPage();
      return;
    }
    // A list that was refused carries no request id.
    if (msg.requestId == null) {
      if (!msg.ok && msg.action === "query") toast((msg.errors || []).join(" ") || "The server refused that.", "error");
      return;
    }
    // The answer to something else: a request that was delivered twice is answered twice.
    if (!this.pending || msg.requestId !== this.pending.requestId || msg.duplicate) return;
    const { action, origin } = this.pending;
    this.endRequest();

    if (msg.ok) {
      const said: string[] = msg.replies?.length ? msg.replies : ["Done."];
      origin.done?.();
      this.errors.delete(origin.key);
      toast(said.join("\n"), "info");
    } else {
      this.fail(origin.key, msg.errors?.length ? msg.errors : ["The server refused that."]);
    }
    if (msg.data) this.data = msg.data;
    // What the action changed is read again: the panel shows what the server has.
    if (action.startsWith("permission.") || action === "player.admin") this.askPermissions();
    if (action.startsWith("loot.")) this.request("CONTROL_PANEL_QUERY", { kind: "lootTables" });
    if (action === "player.mute" || action === "player.unmute") this.askModeration();
    if (action === "report.resolve") this.askReports();
    this.paintChrome();
    this.renderPage();
    // The list of what admins did has a new line.
    this.load(false);
  }

  /** The server has answered: it is there. */
  private heard(): void {
    this.lastAnswerAt = Date.now();
    this.lost = false;
  }

  /** Once a second: how long ago the figures were read, and whether the server still answers. */
  private tick(): void {
    if (this.denied) return;
    const lost = Date.now() - this.lastAnswerAt > LOST_AFTER_MS;
    if (lost !== this.lost) {
      this.lost = lost;
      this.paintChrome();
      this.renderPage();
    }
  }

  // ---------------------------------------------------------------- feedback

  /** Where errors of one part of the page are shown: next to the controls that caused them. */
  private errorSlot(key: string): HTMLElement {
    const slot = el("div", "tl-error");
    slot.setAttribute("role", "alert");
    this.errorSlots.set(key, slot);
    this.paintError(key);
    return slot;
  }

  private paintError(key: string): void {
    const slot = this.errorSlots.get(key);
    if (!slot) return;
    const lines = this.errors.get(key) || [];
    slot.hidden = lines.length === 0;
    slot.replaceChildren();
    if (!lines.length) return;
    slot.appendChild(icon("alert", 15));
    const words = el("div");
    for (const line of lines) words.appendChild(el("div", "", line));
    slot.appendChild(words);
  }

  /** Something went wrong in one part of the page. Said there, or in the corner once that part is gone. */
  private fail(key: string, lines: string[]): void {
    this.errors.set(key, lines);
    if (this.errorSlots.get(key)?.isConnected) this.paintError(key);
    else toast(lines.join("\n"), "error");
  }

  private clearError(key: string): void {
    if (!this.errors.delete(key)) return;
    this.paintError(key);
  }

  // ---------------------------------------------------------------- requests

  private endRequest(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /**
   * Ask the server to run the command behind a control. The button that asked
   * waits for the answer; `origin.done` runs once the server has run it, to
   * empty the field that was sent (a refusal leaves it as typed).
   */
  private act(action: string, data: Record<string, unknown>, origin: Origin): void {
    if (this.denied) return;
    if (this.lost) return this.fail(origin.key, [NOT_ANSWERING]);
    if (this.pending) return toast("Still waiting for the server to answer the last request.", "warning");
    this.clearError(origin.key);
    // Each click has its own id: the server runs a request it has already seen only once.
    const requestId = `${Date.now().toString(36)}-${(++this.requests).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // No answer ever comes if the connection drops: don't stay blocked forever.
    const timer = setTimeout(() => {
      this.endRequest();
      this.fail(origin.key, ["The server did not answer in time, so nothing was confirmed."]);
      this.renderPage();
    }, ANSWER_WITHIN_MS);
    this.pending = { requestId, action, timer, origin };
    this.request("CONTROL_PANEL_ACTION", { ...data, action, requestId });
    if (origin.fk) this.busy(this.pageEl.querySelector<HTMLButtonElement>(`[data-fk="${CSS.escape(origin.fk)}"]`));
  }

  private busy(button: HTMLButtonElement | null): void {
    if (!button) return;
    button.classList.add("is-busy");
    button.setAttribute("aria-busy", "true");
  }

  /** The same, after the admin has read what it will do and agreed. */
  private confirmThen(title: string, consequence: string, okLabel: string, action: string, data: Record<string, unknown>, origin: Origin): void {
    void confirmDialog({ title, body: consequence, okLabel }).then((agreed) => {
      if (agreed) this.act(action, { ...data, confirm: true }, origin);
    });
  }

  private askPermissions(): void {
    if (this.selected && this.showPermissions && this.can["query.permissions"]) this.request("CONTROL_PANEL_QUERY", { kind: "permissions", target: this.selected });
  }

  /** Whether the selected player is muted and how many reports name them: asked of the server, for whoever may act on either. */
  private askModeration(): void {
    if (this.selected && this.can["query.moderation"]) this.request("CONTROL_PANEL_QUERY", { kind: "moderation", target: this.selected });
  }

  private askReports(): void {
    if (this.can["query.reports"]) this.request("CONTROL_PANEL_QUERY", { kind: "reports" });
  }

  private select(username: string): void {
    this.selected = username.toLowerCase();
    if (this.permissions?.target !== this.selected) this.permissions = null;
    if (this.moderation?.target !== this.selected) this.moderation = null;
    this.drafts.permission = "";
    this.drafts.muteLength = "";
    this.drafts.muteReason = "";
    // What went wrong for the last player is not about this one.
    for (const key of [...this.errors.keys()]) if (key.startsWith("players.")) this.errors.delete(key);
    this.askPermissions();
    this.askModeration();
    this.renderPage();
  }

  // ------------------------------------------------------------------ pieces

  /** A titled part of a page: what it is, a line on what it is for, its controls, and where its errors go. */
  private card(parent: HTMLElement, title: string, lead = "", key = ""): { root: HTMLElement; tools: HTMLElement; body: HTMLElement } {
    const root = el("section", "tl-card");
    const head = el("header", "tl-card-head");
    const words = el("div", "tl-card-words");
    words.appendChild(el("h2", "tl-card-title", title));
    if (lead) words.appendChild(el("p", "tl-card-lead", lead));
    const tools = el("div", "tl-card-tools");
    head.append(words, tools);
    const body = el("div", "tl-card-body");
    root.append(head, body);
    if (key) root.appendChild(this.errorSlot(key));
    parent.appendChild(root);
    return { root, tools, body };
  }

  /**
   * A button. With an `action` it is one of the admin commands: greyed out,
   * with the reason, when this admin may not use it or the server is not
   * answering, and shown waiting while its answer is on the way.
   */
  private button(label: string, onClick: (fk: string) => void, opts: { action?: string; icon?: IconName; kind?: "primary" | "danger" | "quiet" | "quiet-danger"; fk?: string } = {}): HTMLButtonElement {
    const fk = opts.fk ?? `${opts.action ?? "ui"}:${label}`;
    const btn = el("button", "tl-btn" + (opts.kind ? ` tl-btn-${opts.kind}` : ""));
    btn.type = "button";
    btn.dataset.fk = fk;
    if (opts.icon) btn.appendChild(icon(opts.icon, 15));
    btn.appendChild(el("span", "", label));
    btn.addEventListener("click", () => onClick(fk));
    if (opts.action) {
      if (!this.can[opts.action]) forbid(btn, NOT_ALLOWED);
      else if (this.lost) forbid(btn, NOT_ANSWERING);
      if (this.pending?.origin.fk === fk) this.busy(btn);
    }
    return btn;
  }

  private field(parent: HTMLElement, label: string, control: HTMLElement, hint = ""): HTMLElement {
    const wrap = el("label", "tl-field");
    wrap.appendChild(el("span", "tl-field-label", label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el("span", "tl-field-hint", hint));
    parent.appendChild(wrap);
    return wrap;
  }

  private textInput(value: string, placeholder: string, onInput: (value: string) => void, maxLength = 100, fk = ""): HTMLInputElement {
    const input = el("input", "tl-input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.spellcheck = false;
    input.autocomplete = "off";
    if (fk) input.dataset.fk = fk;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  private numberInput(value: number, min: number, max: number, onInput: (value: number) => void, step = 1): HTMLInputElement {
    const input = el("input", "tl-input tl-input-number");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", () => onInput(Number(input.value)));
    return input;
  }

  private choice(options: Array<string | [string, string]>, value: string, onChange: (value: string) => void, placeholder = ""): HTMLSelectElement {
    const select = el("select", "tl-input tl-select");
    const pairs = options.map((option) => (typeof option === "string" ? [option, option] : option));
    if (placeholder) {
      const none = el("option", "", placeholder);
      none.value = "";
      select.appendChild(none);
    }
    for (const [key, label] of pairs) {
      const node = el("option", "", label);
      node.value = key;
      select.appendChild(node);
    }
    select.value = pairs.some(([key]) => key === value) ? value : "";
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  /**
   * The buttons under a form, the one that sends it first. If that one is
   * greyed out, the reason is written beside the buttons and the fields of
   * `form` are greyed out with it: there is nothing to fill them in for.
   */
  private actions(parent: HTMLElement, form: HTMLElement | null, ...buttons: HTMLButtonElement[]): HTMLElement {
    const row = el("div", "tl-actions");
    for (const button of buttons) row.appendChild(button);
    const why = buttons[0]?.disabled ? buttons[0].dataset.why : "";
    if (why) {
      row.appendChild(this.reason(why));
      for (const control of form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea") ?? []) forbid(control, why);
    }
    parent.appendChild(row);
    return row;
  }

  private reason(why: string): HTMLElement {
    const note = el("span", "tl-why");
    note.appendChild(icon("lock", 13));
    note.appendChild(el("span", "", why));
    return note;
  }

  /** One thing that can be done, on a row: what it is called, what it does, and its control. A control greyed out gives its reason in place of the description. */
  private row(parent: HTMLElement, title: string, note: string, ...controls: HTMLElement[]): HTMLElement {
    const row = el("div", "tl-row");
    const words = el("div", "tl-row-words");
    words.appendChild(el("span", "tl-row-title", title));
    const blocked = controls.length > 0 && controls.every((control) => (control as HTMLButtonElement).disabled && !!control.dataset.why);
    if (blocked) {
      const why = this.reason(controls[0].dataset.why!);
      why.classList.add("tl-row-note");
      words.appendChild(why);
    } else if (note) {
      words.appendChild(el("span", "tl-row-note", note));
    }
    row.appendChild(words);
    const side = el("div", "tl-row-controls");
    for (const control of controls) side.appendChild(control);
    row.appendChild(side);
    parent.appendChild(row);
    return row;
  }

  private fact(parent: HTMLElement, label: string, value: string | HTMLElement, note = ""): HTMLElement {
    const item = el("div", "tl-fact");
    item.appendChild(el("dt", "tl-fact-label", label));
    const dd = el("dd", "tl-fact-value");
    if (typeof value === "string") dd.textContent = value;
    else dd.appendChild(value);
    item.appendChild(dd);
    if (note) item.appendChild(el("dd", "tl-fact-note", note));
    parent.appendChild(item);
    return item;
  }

  /** The tags of a player's state: what they are, then what has happened to them. */
  private playerTags(p: ControlPanelPlayer, you: boolean): HTMLElement {
    const tags = el("span", "tl-tags");
    if (you) tags.appendChild(tag("You", "you"));
    if (p.isAdmin) tags.appendChild(tag("Admin", "", "shield"));
    if (p.isStealth) tags.appendChild(tag("Stealth", "", "eyeOff"));
    if (p.isGuest) tags.appendChild(tag("Guest", "", "user"));
    if (p.dead === 1) tags.appendChild(tag("Dead", "danger"));
    if (p.dead === 2) tags.appendChild(tag("Ghost", "danger"));
    return tags;
  }

  /**
   * A text field for an item, searched on the server as it is typed in, with
   * the matches listed under it. Typing stands as the value; picking a match
   * replaces it.
   */
  private itemField(value: string, placeholder: string, onValue: (value: string) => void, fk = ""): HTMLElement {
    const wrap = el("div", "tl-suggest-wrap");
    const list = el("div", "tl-suggest");
    list.hidden = true;
    const input = this.textInput(value, placeholder, (typed) => {
      onValue(typed);
      if (this.itemTimer) clearTimeout(this.itemTimer);
      const query = typed.trim().toLowerCase();
      this.itemSearch = { query, paint };
      if (!query) return void (list.hidden = true);
      this.itemTimer = setTimeout(() => this.request("CONTROL_PANEL_QUERY", { kind: "items", query }), 200);
    }, 100, fk);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    const pick = (name: string) => {
      list.hidden = true;
      input.value = name;
      onValue(name);
      input.focus();
    };
    const paint = (result: any) => {
      list.replaceChildren();
      list.hidden = false;
      const rows: any[] = result.items || [];
      if (rows.length === 0) list.appendChild(el("div", "tl-suggest-none", "No item has that in its name."));
      for (const found of rows) {
        const row = el("button", "tl-suggest-row");
        row.type = "button";
        const dot = el("span", `tl-quality tl-quality-${QUALITIES.includes(found.quality) ? found.quality : "common"}`);
        row.append(dot, el("span", "tl-suggest-name", String(found.name)), el("span", "tl-suggest-note", String(found.type ?? "")));
        row.addEventListener("click", () => pick(String(found.name)));
        list.appendChild(row);
      }
      if (result.truncated > 0) list.appendChild(el("div", "tl-suggest-none", `${count(result.truncated, "more match", "more matches")}. Type more of the name.`));
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") list.hidden = true;
      if (e.key === "ArrowDown" && !list.hidden) {
        e.preventDefault();
        list.querySelector<HTMLButtonElement>("button")?.focus();
      }
    });
    list.addEventListener("keydown", (e) => {
      const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") pick(input.value);
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (e.key === "ArrowUp" && at <= 0) input.focus();
      else rows[Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
    });
    wrap.addEventListener("focusout", (e) => {
      if (!wrap.contains(e.relatedTarget as Node | null)) list.hidden = true;
    });
    wrap.append(input, list);
    return wrap;
  }

  // ------------------------------------------------------------------- shell

  private buildShell(): void {
    const brand = el("div", "tl-brand");
    const mark = el("span", "tl-brand-mark");
    mark.appendChild(icon("flame", 18));
    const words = el("span", "tl-brand-words");
    words.append(el("span", "tl-brand-name", "Frostfire Forge"), el("span", "tl-brand-sub", "Control Panel"));
    brand.append(mark, words);

    const list = el("div", "tl-nav cp-nav-list");
    let group = "";
    for (const page of PAGES) {
      if (page.group !== group) {
        group = page.group;
        list.appendChild(el("div", "cp-nav-group", group));
      }
      const item = el("button", "tl-nav-item");
      item.type = "button";
      item.dataset.page = page.id;
      item.title = page.label;
      item.append(icon(page.icon, 18), el("span", "tl-nav-label", page.label));
      if (page.id === "players") item.appendChild(this.navCountEl);
      if (page.id === "reports") item.appendChild(this.navReportsEl);
      item.addEventListener("click", () => this.go(page.id));
      list.appendChild(item);
    }
    this.navEl.append(brand, list, this.viewerEl);

    const refresh = el("button", "tl-icon-btn");
    refresh.type = "button";
    refresh.title = "Read everything again from the server";
    refresh.setAttribute("aria-label", "Reload");
    refresh.appendChild(icon("refresh", 16));
    refresh.addEventListener("click", () => {
      refresh.classList.add("is-spinning");
      setTimeout(() => refresh.classList.remove("is-spinning"), 600);
      this.load(true);
    });
    const end = el("div", "tl-topbar-end");
    end.append(this.updatedEl, refresh);
    this.topEl.append(this.titleEl, this.statusEl, end);
  }

  private go(page: Page): void {
    this.page = page;
    this.errors.clear();
    if (page === "reports") this.askReports();
    // The mute shown for the selected player may have been set from another page.
    if (page === "players") this.askModeration();
    this.paintChrome();
    this.renderPage();
    this.pageEl.scrollTop = 0;
  }

  /** How the server is doing, in a word, with the colour that goes with it. */
  private health(): { level: "good" | "warning" | "danger" | "off" | "wait"; label: string } {
    if (this.standalone) return { level: "off", label: "Not connected" };
    if (this.denied) return { level: "off", label: "No access" };
    if (this.lost) return { level: "danger", label: "Not answering" };
    if (!this.data) return { level: "wait", label: "Connecting" };
    // Trouble comes first; a restart on its way is said when there is none.
    const { restartScheduled, eventLoopLagMs } = this.data.status;
    const lag = this.lagState(eventLoopLagMs);
    return lag.level === "good" && restartScheduled ? { level: "warning", label: "Restart scheduled" } : lag;
  }

  private lagState(lag: number | null): { level: "good" | "warning" | "danger"; label: string } {
    if (lag !== null && lag >= LAG_STRUGGLING_MS) return { level: "danger", label: "Struggling" };
    if (lag !== null && lag >= LAG_BEHIND_MS) return { level: "warning", label: "Running behind" };
    return { level: "good", label: "Running" };
  }

  /** The frame around the pages: where you are, the server's state at a glance, and who you are. */
  private paintChrome(): void {
    const page = PAGES.find((p) => p.id === this.page)!;
    document.title = `${page.label} · Control Panel`;
    this.titleEl.textContent = page.label;
    for (const item of this.navEl.querySelectorAll<HTMLElement>(".tl-nav-item")) {
      const here = item.dataset.page === this.page;
      item.classList.toggle("is-active", here);
      if (here) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }

    const health = this.health();
    const s = this.data?.status;
    this.statusEl.replaceChildren();
    const pill = el("span", `tl-pill tl-pill-${health.level}`);
    pill.append(el("span", "tl-pill-dot"), el("span", "", health.label));
    this.statusEl.appendChild(pill);
    if (s && !this.denied) {
      const stat = (label: string, value: string, extra = "") => {
        const node = el("span", "cp-stat" + (extra ? ` ${extra}` : ""));
        node.append(el("span", "cp-stat-label", label), el("span", "cp-stat-value", value));
        this.statusEl.appendChild(node);
      };
      stat("Online", num(s.online));
      stat("Uptime", duration(s.uptime), "cp-stat-wide");
      stat("Lag", s.eventLoopLagMs === null ? "Unknown" : `${num(s.eventLoopLagMs)} ms`);
      stat("Memory", memory(s.memoryMb), "cp-stat-wide");
    }
    this.updatedEl.textContent = this.data && !this.denied ? `Updated ${clock(this.lastAnswerAt, true)}` : "";
    this.navCountEl.textContent = s && !this.denied ? num(s.online) : "";
    this.navCountEl.hidden = !s || this.denied;
    // How many reports wait, for those who handle them: nothing is shown when none do.
    const waiting = this.denied ? 0 : this.data?.reports?.open ?? 0;
    this.navReportsEl.textContent = waiting ? num(waiting) : "";
    this.navReportsEl.hidden = !waiting;

    this.bannerEl.replaceChildren();
    this.bannerEl.className = "tl-banner";
    if (this.data && this.lost && !this.denied) {
      this.bannerEl.classList.add("tl-banner-danger");
      this.bannerEl.append(icon("plug", 16), el("span", "", `The server has not answered since ${clock(this.lastAnswerAt, true)}. What you see is from then, and the controls are paused until it answers again.`));
    } else if (s?.restartScheduled && !this.denied) {
      this.bannerEl.classList.add("tl-banner-warning");
      this.bannerEl.append(icon("restart", 16), el("span", "", "A restart is scheduled. Players are seeing the countdown, and everyone is disconnected when it ends."));
      if (this.page !== "server") {
        const open = el("button", "tl-link", "Go to Server");
        open.type = "button";
        open.addEventListener("click", () => this.go("server"));
        this.bannerEl.appendChild(open);
      }
    }
    this.bannerEl.hidden = this.bannerEl.childElementCount === 0;

    this.viewerEl.replaceChildren();
    const viewer = this.data?.viewer;
    if (!viewer || this.denied) return;
    const who = el("div", "cp-viewer-who");
    const names = el("div", "cp-viewer-words");
    names.append(el("span", "cp-viewer-name", shown(viewer.username)), el("span", "cp-viewer-note", `Admin · on ${viewer.map}`));
    who.append(avatar(viewer.username), names);
    this.viewerEl.appendChild(who);
    this.viewerEl.title = `${shown(viewer.username)}, on ${viewer.map}`;
    const modes = el("div", "cp-viewer-modes");
    if (viewer.isStealth) modes.appendChild(tag("Stealth on", "info", "eyeOff"));
    if (viewer.isNoclip) modes.appendChild(tag("Noclip on", "info", "move"));
    if (modes.childElementCount) this.viewerEl.appendChild(modes);
  }

  // ------------------------------------------------------------------- pages

  /** Builds the open page again, with the focus and the scrolling where they were. */
  private renderPage(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.fk;
    const scrolls = [...this.pageEl.querySelectorAll<HTMLElement>("[data-scroll]")].map((node) => [node.dataset.scroll!, node.scrollTop] as const);
    const top = this.pageEl.scrollTop;

    this.pageEl.replaceChildren();
    this.pageEl.className = "tl-page";
    this.live = [];
    this.itemSearch = null;
    this.errorSlots.clear();
    this.build();
    this.refresh(true);

    this.pageEl.scrollTop = top;
    for (const [key, at] of scrolls) {
      const node = this.pageEl.querySelector<HTMLElement>(`[data-scroll="${key}"]`);
      if (node) node.scrollTop = at;
    }
    if (focused) this.pageEl.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  private build(): void {
    if (this.standalone) return void this.screen("plug", "This window opens from the game", "Log in to the game as an admin and type /cp in the chat. The control panel opens from there and stays connected to your game.");
    if (this.denied) return void this.screen("lock", "The control panel is for admins", "Your account does not have the admin role, so the server will not answer this window. You can close it.");
    if (!this.data) {
      if (this.lost) {
        const box = this.screen("plug", "The server is not answering", "Nothing has come back from the server yet. Check that your game is still connected, then try again.");
        box.appendChild(this.button("Try again", () => this.load(true), { icon: "refresh", kind: "primary" }));
        return;
      }
      return this.skeleton();
    }
    const inner = el("div", "tl-page-inner");
    const lead = PAGES.find((p) => p.id === this.page)!.lead;
    if (lead) inner.appendChild(el("p", "tl-lead", lead));
    this.pageEl.appendChild(inner);
    switch (this.page) {
      case "players": this.renderPlayers(inner); break;
      case "reports": this.renderReports(inner); break;
      case "communication": this.renderCommunication(inner); break;
      case "server": this.renderServer(inner); break;
      case "world": this.renderWorld(inner); break;
      case "items": this.renderItems(inner); break;
      default: this.renderDashboard(inner);
    }
  }

  /** A page that has nothing to show but a reason. */
  private screen(name: IconName, title: string, text: string): HTMLElement {
    return screen(this.pageEl, name, title, text);
  }

  /** The shape of the page while the first answer is on its way. */
  private skeleton(): void {
    const inner = el("div", "tl-page-inner");
    inner.setAttribute("aria-busy", "true");
    inner.setAttribute("aria-label", "Loading");
    const tiles = el("div", "cp-kpis");
    for (let i = 0; i < 6; i++) tiles.appendChild(el("div", "tl-skeleton tl-skeleton-tile"));
    const blocks = el("div", "tl-grid");
    blocks.append(el("div", "tl-skeleton tl-skeleton-block tl-span-8"), el("div", "tl-skeleton tl-skeleton-block tl-span-4"));
    inner.append(tiles, blocks);
    this.pageEl.appendChild(inner);
  }

  /**
   * A part of the page that is redrawn from each answer of the server. With a
   * `key`, only when what it shows has changed: its buttons are not swapped
   * for new ones under the mouse every few seconds.
   */
  private follow(update: () => void, key?: () => string): void {
    this.live.push({ update, key });
  }

  private refresh(all: boolean): void {
    if (!this.data || this.denied) return;
    for (const part of this.live) {
      const now = part.key?.();
      if (!all && now !== undefined && now === part.last) continue;
      part.last = now;
      part.update();
    }
  }

  // --------------------------------------------------------------- dashboard

  /** One figure of the history as points over time: 1 players online, 2 lag, 3 memory, 4 creatures awake. */
  private series(rows: ControlPanelReading[], figure: number): Point[] {
    return rows.map((row) => ({ t: Number(row[0]), v: row[figure] ?? null }));
  }

  private newestReading(): number {
    const rows = this.history.recent.length ? this.history.recent : this.history.day;
    return rows.length ? Number(rows[rows.length - 1][0]) : Math.floor(Date.now() / 1000);
  }

  private renderDashboard(root: HTMLElement): void {
    const kpis = el("div", "cp-kpis");
    root.appendChild(kpis);
    this.follow(() => this.paintKpis(kpis), () => JSON.stringify([this.data!.status, this.newestReading()]));

    // One choice of time above the charts it applies to.
    const bar = el("div", "tl-sectionbar");
    const words = el("div", "tl-sectionbar-words");
    words.append(el("h2", "tl-sectionbar-title", "Over time"), el("p", "tl-sectionbar-lead", "The server takes a reading every 15 seconds and keeps the last 24 hours."));
    bar.append(words, segments(RANGES.map((r) => [r.id, r.label] as [Range, string]), this.range, (range) => {
      this.range = range;
      this.renderPage();
    }, "Time shown"));
    root.appendChild(bar);

    const grid = el("div", "tl-grid");
    root.appendChild(grid);
    const range = RANGES.find((r) => r.id === this.range)!;
    const chart = (title: string, figure: number, span: string, options: ConstructorParameters<typeof LineChart>[0]) => {
      const card = el("section", `tl-card cp-chart ${span}`);
      const head = el("header", "tl-card-head");
      const names = el("div", "tl-card-words");
      names.appendChild(el("h2", "tl-card-title", title));
      const summary = el("div", "cp-chart-summary");
      head.append(names, summary);
      const plot = new LineChart(options);
      card.append(head, plot.element);
      grid.appendChild(card);
      this.follow(() => {
        // The longer views are drawn from the minutes of the day, and end on the newest reading there is.
        const { recent, day } = this.history;
        const latest = recent[recent.length - 1];
        const ahead = latest && (!day.length || Number(latest[0]) > Number(day[day.length - 1][0]));
        const rows = this.range === "hour" ? recent : ahead ? [...day, latest] : day;
        const to = this.newestReading();
        const from = to - range.seconds;
        const points = this.series(rows, figure);
        // Readings are 15 seconds apart in the last hour and a minute apart before that.
        plot.update(points, from, to, this.range === "hour" ? 40 : 150);
        const values = points.filter((p) => p.v !== null && p.t >= from).map((p) => p.v as number);
        summary.replaceChildren();
        if (!values.length) return;
        const say = (label: string, value: number) => {
          const item = el("span", "cp-chart-stat");
          item.append(el("span", "cp-chart-stat-label", label), el("span", "cp-chart-stat-value", options.axis(value)));
          summary.appendChild(item);
        };
        // "Now" is the newest reading, whichever stretch of time is shown: a minute of the day holds its highest.
        say("Now", latest?.[figure] ?? values[values.length - 1]);
        say("Lowest", Math.min(...values));
        say("Highest", Math.max(...values));
      }, () => `${this.newestReading()}:${this.history.day.length}`);
    };
    chart("Players online", 1, "tl-span-8", { label: "Players online", format: (v) => count(v, "player"), axis: num, height: 236, fromZero: true, minTop: 4 });
    this.renderActivity(grid);
    chart("Server lag", 2, "tl-span-4", {
      label: "Server lag", format: (v) => `${short(v)} ms`, axis: (v) => `${short(v)} ms`, height: 168, fromZero: true, minTop: 10,
      threshold: { value: LAG_BEHIND_MS, label: `Running behind from ${LAG_BEHIND_MS} ms` },
    });
    chart("Memory in use", 3, "tl-span-4", { label: "Memory in use", format: memory, axis: memory, height: 168, fromZero: false });

    const who = el("div", "tl-sectionbar");
    const whoWords = el("div", "tl-sectionbar-words");
    whoWords.append(el("h2", "tl-sectionbar-title", "Who is online"), el("p", "tl-sectionbar-lead", "The players connected right now, by where they are, how far along they are, and what they are."));
    who.appendChild(whoWords);
    root.appendChild(who);

    const breakdown = el("div", "tl-grid");
    root.appendChild(breakdown);
    const byMap = this.card(breakdown, "By map", "Pick a map to list the players on it.");
    byMap.root.classList.add("tl-span-4");
    const byLevel = this.card(breakdown, "By level", "Players in each band of ten levels.");
    byLevel.root.classList.add("tl-span-4");
    byLevel.body.classList.add("cp-card-fill");
    const byRole = this.card(breakdown, "By role", "Admins, guests, and everyone else.");
    byRole.root.classList.add("tl-span-4");
    this.follow(() => {
      const players = this.data!.players;
      for (const body of [byMap.body, byLevel.body, byRole.body]) body.replaceChildren();
      if (players.length === 0) {
        for (const body of [byMap.body, byLevel.body, byRole.body]) empty(body, "players", "Nobody is online");
        return;
      }
      byMap.body.appendChild(barList(this.mapBars(players), (v) => count(v, "player")));
      byLevel.body.appendChild(columns(this.levelBars(players), (v) => count(v, "player")));
      const admins = players.filter((p) => p.isAdmin).length;
      const guests = players.filter((p) => p.isGuest && !p.isAdmin).length;
      byRole.body.appendChild(shares([
        { label: "Players", value: players.length - admins - guests },
        { label: "Admins", value: admins },
        { label: "Guests", value: guests },
      ], (v) => count(v, "player")));
      if (this.accounts) {
        const totals = el("dl", "tl-facts tl-facts-inline");
        this.fact(totals, "Registered accounts", num(this.accounts.registered));
        this.fact(totals, "Banned accounts", num(this.accounts.banned));
        byRole.body.appendChild(totals);
      }
    }, () => JSON.stringify([this.data!.players.map((p) => [p.map, p.level, p.isAdmin, p.isGuest]), this.accounts]));
  }

  private mapBars(players: ControlPanelPlayer[]): Bar[] {
    const counts = new Map<string, number>();
    for (const p of players) counts.set(p.map, (counts.get(p.map) || 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const open = (map: string) => () => {
      this.filter = { text: "", role: "all", map };
      this.go("players");
    };
    const bars: Bar[] = sorted.slice(0, 6).map(([map, value]) => ({ label: map, value, onPick: open(map) }));
    const rest = sorted.slice(6);
    if (rest.length) bars.push({ label: `${count(rest.length, "other map")}`, value: rest.reduce((sum, [, value]) => sum + value, 0) });
    return bars;
  }

  /** Bands of ten levels, up to the highest anyone online has reached; at most eight bands, the last open-ended. */
  private levelBars(players: ControlPanelPlayer[]): Bar[] {
    const top = Math.max(1, ...players.map((p) => p.level));
    const bands = Math.min(8, Math.max(5, Math.floor(top / 10) + 1));
    const bars: Bar[] = [];
    for (let band = 0; band < bands; band++) {
      const last = band === bands - 1 && top >= bands * 10;
      const from = band === 0 ? 1 : band * 10;
      bars.push({
        label: last ? `${from}+` : `${from}–${band * 10 + 9}`,
        value: players.filter((p) => (last ? p.level >= from : Math.floor(p.level / 10) === band)).length,
      });
    }
    return bars;
  }

  private paintKpis(parent: HTMLElement): void {
    const s = this.data!.status;
    const recent = this.history.recent;
    const figure = (index: number) => recent.map((row) => row[index] ?? null);
    // How a figure has moved over the readings held: up to the last hour.
    const first = recent[0];
    const covered = first ? this.newestReading() - Number(first[0]) : 0;
    const over = covered >= 3300 ? "in the last hour" : covered >= 60 ? `in the last ${duration(covered - (covered % 60))}` : "";
    const moved = (now: number, index: number, unit: (delta: number) => string, upIsGood: boolean) => {
      const then = first?.[index];
      const line = el("div", "cp-kpi-foot");
      if (then === null || then === undefined || !over) return line;
      const delta = now - then;
      if (delta === 0) {
        line.appendChild(el("span", "", `No change ${over}`));
        return line;
      }
      const up = delta > 0;
      // More players is good news; fewer, or memory moving either way, is only news.
      const mark = el("span", "cp-delta" + (up && upIsGood ? " cp-delta-good" : ""));
      mark.append(icon(up ? "arrowUp" : "arrowDown", 12), el("span", "", unit(Math.abs(delta))));
      line.append(mark, el("span", "", ` ${over}`));
      return line;
    };
    const tile = (name: IconName, label: string, value: string, unit: string, foot: HTMLElement | string, trend: Array<number | null> | null, hint = "") => {
      const node = el("div", "cp-kpi");
      const head = el("div", "cp-kpi-label");
      head.append(icon(name, 14), el("span", "", label));
      if (hint) head.title = hint;
      const figureEl = el("div", "cp-kpi-value");
      figureEl.appendChild(el("span", "", value));
      if (unit) figureEl.appendChild(el("span", "cp-kpi-unit", unit));
      const footEl = typeof foot === "string" ? el("div", "cp-kpi-foot", foot) : foot;
      node.append(head, figureEl, footEl);
      if (trend) node.appendChild(sparkline(trend));
      parent.appendChild(node);
      return node;
    };

    parent.replaceChildren();
    tile("players", "Players online", num(s.online), "", moved(s.online, 1, (d) => num(d), true), figure(1));
    tile("pulse", "Peak online", num(s.peak.online), "", s.peak.at ? dayAndTime(s.peak.at) : "Since the server started", this.history.day.map((row) => row[1] ?? null),
      "The most players online at once since the server started. The line is the last 24 hours.");
    const started = dayAndTime(Date.now() - s.uptime * 1000);
    const uptime = tile("clock", "Uptime", duration(s.uptime), "", `Since ${started.charAt(0).toLowerCase()}${started.slice(1)}`, null);
    const next = el("div", "cp-kpi-note");
    next.append(icon("restart", 13), el("span", "", s.restartScheduled ? "A restart is scheduled" : "No restart is scheduled"));
    uptime.appendChild(next);

    const lag = s.eventLoopLagMs;
    const lagFoot = el("div", "cp-kpi-foot");
    const state = this.lagState(lag);
    const stateTag = tag(state.level === "good" ? "Keeping up" : state.label, state.level === "good" ? "good" : state.level, state.level === "good" ? "check" : "alert");
    lagFoot.appendChild(stateTag);
    const lags = figure(2).filter((v): v is number => v !== null);
    if (lags.length) lagFoot.appendChild(el("span", "", `Highest ${short(Math.max(...lags))} ms`));
    tile("gauge", "Server lag", lag === null ? "Unknown" : num(lag), lag === null ? "" : "ms", lagFoot, figure(2),
      "How late the server is running its work, averaged over the last second or so. It holds work back from 30 ms. Highest is the most it reached in the last hour.");

    tile("chip", "Memory in use", memory(s.memoryMb).split(" ")[0], memory(s.memoryMb).split(" ")[1], moved(s.memoryMb, 3, (d) => memory(d), false), figure(3));

    const c = s.creatures;
    if (c) {
      tile("paw", "Creatures awake", num(Number(c.awake) || 0), `of ${num(Number(c.creatures) || 0)}`, `${num(Number(c.inCombat) || 0)} in combat · on ${count(Number(c.maps) || 0, "map")}`, figure(4),
        "Creatures near a player or in a fight. The rest are asleep and cost the server nothing.");
    } else {
      tile("paw", "Creatures awake", "Unknown", "", "No creature figures yet", null);
    }
  }

  /** What admins did through the panel, newest first: who, what, on whom, when, and what the command answered. */
  private renderActivity(parent: HTMLElement): void {
    const card = this.card(parent, "Recent activity", "What admins did through this panel.");
    card.root.classList.add("tl-span-4", "cp-activity");
    card.body.dataset.scroll = "activity";
    this.follow(() => {
      card.body.replaceChildren();
      if (this.activity.length === 0) {
        empty(card.body, "list", "Nothing yet", "Actions taken here are listed as they happen, for every admin to see.");
        return;
      }
      const list = el("ol", "cp-acts");
      for (const entry of [...this.activity].reverse()) list.appendChild(this.activityLine(entry));
      card.body.appendChild(list);
    }, () => `${this.activity.length ? this.activity[this.activity.length - 1].seq : 0}:${Math.floor(Date.now() / 30000)}`);
  }

  private activityLine(entry: ControlPanelActivity): HTMLElement {
    const d = entry.details;
    const group = entry.action.split(".")[0];
    const names: Record<string, IconName> = { self: "user", player: "players", permission: "key", server: "server", world: "globe", item: "box", chest: "box", loot: "box" };
    const item = el("li", "cp-act");
    const badge = el("span", "cp-act-icon");
    badge.appendChild(icon(entry.action === "server.broadcast" ? "megaphone" : names[group] ?? "list", 14));

    const what = entry.action.startsWith("self.") ? `${ACTION_LABELS[entry.action]} ${d.enabled ? "on" : "off"}`
      : entry.action === "player.admin" ? (d.admin ? "Make admin" : "Remove admin")
      : ACTION_LABELS[entry.action] ?? entry.action;
    // What went with it, in a few words, unless the command's answer already says it.
    const amount = d.item ? `${d.quantity && d.quantity !== 1 ? `${num(Number(d.quantity))} × ` : ""}${d.item}` : "";
    const audience = AUDIENCES.find(([key]) => key === String(d.audience ?? "").toUpperCase())?.[2];
    const subject = String(d.item ?? d.permission ?? d.map ?? d.weather ?? d.name ?? "");
    const detail = entry.action === "server.broadcast" ? (audience ? `to ${audience}` : "")
      : subject && entry.said.toLowerCase().includes(subject.toLowerCase()) ? ""
      : String(amount || subject);

    const line = el("div", "cp-act-line");
    line.appendChild(el("strong", "", shown(entry.by)));
    line.appendChild(el("span", "cp-act-what", what));
    if (entry.target) line.appendChild(el("strong", "", shown(entry.target)));
    if (detail) line.appendChild(el("span", "cp-act-detail", detail));
    const body = el("div", "cp-act-body");
    body.appendChild(line);
    if (entry.said) body.appendChild(el("div", "cp-act-said", entry.said));
    const when = el("time", "cp-act-when", ago(entry.at));
    when.dateTime = new Date(entry.at).toISOString();
    when.title = new Date(entry.at).toLocaleString();
    item.append(badge, body, when);
    return item;
  }

  // ----------------------------------------------------------------- players

  /** A button that runs one player command on `p`, greyed out where the command would refuse. */
  private playerButton(action: string, p: { username: string; isAdmin?: boolean; online?: boolean }, origin: string): HTMLButtonElement {
    const spec = PLAYER_ACTIONS[action];
    const name = shown(p.username);
    const data = { target: p.username };
    const btn = this.button(spec.label, (fk) => {
      const warning = spec.confirm?.(name);
      if (warning) this.confirmThen(warning[0], warning[1], spec.label, action, data, { key: origin, fk });
      else this.act(action, data, { key: origin, fk });
    }, { action, kind: spec.confirm ? "danger" : undefined, fk: `${action}:${p.username}` });

    const self = p.username === this.data!.viewer.username;
    if (spec.online && p.online === false) forbid(btn, `${name} is not online.`);
    if (self && ["player.summon", "player.goto", "player.kick", "player.ban", "player.unban"].includes(action)) forbid(btn, "That is you.");
    if (p.isAdmin && action === "player.kick") forbid(btn, "Admins cannot be kicked.");
    if (p.isAdmin && action === "player.ban") forbid(btn, "Admins cannot be banned.");
    if (p.isAdmin && action === "player.summon" && !this.can["player.summon.admins"]) forbid(btn, "You don't have permission to summon admins.");
    return btn;
  }

  private renderPlayers(root: HTMLElement): void {
    this.pageEl.classList.add("tl-page-fill");
    const layout = el("div", "cp-players" + (this.selected ? " has-detail" : ""));
    root.appendChild(layout);

    const card = el("section", "tl-card tl-table-card");
    layout.appendChild(card);
    const tools = el("div", "tl-toolbar");
    card.appendChild(tools);

    const search = el("div", "tl-search");
    search.appendChild(icon("search", 15));
    const input = this.textInput(this.filter.text, "Search players", (value) => {
      this.filter.text = value;
      this.matches = null;
      if (this.matchTimer) clearTimeout(this.matchTimer);
      const query = value.trim().toLowerCase();
      // A name of two letters or more is also looked up among every account, the offline ones included.
      if (query.length >= 2) this.matchTimer = setTimeout(() => this.request("CONTROL_PANEL_QUERY", { kind: "players", query }), 250);
      paint();
    }, 64, "players.search");
    input.type = "search";
    input.setAttribute("aria-label", "Search players by name or map");
    search.appendChild(input);
    tools.appendChild(search);

    const players = this.data!.players;
    const roles = segments<"all" | "admins" | "guests">([
      ["all", "All"], ["admins", "Admins"], ["guests", "Guests"],
    ], this.filter.role, (role) => {
      this.filter.role = role;
      this.renderPage();
    }, "Show");
    tools.appendChild(roles);

    const maps = [...new Set(players.map((p) => p.map))].sort((a, b) => a.localeCompare(b));
    if (this.filter.map && !maps.includes(this.filter.map)) maps.push(this.filter.map);
    const map = this.choice(maps, this.filter.map, (value) => {
      this.filter.map = value;
      paint();
    }, "All maps");
    map.dataset.fk = "players.map";
    map.setAttribute("aria-label", "Show the players on one map");
    tools.appendChild(map);

    const scroll = el("div", "tl-table-scroll");
    scroll.dataset.scroll = "players";
    card.appendChild(scroll);
    // How many rows the search and filters leave, under the table.
    const total = el("div", "tl-table-foot");
    total.setAttribute("aria-live", "polite");
    card.appendChild(total);
    const table = el("table", "tl-table");
    const head = el("thead");
    const headRow = el("tr");
    const columnsOf: Array<[SortKey, string, string]> = [["username", "Player", ""], ["level", "Level", "tl-num"], ["map", "Map", ""], ["status", "Status", ""], ["onlineFor", "Online for", "tl-num cp-col-time"]];
    for (const [key, label, className] of columnsOf) {
      const th = el("th", className);
      th.scope = "col";
      const sorter = el("button", "tl-sort");
      sorter.type = "button";
      sorter.dataset.fk = `sort:${key}`;
      sorter.appendChild(el("span", "", label));
      const active = this.sort.key === key;
      sorter.appendChild(icon(active && this.sort.down ? "chevronDown" : "chevronUp", 12));
      th.setAttribute("aria-sort", active ? (this.sort.down ? "descending" : "ascending") : "none");
      sorter.title = `Sort by ${label.toLowerCase()}`;
      sorter.addEventListener("click", () => {
        this.sort = { key, down: active ? !this.sort.down : false };
        this.renderPage();
      });
      th.appendChild(sorter);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = el("tbody");
    table.append(head, body);
    scroll.appendChild(table);

    const paint = () => this.paintPlayers(body, total);
    // The rows are built again when who is online changes, not as the time each has been online counts up.
    this.follow(paint, () => JSON.stringify([this.data!.players.map((p) => ({ ...p, onlineFor: p.onlineFor === null })), this.matches, this.selected]));
    this.follow(() => {
      const online = new Map(this.data!.players.map((p) => [p.username, p.onlineFor]));
      for (const time of body.querySelectorAll<HTMLElement>("[data-time]")) {
        const seconds = online.get(time.dataset.time!);
        if (seconds !== null && seconds !== undefined) time.textContent = duration(seconds);
      }
    });

    if (!this.selected) return;
    const detail = el("aside", "tl-card tl-detail");
    detail.setAttribute("aria-label", `${shown(this.selected)}: details and actions`);
    detail.dataset.scroll = "detail";
    layout.appendChild(detail);
    this.renderDetail(detail, this.selected);
  }

  /** The order of the Status column: what a player is, then what has happened to them. */
  private statusRank(p: ControlPanelPlayer): number {
    return (p.isAdmin ? 8 : 0) + (p.isStealth ? 4 : 0) + (p.isGuest ? 2 : 0) + (p.dead ? 1 : 0);
  }

  private paintPlayers(body: HTMLElement, total: HTMLElement): void {
    const { players, viewer } = this.data!;
    const wanted = this.filter.text.trim().toLowerCase();
    const rows = players.filter((p) =>
      (!wanted || p.username.includes(wanted) || p.map.toLowerCase().includes(wanted))
      && (this.filter.role === "all" || (this.filter.role === "admins" ? p.isAdmin : p.isGuest))
      && (!this.filter.map || p.map === this.filter.map));
    const { key, down } = this.sort;
    const value = (p: ControlPanelPlayer): string | number =>
      key === "status" ? -this.statusRank(p) : key === "onlineFor" ? (p.onlineFor ?? -1) : p[key];
    rows.sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (down ? -order : order) || a.username.localeCompare(b.username);
    });

    const filtered = !!wanted || this.filter.role !== "all" || !!this.filter.map;
    total.textContent = filtered ? `Showing ${num(rows.length)} of ${count(players.length, "player")} online` : `${count(players.length, "player")} online`;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.row;
    body.replaceChildren();

    const pick = (row: HTMLTableRowElement, username: string) => {
      row.tabIndex = 0;
      row.dataset.row = username;
      row.setAttribute("aria-selected", String(username === this.selected));
      if (username === this.selected) row.classList.add("is-selected");
      row.addEventListener("click", () => this.select(username));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.select(username);
        }
        const next = e.key === "ArrowDown" ? row.nextElementSibling : e.key === "ArrowUp" ? row.previousElementSibling : null;
        if (!next) return;
        e.preventDefault();
        // The heading of a group of rows is stepped over.
        const to = (next as HTMLElement).tabIndex === 0 ? next : e.key === "ArrowDown" ? next.nextElementSibling : next.previousElementSibling;
        (to as HTMLElement | null)?.focus();
      });
    };
    const cell = (row: HTMLElement, className = "", text = "") => row.appendChild(el("td", className, text));

    for (const p of rows) {
      const row = el("tr");
      pick(row, p.username);
      const name = cell(row, "cp-cell-player");
      name.append(avatar(p.username), el("span", "cp-player-name", shown(p.username)));
      cell(row, "tl-num", num(p.level));
      cell(row, "", p.map);
      cell(row).appendChild(this.playerTags(p, p.username === viewer.username));
      cell(row, "tl-num cp-col-time", p.onlineFor === null ? "Unknown" : duration(p.onlineFor)).dataset.time = p.username;
      body.appendChild(row);
    }

    // Under who is online: the accounts the search found that are not, so anyone can be picked.
    const online = new Set(players.map((p) => p.username));
    const offline = wanted.length >= 2 && this.matches?.query === wanted ? this.matches.players.filter((a) => !online.has(a.username)) : null;
    const note = (text: string, className = "tl-table-note") => {
      const row = el("tr", className);
      const td = el("td", "", text);
      td.colSpan = 5;
      row.appendChild(td);
      body.appendChild(row);
      return td;
    };
    if (rows.length === 0) {
      const td = note("", "tl-table-empty");
      const box = empty(td, filtered ? "search" : "players", filtered ? "No player online matches that" : "Nobody is online", filtered ? "" : "Players appear here as they log in.");
      if (filtered) {
        box.appendChild(this.button("Clear the search and filters", () => {
          this.filter = { text: "", role: "all", map: "" };
          this.matches = null;
          this.renderPage();
        }, { kind: "quiet" }));
      }
    }
    if (wanted.length >= 2 && !offline) note("Searching every account…");
    if (offline?.length) {
      note(`Accounts that are not online, matching “${wanted}”`, "tl-table-group");
      for (const account of offline) {
        const row = el("tr", "cp-row-offline");
        pick(row, account.username);
        const name = cell(row, "cp-cell-player");
        name.append(avatar(account.username), el("span", "cp-player-name", shown(account.username)));
        cell(row, "tl-num", "");
        cell(row, "", "");
        cell(row).appendChild(tag("Offline", "muted"));
        cell(row, "tl-num cp-col-time", "");
        body.appendChild(row);
      }
      if (this.matches!.truncated > 0) note(`${count(this.matches!.truncated, "more account matches", "more accounts match")}. Type more of the name to narrow it down.`);
    } else if (offline && wanted.length >= 2 && rows.length > 0) {
      note(`No other account matches “${wanted}”.`);
    }
    if (focused) body.querySelector<HTMLElement>(`[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  /** The side panel of the player picked: who they are, then what can be done, by kind. */
  private renderDetail(panel: HTMLElement, who: string): void {
    const name = shown(who);
    const self = who === this.data!.viewer.username;
    const origin = "players.account";

    const head = el("header", "tl-detail-head");
    const words = el("div", "tl-detail-words");
    const state = el("div", "tl-detail-state");
    words.append(el("h2", "tl-detail-name", name), state);
    const close = el("button", "tl-icon-btn");
    close.type = "button";
    close.dataset.fk = "detail.close";
    close.setAttribute("aria-label", `Close ${name}'s details`);
    close.title = "Close";
    close.appendChild(icon("close", 16));
    close.addEventListener("click", () => {
      this.selected = "";
      this.renderPage();
    });
    head.append(avatar(who, true), words, close);
    const tags = el("div", "cp-detail-tags");
    const facts = el("dl", "tl-facts");
    panel.append(head, tags, facts);

    // Each kind of action has its own place for what goes wrong, right under its controls.
    const group = (title: string, name: IconName, key: string): HTMLElement => {
      const section = el("section", "tl-group");
      const heading = el("h3", "tl-group-title");
      heading.append(icon(name, 14), el("span", "", title));
      const rows = el("div", "tl-rows");
      section.append(heading, rows, this.errorSlot(key));
      panel.appendChild(section);
      return rows;
    };
    const movement = group("Movement", "move", "players.movement");
    const moderation = group("Moderation", "shield", "players.moderation");
    const chat = group("Chat", "megaphone", "players.chat");
    // How things stand follows the server; the fields under it are built once, so what is typed in them stays.
    const chatState = el("div", "tl-rows");
    chat.appendChild(chatState);
    const account = group("Account", "user", origin);
    const items = group("Items", "box", "players.items");

    this.follow(() => {
      const live = this.data!.players.find((p) => p.username === who);
      const known = this.matches?.players.find((a) => a.username === who);
      state.replaceChildren();
      const dot = el("span", "tl-dot" + (live ? " tl-dot-on" : ""));
      state.append(dot, el("span", "", live ? `Online, on ${live.map}` : "Not online"));
      tags.replaceChildren();
      if (live) tags.appendChild(this.playerTags(live, self));
      tags.hidden = !live || tags.firstElementChild!.childElementCount === 0;
      facts.replaceChildren();
      if (live) {
        this.fact(facts, "Level", num(live.level));
        this.fact(facts, "Map", live.map);
        this.fact(facts, "Online for", live.onlineFor === null ? "Unknown" : duration(live.onlineFor)).dataset.time = who;
        this.fact(facts, "Connection", live.id);
      } else {
        this.fact(facts, "Status", "Offline");
        if (known) this.fact(facts, "Account number", String(known.userid));
      }

      const p = { username: who, isAdmin: live ? live.isAdmin : this.permissions?.target === who ? this.permissions.isAdmin : undefined, online: !!live };
      const act = (rows: HTMLElement, key: string, action: string) => this.row(rows, PLAYER_ACTIONS[action].label, PLAYER_ACTIONS[action].note, this.playerButton(action, p, key));
      movement.replaceChildren();
      for (const action of ["player.summon", "player.goto", "player.respawn"]) act(movement, "players.movement", action);
      moderation.replaceChildren();
      for (const action of ["player.revive", "player.kill", "player.kick", "player.ban", "player.unban"]) act(moderation, "players.moderation", action);

      chatState.replaceChildren();
      if (this.can["query.moderation"]) {
        const held = this.moderation?.target === who ? this.moderation : null;
        const mute = held?.mute ?? null;
        const unmute = this.playerButton("player.unmute", p, "players.chat");
        if (held && !mute) forbid(unmute, `${name} is not muted.`);
        const state = !held ? "Reading…"
          : !mute ? "Everyone they speak to hears them."
          : `${mute.expires_at ? `Until ${dayAndTime(mute.expires_at)}` : "Until it is lifted"}, by ${shown(mute.muted_by)}.${mute.reason ? ` Reason: ${mute.reason}` : ""}`;
        this.row(chatState, !held ? "Mute" : mute ? "Muted" : "Not muted", state, unmute);
        if (held?.openReports) {
          const see = this.button("See reports", () => this.go("reports"), { icon: "shield", fk: "reports.see" });
          if (!this.can["query.reports"]) forbid(see, "You don't have permission to see reports.");
          this.row(chatState, "Reports", `${count(held.openReports, "open report")} ${held.openReports === 1 ? "names" : "name"} ${name}.`, see);
        }
      }

      account.replaceChildren();
      const admin = (wanted: boolean) => {
        const label = wanted ? "Make admin" : "Remove admin";
        const btn = this.button(label, (fk) => {
          const consequence = wanted
            ? `${name} gets the admin role and is reconnected so their game picks it up. Permissions are given separately.`
            : `${name} loses the admin role, along with noclip and stealth, and is reconnected.`;
          this.confirmThen(wanted ? `Make ${name} an admin?` : `Remove ${name}'s admin role?`, consequence, label, "player.admin", { target: who, admin: wanted }, { key: origin, fk });
        }, { action: "player.admin", kind: wanted ? undefined : "danger", fk: `player.admin:${wanted}:${who}` });
        if (self) forbid(btn, "That is you.");
        if (p.isAdmin === wanted) forbid(btn, wanted ? `${name} is already an admin.` : `${name} is not an admin.`);
        this.row(account, label, wanted ? "Give them the admin role." : "Take the admin role away from them.", btn);
      };
      admin(true);
      admin(false);
      this.renderPermissions(account, who, self);
    }, () => {
      const live = this.data!.players.find((p) => p.username === who);
      return JSON.stringify([live ? { ...live, onlineFor: live.onlineFor === null } : null, this.permissions, this.showPermissions, this.moderation, this.pending?.requestId ?? "", this.lost]);
    });
    // The time they have been online counts up without the buttons under it being built again.
    this.follow(() => {
      const seconds = this.data!.players.find((p) => p.username === who)?.onlineFor;
      const value = facts.querySelector<HTMLElement>("[data-time] .tl-fact-value");
      if (value && seconds !== null && seconds !== undefined) value.textContent = duration(seconds);
    });

    const muteForm = el("div", "tl-form tl-form-tight");
    this.field(muteForm, "Reason", this.textInput(this.drafts.muteReason, "Why, for the other admins", (value) => (this.drafts.muteReason = value), NOTE_MAX, "mute.reason"));
    this.field(muteForm, "For", this.choice(MUTE_LENGTHS, this.drafts.muteLength, (value) => (this.drafts.muteLength = value), "Until lifted"));
    chat.appendChild(muteForm);
    const mute = this.button("Mute", (fk) => {
      this.act("player.mute", { target: who, duration: this.drafts.muteLength, reason: this.drafts.muteReason.trim() }, { key: "players.chat", fk, done: () => (this.drafts.muteReason = "") });
    }, { action: "player.mute", fk: `player.mute:${who}` });
    if (self) forbid(mute, "That is you.");
    this.actions(chat, muteForm, mute);
    chat.appendChild(el("p", "tl-hint", "A muted player still sees their own messages and is not told. Nobody else receives them. Muting again replaces the mute they are under."));

    const form = el("div", "tl-form tl-form-tight");
    this.field(form, "Item", this.itemField(this.drafts.giveItem, "Type an item name", (value) => (this.drafts.giveItem = value), "give.item"));
    this.field(form, "Amount", this.numberInput(this.drafts.giveAmount, 1, 1000000, (value) => (this.drafts.giveAmount = value)));
    items.appendChild(form);
    this.actions(items, form, this.button("Give item", (fk) => {
      if (!this.drafts.giveItem.trim()) return this.fail("players.items", ["Pick an item to give first."]);
      this.act("player.give", { target: who, item: this.drafts.giveItem.trim(), quantity: this.drafts.giveAmount }, { key: "players.items", fk, done: () => (this.drafts.giveItem = "") });
    }, { action: "player.give", kind: "primary", fk: `player.give:${who}` }));
    items.appendChild(el("p", "tl-hint", "It goes straight into their inventory, online or not."));
  }

  private renderPermissions(parent: HTMLElement, who: string, self: boolean): void {
    const name = shown(who);
    const origin = "players.account";
    const toggle = this.button(this.showPermissions ? "Hide" : "Show", () => {
      this.showPermissions = !this.showPermissions;
      this.askPermissions();
      this.refresh(false);
    }, { icon: this.showPermissions ? "chevronUp" : "chevronDown", fk: "permissions.toggle" });
    if (!this.can["query.permissions"]) forbid(toggle, "You don't have permission to see permissions.");
    this.row(parent, "Permissions", "What they may do as an admin. You can only give out permissions you hold yourself.", toggle);
    if (!this.showPermissions || !this.can["query.permissions"]) return;

    const box = el("div", "cp-permissions");
    parent.appendChild(box);
    const held = this.permissions?.target === who ? this.permissions : null;
    if (!held) {
      box.appendChild(el("div", "tl-loading", `Reading ${name}'s permissions…`));
      return;
    }
    if (self) box.appendChild(el("p", "tl-hint", "This is you. Your own permissions are not yours to change."));

    const draft = this.drafts.held;
    const list = el("div", "cp-checks");
    // A permission the player holds is listed even if it is no longer a known type, so it can be taken away.
    const names = [...new Set([...held.types, ...held.held])];
    for (const permission of names) {
      const label = el("label", "cp-check");
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = draft.has(permission);
      tick.disabled = self;
      tick.addEventListener("change", () => {
        if (tick.checked) draft.add(permission);
        else draft.delete(permission);
      });
      label.append(tick, el("span", "", permission));
      list.appendChild(label);
    }
    if (names.length === 0) list.appendChild(el("div", "tl-loading", "No permissions are defined on this server."));
    box.appendChild(list);

    const save = this.button("Save ticked", (fk) => {
      const gained = [...draft].filter((p) => !held.held.includes(p));
      const lost = held.held.filter((p) => !draft.has(p));
      if (gained.length === 0 && lost.length === 0) return this.fail(origin, ["Nothing is ticked differently from what they hold now."]);
      if (draft.size === 0) return this.fail(origin, ["To take every permission away, use Clear all."]);
      const changes = [gained.length ? `gains ${listed(gained)}` : "", lost.length ? `loses ${listed(lost)}` : ""].filter(Boolean).join(" and ");
      this.confirmThen(`Save ${name}'s permissions?`, `${name} ${changes}, and it takes effect at once.`, "Save", "permission.set", { target: who, permissions: [...draft] }, { key: origin, fk });
    }, { action: "permission.set", fk: `permission.set:${who}` });
    const clear = this.button("Clear all", (fk) => {
      this.confirmThen(`Clear ${name}'s permissions?`, `${name} keeps the admin role but can no longer use any command that needs a permission.`, "Clear all", "permission.clear", { target: who }, { key: origin, fk });
    }, { action: "permission.clear", kind: "danger", fk: `permission.clear:${who}` });
    if (self) for (const control of [save, clear]) forbid(control, "That is you.");
    this.actions(box, null, save, clear);

    // /permission add and remove, one permission at a time.
    const one = this.choice(names, this.drafts.permission, (value) => (this.drafts.permission = value), "One permission");
    one.setAttribute("aria-label", "One permission to give or take away");
    const single = (label: string, action: string, title: (p: string) => string, consequence: (p: string) => string) => this.button(label, (fk) => {
      const permission = this.drafts.permission;
      if (!permission) return this.fail(origin, ["Pick the permission first."]);
      this.confirmThen(title(permission), consequence(permission), label, action, { target: who, permission }, { key: origin, fk });
    }, { action, fk: `${action}:${who}` });
    const give = single("Give", "permission.add", (p) => `Give ${name} ${p}?`, (p) => `${name} can use ${p} at once.`);
    const take = single("Take away", "permission.remove", (p) => `Take ${p} away from ${name}?`, (p) => `${name} loses ${p} at once.`);
    if (self) for (const control of [one, give, take]) forbid(control, "That is you.");
    const row = el("div", "tl-inline");
    row.append(one, give, take);
    box.appendChild(row);
  }

  // ----------------------------------------------------------------- reports

  /** Shows a player's details on the Players page. */
  private openPlayer(username: string): void {
    this.select(username);
    this.go("players");
  }

  private renderReports(root: HTMLElement): void {
    if (!this.can["query.reports"]) {
      empty(root, "lock", "Reports are for the admins who handle them", "Your account does not hold the admin.reports permission, so the server does not list them for you.");
      return;
    }
    const grid = el("div", "tl-grid");
    root.appendChild(grid);
    const open = this.card(grid, "Open reports", "Newest first. Resolve a report once it has been dealt with.", "reports.open");
    open.root.classList.add("tl-span-8");
    const done = this.card(grid, "Recently resolved", "The latest reports that were closed, and what was done.");
    done.root.classList.add("tl-span-4");

    const list = this.reportList;
    if (!list) {
      open.body.appendChild(el("div", "tl-loading", "Reading the reports…"));
      done.body.appendChild(el("div", "tl-loading", "Reading the reports…"));
      return;
    }

    titleCount(open.root, list.open.length);
    if (list.open.length === 0) {
      empty(open.body, "check", "No open reports", "When a player reports another, it is listed here, and the admins online who handle reports are told.");
    } else {
      const entries = el("div", "cp-reports");
      for (const report of list.open) entries.appendChild(this.reportEntry(report, list.open));
      open.body.appendChild(entries);
    }

    if (list.resolved.length === 0) {
      empty(done.body, "history", "Nothing resolved yet");
      return;
    }
    const closed = el("ol", "cp-acts");
    for (const report of list.resolved) {
      const item = el("li", "cp-act");
      const badge = el("span", "cp-act-icon");
      badge.appendChild(icon("check", 14));
      const line = el("div", "cp-act-line");
      line.append(el("strong", "", shown(report.target)), el("span", "cp-act-what", REPORT_CATEGORIES[report.category] ?? report.category));
      line.appendChild(el("span", "cp-act-detail", `resolved by ${shown(report.resolved_by ?? "")}`));
      const body = el("div", "cp-act-body");
      body.appendChild(line);
      if (report.resolution) body.appendChild(el("div", "cp-act-said", report.resolution));
      const at = report.resolved_at ?? report.created_at;
      const when = el("time", "cp-act-when", ago(at));
      when.dateTime = new Date(at).toISOString();
      when.title = new Date(at).toLocaleString();
      item.append(badge, body, when);
      closed.appendChild(item);
    }
    done.body.appendChild(closed);
  }

  /** One open report: who it names and why on a line, and everything about it when it is the one opened. */
  private reportEntry(report: Report, all: Report[]): HTMLElement {
    const opened = this.openReport === report.id;
    const target = shown(report.target);
    const reporter = shown(report.reporter);
    const entry = el("article", "cp-report" + (opened ? " is-open" : ""));

    const head = el("button", "cp-report-head");
    head.type = "button";
    head.dataset.fk = `report:${report.id}`;
    head.setAttribute("aria-expanded", String(opened));
    const when = el("time", "cp-report-when", ago(report.created_at));
    when.dateTime = new Date(report.created_at).toISOString();
    when.title = new Date(report.created_at).toLocaleString();
    head.append(
      icon(opened ? "chevronDown" : "chevronRight", 14),
      el("strong", "cp-report-target", target),
      tag(REPORT_CATEGORIES[report.category] ?? report.category, "warning"),
      el("span", "cp-report-by", `reported by ${reporter}`),
      when,
    );
    head.addEventListener("click", () => {
      this.openReport = opened ? 0 : report.id;
      this.drafts.resolveNote = "";
      this.renderPage();
    });
    entry.appendChild(head);
    if (!opened) return entry;

    const body = el("div", "cp-report-body");
    entry.appendChild(body);
    if (report.details) body.appendChild(el("blockquote", "cp-report-details", report.details));

    const place = (map: string | null, x: number | null, y: number | null, none: string) => (map ? `${map} (${num(x ?? 0)}, ${num(y ?? 0)})` : none);
    const facts = el("dl", "tl-facts");
    this.fact(facts, "Reported", dayAndTime(report.created_at));
    this.fact(facts, "Other open reports on them", num(all.filter((other) => other.target === report.target).length - 1));
    this.fact(facts, `Where ${target} was`, place(report.target_map, report.target_x, report.target_y, "Not online"));
    this.fact(facts, `Where ${reporter} was`, place(report.map, report.x, report.y, "Unknown"));
    body.appendChild(facts);

    const said = el("section", "tl-group");
    const heading = el("h3", "tl-group-title");
    heading.append(icon("megaphone", 14), el("span", "", `What ${target} said that reached ${reporter}`));
    said.appendChild(heading);
    if (report.chat_log.length === 0) {
      said.appendChild(el("p", "tl-hint", `Nothing ${target} said in the half hour before reached ${reporter}.`));
    } else {
      const lines = el("ol", "cp-report-lines");
      for (const line of report.chat_log) {
        const row = el("li", "cp-report-line");
        const at = el("time", "cp-report-line-at", clock(line.at, true));
        at.dateTime = new Date(line.at).toISOString();
        row.append(at, tag(line.channel, "muted"), el("span", "cp-report-line-text", line.text));
        lines.appendChild(row);
      }
      said.appendChild(lines);
    }
    body.appendChild(said);

    // What can be done about it: the same commands as on the Players page, on the player reported.
    const origin = "reports.open";
    const live = this.data!.players.find((p) => p.username === report.target);
    const p = { username: report.target, isAdmin: live?.isAdmin, online: !!live };
    const acts = el("section", "tl-group");
    const actsTitle = el("h3", "tl-group-title");
    actsTitle.append(icon("shield", 14), el("span", "", `Act on ${target}`));
    const rows = el("div", "tl-rows");
    acts.append(actsTitle, rows);
    const length = this.choice(MUTE_LENGTHS, this.drafts.muteLength, (value) => (this.drafts.muteLength = value), "Until lifted");
    length.setAttribute("aria-label", "How long the mute lasts");
    const mute = this.button("Mute", (fk) => {
      this.act("player.mute", { target: report.target, duration: this.drafts.muteLength, reason: `Report #${report.id}` }, { key: origin, fk });
    }, { action: "player.mute", fk: `player.mute:report:${report.id}` });
    this.row(rows, "Mute", "Nobody else receives what they say. They are not told.", length, mute);
    for (const action of ["player.kick", "player.ban"]) this.row(rows, PLAYER_ACTIONS[action].label, PLAYER_ACTIONS[action].note, this.playerButton(action, p, origin));
    this.row(rows, "Details", "Their account, permissions and items, on the Players page.", this.button("Open in Players", () => this.openPlayer(report.target), { icon: "user", fk: `report.player:${report.id}` }));
    body.appendChild(acts);

    const close = el("section", "tl-group");
    const closeTitle = el("h3", "tl-group-title");
    closeTitle.append(icon("check", 14), el("span", "", "Resolve"));
    const line = el("div", "tl-inline");
    const note = this.textInput(this.drafts.resolveNote, "What was done, for the other admins", (value) => (this.drafts.resolveNote = value), NOTE_MAX, `report.note:${report.id}`);
    note.setAttribute("aria-label", "What was done about the report");
    const resolve = this.button("Resolve", (fk) => {
      this.act("report.resolve", { id: report.id, note: this.drafts.resolveNote.trim() }, {
        key: origin, fk,
        done: () => {
          this.drafts.resolveNote = "";
          this.openReport = 0;
        },
      });
    }, { action: "report.resolve", kind: "primary", fk: `report.resolve:${report.id}` });
    line.append(note, resolve);
    close.append(closeTitle, line);
    body.appendChild(close);
    return entry;
  }

  // ----------------------------------------------------------- communication

  private renderCommunication(root: HTMLElement): void {
    const { viewer, players } = this.data!;
    const grid = el("div", "tl-grid");
    root.appendChild(grid);
    const origin = "communication.send";
    const send = this.card(grid, "Send a message", "It appears as a notification on the screen of everyone it is sent to.", origin);
    send.root.classList.add("tl-span-7");

    const here = players.filter((p) => p.map === viewer.map);
    const reach: Record<string, string> = {
      ALL: count(players.length, "player"),
      MAP: `${count(here.length, "player")} on ${viewer.map}`,
      ADMINS: `${count(here.filter((p) => p.isAdmin).length, "admin")} on ${viewer.map}`,
    };
    const who = el("div", "tl-options");
    who.setAttribute("role", "radiogroup");
    who.setAttribute("aria-label", "Who the message is for");
    for (const [audience, label] of AUDIENCES) {
      const option = el("button", "tl-option");
      option.type = "button";
      option.dataset.fk = `audience:${audience}`;
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(this.drafts.audience === audience));
      option.append(el("span", "tl-option-mark"), el("span", "tl-option-title", label), el("span", "tl-option-note", reach[audience]));
      option.addEventListener("click", () => {
        this.drafts.audience = audience;
        this.renderPage();
      });
      who.appendChild(option);
    }
    arrowKeys(who);
    const whoField = el("div", "tl-field");
    whoField.append(el("span", "tl-field-label", "Who it is for"), who);
    send.body.appendChild(whoField);

    const message = el("textarea", "tl-input tl-textarea");
    message.value = this.drafts.broadcast;
    message.placeholder = "Type your message";
    message.maxLength = BROADCAST_MAX;
    message.rows = 4;
    message.dataset.fk = "broadcast.message";
    const left = el("span", "tl-field-hint");
    const counted = () => (left.textContent = `${num(message.value.length)} of ${num(BROADCAST_MAX)} characters`);
    message.addEventListener("input", () => {
      this.drafts.broadcast = message.value;
      counted();
    });
    counted();
    const field = this.field(send.body, "Message", message);
    field.appendChild(left);

    const button = this.button("Send message", (fk) => {
      const text = this.drafts.broadcast.trim();
      if (!text) return this.fail(origin, ["Type a message first."]);
      this.act("server.broadcast", { audience: this.drafts.audience, message: text }, { key: origin, fk, done: () => (this.drafts.broadcast = "") });
    }, { action: "server.broadcast", kind: "primary", icon: "send" });
    this.actions(send.body, send.body, button);

    const sent = this.card(grid, "Recent messages", "Messages sent through this panel since the server started.");
    sent.root.classList.add("tl-span-5", "cp-activity");
    sent.body.dataset.scroll = "messages";
    this.follow(() => {
      sent.body.replaceChildren();
      const messages = this.activity.filter((entry) => entry.action === "server.broadcast").reverse();
      if (messages.length === 0) {
        empty(sent.body, "megaphone", "No messages yet", "Messages are listed here once they are sent.");
        return;
      }
      const list = el("ol", "cp-acts");
      for (const entry of messages) {
        const item = el("li", "cp-act cp-message");
        const badge = el("span", "cp-act-icon");
        badge.appendChild(icon("megaphone", 14));
        const body = el("div", "cp-act-body");
        const text = String(entry.details.message ?? "");
        body.appendChild(el("div", "cp-message-text", text.length >= 160 ? `${text}…` : text));
        const audience = AUDIENCES.find(([key]) => key === String(entry.details.audience ?? "").toUpperCase())?.[2] ?? "players";
        const line = el("div", "cp-act-said");
        line.append(el("strong", "", shown(entry.by)), document.createTextNode(` to ${audience}`));
        body.appendChild(line);
        const when = el("time", "cp-act-when", ago(entry.at));
        when.dateTime = new Date(entry.at).toISOString();
        when.title = new Date(entry.at).toLocaleString();
        item.append(badge, body, when);
        list.appendChild(item);
      }
      sent.body.appendChild(list);
    }, () => `${this.activity.length ? this.activity[this.activity.length - 1].seq : 0}:${Math.floor(Date.now() / 30000)}`);
  }

  // ------------------------------------------------------------------ server

  private renderServer(root: HTMLElement): void {
    const grid = el("div", "tl-grid");
    root.appendChild(grid);

    const status = this.card(grid, "Status", "How the server process is doing right now.");
    status.root.classList.add("tl-span-6");
    const statusFacts = el("dl", "tl-facts tl-facts-grid");
    status.body.appendChild(statusFacts);
    this.follow(() => {
      const s = this.data!.status;
      statusFacts.replaceChildren();
      const health = this.lagState(s.eventLoopLagMs);
      this.fact(statusFacts, "State", tag(health.level === "good" ? "Keeping up" : health.label, health.level, health.level === "good" ? "check" : "alert"));
      this.fact(statusFacts, "Running for", duration(s.uptime));
      this.fact(statusFacts, "Started", dayAndTime(Date.now() - s.uptime * 1000));
      this.fact(statusFacts, "Players online", num(s.online), `Peak ${num(s.peak.online)}`);
      this.fact(statusFacts, "Memory in use", memory(s.memoryMb));
      // The server's own measure of how late its work is running, averaged over the last second or so.
      this.fact(statusFacts, "Server lag", s.eventLoopLagMs === null ? "Unknown" : `${num(s.eventLoopLagMs)} ms`, "How late its work is running");
    });

    const creatures = this.card(grid, "Creatures", "How much of the world is awake, and what each round of moving it costs.");
    creatures.root.classList.add("tl-span-6");
    this.follow(() => {
      const c = this.data!.status.creatures;
      creatures.body.replaceChildren();
      if (!c) return void empty(creatures.body, "paw", "No creature figures yet");
      const facts = el("dl", "tl-facts tl-facts-grid");
      this.fact(facts, "Creatures", num(Number(c.creatures) || 0));
      this.fact(facts, "Awake", num(Number(c.awake) || 0));
      this.fact(facts, "In combat", num(Number(c.inCombat) || 0));
      this.fact(facts, "Maps with creatures", num(Number(c.maps) || 0));
      if (c.tick) {
        this.fact(facts, "Typical round", `${short(Number(c.tick.p50))} ms`);
        this.fact(facts, "Slow round", `${short(Number(c.tick.p95))} ms`, "1 in 20 takes this long");
        this.fact(facts, "Slowest round", `${short(Number(c.tick.max))} ms`);
      }
      creatures.body.appendChild(facts);
      if (c.tick) {
        const share = Number(c.tick.budgetPctP95) || 0;
        const used = el("div", "cp-meter-row");
        const words = el("div", "cp-meter-words");
        words.append(el("span", "tl-fact-label", "Share of each round's time used"), el("span", "cp-meter-value", `${short(share)}%`));
        used.append(words, meter(share, "Share of each round's time used"));
        creatures.body.appendChild(used);
      }
    });

    const origin = "server.whitelist";
    // The switch is kept by the running server only, so the card says where it comes from after a restart.
    const whitelist = this.card(grid, "Whitelist", "Who may log in to this realm while the whitelist is on. The switch lasts until the server restarts: the WHITELIST setting decides how it starts.", origin);
    whitelist.root.classList.add("tl-span-6");
    this.follow(() => {
      const wl = this.data!.status.whitelist;
      whitelist.tools.replaceChildren(tag(wl.enabled ? `On · ${count(wl.size, "name")}` : "Off", wl.enabled ? "good" : "muted"));
    }, () => JSON.stringify(this.data!.status.whitelist));
    // Drawn again when it is switched (here, by another admin or with /whitelist), not while a username is being typed.
    this.follow(() => {
      const wl = this.data!.status.whitelist;
      whitelist.body.replaceChildren();
      const rows = el("div", "tl-rows");
      whitelist.body.appendChild(rows);
      const action = wl.enabled ? "server.whitelist.off" : "server.whitelist.on";
      const switchKey = "server.whitelist.switch";
      const toggle = el("button", "tl-switch");
      toggle.type = "button";
      toggle.dataset.fk = switchKey;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(wl.enabled));
      toggle.setAttribute("aria-label", "Whitelist");
      toggle.appendChild(el("span", "tl-switch-knob"));
      toggle.addEventListener("click", () => this.act(action, {}, { key: origin, fk: switchKey }));
      if (!this.can[action]) forbid(toggle, NOT_ALLOWED);
      else if (this.lost) forbid(toggle, NOT_ANSWERING);
      if (this.pending?.origin.fk === switchKey) this.busy(toggle);
      this.row(rows, `The whitelist is ${wl.enabled ? "on" : "off"}`, wl.enabled
        ? "Only the names on it can log in. Players who were already online stay."
        : "Anyone can log in. Turning it on puts you on the list and checks new logins; players already online stay.", toggle);

      const username = this.textInput(this.drafts.whitelist, "Username", (value) => (this.drafts.whitelist = value), 64, "whitelist.name");
      const form = el("div", "tl-form cp-whitelist-form");
      this.field(form, "Player", username);
      whitelist.body.appendChild(form);
      const change = (mode: "add" | "remove", label: string) => this.button(label, (fk) => {
        const target = this.drafts.whitelist.trim();
        if (!target) return this.fail(origin, ["Type a username first."]);
        this.act(`server.whitelist.${mode}`, { target }, { key: origin, fk, done: () => (this.drafts.whitelist = "") });
      }, { action: `server.whitelist.${mode}`, kind: mode === "add" ? "primary" : undefined });
      const controls = [change("add", "Add to whitelist"), change("remove", "Remove from whitelist")];
      if (!wl.enabled) for (const control of [username, ...controls]) forbid(control, "The whitelist is not turned on for this realm.");
      this.actions(whitelist.body, form, ...controls);
    }, () => `${this.data!.status.whitelist.enabled}:${this.pending?.requestId ?? ""}:${this.lost}`);

    const restartKey = "server.restart";
    // What happens after the server stops is up to whatever runs it, so the page says both cases.
    const restart = this.card(grid, "Restart", "Players get a 15 minute countdown, then everyone is disconnected and the server stops. Under Docker it is started again at once; started by hand, it stays down until someone starts it.", restartKey);
    restart.root.classList.add("tl-span-6");
    const restartRows = el("div", "tl-rows");
    restart.body.appendChild(restartRows);
    this.follow(() => {
      restartRows.replaceChildren();
      const scheduled = this.data!.status.restartScheduled;
      const schedule = this.button("Schedule restart", (fk) => {
        this.confirmThen("Schedule a server restart?", "Every player on this server sees a 15 minute countdown and is disconnected when it ends. The server then stops: under Docker it is started again at once, and if it was started by hand it stays down until someone starts it. You can cancel the restart until the countdown ends.", "Schedule restart", "server.restart", {}, { key: restartKey, fk });
      }, { action: "server.restart", kind: "danger", icon: "restart" });
      const cancel = this.button("Cancel restart", (fk) => this.act("server.restart.cancel", {}, { key: restartKey, fk }), { action: "server.restart.cancel" });
      if (scheduled) forbid(schedule, "A restart is already scheduled.");
      else forbid(cancel, "No restart is scheduled.");
      this.row(restartRows, scheduled ? "A restart is scheduled" : "No restart is scheduled", scheduled ? "Players are seeing the countdown. The server stops when it ends." : "The server keeps running until one is scheduled.", scheduled ? cancel : schedule);
    }, () => `${this.data!.status.restartScheduled}:${this.pending?.requestId ?? ""}:${this.lost}`);

    const dangerKey = "server.shutdown";
    const danger = this.card(grid, "Shut down", "Stops the server for everyone. Under Docker it is started again at once; started by hand, it stays down until someone starts it.", dangerKey);
    danger.root.classList.add("tl-span-12", "tl-card-danger");
    const rows = el("div", "tl-rows");
    danger.body.appendChild(rows);
    this.row(rows, "Disconnect everyone and stop the server", "Players are warned, and 5 seconds later everyone is disconnected, you included, and the server stops.",
      this.button("Shut down", (fk) => {
        this.confirmThen("Shut the server down now?", "Every player on this server is warned and disconnected 5 seconds later, you included, and the server stops. Under Docker it is started again at once; if it was started by hand it stays down until someone starts it. This cannot be cancelled.", "Shut down", "server.shutdown", {}, { key: dangerKey, fk });
      }, { action: "server.shutdown", kind: "danger", icon: "power" }));
  }

  // ------------------------------------------------------------------- world

  private renderWorld(root: HTMLElement): void {
    const { viewer } = this.data!;
    const { maps, weathers } = this.options;
    if (!this.drafts.reload) this.drafts.reload = viewer.map;
    const grid = el("div", "tl-grid");
    root.appendChild(grid);

    const worlds = this.card(grid, "Worlds", "Every world, the weather it is showing, and how many players are in it.");
    worlds.root.classList.add("tl-span-7", "tl-card-flush");
    const table = el("table", "tl-table tl-table-plain");
    const head = el("thead");
    const headRow = el("tr");
    for (const [title, className] of [["World", ""], ["Weather", ""], ["Players", "tl-num"]]) {
      const th = el("th", className, title);
      th.scope = "col";
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = el("tbody");
    table.append(head, body);
    worlds.body.appendChild(table);
    this.follow(() => {
      body.replaceChildren();
      for (const w of this.data!.world.worlds) {
        const row = el("tr");
        const name = el("td", "cp-cell-player");
        name.appendChild(el("span", "cp-player-name", w.name));
        if (w.name === this.data!.viewer.map) name.appendChild(tag("You are here", "you", "pin"));
        row.appendChild(name);
        const weather = el("td");
        weather.appendChild(el("span", "", w.showing));
        if (w.weather !== w.showing) weather.appendChild(el("span", "tl-muted", ` · set to ${w.weather}`));
        row.appendChild(weather);
        row.appendChild(el("td", "tl-num", num(w.players)));
        body.appendChild(row);
      }
      if (this.data!.world.worlds.length === 0) {
        const row = el("tr", "tl-table-empty");
        const td = el("td");
        td.colSpan = 3;
        empty(td, "globe", "No worlds are set up");
        row.appendChild(td);
        body.appendChild(row);
      }
    }, () => JSON.stringify([this.data!.world.worlds, this.data!.viewer.map]));

    const side = el("div", "tl-stack tl-span-5");
    grid.appendChild(side);

    const weatherKey = "world.weather";
    const weather = this.card(side, "Weather", `Changes the weather of the map you are on, ${viewer.map}.`, weatherKey);
    const weatherForm = el("div", "tl-form");
    const now = el("span", "tl-field-hint");
    const weatherField = this.field(weatherForm, "Weather", this.choice(weathers, this.drafts.weather, (value) => (this.drafts.weather = value), "Pick a weather"));
    weatherField.appendChild(now);
    weather.body.appendChild(weatherForm);
    this.follow(() => {
      const w = this.data!.world;
      now.textContent = `Showing ${w.showing} now${w.weather === w.showing ? "" : `, set to ${w.weather}`}. With “random”, the server picks one.`;
    });
    this.actions(weather.body, weatherForm, this.button("Change weather", (fk) => {
      if (!this.drafts.weather) return this.fail(weatherKey, ["Pick a weather first."]);
      this.act("world.weather", { weather: this.drafts.weather }, { key: weatherKey, fk });
    }, { action: "world.weather", kind: "primary", icon: "cloud" }));

    const reloadKey = "world.reload";
    const reload = this.card(side, "Reload a map", "Reads the map again and sends it to everyone on it.", reloadKey);
    const reloadForm = el("div", "tl-form");
    this.field(reloadForm, "Map", this.choice(maps, this.drafts.reload, (value) => (this.drafts.reload = value), "Pick a map"));
    reload.body.appendChild(reloadForm);
    this.actions(reload.body, reloadForm, this.button("Reload map", (fk) => {
      if (!this.drafts.reload) return this.fail(reloadKey, ["Pick a map first."]);
      this.act("world.reloadmap", { map: this.drafts.reload }, { key: reloadKey, fk });
    }, { action: "world.reloadmap", icon: "refresh" }));

    const youKey = "world.you";
    const you = this.card(grid, "Your character", "Where you are in the world, and how you move through it as an admin.", youKey);
    you.root.classList.add("tl-span-12");
    const rows = el("div", "tl-rows tl-rows-split");
    you.body.appendChild(rows);
    const warp = this.choice(maps.filter((m) => m !== viewer.map), this.drafts.warp, (value) => (this.drafts.warp = value), "Pick a map");
    warp.setAttribute("aria-label", "Map to warp to");
    const go = this.button("Warp", (fk) => {
      if (!this.drafts.warp) return this.fail(youKey, ["Pick a map to warp to first."]);
      this.act("world.warp", { map: this.drafts.warp }, { key: youKey, fk, done: () => (this.drafts.warp = "") });
    }, { action: "world.warp", kind: "primary", icon: "pin" });
    if (go.disabled) forbid(warp, go.dataset.why!);
    this.row(rows, "Warp to another map", `You are on ${viewer.map}. Warping puts you in the middle of the map you pick.`, warp, go);
    const switches = el("div", "tl-switch-rows");
    rows.appendChild(switches);
    this.follow(() => {
      const v = this.data!.viewer;
      switches.replaceChildren();
      const flip = (label: string, note: string, on: boolean, action: string) => {
        const toggle = el("button", "tl-switch");
        toggle.type = "button";
        toggle.dataset.fk = action;
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-checked", String(on));
        toggle.setAttribute("aria-label", label);
        toggle.appendChild(el("span", "tl-switch-knob"));
        toggle.addEventListener("click", () => this.act(action, { enabled: !on }, { key: youKey, fk: action }));
        if (!this.can[action]) forbid(toggle, NOT_ALLOWED);
        else if (this.lost) forbid(toggle, NOT_ANSWERING);
        if (this.pending?.origin.fk === action) this.busy(toggle);
        this.row(switches, `${label} is ${on ? "on" : "off"}`, note, toggle);
      };
      flip("Noclip", "Walk through anything that would stop you.", v.isNoclip, "self.noclip");
      flip("Stealth", "Players who are not admins cannot see you.", v.isStealth, "self.stealth");
    }, () => JSON.stringify([this.data!.viewer, this.pending?.requestId ?? "", this.lost]));
  }

  // ------------------------------------------------------------------- items

  private renderItems(root: HTMLElement): void {
    const grid = el("div", "tl-grid");
    root.appendChild(grid);
    const tables = this.lootTables;
    if (tables === null && this.can["query.lootTables"]) this.request("CONTROL_PANEL_QUERY", { kind: "lootTables" });

    const dropKey = "items.drop";
    const drop = this.card(grid, "Drop an item", "It falls on the ground where you are standing.", dropKey);
    drop.root.classList.add("tl-span-5");
    const dropForm = el("div", "tl-form tl-form-tight");
    this.field(dropForm, "Item", this.itemField(this.drafts.dropItem, "Type an item name", (value) => (this.drafts.dropItem = value), "drop.item"));
    this.field(dropForm, "Amount", this.numberInput(this.drafts.dropAmount, 1, 9999, (value) => (this.drafts.dropAmount = value)));
    drop.body.appendChild(dropForm);
    this.actions(drop.body, dropForm, this.button("Drop item", (fk) => {
      if (!this.drafts.dropItem.trim()) return this.fail(dropKey, ["Pick an item to drop first."]);
      this.act("item.drop", { item: this.drafts.dropItem.trim(), quantity: this.drafts.dropAmount }, { key: dropKey, fk });
    }, { action: "item.drop", kind: "primary" }));

    const chestKey = "items.chest";
    const chest = this.card(grid, "Spawn a chest", "It appears where you are standing, for any player to open.", chestKey);
    chest.root.classList.add("tl-span-7");
    chest.tools.appendChild(segments<"table" | "items">([["table", "From a loot table"], ["items", "With chosen items"]], this.drafts.chestMode, (mode) => {
      this.drafts.chestMode = mode;
      this.renderPage();
    }, "What the chest holds"));
    if (this.drafts.chestMode === "table") {
      const options = (tables || []).map((t) => [String(t.id), t.name] as [string, string]);
      const pick = this.choice(options, String(this.drafts.chestTable || ""), (value) => (this.drafts.chestTable = Number(value)), tables === null && this.can["query.lootTables"] ? "Reading the loot tables…" : "Pick a loot table");
      const form = el("div", "tl-form");
      this.field(form, "Loot table", pick, this.can["query.lootTables"] ? "The chest rolls what it holds from the table when it is opened." : "You don't have permission to see the loot tables.");
      chest.body.appendChild(form);
      this.actions(chest.body, form, this.button("Spawn chest", (fk) => {
        if (!this.drafts.chestTable) return this.fail(chestKey, ["Pick a loot table first."]);
        this.act("chest.spawn", { table: this.drafts.chestTable }, { key: chestKey, fk });
      }, { action: "chest.spawn", kind: "primary" }));
    } else {
      const list = el("div", "cp-lootrows");
      list.appendChild(this.lootHead(false));
      this.drafts.chest.forEach((entry, index) => {
        const line = el("div", "cp-lootrow");
        line.appendChild(this.itemField(entry.item, "Item name", (value) => (entry.item = value), `chest.item.${index}`));
        this.lootNumbers(line, entry);
        const remove = el("button", "tl-icon-btn");
        remove.type = "button";
        remove.title = "Remove this row";
        remove.setAttribute("aria-label", "Remove this row");
        remove.appendChild(icon("close", 14));
        remove.addEventListener("click", () => {
          this.drafts.chest.splice(index, 1);
          if (this.drafts.chest.length === 0) this.drafts.chest.push({ item: "", min: 1, max: 1, chance: 100 });
          this.renderPage();
        });
        line.appendChild(remove);
        list.appendChild(line);
      });
      chest.body.appendChild(list);
      this.actions(chest.body, list,
        this.button("Spawn chest", (fk) => {
          if (this.drafts.chest.some((entry) => !entry.item.trim())) return this.fail(chestKey, ["Every row needs an item."]);
          this.act("chest.spawn", { entries: this.drafts.chest.map((e) => ({ ...e, item: e.item.trim() })) }, { key: chestKey, fk });
        }, { action: "chest.spawn", kind: "primary" }),
        this.button("Add a row", () => {
          this.drafts.chest.push({ item: "", min: 1, max: 1, chance: 100 });
          this.renderPage();
        }, { icon: "plus" }));
    }

    this.renderLootTables(grid, tables);
  }

  /** The headings over the rows of a chest or a loot table. */
  private lootHead(quality: boolean): HTMLElement {
    const head = el("div", "cp-lootrow cp-lootrow-head");
    head.setAttribute("aria-hidden", "true");
    head.append(el("span", "cp-lootrow-item", "Item"), el("span", "cp-loot-num", "Fewest"), el("span", "cp-loot-num", "Most"), el("span", "cp-loot-num", "Chance %"));
    if (quality) head.appendChild(el("span", "cp-loot-quality", "Quality"));
    head.appendChild(el("span", "cp-lootrow-end"));
    return head;
  }

  /** The smallest amount, largest amount and chance of one loot row. */
  private lootNumbers(parent: HTMLElement, entry: { min: number; max: number; chance: number }): void {
    const part = (title: string, input: HTMLInputElement) => {
      input.title = title;
      input.setAttribute("aria-label", title);
      input.classList.add("cp-loot-num");
      parent.appendChild(input);
    };
    part("Smallest amount", this.numberInput(entry.min, 1, 9999, (value) => (entry.min = value)));
    part("Largest amount", this.numberInput(entry.max, 1, 9999, (value) => (entry.max = value)));
    part("Chance to drop, in percent", this.numberInput(entry.chance, 0, 100, (value) => (entry.chance = value), 0.01));
  }

  private renderLootTables(parent: HTMLElement, tables: LootTable[] | null): void {
    const origin = "items.loot";
    const card = this.card(parent, "Loot tables", "What chests and creatures roll their drops from.", origin);
    card.root.classList.add("tl-span-12");
    if (!this.can["query.lootTables"]) return void empty(card.body, "lock", "You don't have permission to manage loot tables");
    if (tables === null) return void card.body.appendChild(el("div", "tl-loading", "Reading the loot tables…"));

    const name = this.textInput(this.drafts.tableName, "Name of a new loot table", (value) => (this.drafts.tableName = value), 64, "loot.name");
    name.setAttribute("aria-label", "Name of a new loot table");
    const create = this.button("Create table", (fk) => {
      const wanted = this.drafts.tableName.trim();
      if (!wanted) return this.fail(origin, ["Give the loot table a name first."]);
      this.act("loot.create", { name: wanted }, { key: origin, fk, done: () => (this.drafts.tableName = "") });
    }, { action: "loot.create", icon: "plus" });
    const make = el("div", "tl-inline cp-loot-new");
    make.append(name, create);
    card.tools.appendChild(make);

    if (tables.length === 0) return void empty(card.body, "box", "There are no loot tables yet", "Create one with the field above, then add items to it.");
    const list = el("div", "tl-subcards");
    card.body.appendChild(list);
    for (const table of tables) {
      const open = this.openTable === table.id;
      const rows = count(table.items.length, "row");
      // A table folds down to its name; one is open at a time.
      const item = subcard({
        title: table.name, lead: rows, open,
        onToggle: () => {
          this.openTable = open ? 0 : table.id;
          this.renderPage();
        },
      });
      item.fold!.dataset.fk = `loot.open:${table.id}`;
      item.tools.appendChild(this.button("Delete", (fk) => {
        // The question the loot table editor asks, in its words.
        const gone = table.items.length ? `The table and its ${rows} are removed for good.` : "The table is removed for good.";
        this.confirmThen(`Delete ${table.name}?`, `${gone} Creatures and chests that roll their drops from it stop dropping these items.`, "Delete loot table", "loot.delete", { id: table.id }, { key: origin, fk });
      }, { action: "loot.delete", kind: "quiet-danger", icon: "trash", fk: `loot.delete:${table.id}` }));
      list.appendChild(item.root);
      if (!open) continue;

      const body = el("div", "cp-lootrows cp-lootrows-quality");
      body.appendChild(this.lootHead(true));
      if (table.items.length === 0) body.appendChild(el("div", "tl-loading", "This table has no rows yet. Add its first item below."));
      for (const row of table.items) {
        const entry = { min: Number(row.min_quantity) || 1, max: Number(row.max_quantity) || 1, chance: Number(row.drop_chance) || 0, quality: row.quality || "common" };
        const line = el("div", "cp-lootrow");
        const label = el("span", "cp-lootrow-item");
        label.append(el("span", `tl-quality tl-quality-${QUALITIES.includes(entry.quality) ? entry.quality : "common"}`), el("span", "", row.item_name));
        line.appendChild(label);
        this.lootNumbers(line, entry);
        line.appendChild(this.qualityChoice(entry));
        const end = el("span", "cp-lootrow-end");
        end.appendChild(this.button("Save", (fk) => this.act("loot.updateitem", { itemId: row.id, ...entry }, { key: origin, fk }), { action: "loot.updateitem", fk: `loot.updateitem:${row.id}` }));
        const remove = this.button("Remove", (fk) => this.act("loot.removeitem", { itemId: row.id }, { key: origin, fk }), { action: "loot.removeitem", kind: "quiet", fk: `loot.removeitem:${row.id}` });
        if (!remove.disabled) remove.title = `Remove ${row.item_name} from the table`;
        end.appendChild(remove);
        line.appendChild(end);
        body.appendChild(line);
      }
      const adding = this.drafts.row;
      const line = el("div", "cp-lootrow cp-lootrow-new");
      line.appendChild(this.itemField(adding.item, "Add an item", (value) => (adding.item = value), `loot.add.${table.id}`));
      this.lootNumbers(line, adding);
      line.appendChild(this.qualityChoice(adding));
      const end = el("span", "cp-lootrow-end");
      end.appendChild(this.button("Add row", (fk) => {
        if (!adding.item.trim()) return this.fail(origin, ["Pick an item to add first."]);
        this.act("loot.additem", { id: table.id, ...adding, item: adding.item.trim() }, { key: origin, fk, done: () => (adding.item = "") });
      }, { action: "loot.additem", kind: "primary", icon: "plus", fk: `loot.additem:${table.id}` }));
      line.appendChild(end);
      body.appendChild(line);
      item.body.appendChild(body);
    }
  }

  private qualityChoice(entry: { quality: string }): HTMLSelectElement {
    const options = QUALITIES.includes(entry.quality) ? QUALITIES : [...QUALITIES, entry.quality];
    const select = this.choice(options.map((q) => [q, shown(q)] as [string, string]), entry.quality, (value) => (entry.quality = value));
    select.title = "Quality";
    select.setAttribute("aria-label", "Quality");
    select.classList.add("cp-loot-quality");
    return select;
  }
}

new ControlPanel();
