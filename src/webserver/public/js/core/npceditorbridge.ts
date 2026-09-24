import { FieldRenderer, orderFields, pick, sheetOptions, type AssetOption, type Field } from "./editorfields.js";

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

class NpcEditorBridge {
  private npcs: any[] = [];
  private availableParticles: string[] = [];
  private availableQuests: Array<{ id: number; name: string }> = [];
  private spriteData: { spriteSheets: Record<string, Array<{ name: string; image: string | null }>>; icons: AssetOption[] } = { spriteSheets: {}, icons: [] };
  private appearance = new FieldRenderer({
    assetOptions: (field, value) => field.type === "sheet"
      ? sheetOptions(this.spriteData.spriteSheets, field.slot || "other", String(value ?? ""))
      : field.assets?.() ?? [],
    rerender: () => this.renderAppearance(),
  });
  private selectedParticles: string[] = [];
  private selectedNpcId: number | null = null;
  /**
   * A private copy of the selected NPC, never the object the game window owns:
   * the appearance fields edit this in place, and the game window replaces its
   * own rows on every refresh. Same draft model as the creature editor.
   */
  private selectedNpcData: any = null;
  /** Unsaved edits live in the draft; a refresh must not overwrite them. */
  private dirty: boolean = false;
  /** The open tab, so a refresh does not drop the user back on General. */
  private tab: string = "general";
  /** Slots + counts of the sprite data last rendered, to skip pointless re-renders. */
  private spriteSignature: string = "";
  private searchQuery: string = "";
  private particleSearchQuery: string = "";

  private saveBtn: HTMLElement;
  private searchInput: HTMLInputElement;
  private npcListEl: HTMLElement;
  private particleSearchInput: HTMLInputElement;
  private particleOptionsEl: HTMLElement;
  private inputs: Record<string, HTMLElement> = {};

