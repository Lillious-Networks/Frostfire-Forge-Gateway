class NpcEditorBridge {
  private npcs: any[] = [];
  private availableParticles: string[] = [];
  private selectedParticles: string[] = [];
  private selectedNpcId: number | null = null;
  private selectedNpcData: any = null;
  private searchQuery: string = "";
  private particleSearchQuery: string = "";

  private saveBtn: HTMLElement;
  private newBtn: HTMLElement;
  private deleteBtn: HTMLElement;
  private searchInput: HTMLInputElement;
  private npcListEl: HTMLElement;
  private particleSearchInput: HTMLInputElement;
  private particleOptionsEl: HTMLElement;
  private inputs: Record<string, HTMLElement> = {};

  constructor() {
    this.saveBtn = document.getElementById("btn-save")!;
    this.newBtn = document.getElementById("btn-new")!;
    this.deleteBtn = document.getElementById("btn-delete")!;
    this.searchInput = document.getElementById("ne-npc-search") as HTMLInputElement;
    this.npcListEl = document.getElementById("ne-npc-list")!;
    this.particleSearchInput = document.getElementById("ne-particle-search") as HTMLInputElement;
    this.particleOptionsEl = document.getElementById("ne-particle-options")!;

    const formIds = ["inp-quest","inp-direction","inp-hidden","inp-sprite-type","inp-sprite-body",
      "inp-sprite-head","inp-sprite-helmet","inp-sprite-shoulderguards","inp-sprite-neck",
      "inp-sprite-hands","inp-sprite-chest","inp-sprite-feet","inp-sprite-legs","inp-sprite-weapon",
      "inp-name","inp-dialog","inp-script"];
    for (const id of formIds) {
      const el = document.getElementById(id);
      if (el) { this.inputs[id] = el; el.addEventListener("input", () => this.markDirty()); el.addEventListener("change", () => this.markDirty()); }
    }

    this.saveBtn.addEventListener("click", () => this.saveNpc());
    this.newBtn.addEventListener("click", () => this.send({ type: "createNpc" }));
    this.deleteBtn.addEventListener("click", () => this.deleteNpc());
    this.searchInput.addEventListener("input", () => { this.searchQuery = this.searchInput.value.toLowerCase(); this.renderNpcList(); });
    this.particleSearchInput.addEventListener("input", () => { this.particleSearchQuery = this.particleSearchInput.value.toLowerCase(); this.renderParticleOptions(); });

    const spriteTypeEl = document.getElementById("inp-sprite-type");
    if (spriteTypeEl) spriteTypeEl.addEventListener("change", () => this.updateSpriteVisibility());

    document.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")!));
    });

    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  private send(msg: any): void { if (window.opener) window.opener.postMessage(msg, "*"); }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); this.saveNpc(); }
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window.opener) return;
    const msg = e.data;
    switch (msg.type) {
      case "init": this.handleInit(msg); break;
      case "npcListUpdate": this.npcs = msg.npcs || []; this.renderNpcList(); break;
      case "npcSelectUpdate": if (msg.npc) { this.selectedNpcId = msg.npc.id; this.selectedNpcData = msg.npc; this.populateForm(msg.npc); this.renderNpcList(); } break;
      case "particleOptions": this.availableParticles = msg.particles || []; this.renderParticleOptions(); break;
      case "positionUpdate": if (this.selectedNpcId === msg.id) { const el = document.getElementById("ne-display-pos"); if (el) el.textContent = "(" + msg.x + ", " + msg.y + ")"; if (this.selectedNpcData) { if (!this.selectedNpcData.position) this.selectedNpcData.position = {}; this.selectedNpcData.position.x = msg.x; this.selectedNpcData.position.y = msg.y; } } break;
      case "close": window.close(); break;
    }
  }

  private handleInit(msg: any): void {
    this.npcs = msg.npcs || [];
    this.availableParticles = msg.particles || [];
    this.selectedParticles = this.normalizeParticleNames(msg.selectedParticles);
    this.renderNpcList();
    this.renderParticleOptions();
    if (msg.selectedNpc) {
      this.selectedNpcId = msg.selectedNpcId;
      this.selectedNpcData = msg.selectedNpc;
      this.populateForm(msg.selectedNpc);
    } else if (this.npcs.length > 0 && !this.selectedNpcId) {
      this.selectNpc(this.npcs[0]);
    }
  }

  private renderNpcList(): void {
    this.npcListEl.innerHTML = "";
    const q = this.searchQuery;
    for (let i = 0; i < this.npcs.length; i++) {
      const npc = this.npcs[i];
      const label = npc.id === null ? "Unsaved NPC" : "NPC #" + npc.id;
      if (q && label.toLowerCase().indexOf(q) === -1 && (!npc.name || npc.name.toLowerCase().indexOf(q) === -1)) continue;
      const item = document.createElement("div");
      item.className = "editor-item" + (npc.id === this.selectedNpcId ? " active" : "");
      item.innerHTML = '<span class="editor-item-label">' + label + '</span><span class="editor-item-icon">(' + (npc.position ? Math.round(npc.position.x || 0) + ", " + Math.round(npc.position.y || 0) : "-") + ')</span>';
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
    this.selectedNpcData = npc;
    this.renderNpcList();
    this.populateForm(npc);
    this.send({ type: "selectNpc", id: npc.id });
    this.scrollToListSelection();
  }

  private populateForm(npc: any): void {
    const v = (id: string, val: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) { if (el.type === "checkbox") { el.checked = !!val; } else { el.value = val != null ? String(val) : ""; } } };
    let el = document.getElementById("ne-display-id");
    if (el) el.textContent = npc.id === null ? "Unsaved" : "#" + npc.id;
    el = document.getElementById("ne-display-pos");
    if (el) el.textContent = "(" + (npc.position ? Math.round(npc.position.x || 0) + ", " + Math.round(npc.position.y || 0) : "-") + ")";
    v("inp-quest", npc.quest != null ? npc.quest : "");
    v("inp-direction", npc.position?.direction || npc.direction || "down");
    v("inp-hidden", npc.hidden || false);
    v("inp-sprite-type", npc.sprite_type || "none");
    v("inp-sprite-body", npc.sprite_body || "");
    v("inp-sprite-head", npc.sprite_head || "");
    v("inp-sprite-helmet", npc.sprite_helmet || "");
    v("inp-sprite-shoulderguards", npc.sprite_shoulderguards || "");
    v("inp-sprite-neck", npc.sprite_neck || "");
    v("inp-sprite-hands", npc.sprite_hands || "");
    v("inp-sprite-chest", npc.sprite_chest || "");
    v("inp-sprite-feet", npc.sprite_feet || "");
    v("inp-sprite-legs", npc.sprite_legs || "");
    v("inp-sprite-weapon", npc.sprite_weapon || "");
    v("inp-name", npc.name || "");
    v("inp-dialog", npc.dialog || "");
    v("inp-script", npc.script || "");
    this.selectedParticles = this.normalizeParticleNames(npc.particles);
    this.renderParticleOptions();
    this.updateSpriteVisibility();
    this.switchTab("general");
  }

  private normalizeParticleNames(particles: any): string[] {
    if (!Array.isArray(particles)) return [];
    return particles
      .map((p) => (typeof p === "string" ? p : (p && p.name ? p.name : null)))
      .filter((p): p is string => !!p);
  }

  private updateSpriteVisibility(): void {
    const val = document.getElementById("inp-sprite-type") as HTMLSelectElement | null;
    const type = val ? val.value : "none";
    const sf = document.getElementById("sprite-fields");
    const af = document.getElementById("sprite-animated-fields");
    if (sf) sf.style.display = type === "none" ? "none" : "block";
    if (af) af.style.display = type === "animated" ? "block" : "none";
  }

  private switchTab(tabName: string): void {
    document.querySelectorAll(".editor-tab-btn").forEach((b) => { b.classList.toggle("active", b.getAttribute("data-tab") === tabName); });
    document.querySelectorAll(".editor-tab-panel").forEach((p) => { p.classList.toggle("active", p.getAttribute("data-tab") === tabName); });
    if (this.selectedNpcId != null) { localStorage.setItem("ne-tab-preference-" + this.selectedNpcId, tabName); }
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
      name: gs("inp-name") || null,
      dialog: gs("inp-dialog") || null,
      script: gs("inp-script") || null,
      quest: gv("inp-quest") ? Number(gv("inp-quest")) : null,
      particles: this.selectedParticles.slice(),
      sprite_type: gs("inp-sprite-type") || "none",
      sprite_body: gs("inp-sprite-body") || null,
      sprite_head: gs("inp-sprite-head") || null,
      sprite_helmet: gs("inp-sprite-helmet") || null,
      sprite_shoulderguards: gs("inp-sprite-shoulderguards") || null,
      sprite_neck: gs("inp-sprite-neck") || null,
      sprite_hands: gs("inp-sprite-hands") || null,
      sprite_chest: gs("inp-sprite-chest") || null,
      sprite_feet: gs("inp-sprite-feet") || null,
      sprite_legs: gs("inp-sprite-legs") || null,
      sprite_weapon: gs("inp-sprite-weapon") || null,
    };
  }

  private markDirty(): void { this.sendFormUpdate(); }

  private sendFormUpdate(): void { const data = this.getFormData(); if (data) this.send({ type: "fieldUpdate", npc: data }); }

  private saveNpc(): void {
    if (this.selectedNpcId === null && !this.selectedNpcData) return;
    const data = this.getFormData();
    if (!data) return;
    this.send({ type: "saveNpc", npc: data });
  }

  private deleteNpc(): void {
    if (this.selectedNpcId === null && !this.selectedNpcData) return;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    const label = this.selectedNpcId === null ? "Unsaved NPC" : "NPC #" + this.selectedNpcId;
    box.innerHTML = '<h3>Delete NPC</h3><p>Delete <strong>' + label + '</strong>?</p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-danger">Delete</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    box.querySelector(".btn-danger")!.addEventListener("click", () => { overlay.remove(); this.send({ type: "deleteNpc", id: this.selectedNpcId }); });
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    document.addEventListener("keydown", function handler(e) { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", handler); } });
  }
}

new NpcEditorBridge();
