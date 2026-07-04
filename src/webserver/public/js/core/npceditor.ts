import { getCameraX, getCameraY } from "./renderer.js";
import Cache from "./cache.js";
import { createNPC, deleteNPC } from "./npc.js";

const cache = Cache.getInstance();

const NPC_HIT_W = 32;
const NPC_HIT_H = 48;

class NpcEditor {
  public isActive: boolean = false;
  private selectedNpc: any = null;
  private npcs: any[] = [];
  private availableParticles: string[] = [];
  private selectedParticles: string[] = [];
  private isDirty: boolean = false;
  private hasPendingNew: boolean = false;
  private pendingSelectId: number | null = null;

  // Drag state
  private draggingNpc: any = null;
  private dragStarted: boolean = false;
  private dragOffsetX: number = 0;
  private dragOffsetY: number = 0;
  private dragStartX: number = 0;
  private dragStartY: number = 0;

  // Undo/Redo state
  private positionHistory: Array<{ npcId: number; x: number; y: number }[]> = [];
  private historyIndex: number = -1;

  // Track last saved NPC
  private lastSavedNpcId: number | null = null;

  // Bound handlers
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  // External window
  private editorWindow: Window | null = null;
  private bridgeReady: boolean = false;
  private messageQueue: any[] = [];
  private windowCloseInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
    window.addEventListener('message', this.onBridgeMessage.bind(this));
  }

  public toggle() {
    if (this.isActive) {
      this.closeEditor();
    } else {
      this.openEditor();
    }
  }

  public refresh() {
    if (!this.isActive) return;
    this.npcs = [];
    this.selectedNpc = null;
    this.loadNpcs();
    this.loadParticleOptions();
    this.sendToEditor({ type: 'npcListUpdate', npcs: [] });
  }

  // ===== External window management =====

  private openEditor() {
    this.isActive = true;

    const url = window.location.origin + '/npc-editor';
    this.editorWindow = window.open(url, 'NpcEditor',
      'width=1100,height=750,left=120,top=80,location=no,toolbar=no,menubar=no,status=no');

    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }

    this.windowCloseInterval = setInterval(() => {
      if (this.editorWindow && this.editorWindow.closed) {
        this.onWindowClosed();
      }
    }, 500);

    document.addEventListener("mousedown", this.boundMouseDown, { capture: true });
    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mouseup", this.boundMouseUp);
    document.addEventListener("keydown", this.boundKeyDown);

    this.selectedNpc = null;
    this.isDirty = false;

    this.loadNpcs();
    this.loadParticleOptions();
  }

  private closeEditor() {
    this.isActive = false;

    this.stopDrag();
    document.removeEventListener("mousedown", this.boundMouseDown, { capture: true });
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseup", this.boundMouseUp);
    document.removeEventListener("keydown", this.boundKeyDown);

    if (this.editorWindow && !this.editorWindow.closed) {
      this.editorWindow.postMessage({ type: 'close' }, '*');
      this.editorWindow.close();
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.messageQueue = [];
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }
  }

  private onWindowClosed() {
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.messageQueue = [];
    this.isActive = false;
    this.stopDrag();
    document.removeEventListener("mousedown", this.boundMouseDown, { capture: true });
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseup", this.boundMouseUp);
    document.removeEventListener("keydown", this.boundKeyDown);
  }

  private sendToEditor(msg: any) {
    if (this.bridgeReady && this.editorWindow) {
      this.editorWindow.postMessage(msg, '*');
    } else {
      this.messageQueue.push(msg);
    }
  }

  private markBridgeReady() {
    if (!this.bridgeReady) {
      this.bridgeReady = true;
      while (this.messageQueue.length > 0) {
        this.editorWindow!.postMessage(this.messageQueue.shift()!, '*');
      }
    }
  }

  private syncToBridge() {
    this.sendToEditor({
      type: 'init',
      npcs: this.npcs,
      particles: this.availableParticles,
      selectedParticles: this.selectedParticles,
      selectedNpc: this.selectedNpc,
      selectedNpcId: this.selectedNpc ? this.selectedNpc.id : null,
      isDirty: this.isDirty,
    });
  }

  private onBridgeMessage(e: MessageEvent) {
    if (!this.editorWindow || e.source !== this.editorWindow) return;
    this.markBridgeReady();

    const msg = e.data;
    if (msg.type === 'bridgeReady') {
      this.syncToBridge();
      return;
    }

    switch (msg.type) {
      case 'selectNpc': {
        const npc = this.npcs.find(function (n) { return n.id === msg.id; });
        if (npc) this.selectNpc(npc);
        break;
      }
      case 'fieldUpdate': {
        if (msg.npc) {
          const liveNpc = cache.npcs.find(function (n) { return n.id === msg.npc.id; });
          if (liveNpc) {
            liveNpc.hidden = msg.npc.hidden;
            if (msg.npc.position) {
              liveNpc.position.direction = msg.npc.position.direction;
            }
          }
          const npcIdx = this.npcs.findIndex(function (n) { return n.id === msg.npc.id; });
          if (npcIdx >= 0) {
            this.npcs[npcIdx] = Object.assign({}, this.npcs[npcIdx], msg.npc);
          }
          this.isDirty = true;
        }
        break;
      }
      case 'saveNpc':
        this.handleBridgeSave(msg.npc);
        break;
      case 'createNpc':
        this.createNewNpc();
        break;
      case 'deleteNpc':
        this.handleBridgeDelete(msg.id);
        break;
      case 'editorClosed':
        if (this.windowCloseInterval) clearInterval(this.windowCloseInterval);
        this.windowCloseInterval = null;
        this.editorWindow = null;
        this.bridgeReady = false;
        this.messageQueue = [];
        this.isActive = false;
        this.stopDrag();
        document.removeEventListener("mousedown", this.boundMouseDown, { capture: true });
        document.removeEventListener("mousemove", this.boundMouseMove);
        document.removeEventListener("mouseup", this.boundMouseUp);
        document.removeEventListener("keydown", this.boundKeyDown);
        break;
    }
  }

  private handleBridgeSave(npcData: any) {
    if (!npcData) return;

    // Select the NPC if it's the one being saved
    if (this.selectedNpc && this.selectedNpc.id === npcData.id) {
      // Update selected NPC with saved data
      Object.assign(this.selectedNpc, npcData);
    } else if (npcData.id !== null) {
      const npc = this.npcs.find(function (n) { return n.id === npcData.id; });
      if (npc) this.selectNpc(npc);
    }

    this.lastSavedNpcId = npcData.id;

    const sendRequest = (window as any).sendRequest;
    if (npcData.id === null) {
      sendRequest({ type: "ADD_NPC", data: npcData });
    } else {
      sendRequest({ type: "SAVE_NPC", data: npcData });
    }

    // Update editor NPC array
    const npcIndex = this.npcs.findIndex(function (n) { return n.id === npcData.id; });
    if (npcIndex >= 0) {
      this.npcs[npcIndex] = Object.assign({}, this.npcs[npcIndex], npcData);
    }

    const liveNpc = cache.npcs.find(function (n) { return n.id === npcData.id; });
    if (liveNpc && npcData.position) {
      liveNpc.position = Object.assign({}, liveNpc.position, npcData.position);
    }

    this.isDirty = false;
  }

  private handleBridgeDelete(id: any) {
    if (id === null) {
      // Unsaved NPC
      if (this.selectedNpc) {
        this.npcs = this.npcs.filter((n: any) => n !== this.selectedNpc);
        deleteNPC(this.selectedNpc);
        this.selectedNpc = null;
        this.hasPendingNew = false;
      }
    } else {
      const sendRequest = (window as any).sendRequest;
      if (sendRequest) sendRequest({ type: "DELETE_NPC", data: { id: id } });
    }
    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }

  // ===== Canvas interaction (NPC dragging) =====

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

      if (liveNpc.hidden) {
        const centerX = nx + 16;
        const centerY = ny + 24;
        const squareSize = 16;
        if (wx >= centerX - squareSize / 2 && wx <= centerX + squareSize / 2 &&
            wy >= centerY - squareSize / 2 && wy <= centerY + squareSize / 2) {
          const data = this.npcs.find((n) => n.id === liveNpc.id) ?? null;
          return { live: liveNpc, data };
        }
      }
    }
    return null;
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.isActive) return;
    if ((e.target as HTMLElement).closest(".ne-floating-panel, .ne-modal")) return;

    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.findNpcAtWorld(wx, wy);
    if (!hit) return;

    e.stopPropagation();
    this.draggingNpc = hit.live;
    this.dragStarted = false;
    this.dragStartX = wx;
    this.dragStartY = wy;
    this.dragOffsetX = wx - (hit.live.position?.x ?? 0);
    this.dragOffsetY = wy - (hit.live.position?.y ?? 0);
    document.body.style.cursor = "grabbing";

    this.savePositionHistory();
  }

  private onMouseMove(e: MouseEvent) {
    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);

    if (this.draggingNpc) {
      const dx = wx - this.dragStartX;
      const dy = wy - this.dragStartY;
      if (!this.dragStarted && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        this.dragStarted = true;
      }
      if (this.dragStarted) {
        const newX = wx - this.dragOffsetX;
        const newY = wy - this.dragOffsetY;

        this.draggingNpc.position.x = newX;
        this.draggingNpc.position.y = newY;

        if (this.selectedNpc?.id === this.draggingNpc.id) {
          this.sendToEditor({ type: 'positionUpdate', id: this.draggingNpc.id, x: Math.round(newX), y: Math.round(newY) });
        }
      }
    } else {
      const hit = this.findNpcAtWorld(wx, wy);
      document.body.style.cursor = hit ? "grab" : "default";
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (!this.draggingNpc) return;

    if (!this.dragStarted) {
      const id = this.draggingNpc!.id;
      const editorNpc = this.npcs.find((n) => n.id === id);
      if (editorNpc) {
        this.selectNpc(editorNpc);
      } else {
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

    const dataIdx = this.npcs.findIndex((n) => n.id === id);
    if (dataIdx >= 0) {
      this.npcs[dataIdx] = {
        ...this.npcs[dataIdx],
        position: { ...this.npcs[dataIdx].position, x: finalX, y: finalY },
      };
      if (this.selectedNpc?.id === id) {
        this.selectedNpc.position.x = finalX;
        this.selectedNpc.position.y = finalY;
      }
      this.markDirty();
      this.savePositionHistory();
    } else {
      this.pendingSelectId = id;
      this.loadNpcs();
    }

    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
    this.stopDrag();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
    } else if (e.ctrlKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      this.undo();
    } else if (e.ctrlKey && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      this.redo();
    }
  }

  private stopDrag() {
    this.draggingNpc = null;
    this.dragStarted = false;
    document.body.style.cursor = "";
  }

  // ===== Undo/Redo =====

  private savePositionHistory() {
    const snapshot = cache.npcs.map((npc: any) => ({
      npcId: npc.id,
      x: npc.position.x,
      y: npc.position.y,
    }));
    this.positionHistory = this.positionHistory.slice(0, this.historyIndex + 1);
    this.positionHistory.push(snapshot);
    this.historyIndex++;
    if (this.positionHistory.length > 50) {
      this.positionHistory.shift();
      this.historyIndex--;
    }
  }

  private undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    const snapshot = this.positionHistory[this.historyIndex];
    this.applyPositionSnapshot(snapshot);
    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }

  private redo() {
    if (this.historyIndex >= this.positionHistory.length - 1) return;
    this.historyIndex++;
    const snapshot = this.positionHistory[this.historyIndex];
    this.applyPositionSnapshot(snapshot);
    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }

  private applyPositionSnapshot(snapshot: Array<{ npcId: number; x: number; y: number }>) {
    for (const entry of snapshot) {
      const liveNpc = cache.npcs.find((n: any) => n.id === entry.npcId);
      if (liveNpc) {
        liveNpc.position.x = entry.x;
        liveNpc.position.y = entry.y;
      }
      const dataIdx = this.npcs.findIndex((n: any) => n.id === entry.npcId);
      if (dataIdx >= 0) {
        this.npcs[dataIdx].position.x = entry.x;
        this.npcs[dataIdx].position.y = entry.y;
      }
    }
  }

  // ===== NPC selection =====

  private selectNpc(npc: any) {
    this.selectedNpc = npc;
    this.isDirty = false;
    this.selectedParticles = npc.particles || [];
    this.sendToEditor({
      type: 'npcSelectUpdate',
      npc: npc,
    });
  }

  private markDirty() {
    this.isDirty = true;
  }

  // ===== Server communication =====

  private loadNpcs() {
    const sendRequest = (window as any).sendRequest;
    if (sendRequest) sendRequest({ type: "LIST_NPCS", data: null });
  }

  private loadParticleOptions() {
    const sendRequest = (window as any).sendRequest;
    if (sendRequest) sendRequest({ type: "LIST_PARTICLES", data: null });
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
      name: null,
    };

    this.hasPendingNew = true;
    this.npcs.unshift(tempNpc);

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
      name: null,
    });

    this.selectNpc(tempNpc);
    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }

  // ===== Public methods called from socket =====

  public setNpcs(npcs: any[]) {
    // Merge with existing to preserve unsaved position changes
    for (const newNpc of npcs) {
      const existingIdx = this.npcs.findIndex(function (n) { return n.id === newNpc.id; });
      if (existingIdx >= 0) {
        const existing = this.npcs[existingIdx];
        // Only preserve position if dirty and this is the selected NPC
        if (this.isDirty && this.selectedNpc && this.selectedNpc.id === newNpc.id) {
          newNpc.position = { ...newNpc.position, x: existing.position.x, y: existing.position.y };
        }
        this.npcs[existingIdx] = newNpc;
      } else {
        this.npcs.push(newNpc);
      }
    }

    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });

    if (this.pendingSelectId !== null) {
      const pending = this.npcs.find((n: any) => n.id === this.pendingSelectId);
      if (pending) this.selectNpc(pending);
      this.pendingSelectId = null;
    }
  }

  public setParticleOptions(particles: any[]) {
    this.availableParticles = Array.isArray(particles)
      ? particles.map((p: any) => typeof p === 'string' ? p : (p.name || ''))
      : [];
    this.sendToEditor({ type: 'particleOptions', particles: this.availableParticles });
  }

  public handleNpcUpdated(npc: any) {
    if (!npc || npc.id == null) return;

    const existingIdx = this.npcs.findIndex(function (n) { return n.id === npc.id; });
    if (existingIdx >= 0) {
      this.npcs[existingIdx] = Object.assign({}, this.npcs[existingIdx], npc);
    }

    // If this was a newly created NPC (id was null), update the reference
    if (this.hasPendingNew && this.lastSavedNpcId === null) {
      this.hasPendingNew = false;
    }

    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }

  public handleNpcRemoved(id: number) {
    this.npcs = this.npcs.filter(function (n) { return n.id !== id; });
    if (this.selectedNpc && this.selectedNpc.id === id) {
      this.selectedNpc = null;
    }
    this.sendToEditor({ type: 'npcListUpdate', npcs: this.npcs });
  }
}

const npcEditor = new NpcEditor();
(window as any).npcEditor = npcEditor;
export default npcEditor;
