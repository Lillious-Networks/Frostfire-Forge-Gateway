// NPC editor popup. Talks to the game window over postMessage; the game
// window owns the NPCs of the map the admin stands on, shows them in the
// world (where they are placed, dragged and clicked) and sends what is saved
// on to the server. The window itself is the shared workbench (tooleditor.ts);
// this file holds what is the NPC editor's own: its fields, the NPC said in
// plain words, and its conversation with the game window.
//
// That conversation is not like the other editors': there is no search on the
// server and no result of a save. The game window sends the whole list
// whenever it changes, and a save or a delete is known to have gone through
// when the list that comes back shows it.
import { EditorShell, type ListRow } from "./tooleditor.js";
import { FieldRenderer, coinWords, orderFields, sheetOptions, type AssetOption, type Field } from "./toolfields.js";
import { button, card, confirmDialog, count, el, empty, iconButton, listed, tag, thumb, toast, tooltip } from "./toolkit.js";
import { manyField, type Choice } from "./questnpcparts.js";
import { Completer, GOSSIP_RULES, SCRIPT_RULES, type CompleterRules } from "./npceditorcomplete.js";

const TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "content", label: "Dialogue" },
  { id: "quests", label: "Quests" },
  { id: "vendor", label: "Vendor & Inn" },
  { id: "effects", label: "Effects" },
];
/** How many different items one vendor stocks: the server's limit. */
const STOCK_MAX = 40;
/** What a newly stocked item costs, as a multiple of what vendors pay for it, until a price is set. */
const MARKUP = 4;
const FACINGS = ["down", "up", "left", "right"];
const FACING_WORDS: Record<string, string> = { down: "Down", up: "Up", left: "Left", right: "Right" };
const SPRITE_WORDS: Record<string, string> = { animated: "Animated", static: "Static", none: "None" };
/** The sprite sheets an animated NPC wears over its body and head. */
const WORN: Array<{ key: string; label: string; slot: string }> = [
  { key: "sprite_helmet", label: "Helmet", slot: "helmet" },
  { key: "sprite_shoulderguards", label: "Shoulders", slot: "shoulderguards" },
  { key: "sprite_neck", label: "Neck", slot: "neck" },
  { key: "sprite_hands", label: "Gloves", slot: "hands" },
  { key: "sprite_chest", label: "Chest", slot: "chest" },
  { key: "sprite_feet", label: "Boots", slot: "feet" },
  { key: "sprite_legs", label: "Pants", slot: "legs" },
  { key: "sprite_weapon", label: "Weapon", slot: "weapon" },
];
/** With no answer for this long, the page stops waiting and says so. */
const ANSWER_MS = 15000;
/** How long the list waits for the map's NPCs before it says there are none. */
const SETTLE_MS = 2500;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const dialogOpen = (): boolean => !!document.querySelector("dialog[open]");

/** Listings under an `animations` folder are animations, not sprite sheets an NPC can wear. */
function inAnimationsFolder(option: AssetOption): boolean {
  const inFolder = (path: unknown) => typeof path === "string" && /(^|[\\/])animations[\\/]/i.test(path);
  return inFolder(option.value) || inFolder(option.image);
}

/** What is edited that is not one plain value of the NPC. */
interface Edit {
  direction: string;
  given: number[];
  ended: number[];
  particles: string[];
  /** What the NPC sells: each item's name, and what one costs there, in copper. */
  stock: Array<{ item: string; price: number }>;
}

/** An item as the stock picker knows it. */
interface StockChoice { name: string; icon: string | null; quality: string | null; sell_price: number }

class NpcEditorBridge {
  private npcs: any[] = [];
  private availableParticles: string[] = [];
  private availableQuests: Array<{ id: number; name: string }> = [];
  private availableItems: StockChoice[] = [];
  private spriteData: { spriteSheets: Record<string, Array<{ name: string; image: string | null }>>; icons: Array<{ name: string; image: string | null }> } = { spriteSheets: {}, icons: [] };
  private selectedNpcId: number | null = null;
  /**
   * A private copy of the open NPC, never the object the game window owns:
   * the fields edit this in place, and the game window replaces its own rows
   * on every refresh.
   */
  private draft: any = null;
  private edit: Edit = { direction: "down", given: [], ended: [], particles: [], stock: [] };
  /** The row the draft was copied from, as text: a refresh that brings the same row again changes nothing. */
  private source = "";
  /** Unsaved edits live in the draft; a refresh must not overwrite them. */
  private dirty = false;
  /**
   * The NPCs changed here, or moved in the world, and not saved since. The
   * game window keeps such changes with the NPC while the editor is open, so
   * they are still there, unsaved, when the NPC is opened again.
   */
  private unsaved = new Set<number | null>();
  /** The NPCs whose last save was never seen to arrive. */
  private unconfirmed = new Set<number | null>();
  /** The open tab, kept across refreshes, across NPCs and from one visit to the next. */
  private tab = "general";
  /** Slots and counts of the sprite data last drawn, to skip pointless redraws. */
  private spriteSignature = "";
  /** The game window has answered. */
  private ready = false;
  /** The map's NPCs have arrived, or enough time has passed to say there are none. */
  private settled = false;
  /** Counts the NPCs opened, so the page knows a redraw from a different one. */
  private opened = 0;
  /** The page was not drawn again because a dialog was open over it; it is once the dialog has closed. */
  private stale = false;

