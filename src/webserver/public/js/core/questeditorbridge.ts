// Quest editor popup. Talks to the game window over postMessage; the game
// window forwards everything to the server, which validates and persists.
// The window itself is the shared workbench (tooleditor.ts); this file holds
// what is the quest editor's own: its fields, the objectives and the item
// rewards of a quest as lists of cards, the quest said in plain words as a
// player meets it, and its conversation with the server. Quests are edited by
// search: the editor never holds the whole quest table.
import { EditorShell, type ListRow, type RecordState } from "./tooleditor.js";
import { coins, FieldRenderer, setFieldError, type AssetOption, type Field } from "./toolfields.js";
import { button, card, count, el, empty, icon, iconButton, listed, noticeDialog, num, shown, tag, thumb, toast, words, type IconName } from "./toolkit.js";
import { manyField, type Choice } from "./questnpcparts.js";

const TABS = [
  { id: "general", label: "General" },
  { id: "texts", label: "Texts" },
  { id: "objectives", label: "Objectives" },
  { id: "rewards", label: "Rewards" },
];
const TAB_TITLES: Record<string, string> = { general: "General", texts: "Texts", objectives: "Objectives", rewards: "Rewards" };

/** What the server offers when it has not said: the kinds of objective, and how often a quest can be done. */
const OBJECTIVE_TYPES = ["kill", "collect", "talk", "explore"];
const REPEATABLE_VALUES = ["none", "repeatable", "daily"];
const REPEATABLE_WORDS: Record<string, string> = { none: "Not repeatable", repeatable: "Repeatable", daily: "Daily" };
/** What each kind of objective points at, and the icon that stands for it. */
const TARGETS: Record<string, { label: string; icon: IconName }> = {
  kill: { label: "Creature to kill", icon: "sword" },
  collect: { label: "Item to collect", icon: "bag" },
  talk: { label: "NPC to talk to", icon: "user" },
  explore: { label: "Map to reach", icon: "map" },
};
/** How many matches the item field lists under itself. */
const SUGGEST_LIMIT = 40;

const lower = (s: unknown): string => String(s ?? "").toLowerCase();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const filled = (value: unknown): boolean => value !== null && value !== undefined && value !== "";
/** The ids in a list, as numbers. */
const idList = (list: unknown): number[] => (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n));
/** "a", "a or b", "a, b or c". */
const either = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);

/** A problem the server found: its own line, the field it is about when that can be told, and the words shown under that field. */
interface Problem {
  line: string;
  path: string | null;
  said: string;
}

/**
 * The server reports what is wrong with a quest as lines of text ("Objective
 * 2: target is required."). Each is shown as it is; this works out which
 * field a line is about, so the field can be marked and its tab can say how
 * many problems it has. A line it does not know stays in the summary only.
 */
function placeOf(line: string): Problem {
  const part = /^(Objective|Reward) (\d+): (.*)$/.exec(line);
  if (part) {
    const [, kind, number, rest] = part;
    const at = `${kind === "Objective" ? "objectives" : "rewards"}.${Number(number) - 1}`;
    const key =
      kind === "Objective"
        ? /^type\b/.test(rest) ? "type" : /required count/.test(rest) ? "required_count" : /radius/.test(rest) ? "target_radius" : /target/.test(rest) ? "target" : null
        : /quantity/.test(rest) ? "quantity" : /item/.test(rest) ? "item_name" : null;
    return { line, path: key ? `${at}.${key}` : at, said: rest.charAt(0).toUpperCase() + rest.slice(1) };
  }
  const path =
    /^Name\b/.test(line) ? "name"
    : /^Required level\b/.test(line) ? "required_level"
    : /^Repeatable\b/.test(line) ? "repeatable"
    : /^Next quest\b|chain into itself/.test(line) ? "next_quest_id"
    : /^Prerequisite|cannot require itself/.test(line) ? "prerequisites"
    : /\bin givers\b|^Quests given\b/.test(line) ? "givers"
    : /\bin enders\b|^Quests ended\b/.test(line) ? "enders"
    : null;
  return { line, path, said: line };
}

/** A request the server has been sent and has not answered yet. */
interface Asked {
  kind: "save" | "delete";
  /** The quest it is about; null for one that has never been saved. */
  id: number | null;
  name: string;
  /** A save of a quest that was not there before. */
  adds: boolean;
  /** Which opening of a record it was sent from, and how much had been changed in it by then. */
  opened: number;
  edits: number;
}

let comboIds = 0;

class QuestEditorBridge {
  private data: any = { objectiveTypes: [], repeatableValues: [], creatures: [], items: [], npcs: [], maps: [], questCount: 0, quests: [] };
  /** The server's first answer has arrived. */
  private ready = false;
  private tab = "general";
  /** Id of the quest being edited, or null for a new one. */
  private editingId: number | null = null;
  private draft: any = null;
  /** Counts the records opened, so the page knows a redraw from a different record. */
  private opened = 0;
  /** Counts the changes made, so a save knows whether more was changed while it was on its way. */
  private edits = 0;
  /** Last search results; the editor never holds the whole quest table. */
  private results: any[] = [];
  private truncated = 0;
  private searched = false;
  private dirty = false;
  /** The last save was refused and nothing has been changed since. */
  private refused = false;
  /** What the server found wrong at the last save, less what has been changed since. */
  private problems: Problem[] = [];
  /** The problems are those of a refused save (the summary then says so), not something else the server refused. */
  private problemsOfSave = false;
  /** How many quests there are in all: the server's count, kept in step with what is saved and deleted here. */
  private total = 0;
  /** The page was not drawn again because a dialog was open over it; it is once the dialog has closed. */
  private stale = false;

  // A second save while one is on its way would interleave delete and insert
  // cycles on the server and duplicate every objective and reward. The result
  // does not name its request, so the one that is waiting is remembered.
  private pending: Asked | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** A request given up on after 15 seconds: its answer may still come. */
  private late: Asked | null = null;

  /** The parts of the page that follow the fields as they are typed in. */
  private summaryEl: HTMLElement | null = null;
  private live: Array<() => void> = [];
  private headThumb: { key: string; node: HTMLElement } | null = null;

  private shell = new EditorShell({
    tool: "Quest Editor", noun: "quest", icon: "scroll", tabs: TABS,
    onSearch: () => this.runSearch(),
    onNew: () => void this.newEntry(),
    onSave: () => this.save(),
    onDuplicate: () => void this.duplicate(this.openRow()),
    onDelete: () => void this.deleteEntry(this.openRow()),
    onTab: (id) => this.switchTab(id),
  });