  constructor() {
    this.saveBtn = document.getElementById("btn-save")!;
    this.searchInput = document.getElementById("ne-npc-search") as HTMLInputElement;
    this.npcListEl = document.getElementById("ne-npc-list")!;
    this.particleSearchInput = document.getElementById("ne-particle-search") as HTMLInputElement;
    this.particleOptionsEl = document.getElementById("ne-particle-options")!;

    const formIds = ["inp-quest-giver","inp-direction","inp-hidden",
      "inp-name","inp-dialog","inp-gossip","inp-script","inp-quests-given","inp-quests-ended"];
    for (const id of formIds) {
      const el = document.getElementById(id);
      if (el) { this.inputs[id] = el; el.addEventListener("input", () => this.markDirty()); el.addEventListener("change", () => this.markDirty()); }
    }

    this.saveBtn.addEventListener("click", () => this.saveNpc());
    // Some edits flag changes without re-rendering (appearance pickers);
    // refresh the save icon after any interaction.
    for (const type of ["input", "change", "click"]) {
      document.addEventListener(type, () => queueMicrotask(() => this.updateSaveIcon()));
    }
    this.setupGossipAc();
    this.setupScriptAc();
    this.searchInput.addEventListener("input", () => { this.searchQuery = this.searchInput.value.toLowerCase(); this.renderNpcList(); });
    this.particleSearchInput.addEventListener("input", () => { this.particleSearchQuery = this.particleSearchInput.value.toLowerCase(); this.renderParticleOptions(); });

    try { this.tab = localStorage.getItem("ne-tab-preference") || this.tab; } catch { /* storage unavailable */ }
    document.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")!));
    });

    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    this.updateChrome();
    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  /**
   * Status to show once the server's change arrives: the game window relays no
   * save/delete result, only the refreshed list, so report success on that.
   */
  private statusOnListUpdate: string | null = null;

  private send(msg: any): void { if (window.opener) window.opener.postMessage(msg, "*"); }

  private onKeyDown(e: KeyboardEvent): void {
    // Ctrl+S saves from anywhere, including while typing in a field.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.saveNpc(); }
  }

  private status(text: string): void {
    const el = document.getElementById("ne-status");
    if (el) el.textContent = text;
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window.opener) return;
    const msg = e.data;
    switch (msg.type) {
      case "init": this.handleInit(msg); break;
      case "npcListUpdate":
        this.npcs = msg.npcs || []; if (msg.quests) this.setAvailableQuests(msg.quests); this.storeSpriteData(msg); this.dropDeletedSelection(); this.refreshDraftFromList(); this.renderNpcList();
        if (this.statusOnListUpdate) { this.status(this.statusOnListUpdate); this.statusOnListUpdate = null; }
        break;
      case "npcSelectUpdate": if (msg.npc) { this.selectedNpcId = msg.npc.id; this.setDraft(msg.npc); if (msg.quests) this.setAvailableQuests(msg.quests); this.storeSpriteData(msg); this.populateForm(); this.renderNpcList(); } break;
      case "particleOptions": this.availableParticles = msg.particles || []; this.renderParticleOptions(); break;
      case "positionUpdate": if (this.selectedNpcId === msg.id) { const el = document.getElementById("ne-display-pos"); if (el) el.textContent = "(" + msg.x + ", " + msg.y + ")"; if (this.selectedNpcData) { if (!this.selectedNpcData.position) this.selectedNpcData.position = {}; this.selectedNpcData.position.x = msg.x; this.selectedNpcData.position.y = msg.y; } } break;
      case "close": window.close(); break;
    }
  }

  /** A detached copy, so edits survive the game window replacing its own rows. */
  private setDraft(npc: any): void {
    this.selectedNpcData = npc ? JSON.parse(JSON.stringify(npc)) : null;
    this.dirty = false;
  }

  /**
   * Re-sync the draft with the refreshed list. Unsaved edits win: a list update
   * can arrive because any player on this map changed an NPC, and that must not
   * throw away what is being typed.
   */
  private refreshDraftFromList(): void {
    if (this.dirty || this.selectedNpcId === null) return;
    const fresh = this.npcs.find((n: any) => n.id === this.selectedNpcId);
    if (!fresh) return;
    // Most list updates are about some other NPC. Re-rendering then would close
    // an open asset picker for no reason.
    if (JSON.stringify(fresh) === JSON.stringify(this.selectedNpcData)) return;
    this.setDraft(fresh);
    this.populateForm();
  }

  private storeSpriteData(msg: any): void {
    if (msg.spriteSheets) this.spriteData.spriteSheets = msg.spriteSheets;
    if (msg.icons) this.spriteData.icons = msg.icons;
    const sheets = this.spriteData.spriteSheets ?? {};
    const signature = Object.keys(sheets).sort()
      .map((slot) => `${slot}:${(sheets[slot] ?? []).length}`).join(",")
      + `|${(this.spriteData.icons ?? []).length}`;
    if (signature === this.spriteSignature) return;
    this.spriteSignature = signature;
    this.renderAppearance();
  }

  private handleInit(msg: any): void {
    this.npcs = msg.npcs || [];
    this.availableParticles = msg.particles || [];
    if (msg.quests) this.setAvailableQuests(msg.quests);
    this.storeSpriteData(msg);
    this.selectedParticles = this.normalizeParticleNames(msg.selectedParticles);
    this.renderNpcList();
    this.renderParticleOptions();
    if (msg.selectedNpc) {
      this.selectedNpcId = msg.selectedNpcId;
      this.setDraft(msg.selectedNpc);
      this.populateForm();
    } else if (this.npcs.length > 0 && !this.selectedNpcId) {
      this.selectNpc(this.npcs[0]);
    }
  }

  /** Named NPCs show their name; only unnamed ones fall back to NPC #id. */
  private npcLabel(npc: any): string {
    const name = typeof npc?.name === "string" ? npc.name.trim() : "";
    if (name) return name;
    return npc?.id === null || npc?.id === undefined ? "Unsaved NPC" : "NPC #" + npc.id;
  }

  /**
   * The open NPC is gone from the list (deleted from its row, elsewhere, or an
   * unsaved one discarded): close it instead of editing something that no
   * longer exists.
   */
  private dropDeletedSelection(): void {
    if (!this.selectedNpcData) return;
    const stillThere = this.npcs.some((n: any) => n.id === this.selectedNpcId);
    if (stillThere) return;
    this.selectedNpcId = null;
    this.selectedNpcData = null;
    this.dirty = false;
    this.updateChrome();
  }

  private renderNpcList(): void {
    this.npcListEl.innerHTML = "";
    const q = this.searchQuery;
    // New NPCs start from a pinned row at the top of the list.
    const newRow = document.createElement("div");
    newRow.className = "editor-item ce-new-row";
    newRow.title = "New NPC (placed where you stand)";
    const newLabel = document.createElement("span");
    newLabel.className = "editor-item-label";
    newLabel.textContent = "+ New NPC";
    newRow.appendChild(newLabel);
    newRow.addEventListener("click", () => {
      if (this.dirty && !confirm("Discard unsaved changes?")) return;
      this.send({ type: "createNpc" });
    });
    this.npcListEl.appendChild(newRow);
    for (let i = 0; i < this.npcs.length; i++) {
      const npc = this.npcs[i];
      const label = this.npcLabel(npc);
      if (q && label.toLowerCase().indexOf(q) === -1 && (!npc.name || npc.name.toLowerCase().indexOf(q) === -1)) continue;
      const item = document.createElement("div");
      item.className = "editor-item" + (npc.id === this.selectedNpcId ? " active" : "");
      const labelEl = document.createElement("span");
      labelEl.className = "editor-item-label";
      labelEl.textContent = label;
      const posEl = document.createElement("span");
      posEl.className = "editor-item-icon";
      posEl.textContent = "(" + (npc.position ? Math.round(npc.position.x || 0) + ", " + Math.round(npc.position.y || 0) : "-") + ")";
      item.appendChild(labelEl);
      item.appendChild(posEl);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ce-row-delete";
      del.title = `Delete ${label}`;
      del.setAttribute("aria-label", `Delete ${label}`);
      del.innerHTML = TRASH_ICON;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteNpc(npc);
      });
      item.appendChild(del);
      item.addEventListener("click", () => this.selectNpc(npc));
      this.npcListEl.appendChild(item);
    }
    this.scrollToListSelection();
  }

  private scrollToListSelection(): void {
    const active = this.npcListEl.querySelector(".editor-item.active") as HTMLElement | null;
    if (active) { active.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }

  private selectNpc(npc: any): void {
    this.selectedNpcId = npc.id;
    this.setDraft(npc);
    this.renderNpcList();
    this.populateForm();
    this.send({ type: "selectNpc", id: npc.id });
    this.scrollToListSelection();
  }

  private setAvailableQuests(quests: any): void {
    const list = Array.isArray(quests) ? quests : [];
    this.availableQuests = list
      .filter((q: any) => q && q.id !== undefined && q.id !== null)
      .map((q: any) => ({ id: Number(q.id), name: String(q.name ?? ("Quest #" + q.id)) }))
      .sort((a: any, b: any) => a.id - b.id);
    this.renderQuestSelects();
  }

  private selectedOptions(id: string): number[] {
    const el = document.getElementById(id);
    if (!el) return [];
    return Array.from(el.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => (cb as HTMLInputElement).checked)
      .map((cb) => Number((cb as HTMLInputElement).value))
      .filter((n) => Number.isFinite(n));
  }

  // Checkbox lists, not multi-selects: select.editor-form-input is pinned to
  // 29px height, which collapses a multi-select into a broken single row.
  private renderQuestSelects(): void {
    for (const [id, selected] of [["inp-quests-given", this.selectedNpcData?.questsGiven || []], ["inp-quests-ended", this.selectedNpcData?.questsEnded || []]] as Array<[string, any]>) {
      const el = document.getElementById(id);
      if (!el) continue;
      const chosen = new Set((Array.isArray(selected) ? selected : []).map(Number));
      el.innerHTML = "";
      if (this.availableQuests.length === 0) {
        const empty = document.createElement("div");
        empty.className = "editor-empty";
        empty.textContent = "No quests available";
        el.appendChild(empty);
        continue;
      }
      for (const quest of this.availableQuests) {
        const item = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = String(quest.id);
        cb.checked = chosen.has(quest.id);
        cb.addEventListener("change", () => this.markDirty());
        item.appendChild(cb);
        item.appendChild(document.createTextNode(` #${quest.id} ${quest.name}`));
        el.appendChild(item);
      }
    }
  }

  private populateForm(): void {
    this.hideGossipAc();
    this.hideScriptAc();
    this.updateChrome();
    const npc = this.selectedNpcData;
    if (!npc) return;
    const v = (id: string, val: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { if (el.type === "checkbox") { el.checked = !!val; } else { el.value = val != null ? String(val) : ""; } } };
    let el = document.getElementById("ne-display-name");
    if (el) el.textContent = this.npcLabel(npc);
    el = document.getElementById("ne-display-id");
    if (el) el.textContent = npc.id === null ? "not saved yet" : "#" + npc.id;
    el = document.getElementById("ne-display-pos");
    if (el) el.textContent = "(" + (npc.position ? Math.round(npc.position.x || 0) + ", " + Math.round(npc.position.y || 0) : "-") + ")";
    this.renderQuestSelects();
    v("inp-quest-giver", npc.quest_giver || false);
    v("inp-direction", npc.position?.direction || npc.direction || "down");
    v("inp-hidden", npc.hidden || false);
    v("inp-name", npc.name || "");
    v("inp-dialog", npc.dialog || "");
    v("inp-gossip", npc.gossip || "");
    v("inp-script", npc.script || "");
    this.selectedParticles = this.normalizeParticleNames(npc.particles);
    this.renderParticleOptions();
    this.renderAppearance();
    this.restoreTab();
  }

  /**
   * Keep the open tab across refreshes and NPC switches. The tab is editor-wide,
   * not per NPC: picking another NPC on the left must not drop the user back on
   * General.
   */
  private restoreTab(): void {
    const exists = document.querySelector('.editor-tab-panel[data-tab="' + this.tab + '"]');
    this.switchTab(exists ? this.tab : "general");
  }

  // Appearance tab: the exact same sprite tools as the creature editor, mapped
  // onto NPC keys (body sheet / static image live in sprite_body; NPCs have no
  // scale column, so that field is omitted).
  private appearanceFields(): Field[] {
    const spriteType = String(this.selectedNpcData?.sprite_type ?? "none");
    return [
      { key: "sprite_type", label: "Sprite type", type: "select", options: pick(["animated", "static", "none"]), rerender: true },
      ...(spriteType === "static"
        ? [{
            key: "sprite_body",
            label: "Static image",
            type: "asset",
            assets: () => [
              { value: "", label: "None" },
              ...(this.spriteData.icons ?? []).map((i: any) => ({ value: i.name, label: i.name, image: i.image })),
            ],
          } as Field]
        : []),
      ...(spriteType === "animated"
        ? ([
            { key: "sprite_body", label: "Body sheet", type: "sheet", slot: "body", noIcons: true },
            { key: "sprite_head", label: "Head sheet", type: "sheet", slot: "head", noIcons: true },
            { key: "sprite_helmet", label: "Helmet", type: "sheet", slot: "helmet" },
            { key: "sprite_shoulderguards", label: "Shoulders", type: "sheet", slot: "shoulderguards" },
            { key: "sprite_neck", label: "Neck", type: "sheet", slot: "neck" },
            { key: "sprite_hands", label: "Gloves", type: "sheet", slot: "hands" },
            { key: "sprite_chest", label: "Chest", type: "sheet", slot: "chest" },
            { key: "sprite_feet", label: "Boots", type: "sheet", slot: "feet" },
            { key: "sprite_legs", label: "Pants", type: "sheet", slot: "legs" },
            { key: "sprite_weapon", label: "Weapon", type: "sheet", slot: "weapon" },
          ] as Field[])
        : []),
    ];
  }

  private renderAppearance(): void {
    const el = document.getElementById("ne-appearance-fields");
    if (!el || !this.selectedNpcData) return;
    el.innerHTML = "";
    const touch = () => this.markDirty();
    for (const field of orderFields(this.appearanceFields())) {
      el.appendChild(this.appearance.renderField(field, this.selectedNpcData, touch));
    }
  }

  private normalizeParticleNames(particles: any): string[] {
    if (!Array.isArray(particles)) return [];
    return particles
      .map((p) => (typeof p === "string" ? p : (p && p.name ? p.name : null)))
      .filter((p): p is string => !!p);
  }

  private switchTab(tabName: string): void {
    this.tab = tabName;
    document.querySelectorAll(".editor-tab-btn").forEach((b) => { b.classList.toggle("active", b.getAttribute("data-tab") === tabName); });
    document.querySelectorAll(".editor-tab-panel").forEach((p) => { p.classList.toggle("active", p.getAttribute("data-tab") === tabName); });
    try { localStorage.setItem("ne-tab-preference", tabName); } catch { /* storage unavailable */ }
  }

  private renderParticleOptions(): void {
    this.particleOptionsEl.innerHTML = "";
    const q = this.particleSearchQuery;
    for (let i = 0; i < this.availableParticles.length; i++) {
      const name = this.availableParticles[i];
      if (q && name.toLowerCase().indexOf(q) === -1) continue;
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this.selectedParticles.indexOf(name) >= 0;
      cb.addEventListener("change", () => {
        if (cb.checked) { this.selectedParticles.push(name); } else { this.selectedParticles = this.selectedParticles.filter((p) => p !== name); }
        this.markDirty();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + name));
      this.particleOptionsEl.appendChild(label);
    }
  }

  private getFormData(): any {
    if (this.selectedNpcData === null && this.selectedNpcId === null) return null;
    const gv = (id: string) => { const el = document.getElementById(id) as HTMLInputElement | null; return el ? (el.type === "checkbox" ? el.checked : el.value) : null; };
    const gs = (id: string) => { const el = document.getElementById(id) as HTMLInputElement | null; return el && el.value ? el.value.trim() : null; };
    return {
      id: this.selectedNpcId,
      map: this.selectedNpcData ? this.selectedNpcData.map : "",
      position: { x: this.selectedNpcData ? (this.selectedNpcData.position?.x || 0) : 0, y: this.selectedNpcData ? (this.selectedNpcData.position?.y || 0) : 0, direction: gs("inp-direction") || "down" },
      hidden: gv("inp-hidden"),
      quest_giver: !!gv("inp-quest-giver"),
      name: gs("inp-name") || null,
      dialog: gs("inp-dialog") || null,
      gossip: gs("inp-gossip") || null,
      script: gs("inp-script") || null,
      questsGiven: this.selectedOptions("inp-quests-given"),
      questsEnded: this.selectedOptions("inp-quests-ended"),
      particles: this.selectedParticles.slice(),
      // Sprite values are edited in place on the selected NPC by the shared
      // appearance fields; read them back from there.
      sprite_type: this.selectedNpcData?.sprite_type || "none",
      sprite_body: this.selectedNpcData?.sprite_body ?? null,
      sprite_head: this.selectedNpcData?.sprite_head ?? null,
      sprite_helmet: this.selectedNpcData?.sprite_helmet ?? null,
      sprite_shoulderguards: this.selectedNpcData?.sprite_shoulderguards ?? null,
      sprite_neck: this.selectedNpcData?.sprite_neck ?? null,
      sprite_hands: this.selectedNpcData?.sprite_hands ?? null,
      sprite_chest: this.selectedNpcData?.sprite_chest ?? null,
      sprite_feet: this.selectedNpcData?.sprite_feet ?? null,
      sprite_legs: this.selectedNpcData?.sprite_legs ?? null,
      sprite_weapon: this.selectedNpcData?.sprite_weapon ?? null,
    };
  }

  private markDirty(): void {
    this.dirty = true;
    this.sendFormUpdate();
    // The page title follows the Name field as it is typed.
    const title = document.getElementById("ne-display-name");
    const name = (document.getElementById("inp-name") as HTMLInputElement | null)?.value.trim();
    if (title && this.selectedNpcData) title.textContent = name || this.npcLabel({ id: this.selectedNpcId });
    this.updateSaveIcon();
  }

  /**
   * Form, tabs content and save icon only show while an NPC is open; with
   * none (e.g. it was deleted) an empty-state message takes their place.
   */
  private updateChrome(): void {
    const has = !!this.selectedNpcData;
    const panels = document.getElementById("ne-panels");
    const empty = document.getElementById("ne-empty");
    if (panels) panels.hidden = !has;
    if (empty) empty.hidden = has;
    this.saveBtn.hidden = !has;
    this.updateSaveIcon();
  }

  /** Save icon: faded with nothing to save, highlighted with unsaved changes. */
  private updateSaveIcon(): void {
    // A new NPC counts as unsaved until the server gives it an id.
    const changes = !!this.selectedNpcData && (this.dirty || this.selectedNpcId === null);
    this.saveBtn.classList.toggle("has-changes", changes);
    this.saveBtn.title = changes ? "Save changes (Ctrl+S)" : "No unsaved changes";
  }

  // ---- Gossip ${player...} autocomplete ----
  // Popup only ever appears inside an unclosed ${...} expression.
  private gossipAcEl: HTMLDivElement | null = null;
  private gossipAcItems: Array<{ insert: string; label: string; hint: string; keepOpen: boolean }> = [];
  private gossipAcIndex = 0;
  private gossipAcTokenStart = 0;

  private static readonly GOSSIP_TOP: Array<{ path: string; hint: string; branch?: boolean }> = [
    { path: "name", hint: "username" },
    { path: "username", hint: "login name" },
    { path: "userid", hint: "account id" },
    { path: "level", hint: "level" },
    { path: "guild_name", hint: "guild name" },
    { path: "mounted", hint: "mounted?" },
    { path: "isAdmin", hint: "admin?" },
    { path: "isGuest", hint: "guest?" },
    { path: "stats", hint: "stats…", branch: true },
    { path: "currency", hint: "currency…", branch: true },
  ];

  private static readonly GOSSIP_STATS = [
    "level", "xp", "max_xp", "health", "max_health", "total_max_health",
    "stamina", "max_stamina", "total_max_stamina", "stat_damage", "stat_armor",
    "stat_health", "stat_stamina", "stat_critical_chance", "stat_critical_damage",
    "stat_avoidance",
  ];

  private static readonly GOSSIP_CURRENCY = ["copper", "silver", "gold"];

  private setupGossipAc(): void {
    const ta = document.getElementById("inp-gossip") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.addEventListener("input", () => this.updateGossipAc());
    ta.addEventListener("click", () => this.updateGossipAc());
    ta.addEventListener("blur", () => window.setTimeout(() => this.hideGossipAc(), 150));
    ta.addEventListener("keydown", (e: KeyboardEvent) => {
      if (!this.gossipAcEl) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = this.gossipAcItems.length;
        if (n > 0) this.paintGossipAc((this.gossipAcIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.applyGossipAc();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.hideGossipAc();
      }
    });
  }

  /** Candidates for the inner text of an unclosed ${...}; [] means no popup. */
  private gossipAcCandidates(inner: string): Array<{ insert: string; label: string; hint: string; keepOpen: boolean }> {
    const leaf = (base: string, path: string, hint: string) => ({ insert: `${base}${path}`, label: `${base}${path}`, hint, keepOpen: false });
    if (!inner || (!inner.includes(".") && "player".startsWith(inner))) {
      return [{ insert: "player.", label: "player", hint: "current player…", keepOpen: true }];
    }
    if (inner === "player" || inner.startsWith("player.")) {
      const rest = inner.startsWith("player.") ? inner.slice("player.".length) : "";
      if (rest.includes(".")) {
        const [head, ...tailParts] = rest.split(".");
        const tail = tailParts.join(".");
        const pool = head === "stats" ? NpcEditorBridge.GOSSIP_STATS
          : head === "currency" ? NpcEditorBridge.GOSSIP_CURRENCY
          : null;
        if (!pool || tail.includes(".")) return [];
        return pool
          .filter((f) => f.toLowerCase().startsWith(tail.toLowerCase()))
          .map((f) => leaf("player." + head + ".", f, head === "stats" ? "stat" : "coins"));
      }
      const out: Array<{ insert: string; label: string; hint: string; keepOpen: boolean }> = [];
      for (const f of NpcEditorBridge.GOSSIP_TOP) {
        if (!f.path.toLowerCase().startsWith(rest.toLowerCase())) continue;
        if (f.branch) out.push({ insert: `player.${f.path}.`, label: `player.${f.path}.`, hint: f.hint, keepOpen: true });
        else out.push(leaf("player.", f.path, f.hint));
      }
      return out;
    }
    return [];
  }

  private updateGossipAc(): void {
    const ta = document.getElementById("inp-gossip") as HTMLTextAreaElement | null;
    if (!ta || document.activeElement !== ta) { this.hideGossipAc(); return; }
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);
    const match = before.match(/(\$\{[A-Za-z0-9_.]*)$/);
    if (!match) { this.hideGossipAc(); return; }
    const inner = match[1].slice(2);
    const items = this.gossipAcCandidates(inner);
    if (items.length === 0) { this.hideGossipAc(); return; }
    this.gossipAcItems = items;
    this.gossipAcTokenStart = caret - match[1].length;
    this.paintGossipAc(0);
  }

  private paintGossipAc(selected: number): void {
    this.gossipAcIndex = selected;
    const ta = document.getElementById("inp-gossip") as HTMLTextAreaElement | null;
    if (!ta) { this.hideGossipAc(); return; }
    if (!this.gossipAcEl) {
      const el = document.createElement("div");
      el.className = "qe-ac-popup";
      document.body.appendChild(el);
      this.gossipAcEl = el;
    }
    const el = this.gossipAcEl;
    el.innerHTML = "";
    this.gossipAcItems.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "qe-ac-row" + (i === selected ? " active" : "");
      const name = document.createElement("span");
      name.className = "qe-ac-name";
      name.textContent = "${" + item.label + "}";
      const hint = document.createElement("span");
      hint.className = "qe-ac-hint";
      hint.textContent = item.hint;
      row.appendChild(name);
      row.appendChild(hint);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.paintGossipAc(i);
        this.applyGossipAc();
      });
      el.appendChild(row);
    });
    const rect = ta.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    el.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 200)}px`;
    el.style.display = "block";
  }

  private applyGossipAc(): void {
    const ta = document.getElementById("inp-gossip") as HTMLTextAreaElement | null;
    const item = this.gossipAcItems[this.gossipAcIndex];
    if (!ta || !item) { this.hideGossipAc(); return; }
    const caret = ta.selectionStart ?? ta.value.length;
    // Branch picks (player, stats…) leave the expression open for the next
    // level; leaves close it.
    const suffix = item.keepOpen ? "" : "}";
    ta.value = ta.value.slice(0, this.gossipAcTokenStart) + "${" + item.insert + suffix + ta.value.slice(caret);
    const after = this.gossipAcTokenStart + item.insert.length + 2 + suffix.length;
    ta.focus();
    ta.setSelectionRange(after, after);
    this.markDirty();
    if (item.keepOpen) this.updateGossipAc();
    else this.hideGossipAc();
  }

  private hideGossipAc(): void {
    if (this.gossipAcEl) this.gossipAcEl.style.display = "none";
    this.gossipAcItems = [];
    this.gossipAcIndex = 0;
  }

  // ---- Script identifier autocomplete (inp-script) ----
  // Same popup behavior as the gossip autocomplete, but scripts run with
  // `with(this)` on the NPC object, so candidates are plain NPC members and
  // no ${} wrapper is required or added.
  private static readonly SCRIPT_TOP: Array<{ path: string; hint: string; branch?: boolean; fn?: boolean }> = [
    { path: "id", hint: "npc id" },
    { path: "name", hint: "name" },
    { path: "dialog", hint: "dialog line" },
    { path: "gossip", hint: "gossip chain" },
    { path: "hidden", hint: "hidden?" },
    { path: "direction", hint: "facing" },
    { path: "position", hint: "position…", branch: true },
    { path: "particles", hint: "particles" },
    { path: "sprite_type", hint: "sprite type" },
    { path: "quest_giver", hint: "quest giver?" },
    { path: "dialogue", hint: "draw bubble()", fn: true },
    { path: "show", hint: "draw sprite()", fn: true },
    { path: "updateParticle", hint: "emit particle()", fn: true },
  ];

  private static readonly SCRIPT_POSITION = ["x", "y"];

  private scriptAcEl: HTMLDivElement | null = null;
  private scriptAcItems: Array<{ insert: string; label: string; hint: string; keepOpen: boolean; caretBack?: number }> = [];
  private scriptAcIndex = 0;
  private scriptAcTokenStart = 0;

  private setupScriptAc(): void {
    const ta = document.getElementById("inp-script") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.addEventListener("input", () => this.updateScriptAc());
    ta.addEventListener("click", () => this.updateScriptAc());
    ta.addEventListener("blur", () => window.setTimeout(() => this.hideScriptAc(), 150));
    ta.addEventListener("keydown", (e: KeyboardEvent) => {
      if (!this.scriptAcEl) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = this.scriptAcItems.length;
        if (n > 0) this.paintScriptAc((this.scriptAcIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.applyScriptAc();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.hideScriptAc();
      }
    });
  }

  /** Candidates for a trailing bare identifier; [] means no popup. */
  private scriptAcCandidates(token: string): Array<{ insert: string; label: string; hint: string; keepOpen: boolean; caretBack?: number }> {
    const leaf = (insert: string, label: string, hint: string, extra?: { keepOpen?: boolean; caretBack?: number }) =>
      ({ insert, label, hint, keepOpen: extra?.keepOpen ?? false, caretBack: extra?.caretBack });
    if (token.includes(".")) {
      const [head, ...tailParts] = token.split(".");
      const tail = tailParts.join(".");
      if (head !== "position" || tail.includes(".")) return [];
      return NpcEditorBridge.SCRIPT_POSITION
        .filter((f) => f.toLowerCase().startsWith(tail.toLowerCase()))
        .map((f) => leaf(`position.${f}`, `position.${f}`, head === "position" ? "coord" : ""));
    }
    const out: Array<{ insert: string; label: string; hint: string; keepOpen: boolean; caretBack?: number }> = [];
    for (const f of NpcEditorBridge.SCRIPT_TOP) {
      if (!f.path.toLowerCase().startsWith(token.toLowerCase())) continue;
      if (f.branch) out.push({ insert: `${f.path}.`, label: `${f.path}.`, hint: f.hint, keepOpen: true });
      else if (f.fn) out.push(leaf(`${f.path}()`, f.path, f.hint, { caretBack: 1 }));
      else out.push(leaf(f.path, f.path, f.hint));
    }
    return out;
  }

  private updateScriptAc(): void {
    const ta = document.getElementById("inp-script") as HTMLTextAreaElement | null;
    if (!ta || document.activeElement !== ta) { this.hideScriptAc(); return; }
    const caret = ta.selectionStart ?? ta.value.length;
    // Only at a word end: typing mid-word must not pop up or rewrite text.
    if (caret < ta.value.length && /[A-Za-z0-9_]/.test(ta.value[caret])) { this.hideScriptAc(); return; }
    const before = ta.value.slice(0, caret);
    const match = before.match(/([A-Za-z_][A-Za-z0-9_.]*)$/);
    if (!match || match[1].length === 0) { this.hideScriptAc(); return; }
    const items = this.scriptAcCandidates(match[1]);
    if (items.length === 0) { this.hideScriptAc(); return; }
    this.scriptAcItems = items;
    this.scriptAcTokenStart = caret - match[1].length;
    this.paintScriptAc(0);
  }

  private paintScriptAc(selected: number): void {
    this.scriptAcIndex = selected;
    const ta = document.getElementById("inp-script") as HTMLTextAreaElement | null;
    if (!ta) { this.hideScriptAc(); return; }
    if (!this.scriptAcEl) {
      const el = document.createElement("div");
      el.className = "qe-ac-popup";
      document.body.appendChild(el);
      this.scriptAcEl = el;
    }
    const el = this.scriptAcEl;
    el.innerHTML = "";
    this.scriptAcItems.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "qe-ac-row" + (i === selected ? " active" : "");
      const name = document.createElement("span");
      name.className = "qe-ac-name";
      name.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "qe-ac-hint";
      hint.textContent = item.hint;
      row.appendChild(name);
      row.appendChild(hint);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.paintScriptAc(i);
        this.applyScriptAc();
      });
      el.appendChild(row);
    });
    const rect = ta.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    el.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 200)}px`;
    el.style.display = "block";
  }

  private applyScriptAc(): void {
    const ta = document.getElementById("inp-script") as HTMLTextAreaElement | null;
    const item = this.scriptAcItems[this.scriptAcIndex];
    if (!ta || !item) { this.hideScriptAc(); return; }
    const caret = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, this.scriptAcTokenStart) + item.insert + ta.value.slice(caret);
    const after = this.scriptAcTokenStart + item.insert.length - (item.caretBack ?? 0);
    ta.focus();
    ta.setSelectionRange(after, after);
    this.markDirty();
    if (item.keepOpen) this.updateScriptAc();
    else this.hideScriptAc();
  }

  private hideScriptAc(): void {
    if (this.scriptAcEl) this.scriptAcEl.style.display = "none";
    this.scriptAcItems = [];
    this.scriptAcIndex = 0;
  }

  private sendFormUpdate(): void { const data = this.getFormData(); if (data) this.send({ type: "fieldUpdate", npc: data }); }

  private saveNpc(): void {
    if (this.selectedNpcId === null && !this.selectedNpcData) return;
    const data = this.getFormData();
    if (!data) return;
    this.dirty = false;
    this.send({ type: "saveNpc", npc: data });
    this.updateSaveIcon();
    this.status("Saving...");
    this.statusOnListUpdate = "Saved";
  }

  /** Delete an NPC from its list row (an unsaved one is just discarded). */
  private deleteNpc(npc: any): void {
    if (!npc) return;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    const label = this.npcLabel(npc);
    const unsaved = npc.id === null || npc.id === undefined;
    box.innerHTML = '<h3></h3><p></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-danger"></button></div>';
    box.querySelector("h3")!.textContent = unsaved ? "Discard NPC" : "Delete NPC";
    box.querySelector("p")!.textContent = unsaved ? `Discard ${label}? It was never saved.` : `Delete ${label}? It is removed from the world.`;
    box.querySelector(".btn-danger")!.textContent = unsaved ? "Discard" : "Delete";
    overlay.appendChild(box); document.body.appendChild(overlay);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    document.addEventListener("keydown", onKey);
    box.querySelector(".btn-danger")!.addEventListener("click", () => {
      close();
      // The game window only discards the unsaved NPC it has selected.
      if (unsaved && this.selectedNpcId !== null) this.selectNpc(npc);
      this.send({ type: "deleteNpc", id: unsaved ? null : npc.id });
      this.status(unsaved ? "Discarded" : "Deleting...");
      if (!unsaved) this.statusOnListUpdate = "Deleted";
    });
    box.querySelector(".btn-cancel")!.addEventListener("click", close);
  }
}

new NpcEditorBridge();