  // The game window relays no result of a save or a delete, only the list as
  // it is afterwards: each is waited for here until the list shows it.
  private saving: { id: number | null; label: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The NPCs being deleted, by id: several can be on their way at once. */
  private deleting = new Map<number, { label: string; timer: ReturnType<typeof setTimeout> }>();
  private discarding: string | null = null;

  /** The parts of the page that follow the fields, and the world, as they change. */
  private summaryEl: HTMLElement | null = null;
  private placeEl: HTMLElement | null = null;
  /** The fields of where the open NPC stands, across and down: they follow it as it is moved in the world. */
  private placeInputs: Array<HTMLInputElement | null> = [];
  private headThumb: { key: string; node: HTMLElement } | null = null;
  private completer = new Completer();

  private shell = new EditorShell({
    tool: "NPC Editor", noun: "NPC", plural: "NPCs", icon: "user", tabs: TABS,
    // The NPCs of the map are all here: a search only narrows the list, at every key.
    onSearch: () => this.renderList(),
    liveSearch: true,
    onNew: () => void this.createNpc(),
    onSave: () => this.saveNpc(),
    // An NPC is placed in the world, one at a time: there is nothing to duplicate, so no onDuplicate.
    onDelete: () => void this.deleteNpc(this.npcs.find((n: any) => n.id === this.selectedNpcId)),
    onTab: (id) => this.switchTab(id),
  });

  private fields = new FieldRenderer({
    assetOptions: (field, value) => field.type === "sheet"
      ? sheetOptions(this.spriteData.spriteSheets, field.slot || "other", String(value ?? "")).filter((option) => !inAnimationsFolder(option))
      : field.assets?.() ?? [],
    rerender: () => this.renderForm(),
  });

  constructor() {
    const page = document.getElementById("tl-page")!;
    // The shell writes the tool's name in small letters in its sentences; "NPC" keeps its capitals.
    new MutationObserver(() => {
      for (const node of page.querySelectorAll(".tl-screen-title, .tl-screen-text")) {
        if (node.textContent?.includes("npc editor")) node.textContent = node.textContent.replace(/npc editor/g, "NPC editor");
      }
    }).observe(page, { childList: true, subtree: true });
    // A dialog that closes leaves the page free to be drawn again, if it was waiting to be.
    new MutationObserver(() => {
      if (this.stale && !dialogOpen()) this.renderForm();
    }).observe(document.body, { childList: true });
    page.addEventListener("scroll", () => this.completer.hide());
    tooltip(document.querySelector<HTMLElement>("#tl-side .tl-side-tools > .tl-btn")!, "Places a new NPC where your character stands");

    try {
      const kept = localStorage.getItem("ne-tab-preference");
      if (kept && TABS.some((tab) => tab.id === kept)) this.tab = kept;
    } catch { /* storage unavailable */ }

    // Saying it is ready again makes the game window send everything again.
    this.shell.waiting(() => this.shell.send({ type: "bridgeReady" }));
    this.shell.connect((msg) => this.onMessage(msg));
  }

  private send(msg: any): void {
    this.shell.send(msg);
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case "init": this.handleInit(msg); break;
      case "npcListUpdate": this.onList(msg); break;
      case "npcSelectUpdate": if (msg.npc) this.onSelected(msg); break;
      case "particleOptions":
        this.availableParticles = msg.particles || [];
        if (this.draft && this.tab === "effects") this.redraw();
        break;
      case "positionUpdate": this.onMoved(msg); break;
      case "close": window.close(); break;
    }
  }

  private handleInit(msg: any): void {
    this.npcs = msg.npcs || [];
    this.availableParticles = msg.particles || [];
    if (msg.quests) this.setAvailableQuests(msg.quests);
    this.setAvailableItems(msg.items);
    this.storeSpriteData(msg);
    this.ready = true;
    this.shell.arrived();
    // The game window answers at once, with whatever it has: the map's NPCs may still be on their way.
    if (this.npcs.length > 0) this.settled = true;
    else if (!this.settled) {
      setTimeout(() => {
        if (this.settled) return;
        this.settled = true;
        this.renderList();
      }, SETTLE_MS);
    }
    if (msg.selectedNpc) {
      this.selectedNpcId = msg.selectedNpcId;
      this.setDraft(msg.selectedNpc);
      // The game window knows it was changed, or moved, and not saved.
      if (msg.isDirty) this.unsaved.add(this.selectedNpcId);
      this.opened++;
    } else if (this.npcs.length > 0 && !this.selectedNpcId) {
      return this.selectNpc(this.npcs[0]);
    }
    this.renderList();
    this.renderForm();
  }

  /** The list as it is now: after a save, a delete, a drag in the world, or another admin's change. */
  private onList(msg: any): void {
    this.npcs = msg.npcs || [];
    this.settled = true;
    let redraw = msg.quests ? this.setAvailableQuests(msg.quests) : false;
    redraw = this.setAvailableItems(msg.items) || redraw;
    redraw = this.storeSpriteData(msg) || redraw;
    const dropped = this.dropDeletedSelection();
    redraw = this.refreshDraftFromList() || redraw;
    for (const id of [...this.unsaved]) if (!this.npcs.some((n: any) => n.id === id)) this.unsaved.delete(id);
    for (const id of [...this.unconfirmed]) if (!this.npcs.some((n: any) => n.id === id)) this.unconfirmed.delete(id);
    this.settlePending();
    this.renderList();
    if (dropped) this.renderForm();
    else if (redraw && this.draft) this.redraw();
    else this.chrome();
  }

  /** The game window says which NPC is open: the one picked here, or one clicked or dragged in the world. */
  private onSelected(msg: any): void {
    // A new NPC that has just been saved comes back with the id the server gave it: it is still the same one.
    const adopted = !!this.draft && this.selectedNpcId === null && this.saving?.id === null && msg.npc.id !== null;
    const another = !this.draft || (this.selectedNpcId !== msg.npc.id && !adopted);
    let redraw = msg.quests ? this.setAvailableQuests(msg.quests) : false;
    redraw = this.setAvailableItems(msg.items) || redraw;
    redraw = this.storeSpriteData(msg) || redraw;
    // The answer to an NPC picked here is mostly the row it was opened from: then there is nothing to do.
    if (!another && !adopted && !this.dirty && JSON.stringify(msg.npc) === this.source) {
      if (redraw) this.redraw();
      return;
    }
    // A dialog left open would go on working on the draft that was there before.
    this.closeDialogs();
    if (adopted) {
      this.unsaved.delete(null);
      this.saving!.id = msg.npc.id;
    }
    this.selectedNpcId = msg.npc.id;
    this.setDraft(msg.npc);
    if (another) this.opened++;
    this.renderList();
    this.renderForm();
    if (another) this.showSelection();
  }