  private fields = new FieldRenderer({
    rerender: () => this.renderForm(),
    missingImage: () => this.missingIcon(),
  });

  constructor() {
    // A dialog that closes leaves the page free to be drawn again, if it was waiting to be.
    new MutationObserver(() => {
      if (this.stale && !document.querySelector("dialog[open]")) this.renderForm();
    }).observe(document.body, { childList: true });
    this.shell.waiting(() => this.askForLists());
    this.shell.connect((msg) => this.onMessage(msg));
  }

  /**
   * The game window asks for the lists the fields pick from when it opens the
   * editor. This asks again, from the page that says the server is not answering.
   */
  private askForLists(): void {
    this.shell.send({ type: "request", packet: "QUEST_EDITOR_DATA", data: null });
  }

  private onMessage(msg: any): void {
    if (msg.type === "data") {
      this.data = { ...this.data, ...msg.data };
      this.ready = true;
      this.shell.arrived();
      this.total = Number(this.data.questCount) || 0;
      this.shell.setCount(this.total);
      this.renderList();
      this.redraw();
      // Fill the list at once; an empty search lists every quest.
      this.runSearch();
    } else if (msg.type === "results") {
      this.results = Array.isArray(msg.data?.quests) ? msg.data.quests : [];
      this.truncated = Number(msg.data?.truncated) || 0;
      this.searched = true;
      // A save runs the search again; go on editing the quest as it came back.
      // Not under an open picker: what is picked there goes into the draft it was opened on.
      if (this.editingId !== null && !this.dirty && !document.querySelector("dialog[open]")) {
        const fresh = this.results.find((q: any) => Number(q.id) === this.editingId);
        if (fresh) {
          this.draft = clone(fresh);
          this.renderForm();
        }
      }
      this.renderList();
    } else if (msg.type === "result") {
      const asked = this.pending ?? this.late;
      const wasLate = !this.pending && !!this.late;
      this.late = null;
      if (this.pending) this.endRequest();
      if (!asked) {
        if (!msg.ok) this.report(msg.errors?.length ? msg.errors : ["The server refused that."]);
        return;
      }
      if (asked.kind === "save") this.onSaveResult(msg, asked, wasLate);
      else this.onDeleteResult(msg, asked);
    } else if (msg.type === "updated") {
      toast(`${shown(msg.by)} changed a quest. The list shows it as it is now.`);
      if (this.searched) this.runSearch();
    }
  }

  private onSaveResult(msg: any, asked: Asked, wasLate: boolean): void {
    // The save was sent from the record that is open, and no other has been opened since.
    const here = asked.opened === this.opened && !!this.draft;
    if (!msg.ok) {
      const lines: string[] = msg.errors?.length ? msg.errors : ["The server refused the save."];
      if (!here) return toast([`${asked.name} was not saved.`, ...lines].join("\n"), "error");
      this.refused = true;
      this.problems = lines.map(placeOf);
      this.problemsOfSave = true;
      this.showProblems();
      return;
    }
    if (asked.adds) this.shell.setCount(++this.total);
    toast(wasLate ? `Saved ${asked.name}. The server took a while to answer.` : `Saved ${asked.name}.`);
    if (here) {
      // What was changed while the save was on its way is still to be saved.
      this.dirty = this.edits !== asked.edits;
      this.refused = false;
      this.clearProblems();
      if (msg.id !== undefined && msg.id !== null) this.editingId = Number(msg.id);
      this.renderForm();
    }
    this.runSearch();
  }

  private onDeleteResult(msg: any, asked: Asked): void {
    if (!msg.ok) {
      const lines: string[] = msg.errors?.length ? msg.errors : ["The server refused to delete it."];
      void noticeDialog(`${asked.name} was not deleted`, lines);
      return;
    }
    // Close it if it is the open one. Another open quest's unsaved changes are left alone.
    if (this.editingId !== null && this.editingId === asked.id) {
      this.draft = null;
      this.editingId = null;
      this.dirty = false;
      this.refused = false;
      this.clearProblems();
      this.renderForm();
    }
    this.total = Math.max(0, this.total - 1);
    this.shell.setCount(this.total);
    toast(`Deleted ${asked.name}.`);
    this.runSearch();
  }

  /**
   * Something the server refused that no request here was waiting for. Before
   * its first answer, that is the editor itself being refused: the page says
   * so. After, it is said on the open quest, or in the corner.
   */
  private report(lines: string[]): void {
    if (!this.ready) this.shell.refused(lines, () => this.askForLists());
    else if (this.draft) {
      this.problems = lines.map((line) => ({ line, path: null, said: line }));
      this.problemsOfSave = false;
      this.shell.setProblems(this.problemLines());
    } else toast(lines.join("\n"), "error");
  }

  // ---------------------------------------------------------------- problems

  /** Which tab a field path is edited on. */
  private tabOf(path: string): string {
    return path.startsWith("objectives") ? "objectives" : path.startsWith("rewards") ? "rewards" : "general";
  }

