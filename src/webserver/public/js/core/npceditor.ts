import { getCameraX, getCameraY } from "./renderer.js";
import Cache from "./cache.js";
import { createNPC } from "./npc.js";

const cache = Cache.getInstance();

// Hit box for NPC drag detection (pixels in world space)
const NPC_HIT_W = 32;
const NPC_HIT_H = 48;

class NpcEditor {
  public isActive: boolean = false;
  private selectedNpc: any = null;
  private npcs: any[] = [];
  private availableParticles: string[] = [];
  private isDirty: boolean = false;
  private searchQuery: string = "";
  private particleSearchQuery: string = "";
  private hasPendingNew: boolean = false;
  private pendingSelectId: number | null = null;

  // Drag state
  private draggingNpc: any = null; // live cache.npcs reference
  private dragStarted: boolean = false;
  private dragOffsetX: number = 0;
  private dragOffsetY: number = 0;

  // Bound handlers (stored for removeEventListener)
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;

  // UI Elements
  private container: HTMLElement | null = null;
  private propertiesPanel: HTMLElement | null = null;
  private npcListPanel: HTMLElement | null = null;
  private npcListEl: HTMLElement | null = null;

  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor() {
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
  }

  public toggle() {
    this.isActive = !this.isActive;
    const container = document.getElementById("npc-editor-container");
    if (container) {
      container.style.display = this.isActive ? "block" : "none";
      if (this.isActive) {
        if (!this.container) {
          this.createUI();
        }
        this.loadNpcs();
        this.loadParticleOptions();
        this.selectedNpc = null;
        this.isDirty = false;
        this.setPropertiesPanelVisible(false);
        document.addEventListener("mousedown", this.boundMouseDown, { capture: true });
        document.addEventListener("mousemove", this.boundMouseMove);
        document.addEventListener("mouseup", this.boundMouseUp);
        document.addEventListener("keydown", this.boundKeyDown);
      } else {
        this.stopDrag();
        document.removeEventListener("mousedown", this.boundMouseDown, { capture: true });
        document.removeEventListener("mousemove", this.boundMouseMove);
        document.removeEventListener("mouseup", this.boundMouseUp);
        document.removeEventListener("keydown", this.boundKeyDown);
      }
    }
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: Math.floor(clientX - window.innerWidth / 2 + getCameraX()),
      y: Math.floor(clientY - window.innerHeight / 2 + getCameraY()),
    };
  }

  private findNpcAtWorld(wx: number, wy: number): { live: any; data: any } | null {
    for (const liveNpc of cache.npcs) {
      const nx = liveNpc.position?.x ?? 0;
      const ny = liveNpc.position?.y ?? 0;
      if (wx >= nx - NPC_HIT_W / 2 && wx <= nx + NPC_HIT_W / 2 && wy >= ny - NPC_HIT_H / 2 && wy <= ny + NPC_HIT_H / 2) {
        const data = this.npcs.find((n) => n.id === liveNpc.id) ?? null;
        return { live: liveNpc, data };
      }
    }
    return null;
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.isActive) return;
    // Ignore clicks on editor UI
    if ((e.target as HTMLElement).closest(".ne-floating-panel, .ne-modal")) return;

    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.findNpcAtWorld(wx, wy);
    if (!hit) return;

    e.stopPropagation();
    this.draggingNpc = hit.live;
    this.dragStarted = false;
    this.dragOffsetX = wx - (hit.live.position?.x ?? 0);
    this.dragOffsetY = wy - (hit.live.position?.y ?? 0);
    document.body.style.cursor = "grabbing";
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.draggingNpc) return;

    this.dragStarted = true;
    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);

    const newX = wx - this.dragOffsetX;
    const newY = wy - this.dragOffsetY;

    // Update live NPC position (moves it in the game world immediately)
    this.draggingNpc.position.x = newX;
    this.draggingNpc.position.y = newY;

    // Update position display if this NPC is selected
    if (this.selectedNpc?.id === this.draggingNpc.id) {
      const posEl = document.getElementById("ne-npc-position");
      if (posEl) posEl.textContent = `(${newX}, ${newY})`;
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (!this.draggingNpc) return;

    if (!this.dragStarted) {
      // Plain click — select the NPC and open properties
      const id = this.draggingNpc!.id;
      const editorNpc = this.npcs.find((n) => n.id === id);
      if (editorNpc) {
        this.selectNpc(editorNpc);
      } else {
        // List not loaded yet — queue the selection and request a fresh list
        this.pendingSelectId = id;
        this.loadNpcs();
      }
      this.stopDrag();
      return;
    }

    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);
    const finalX = wx - this.dragOffsetX;
    const finalY = wy - this.dragOffsetY;
    const id = this.draggingNpc.id;

    // Update editor data without saving — user must press save explicitly
    const dataIdx = this.npcs.findIndex((n) => n.id === id);
    if (dataIdx >= 0) {
      this.npcs[dataIdx] = {
        ...this.npcs[dataIdx],
        position: { ...this.npcs[dataIdx].position, x: finalX, y: finalY },
      };
      this.selectNpc(this.npcs[dataIdx]);
      this.markDirty();
    } else {
      // NPC not in editor list yet — queue selection and refresh
      this.pendingSelectId = id;
      this.loadNpcs();
    }

    this.refreshNpcList();
    this.stopDrag();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === "s") {
      if (this.selectedNpc) {
        e.preventDefault();
        this.saveNpc();
      }
    }
  }

  private stopDrag() {
    this.draggingNpc = null;
    this.dragStarted = false;
    document.body.style.cursor = "";
  }

  private setPropertiesPanelVisible(visible: boolean) {
    const panel = document.getElementById("npc-editor-properties-panel");
    if (panel) {
      panel.style.display = visible ? "block" : "none";
    }
  }

  private createUI() {
    this.container = document.getElementById("npc-editor-container");
    if (!this.container) return;

    this.propertiesPanel = document.getElementById("npc-editor-properties-panel");
    this.npcListPanel = document.getElementById("npc-editor-list-panel");
    this.npcListEl = document.getElementById("npc-list");

    this.setupEventListeners();
    this.setupPanelDragAndResize();
    this.loadStoredPanelStates();
  }

  private setupEventListeners() {
    const newNpcBtn = document.getElementById("ne-new-npc");
    if (newNpcBtn) {
      newNpcBtn.addEventListener("click", () => this.createNewNpc());
    }

    const saveBtn = document.getElementById("ne-save-npc");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => this.saveNpc());
    }

    const deleteBtn = document.getElementById("ne-delete-npc");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => this.deleteNpc());
    }

    const searchInput = document.getElementById("ne-npc-search") as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.refreshNpcList();
      });
    }

    const particleSearchInput = document.getElementById("ne-particle-search") as HTMLInputElement;
    if (particleSearchInput) {
      particleSearchInput.addEventListener("input", (e) => {
        this.particleSearchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.renderParticleOptions();
      });
    }

    const formFields = [
      "ne-npc-direction",
      "ne-npc-name",
      "ne-npc-dialog",
      "ne-npc-script",
      "ne-npc-quest",
      "ne-npc-hidden",
      "ne-npc-sprite-type",
      "ne-npc-sprite-body",
      "ne-npc-sprite-head",
      "ne-npc-sprite-helmet",
      "ne-npc-sprite-shoulderguards",
      "ne-npc-sprite-neck",
      "ne-npc-sprite-hands",
      "ne-npc-sprite-chest",
      "ne-npc-sprite-feet",
      "ne-npc-sprite-legs",
      "ne-npc-sprite-weapon",
    ];

    // Show/hide animated-only fields when sprite type changes
    const spriteTypeEl = document.getElementById("ne-npc-sprite-type") as HTMLSelectElement;
    const animatedFields = document.getElementById("ne-sprite-animated-fields");
    const spriteFields = document.getElementById("ne-sprite-fields");
    if (spriteTypeEl) {
      const updateSpriteVisibility = () => {
        const val = spriteTypeEl.value;
        if (spriteFields) spriteFields.style.display = val === "none" ? "none" : "block";
        if (animatedFields) animatedFields.style.display = val === "animated" ? "block" : "none";
      };
      spriteTypeEl.addEventListener("change", updateSpriteVisibility);
      updateSpriteVisibility();
    }
    for (const id of formFields) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", () => this.markDirty());
        el.addEventListener("change", () => this.markDirty());
      }
    }
  }

  private setupPanelDragAndResize() {
    const panels = [
      { panel: this.propertiesPanel, storageKey: "ne-properties-pos" },
      { panel: this.npcListPanel, storageKey: "ne-list-pos" },
    ];

    for (const { panel, storageKey } of panels) {
      if (!panel) continue;

      const header = panel.querySelector(".ne-panel-header") as HTMLElement;
      if (header) {
        let isDown = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener("mousedown", (e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          isDown = true;
          offsetX = e.clientX - panel!.offsetLeft;
          offsetY = e.clientY - panel!.offsetTop;
        });

        document.addEventListener("mousemove", (e) => {
          if (!isDown) return;
          panel!.style.left = (e.clientX - offsetX) + "px";
          panel!.style.top = (e.clientY - offsetY) + "px";
          localStorage.setItem(storageKey, JSON.stringify({
            x: panel!.offsetLeft,
            y: panel!.offsetTop,
          }));
        });

        document.addEventListener("mouseup", () => {
          isDown = false;
        });
      }

      const minimizeBtn = panel.querySelector(".ne-panel-minimize");
      if (minimizeBtn) {
        minimizeBtn.addEventListener("click", () => {
          const content = panel!.querySelector(".ne-panel-content") as HTMLElement;
          if (content) {
            content.style.display = content.style.display === "none" ? "block" : "none";
          }
        });
      }

      const closeBtn = panel.querySelector(".ne-panel-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          if (panel === this.npcListPanel) {
            this.toggle();
          } else {
            panel!.style.display = "none";
          }
        });
      }
    }
  }

  private loadStoredPanelStates() {
    const panels = [
      { panel: this.propertiesPanel, storageKey: "ne-properties-pos", defaultX: 400, defaultY: 50 },
      { panel: this.npcListPanel, storageKey: "ne-list-pos", defaultX: 50, defaultY: 50 },
    ];

    for (const { panel, storageKey, defaultX, defaultY } of panels) {
      if (!panel) continue;
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const { x, y } = JSON.parse(stored);
        panel.style.left = x + "px";
        panel.style.top = y + "px";
      } else {
        panel.style.left = defaultX + "px";
        panel.style.top = defaultY + "px";
      }
    }
  }

  private loadNpcs() {
    const sendRequest = (window as any).sendRequest;
    if (sendRequest) {
      sendRequest({ type: "LIST_NPCS", data: null });
    }
  }

  private loadParticleOptions() {
    const sendRequest = (window as any).sendRequest;
    if (sendRequest) {
      sendRequest({ type: "LIST_PARTICLES", data: null });
    }
  }

  public setNpcs(npcs: any[]) {
    this.npcs = npcs;
    this.refreshNpcList();

    // Auto-select if a click arrived before the list was loaded
    if (this.pendingSelectId !== null) {
      const npc = this.npcs.find((n) => n.id === this.pendingSelectId);
      if (npc) this.selectNpc(npc);
      this.pendingSelectId = null;
    }

    if (this.selectedNpc) {
      const updated = this.npcs.find((n) => n.id === this.selectedNpc.id);
      if (updated) {
        this.selectedNpc = updated;
        this.populateForm(updated);
      }
    }
  }

  public setParticleOptions(particles: any[]) {
    this.availableParticles = particles.map((p: any) => p.name || p).filter(Boolean);
    this.renderParticleOptions();
  }

  private renderParticleOptions() {
    const container = document.getElementById("ne-particle-options");
    if (!container) return;

    container.innerHTML = "";

    const selectedParticleNames = this.getSelectedParticleNames();
    const filtered = this.availableParticles.filter((name) =>
      name.toLowerCase().includes(this.particleSearchQuery)
    );

    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding: 6px; color: rgba(255,255,255,0.4); font-size: 12px;">No particles found</div>';
      return;
    }

    for (const name of filtered) {
      const row = document.createElement("label");
      row.className = "ne-particle-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = name;
      checkbox.checked = selectedParticleNames.includes(name);
      checkbox.addEventListener("change", () => this.markDirty());

      const text = document.createElement("span");
      text.textContent = name;

      row.appendChild(checkbox);
      row.appendChild(text);
      container.appendChild(row);
    }
  }

  private getSelectedParticleNames(): string[] {
    const container = document.getElementById("ne-particle-options");
    if (!container) return [];
    const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked");
    return Array.from(checkboxes).map((cb) => cb.value);
  }

  private refreshNpcList() {
    if (!this.npcListEl) return;

    this.npcListEl.innerHTML = "";

    const filtered = this.npcs.filter((npc) =>
      `NPC #${npc.id}`.toLowerCase().includes(this.searchQuery)
    );

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding: 8px; color: rgba(255,255,255,0.4); font-size: 12px; text-align: center;";
      empty.textContent = "No NPCs in this map";
      this.npcListEl.appendChild(empty);
      return;
    }

    for (const npc of filtered) {
      const item = document.createElement("div");
      item.className = "ne-npc-item";
      if (this.selectedNpc?.id === npc.id) item.classList.add("selected");

      const x = npc.position?.x ?? 0;
      const y = npc.position?.y ?? 0;
      item.textContent = npc.id === null
        ? "New NPC (unsaved)"
        : `NPC #${npc.id} @ (${Math.round(x)}, ${Math.round(y)})`;
      item.addEventListener("click", () => this.selectNpc(npc));
      this.npcListEl!.appendChild(item);
    }
  }

  private selectNpc(npc: any) {
    this.selectedNpc = npc;
    this.isDirty = false;
    this.populateForm(npc);
    this.refreshNpcList();
    this.updateDirtyIndicator();
    this.setPropertiesPanelVisible(true);
  }

  private populateForm(npc: any) {
    const idEl = document.getElementById("ne-npc-id");
    if (idEl) idEl.textContent = npc.id !== null ? `#${npc.id}` : "(unsaved)";

    const posEl = document.getElementById("ne-npc-position");
    if (posEl) {
      const x = npc.position?.x ?? 0;
      const y = npc.position?.y ?? 0;
      posEl.textContent = `(${Math.round(x)}, ${Math.round(y)})`;
    }

    const directionEl = document.getElementById("ne-npc-direction") as HTMLSelectElement;
    if (directionEl) directionEl.value = npc.position?.direction || "down";

    const hiddenEl = document.getElementById("ne-npc-hidden") as HTMLInputElement;
    if (hiddenEl) hiddenEl.checked = Boolean(npc.hidden);

    const nameEl = document.getElementById("ne-npc-name") as HTMLInputElement;
    if (nameEl) nameEl.value = npc.name || "";

    const dialogEl = document.getElementById("ne-npc-dialog") as HTMLTextAreaElement;
    if (dialogEl) dialogEl.value = npc.dialog || "";

    const scriptEl = document.getElementById("ne-npc-script") as HTMLTextAreaElement;
    if (scriptEl) scriptEl.value = npc.script || "";

    const questEl = document.getElementById("ne-npc-quest") as HTMLInputElement;
    if (questEl) questEl.value = npc.quest != null ? String(npc.quest) : "";

    const spriteTypeEl = document.getElementById("ne-npc-sprite-type") as HTMLSelectElement;
    if (spriteTypeEl) {
      spriteTypeEl.value = npc.sprite_type || "none";
      spriteTypeEl.dispatchEvent(new Event("change"));
    }

    const spriteLayerIds: [string, string][] = [
      ["ne-npc-sprite-body", "sprite_body"],
      ["ne-npc-sprite-head", "sprite_head"],
      ["ne-npc-sprite-helmet", "sprite_helmet"],
      ["ne-npc-sprite-shoulderguards", "sprite_shoulderguards"],
      ["ne-npc-sprite-neck", "sprite_neck"],
      ["ne-npc-sprite-hands", "sprite_hands"],
      ["ne-npc-sprite-chest", "sprite_chest"],
      ["ne-npc-sprite-feet", "sprite_feet"],
      ["ne-npc-sprite-legs", "sprite_legs"],
      ["ne-npc-sprite-weapon", "sprite_weapon"],
    ];
    for (const [elId, field] of spriteLayerIds) {
      const el = document.getElementById(elId) as HTMLInputElement;
      if (el) el.value = npc[field] || "";
    }

    let npcParticleNames: string[] = [];
    if (typeof npc.particles === "string" && npc.particles) {
      npcParticleNames = npc.particles.split(",").map((s: string) => s.trim()).filter(Boolean);
    } else if (Array.isArray(npc.particles)) {
      npcParticleNames = npc.particles.map((p: any) => (typeof p === "string" ? p : p?.name)).filter(Boolean);
    }

    const container = document.getElementById("ne-particle-options");
    if (container) {
      const checkboxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]") as any;
      for (const cb of checkboxes) {
        cb.checked = npcParticleNames.includes(cb.value);
      }
    }
  }

  private getFormData(): any {
    if (!this.selectedNpc) return null;

    const directionEl = document.getElementById("ne-npc-direction") as HTMLSelectElement;
    const hiddenEl = document.getElementById("ne-npc-hidden") as HTMLInputElement;
    const nameEl = document.getElementById("ne-npc-name") as HTMLInputElement;
    const dialogEl = document.getElementById("ne-npc-dialog") as HTMLTextAreaElement;
    const scriptEl = document.getElementById("ne-npc-script") as HTMLTextAreaElement;
    const questEl = document.getElementById("ne-npc-quest") as HTMLInputElement;
    const spriteTypeEl = document.getElementById("ne-npc-sprite-type") as HTMLSelectElement;
    const g = (id: string) => (document.getElementById(id) as HTMLInputElement)?.value?.trim() || null;

    return {
      id: this.selectedNpc.id,
      map: this.selectedNpc.map,
      position: {
        x: this.selectedNpc.position?.x ?? 0,
        y: this.selectedNpc.position?.y ?? 0,
        direction: directionEl?.value || "down",
      },
      hidden: hiddenEl?.checked ?? false,
      name: nameEl?.value?.trim() || null,
      dialog: dialogEl?.value || null,
      script: scriptEl?.value || null,
      quest: questEl?.value ? Number(questEl.value) : null,
      particles: this.getSelectedParticleNames(),
      sprite_type: (spriteTypeEl?.value || "none") as 'none' | 'static' | 'animated',
      sprite_body: g("ne-npc-sprite-body"),
      sprite_head: g("ne-npc-sprite-head"),
      sprite_helmet: g("ne-npc-sprite-helmet"),
      sprite_shoulderguards: g("ne-npc-sprite-shoulderguards"),
      sprite_neck: g("ne-npc-sprite-neck"),
      sprite_hands: g("ne-npc-sprite-hands"),
      sprite_chest: g("ne-npc-sprite-chest"),
      sprite_feet: g("ne-npc-sprite-feet"),
      sprite_legs: g("ne-npc-sprite-legs"),
      sprite_weapon: g("ne-npc-sprite-weapon"),
    };
  }

  private saveNpc() {
    if (!this.selectedNpc) return;
    const data = this.getFormData();
    if (!data) return;

    const sendRequest = (window as any).sendRequest;
    if (!sendRequest) return;

    if (this.selectedNpc.id === null) {
      sendRequest({ type: "ADD_NPC", data });
    } else {
      sendRequest({ type: "SAVE_NPC", data });
    }
    this.isDirty = false;
    this.updateDirtyIndicator();
  }

  private createNewNpc() {
    if (this.hasPendingNew) return;

    const spawnX = getCameraX();
    const spawnY = getCameraY();
    const tempNpc = {
      id: null,
      map: "",
      position: { x: spawnX, y: spawnY, direction: "down" },
      hidden: false,
      dialog: null,
      script: null,
      particles: [],
      quest: null,
      sprite_type: "none",
      sprite_body: null, sprite_head: null, sprite_helmet: null,
      sprite_shoulderguards: null, sprite_neck: null, sprite_hands: null,
      sprite_chest: null, sprite_feet: null, sprite_legs: null, sprite_weapon: null,
    };

    this.hasPendingNew = true;
    this.npcs.unshift(tempNpc);

    // Add to cache.npcs so the renderer draws it immediately
    createNPC({
      id: null,
      location: { x: spawnX, y: spawnY, direction: "down" },
      dialog: "",
      hidden: false,
      particles: [],
      quest: null,
      script: null,
      map: "",
      position: { x: spawnX, y: spawnY, direction: "down" },
      last_updated: null,
      sprite_type: "none",
      spriteLayers: null,
    });

    this.selectNpc(tempNpc);
  }

  private deleteNpc() {
    if (!this.selectedNpc) return;

    const modal = document.getElementById("ne-delete-npc-modal");
    const nameEl = document.getElementById("ne-delete-npc-id");
    const confirmBtn = document.getElementById("ne-delete-confirm");
    const cancelBtn = document.getElementById("ne-delete-cancel");
    if (!modal || !nameEl) return;

    nameEl.textContent = `NPC #${this.selectedNpc.id}`;
    modal.classList.add("visible");

    const cleanup = () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
      document.removeEventListener("keydown", keyHandler);
    };

    const confirmHandler = () => {
      cleanup();
      const sendRequest = (window as any).sendRequest;
      if (sendRequest) sendRequest({ type: "DELETE_NPC", data: { id: this.selectedNpc!.id } });
    };

    const cancelHandler = () => cleanup();

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") confirmHandler();
      else if (e.key === "Escape") cancelHandler();
    };

    confirmBtn?.addEventListener("click", confirmHandler);
    cancelBtn?.addEventListener("click", cancelHandler);
    document.addEventListener("keydown", keyHandler);
  }

  private markDirty() {
    if (!this.selectedNpc) return;
    this.isDirty = true;
    this.updateDirtyIndicator();
  }

  private updateDirtyIndicator() {
    const indicator = document.getElementById("ne-dirty-indicator");
    if (indicator) {
      indicator.style.display = this.isDirty ? "inline" : "none";
    }
  }

  public handleNpcUpdated(npc: any) {
    // If we have a pending unsaved NPC and this ID is new, it's the server response to ADD_NPC
    if (this.hasPendingNew && !this.npcs.find((n) => n.id === npc.id)) {
      this.npcs = this.npcs.filter((n) => n.id !== null);
      this.hasPendingNew = false;
      // Remove the temp null-id entry from the live renderer cache
      const tempIdx = cache.npcs.findIndex((n: any) => n.id === null);
      if (tempIdx >= 0) cache.npcs.splice(tempIdx, 1);
      this.npcs.push(npc);
      this.selectNpc(npc);
      this.refreshNpcList();
      return;
    }

    const idx = this.npcs.findIndex((n) => n.id === npc.id);
    if (idx >= 0) {
      this.npcs[idx] = npc;
    } else {
      this.npcs.push(npc);
    }

    this.refreshNpcList();

    if (this.selectedNpc?.id === npc.id) {
      this.selectedNpc = npc;
      this.isDirty = false;
      this.updateDirtyIndicator();
    }
  }

  public handleNpcRemoved(id: number) {
    this.npcs = this.npcs.filter((n) => n.id !== id);
    this.refreshNpcList();

    if (this.selectedNpc?.id === id) {
      this.selectedNpc = null;
      this.isDirty = false;
      this.setPropertiesPanelVisible(false);
    }
  }
}

const npcEditor = new NpcEditor();
(window as any).npcEditor = npcEditor;
export default npcEditor;