  /** The open NPC is being dragged in the world: follow it. Where it is let go is not saved until Save is pressed. */
  private onMoved(msg: any): void {
    if (this.selectedNpcId !== msg.id || !this.draft) return;
    if (!this.draft.position) this.draft.position = {};
    this.draft.position.x = msg.x;
    this.draft.position.y = msg.y;
    const marked = this.unsaved.has(msg.id);
    this.unsaved.add(msg.id);
    this.chrome();
    this.paintLive();
    if (!marked) this.renderList();
  }

  /** A detached copy, so edits survive the game window replacing its own rows. */
  private setDraft(npc: any): void {
    this.draft = npc ? clone(npc) : null;
    this.source = npc ? JSON.stringify(npc) : "";
    this.dirty = false;
    if (!this.draft) return;
    const facing = this.draft.position?.direction || this.draft.direction || "down";
    const ids = (list: unknown) => (Array.isArray(list) ? list : []).map(Number);
    this.edit = {
      // A facing the game does not know is saved as "down", as it always was.
      direction: FACINGS.includes(facing) ? facing : "down",
      given: ids(this.draft.questsGiven),
      ended: ids(this.draft.questsEnded),
      particles: this.normalizeParticleNames(this.draft.particles),
      stock: (Array.isArray(this.draft.vendor_items) ? this.draft.vendor_items : [])
        .map((entry: any) => ({ item: String(entry?.item ?? ""), price: Math.max(0, Math.floor(Number(entry?.price) || 0)) })),
    };
  }

  /**
   * Re-sync the draft with the refreshed list. Unsaved edits win: a list update
   * can arrive because any player on this map changed an NPC, and that must not
   * throw away what is being typed.
   */
  private refreshDraftFromList(): boolean {
    if (this.dirty || this.selectedNpcId === null) return false;
    const fresh = this.npcs.find((n: any) => n.id === this.selectedNpcId);
    if (!fresh) return false;
    // Most list updates are about some other NPC. Drawing the page again then
    // would be for nothing. Nor under an open picker: what is picked there
    // goes into the draft it was opened on.
    if (JSON.stringify(fresh) === this.source || dialogOpen()) return false;
    this.setDraft(fresh);
    return true;
  }

  /** Whether anything in the sprite lists changed, so the page is only drawn again when it did. */
  private storeSpriteData(msg: any): boolean {
    if (msg.spriteSheets) this.spriteData.spriteSheets = msg.spriteSheets;
    if (msg.icons) this.spriteData.icons = msg.icons;
    const sheets = this.spriteData.spriteSheets ?? {};
    const signature = Object.keys(sheets).sort()
      .map((slot) => `${slot}:${(sheets[slot] ?? []).length}`).join(",")
      + `|${(this.spriteData.icons ?? []).length}`;
    if (signature === this.spriteSignature) return false;
    this.spriteSignature = signature;
    this.headThumb = null;
    return true;
  }

  /** The items there are, for the stock picker. Whether the list changed, so the page is only drawn again when it did. */
  private setAvailableItems(items: unknown): boolean {
    if (!Array.isArray(items)) return false;
    const next: StockChoice[] = items
      .filter((item: any) => item && typeof item.name === "string" && item.name)
      .map((item: any) => ({ name: item.name, icon: item.icon ?? null, quality: item.quality ?? null, sell_price: Math.max(0, Math.floor(Number(item.sell_price ?? 1) || 0)) }));
    const changed = JSON.stringify(next) !== JSON.stringify(this.availableItems);
    this.availableItems = next;
    return changed;
  }

  private setAvailableQuests(quests: any): boolean {
    const list = Array.isArray(quests) ? quests : [];
    const next = list
      .filter((q: any) => q && q.id !== undefined && q.id !== null)
      .map((q: any) => ({ id: Number(q.id), name: String(q.name ?? ("Quest #" + q.id)) }))
      .sort((a: any, b: any) => a.id - b.id);
    const changed = JSON.stringify(next) !== JSON.stringify(this.availableQuests);
    this.availableQuests = next;
    return changed;
  }

  /**
   * The open NPC is gone from the list (deleted from its row, elsewhere, or an
   * unsaved one discarded): close it instead of editing something that no
   * longer exists.
   */
  private dropDeletedSelection(): boolean {
    if (!this.draft) return false;
    if (this.npcs.some((n: any) => n.id === this.selectedNpcId)) return false;
    const label = this.liveLabel();
    const ours = this.selectedNpcId === null ? this.discarding !== null : this.deleting.has(this.selectedNpcId);
    this.closeDialogs();
    this.selectedNpcId = null;
    this.draft = null;
    this.dirty = false;
    if (!ours) toast(`${label} is no longer on this map, so it has been closed here.`, "warning");
    return true;
  }

  /** What was asked for and has now happened: the list that came back shows it. */
  private settlePending(): void {
    if (this.saving) {
      clearTimeout(this.saving.timer);
      toast(`Saved ${this.saving.label}.`);
      this.saving = null;
    }
    for (const [id, asked] of [...this.deleting]) {
      if (this.npcs.some((n: any) => n.id === id)) continue;
      clearTimeout(asked.timer);
      toast(`Deleted ${asked.label}.`);
      this.deleting.delete(id);
    }
    if (this.discarding !== null && !this.npcs.some((n: any) => n.id === null)) {
      toast(`Discarded ${this.discarding}.`);
      this.discarding = null;
    }
  }

  private closeDialogs(): void {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
  }

  // ------------------------------------------------------------------- words

  /** Named NPCs show their name; only unnamed ones fall back to NPC #id. */
  private npcLabel(npc: any): string {
    const name = typeof npc?.name === "string" ? npc.name.trim() : "";
    if (name) return name;
    return npc?.id === null || npc?.id === undefined ? "Unsaved NPC" : "NPC #" + npc.id;
  }

  /** The open NPC's name as it is being typed. */
  private liveLabel(): string {
    return this.npcLabel({ id: this.selectedNpcId, name: String(this.draft?.name ?? "") });
  }

  /** Where an NPC stands, to the pixel: "x 1204, y 388". */
  private placeOf(npc: any): string {
    return npc?.position ? `x ${Math.round(npc.position.x || 0)}, y ${Math.round(npc.position.y || 0)}` : "no position yet";
  }