  private problemsByTab(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { path } of this.problems) if (path) counts[this.tabOf(path)] = (counts[this.tabOf(path)] ?? 0) + 1;
    return counts;
  }

  /** The problem to show under the field at `path`: the first the server reported for it. */
  private errorAt(path: string): string | undefined {
    return this.problems.find((p) => p.path === path)?.said;
  }

  /**
   * The summary at the top of the page: how many things the server found
   * wrong and on which tabs, then its own lines. It is worked out again as
   * fields are put right.
   */
  private problemLines(): string[] {
    if (this.problems.length === 0) return [];
    const lines = this.problems.map((p) => p.line);
    if (!this.problemsOfSave) return lines;
    const tabs = [...new Set(this.problems.flatMap((p) => (p.path ? [this.tabOf(p.path)] : [])))];
    const where = tabs.length ? `, on ${listed(tabs.map((t) => TAB_TITLES[t]))}` : "";
    return [`The quest was not saved. ${count(lines.length, "thing needs", "things need")} fixing${where}:`, ...lines];
  }

  /** Nothing is wrong any more: a save went through, or another quest is opened. */
  private clearProblems(): void {
    this.problems = [];
    this.shell.setProblems([]);
  }

  /** A save was refused: say so at the top, and show a tab that has a problem. */
  private showProblems(): void {
    const tabs = Object.keys(this.problemsByTab());
    // Show a tab that has a problem, unless the one in view already does.
    if (tabs.length && !tabs.includes(this.tab)) this.tab = TABS.map((t) => t.id).find((id) => tabs.includes(id)) ?? this.tab;
    this.shell.setProblems(this.problemLines());
    this.renderForm();
  }

  /** The problems reported by position in a list no longer line up once the list is reordered or shortened. */
  private dropProblemsOf(root: string): void {
    this.problems = this.problems.filter((p) => !p.path?.startsWith(root));
  }

  // ------------------------------------------------------------------- lists

  private creatureName(id: unknown): string {
    const found = (this.data.creatures ?? []).find((c: any) => String(c.id) === String(id));
    const name = String(found?.name ?? "").trim();
    return !found ? `creature #${id}` : !name || name === `#${found.id}` ? `Unnamed creature #${found.id}` : name;
  }

  private creatureOptions(): AssetOption[] {
    return (this.data.creatures ?? []).map((c: any) => ({ value: String(c.id), label: `${this.creatureName(c.id)} (#${c.id})` }));
  }

  /** An NPC's name as it is shown; the server sends "#12" for one that has none. */
  private npcNameOf(npc: any): string {
    const name = String(npc?.name ?? "").trim();
    return !name || name === `#${npc?.id}` ? "Unnamed NPC" : name;
  }

  private npcName(id: unknown): string {
    const found = (this.data.npcs ?? []).find((n: any) => String(n.id) === String(id));
    return found ? this.npcNameOf(found) : `NPC #${id}`;
  }

  /** Every NPC, for an objective to talk to one. */
  private npcOptions(): AssetOption[] {
    return (this.data.npcs ?? []).map((n: any) => ({ value: String(n.id), label: `${this.npcNameOf(n)} (#${n.id}${n.map ? `, ${n.map}` : ""})` }));
  }

  /** Only NPCs marked as quest givers can have quests assigned to them. */
  private questGivers(): Choice<number>[] {
    return (this.data.npcs ?? [])
      .filter((n: any) => n.quest_giver === true || n.quest_giver === 1)
      .map((n: any) => ({ value: Number(n.id), label: this.npcNameOf(n), mark: `#${n.id}`, note: n.map ? `#${n.id} · ${n.map}` : `#${n.id}` }));
  }

  /** The draft itself can never be its own prerequisite or the quest that follows it. */
  private selfQuestId(): number | null {
    const fromTracker = this.editingId === null || this.editingId === undefined ? null : Number(this.editingId);
    if (Number.isFinite(fromTracker)) return fromTracker as number;
    const fromDraft = this.draft?.id === null || this.draft?.id === undefined ? null : Number(this.draft.id);
    return Number.isFinite(fromDraft) ? (fromDraft as number) : null;
  }

  /** Every quest the editor knows by name: the server's list, and what the last search found that is not in it. */
  private knownQuests(): any[] {
    const listed: any[] = this.data.quests ?? [];
    return [...listed, ...this.results.filter((q: any) => !listed.some((k: any) => Number(k.id) === Number(q.id)))];
  }

  /** The quests another quest can be picked from: all but the open one, unless it is already picked. */
  private questsToPick(includeIds: number[] = []): any[] {
    const excludeId = this.selfQuestId();
    const include = new Set(includeIds);
    return this.knownQuests().filter((q: any) => include.has(Number(q.id)) || excludeId === null || Number(q.id) !== excludeId);
  }

  private questName(id: unknown): string {
    const found = this.knownQuests().find((q: any) => Number(q.id) === Number(id));
    return found ? String(found.name) : `quest #${id}`;
  }

  private iconUrlFor(name: unknown): string | null {
    const wanted = String(name ?? "").trim();
    if (!wanted) return null;
    const bare = wanted.replace(/\.(png|jpg|jpeg|gif)$/i, "");
    const base = this.data.assetServerUrl;
    return base ? `${base}/icon?name=${encodeURIComponent(bare)}` : null;
  }

  /** Tried once when an item's own icon will not load. */
  private missingIcon(): string | null {
    return this.data.assetServerUrl ? `${this.data.assetServerUrl}/icon?name=missing_icon` : null;
  }

  /** Item entries are { name, icon, quality }; older payloads may carry bare names. */
  private itemNameOf(entry: unknown): string {
    if (typeof entry === "string") return entry;
    return String((entry as any)?.name ?? "");
  }

  private itemOptions(): AssetOption[] {
    return (this.data.items ?? []).map((entry: unknown) => {
      const name = this.itemNameOf(entry);
      const iconName = typeof entry === "string" ? null : ((entry as any)?.icon ?? null);
      // No quality from the server (an older server build) leaves the icon unframed
      // rather than showing every item as common.
      const quality = typeof entry === "string" ? null : ((entry as any)?.quality ?? null);
      return { value: name, label: name, image: iconName ? this.iconUrlFor(iconName) : null, quality };
    });
  }

  /** The item of that name, whatever its capitals: the server matches names that way too. */
  private itemNamed(name: unknown): AssetOption | undefined {
    const wanted = lower(name).trim();
    return wanted ? this.itemOptions().find((o) => lower(o.label) === wanted) : undefined;
  }

  /** An item's icon in its quality frame, or a box where it has none or is not a known item. */
  private itemThumb(name: unknown, size: "" | "lg" = ""): HTMLElement {
    const item = this.itemNamed(name);
    return thumb(item?.image, { size, fallback: "box", missing: this.missingIcon(), ...(item?.quality ? { quality: item.quality } : {}) });
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

  /** A detached, fully-shaped copy of a quest for the form to edit. */
  private editableCopy(quest: any): any {
    const draft = clone(quest);
    draft.objectives = draft.objectives || [];
    draft.rewards = draft.rewards || [];
    draft.prerequisites = (draft.prerequisites || []).map(Number);
    // NPC links are edited alongside the quest but loaded lazily: keep
    // whatever the draft carries, defaulting to empty.
    draft.givers = draft.givers || [];
    draft.enders = draft.enders || [];
    return draft;
  }

  // ------------------------------------------------------------------ search

  private runSearch(): void {
    this.shell.send({ type: "request", packet: "QUEST_EDITOR_SEARCH", data: { query: this.shell.takeQuery() } });
  }

  /** The row of the open quest as the list holds it, or the open quest itself where the search does not list it. */
  private openRow(): any {
    return this.results.find((q: any) => Number(q.id) === this.editingId) ?? this.draft;
  }

  /** The level a quest asks for, in the square a record's picture goes in: what tells quests apart at a glance. */
  private levelThumb(quest: any, size: "" | "lg" | "xl" = ""): HTMLElement {
    const level = Math.floor(Number(quest?.required_level));
    if (!Number.isFinite(level) || level < 1) return thumb(null, { size, fallback: "scroll" });
    const box = el("span", "tl-thumb qe-level" + (size ? ` tl-thumb-${size}` : ""), level > 999 ? "999+" : String(level));
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `Level ${num(level)}`);
    box.title = `For players of level ${num(level)} and up`;
    return box;
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    if (!this.searched) return this.shell.setList({ rows: [], loading: true });
    const rows: ListRow[] = [];
    // A quest that has never been saved is not in the server's list yet: it heads this one.
    if (this.draft && this.editingId === null) {
      rows.push({
        id: "\u0000new", name: this.titleOf(this.draft), note: "Not saved yet", selected: true,
        thumb: this.levelThumb(this.draft), tags: [tag("New", "warning")], onOpen: () => undefined,
      });
    }
    for (const quest of this.results) {
      const label = `#${quest.id} ${quest.name}`;
      const repeats = String(quest.repeatable ?? "none");
      rows.push({
        id: String(quest.id), name: String(quest.name), note: quest.zone ? `#${quest.id} · ${quest.zone}` : `#${quest.id}`,
        selected: Number(quest.id) === this.editingId, thumb: this.levelThumb(quest),
        tags: repeats === "none" ? [] : [tag(REPEATABLE_WORDS[repeats] ?? words(repeats), "muted", "refresh")],
        actions: [
          { icon: "copy", label: `Duplicate ${label}`, onClick: () => void this.duplicate(quest) },
          { icon: "trash", label: `Delete ${label}`, danger: true, onClick: () => void this.deleteEntry(quest) },
        ],
        onOpen: () => void this.select(Number(quest.id)),
      });
    }
    this.shell.setList({
      rows,
      empty: this.shell.query
        ? { icon: "search", title: "No quests match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "There are no quests yet", text: "Start the first one with New quest." },
      foot: this.truncated > 0 ? `${count(this.truncated, "more quest matches", "more quests match")}. Narrow the search to see them.` : "",
    });
  }

  /** The top bar and the tabs: what is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false, busy: this.pending ? "other" : null });
      shell.setTabs(null);
      shell.setBanner(null);
      return;
    }
    const saved = this.editingId !== null;
    // The square is only drawn again when the level changes, not at every key typed.
    const level = String(d.required_level);
    if (this.headThumb?.key !== level) this.headThumb = { key: level, node: this.levelThumb(d, "lg") };
    const zone = String(d.zone ?? "").trim();
    shell.setRecord({
      title: this.titleOf(d),
      note: [saved ? `Quest #${this.editingId}` : "New quest", zone].filter(Boolean).join(" · "),
      thumb: this.headThumb.node,
    });
    const saving = this.pending?.kind === "save" && this.pending.opened === this.opened;
    const state: RecordState = saving ? "saving" : this.refused ? "error" : !saved ? "new" : this.dirty ? "unsaved" : "saved";
    shell.setState(state);
    const deleting = this.pending?.kind === "delete" && this.pending.id === this.editingId;
    shell.setActions({
      open: true, dirty: this.dirty,
      busy: this.pending ? (saving ? "save" : deleting ? "delete" : "other") : null,
      canDuplicate: saved, canDelete: saved,
      why: {
        duplicate: "Save it first, then it can be copied",
        delete: "It has not been saved, so there is nothing to delete",
      },
    });
    shell.setTabs(this.tab, this.problemsByTab());
    shell.setBanner(null);
  }

  /** What the open quest is called while its name field may be empty. */
  private titleOf(quest: any): string {
    return String(quest?.name ?? "").trim() || (this.editingId === null ? "New quest" : "Unnamed quest");
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    this.renderForm();
  }

  /** Draws the page again, unless a dialog is open over it: then it waits until the dialog has closed. */
  private redraw(): void {
    if (document.querySelector("dialog[open]")) {
      this.stale = true;
      this.chrome();
    } else this.renderForm();
  }

  private renderForm(): void {
    this.stale = false;
    this.chrome();
    this.summaryEl = null;
    this.live = [];
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle("Pick a quest from the list on the left, or start a new one.", this.total === 0 ? "Start the first one." : null);
      box.appendChild(button("New quest", () => void this.newEntry(), { icon: "plus", kind: "primary" }));
      return;
    }
    this.shell.setProblems(this.problemLines(), false);
    const { main, aside } = this.shell.page(`${this.opened}:${this.tab}`, { aside: true });

    if (this.tab === "objectives") this.renderObjectives(main);
    else if (this.tab === "rewards") this.renderRewards(main);
    else if (this.tab === "texts") this.renderTexts(main);
    else this.renderGeneral(main);

    // The quest as a player meets it, beside the form on every tab.
    const { body } = card(aside, "As a player meets it", "What the quest asks for and what it gives");
    this.summaryEl = el("div", "tl-summary qe-summary");
    body.appendChild(this.summaryEl);
    this.paintLive();
  }

  private renderGeneral(main: HTMLElement): void {
    const d = this.draft;
    const repeatables: string[] = this.data.repeatableValues?.length ? this.data.repeatableValues : REPEATABLE_VALUES;

    const quest = this.section(main, "Quest", "What it is called and who it is for");
    quest.appendChild(this.field({ key: "name", label: "Name", type: "text" }, d, "name"));
    quest.appendChild(this.field({ key: "zone", label: "Zone", type: "text", hint: "Groups the quest in the player's log." }, d, "zone"));
    quest.appendChild(this.field({ key: "required_level", label: "Required level", type: "number", min: 1, step: 1, hint: "Players below it are not offered the quest." }, d, "required_level"));
    quest.appendChild(this.field({ key: "quest_level", label: "Quest level", type: "number", min: 0, step: 1, hint: "Sets its difficulty colour. 0 uses the required level." }, d, "quest_level"));
    quest.appendChild(this.field(
      { key: "repeatable", label: "Repeatable", type: "select", options: () => repeatables.map((v) => ({ value: v, label: REPEATABLE_WORDS[v] ?? words(v) })), hint: "Whether a player who has finished it can take it again." },
      d, "repeatable"
    ));
    quest.appendChild(this.field({ key: "sort_order", label: "Sort order", type: "number", step: 1, hint: "Lower numbers are listed first." }, d, "sort_order"));

    const chain = this.section(main, "Quest chain", "What comes before this quest and what follows it");
    chain.appendChild(this.field(
      {
        key: "next_quest_id", label: "Next quest", type: "asset", noIcons: true, hint: "Offered right after this one is turned in.",
        assets: () => {
          const quests = this.questsToPick().map((q: any) => ({ value: String(q.id), label: `${q.name} (#${q.id})` }));
          // A quest that is kept here and cannot be picked says why, in place of a bare number.
          const kept = filled(d.next_quest_id) && !quests.some((q) => q.value === String(d.next_quest_id));
          const why = Number(d.next_quest_id) === this.selfQuestId() ? "a quest cannot follow itself" : "no longer exists";
          return [{ value: "", label: "None" }, ...(kept ? [{ value: String(d.next_quest_id), label: `Quest #${d.next_quest_id} (${why})` }] : []), ...quests];
        },
      },
      d, "next_quest_id",
      // Kept as the server keeps it: a quest's id as a number, or nothing.
      () => {
        d.next_quest_id = d.next_quest_id === "" ? null : Number(d.next_quest_id);
      }
    ));
    chain.appendChild(this.many("prerequisites", "Prerequisites", "quest", "Quests that must be completed before this one is offered.", "this quest no longer exists",
      () => this.questsToPick(idList(d.prerequisites)).map((q: any) => ({ value: Number(q.id), label: String(q.name), mark: `#${q.id}`, note: `#${q.id}` }))));

    const npcs = this.section(main, "NPCs", "Only NPCs marked as quest givers can be picked");
    npcs.appendChild(this.many("givers", "Given by", "NPC", "The NPCs that offer the quest.", "this NPC no longer exists, or is no longer a quest giver", () => this.questGivers()));
    npcs.appendChild(this.many("enders", "Turned in to", "NPC", "The NPCs the finished quest is handed in to.", "this NPC no longer exists, or is no longer a quest giver", () => this.questGivers()));
  }

  private renderTexts(main: HTMLElement): void {
    const d = this.draft;
    const texts = this.section(main, "What the player reads", "The quest in its own words, at each step");
    texts.appendChild(this.field({ key: "offer_text", label: "Offer text", type: "textarea", rows: 4, hint: "Shown when the NPC offers the quest." }, d, "offer_text"));
    texts.appendChild(this.field({ key: "description", label: "Log description", type: "textarea", rows: 3, hint: "Shown in the quest log while the quest is active." }, d, "description"));
    texts.appendChild(this.field({ key: "progress_text", label: "Progress text", type: "textarea", rows: 3, hint: "Shown when talking to the NPC before the objectives are done." }, d, "progress_text"));
    texts.appendChild(this.field({ key: "completion_text", label: "Completion text", type: "textarea", rows: 3, hint: "Shown when the quest is turned in." }, d, "completion_text"));
  }

  /** The quest's objectives, one card each, in the order the quest log lists them. */
  private renderObjectives(main: HTMLElement): void {
    const d = this.draft;
    d.objectives = d.objectives || [];
    const objectives: any[] = d.objectives;
    const types: string[] = this.data.objectiveTypes?.length ? this.data.objectiveTypes : OBJECTIVE_TYPES;

    if (objectives.length === 0) {
      const none = el("section", "tl-card");
      empty(none, "target", "No objectives", "The quest can be turned in straight away. Add an objective below to give the player something to do.");
      main.appendChild(none);
    }

    objectives.forEach((objective, index) => {
      const at = `objectives.${index}`;
      const type = String(objective.type ?? "");
      // An objective that names a creature or an NPC always holds one that exists: the first, until another is picked.
      if (type === "kill" || type === "talk") {
        const options = type === "kill" ? this.creatureOptions() : this.npcOptions();
        const current = String(objective.target ?? "");
        objective.target = options.some((o) => o.value === current) ? current : options.length ? String(options[0].value) : "";
      }

      const part = card(main, `Objective ${index + 1} · ${words(type) || "No type"}`, this.objectiveLine(objective));
      part.root.classList.add("qe-entry");
      const lead = part.root.querySelector<HTMLElement>(".tl-card-lead");
      const picture = el("span", "qe-entry-thumb");
      part.root.querySelector(".tl-card-head")!.prepend(picture);
      // The card's own line and picture follow its fields as they change.
      const repaint = () => {
        if (lead) lead.textContent = this.objectiveLine(objective);
        const shownFor = objective.type === "collect" ? `item:${lower(objective.target).trim()}` : `type:${objective.type}`;
        if (picture.dataset.shows === shownFor) return;
        picture.dataset.shows = shownFor;
        picture.replaceChildren(objective.type === "collect" && this.itemNamed(objective.target) ? this.itemThumb(objective.target, "lg") : thumb(null, { size: "lg", fallback: TARGETS[type]?.icon ?? "target" }));
      };
      repaint();
      this.live.push(repaint);
      part.tools.append(...this.entryActions(objectives, index, "objective", "objectives"));
      const wrong = this.errorAt(at);
      if (wrong) part.body.appendChild(this.entryError(wrong));

      const grid = el("div", "tl-fields tl-fields-2");
      part.body.appendChild(grid);
      grid.appendChild(this.field(
        { key: "type", label: "Type", type: "select", options: () => types.map((v) => ({ value: v, label: words(v) })), rerender: true },
        objective, `${at}.type`,
        // A different type points at a different kind of thing: start with nothing picked.
        () => {
          objective.target = "";
          this.dropProblemsOf(`${at}.`);
        }
      ));

      const target = TARGETS[type]?.label ?? "Target";
      if (type === "kill" || type === "talk") {
        grid.appendChild(this.field(
          { key: "target", label: target, type: "asset", noIcons: true, assets: () => (type === "kill" ? this.creatureOptions() : this.npcOptions()) },
          objective, `${at}.target`
        ));
      } else if (type === "explore") {
        const maps: string[] = this.data.maps ?? [];
        grid.appendChild(this.field(
          // A map's name stays text, even one made of digits.
          { key: "target", label: target, type: "select", asText: true, options: () => maps.map((map) => ({ value: map, label: map })) },
          objective, `${at}.target`
        ));
      } else {
        grid.appendChild(this.itemField(objective, `${at}.target`, target));
      }
      const required = this.field({ key: "required_count", label: "Required count", type: "number", min: 1, step: 1 }, objective, `${at}.required_count`);
      if (type === "explore") {
        // An optional spot: leave all three empty to complete on entering the map.
        grid.appendChild(this.field({ key: "target_x", label: "X", type: "number" }, objective, `${at}.target_x`));
        grid.appendChild(this.field({ key: "target_y", label: "Y", type: "number" }, objective, `${at}.target_y`));
        grid.appendChild(this.field({ key: "target_radius", label: "Radius", type: "number", min: 1, unit: "pixels" }, objective, `${at}.target_radius`));
        grid.appendChild(required);
        grid.appendChild(el("p", "tl-field-hint tl-field-wide qe-fields-note", "Leave X, Y and Radius empty to complete the objective on entering the map. A radius needs both X and Y."));
      } else grid.appendChild(required);
      grid.appendChild(this.field(
        { key: "description", label: "Display text (optional)", type: "text", wide: type === "explore", hint: 'Replaces the generated line in the quest log, for example "Wolf pelts collected".' },
        objective, `${at}.description`
      ));
    });

    main.appendChild(button("Add objective", () => {
      objectives.push({ type: "kill", target: "", required_count: 1, target_x: null, target_y: null, target_radius: null, description: null });
      this.changed();
      this.renderForm();
      this.focusLater(`objectives.${objectives.length - 1}.type`);
    }, { icon: "plus", add: true }));
  }

  private renderRewards(main: HTMLElement): void {
    const d = this.draft;
    d.rewards = d.rewards || [];
    const rewards: any[] = d.rewards;
    // XP and money are rewards, not quest metadata: they live here next to
    // the item rewards so authors set the whole payout in one place.
    const payout = this.section(main, "Experience and money", "What every player who turns the quest in is given");
    payout.appendChild(this.field({ key: "xp_reward", label: "XP reward", type: "number", min: 0, step: 1, unit: "XP" }, d, "xp_reward"));
    payout.appendChild(this.field({ key: "copper_reward", label: "Money reward", type: "money", hint: "Gold, silver and copper." }, d, "copper_reward"));

    if (rewards.length === 0) {
      const none = el("section", "tl-card");
      empty(none, "bag", "No item rewards", "The quest pays its experience and money only. Add an item below to give more.");
      main.appendChild(none);
    }

    rewards.forEach((reward, index) => {
      const at = `rewards.${index}`;
      const name = this.itemNameOf(reward.item_name ?? reward);
      const part = card(main, `Item reward ${index + 1} · ${name || "No item picked"}`, this.rewardLine(reward));
      part.root.classList.add("qe-entry");
      const lead = part.root.querySelector<HTMLElement>(".tl-card-lead");
      const picture = el("span", "qe-entry-thumb");
      picture.appendChild(this.itemThumb(name, "lg"));
      part.root.querySelector(".tl-card-head")!.prepend(picture);
      this.live.push(() => {
        if (lead) lead.textContent = this.rewardLine(reward);
      });
      part.tools.append(...this.entryActions(rewards, index, "item reward", "rewards"));
      const wrong = this.errorAt(at);
      if (wrong) part.body.appendChild(this.entryError(wrong));

      const grid = el("div", "tl-fields tl-fields-2");
      part.body.appendChild(grid);
      grid.appendChild(this.field(
        { key: "item_name", label: "Item", type: "asset", assets: () => this.itemOptions(), searchFirst: true, fallback: "box", rerender: true },
        reward, `${at}.item_name`
      ));
      grid.appendChild(this.field({ key: "quantity", label: "Quantity", type: "number", min: 1, step: 1 }, reward, `${at}.quantity`));
      grid.appendChild(this.field(
        { key: "is_choice", label: "Player's choice", type: "switch", rerender: true, wide: true, hint: "The player picks one of the rewards marked as a choice. All others are always given." },
        reward, `${at}.is_choice`
      ));
    });

    main.appendChild(button("Add item reward", () => {
      rewards.push({ item_name: "", quantity: 1, is_choice: false });
      this.changed();
      this.renderForm();
      this.focusLater(`rewards.${rewards.length - 1}.item_name`);
    }, { icon: "plus", add: true }));
  }

  /** Move up, move down and remove, in the header of an objective's or an item reward's card. */
  private entryActions(list: any[], index: number, noun: string, root: string): HTMLElement[] {
    const act = (name: "arrowUp" | "arrowDown" | "trash", label: string, enabled: boolean, change: () => void) => {
      const btn = iconButton(name, label, () => {
        change();
        // Positions changed, so the problems reported by position no longer line up.
        this.dropProblemsOf(root);
        this.changed();
        this.renderForm();
      }, { danger: name === "trash", size: 15 });
      btn.disabled = !enabled;
      return btn;
    };
    const swap = (a: number, b: number) => {
      [list[a], list[b]] = [list[b], list[a]];
    };
    return [
      act("arrowUp", `Move ${noun} ${index + 1} up`, index > 0, () => swap(index, index - 1)),
      act("arrowDown", `Move ${noun} ${index + 1} down`, index < list.length - 1, () => swap(index, index + 1)),
      act("trash", `Remove ${noun} ${index + 1}`, true, () => list.splice(index, 1)),
    ];
  }

  /** What the server found wrong with a card as a whole, at its top. */
  private entryError(message: string): HTMLElement {
    const line = el("p", "tl-field-error qe-entry-error");
    line.setAttribute("role", "alert");
    line.append(icon("alert", 13), el("span", "", message));
    return line;
  }

  // ------------------------------------------------------------- plain words

  /** "Kill Rat × 3": what an objective asks for, under its card's title and in the summary. */
  private objectiveLine(objective: any): string {
    const type = String(objective?.type ?? "");
    const target = String(objective?.target ?? "").trim();
    const wanted = Number(objective?.required_count);
    const times = Number.isFinite(wanted) && wanted > 1 ? ` × ${num(wanted)}` : "";
    if (type === "kill") return target ? `Kill ${this.creatureName(target)}${times}` : "No creature picked yet";
    if (type === "talk") return target ? `Talk to ${this.npcName(target)}${times}` : "No NPC picked yet";
    if (type === "collect") return target ? `Collect ${this.itemNamed(target)?.label ?? target}${times}` : "No item named yet";
    if (type === "explore") {
      if (!target) return "No map picked yet";
      if (!filled(objective.target_x) || !filled(objective.target_y)) return `Enter ${target}${times}`;
      const within = filled(objective.target_radius) ? `, to within ${count(Number(objective.target_radius), "pixel")}` : "";
      return `Reach x ${objective.target_x}, y ${objective.target_y} on ${target}${within}${times}`;
    }
    return target ? `${words(type)} ${target}${times}` : "The game does not know this kind of objective";
  }

  /** How an item reward is given, under its card's title. */
  private rewardLine(reward: any): string {
    const quantity = Number(reward?.quantity);
    const times = Number.isFinite(quantity) && quantity > 1 ? `${num(quantity)} of them. ` : "";
    return `${times}${reward?.is_choice ? "One of the choices the player picks from." : "Always given."}`;
  }

  /** The quest as a player meets it, in plain words: who offers it, what it asks, where it ends and what it pays. */
  private summary(): HTMLElement[] {
    const d = this.draft;
    const out: HTMLElement[] = [];
    const say = (text: string, className = "") => out.push(el("p", className, text));
    const named = (ids: unknown, name: (id: number) => string) => idList(ids).map(name);

    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    const zone = String(d.zone ?? "").trim();
    said.append(el("span", "tl-preview-name", this.titleOf(d)), el("span", "tl-preview-kind", zone ? `Quest in ${zone}` : "Quest"));
    head.append(this.levelThumb(d, "xl"), said);
    out.push(head);

    const level = Math.max(1, Math.floor(Number(d.required_level) || 1));
    const givers = named(d.givers, (id) => this.npcName(id));
    const before = named(d.prerequisites, (id) => `“${this.questName(id)}”`);
    const whom = `players of level ${num(level)} and up${before.length ? ` who have finished ${listed(before)}` : ""}`;
    say(givers.length ? `${listed(givers)} ${givers.length === 1 ? "offers" : "offer"} it to ${whom}.` : `No NPC offers it yet, so nobody can start it. It is for ${whom}.`);

    const objectives: any[] = Array.isArray(d.objectives) ? d.objectives : [];
    if (objectives.length === 0) say("It has no objectives, so it can be turned in straight away.");
    else {
      say(`To finish it they must:`);
      const steps = el("ol", "qe-steps");
      for (const objective of objectives) {
        const step = el("li", "", this.objectiveLine(objective));
        const shownAs = String(objective.description ?? "").trim();
        if (shownAs) step.appendChild(el("span", "qe-steps-note", `Shown in the log as “${shownAs}”`));
        steps.appendChild(step);
      }
      out.push(steps);
    }

    const enders = named(d.enders, (id) => this.npcName(id));
    say(enders.length ? `They turn it in to ${either(enders)}.` : "No NPC takes it back yet, so it cannot be turned in.");

    const xp = Math.max(0, Math.floor(Number(d.xp_reward) || 0));
    const money = coins(d.copper_reward);
    const pay = el("p");
    if (xp === 0 && !money) pay.textContent = "It pays no experience and no money.";
    else {
      pay.append(xp > 0 ? `It pays ${num(xp)} XP` : "It pays ");
      if (money) pay.append(xp > 0 ? " and " : "", money);
      pay.append(".");
    }
    out.push(pay);

    const rewards: any[] = Array.isArray(d.rewards) ? d.rewards : [];
    const loot = (heading: string, picked: any[]) => {
      if (picked.length === 0) return;
      say(heading);
      const list = el("ul", "qe-loot");
      for (const reward of picked) {
        const name = this.itemNameOf(reward.item_name ?? reward);
        const row = el("li");
        row.append(this.itemThumb(name), el("span", "qe-loot-name", name || "No item picked"));
        if (Number(reward.quantity) > 1) row.appendChild(el("span", "qe-loot-count", `× ${num(Number(reward.quantity))}`));
        list.appendChild(row);
      }
      out.push(list);
    };
    loot("Every player also gets:", rewards.filter((r) => !r.is_choice));
    loot("They pick one of:", rewards.filter((r) => r.is_choice));

    const repeats = String(d.repeatable ?? "none");
    if (repeats === "daily") say("It can be done again once a day.");
    else if (repeats !== "none") say("It can be done again as often as they like.");
    if (filled(d.next_quest_id)) say(`Turning it in offers “${this.questName(d.next_quest_id)}” next.`);

    const unwritten = [["offer_text", "offer text"], ["description", "log description"], ["progress_text", "progress text"], ["completion_text", "completion text"]]
      .filter(([key]) => !String(d[key] ?? "").trim())
      .map(([, label]) => label);
    if (unwritten.length) say(`Not written yet: ${listed(unwritten)}.`, "qe-faint");
    return out;
  }

  /** The parts that follow the fields as they change: the cards' own lines, and the summary beside the form. */
  private paintLive(): void {
    if (!this.draft) return;
    for (const repaint of this.live) repaint();
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary());
  }

  // ------------------------------------------------------------------ fields

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /**
   * One form field editing `target[field.key]`, with any problem reported
   * under `path` shown beneath it. `onChange` runs before the form is told.
   */
  private field(field: Field, target: any, path: string, onChange?: () => void): HTMLElement {
    const wrap = this.fields.renderField({ ...field, path }, target, () => {
      onChange?.();
      this.touched(path, wrap);
    }, { error: this.errorAt(path) });
    return wrap;
  }

  /** A field of the quest itself that holds several picks: the quests before it, the NPCs that give it and take it. */
  private many(key: string, label: string, noun: string, hint: string, gone: string, choices: () => Choice<number>[]): HTMLElement {
    const d = this.draft;
    const wrap = manyField<number>({
      path: key, label, noun, hint, gone, choices,
      get: () => idList(d[key]),
      set: (next) => {
        d[key] = next;
        this.touched(key, wrap);
      },
      error: this.errorAt(key),
    });
    return wrap;
  }

  /**
   * The item an objective collects: its name as free text, as the server
   * keeps it, with the items that match listed under the field to pick from.
   */
  private itemField(objective: any, path: string, label: string): HTMLElement {
    const id = `qe-item-${++comboIds}`;
    const wrap = el("div", "tl-field");
    wrap.dataset.field = path;
    const title = el("label", "tl-field-label", label);
    title.htmlFor = id;
    const box = el("div", "tl-suggest-wrap qe-combo");
    const picture = el("span", "qe-combo-thumb");
    const input = el("input", "tl-input");
    input.id = id;
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", `${id}-list`);
    input.setAttribute("aria-describedby", `${id}-hint`);
    input.value = String(objective.target ?? "");
    const list = el("div", "tl-suggest");
    list.id = `${id}-list`;
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const hint = el("span", "tl-field-hint");
    hint.id = `${id}-hint`;
    box.append(picture, input, list);
    wrap.append(title, box, hint);

    const items = this.itemOptions();
    let matches: AssetOption[] = [];
    let active = -1;

    const paintState = () => {
      const typed = input.value.trim();
      const known = this.itemNamed(typed);
      picture.replaceChildren(this.itemThumb(typed));
      hint.classList.toggle("qe-combo-unknown", !!typed && !known && items.length > 0);
      hint.textContent = !typed ? "Type part of an item's name and pick it from the matches."
        : known ? "An item of this name exists."
        : items.length === 0 ? "The list of items did not arrive, so the name cannot be checked here."
        : "No item has this name. Pick one of the matches.";
    };
    const close = () => {
      list.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    const mark = (index: number) => {
      active = index;
      [...list.querySelectorAll<HTMLElement>(".tl-suggest-row")].forEach((row, i) => {
        row.classList.toggle("is-active", i === index);
        row.setAttribute("aria-selected", String(i === index));
        if (i === index) {
          input.setAttribute("aria-activedescendant", row.id);
          row.scrollIntoView({ block: "nearest" });
        }
      });
    };
    const take = (option: AssetOption) => {
      input.value = String(option.value);
      objective.target = input.value;
      close();
      paintState();
      this.touched(path, wrap);
    };
    const open = () => {
      const typed = lower(input.value).trim();
      // Names that start with what was typed come first, then those that hold it.
      const found = items.filter((o) => !typed || lower(o.label).includes(typed));
      found.sort((a, b) => Number(lower(b.label).startsWith(typed)) - Number(lower(a.label).startsWith(typed)));
      matches = found.slice(0, SUGGEST_LIMIT);
      list.replaceChildren();
      // Nothing to offer, or only the name that is already there in full.
      if (matches.length === 0 || (matches.length === 1 && lower(matches[0].label) === typed)) return close();
      matches.forEach((option, index) => {
        const row = el("button", "tl-suggest-row");
        row.type = "button";
        row.id = `${id}-option-${index}`;
        row.tabIndex = -1;
        row.setAttribute("role", "option");
        row.append(thumb(option.image, { fallback: "box", missing: this.missingIcon(), ...(option.quality ? { quality: option.quality } : {}) }), el("span", "tl-suggest-name", option.label));
        // The field keeps the keyboard: the row is picked without taking the focus.
        row.addEventListener("mousedown", (e) => e.preventDefault());
        row.addEventListener("click", () => take(option));
        list.appendChild(row);
      });
      if (found.length > matches.length) list.appendChild(el("div", "tl-suggest-none", `${count(found.length - matches.length, "more match", "more matches")}. Type more of the name.`));
      list.hidden = false;
      active = -1;
      input.setAttribute("aria-expanded", "true");
    };

    input.addEventListener("input", () => {
      objective.target = input.value;
      paintState();
      this.touched(path, wrap);
      open();
    });
    input.addEventListener("focus", open);
    input.addEventListener("click", () => {
      if (list.hidden) open();
    });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (list.hidden) open();
        if (matches.length === 0) return;
        e.preventDefault();
        mark((active + (e.key === "ArrowDown" ? 1 : matches.length - (active < 0 ? 0 : 1))) % matches.length);
      } else if (e.key === "Enter" && !list.hidden && active >= 0) {
        e.preventDefault();
        take(matches[active]);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault();
        close();
      }
    });
    input.setAttribute("aria-expanded", "false");
    paintState();
    const wrong = this.errorAt(path);
    if (wrong) setFieldError(wrap, wrong);
    return wrap;
  }

  /** Something was changed that is not one field: an entry added, moved or removed. */
  private changed(): void {
    this.dirty = true;
    this.refused = false;
    this.edits++;
  }

  /** The field was edited: there is something to save, and its old problem no longer describes it. */
  private touched(path: string, wrap: HTMLElement | null): void {
    this.changed();
    if (this.problems.some((p) => p.path === path)) {
      this.problems = this.problems.filter((p) => p.path !== path);
      setFieldError(wrap, null);
    }
    this.shell.setProblems(this.problemLines(), false);
    this.chrome();
    this.paintLive();
  }

  /** Puts the keyboard in a field once the page drawn just now has settled. */
  private focusLater(path: string): void {
    queueMicrotask(() => this.shell.focusField(path));
  }

  // ----------------------------------------------------------------- opening

  /** True when the open quest can be left: it has no unsaved changes, or the admin agreed to lose them. */
  private async mayLeave(): Promise<boolean> {
    return !this.dirty || !this.draft || this.shell.discard(this.titleOf(this.draft));
  }

  private open(draft: any, id: number | null, dirty: boolean): void {
    this.editingId = id;
    this.draft = draft;
    this.dirty = dirty;
    this.refused = false;
    this.clearProblems();
    this.opened++;
    this.renderList();
    this.renderForm();
  }

  private async select(id: number): Promise<void> {
    if (!(await this.mayLeave())) return;
    // A search still waiting on the typing is forgotten: its results would
    // redraw the list in the middle of the click.
    this.shell.takeQuery();
    const quest = this.results.find((q: any) => Number(q.id) === id) ?? (this.data.quests ?? []).find((q: any) => Number(q.id) === id);
    if (!quest) return;
    this.open(this.editableCopy(quest), id, false);
  }

  private async newEntry(): Promise<void> {
    if (!(await this.mayLeave())) return;
    this.tab = "general";
    this.open(this.blank(), null, true);
    this.shell.focusField("name");
  }

  /** Start a new, unsaved quest copied from a list row. */
  private async duplicate(quest: any): Promise<void> {
    if (!quest || !(await this.mayLeave())) return;
    const copy = this.editableCopy(quest);
    copy.id = null;
    copy.clientKey = this.newClientKey();
    copy.name = `${copy.name} copy`;
    this.tab = "general";
    this.open(copy, null, true);
    // The copy wants a name of its own before it is saved.
    this.shell.focusField("name");
  }

  // ----------------------------------------------------------------- actions

  private save(): void {
    if (!this.draft || this.pending) return;
    const payload = { ...this.draft };
    if (this.editingId !== null) payload.id = this.editingId;
    this.beginRequest("save", "QUEST_EDITOR_SAVE", payload, this.editingId, this.titleOf(this.draft));
  }

  /** Delete a quest, from its list row or the top bar. It is closed, if it is the open one, once the server has deleted it. */
  private async deleteEntry(quest: any): Promise<void> {
    const id = Number(quest?.id);
    if (quest?.id === null || quest?.id === undefined || !Number.isFinite(id) || this.pending) return;
    const name = String(quest.name ?? "").trim() || `quest #${id}`;
    const agreed = await this.shell.confirmDelete(name, [
      "This cannot be undone.",
      "Players who are on it lose it, with what they had done for it. Quests that needed it first, or led to it, are no longer tied to it.",
    ]);
    if (!agreed || this.pending) return;
    this.beginRequest("delete", "QUEST_EDITOR_DELETE", { questId: id }, id, name);
  }

  private beginRequest(kind: "save" | "delete", packet: string, data: any, id: number | null, name: string): void {
    const asked: Asked = { kind, id, name, adds: kind === "save" && id === null, opened: this.opened, edits: this.edits };
    this.pending = asked;
    this.late = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // No result ever comes back if the server rejects the packet outright
    // (permissions, for one): do not leave the buttons blocked forever.
    this.pendingTimer = setTimeout(() => {
      if (this.pending !== asked) return;
      this.late = asked;
      this.endRequest();
      if (kind === "save" && asked.opened === this.opened) this.refused = true;
      this.chrome();
      toast("The server did not answer in time, so nothing was confirmed.", "error");
    }, 15000);
    this.shell.send({ type: "request", packet, data });
    this.chrome();
  }

  private endRequest(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.chrome();
  }
}

new QuestEditorBridge();