  private isUnsaved(): boolean {
    return this.dirty || this.unsaved.has(this.selectedNpcId);
  }

  private normalizeParticleNames(particles: any): string[] {
    if (!Array.isArray(particles)) return [];
    return particles
      .map((p) => (typeof p === "string" ? p : (p && p.name ? p.name : null)))
      .filter((p): p is string => !!p);
  }

  private iconImage(name: unknown): string | null {
    return (this.spriteData.icons ?? []).find((i) => i.name === name)?.image ?? null;
  }

  /** An NPC's picture: its static image where it has one, a figure otherwise. */
  private thumbOf(npc: any, size: "" | "lg" | "xl" = ""): HTMLElement {
    const still = String(npc?.sprite_type ?? "") === "static";
    return thumb(still ? this.iconImage(npc.sprite_body) : null, { size, fallback: still ? "image" : "user" });
  }

  // ------------------------------------------------------------------ render

  private renderList(): void {
    if (!this.ready) return;
    if (!this.settled) return this.shell.setList({ rows: [], loading: true });
    this.shell.setCount(this.npcs.length);
    const q = this.shell.query.toLowerCase();
    const rows: ListRow[] = [];
    for (const npc of this.npcs) {
      const open = !!this.draft && npc.id === this.selectedNpcId;
      const label = open ? this.liveLabel() : this.npcLabel(npc);
      if (q && label.toLowerCase().indexOf(q) === -1 && (!npc.name || String(npc.name).toLowerCase().indexOf(q) === -1)) continue;
      const fresh = npc.id === null || npc.id === undefined;
      const tags: HTMLElement[] = [];
      if (fresh) tags.push(tag("New", "warning"));
      else if (this.unsaved.has(npc.id) || (open && this.dirty)) tags.push(tag("Unsaved", "warning"));
      if ((open ? this.draft : npc).hidden) tags.push(tag("Hidden", "muted", "eyeOff"));
      rows.push({
        id: fresh ? "\u0000new" : String(npc.id), name: label,
        note: `${fresh ? "Not saved yet" : `#${npc.id}`} · ${this.placeOf(open ? this.draft : npc)}`,
        thumb: this.thumbOf(open ? this.draft : npc), tags, selected: open,
        actions: [{ icon: "trash", label: `${fresh ? "Discard" : "Delete"} ${label}`, danger: true, onClick: () => void this.deleteNpc(npc) }],
        onOpen: () => this.selectNpc(npc),
      });
    }
    this.shell.setList({
      rows,
      empty: q
        ? { icon: "search", title: "No NPCs match that search", text: "Check the spelling, or search for less of the name." }
        : { title: "No NPCs on this map yet", text: "Place the first one with New NPC: it appears where your character stands." },
    });
  }

  /** Bring the open NPC's row into view, as when it was picked in the world. */
  private showSelection(): void {
    document.querySelector("#tl-side .tl-list-row.is-selected")?.scrollIntoView({ block: "nearest" });
  }

  /** The top bar, the banner and the tabs: which NPC is open, how it stands, and what can be done to it. */
  private chrome(): void {
    const d = this.draft;
    const { shell } = this;
    if (!d) {
      shell.setRecord(null);
      shell.setState(null);
      shell.setActions({ open: false });
      shell.setTabs(null);
      shell.setBanner(null);
      return;
    }
    const fresh = this.selectedNpcId === null;
    // The picture is only drawn again when it changes, not at every key typed.
    const looks = `${d.sprite_type}:${d.sprite_body}`;
    if (this.headThumb?.key !== looks) this.headThumb = { key: looks, node: this.thumbOf(d, "lg") };
    shell.setRecord({ title: this.liveLabel(), note: `${fresh ? "Not saved yet" : `NPC #${this.selectedNpcId}`} · ${this.placeOf(d)}`, thumb: this.headThumb.node });

    const saving = !!this.saving && this.saving.id === this.selectedNpcId;
    const deleting = !fresh && this.deleting.has(this.selectedNpcId!);
    if (saving) shell.setState("saving");
    else if (deleting) shell.setState("deleting");
    else if (this.unconfirmed.has(this.selectedNpcId)) shell.setState("unconfirmed");
    else shell.setState(fresh ? "new" : this.isUnsaved() ? "unsaved" : "saved");

    shell.setActions({
      open: true, dirty: fresh || this.isUnsaved(),
      busy: saving ? "save" : deleting ? "delete" : null,
      // An NPC that was never saved is discarded, not deleted: the button says which.
      ...(fresh ? { deleteTip: "Discard this NPC: it was never saved" } : {}),
    });
    shell.setTabs(this.tab);
    shell.setBanner(fresh
      ? { tone: "info", icon: "pin", text: "This NPC stands where your character stood when you placed it. Drag it in the game window to move it. It is only kept once you save it." }
      : null);
  }

  private switchTab(tab: string): void {
    this.tab = tab;
    try { localStorage.setItem("ne-tab-preference", tab); } catch { /* storage unavailable */ }
    this.renderForm();
  }

  /** Draws the page again, unless a dialog is open over it: then it waits until the dialog has closed. */
  private redraw(): void {
    if (dialogOpen()) {
      this.stale = true;
      this.chrome();
    } else this.renderForm();
  }

  private renderForm(): void {
    this.stale = false;
    this.completer.hide();
    this.chrome();
    this.summaryEl = this.placeEl = null;
    this.placeInputs = [];
    if (!this.ready) return;
    if (!this.draft) {
      const box = this.shell.idle(
        "Pick an NPC from the list on the left or click one in the game window, or place a new one where your character stands.",
        this.npcs.length === 0 ? "This map has none. Place the first one where your character stands." : null,
      );
      box.appendChild(button("New NPC", () => void this.createNpc(), { icon: "plus", kind: "primary" }));
      return;
    }
    const { main, aside } = this.shell.page(`${this.opened}:${this.tab}`, { aside: true });

    if (this.tab === "appearance") this.renderAppearance(main);
    else if (this.tab === "content") this.renderContent(main);
    else if (this.tab === "quests") this.renderQuests(main);
    else if (this.tab === "vendor") this.renderVendor(main);
    else if (this.tab === "effects") this.renderEffects(main);
    else this.renderGeneral(main);

    // The NPC in plain words, beside the form on every tab.
    const { body } = card(aside, "At a glance", "The NPC as players find it");
    this.summaryEl = el("div", "tl-summary ne-summary");
    body.appendChild(this.summaryEl);
    this.paintLive();
  }

  private renderGeneral(main: HTMLElement): void {
    const d = this.draft;
    const who = this.section(main, "NPC", "What it is called");
    who.appendChild(this.field({ key: "name", label: "Name", type: "text", maxLength: 64, hint: "What players see the NPC called. Leave it empty for an NPC without a name." }, d, "name"));

    const placement = card(main, "Placement", "Where the NPC stands and which way it faces");
    const facts = el("div", "tl-facts ne-place");
    const fact = (label: string, value: string, note = "") => {
      const box = el("div", "tl-fact");
      const said = el("div", "tl-fact-value", value);
      box.append(el("div", "tl-fact-label", label), said);
      if (note) box.appendChild(el("div", "tl-fact-note", note));
      facts.appendChild(box);
      return said;
    };
    fact("Map", d.map ? String(d.map) : "The map you are on", d.map ? "" : "Set when the NPC is saved.");
    this.placeEl = fact("Position", this.placeOf(d), "Drag the NPC in the game window, type where it stands, or bring it to you.");
    // Where it stands can be typed, and it can be brought to where the admin's character is: an NPC that has ended
    // up off the map, or anywhere it cannot be reached, cannot be dragged back (USER REQUEST 2026-10-07: "Add a
    // 'Bring to' button to NPCs and editable position fields"). Like a drag, neither is saved until Save is pressed.
    if (!d.position) d.position = {};
    const spot = el("div", "tl-fields ne-spot");
    const across = this.field({ key: "x", label: "X", type: "number", unit: "px", hint: "Across the map, from its left edge." }, d.position, "position.x");
    const down = this.field({ key: "y", label: "Y", type: "number", unit: "px", hint: "Down the map, from its top edge." }, d.position, "position.y");
    this.placeInputs = [across.querySelector("input"), down.querySelector("input")];
    const bring = el("div", "tl-field ne-bring");
    bring.appendChild(button("Bring to me", () => this.send({ type: "bringNpc", id: this.selectedNpcId }), { icon: "pin", tip: "Puts the NPC where your character stands" }));
    spot.append(across, down, bring);
    const grid = el("div", "tl-fields");
    placement.body.append(facts, spot, grid);
    grid.appendChild(this.field(
      { key: "direction", label: "Facing", type: "segmented", options: () => FACINGS.map((value) => ({ value, label: FACING_WORDS[value] })) },
      this.edit, "direction"
    ));
    grid.appendChild(this.field({ key: "hidden", label: "Hidden", type: "switch", hint: "Hidden NPCs are not shown to players." }, d, "hidden"));
  }

  /**
   * Appearance: the same sprite tools as the creature editor, mapped onto NPC
   * keys. The body sheet and the static image both live in sprite_body; NPCs
   * have no scale.
   */
  private renderAppearance(main: HTMLElement): void {
    const d = this.draft;
    const spriteType = String(d.sprite_type ?? "none");
    const how: Record<string, string> = {
      animated: "Drawn from sprite sheets, one over the other, as a player is.",
      static: "Drawn as one still image.",
      none: "Nothing is drawn where the NPC stands.",
    };
    const shape: Field[] = [
      { key: "sprite_type", label: "Sprite type", type: "segmented", options: () => Object.entries(SPRITE_WORDS).map(([value, label]) => ({ value, label })), rerender: true, wide: true, hint: how[spriteType] ?? "" },
      ...(spriteType === "static"
        ? [{
            key: "sprite_body", label: "Static image", type: "asset", rerender: true,
            assets: () => [
              { value: "", label: "None" },
              ...(this.spriteData.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image })),
            ],
          } as Field]
        : []),
      ...(spriteType === "animated"
        ? ([
            { key: "sprite_body", label: "Body sheet", type: "sheet", slot: "body", noIcons: true, rerender: true },
            { key: "sprite_head", label: "Head sheet", type: "sheet", slot: "head", noIcons: true, rerender: true },
          ] as Field[])
        : []),
    ];
    const sprite = this.section(main, "Sprite", "How the NPC is drawn in the world");
    for (const field of orderFields(shape)) sprite.appendChild(this.field(field, d, field.key));

    if (spriteType !== "animated") return;
    const worn = this.section(main, "Worn", "Sprite sheets drawn over the body and head");
    for (const piece of WORN) worn.appendChild(this.field({ key: piece.key, label: piece.label, type: "sheet", slot: piece.slot, rerender: true }, d, piece.key));
  }

  private renderContent(main: HTMLElement): void {
    const d = this.draft;
    const says = this.section(main, "Dialogue", "What the NPC says to players");
    says.appendChild(this.field(
      { key: "dialog", label: "Says when clicked", type: "textarea", maxLength: 500, rows: 3, hint: "What the NPC says to a player who clicks it. Up to 500 characters." },
      d, "dialog"
    ));
    says.appendChild(this.completed(
      { key: "gossip", label: "Gossip chain", type: "textarea", maxLength: 5000, rows: 5, hint: "One line per step; the NPC cycles through them over time. Type ${ to insert a detail of the player, for example ${player.name}." },
      "gossip", GOSSIP_RULES
    ));

    const script = this.section(main, "Script", "Code the game runs for this NPC");
    const code = this.completed(
      { key: "script", label: "Script", type: "textarea", maxLength: 5000, rows: 6, hint: "Runs with the NPC as `this`, so its own members need no prefix: dialogue(), show(). Up to 5,000 characters." },
      "script", SCRIPT_RULES
    );
    code.querySelector("textarea")!.classList.add("ne-code");
    script.appendChild(code);
  }

  private renderQuests(main: HTMLElement): void {
    const quests = this.section(main, "Quests", "Quests this NPC hands out and takes back");
    quests.appendChild(this.field(
      { key: "quest_giver", label: "Quest giver", type: "switch", wide: true, hint: "Only quest givers can be given quests, here or in the quest editor." },
      this.draft, "quest_giver"
    ));
    const choices = (): Choice<number>[] => this.availableQuests.map((q) => ({ value: q.id, label: q.name, mark: `#${q.id}`, note: `#${q.id}` }));
    quests.appendChild(manyField<number>({
      path: "questsGiven", label: "Gives these quests", noun: "quest", choices, gone: "this quest no longer exists, so it is left out when the NPC is saved",
      get: () => this.edit.given,
      set: (next) => {
        this.edit.given = next;
        this.touched("questsGiven");
      },
    }));
    quests.appendChild(manyField<number>({
      path: "questsEnded", label: "Takes these quests back", noun: "quest", choices, gone: "this quest no longer exists, so it is left out when the NPC is saved",
      get: () => this.edit.ended,
      set: (next) => {
        this.edit.ended = next;
        this.touched("questsEnded");
      },
    }));
  }

  /** The items to stock, each with its icon in its quality's frame. */
  private itemOptions(): AssetOption[] {
    const images = new Map((this.spriteData.icons ?? []).map((entry) => [entry.name, entry.image]));
    return this.availableItems.map((item) => ({
      value: item.name, label: item.name, image: item.icon ? images.get(item.icon) ?? null : null, quality: item.quality,
    }));
  }

  /** The item of that name, whatever its capitals: the server matches names that way too. */
  private itemNamed(name: unknown): StockChoice | undefined {
    const wanted = String(name ?? "").toLowerCase();
    return wanted ? this.availableItems.find((item) => item.name.toLowerCase() === wanted) : undefined;
  }

  /** What a stocked item is sold for, under its card's title: its price, or why the price asked is not the one charged. */
  private stockLine(entry: { item: string; price: number }): string {
    const item = this.itemNamed(entry.item);
    if (!entry.item) return "Pick the item this NPC sells.";
    if (!item) return "This item no longer exists, so it is left out when the NPC is saved.";
    if (entry.price < item.sell_price) return `Sold for ${coinWords(item.sell_price)}: never less than vendors pay for it.`;
    return entry.price > 0 ? `Sold for ${coinWords(entry.price)}. Vendors pay ${coinWords(item.sell_price)} for it.` : "Given away for nothing.";
  }

  /**
   * What the NPC sells. An NPC with anything in stock is a vendor: players
   * buy from it, and it buys what they sell at each item's own sell price
   * (set in the item editor).
   */
  private renderVendor(main: HTMLElement): void {
    // An inn is one more service an NPC offers, with or without goods.
    const inn = this.section(main, "Inn", "Where players set the home their home item returns them to");
    inn.appendChild(this.field(
      {
        key: "innkeeper", label: "Innkeeper", type: "switch", wide: true,
        hint: "Players who talk to this NPC can make its inn their home. Their home item then brings them back to where they stood when they did.",
      },
      this.draft, "innkeeper"
    ));

    const stock = this.edit.stock;
    if (stock.length === 0) {
      const none = card(main, "Vendor", "What this NPC sells to players");
      empty(none.body, "coins", "Sells nothing", "Add an item below to make this NPC a vendor. A vendor also buys what players sell, for each item's own sell price.");
    }

    stock.forEach((entry, index) => {
      const part = card(main, `Item ${index + 1} · ${entry.item || "No item picked"}`, this.stockLine(entry));
      const lead = part.root.querySelector<HTMLElement>(".tl-card-lead");
      const said = () => {
        if (lead) lead.textContent = this.stockLine(entry);
      };
      const swap = (a: number, b: number) => {
        [stock[a], stock[b]] = [stock[b], stock[a]];
      };
      const act = (name: "arrowUp" | "arrowDown" | "trash", label: string, enabled: boolean, change: () => void) => {
        const btn = iconButton(name, label, () => {
          change();
          this.touched("vendor_items");
          this.renderForm();
        }, { danger: name === "trash", size: 15 });
        btn.disabled = !enabled;
        return btn;
      };
      part.tools.append(
        act("arrowUp", `Move item ${index + 1} up`, index > 0, () => swap(index, index - 1)),
        act("arrowDown", `Move item ${index + 1} down`, index < stock.length - 1, () => swap(index, index + 1)),
        act("trash", `Remove item ${index + 1}`, true, () => stock.splice(index, 1)),
      );

      const grid = el("div", "tl-fields");
      part.body.appendChild(grid);
      grid.appendChild(this.fields.renderField(
        { key: "item", label: "Item", type: "asset", assets: () => this.itemOptions(), searchFirst: true, fallback: "box", rerender: true, path: `vendor_items.${index}.item` },
        entry,
        () => {
          // A newly picked item starts at a few times what vendors pay for it, rather than free.
          const item = this.itemNamed(entry.item);
          if (item && entry.price === 0) entry.price = item.sell_price * MARKUP;
          this.touched("vendor_items");
        }
      ));
      grid.appendChild(this.fields.renderField(
        { key: "price", label: "Price", type: "money", hint: "What one costs to buy here. Never charged at less than vendors pay for the item.", path: `vendor_items.${index}.price` },
        entry,
        () => {
          said();
          this.touched("vendor_items");
        }
      ));
    });

    const add = button("Add item", () => {
      stock.push({ item: "", price: 0 });
      this.touched("vendor_items");
      this.renderForm();
    }, { icon: "plus" });
    if (stock.length >= STOCK_MAX) {
      add.disabled = true;
      add.title = `A vendor stocks ${STOCK_MAX} items at most.`;
    }
    main.appendChild(add);
  }

  private renderEffects(main: HTMLElement): void {
    const particles = this.section(main, "Particles", "Effects that play around the NPC");
    particles.appendChild(manyField<string>({
      path: "particles", label: "Particles", noun: "particle", hint: "Made in the particle editor.",
      choices: () => this.availableParticles.map((name) => ({ value: name, label: name })),
      gone: "there is no particle of this name",
      get: () => this.edit.particles,
      set: (next) => {
        this.edit.particles = next;
        this.touched("particles");
      },
    }));
  }

  // ------------------------------------------------------------- plain words

  /** The NPC as players find it, in plain words: one sentence to a line. */
  private summary(): HTMLElement[] {
    const d = this.draft;
    const out: HTMLElement[] = [];
    const say = (text: string) => out.push(el("p", "", text));
    const fresh = this.selectedNpcId === null;

    const head = el("div", "tl-preview-head");
    const said = el("div", "tl-preview-words");
    said.append(el("span", "tl-preview-name", this.liveLabel()), el("span", "tl-preview-kind", fresh ? "NPC, not saved yet" : `NPC #${this.selectedNpcId}`));
    head.append(this.thumbOf(d, "xl"), said);
    out.push(head);

    const where = `${this.placeOf(d)}${d.map ? ` on ${d.map}` : ""}`;
    say(`Stands at ${where}, facing ${this.edit.direction}.${d.hidden ? " Hidden: players do not see it." : ""}`);

    const spriteType = String(d.sprite_type ?? "none");
    if (spriteType === "static") say(d.sprite_body ? `Drawn as the still image ${d.sprite_body}.` : "Set to a still image, but none is picked yet, so nothing is drawn.");
    else if (spriteType === "animated") {
      const worn = WORN.filter((piece) => d[piece.key]);
      if (!d.sprite_body && !d.sprite_head) say("Set to animated, but it has no body or head sheet yet.");
      else say(`Animated${d.sprite_body ? `, with the body ${d.sprite_body}` : ", with no body sheet"}${d.sprite_head ? ` and the head ${d.sprite_head}` : " and no head sheet"}.`);
      if (worn.length > 0) {
        say(`Wears ${count(worn.length, "piece")}:`);
        const layers = el("div", "ne-layers");
        for (const piece of worn) {
          const image = (this.spriteData.spriteSheets?.[piece.slot] ?? []).find((sheet) => sheet.name === d[piece.key])?.image ?? null;
          const box = thumb(image, { size: "lg", fallback: "layers" });
          box.removeAttribute("aria-hidden");
          box.setAttribute("role", "img");
          box.setAttribute("aria-label", `${piece.label}: ${d[piece.key]}`);
          tooltip(box, `${piece.label}: ${d[piece.key]}`);
          layers.appendChild(box);
        }
        out.push(layers);
      }
    } else say("Has no sprite, so nothing is drawn where it stands.");

    const dialog = String(d.dialog ?? "").trim();
    if (dialog) {
      say("When clicked, says:");
      out.push(el("p", "ne-quote", dialog));
    } else say("Says nothing when clicked.");
    const gossip = String(d.gossip ?? "").split("\n").filter((line) => line.trim()).length;
    if (gossip > 0) say(`Cycles through ${count(gossip, "line")} of gossip.`);

    const quests = (picked: number[]) => this.availableQuests.filter((q) => picked.includes(q.id)).length;
    const given = quests(this.edit.given);
    const ended = quests(this.edit.ended);
    if (given + ended === 0) say(d.quest_giver ? "A quest giver, with no quests yet." : "Not a quest giver.");
    else {
      const parts = [given > 0 ? `gives ${count(given, "quest")}` : "", ended > 0 ? `takes ${count(ended, "quest")} back` : ""].filter(Boolean);
      const does = listed(parts);
      say(`${does.charAt(0).toUpperCase()}${does.slice(1)}${d.quest_giver ? "." : ", but is not marked as a quest giver."}`);
    }

    const stocked = this.edit.stock.filter((entry) => this.itemNamed(entry.item)).length;
    if (stocked > 0) say(`A vendor: sells ${count(stocked, "item")}, and buys what players sell.`);
    if (d.innkeeper) say("An innkeeper: players can make this inn their home.");

    if (this.edit.particles.length > 0) say(`Plays ${listed(this.edit.particles)} around it.`);
    if (String(d.script ?? "").trim()) say("Runs a script.");
    return out;
  }

  /** The parts that follow the fields and the world as they change: where the NPC stands, and the summary. */
  private paintLive(): void {
    if (!this.draft) return;
    if (this.placeEl) this.placeEl.textContent = this.placeOf(this.draft);
    // The two fields follow the NPC as it is dragged or brought: not the one being typed in.
    const at = [this.draft.position?.x, this.draft.position?.y];
    this.placeInputs.forEach((input, i) => {
      if (input && document.activeElement !== input) input.value = Number.isFinite(at[i]) ? String(Math.round(at[i])) : "";
    });
    if (this.summaryEl) this.summaryEl.replaceChildren(...this.summary());
  }

  // ------------------------------------------------------------------ fields

  /** A titled card appended to `parent`; returns its field grid. */
  private section(parent: HTMLElement, title: string, lead = ""): HTMLElement {
    const grid = el("div", "tl-fields");
    card(parent, title, lead).body.appendChild(grid);
    return grid;
  }

  /** One form field editing `target[field.key]`. Every change is told to the game window, which shows it in the world. */
  private field(field: Field, target: any, path: string): HTMLElement {
    return this.fields.renderField({ ...field, path }, target, () => this.touched(path));
  }

  /** A text box of the NPC with suggestions as it is typed in: a gossip line's player details, a script's NPC members. */
  private completed(field: Field, path: string, rules: CompleterRules): HTMLElement {
    const wrap = this.field(field, this.draft, path);
    const area = wrap.querySelector("textarea")!;
    this.completer.attach(area, rules, () => {
      this.draft[field.key] = area.value;
      this.touched(path);
    });
    return wrap;
  }

  /**
   * What the game window is sent: the NPC as the form has it now. The game
   * window keeps the position (it is dragged there) and the map.
   */
  private formData(): any {
    if (this.draft === null && this.selectedNpcId === null) return null;
    const d = this.draft;
    // Text is trimmed, and nothing at all is sent as null.
    const text = (value: unknown) => (value ? String(value).trim() : null) || null;
    // Only quests that exist are sent, in the order of their ids.
    const quests = (picked: number[]) => this.availableQuests.filter((q) => picked.includes(q.id)).map((q) => q.id);
    return {
      id: this.selectedNpcId,
      map: d ? d.map : "",
      position: { x: d ? (d.position?.x || 0) : 0, y: d ? (d.position?.y || 0) : 0, direction: this.edit.direction || "down" },
      hidden: !!d?.hidden,
      quest_giver: !!d?.quest_giver,
      innkeeper: !!d?.innkeeper,
      name: text(d?.name),
      dialog: text(d?.dialog),
      gossip: text(d?.gossip),
      script: text(d?.script),
      questsGiven: quests(this.edit.given),
      questsEnded: quests(this.edit.ended),
      // Only items that exist are sent, under their own names, each once.
      vendor_items: this.edit.stock
        .map((entry) => ({ item: this.itemNamed(entry.item)?.name ?? "", price: Math.max(0, Math.floor(Number(entry.price) || 0)) }))
        .filter((entry, index, list) => entry.item && list.findIndex((other) => other.item === entry.item) === index),
      particles: this.edit.particles.slice(),
      sprite_type: d?.sprite_type || "none",
      sprite_body: d?.sprite_body ?? null,
      sprite_head: d?.sprite_head ?? null,
      sprite_helmet: d?.sprite_helmet ?? null,
      sprite_shoulderguards: d?.sprite_shoulderguards ?? null,
      sprite_neck: d?.sprite_neck ?? null,
      sprite_hands: d?.sprite_hands ?? null,
      sprite_chest: d?.sprite_chest ?? null,
      sprite_feet: d?.sprite_feet ?? null,
      sprite_legs: d?.sprite_legs ?? null,
      sprite_weapon: d?.sprite_weapon ?? null,
    };
  }

  /** Something was changed: there is something to save, and the game window is told, so the world shows it. */
  private touched(path: string): void {
    this.dirty = true;
    const marked = this.unsaved.has(this.selectedNpcId);
    this.unsaved.add(this.selectedNpcId);
    this.unconfirmed.delete(this.selectedNpcId);
    const data = this.formData();
    // (`moved`: where it stands was typed, so the game window puts the NPC there; any other field leaves it be)
    if (data) this.send({ type: "fieldUpdate", npc: data, moved: path.startsWith("position.") });
    this.chrome();
    this.paintLive();
    // The list follows the name as it is typed, and marks the NPC as changed.
    if (!marked || path === "name" || path === "hidden") this.renderList();
  }

  // ----------------------------------------------------------------- actions

  private selectNpc(npc: any): void {
    this.selectedNpcId = npc.id;
    this.setDraft(npc);
    this.opened++;
    this.renderList();
    this.renderForm();
    this.send({ type: "selectNpc", id: npc.id });
    this.showSelection();
  }

  /** Place a new NPC where the admin's character stands. The game window makes it, and opens it here. */
  private async createNpc(): Promise<void> {
    if (this.draft && this.isUnsaved() && this.selectedNpcId !== null) {
      const label = this.liveLabel();
      const agreed = await confirmDialog({
        title: `Leave ${label} unsaved?`,
        body: [
          `What you changed in ${label} has not been saved.`,
          "It stays as you left it while this editor is open, and is lost if the editor is closed before it is saved.",
        ],
        okLabel: "Place a new NPC", cancelLabel: "Keep editing", danger: false,
      });
      if (!agreed) return;
    }
    this.send({ type: "createNpc" });
    // The game window places one new NPC at a time, and does nothing while one is waiting to be saved.
    const waiting = this.npcs.find((n: any) => n.id === null);
    if (waiting) toast(`${this.npcLabel(waiting)} has not been saved yet. Save or discard it before placing another.`, "warning");
  }

  private saveNpc(): void {
    if (this.selectedNpcId === null && !this.draft) return;
    if (this.saving) return;
    const data = this.formData();
    if (!data) return;
    const id = this.selectedNpcId;
    const label = this.liveLabel();
    this.dirty = false;
    this.unsaved.delete(id);
    this.unconfirmed.delete(id);
    this.send({ type: "saveNpc", npc: data });
    const asked = {
      id, label,
      timer: setTimeout(() => {
        if (this.saving !== asked) return;
        this.saving = null;
        this.unconfirmed.add(asked.id);
        this.chrome();
        toast(`The server did not answer in time, so the save of ${label} was not confirmed.`, "error");
      }, ANSWER_MS),
    };
    this.saving = asked;
    this.chrome();
    this.renderList();
  }

  /** Delete an NPC, from its list row or the top bar. One that was never saved is just discarded. */
  private async deleteNpc(npc: any): Promise<void> {
    if (!npc) return;
    const fresh = npc.id === null || npc.id === undefined;
    if (!fresh && this.deleting.has(npc.id)) return;
    const label = npc.id === this.selectedNpcId && this.draft ? this.liveLabel() : this.npcLabel(npc);
    const agreed = await confirmDialog(fresh
      ? { title: `Discard ${label}?`, body: "It was never saved. It is taken out of the world and nothing of it is kept.", okLabel: "Discard NPC" }
      : { title: `Delete ${label}?`, body: ["This cannot be undone.", "It is removed from the world for every player."], okLabel: "Delete NPC" });
    // It may have gone, or its delete may have been asked for elsewhere, while the question was open.
    const still = this.npcs.find((n: any) => n.id === npc.id);
    if (!agreed || !still || (!fresh && this.deleting.has(npc.id))) return;
    // The game window only discards the unsaved NPC it has selected.
    if (fresh && this.selectedNpcId !== null) this.selectNpc(still);
    this.discarding = fresh ? label : this.discarding;
    this.send({ type: "deleteNpc", id: fresh ? null : npc.id });
    if (fresh) return;
    const asked = {
      label,
      timer: setTimeout(() => {
        if (this.deleting.get(npc.id) !== asked) return;
        this.deleting.delete(npc.id);
        this.chrome();
        toast(`The server did not answer in time, so ${label} was not deleted as far as this editor can tell.`, "error");
      }, ANSWER_MS),
    };
    this.deleting.set(npc.id, asked);
    this.chrome();
  }
}

new NpcEditorBridge();
