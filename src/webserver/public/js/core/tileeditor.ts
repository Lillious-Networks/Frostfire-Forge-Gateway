import { sendRequest } from "./socket.js";
import { canvas, ctx, collisionTilesDebugCheckbox, noPvpDebugCheckbox, shadowsDebugCheckbox } from "./ui.js";
import { renderChunkToCanvas, redrawChunkCells, ensureChunkForTile, parseChunkKey, clearChunkFromCache, rebakeAllChunks } from "./map.js";
import { panEditorCamera } from "./renderer.js";

declare global {
  interface Window {
    mapData?: any;
  }
}

function drawTileWithFlags(
  renderCtx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  srcX: number, srcY: number, srcW: number, srcH: number,
  destX: number, destY: number, destW: number, destH: number,
  tileGid: number
): void {
  const flipH = (tileGid & 0x80000000) !== 0;
  const flipV = (tileGid & 0x40000000) !== 0;
  const flipD = (tileGid & 0x20000000) !== 0;

  const cx = destX + destW / 2;
  const cy = destY + destH / 2;

  if (flipH || flipV || flipD) {
    let rot = 0;
    let effH = flipH;
    let effV = flipV;
    if (flipD) {
      rot = Math.PI / 2;
      effH = flipV;
      effV = !flipH;
    }
    renderCtx.save();
    renderCtx.translate(cx, cy);
    if (rot !== 0) renderCtx.rotate(rot);
    renderCtx.scale(effH ? -1 : 1, effV ? -1 : 1);
    renderCtx.drawImage(image, srcX, srcY, srcW, srcH, -destW / 2, -destH / 2, destW, destH);
    renderCtx.restore();
  } else {
    renderCtx.drawImage(image, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
  }
}

function getTileBaseGid(gid: number): number { return gid & 0x0FFFFFFF; }


interface TileChange {
  chunkX: number;
  chunkY: number;
  layerName: string;
  tileX: number;
  tileY: number;
  oldTileId: number;
  newTileId: number;
}

interface TileChangeGroup {
  changes: TileChange[];
}

interface ObjectMutation {
  type: 'graveyard' | 'warp';
  name: string;
  oldState: { x?: number, y?: number, width?: number, height?: number } | null;
  newState: { x?: number, y?: number, width?: number, height?: number } | null;
}

class TileEditor {
  public isActive: boolean = false;
  private currentTool: 'paint' | 'erase' | 'copy' | 'paste' = 'paint';
  private selectedTile: number | null = null;
  public selectedLayer: string | null = null;
  private selectedObject: string | null = null;
  private selectedObjectName: string | null = null;
  private draggingObject: { type: string, name: string, startX: number, startY: number, offsetX: number, offsetY: number } | null = null;
  private resizingWarp: { name: string, corner: string, startX: number, startY: number, startWarpX: number, startWarpY: number, startWidth: number, startHeight: number } | null = null;
  private objectMutationStartState: { x: number, y: number, width?: number, height?: number } | null = null;
  private deleteButtonCoords: { type: string, name: string, x: number, y: number, size: number } | null = null;
  private labelCoords: Map<string, { type: string, x: number, y: number, width: number, height: number }> = new Map();
  private editingLabel: { type: string, oldName: string } | null = null;
  private labelInput: HTMLInputElement | null = null;
  private propertiesPanel: HTMLElement | null = null;
  private propertyUndoStack: any[] = [];
  private propertyRedoStack: any[] = [];
  private currentPropertyObject: any = null;
  private currentPropertyObjectType: string | null = null;
  private currentPropertyObjectName: string | null = null;
  private currentTilesetIndex: number = 0;
  private objectLayerVisibility: Map<string, boolean> = new Map();
  private layerVisibility: Map<string, boolean> = new Map();
  private layerLocked: Map<string, boolean> = new Map();
  private unsavedLayers: Set<string> = new Set();
  private undoStack: (TileChange | TileChangeGroup | ObjectMutation)[] = [];
  private redoStack: (TileChange | TileChangeGroup | ObjectMutation)[] = [];
  private copiedTile: number | null = null;
  private isMouseDown: boolean = false;
  private previewTilePos: { x: number, y: number } | null = null;
  private lastSaveTime: number = 0;
  private saveCooldownMs: number = 500;

  private selectedTiles: number[][] = [];
  private selectedTilesFromMap: boolean = false;
  private modifiedChunkKeys: Set<string> = new Set();
  private layerDataSnapshot: Map<string, Map<string, number[]>> | null = null;

  private isMapDraggingSelection: boolean = false;
  private mapDragStartTile: { x: number, y: number } | null = null;
  private mapDragEndTile: { x: number, y: number } | null = null;

  private editorWindow: Window | null = null;
  private bridgeReady: boolean = false;
  private messageQueue: any[] = [];
  private windowCloseInterval: ReturnType<typeof setInterval> | null = null;
  private isPanningMap = false;
  private panLastX = 0;
  private panLastY = 0;
  private isShiftHeld = false;
  private lastPlacedTilePos: { x: number, y: number } | null = null;

  constructor() {
    this.setupEventListeners();
    this.setupMessageListener();
  }

  private setupEventListeners() {

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => { this.isShiftHeld = false; });

    canvas.addEventListener('mousemove', (e) => this.onMapMouseMove(e));
    canvas.addEventListener('mousedown', (e) => this.onMapMouseDown(e));
    canvas.addEventListener('mouseup', () => this.onMapMouseUp());
    canvas.addEventListener('mouseleave', () => this.onMapMouseUp());
    canvas.addEventListener('contextmenu', (e) => this.onMapContextMenu(e));
  }

  public async toggle() {
    if (this.isActive) {
      await this.closeEditor();
    } else {
      await this.openEditor();
    }
  }

  public async refresh() {
    if (!this.isActive) return;
    await this.closeEditor();
    await this.openEditor();
  }

  private async openEditor() {
    this.isActive = true;
    this.modifiedChunkKeys.clear();

    // Snapshot the saved state BEFORE sync so close reverts ALL edits (local + synced)
    this.saveLayerSnapshot();

    this.showSyncNotification();
    sendRequest({ type: 'EDITOR_OPEN', data: null });

    // Open external editor window
    const url = window.location.origin + '/map-editor';
    this.editorWindow = window.open(url, 'MapEditor',
      'width=1350,height=900,left=100,top=100,location=no,toolbar=no,menubar=no,status=no');

    if (!this.editorWindow) {
      this.showNotification('Popup blocked! Please allow popups for this site.', 'error', 5000);
      this.isActive = false;
      this.hideSyncNotification();
      return;
    }

    this.windowCloseInterval = setInterval(() => {
      if (this.editorWindow && this.editorWindow.closed) {
        this.onWindowClosed();
      }
    }, 500);

    await this.waitForSyncReady();
    this.hideSyncNotification();

    this.initialize();
    this.syncEditorState();
    this.sendTilesetImages();
  }

  private async closeEditor() {
    this.isActive = false;
    this.hideSyncNotification();

    if (this.editorWindow && !this.editorWindow.closed) {
      this.sendToEditor({ type: 'close' });
      this.editorWindow.close();
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }

    sendRequest({ type: 'EDITOR_CLOSE', data: null });

    await this.restoreLayerSnapshot();

    collisionTilesDebugCheckbox.checked = false;
    noPvpDebugCheckbox.checked = false;

    const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
    if (gridCheckbox) {
      gridCheckbox.checked = false;
    }
  }

  private onWindowClosed() {
    if (this.windowCloseInterval) {
      clearInterval(this.windowCloseInterval);
      this.windowCloseInterval = null;
    }
    this.editorWindow = null;
    this.bridgeReady = false;
    this.isActive = false;
    this.hideSyncNotification();

    sendRequest({ type: 'EDITOR_CLOSE', data: null });

    this.restoreLayerSnapshot();

    collisionTilesDebugCheckbox.checked = false;
    noPvpDebugCheckbox.checked = false;

    const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
    if (gridCheckbox) {
      gridCheckbox.checked = false;
    }
  }

  private saveLayerSnapshot() {
    if (!window.mapData) return;
    this.layerDataSnapshot = new Map();
    for (const [chunkKey, chunkData] of window.mapData.loadedChunks) {
      const layerMap = new Map<string, number[]>();
      for (const layer of chunkData.layers) {
        layerMap.set(layer.name, layer.data ? [...layer.data] : []);
      }
      this.layerDataSnapshot.set(chunkKey, layerMap);
    }
  }

  private async restoreLayerSnapshot() {
    if (!window.mapData || !this.layerDataSnapshot) return;

    const rebakes: Promise<void>[] = [];

    for (const chunkKey of this.modifiedChunkKeys) {
      const chunkData = window.mapData.loadedChunks.get(chunkKey);
      const savedLayers = this.layerDataSnapshot.get(chunkKey);
      if (!chunkData || !savedLayers) continue;

      for (const [layerName, saved] of savedLayers) {
        const layer = chunkData.layers.find((l: any) => l.name === layerName);
        if (layer && saved.length === layer.data.length) {
          for (let i = 0; i < saved.length; i++) {
            layer.data[i] = saved[i];
          }
        }
      }

      rebakes.push(
        renderChunkToCanvas(chunkData, true).then(({ lowerCanvas, upperCanvas }) => {
          chunkData.lowerCanvas = lowerCanvas;
          chunkData.upperCanvas = upperCanvas;
          chunkData.canvas = lowerCanvas;
        })
      );
    }

    await Promise.all(rebakes);
    this.layerDataSnapshot = null;
  }

  private syncReadyResolve: (() => void) | null = null;

  private waitForSyncReady(): Promise<void> {
    return new Promise((resolve) => {
      this.syncReadyResolve = resolve;
    });
  }

  public onSyncReady() {
    if (this.syncReadyResolve) {
      this.syncReadyResolve();
      this.syncReadyResolve = null;
    }
  }

  private showSyncNotification() {
    // Create a DOM notification overlay
    const existing = document.getElementById('te-sync-notification');
    if (!existing) {
      const el = document.createElement('div');
      el.id = 'te-sync-notification';
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:10001;'
        + 'background:rgba(30,41,59,0.95);border:1px solid rgba(46,204,113,0.5);border-radius:6px;'
        + 'padding:10px 20px;color:#f1f5f9;font-family:\'Space Mono\',monospace;font-size:14px;'
        + 'pointer-events:none;';
      el.textContent = 'Syncing map state...';
      document.body.appendChild(el);
    }
  }

  private hideSyncNotification() {
    const el = document.getElementById('te-sync-notification');
    if (el) el.remove();
  }

  private sendToEditor(msg: any) {
    if (this.bridgeReady && this.editorWindow) {
      this.editorWindow.postMessage(msg, '*');
    } else {
      this.messageQueue.push(msg);
    }
  }

  private flushMessageQueue() {
    if (this.editorWindow && this.bridgeReady) {
      while (this.messageQueue.length > 0) {
        this.editorWindow.postMessage(this.messageQueue.shift()!, '*');
      }
    }
  }

  private setupMessageListener() {
    window.addEventListener('message', (e) => {
      if (this.editorWindow && e.source !== this.editorWindow) return;

      const msg = e.data;

      if (!this.bridgeReady) {
        this.bridgeReady = true;
        this.flushMessageQueue();
      }

      if (msg.type === 'bridgeReady') {
        this.syncEditorState();
        this.sendTilesetImages();
        return;
      }

      switch (msg.type) {
        case 'toolChange':
          this.setTool(msg.tool);
          break;
        case 'layerSelect':
          this.selectLayer(msg.layerName);
          break;
        case 'layerToggle':
          this.layerVisibility.set(msg.layerName, msg.visible);
          if (msg.visible) {
            rebakeAllChunks();
          }
          break;
        case 'layerLock': {
          this.layerLocked.set(msg.layerName, msg.locked);
          this.propagateLayerLockToChunks(msg.layerName, msg.locked);
          this.sendLayerLockChange(msg.layerName, msg.locked);
          break;
        }
        case 'objectSelect':
          if (msg.objectType) {
            this.selectObject(msg.objectType);
          } else {
            this.deselectObject();
          }
          break;
        case 'objectToggle':
          this.objectLayerVisibility.set(msg.objectType, msg.visible);
          break;
        case 'tileSelect':
          this.selectedTile = msg.tileId;
          this.selectedTiles = msg.selectedTiles || [];
          this.selectedTilesFromMap = msg.selectedTilesFromMap || false;
          break;
        case 'tilesetSelect':
          this.currentTilesetIndex = msg.index;
          break;
        case 'command':
          switch (msg.name) {
            case 'undo': this.undo(); break;
            case 'redo': this.redo(); break;
            case 'save': this.save(); break;
            case 'toggleGrid': this.toggleGrid(); break;
            case 'clear': this.clearAllEdits(); break;
            case 'toggle': this.toggle(); break;
            case 'rotateTile': this.rotateSelectedTile(); break;
          }
          break;
        case 'editorClosed': {
          if (this.windowCloseInterval) {
            clearInterval(this.windowCloseInterval);
            this.windowCloseInterval = null;
          }
          this.editorWindow = null;
          this.bridgeReady = false;
          this.isActive = false;
          this.hideSyncNotification();
          sendRequest({ type: 'EDITOR_CLOSE', data: null });
          this.restoreLayerSnapshot();
          collisionTilesDebugCheckbox.checked = false;
          noPvpDebugCheckbox.checked = false;
          const gc = document.getElementById('show-grid-checkbox') as HTMLInputElement;
          if (gc) gc.checked = false;
          break;
        }
      }
    });
  }

  private syncEditorState() {
    if (!window.mapData || !this.editorWindow) return;

    this.sendToEditor({
      type: 'init',
      tilesets: window.mapData.tilesets.map((t: any, i: number) => ({
        name: t.name,
        firstgid: t.firstgid,
        tilecount: t.tilecount,
        tilewidth: t.tilewidth,
        tileheight: t.tileheight,
        imagewidth: t.imagewidth,
        imageheight: t.imageheight,
        tiles: t.tiles
      })),
      tool: this.currentTool,
      selectedLayer: this.selectedLayer,
      selectedObject: this.selectedObject,
      selectedTile: this.selectedTile,
      selectedTiles: this.selectedTiles,
      selectedTilesFromMap: this.selectedTilesFromMap,
      layerVisibility: [...this.layerVisibility],
      layerLocked: [...this.layerLocked],
      objectVisibility: {
        Graveyards: this.objectLayerVisibility.get('Graveyards') ?? true,
        Warps: this.objectLayerVisibility.get('Warps') ?? true
      },
      unsavedLayers: [...this.unsavedLayers]
    });

    this.sendLayersToEditor();
  }

  private sendLayersToEditor() {
    if (!window.mapData || !this.editorWindow) return;

    const firstChunk = window.mapData.loadedChunks.values().next().value;
    if (!firstChunk) return;

    const layers = firstChunk.layers.sort((a: any, b: any) => a.zIndex - b.zIndex);

    const layerData: any[] = [];
    layers.forEach((layer: any) => {
      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');
      const isShadow = layer.name.toLowerCase().includes('shadow');
      layerData.push({
        name: layer.name,
        zIndex: layer.zIndex,
        locked: this.layerLocked.get(layer.name) ?? (layer.locked ?? false),
        isCollision,
        isNoPvp,
        isShadow
      });
    });

    this.sendToEditor({
      type: 'layerUpdate',
      layers: layerData,
      unsavedLayers: [...this.unsavedLayers]
    });
  }

  private sendTilesetImages() {
    if (!window.mapData || !this.editorWindow) return;

    window.mapData.tilesets.forEach((tileset: any, index: number) => {
      const image = window.mapData.images[index];
      if (!image || !image.complete) return;

      try {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = tileset.imagewidth;
        tempCanvas.height = tileset.imageheight;
        const tempCtx = tempCanvas.getContext('2d')!;
        tempCtx.drawImage(image, 0, 0);
        const dataUrl = tempCanvas.toDataURL('image/png');

        this.sendToEditor({
          type: 'tilesetImage',
          index,
          dataUrl
        });
      } catch (e) {
        console.error('Error converting tileset image:', e);
      }
    });
  }

  private initialize() {
    if (!window.mapData) return;

    // Convert graveyards and warps from arrays to objects for editor convenience
    this.convertMapObjectsToEditorFormat();

    this.loadLayers();
    this.loadObjectLayers();
    this.loadTilesets();

  }

  private convertMapObjectsToEditorFormat() {
    if (!window.mapData) return;

    // Convert graveyards array to object with name keys
    if (Array.isArray(window.mapData.graveyards)) {
      const graveyardsObj: any = {};
      window.mapData.graveyards.forEach((g: any) => {
        graveyardsObj[g.name] = {
          position: g.position,
          layer: g.layer
        };
      });
      window.mapData.graveyards = graveyardsObj;
    }

    // Convert warps array to object with name keys
    if (Array.isArray(window.mapData.warps)) {
        const warpsObj: any = {};
        window.mapData.warps.forEach((w: any) => {
          warpsObj[w.name] = {
            map: w.map || 'default_map', // Good practice to have a fallback map name too
            x: w.x !== undefined ? w.x : 0, // Fallback to 0 instead of ''
            y: w.y !== undefined ? w.y : 0, // Fallback to 0 instead of ''
            position: w.position || { x: 0, y: 0 },
            size: w.size || { width: 32, height: 32 },
            layer: w.layer
          };
        });
        window.mapData.warps = warpsObj;
      }
    }

  private loadLayers() {
    if (!window.mapData) return;

    const firstChunk = window.mapData.loadedChunks.values().next().value;
    if (!firstChunk) return;

    const layers = firstChunk.layers
      .sort((a: any, b: any) => a.zIndex - b.zIndex);

    layers.forEach((layer: any) => {
      // Initialize visibility if not set
      if (!this.layerVisibility.has(layer.name)) {
        this.layerVisibility.set(layer.name, true);
      }

      // Always read lock state from chunk layer data (authoritative server state),
      // falling back to unlocked when no lock data is present
      if (typeof layer.locked === 'boolean') {
        this.layerLocked.set(layer.name, layer.locked);
      } else if (!this.layerLocked.has(layer.name)) {
        this.layerLocked.set(layer.name, false);
      }
    });

    // Send layers data to external editor
    this.sendLayersToEditor();

    if (layers.length > 0) {
      const firstNonSpecial = layers.find((l: any) => {
        const name = l.name.toLowerCase();
        return !name.includes('collision') && !name.includes('nopvp') && !name.includes('no-pvp') && !name.includes('shadow');
      });
      this.selectLayer(firstNonSpecial ? firstNonSpecial.name : layers[0].name);
    }
  }

  private selectLayer(layerName: string) {
    this.selectedLayer = layerName;
    this.selectedObject = null;
    this.selectedObjectName = null;
    this.deleteButtonCoords = null;

    const lowerName = layerName.toLowerCase();
    const isCollision = lowerName.includes('collision');
    const isNoPvp = lowerName.includes('nopvp') || lowerName.includes('no-pvp');
    const isShadow = lowerName.includes('shadow');

    collisionTilesDebugCheckbox.checked = isCollision;

    noPvpDebugCheckbox.checked = isNoPvp;

    shadowsDebugCheckbox.checked = isShadow;

    this.sendToEditor({ type: 'layerSelectUpdate', layerName });
  }

  private updateLayerList() {
    this.sendLayersToEditor();
  }

  private loadObjectLayers() {
    const objectTypes = ['Graveyards', 'Warps'];

    // Initialize visibility map - all visible by default
    objectTypes.forEach(type => {
      if (!this.objectLayerVisibility.has(type)) {
        this.objectLayerVisibility.set(type, true);
      }
    });
  }

  public isObjectLayerVisible(layerName: string): boolean {
    return this.objectLayerVisibility.get(layerName) ?? true;
  }

  public isLayerVisible(layerName: string): boolean {
    return this.layerVisibility.get(layerName) ?? true;
  }

  public isLayerLocked(layerName: string): boolean {
    return this.layerLocked.get(layerName) ?? false;
  }

  public getSelectedObjectName(): string | null {
    return this.selectedObjectName;
  }

  public setDeleteButtonCoords(type: string, name: string, x: number, y: number, size: number) {
    this.deleteButtonCoords = { type, name, x, y, size };
  }

  public setLabelCoords(name: string, type: string, x: number, y: number, width: number, height: number) {
    this.labelCoords.set(name, { type, x, y, width, height });
  }

  private getLabelAtPosition(clientX: number, clientY: number): { name: string, type: string } | null {
    for (const [name, coord] of this.labelCoords.entries()) {
      // Don't allow interaction with labels if that layer is not visible or not selected
      if (!this.isObjectLayerVisible(coord.type) || this.selectedObject !== coord.type) {
        continue;
      }
      if (clientX >= coord.x && clientX <= coord.x + coord.width &&
          clientY >= coord.y && clientY <= coord.y + coord.height) {
        return { name, type: coord.type };
      }
    }
    return null;
  }

  private startEditingLabel(name: string, type: string) {
    if (!window.mapData) return;

    // Get the current name from the data
    let currentName = name;
    if (type === 'Graveyards' && window.mapData.graveyards) {
      currentName = name;
    } else if (type === 'Warps' && window.mapData.warps) {
      currentName = name;
    }

    this.editingLabel = { type, oldName: name };

    // Create input element
    this.labelInput = document.createElement('input');
    this.labelInput.type = 'text';
    this.labelInput.value = currentName;
    this.labelInput.style.position = 'fixed';
    this.labelInput.style.padding = '4px 8px';
    this.labelInput.style.fontSize = '13px';
    this.labelInput.style.fontFamily = 'monospace';
    this.labelInput.style.fontWeight = 'bold';
    this.labelInput.style.border = '2px solid rgba(100, 200, 255, 1)';
    this.labelInput.style.background = 'rgba(0, 0, 0, 0.8)';
    this.labelInput.style.color = 'rgba(150, 220, 255, 1)';
    this.labelInput.style.outline = 'none';
    this.labelInput.style.zIndex = '10000';

    const labelCoord = this.labelCoords.get(name);
    if (labelCoord) {
      this.labelInput.style.left = `${labelCoord.x}px`;
      this.labelInput.style.top = `${labelCoord.y}px`;
      this.labelInput.style.width = '300px';
    }

    document.body.appendChild(this.labelInput);
    this.labelInput.focus();
    this.labelInput.select();

    // Handle Enter key to save
    this.labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.finishEditingLabel(true);
      } else if (e.key === 'Escape') {
        this.finishEditingLabel(false);
      }
    });

    // Handle blur to save
    this.labelInput.addEventListener('blur', () => {
      this.finishEditingLabel(true);
    });
  }

  private finishEditingLabel(save: boolean) {
    if (!this.labelInput || !this.editingLabel || !window.mapData) return;

    const newName = this.labelInput.value.trim();
    const { type, oldName } = this.editingLabel;

    // Store reference and clear immediately to prevent blur from firing again
    const inputElement = this.labelInput;
    this.labelInput = null;
    this.editingLabel = null;

    // Remove input element from DOM if it still exists
    if (inputElement.parentNode) {
      inputElement.remove();
    }

    if (!save || !newName || newName === oldName) {
      return;
    }

    // Check if new name already exists
    if (type === 'Graveyards' && window.mapData.graveyards) {
      if ((window.mapData.graveyards as any)[newName]) {
        alert('A graveyard with that name already exists!');
        return;
      }
      const graveyardData = (window.mapData.graveyards as any)[oldName];
      if (graveyardData) {
        // Rename the object
        (window.mapData.graveyards as any)[newName] = graveyardData;
        delete (window.mapData.graveyards as any)[oldName];

        // Record mutation
        const mutation: ObjectMutation = {
          type: 'graveyard',
          name: oldName,
          oldState: { x: graveyardData.position?.x || 0, y: graveyardData.position?.y || 0 },
          newState: { x: graveyardData.position?.x || 0, y: graveyardData.position?.y || 0 }
        };
        // Store both old and new names in mutation for rename tracking
        (mutation as any).newName = newName;
        this.undoStack.push(mutation);
        this.redoStack = [];

        // Mark Graveyards as unsaved
        this.unsavedLayers.add('Graveyards');
        this.updateLayerList();

        // Update selection
        this.selectedObjectName = newName;
      }
    } else if (type === 'Warps' && window.mapData.warps) {
      if ((window.mapData.warps as any)[newName]) {
        alert('A warp with that name already exists!');
        return;
      }
      const warpData = (window.mapData.warps as any)[oldName];
      if (warpData) {
        // Rename the object
        (window.mapData.warps as any)[newName] = warpData;
        delete (window.mapData.warps as any)[oldName];

        // Record mutation
        const mutation: ObjectMutation = {
          type: 'warp',
          name: oldName,
          oldState: {
            x: warpData.position?.x || 0,
            y: warpData.position?.y || 0,
            width: warpData.size?.width || 32,
            height: warpData.size?.height || 32
          },
          newState: {
            x: warpData.position?.x || 0,
            y: warpData.position?.y || 0,
            width: warpData.size?.width || 32,
            height: warpData.size?.height || 32
          }
        };
        // Store both old and new names in mutation for rename tracking
        (mutation as any).newName = newName;
        this.undoStack.push(mutation);
        this.redoStack = [];

        // Mark Warps as unsaved
        this.unsavedLayers.add('Warps');
        this.updateLayerList();

        // Update selection
        this.selectedObjectName = newName;
      }
    }

    // Clear label coordinates since name changed
    this.labelCoords.clear();
  }

  private deleteSelectedObject() {
    if (!this.deleteButtonCoords || !window.mapData) return;

    const { type, name } = this.deleteButtonCoords;

    if (type === 'Graveyards' && window.mapData.graveyards) {
      const graveyardData = (window.mapData.graveyards as any)[name];
      if (graveyardData) {
        // Record deletion mutation
        const oldState = {
          x: graveyardData.position?.x || graveyardData.x || 0,
          y: graveyardData.position?.y || graveyardData.y || 0
        };
        const mutation: ObjectMutation = {
          type: 'graveyard',
          name,
          oldState,
          newState: null
        };
        this.undoStack.push(mutation);
        this.redoStack = [];

        // Mark Graveyards as unsaved
        this.unsavedLayers.add('Graveyards');
        this.updateLayerList();

        // Delete the object
        delete (window.mapData.graveyards as any)[name];
        this.labelCoords.delete(name);
        this.selectedObjectName = null;
        this.deleteButtonCoords = null;
      }
    } else if (type === 'Warps' && window.mapData.warps) {
      const warpData = (window.mapData.warps as any)[name];
      if (warpData) {
        // Record deletion mutation with full state
        const oldState = {
          x: warpData.position?.x || warpData.x || 0,
          y: warpData.position?.y || warpData.y || 0,
          width: warpData.size?.width || 32,
          height: warpData.size?.height || 32
        };
        const mutation: ObjectMutation = {
          type: 'warp',
          name,
          oldState,
          newState: null
        };
        this.undoStack.push(mutation);
        this.redoStack = [];

        // Mark Warps as unsaved
        this.unsavedLayers.add('Warps');
        this.updateLayerList();

        // Delete the object
        delete (window.mapData.warps as any)[name];
        this.labelCoords.delete(name);
        this.selectedObjectName = null;
        this.deleteButtonCoords = null;
      }
    }
  }

  private selectObject(objectType: string) {
    this.selectedObject = objectType;
    this.selectedLayer = null;
    this.selectedObjectName = null;
    this.deleteButtonCoords = null;
  }

  private deselectObject() {
    this.selectedObject = null;
    this.selectedObjectName = null;
    this.deleteButtonCoords = null;
  }

  private loadTilesets() {
    if (window.mapData.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;
    this.sendToEditor({ type: 'tileSelectUpdate', tileId: this.selectedTile, tilesetIndex: index, selectedTiles: this.selectedTiles, selectedTilesFromMap: this.selectedTilesFromMap });
  }

  private onMapMouseMove(e: MouseEvent) {
    if (!this.isActive || !window.mapData) {
      this.previewTilePos = null;
      return;
    }

    this.isShiftHeld = e.shiftKey;

    if (this.isPanningMap) {
      const dx = e.clientX - this.panLastX;
      const dy = e.clientY - this.panLastY;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      panEditorCamera(-dx, -dy);
      this.previewTilePos = null;
      return;
    }

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const worldX = worldPos.x;
    const worldY = worldPos.y;

    if (this.isMapDraggingSelection) {
      const tileX = Math.floor(worldX / window.mapData.tilewidth);
      const tileY = Math.floor(worldY / window.mapData.tileheight);
      this.mapDragEndTile = { x: tileX, y: tileY };
      canvas.style.cursor = 'crosshair';
      this.previewTilePos = null;
      return;
    }

    // Handle resizing warps
    if (this.resizingWarp) {
      // Set cursor based on resize direction
      const corner = this.resizingWarp.corner;
      if (corner === 'top-left' || corner === 'bottom-right') {
        canvas.style.cursor = 'nwse-resize';
      } else if (corner === 'top-right' || corner === 'bottom-left') {
        canvas.style.cursor = 'nesw-resize';
      } else if (corner === 'top' || corner === 'bottom') {
        canvas.style.cursor = 'ns-resize';
      } else if (corner === 'left' || corner === 'right') {
        canvas.style.cursor = 'ew-resize';
      }
      const warpData = (window.mapData.warps as any)[this.resizingWarp.name];
      if (warpData && window.mapData) {
        const deltaX = worldX - this.resizingWarp.startX;
        const deltaY = worldY - this.resizingWarp.startY;

        // Get map boundaries
        const mapMaxWidth = window.mapData.width * window.mapData.tilewidth;
        const mapMaxHeight = window.mapData.height * window.mapData.tileheight;

        let newWidth = this.resizingWarp.startWidth;
        let newHeight = this.resizingWarp.startHeight;
        let newX = this.resizingWarp.startWarpX;
        let newY = this.resizingWarp.startWarpY;

        // Update size and position based on which corner/edge is being dragged
        if (this.resizingWarp.corner === 'top-right' || this.resizingWarp.corner === 'bottom-right') {
          newWidth = Math.max(1, this.resizingWarp.startWidth + deltaX);
        }
        if (this.resizingWarp.corner === 'top-left' || this.resizingWarp.corner === 'bottom-left') {
          newWidth = Math.max(1, this.resizingWarp.startWidth - deltaX);
          newX = this.resizingWarp.startWarpX + deltaX;
        }

        if (this.resizingWarp.corner === 'bottom-left' || this.resizingWarp.corner === 'bottom-right') {
          newHeight = Math.max(1, this.resizingWarp.startHeight + deltaY);
        }
        if (this.resizingWarp.corner === 'top-left' || this.resizingWarp.corner === 'top-right') {
          newHeight = Math.max(1, this.resizingWarp.startHeight - deltaY);
          newY = this.resizingWarp.startWarpY + deltaY;
        }

        // Handle edge midpoint resizing
        if (this.resizingWarp.corner === 'right') {
          newWidth = Math.max(1, this.resizingWarp.startWidth + deltaX);
        } else if (this.resizingWarp.corner === 'left') {
          newWidth = Math.max(1, this.resizingWarp.startWidth - deltaX);
          newX = this.resizingWarp.startWarpX + deltaX;
        }

        if (this.resizingWarp.corner === 'bottom') {
          newHeight = Math.max(1, this.resizingWarp.startHeight + deltaY);
        } else if (this.resizingWarp.corner === 'top') {
          newHeight = Math.max(1, this.resizingWarp.startHeight - deltaY);
          newY = this.resizingWarp.startWarpY + deltaY;
        }

        // Apply boundary constraints
        // Clamp position to map boundaries
        newX = Math.max(0, Math.min(newX, mapMaxWidth));
        newY = Math.max(0, Math.min(newY, mapMaxHeight));

        // Clamp size so warp doesn't extend beyond map
        newWidth = Math.max(1, Math.min(newWidth, mapMaxWidth - newX));
        newHeight = Math.max(1, Math.min(newHeight, mapMaxHeight - newY));

        // Update position and size
        // Note: x and y are destination coordinates from properties - do NOT update them during resize
        if (!warpData.position) {
          warpData.position = {};
        }
        warpData.position.x = newX;
        warpData.position.y = newY;

        if (!warpData.size) {
          warpData.size = {};
        }
        warpData.size.width = newWidth;
        warpData.size.height = newHeight;
      }
      return;
    }

    // Handle dragging objects
    if (this.draggingObject) {
      // Set cursor to move icon
      canvas.style.cursor = 'move';

      let newX = worldX - this.draggingObject.offsetX;
      let newY = worldY - this.draggingObject.offsetY;

      if (this.draggingObject.type === 'Graveyards') {
        const graveyardData = (window.mapData.graveyards as any)[this.draggingObject.name];
        if (graveyardData && window.mapData) {
          // Get map boundaries
          const mapMaxWidth = window.mapData.width * window.mapData.tilewidth;
          const mapMaxHeight = window.mapData.height * window.mapData.tileheight;

          // Clamp position to map boundaries
          newX = Math.max(0, Math.min(newX, mapMaxWidth));
          newY = Math.max(0, Math.min(newY, mapMaxHeight));

          // Ensure position object exists
          if (!graveyardData.position) {
            graveyardData.position = {};
          }
          graveyardData.position.x = newX;
          graveyardData.position.y = newY;
          // Keep x/y in sync for backward compatibility
          graveyardData.x = newX;
          graveyardData.y = newY;
        }
      } else if (this.draggingObject.type === 'Warps') {
        const warpData = (window.mapData.warps as any)[this.draggingObject.name];
        if (warpData && window.mapData) {
          // Get warp size
          const warpWidth = warpData.size?.width || 32;
          const warpHeight = warpData.size?.height || 32;

          // Get map boundaries
          const mapMaxWidth = window.mapData.width * window.mapData.tilewidth;
          const mapMaxHeight = window.mapData.height * window.mapData.tileheight;

          // Clamp position so warp doesn't extend beyond map
          newX = Math.max(0, Math.min(newX, mapMaxWidth - warpWidth));
          newY = Math.max(0, Math.min(newY, mapMaxHeight - warpHeight));

          // Ensure position object exists
          if (!warpData.position) {
            warpData.position = {};
          }
          warpData.position.x = newX;
          warpData.position.y = newY;
          // x and y are destination coordinates from properties - do NOT update them when moving the trigger zone
        }
      }
      return;
    }

    // Check for hover over objects to change cursor
    if (this.selectedObject === 'Graveyards' && window.mapData?.graveyards) {
      const hoveredGraveyard = this.getGraveyardAtPosition(worldX, worldY);
      if (hoveredGraveyard) {
        canvas.style.cursor = 'grab';
        this.previewTilePos = null;
        return;
      }
    } else if (this.selectedObject === 'Warps' && window.mapData?.warps) {
      // Check for resize handle hover
      const cornerClick = this.getWarpCornerAtPosition(worldX, worldY);
      if (cornerClick) {
        const corner = cornerClick.corner;
        if (corner === 'top-left' || corner === 'bottom-right') {
          canvas.style.cursor = 'nwse-resize';
        } else if (corner === 'top-right' || corner === 'bottom-left') {
          canvas.style.cursor = 'nesw-resize';
        } else if (corner === 'top' || corner === 'bottom') {
          canvas.style.cursor = 'ns-resize';
        } else if (corner === 'left' || corner === 'right') {
          canvas.style.cursor = 'ew-resize';
        }
        this.previewTilePos = null;
        return;
      }

      // Check for warp center hover
      const hoveredWarp = this.getWarpAtPosition(worldX, worldY);
      if (hoveredWarp) {
        canvas.style.cursor = 'grab';
        this.previewTilePos = null;
        return;
      }
    }

    // Check for delete button hover
    if (this.deleteButtonCoords && this.selectedObject === this.deleteButtonCoords.type) {
      const { x, y, size } = this.deleteButtonCoords;
      if (worldX >= x && worldX <= x + size && worldY >= y && worldY <= y + size) {
        canvas.style.cursor = 'pointer';
        this.previewTilePos = null;
        return;
      }
    }

    // Reset cursor to default when not dragging/resizing
    canvas.style.cursor = 'default';

    // Disable preview when an object layer is selected
    if (this.selectedObject) {
      this.previewTilePos = null;
      return;
    }

    const tileX = Math.floor(worldX / window.mapData.tilewidth);
    const tileY = Math.floor(worldY / window.mapData.tileheight);

    this.previewTilePos = { x: tileX, y: tileY };

    const isLayerLocked = this.selectedLayer ? this.isLayerLocked(this.selectedLayer) : false;

    if (!isLayerLocked && this.isMouseDown && this.currentTool === 'paint') {
      this.placeTile(tileX, tileY);
    } else if (!isLayerLocked && this.isMouseDown && this.currentTool === 'erase') {
      this.eraseTile(tileX, tileY);
    } else if (!isLayerLocked && this.isMouseDown && this.currentTool === 'paste') {
      this.pasteTile(tileX, tileY);
    }
  }

  private onMapMouseDown(e: MouseEvent) {
    if (!this.isActive || !window.mapData) return;

    // Middle-mouse drag pans the free-pan editor camera (Tiled-style navigation).
    if (e.button === 1) {
      e.preventDefault();
      this.isPanningMap = true;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      return;
    }

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const worldX = worldPos.x;
    const worldY = worldPos.y;

    // Check for delete button click
    if (this.deleteButtonCoords) {
      // Don't allow delete if the object's layer is not visible or not selected
      if (!this.isObjectLayerVisible(this.deleteButtonCoords.type) || this.selectedObject !== this.deleteButtonCoords.type) {
        return;
      }
      const { x, y, size } = this.deleteButtonCoords;
      if (worldX >= x && worldX <= x + size && worldY >= y && worldY <= y + size) {
        this.deleteSelectedObject();
        return;
      }
    }

    // Check for label click (for inline editing)
    const clickedLabel = this.getLabelAtPosition(e.clientX, e.clientY);
    if (clickedLabel) {
      e.preventDefault();
      this.startEditingLabel(clickedLabel.name, clickedLabel.type);
      return;
    }

    // Handle object selection and dragging when an object layer is selected
    if (this.selectedObject && e.button === 0) {
      let foundObject = false;

      if (this.selectedObject === 'Graveyards') {
        // Only allow interaction if layer is visible
        if (!this.isObjectLayerVisible('Graveyards')) {
          return;
        }
        const clickedGraveyard = this.getGraveyardAtPositionForInteraction(worldX, worldY);
        if (clickedGraveyard) {
          foundObject = true;
          this.selectedObjectName = clickedGraveyard;
          const graveyardData = (window.mapData.graveyards as any)[clickedGraveyard];
          if (graveyardData) {
            // Use position.x/y if available, fall back to x/y
            const gx = graveyardData.position?.x || graveyardData.x || 0;
            const gy = graveyardData.position?.y || graveyardData.y || 0;

            // Capture initial state for undo/redo
            this.objectMutationStartState = { x: gx, y: gy };

            this.draggingObject = {
              type: 'Graveyards',
              name: clickedGraveyard,
              startX: gx,
              startY: gy,
              offsetX: worldX - gx,
              offsetY: worldY - gy
            };
            e.preventDefault();
          }
        }
      } else if (this.selectedObject === 'Warps') {
        // First check if clicking on a corner to resize
        // Only allow if layer is visible and selected
        if (!this.isObjectLayerVisible('Warps')) {
          return;
        }
        const cornerClick = this.getWarpCornerAtPosition(worldX, worldY);
        if (cornerClick) {
          foundObject = true;
          const warpData = (window.mapData.warps as any)[cornerClick.name];
          if (warpData) {
            const currentWidth = warpData.size?.width || 32;
            const currentHeight = warpData.size?.height || 32;
            const currentX = warpData.position?.x || warpData.x || 0;
            const currentY = warpData.position?.y || warpData.y || 0;

            // Capture initial state for undo/redo
            this.objectMutationStartState = { x: currentX, y: currentY, width: currentWidth, height: currentHeight };

            this.resizingWarp = {
              name: cornerClick.name,
              corner: cornerClick.corner,
              startX: worldX,
              startY: worldY,
              startWarpX: currentX,
              startWarpY: currentY,
              startWidth: currentWidth,
              startHeight: currentHeight
            };
            e.preventDefault();
          }
        } else {
          // Otherwise try to drag the warp
          const clickedWarp = this.getWarpAtPositionForInteraction(worldX, worldY);
          if (clickedWarp) {
            foundObject = true;
            this.selectedObjectName = clickedWarp;
            const warpData = (window.mapData.warps as any)[clickedWarp];
            if (warpData) {
              // Use position.x/y if available, fall back to x/y
              const wx = warpData.position?.x || warpData.x || 0;
              const wy = warpData.position?.y || warpData.y || 0;
              const warpWidth = warpData.size?.width || 32;
              const warpHeight = warpData.size?.height || 32;

              // Capture initial state for undo/redo
              this.objectMutationStartState = { x: wx, y: wy, width: warpWidth, height: warpHeight };

              this.draggingObject = {
                type: 'Warps',
                name: clickedWarp,
                startX: wx,
                startY: wy,
                offsetX: worldX - wx,
                offsetY: worldY - wy
              };
              e.preventDefault();
            }
          }
        }
      }

      // If no object was found, deselect the specific object (but keep the layer selected)
      if (!foundObject) {
        this.selectedObjectName = null;
        this.deleteButtonCoords = null;
      }

      return;
    }

    const tileX = Math.floor(worldX / window.mapData.tilewidth);
    const tileY = Math.floor(worldY / window.mapData.tileheight);

    if (e.button === 2) {
      e.preventDefault();
      if (this.selectedLayer) {
        this.isMapDraggingSelection = true;
        this.mapDragStartTile = { x: tileX, y: tileY };
        this.mapDragEndTile = { x: tileX, y: tileY };
      } else {
        this.copyTileFromWorld(tileX, tileY);
      }
      return;
    }

    if (e.button === 0) {
      this.isMouseDown = true;

      if (this.selectedLayer && this.isLayerLocked(this.selectedLayer)) {
        return;
      }

      if ((this.isShiftHeld || e.shiftKey) && this.lastPlacedTilePos) {
        if (this.currentTool === 'paint') {
          this.placeLineTiles(this.lastPlacedTilePos.x, this.lastPlacedTilePos.y, tileX, tileY);
        } else if (this.currentTool === 'paste') {
          this.pasteLineTiles(this.lastPlacedTilePos.x, this.lastPlacedTilePos.y, tileX, tileY);
        }
        this.lastPlacedTilePos = { x: tileX, y: tileY };
        return;
      }

      if (this.currentTool === 'paint') {
        this.placeTile(tileX, tileY);
      } else if (this.currentTool === 'erase') {
        this.eraseTile(tileX, tileY);
      } else if (this.currentTool === 'paste') {
        this.pasteTile(tileX, tileY);
      } else if (this.currentTool === 'copy') {
        this.copyTileFromWorld(tileX, tileY);
      }
    }
  }

  private getGraveyardAtPosition(worldX: number, worldY: number): string | null {
    if (!window.mapData?.graveyards) return null;

    for (const [name, data] of Object.entries(window.mapData.graveyards)) {
      if (data && typeof data === 'object') {
        const gData = data as any;
        const graveyardX = gData.position?.x || gData.x || 0;
        const graveyardY = gData.position?.y || gData.y || 0;
        // Graveyards are rendered centered, so use fixed dimensions from renderer
        const graveyardWidth = 16;
        const graveyardHeight = 22;

        // Check if click is within the centered bounds
        if (worldX >= graveyardX - graveyardWidth / 2 && worldX <= graveyardX + graveyardWidth / 2 &&
            worldY >= graveyardY - graveyardHeight / 2 && worldY <= graveyardY + graveyardHeight / 2) {
          return name;
        }
      }
    }
    return null;
  }

  private getGraveyardAtPositionForInteraction(worldX: number, worldY: number): string | null {
    // Only allow interaction if the layer is visible and selected
    if (!this.isObjectLayerVisible('Graveyards') || this.selectedObject !== 'Graveyards') {
      return null;
    }
    return this.getGraveyardAtPosition(worldX, worldY);
  }

  private getWarpAtPosition(worldX: number, worldY: number): string | null {
    if (!window.mapData?.warps) return null;

    for (const [name, data] of Object.entries(window.mapData.warps)) {
      if (data && typeof data === 'object') {
        const wData = data as any;
        const warpX = wData.position?.x || wData.x || 0;
        const warpY = wData.position?.y || wData.y || 0;
        const warpWidth = wData.size?.width || 32;
        const warpHeight = wData.size?.height || 32;

        if (worldX >= warpX && worldX <= warpX + warpWidth &&
            worldY >= warpY && worldY <= warpY + warpHeight) {
          return name;
        }
      }
    }
    return null;
  }

  private getWarpAtPositionForInteraction(worldX: number, worldY: number): string | null {
    // Only allow interaction if the layer is visible and selected
    if (!this.isObjectLayerVisible('Warps') || this.selectedObject !== 'Warps') {
      return null;
    }
    return this.getWarpAtPosition(worldX, worldY);
  }

  private getWarpCornerAtPosition(worldX: number, worldY: number): { name: string, corner: string } | null {
    if (!window.mapData?.warps || this.selectedObjectName === null) return null;

    const data = (window.mapData.warps as any)[this.selectedObjectName];
    if (!data) return null;

    const warpX = data.position?.x || data.x || 0;
    const warpY = data.position?.y || data.y || 0;
    const warpWidth = data.size?.width || 32;
    const warpHeight = data.size?.height || 32;
    const hitRadius = 8;

    // Check corners
    const corners = [
      { x: warpX, y: warpY, name: 'top-left' },
      { x: warpX + warpWidth, y: warpY, name: 'top-right' },
      { x: warpX, y: warpY + warpHeight, name: 'bottom-left' },
      { x: warpX + warpWidth, y: warpY + warpHeight, name: 'bottom-right' }
    ];

    for (const corner of corners) {
      const distance = Math.sqrt(Math.pow(worldX - corner.x, 2) + Math.pow(worldY - corner.y, 2));
      if (distance <= hitRadius) {
        return { name: this.selectedObjectName, corner: corner.name };
      }
    }

    // Check edge midpoints
    const edges = [
      { x: warpX + warpWidth / 2, y: warpY, name: 'top' },
      { x: warpX + warpWidth / 2, y: warpY + warpHeight, name: 'bottom' },
      { x: warpX, y: warpY + warpHeight / 2, name: 'left' },
      { x: warpX + warpWidth, y: warpY + warpHeight / 2, name: 'right' }
    ];

    for (const edge of edges) {
      const distance = Math.sqrt(Math.pow(worldX - edge.x, 2) + Math.pow(worldY - edge.y, 2));
      if (distance <= hitRadius) {
        return { name: this.selectedObjectName, corner: edge.name };
      }
    }

    return null;
  }

  private onMapMouseUp() {
    this.isMouseDown = false;

    if (this.isMapDraggingSelection && this.mapDragStartTile) {
      this.isMapDraggingSelection = false;

      const startX = this.mapDragStartTile.x;
      const startY = this.mapDragStartTile.y;
      const endX = this.mapDragEndTile?.x ?? startX;
      const endY = this.mapDragEndTile?.y ?? startY;

      if (this.currentTool === 'erase') {
        if (startX === endX && startY === endY) {
          this.eraseTile(startX, startY);
        } else {
          this.eraseTilesInRegion(startX, startY, endX, endY);
        }
      } else {
        if (startX === endX && startY === endY) {
          this.copyTileFromWorld(startX, startY);
        } else {
          this.copyTilesFromWorld(startX, startY, endX, endY);
        }
      }

      canvas.style.cursor = 'default';
      return;
    }

    if (this.isPanningMap) {
      this.isPanningMap = false;
      canvas.style.cursor = 'default';
    }

    // Finalize warp resizing
    if (this.resizingWarp && window.mapData) {
      const warpData = (window.mapData.warps as any)[this.resizingWarp.name];
      if (warpData) {
        // Snap position to whole numbers
        if (warpData.position) {
          warpData.position.x = Math.round(warpData.position.x);
          warpData.position.y = Math.round(warpData.position.y);
        }
        // Custom x/y are destination coordinates (strings from properties panel) - convert to numbers before rounding
        if (warpData.x !== undefined && warpData.x !== '') {
          warpData.x = Math.round(Number(warpData.x));
        }
        if (warpData.y !== undefined && warpData.y !== '') {
          warpData.y = Math.round(Number(warpData.y));
        }

        // Snap size to whole numbers
        if (warpData.size) {
          warpData.size.width = Math.round(warpData.size.width);
          warpData.size.height = Math.round(warpData.size.height);
        }

        // Record mutation only if size or position changed
        const newX = warpData.position?.x || warpData.x || 0;
        const newY = warpData.position?.y || warpData.y || 0;
        const newWidth = warpData.size?.width || 32;
        const newHeight = warpData.size?.height || 32;

        const oldState = this.objectMutationStartState || { x: newX, y: newY, width: newWidth, height: newHeight };

        // Only create snapshot if something changed
        if (oldState.x !== newX || oldState.y !== newY || oldState.width !== newWidth || oldState.height !== newHeight) {
          const mutation: ObjectMutation = {
            type: 'warp',
            name: this.resizingWarp.name,
            oldState: {
              x: oldState.x,
              y: oldState.y,
              width: oldState.width,
              height: oldState.height
            },
            newState: { x: newX, y: newY, width: newWidth, height: newHeight }
          };
          this.undoStack.push(mutation);
          this.redoStack = [];

          // Mark Warps as unsaved
          this.unsavedLayers.add('Warps');
          this.updateLayerList();
        }
      }
      this.resizingWarp = null;
      this.objectMutationStartState = null;
    }

    if (this.draggingObject && window.mapData) {
      if (this.draggingObject.type === 'Warps') {
        const warpData = (window.mapData.warps as any)[this.draggingObject.name];
        if (warpData) {
          // Get current position
          const currentX = warpData.position?.x || warpData.x || 0;
          const currentY = warpData.position?.y || warpData.y || 0;

          // Snap to nearest whole number
          const snappedX = Math.round(currentX);
          const snappedY = Math.round(currentY);

          // Update position (trigger zone only, not destination coordinates)
          if (!warpData.position) {
            warpData.position = {};
          }
          warpData.position.x = snappedX;
          warpData.position.y = snappedY;
          // x and y are destination coordinates from properties - do NOT update them when moving the trigger zone

          // Record mutation only if position changed
          const warpWidth = warpData.size?.width || 32;
          const warpHeight = warpData.size?.height || 32;
          const oldState = this.objectMutationStartState || { x: snappedX, y: snappedY, width: warpWidth, height: warpHeight };

          if (oldState.x !== snappedX || oldState.y !== snappedY) {
            const mutation: ObjectMutation = {
              type: 'warp',
              name: this.draggingObject.name,
              oldState: {
                x: oldState.x,
                y: oldState.y,
                width: oldState.width,
                height: oldState.height
              },
              newState: { x: snappedX, y: snappedY, width: warpWidth, height: warpHeight }
            };
            this.undoStack.push(mutation);
            this.redoStack = [];

            // Mark Warps as unsaved
            this.unsavedLayers.add('Warps');
            this.updateLayerList();
          }
        }
      } else if (this.draggingObject.type === 'Graveyards') {
        const graveyardData = (window.mapData.graveyards as any)[this.draggingObject.name];
        if (graveyardData) {
          // Get current position
          const currentX = graveyardData.position?.x || graveyardData.x || 0;
          const currentY = graveyardData.position?.y || graveyardData.y || 0;

          // Snap to nearest whole number
          const snappedX = Math.round(currentX);
          const snappedY = Math.round(currentY);

          // Update position
          if (!graveyardData.position) {
            graveyardData.position = {};
          }
          graveyardData.position.x = snappedX;
          graveyardData.position.y = snappedY;
          graveyardData.x = snappedX;
          graveyardData.y = snappedY;

          // Record mutation only if position changed
          const oldState = this.objectMutationStartState || { x: snappedX, y: snappedY };

          if (oldState.x !== snappedX || oldState.y !== snappedY) {
            const mutation: ObjectMutation = {
              type: 'graveyard',
              name: this.draggingObject.name,
              oldState: {
                x: oldState.x,
                y: oldState.y
              },
              newState: { x: snappedX, y: snappedY }
            };
            this.undoStack.push(mutation);
            this.redoStack = [];

            // Mark Graveyards as unsaved
            this.unsavedLayers.add('Graveyards');
            this.updateLayerList();
          }
        }
      }

      this.draggingObject = null;
      this.objectMutationStartState = null;
    }

    // Reset cursor to default when done dragging/resizing
    canvas.style.cursor = 'default';
  }

  private toggleGrid() {
    const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
    if (gridCheckbox) {
      gridCheckbox.checked = !gridCheckbox.checked;
    }
  }

  private screenToWorld(screenX: number, screenY: number): { x: number, y: number } {

    const cameraX = (window as any).cameraX || 0;
    const cameraY = (window as any).cameraY || 0;

    // Account for map centering offset for small maps
    let mapCenterOffsetX = 0;
    const mapCenterOffsetY = 0;
    if (window.mapData) {
      const mapWidth = window.mapData.width * window.mapData.tilewidth;
      if (mapWidth < window.innerWidth) {
        mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
      }
    }

    return {
      x: screenX - (window.innerWidth / 2) + cameraX - mapCenterOffsetX,
      y: screenY - (window.innerHeight / 2) + cameraY - mapCenterOffsetY
    };
  }

  public rotateSelectedTile() {
    // Pure rotation flag combos: 0° = none, 90°CW = D+H, 180° = H+V, 270°CW = D+V
    const seq = [0x00000000, 0xA0000000, 0xC0000000, 0x60000000];

    const nextFlags = (flags: number): number => {
      const f = (flags >>> 0); // unsigned 32-bit, so comparisons match JS hex literals
      const result = f === 0x00000000 ? seq[1]
        : f === 0xA0000000 ? seq[2]
        : f === 0xC0000000 ? seq[3]
        : f === 0x60000000 ? seq[0]
        : (f & 0x20000000) ? seq[2]
        : f === 0x80000000 ? seq[1]
        : f === 0x40000000 ? seq[3]
        : f === 0xE0000000 ? seq[0]
        : seq[1];
      return result;
    };

    // Rotate multi-tile selection: rearrange grid 90° CW + advance each tile one step
    if (this.selectedTiles.length > 0 && (this.selectedTiles.length > 1 || this.selectedTiles[0].length > 1)) {
      const rows = this.selectedTiles.length;
      const cols = this.selectedTiles[0].length;
      const rotated: number[][] = [];
      for (let c = 0; c < cols; c++) {
        const newRow: number[] = [];
        for (let r = rows - 1; r >= 0; r--) {
          const tileId = this.selectedTiles[r][c];
          if (tileId === 0) {
            newRow.push(0);
          } else {
            newRow.push((tileId & 0x0FFFFFFF) | nextFlags(tileId & 0xE0000000));
          }
        }
        rotated.push(newRow);
      }
      this.selectedTiles = rotated;
      this.selectedTile = null;
      this.selectedTilesFromMap = true;
      this.sendToEditor({ type: 'tileSelectUpdate', tileId: this.selectedTile, selectedTiles: this.selectedTiles, selectedTilesFromMap: this.selectedTilesFromMap, tilesetIndex: this.currentTilesetIndex });
      return;
    }

    // Rotate single tile
    if (!this.selectedTile) return;
    const currentFlags = this.selectedTile & 0xE0000000;
    const newFlags = nextFlags(currentFlags);
    const baseGID = this.selectedTile & 0x0FFFFFFF;
    const newTile = baseGID | newFlags;
    this.selectedTile = newTile;

    if (this.selectedTiles.length === 1 && this.selectedTiles[0].length === 1) {
      this.selectedTiles[0][0] = newTile;
    }

    if (this.copiedTile !== null) {
      const copyBase = this.copiedTile & 0x0FFFFFFF;
      if (copyBase === baseGID) {
        this.copiedTile = newTile;
      }
    }

    this.sendToEditor({ type: 'tileSelectUpdate', tileId: this.selectedTile, selectedTiles: this.selectedTiles, selectedTilesFromMap: this.selectedTilesFromMap, tilesetIndex: this.currentTilesetIndex });
  }

  private placeTile(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    if (this.selectedTiles.length > 0) {
      this.placeMultipleTiles(tileX, tileY);
      return;
    }

    if (!this.selectedTile) return;

    const ensured = ensureChunkForTile(tileX, tileY);
    if (!ensured) return;
    const { chunk, chunkX, chunkY, localX: localTileX, localY: localTileY } = ensured;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === this.selectedTile) return;

    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: this.selectedTile
    });
    this.redoStack = [];

    // Mark layer as unsaved
    this.unsavedLayers.add(this.selectedLayer);
    this.updateLayerList();

    layer.data[tileIndex] = this.selectedTile;
    this.lastPlacedTilePos = { x: tileX, y: tileY };

    this.redrawCells(chunkX, chunkY, [{ x: localTileX, y: localTileY }]);
    this.sendTileEdits([{ chunkX, chunkY, layerName: this.selectedLayer as string, x: localTileX, y: localTileY, tileId: this.selectedTile as number }]);
  }

  private placeMultipleTiles(startTileX: number, startTileY: number) {
    if (!this.selectedLayer || !window.mapData || this.selectedTiles.length === 0) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const cellsByChunk = new Map<string, Array<{ x: number; y: number }>>();
    const changeGroup: TileChange[] = [];

    for (let row = 0; row < this.selectedTiles.length; row++) {
      for (let col = 0; col < this.selectedTiles[row].length; col++) {
        const tileId = this.selectedTiles[row][col];
        const worldTileX = startTileX + col;
        const worldTileY = startTileY + row;

        const ensured = ensureChunkForTile(worldTileX, worldTileY);
        if (!ensured) continue;
        const { chunk, chunkX, chunkY, localX: localTileX, localY: localTileY } = ensured;
        const chunkKey = `${chunkX}-${chunkY}`;

        const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
        if (!layer) continue;

        const tileIndex = localTileY * chunk.width + localTileX;
        const oldTileId = layer.data[tileIndex];

        if (oldTileId === tileId) continue;

        changeGroup.push({
          chunkX,
          chunkY,
          layerName: this.selectedLayer,
          tileX: localTileX,
          tileY: localTileY,
          oldTileId,
          newTileId: tileId
        });

        layer.data[tileIndex] = tileId;

        let cellArr = cellsByChunk.get(chunkKey);
        if (!cellArr) { cellArr = []; cellsByChunk.set(chunkKey, cellArr); }
        cellArr.push({ x: localTileX, y: localTileY });
      }
    }

    if (changeGroup.length > 0) {
      this.undoStack.push({ changes: changeGroup });
      this.redoStack = [];

      // Mark layer as unsaved
      this.unsavedLayers.add(this.selectedLayer);
      this.updateLayerList();
    }

    cellsByChunk.forEach((cells, chunkKey) => {
      const [chunkX, chunkY] = parseChunkKey(chunkKey);
      this.redrawCells(chunkX, chunkY, cells);
    });

    this.sendTileEdits(changeGroup.map(ch => ({ chunkX: ch.chunkX, chunkY: ch.chunkY, layerName: ch.layerName, x: ch.tileX, y: ch.tileY, tileId: ch.newTileId })));
    this.lastPlacedTilePos = { x: startTileX, y: startTileY };
  }

  private eraseTile(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === 0) return;

    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: 0
    });
    this.redoStack = [];

    // Mark layer as unsaved
    this.unsavedLayers.add(this.selectedLayer);
    this.updateLayerList();

    layer.data[tileIndex] = 0;
    this.lastPlacedTilePos = { x: tileX, y: tileY };

    this.redrawCells(chunkX, chunkY, [{ x: localTileX, y: localTileY }]);
    this.sendTileEdits([{ chunkX, chunkY, layerName: this.selectedLayer as string, x: localTileX, y: localTileY, tileId: 0 }]);
  }

  private eraseTilesInRegion(startX: number, startY: number, endX: number, endY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    const changes: TileChange[] = [];
    const cellsByChunk: Map<string, { x: number, y: number }[]> = new Map();

    const chunkSize = window.mapData.chunkSize;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cx = Math.floor(x / chunkSize);
        const cy = Math.floor(y / chunkSize);
        const lx = x % chunkSize;
        const ly = y % chunkSize;

        const chunkKey = `${cx}-${cy}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (!chunk) continue;

        const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
        if (!layer) continue;

        const tileIndex = ly * chunk.width + lx;
        const oldTileId = layer.data[tileIndex];
        if (oldTileId === 0) continue;

        changes.push({
          chunkX: cx,
          chunkY: cy,
          layerName: this.selectedLayer,
          tileX: lx,
          tileY: ly,
          oldTileId,
          newTileId: 0
        });

        if (!cellsByChunk.has(chunkKey)) {
          cellsByChunk.set(chunkKey, []);
        }
        cellsByChunk.get(chunkKey)!.push({ x: lx, y: ly });

        layer.data[tileIndex] = 0;
      }
    }

    if (changes.length === 0) return;

    this.undoStack.push({ changes });
    this.redoStack = [];

    this.unsavedLayers.add(this.selectedLayer);
    this.updateLayerList();

    for (const [key, cells] of cellsByChunk) {
      const [cxStr, cyStr] = key.split('-');
      const cx = parseInt(cxStr);
      const cy = parseInt(cyStr);
      this.redrawCells(cx, cy, cells);
    }

    this.sendTileEdits(changes.map(ch => ({
      chunkX: ch.chunkX,
      chunkY: ch.chunkY,
      layerName: ch.layerName,
      x: ch.tileX,
      y: ch.tileY,
      tileId: 0
    })));
  }

  private copyTileFromWorld(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const tileId = layer.data[tileIndex];

    // Only copy if tile is not empty (tileId > 0)
    if (tileId > 0) {
      this.copiedTile = tileId;
      this.selectedTile = tileId;
      this.selectedTiles = [];
      this.selectedTilesFromMap = false;

      const baseGID = tileId & 0x0FFFFFFF;
      const tilesetIndex = window.mapData.tilesets.findIndex((t: any) =>
        t.firstgid <= baseGID && baseGID < t.firstgid + t.tilecount
      );

      if (tilesetIndex !== -1 && tilesetIndex !== this.currentTilesetIndex) {
        this.selectTileset(tilesetIndex);
      }

      this.setTool('paste');
      this.sendToEditor({ type: 'tileSelectUpdate', tileId: this.selectedTile, selectedTiles: this.selectedTiles, selectedTilesFromMap: this.selectedTilesFromMap, tilesetIndex: this.currentTilesetIndex });
      // Clear preview position to avoid rendering artifacts
      this.previewTilePos = null;
    }
  }

  private copyTilesFromWorld(startX: number, startY: number, endX: number, endY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    const tiles: number[][] = [];
    for (let y = minY; y <= maxY; y++) {
      const row: number[] = [];
      for (let x = minX; x <= maxX; x++) {
        const chunkSize = window.mapData.chunkSize;
        const chunkX = Math.floor(x / chunkSize);
        const chunkY = Math.floor(y / chunkSize);
        const localX = x % chunkSize;
        const localY = y % chunkSize;

        const chunkKey = `${chunkX}-${chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);

        if (!chunk) {
          row.push(0);
          continue;
        }

        const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
        if (!layer) {
          row.push(0);
          continue;
        }

        const tileIndex = localY * chunk.width + localX;
        row.push(layer.data[tileIndex] || 0);
      }
      tiles.push(row);
    }

    if (tiles.length === 1 && tiles[0].length === 1) {
      this.selectedTile = tiles[0][0];
      this.selectedTiles = [];
      this.selectedTilesFromMap = false;
      if (tiles[0][0] > 0) {
        this.copiedTile = tiles[0][0];

        const baseGID = tiles[0][0] & 0x0FFFFFFF;
        const tilesetIndex = window.mapData.tilesets.findIndex((t: any) =>
          t.firstgid <= baseGID && baseGID < t.firstgid + t.tilecount
        );

        if (tilesetIndex !== -1 && tilesetIndex !== this.currentTilesetIndex) {
          this.selectTileset(tilesetIndex);
        }

        this.setTool('paste');
      }
    } else {
      this.selectedTile = null;
      this.selectedTiles = tiles;
      this.selectedTilesFromMap = true;
      this.copiedTile = null;
      this.setTool('paint');
      this.sendToEditor({ type: 'tileSelectUpdate', tileId: this.selectedTile, selectedTiles: this.selectedTiles, selectedTilesFromMap: this.selectedTilesFromMap, tilesetIndex: this.currentTilesetIndex });
    }
  }

  private pasteTile(tileX: number, tileY: number) {

    if (this.copiedTile === null || !this.selectedLayer || !window.mapData) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const ensured = ensureChunkForTile(tileX, tileY);
    if (!ensured) return;
    const { chunk, chunkX, chunkY, localX: localTileX, localY: localTileY } = ensured;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === this.copiedTile) return;

    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: this.copiedTile
    });
    this.redoStack = [];

    layer.data[tileIndex] = this.copiedTile;
    this.lastPlacedTilePos = { x: tileX, y: tileY };

    this.redrawCells(chunkX, chunkY, [{ x: localTileX, y: localTileY }]);
    this.sendTileEdits([{ chunkX, chunkY, layerName: this.selectedLayer as string, x: localTileX, y: localTileY, tileId: this.copiedTile as number }]);
  }

  // Incrementally redraw only the given local cells of a chunk's canvases. Falls
  // back to a full (async) re-bake if the chunk's canvases aren't ready yet.
  private redrawCells(chunkX: number, chunkY: number, cells: Array<{ x: number; y: number }>) {
    if (!window.mapData || cells.length === 0) return;
    const chunkKey = `${chunkX}-${chunkY}`;
    this.modifiedChunkKeys.add(chunkKey);
    const chunk = window.mapData.loadedChunks.get(chunkKey);
    if (!chunk) return;
    if (!chunk.lowerCanvas || !chunk.upperCanvas) {
      this.rerenderChunk(chunkX, chunkY);
      return;
    }
    redrawChunkCells(chunk, cells);
  }

  private getLineTiles(x0: number, y0: number, x1: number, y1: number): { x: number, y: number }[] {
    const tiles: { x: number, y: number }[] = [];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;

    while (true) {
      tiles.push({ x, y });
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
    return tiles;
  }

  private placeLineTiles(fromX: number, fromY: number, toX: number, toY: number) {
    if (!this.selectedLayer || !window.mapData || !this.selectedTile) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const lineTiles = this.getLineTiles(fromX, fromY, toX, toY);
    const changes: TileChange[] = [];
    const cellsByChunk: Map<string, { x: number, y: number }[]> = new Map();

    for (const pos of lineTiles) {
      const ensured = ensureChunkForTile(pos.x, pos.y);
      if (!ensured) continue;
      const { chunk, chunkX, chunkY, localX, localY } = ensured;

      const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
      if (!layer) continue;

      const tileIndex = localY * chunk.width + localX;
      const oldTileId = layer.data[tileIndex];

      if (oldTileId === this.selectedTile) continue;

      changes.push({
        chunkX,
        chunkY,
        layerName: this.selectedLayer,
        tileX: localX,
        tileY: localY,
        oldTileId,
        newTileId: this.selectedTile
      });

      const chunkKey = `${chunkX}-${chunkY}`;
      if (!cellsByChunk.has(chunkKey)) {
        cellsByChunk.set(chunkKey, []);
      }
      cellsByChunk.get(chunkKey)!.push({ x: localX, y: localY });

      layer.data[tileIndex] = this.selectedTile;
    }

    if (changes.length === 0) return;

    this.undoStack.push({ changes });
    this.redoStack = [];

    this.unsavedLayers.add(this.selectedLayer);
    this.updateLayerList();

    for (const [key, cells] of cellsByChunk) {
      const [cxStr, cyStr] = key.split('-');
      const cx = parseInt(cxStr);
      const cy = parseInt(cyStr);
      this.redrawCells(cx, cy, cells);
    }

    this.sendTileEdits(changes.map(ch => ({
      chunkX: ch.chunkX,
      chunkY: ch.chunkY,
      layerName: ch.layerName,
      x: ch.tileX,
      y: ch.tileY,
      tileId: ch.newTileId
    })));
  }

  private pasteLineTiles(fromX: number, fromY: number, toX: number, toY: number) {
    if (!this.selectedLayer || !window.mapData || this.copiedTile === null) return;

    if (this.isLayerLocked(this.selectedLayer)) return;

    const lineTiles = this.getLineTiles(fromX, fromY, toX, toY);
    const changes: TileChange[] = [];
    const cellsByChunk: Map<string, { x: number, y: number }[]> = new Map();

    for (const pos of lineTiles) {
      const ensured = ensureChunkForTile(pos.x, pos.y);
      if (!ensured) continue;
      const { chunk, chunkX, chunkY, localX, localY } = ensured;

      const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
      if (!layer) continue;

      const tileIndex = localY * chunk.width + localX;
      const oldTileId = layer.data[tileIndex];

      if (oldTileId === this.copiedTile) continue;

      changes.push({
        chunkX,
        chunkY,
        layerName: this.selectedLayer,
        tileX: localX,
        tileY: localY,
        oldTileId,
        newTileId: this.copiedTile!
      });

      const chunkKey = `${chunkX}-${chunkY}`;
      if (!cellsByChunk.has(chunkKey)) {
        cellsByChunk.set(chunkKey, []);
      }
      cellsByChunk.get(chunkKey)!.push({ x: localX, y: localY });

      layer.data[tileIndex] = this.copiedTile!;
    }

    if (changes.length === 0) return;

    this.undoStack.push({ changes });
    this.redoStack = [];

    this.unsavedLayers.add(this.selectedLayer);
    this.updateLayerList();

    for (const [key, cells] of cellsByChunk) {
      const [cxStr, cyStr] = key.split('-');
      const cx = parseInt(cxStr);
      const cy = parseInt(cyStr);
      this.redrawCells(cx, cy, cells);
    }

    this.sendTileEdits(changes.map(ch => ({
      chunkX: ch.chunkX,
      chunkY: ch.chunkY,
      layerName: ch.layerName,
      x: ch.tileX,
      y: ch.tileY,
      tileId: ch.newTileId
    })));
  }

  // Broadcast tile edits to other admins editing the same map so concurrent edits
  // stay in sync (best-effort relay; persistence still happens on Save).
  private sendTileEdits(edits: Array<{ chunkX: number; chunkY: number; layerName: string; x: number; y: number; tileId: number }>) {
    if (!this.isActive || !window.mapData || edits.length === 0) return;
    sendRequest({ type: 'EDITOR_TILE_EDIT', data: { mapName: window.mapData.name, edits } });
  }

  // Apply tile edits received live from another editor. Remote edits are not pushed
  // onto the local undo stack and are not re-broadcast.
  public applyRemoteEdits(data: { mapName: string; edits: Array<{ chunkX: number; chunkY: number; layerName: string; x: number; y: number; tileId: number }> }) {
    if (!this.isActive || !window.mapData || !data || data.mapName !== window.mapData.name || !Array.isArray(data.edits)) return;

    const cellsByChunk = new Map<string, Array<{ x: number; y: number }>>();
    const chunkSize = window.mapData.chunkSize;
    for (const edit of data.edits) {
      const chunkKey = `${edit.chunkX}-${edit.chunkY}`;
      // Grow bounds / create the chunk if a remote editor painted into the zone.
      const ensured = ensureChunkForTile(edit.chunkX * chunkSize + edit.x, edit.chunkY * chunkSize + edit.y);
      if (!ensured) continue;
      const chunk = ensured.chunk;
      const layer = chunk.layers.find((l: any) => l.name === edit.layerName);
      if (!layer) continue;
      const idx = edit.y * chunk.width + edit.x;
      if (idx < 0 || idx >= layer.data.length) continue;
      layer.data[idx] = edit.tileId;
      let arr = cellsByChunk.get(chunkKey);
      if (!arr) { arr = []; cellsByChunk.set(chunkKey, arr); }
      arr.push({ x: edit.x, y: edit.y });
    }

    cellsByChunk.forEach((cells, chunkKey) => {
      const [cx, cy] = parseChunkKey(chunkKey);
      this.redrawCells(cx, cy, cells);
    });
  }

  private sendLayerLockChange(layerName: string, locked: boolean) {
    if (!this.isActive || !window.mapData) return;
    sendRequest({ type: 'EDITOR_LAYER_LOCK', data: { mapName: window.mapData.name, layerName, locked } });
  }

  public applyRemoteLayerLock(data: { mapName: string; layerName: string; locked: boolean }) {
    if (!window.mapData || !data || data.mapName !== window.mapData.name) return;

    this.layerLocked.set(data.layerName, data.locked);
    this.propagateLayerLockToChunks(data.layerName, data.locked);

    this.sendToEditor({ type: 'layerLockUpdate', layerName: data.layerName, locked: data.locked });
  }

  private propagateLayerLockToChunks(layerName: string, locked: boolean) {
    if (!window.mapData) return;

    for (const chunk of window.mapData.loadedChunks.values()) {
      const layer = chunk.layers.find((l: any) => l.name === layerName);
      if (layer) {
        layer.locked = locked;
      }
    }
  }

  private async rerenderChunk(chunkX: number, chunkY: number) {
    if (!window.mapData) return;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);
    if (!chunk) return;

    const { lowerCanvas, upperCanvas } = await renderChunkToCanvas(chunk);
    chunk.lowerCanvas = lowerCanvas;
    chunk.upperCanvas = upperCanvas;
    chunk.canvas = lowerCanvas;

  }

  private clearAllEdits() {
    while (this.undoStack.length > 0) {
      this.undo();
    }
  }

  private undo() {
    const item = this.undoStack.pop();
    if (!item) return;

    // Handle ObjectMutation
    if ('type' in item && (item.type === 'graveyard' || item.type === 'warp')) {
      const mutation = item as ObjectMutation;
      const mutationAny = mutation as any;
      const isRename = mutationAny.newName !== undefined;

      // Check if this is a deletion (newState is null) or creation (oldState is null)
      const isDeletion = mutation.newState === null && mutation.oldState !== null;
      const isCreation = mutation.oldState === null && mutation.newState !== null;

      if (mutation.type === 'graveyard' && window.mapData?.graveyards) {
        if (isRename) {
          // Undo rename: change from newName back to mutation.name
          const newName = mutationAny.newName;
          const graveyardData = (window.mapData.graveyards as any)[newName];
          if (graveyardData) {
            (window.mapData.graveyards as any)[mutation.name] = graveyardData;
            delete (window.mapData.graveyards as any)[newName];
            this.selectedObjectName = mutation.name;
          }
        } else if (isDeletion && mutation.oldState) {
          // Restore deleted graveyard
          (window.mapData.graveyards as any)[mutation.name] = {
            position: { x: mutation.oldState.x, y: mutation.oldState.y },
            x: mutation.oldState.x,
            y: mutation.oldState.y,
            map: 'main'
          };
          // Clear label coords so they get recalculated on next render
          this.labelCoords.delete(mutation.name);
          // Auto-select the restored graveyard
          this.selectedObject = 'Graveyards';
          this.selectedObjectName = mutation.name;
          this.deleteButtonCoords = null;
        } else if (isCreation) {
          // Delete created graveyard
          delete (window.mapData.graveyards as any)[mutation.name];
          this.labelCoords.delete(mutation.name);
          this.selectedObjectName = null;
          this.deleteButtonCoords = null;
        } else {
          // Position/size change
          const graveyardData = (window.mapData.graveyards as any)[mutation.name];
          if (graveyardData && mutation.oldState) {
            if (mutation.oldState.x !== undefined) {
              if (!graveyardData.position) graveyardData.position = {};
              graveyardData.position.x = mutation.oldState.x;
              graveyardData.x = mutation.oldState.x;
            }
            if (mutation.oldState.y !== undefined) {
              if (!graveyardData.position) graveyardData.position = {};
              graveyardData.position.y = mutation.oldState.y;
              graveyardData.y = mutation.oldState.y;
            }
          }
        }
      } else if (mutation.type === 'warp' && window.mapData?.warps) {
        if (isRename) {
          // Undo rename: change from newName back to mutation.name
          const newName = mutationAny.newName;
          const warpData = (window.mapData.warps as any)[newName];
          if (warpData) {
            (window.mapData.warps as any)[mutation.name] = warpData;
            delete (window.mapData.warps as any)[newName];
            this.selectedObjectName = mutation.name;
          }
        } else if (isDeletion) {
          // Restore deleted warp
          if (mutation.oldState) {
            (window.mapData.warps as any)[mutation.name] = {
              position: { x: mutation.oldState.x, y: mutation.oldState.y },
              x: mutation.oldState.x,
              y: mutation.oldState.y,
              size: { width: mutation.oldState.width, height: mutation.oldState.height },
              map: 'main'
            };
          }
          // Clear label coords so they get recalculated on next render
          this.labelCoords.delete(mutation.name);
          // Auto-select the restored warp
          this.selectedObject = 'Warps';
          this.selectedObjectName = mutation.name;
          this.deleteButtonCoords = null;
        } else if (isCreation) {
          // Delete created warp
          delete (window.mapData.warps as any)[mutation.name];
          this.labelCoords.delete(mutation.name);
          this.selectedObjectName = null;
          this.deleteButtonCoords = null;
        } else {
          // Position/size change
          const warpData = (window.mapData.warps as any)[mutation.name];
          if (warpData && mutation.oldState) {
            if (mutation.oldState.x !== undefined) {
              if (!warpData.position) warpData.position = {};
              warpData.position.x = mutation.oldState.x;
            }
            if (mutation.oldState.y !== undefined) {
              if (!warpData.position) warpData.position = {};
              warpData.position.y = mutation.oldState.y;
            }
            if (mutation.oldState.width !== undefined) {
              if (!warpData.size) warpData.size = {};
              warpData.size.width = mutation.oldState.width;
            }
            if (mutation.oldState.height !== undefined) {
              if (!warpData.size) warpData.size = {};
              warpData.size.height = mutation.oldState.height;
            }
          }
        }
      }
      this.redoStack.push(mutation);
      return;
    }

    // Handle TileChange
    const cellsByChunk = new Map<string, Array<{ x: number; y: number }>>();
    const broadcastEdits: Array<{ chunkX: number; chunkY: number; layerName: string; x: number; y: number; tileId: number }> = [];

    const recordCell = (chunkKey: string, change: TileChange, tileId: number) => {
      let arr = cellsByChunk.get(chunkKey);
      if (!arr) { arr = []; cellsByChunk.set(chunkKey, arr); }
      arr.push({ x: change.tileX, y: change.tileY });
      broadcastEdits.push({ chunkX: change.chunkX, chunkY: change.chunkY, layerName: change.layerName, x: change.tileX, y: change.tileY, tileId });
    };

    if ('changes' in item) {

      const group = item as TileChangeGroup;
      group.changes.forEach(change => {
        const chunkKey = `${change.chunkX}-${change.chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (!chunk) return;

        const layer = chunk.layers.find((l: any) => l.name === change.layerName);
        if (!layer) return;

        const tileIndex = change.tileY * chunk.width + change.tileX;
        layer.data[tileIndex] = change.oldTileId;

        recordCell(chunkKey, change, change.oldTileId);
        // Mark layer as unsaved when undoing
        this.unsavedLayers.add(change.layerName);
      });
      this.redoStack.push(group);
    } else {

      const change = item as TileChange;
      const chunkKey = `${change.chunkX}-${change.chunkY}`;
      const chunk = window.mapData.loadedChunks.get(chunkKey);
      if (!chunk) return;

      const layer = chunk.layers.find((l: any) => l.name === change.layerName);
      if (!layer) return;

      const tileIndex = change.tileY * chunk.width + change.tileX;
      layer.data[tileIndex] = change.oldTileId;

      recordCell(chunkKey, change, change.oldTileId);
      // Mark layer as unsaved when undoing
      this.unsavedLayers.add(change.layerName);
      this.redoStack.push(change);
    }

    const lastUndoChange = 'changes' in item ? (item.changes[(item.changes as TileChange[]).length - 1]) : (item as TileChange);
    if (lastUndoChange) {
      const chunkSize = window.mapData.chunkSize;
      this.lastPlacedTilePos = {
        x: lastUndoChange.chunkX * chunkSize + lastUndoChange.tileX,
        y: lastUndoChange.chunkY * chunkSize + lastUndoChange.tileY
      };
    }

    cellsByChunk.forEach((cells, chunkKey) => {
      const [chunkX, chunkY] = parseChunkKey(chunkKey);
      this.redrawCells(chunkX, chunkY, cells);
    });

    this.sendTileEdits(broadcastEdits);
    this.updateLayerList();
  }

  private redo() {
    const item = this.redoStack.pop();
    if (!item) return;

    // Handle ObjectMutation
    if ('type' in item && (item.type === 'graveyard' || item.type === 'warp')) {
      const mutation = item as ObjectMutation;
      const mutationAny = mutation as any;
      const isRename = mutationAny.newName !== undefined;

      // Check if this is a deletion (newState is null) or creation (oldState is null)
      const isDeletion = mutation.newState === null && mutation.oldState !== null;
      const isCreation = mutation.oldState === null && mutation.newState !== null;

      if (mutation.type === 'graveyard' && window.mapData?.graveyards) {
        if (isRename) {
          // Redo rename: change from mutation.name to newName
          const newName = mutationAny.newName;
          const graveyardData = (window.mapData.graveyards as any)[mutation.name];
          if (graveyardData) {
            (window.mapData.graveyards as any)[newName] = graveyardData;
            delete (window.mapData.graveyards as any)[mutation.name];
            this.selectedObjectName = newName;
          }
        } else if (isDeletion) {
          // Delete graveyard again
          delete (window.mapData.graveyards as any)[mutation.name];
          this.labelCoords.delete(mutation.name);
          this.selectedObjectName = null;
          this.deleteButtonCoords = null;
        } else if (isCreation && mutation.newState) {
          // Restore created graveyard
          (window.mapData.graveyards as any)[mutation.name] = {
            position: { x: mutation.newState.x, y: mutation.newState.y },
            x: mutation.newState.x,
            y: mutation.newState.y,
            map: 'main'
          };
          // Clear label coords so they get recalculated on next render
          this.labelCoords.delete(mutation.name);
          // Auto-select the restored graveyard
          this.selectedObject = 'Graveyards';
          this.selectedObjectName = mutation.name;
          this.deleteButtonCoords = null;
        } else {
          // Position/size change
          const graveyardData = (window.mapData.graveyards as any)[mutation.name];
          if (graveyardData && mutation.newState) {
            if (mutation.newState.x !== undefined) {
              if (!graveyardData.position) graveyardData.position = {};
              graveyardData.position.x = mutation.newState.x;
              graveyardData.x = mutation.newState.x;
            }
            if (mutation.newState.y !== undefined) {
              if (!graveyardData.position) graveyardData.position = {};
              graveyardData.position.y = mutation.newState.y;
              graveyardData.y = mutation.newState.y;
            }
          }
        }
      } else if (mutation.type === 'warp' && window.mapData?.warps) {
        if (isRename) {
          // Redo rename: change from mutation.name to newName
          const newName = mutationAny.newName;
          const warpData = (window.mapData.warps as any)[mutation.name];
          if (warpData) {
            (window.mapData.warps as any)[newName] = warpData;
            delete (window.mapData.warps as any)[mutation.name];
            this.selectedObjectName = newName;
          }
        } else if (isDeletion) {
          // Delete warp again
          delete (window.mapData.warps as any)[mutation.name];
          this.labelCoords.delete(mutation.name);
          this.selectedObjectName = null;
          this.deleteButtonCoords = null;
        } else if (isCreation && mutation.newState) {
          // Restore created warp
          (window.mapData.warps as any)[mutation.name] = {
            position: { x: mutation.newState.x, y: mutation.newState.y },
            x: mutation.newState.x,
            y: mutation.newState.y,
            size: { width: mutation.newState.width, height: mutation.newState.height },
            map: 'main'
          };
          // Clear label coords so they get recalculated on next render
          this.labelCoords.delete(mutation.name);
          // Auto-select the restored warp
          this.selectedObject = 'Warps';
          this.selectedObjectName = mutation.name;
          this.deleteButtonCoords = null;
        } else {
          // Position/size change
          const warpData = (window.mapData.warps as any)[mutation.name];
          if (warpData && mutation.newState) {
            if (mutation.newState.x !== undefined) {
              if (!warpData.position) warpData.position = {};
              warpData.position.x = mutation.newState.x;
              warpData.x = mutation.newState.x;
            }
            if (mutation.newState.y !== undefined) {
              if (!warpData.position) warpData.position = {};
              warpData.position.y = mutation.newState.y;
              warpData.y = mutation.newState.y;
            }
            if (mutation.newState.width !== undefined) {
              if (!warpData.size) warpData.size = {};
              warpData.size.width = mutation.newState.width;
            }
            if (mutation.newState.height !== undefined) {
              if (!warpData.size) warpData.size = {};
              warpData.size.height = mutation.newState.height;
            }
          }
        }
      }
      this.undoStack.push(mutation);
      return;
    }

    // Handle TileChange
    const cellsByChunk = new Map<string, Array<{ x: number; y: number }>>();
    const broadcastEdits: Array<{ chunkX: number; chunkY: number; layerName: string; x: number; y: number; tileId: number }> = [];

    const recordCell = (chunkKey: string, change: TileChange, tileId: number) => {
      let arr = cellsByChunk.get(chunkKey);
      if (!arr) { arr = []; cellsByChunk.set(chunkKey, arr); }
      arr.push({ x: change.tileX, y: change.tileY });
      broadcastEdits.push({ chunkX: change.chunkX, chunkY: change.chunkY, layerName: change.layerName, x: change.tileX, y: change.tileY, tileId });
    };

    if ('changes' in item) {

      const group = item as TileChangeGroup;
      group.changes.forEach(change => {
        const chunkKey = `${change.chunkX}-${change.chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (!chunk) return;

        const layer = chunk.layers.find((l: any) => l.name === change.layerName);
        if (!layer) return;

        const tileIndex = change.tileY * chunk.width + change.tileX;
        layer.data[tileIndex] = change.newTileId;

        recordCell(chunkKey, change, change.newTileId);
        // Mark layer as unsaved when redoing
        this.unsavedLayers.add(change.layerName);
      });
      this.undoStack.push(group);
    } else {

      const change = item as TileChange;
      const chunkKey = `${change.chunkX}-${change.chunkY}`;
      const chunk = window.mapData.loadedChunks.get(chunkKey);
      if (!chunk) return;

      const layer = chunk.layers.find((l: any) => l.name === change.layerName);
      if (!layer) return;

      const tileIndex = change.tileY * chunk.width + change.tileX;
      layer.data[tileIndex] = change.newTileId;

      recordCell(chunkKey, change, change.newTileId);
      // Mark layer as unsaved when redoing
      this.unsavedLayers.add(change.layerName);
      this.undoStack.push(change);
    }

    const lastRedoChange = 'changes' in item ? (item.changes[(item.changes as TileChange[]).length - 1]) : (item as TileChange);
    if (lastRedoChange) {
      const chunkSize = window.mapData.chunkSize;
      this.lastPlacedTilePos = {
        x: lastRedoChange.chunkX * chunkSize + lastRedoChange.tileX,
        y: lastRedoChange.chunkY * chunkSize + lastRedoChange.tileY
      };
    }

    cellsByChunk.forEach((cells, chunkKey) => {
      const [chunkX, chunkY] = parseChunkKey(chunkKey);
      this.redrawCells(chunkX, chunkY, cells);
    });

    this.sendTileEdits(broadcastEdits);
    this.updateLayerList();
  }

  private propertyUndo() {
    const operation = this.propertyUndoStack.pop();
    if (!operation || !this.currentPropertyObject || !this.currentPropertyObjectType || !this.currentPropertyObjectName) return;

    const objectMap = this.currentPropertyObjectType === 'Graveyards'
      ? window.mapData?.graveyards
      : window.mapData?.warps;
    if (!objectMap) return;

    const obj = (objectMap as any)[this.currentPropertyObjectName];
    if (!obj) return;

    this.propertyRedoStack.push(operation);

    switch (operation.type) {
      case 'edit':
        // Restore old value
        obj[operation.key] = operation.oldValue;
        break;
      case 'delete':
        // Restore deleted property
        obj[operation.key] = operation.value;
        break;
      case 'create':
        // Remove created property
        delete obj[operation.key];
        break;
    }

    // Mark object layer as unsaved
    if (this.currentPropertyObjectType) {
      this.unsavedLayers.add(this.currentPropertyObjectType);
      this.updateLayerList();
    }

    // Re-render the properties panel if it's open
    if (this.propertiesPanel && this.propertiesPanel.parentNode) {
      this.refreshPropertiesPanel();
    }
  }

  private propertyRedo() {
    const operation = this.propertyRedoStack.pop();
    if (!operation || !this.currentPropertyObject || !this.currentPropertyObjectType || !this.currentPropertyObjectName) return;

    const objectMap = this.currentPropertyObjectType === 'Graveyards'
      ? window.mapData?.graveyards
      : window.mapData?.warps;
    if (!objectMap) return;

    const obj = (objectMap as any)[this.currentPropertyObjectName];
    if (!obj) return;

    this.propertyUndoStack.push(operation);

    switch (operation.type) {
      case 'edit':
        // Apply new value
        obj[operation.key] = operation.newValue;
        break;
      case 'delete':
        // Delete property again
        delete obj[operation.key];
        break;
      case 'create':
        // Restore created property
        obj[operation.key] = operation.value;
        break;
    }

    // Mark object layer as unsaved
    if (this.currentPropertyObjectType) {
      this.unsavedLayers.add(this.currentPropertyObjectType);
      this.updateLayerList();
    }

    // Re-render the properties panel if it's open
    if (this.propertiesPanel && this.propertiesPanel.parentNode) {
      this.refreshPropertiesPanel();
    }
  }

  private refreshPropertiesPanel() {
    if (!this.propertiesPanel || !this.currentPropertyObjectName) return;

    // Find and clear the content area
    const content = this.propertiesPanel.querySelector('.te-panel-content');
    if (!content) return;

    // Clear existing property list
    const existingPropertyList = content.querySelector('div');
    if (existingPropertyList) {
      existingPropertyList.remove();
    }

    const objectData = this.currentPropertyObject;
    const excludedKeys = new Set(['layer', 'position', 'size', 'name', 'Name']);
    // Graveyards don't have custom x and y properties
    if (this.currentPropertyObjectType === 'Graveyards') {
      excludedKeys.add('x');
      excludedKeys.add('y');
    }

    // Recreate property list
    const propertyList = document.createElement("div");
    propertyList.className = "ui";
    propertyList.style.display = 'flex';
    propertyList.style.flexDirection = 'column';
    propertyList.style.gap = '10px';

    // Render properties
    for (const [key, value] of Object.entries(objectData)) {
      if (!excludedKeys.has(key)) {
        const propertyDiv = document.createElement("div");
        propertyDiv.className = "ui";
        propertyDiv.style.borderBottom = '1px solid rgba(46, 204, 113, 0.2)';
        propertyDiv.style.paddingBottom = '10px';

        const label = document.createElement("div");
        label.className = "ui";
        label.style.color = 'rgba(46, 204, 113, 0.8)';
        label.style.fontSize = '0.9em';
        label.style.fontWeight = 'bold';
        label.innerText = key;
        propertyDiv.appendChild(label);

        const inputContainer = document.createElement("div");
        inputContainer.className = "ui";
        inputContainer.style.display = 'flex';
        inputContainer.style.gap = '8px';
        inputContainer.style.marginTop = '5px';
        inputContainer.style.alignItems = 'center';

        const valueInput = document.createElement("input");
        valueInput.className = "ui";
        valueInput.type = 'text';
        valueInput.value = String(value);
        valueInput.style.flex = '1';
        valueInput.style.padding = '5px';
        valueInput.style.background = 'rgba(0, 0, 0, 0.3)';
        valueInput.style.color = 'rgba(255, 255, 255, 0.9)';
        valueInput.style.border = '1px solid rgba(46, 204, 113, 0.3)';
        valueInput.style.borderRadius = '3px';
        valueInput.style.boxSizing = 'border-box';

        valueInput.addEventListener('change', () => {
          const oldValue = objectData[key];
          const newValue = valueInput.value;
          if (oldValue !== newValue) {
            objectData[key] = newValue;
            // Record property edit in undo stack
            this.propertyUndoStack.push({
              type: 'edit',
              key: key,
              oldValue: oldValue,
              newValue: newValue
            });
            this.propertyRedoStack = [];

            // Mark object layer as unsaved
            if (this.currentPropertyObjectType) {
              this.unsavedLayers.add(this.currentPropertyObjectType);
              this.updateLayerList();
            }
          }
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "ui";
        deleteBtn.innerText = 'âˆ’';
        deleteBtn.style.background = 'rgba(255, 100, 100, 0.3)';
        deleteBtn.style.color = 'rgba(255, 100, 100, 0.8)';
        deleteBtn.style.border = '1px solid rgba(255, 100, 100, 0.5)';
        deleteBtn.style.borderRadius = '3px';
        deleteBtn.style.padding = '5px 12px';
        deleteBtn.style.cursor = 'pointer';
        deleteBtn.style.flexShrink = '0';
        deleteBtn.onclick = () => {
          const deletedValue = objectData[key];
          delete objectData[key];
          // Record property deletion in undo stack
          this.propertyUndoStack.push({
            type: 'delete',
            key: key,
            value: deletedValue
          });
          this.propertyRedoStack = [];

          // Mark object layer as unsaved
          if (this.currentPropertyObjectType) {
            this.unsavedLayers.add(this.currentPropertyObjectType);
            this.updateLayerList();
          }

          this.refreshPropertiesPanel();
        };

        inputContainer.appendChild(valueInput);
        inputContainer.appendChild(deleteBtn);
        propertyDiv.appendChild(inputContainer);
        propertyList.appendChild(propertyDiv);
      }
    }

    if (Object.keys(objectData).filter(k => !excludedKeys.has(k)).length === 0) {
      const noPropsDiv = document.createElement("div");
      noPropsDiv.className = "ui";
      noPropsDiv.style.color = 'rgba(255, 255, 255, 0.6)';
      noPropsDiv.style.fontStyle = 'italic';
      noPropsDiv.innerText = 'No custom properties';
      propertyList.appendChild(noPropsDiv);
    }

    // Add new property button
    const addPropDiv = document.createElement("div");
    addPropDiv.className = "ui";
    addPropDiv.style.marginTop = '10px';
    addPropDiv.style.paddingTop = '10px';
    addPropDiv.style.borderTop = '1px solid rgba(46, 204, 113, 0.2)';

    const addPropBtn = document.createElement("button");
    addPropBtn.className = "ui";
    addPropBtn.innerText = '+ Add Property';
    addPropBtn.style.width = '100%';
    addPropBtn.style.padding = '8px';
    addPropBtn.style.background = 'rgba(46, 204, 113, 0.2)';
    addPropBtn.style.color = 'rgba(46, 204, 113, 0.8)';
    addPropBtn.style.border = '1px solid rgba(46, 204, 113, 0.4)';
    addPropBtn.style.borderRadius = '3px';
    addPropBtn.style.cursor = 'pointer';
    addPropBtn.onclick = () => {
      this.openAddPropertyModal(objectData, excludedKeys, () => this.refreshPropertiesPanel());
    };

    addPropDiv.appendChild(addPropBtn);
    propertyList.appendChild(addPropDiv);

    content.appendChild(propertyList);
  }

  private validateWarps(warps: any): { valid: boolean; invalidWarps: string[] } {
    const invalidWarps: string[] = [];

    for (const [warpName, warpData] of Object.entries(warps)) {
      const warp = warpData as any;
      const missingProps: string[] = [];

      // Check for required properties
      if (!warp.map || warp.map === '') {
        missingProps.push('map');
      }
      if (warp.x === undefined || warp.x === null || warp.x === '') {
        missingProps.push('x');
      }
      if (warp.y === undefined || warp.y === null || warp.y === '') {
        missingProps.push('y');
      }

      if (missingProps.length > 0) {
        invalidWarps.push(`${warpName} (missing: ${missingProps.join(', ')})`);
      }
    }

    return {
      valid: invalidWarps.length === 0,
      invalidWarps
    };
  }

  private showNotification(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration: number = 3000) {
    const container = document.getElementById('tile-editor-notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `te-notification te-notification-${type}`;
    notification.textContent = message;
    container.appendChild(notification);

    // Auto-remove after duration
    setTimeout(() => {
      notification.classList.add('hiding');
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 300); // Match the hiding animation duration
    }, duration);

    // Click to dismiss
    notification.addEventListener('click', () => {
      notification.classList.add('hiding');
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 300);
    });
  }

  public saveMap() {
    this.save();
  }

  private save() {
    // Implement save cooldown to prevent spam
    const now = Date.now();
    if (now - this.lastSaveTime < this.saveCooldownMs) {
      return;
    }
    this.lastSaveTime = now;

    const hasChunkChanges = this.undoStack.length > 0;
    const hasGraveyardChanges = window.mapData?.graveyards !== undefined;
    const hasWarpChanges = window.mapData?.warps !== undefined;

    if (!hasChunkChanges && !hasGraveyardChanges && !hasWarpChanges) {
      return;
    }

    // Validate warps before saving
    if (window.mapData?.warps) {
      const validation = this.validateWarps(window.mapData.warps);
      if (!validation.valid) {
        const invalidList = validation.invalidWarps.join(', ');
        const message = `Cannot save: Invalid warps: ${invalidList}`;
        console.error(message);
        this.showNotification(message, 'error', 5000);
        return;
      }
    }

    const chunkChanges = new Map<string, any>();

    this.undoStack.forEach(item => {

      const changes: TileChange[] = 'changes' in item ? item.changes : [item as TileChange];

      changes.forEach(change => {
        const chunkKey = `${change.chunkX}-${change.chunkY}`;

        if (!chunkChanges.has(chunkKey)) {
          const chunk = window.mapData.loadedChunks.get(chunkKey);
          if (chunk) {

            chunkChanges.set(chunkKey, {
              chunkX: change.chunkX,
              chunkY: change.chunkY,
              width: chunk.width,
              height: chunk.height,
              layers: chunk.layers.map((layer: any) => ({
                name: layer.name,
                zIndex: layer.zIndex,
                data: [...layer.data],
                locked: layer.locked,
              }))
            });
          }
        }
      });
    });

    const chunks = Array.from(chunkChanges.values());

    // Editor extent for server-side growth / origin re-base. minTileX/minTileY are
    // <= 0 when the map was expanded left/up. Clamp to 0 to disable left/up expansion.
    const saveMinTileX = window.mapData.minTileX ?? 0;
    const saveMinTileY = window.mapData.minTileY ?? 0;
    const shiftTilesX = -Math.min(0, saveMinTileX);
    const shiftTilesY = -Math.min(0, saveMinTileY);
    const didShift = shiftTilesX > 0 || shiftTilesY > 0;
    const saveBounds = {
      minTileX: saveMinTileX,
      minTileY: saveMinTileY,
      width: window.mapData.width,
      height: window.mapData.height,
      infinite: window.mapData.infinite === true,
    };

    // For left/up expansion the origin re-bases on save, so shift object positions
    // to match before sending (the server shifts the object-group layers itself).
    if (didShift) {
      const dpx = shiftTilesX * window.mapData.tilewidth;
      const dpy = shiftTilesY * window.mapData.tileheight;
      for (const w of Object.values(window.mapData.warps || {}) as any[]) {
        if (w?.position) { w.position.x += dpx; w.position.y += dpy; }
      }
      for (const g of Object.values(window.mapData.graveyards || {}) as any[]) {
        if (g?.position) { g.position.x += dpx; g.position.y += dpy; }
      }
    }

    // Count objects being saved
    // Convert graveyards and warps from objects to arrays for saving
    const graveyardsArray = window.mapData?.graveyards
      ? Object.entries(window.mapData.graveyards).map(([name, data]: [string, any]) => ({
          name,
          ...data
        }))
      : [];

      const warpsArray = window.mapData?.warps
        ? Object.entries(window.mapData.warps).map(([name, data]: any) => ({
            name,
            ...data,
            x: data.x ?? '',
            y: data.y ?? '',
          }))
        : [];

    const savePayload: any = {
      type: 'SAVE_MAP',
      data: {
        mapName: window.mapData.name,
        chunks: chunks,
        bounds: saveBounds,
        graveyards: graveyardsArray,
        warps: warpsArray
      }
    };

    sendRequest(savePayload);

    this.layerDataSnapshot = null;

    Promise.all(chunks.map(chunk =>
      clearChunkFromCache(window.mapData.name, chunk.chunkX, chunk.chunkY)
    )).catch(() => {});

    this.undoStack = [];
    this.redoStack = [];

    // Clear unsaved layers tracking
    this.unsavedLayers.clear();
    this.updateLayerList();
  }

  private setTool(tool: 'paint' | 'erase' | 'copy' | 'paste') {
    // Prevent switching to editing tools when the selected layer is locked
    if (tool !== 'copy' && this.selectedLayer && this.isLayerLocked(this.selectedLayer)) {
      return;
    }

    this.currentTool = tool;
    this.lastPlacedTilePos = null;

    // Deselect object layer when switching to a tile tool
    if (this.selectedObject) {
      this.deselectObject();
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.isActive) return;

    if ((e.keyCode === 90 || e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.rotateSelectedTile();
      return;
    }

    if (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.isShiftHeld = true;
      return;
    }

    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    // Don't allow mode changes when an object layer is selected
    if (this.selectedObject && ['p', 'e', 'c', 'v'].includes(e.key)) {
      return;
    }

    // Don't allow editing tools when the selected layer is locked
    const isLayerLocked = this.selectedLayer ? this.isLayerLocked(this.selectedLayer) : false;
    if (isLayerLocked && ['p', 'e', 'v'].includes(e.key)) {
      return;
    }

    if (e.key === 'p') this.setTool('paint');
    if (e.key === 'e') this.setTool('erase');
    if (e.key === 'c') this.setTool('copy');
    if (e.key === 'v') {

      if (this.copiedTile !== null) {
        this.setTool('paste');
      }
    }

    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      e.stopPropagation();
      // If properties panel is open, undo property changes instead of tiles
      if (this.propertiesPanel && this.propertiesPanel.parentNode) {
        this.propertyUndo();
      } else {
        this.undo();
      }
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      e.stopPropagation();
      // If properties panel is open, redo property changes instead of tiles
      if (this.propertiesPanel && this.propertiesPanel.parentNode) {
        this.propertyRedo();
      } else {
        this.redo();
      }
    }

    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      // Prevent player movement by stopping default key handling
      e.stopPropagation();
      this.save();
    }

    if (e.key === 'Delete' && this.selectedObjectName && this.deleteButtonCoords) {
      e.preventDefault();
      this.deleteSelectedObject();
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.isShiftHeld = false;
    }
  }

  private onMapContextMenu(e: MouseEvent) {
    if (!this.isActive || !window.mapData) {
      return;
    }

    // When a tile layer is selected, right-click is for tile copying - suppress context menu
    if (this.selectedLayer) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // Convert client coordinates to canvas-relative coordinates
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    const worldPos = this.screenToWorld(screenX, screenY);
    const worldX = worldPos.x;
    const worldY = worldPos.y;

    // Remove existing context menu
    const existingMenu = document.getElementById("context-menu");
    if (existingMenu) existingMenu.remove();

    // Create context menu
    const contextMenu = document.createElement("div");
    contextMenu.className = "ui";
    contextMenu.id = 'context-menu';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Boundary checks
    if (e.clientX + 200 > window.innerWidth) {
      contextMenu.style.left = `${e.clientX - 200}px`;
    }

    if (e.clientX - 200 < 0) {
      contextMenu.style.left = `${e.clientX + 50}px`;
    }

    if (e.clientY + 150 > window.innerHeight) {
      contextMenu.style.top = `${e.clientY - 150}px`;
    }

    if (e.clientY - 150 < 0) {
      contextMenu.style.top = `${e.clientY + 50}px`;
    }

    const ul = document.createElement("ul");
    ul.className = "ui";

    // Check what was clicked
    const clickedGraveyard = this.getGraveyardAtPosition(worldX, worldY);
    const clickedWarp = this.getWarpAtPosition(worldX, worldY);

    // Auto-select the object when right-clicking on it
    if (clickedGraveyard) {
      this.selectObject('Graveyards');
      this.selectedObjectName = clickedGraveyard;
    } else if (clickedWarp) {
      this.selectObject('Warps');
      this.selectedObjectName = clickedWarp;
    }

    if (clickedGraveyard && this.selectedObject === 'Graveyards') {
      // Show properties option for graveyard (only if Graveyards layer is selected)
      const propertiesItem = document.createElement("li");
      propertiesItem.className = "ui";
      propertiesItem.innerText = "Properties";
      propertiesItem.onclick = (e) => {
        e.stopPropagation();
        // Object was already selected on right-click
        this.openPropertiesPanel('Graveyards', clickedGraveyard);
        contextMenu.remove();
      };
      ul.appendChild(propertiesItem);

      // Show delete option for graveyard
      const deleteItem = document.createElement("li");
      deleteItem.className = "ui";
      deleteItem.innerText = "Delete";
      deleteItem.onclick = (e) => {
        e.stopPropagation();
        // Object was already selected on right-click
        const graveyardData = (window.mapData.graveyards as any)[clickedGraveyard];
        if (graveyardData) {
          this.deleteButtonCoords = {
            type: 'Graveyards',
            name: clickedGraveyard,
            x: 0,
            y: 0,
            size: 16
          };
        }
        this.deleteSelectedObject();
        contextMenu.remove();
      };
      ul.appendChild(deleteItem);
    } else if (clickedWarp && this.selectedObject === 'Warps') {
      // Show properties option for warp (only if Warps layer is selected)
      const propertiesItem = document.createElement("li");
      propertiesItem.innerText = "Properties";
      propertiesItem.onclick = (e) => {
        e.stopPropagation();
        // Object was already selected on right-click
        this.openPropertiesPanel('Warps', clickedWarp);
        contextMenu.remove();
      };
      ul.appendChild(propertiesItem);

      // Show delete option for warp
      const deleteItem = document.createElement("li");
      deleteItem.innerText = "Delete";
      deleteItem.onclick = (e) => {
        e.stopPropagation();
        // Object was already selected on right-click
        const warpData = (window.mapData.warps as any)[clickedWarp];
        if (warpData) {
          this.deleteButtonCoords = {
            type: 'Warps',
            name: clickedWarp,
            x: 0,
            y: 0,
            size: 16
          };
        }
        this.deleteSelectedObject();
        contextMenu.remove();
      };
      ul.appendChild(deleteItem);
    } else if (this.selectedObject && this.isObjectLayerVisible(this.selectedObject)) {
      // Show create option for empty area based on selected object layer
      // Only show if the selected layer is visible
      const createItem = document.createElement("li");
      createItem.innerText = "Create";
      createItem.onclick = (e) => {
        e.stopPropagation();
        if (this.selectedObject === 'Graveyards') {
          this.createGraveyardAtPosition(worldX, worldY);
        } else if (this.selectedObject === 'Warps') {
          this.createWarpAtPosition(worldX, worldY);
        }
        contextMenu.remove();
      };
      ul.appendChild(createItem);
    }

    // Only show context menu if there are menu items
    if (ul.children.length > 0) {
      contextMenu.appendChild(ul);
      document.body.appendChild(contextMenu);
      document.addEventListener("click", () => contextMenu.remove(), { once: true });
    }
  }

  private createGraveyardAtPosition(x: number, y: number) {
    if (!window.mapData) return;

    // Initialize graveyards object if it doesn't exist
    if (!window.mapData.graveyards) {
      window.mapData.graveyards = {};
    }

    // Generate unique name
    let counter = 1;
    let newName = `Graveyard_${counter}`;
    while ((window.mapData.graveyards as any)[newName]) {
      counter++;
      newName = `Graveyard_${counter}`;
    }

    // Create graveyard object
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    const graveyardData = {
      position: { x: roundedX, y: roundedY }
    };

    (window.mapData.graveyards as any)[newName] = graveyardData;

    // Record creation mutation
    const mutation: ObjectMutation = {
      type: 'graveyard',
      name: newName,
      oldState: null,
      newState: {
        x: roundedX,
        y: roundedY
      }
    };
    this.undoStack.push(mutation);
    this.redoStack = [];

    // Mark Graveyards as unsaved
    this.unsavedLayers.add('Graveyards');
    this.updateLayerList();

    // Auto-select the created object
    this.selectedObjectName = newName;
  }

  private createWarpAtPosition(x: number, y: number) {
    if (!window.mapData) {
      return;
    }

    // Initialize warps object if it doesn't exist
    if (!window.mapData.warps) {
      window.mapData.warps = {};
    }

    // Generate unique name
    let counter = 1;
    let newName = `Warp_${counter}`;
    while ((window.mapData.warps as any)[newName]) {
      counter++;
      newName = `Warp_${counter}`;
    }

    // Create warp object
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    const warpData = {
      map: '',
      x: '',
      y: '',
      position: { x: roundedX, y: roundedY },
      size: {
        width: 32,
        height: 32
      }
    };

    (window.mapData.warps as any)[newName] = warpData;

    // Record creation mutation
    const mutation: ObjectMutation = {
      type: 'warp',
      name: newName,
      oldState: null,
      newState: {
        x: roundedX,
        y: roundedY,
        width: 32,
        height: 32
      }
    };
    this.undoStack.push(mutation);
    this.redoStack = [];

    // Mark Warps as unsaved
    this.unsavedLayers.add('Warps');
    this.updateLayerList();

    // Auto-select the created object
    this.selectedObjectName = newName;

    // Auto-open properties panel for the new warp
    this.openPropertiesPanel('Warps', newName);
  }

  private openPropertiesPanel(objectType: string, objectName: string) {
    if (!window.mapData) return;

    // Select the object on right-click
    this.selectedObject = objectType;
    this.selectedObjectName = objectName;

    // Close existing properties panel if open - clear old undo/redo stacks
    if (this.propertiesPanel && this.propertiesPanel.parentNode) {
      this.propertyUndoStack = [];
      this.propertyRedoStack = [];
      this.propertiesPanel.remove();
    }

    // Get the object data
    let objectData: any = null;
    if (objectType === 'Graveyards' && window.mapData.graveyards) {
      objectData = (window.mapData.graveyards as any)[objectName];
    } else if (objectType === 'Warps' && window.mapData.warps) {
      objectData = (window.mapData.warps as any)[objectName];
    }

    if (!objectData) return;

    // Initialize property undo/redo stacks for this panel
    this.propertyUndoStack = [];
    this.propertyRedoStack = [];
    this.currentPropertyObject = objectData;
    this.currentPropertyObjectType = objectType;
    this.currentPropertyObjectName = objectName;

    // Get object position to spawn panel nearby
    const objX = objectData.position?.x || objectData.x || 0;
    const objY = objectData.position?.y || objectData.y || 0;
    const screenX = window.innerWidth / 2 - objX;
    const screenY = window.innerHeight / 2 - objY;
    let panelLeft = screenX + 100;
    let panelTop = screenY + 100;

    // Keep panel within bounds
    panelLeft = Math.max(10, Math.min(panelLeft, window.innerWidth - 370));
    panelTop = Math.max(10, Math.min(panelTop, window.innerHeight - 650));

    // Create properties panel
    this.propertiesPanel = document.createElement("div");
    this.propertiesPanel.id = 'te-properties-panel';
    this.propertiesPanel.className = 'te-floating-panel';
    this.propertiesPanel.style.position = 'fixed';
    this.propertiesPanel.style.left = `${panelLeft}px`;
    this.propertiesPanel.style.top = `${panelTop}px`;
    this.propertiesPanel.style.width = '350px';
    this.propertiesPanel.style.maxHeight = '600px';
    this.propertiesPanel.style.overflowY = 'auto';
    this.propertiesPanel.style.zIndex = '10000';

    // Make panel draggable
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // Create header
    const header = document.createElement("div");
    header.className = 'te-panel-header ui';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.cursor = 'move';

    const title = document.createElement("span");
    title.className = 'te-panel-title ui';
    title.innerText = 'Properties';

    const closeButton = document.createElement("button");
    closeButton.className = 'te-panel-close ui';
    closeButton.innerText = 'Ã—';
    closeButton.style.cursor = 'pointer';
    closeButton.onclick = () => {
      if (this.propertiesPanel && this.propertiesPanel.parentNode) {
        // Clear property undo/redo stacks when closing
        this.propertyUndoStack = [];
        this.propertyRedoStack = [];
        this.currentPropertyObject = null;
        this.currentPropertyObjectType = null;
        this.currentPropertyObjectName = null;
        this.propertiesPanel.remove();
        this.propertiesPanel = null;
      }
    };

    // Dragging functionality
    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragOffsetX = e.clientX - panelLeft;
      dragOffsetY = e.clientY - panelTop;
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging && this.propertiesPanel) {
        panelLeft = e.clientX - dragOffsetX;
        panelTop = e.clientY - dragOffsetY;
        this.propertiesPanel.style.left = `${panelLeft}px`;
        this.propertiesPanel.style.top = `${panelTop}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    header.appendChild(title);
    header.appendChild(closeButton);
    this.propertiesPanel.appendChild(header);

    // Create content
    const content = document.createElement("div");
    content.className = 'te-panel-content ui';
    content.style.padding = '15px';

    // Add properties
    const propertyList = document.createElement("div");
    propertyList.style.display = 'flex';
    propertyList.style.flexDirection = 'column';
    propertyList.style.gap = '10px';

    // Display object name
    const namePropertyDiv = document.createElement("div");
    namePropertyDiv.style.borderBottom = '1px solid rgba(46, 204, 113, 0.2)';
    namePropertyDiv.style.paddingBottom = '10px';

    const nameLabel = document.createElement("div");
    nameLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    nameLabel.style.fontSize = '0.9em';
    nameLabel.style.fontWeight = 'bold';
    nameLabel.innerText = 'Name';

    const nameValue = document.createElement("div");
    nameValue.style.color = 'rgba(255, 255, 255, 0.9)';
    nameValue.style.marginTop = '5px';
    nameValue.innerText = objectName;

    namePropertyDiv.appendChild(nameLabel);
    namePropertyDiv.appendChild(nameValue);
    propertyList.appendChild(namePropertyDiv);

    // Add all custom properties from the object, excluding system properties
    const excludedKeys = new Set(['layer', 'position', 'size']);
    // Graveyards don't have custom x and y properties
    if (objectType === 'Graveyards') {
      excludedKeys.add('x');
      excludedKeys.add('y');
    }

    const renderProperties = () => {
      propertyList.innerHTML = '';
      const propertyInputs: HTMLInputElement[] = [];

      for (const [key, value] of Object.entries(objectData)) {
        if (!excludedKeys.has(key)) {
          const propertyDiv = document.createElement("div");
          propertyDiv.style.borderBottom = '1px solid rgba(46, 204, 113, 0.2)';
          propertyDiv.style.paddingBottom = '10px';

          const label = document.createElement("div");
          label.style.color = 'rgba(46, 204, 113, 0.8)';
          label.style.fontSize = '0.9em';
          label.style.fontWeight = 'bold';
          label.innerText = key;
          propertyDiv.appendChild(label);

          const inputContainer = document.createElement("div");
          inputContainer.style.display = 'flex';
          inputContainer.style.gap = '8px';
          inputContainer.style.marginTop = '5px';
          inputContainer.style.alignItems = 'center';

          const valueInput = document.createElement("input");
          valueInput.type = 'text';
          valueInput.value = String(value);
          valueInput.style.flex = '1';
          valueInput.style.padding = '5px';
          valueInput.style.background = 'rgba(0, 0, 0, 0.3)';
          valueInput.style.color = 'rgba(255, 255, 255, 0.9)';
          valueInput.style.border = '1px solid rgba(46, 204, 113, 0.3)';
          valueInput.style.borderRadius = '3px';
          valueInput.style.boxSizing = 'border-box';

          // Add input to tracking array
          propertyInputs.push(valueInput);

          // Use both 'input' and 'change' events to catch edits while typing and on blur
          const handlePropertyChange = () => {
            const oldValue = objectData[key];
            const newValue = valueInput.value;
            if (oldValue !== newValue) {
              objectData[key] = newValue;
              // Record property edit in undo stack
              this.propertyUndoStack.push({
                type: 'edit',
                key: key,
                oldValue: oldValue,
                newValue: newValue
              });
              this.propertyRedoStack = [];
              // Mark object type as unsaved
              if (this.currentPropertyObjectType) {
                this.unsavedLayers.add(this.currentPropertyObjectType);
                this.updateLayerList();
              }
            }
          };

          valueInput.addEventListener('input', handlePropertyChange);
          valueInput.addEventListener('change', handlePropertyChange);

          // Handle Tab key navigation between inputs
          valueInput.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const currentIndex = propertyInputs.indexOf(valueInput);
              if (e.shiftKey) {
                // Shift+Tab: move to previous input
                if (currentIndex > 0) {
                  propertyInputs[currentIndex - 1].focus();
                } else if (currentIndex === 0) {
                  // Wrap to last input
                  propertyInputs[propertyInputs.length - 1].focus();
                }
              } else {
                // Tab: move to next input
                if (currentIndex < propertyInputs.length - 1) {
                  propertyInputs[currentIndex + 1].focus();
                } else if (currentIndex === propertyInputs.length - 1) {
                  // Wrap to first input
                  propertyInputs[0].focus();
                }
              }
            }
          });

          const deleteBtn = document.createElement("button");
          deleteBtn.innerText = 'âˆ’';
          deleteBtn.style.background = 'rgba(255, 100, 100, 0.3)';
          deleteBtn.style.color = 'rgba(255, 100, 100, 0.8)';
          deleteBtn.style.border = '1px solid rgba(255, 100, 100, 0.5)';
          deleteBtn.style.borderRadius = '3px';
          deleteBtn.style.padding = '5px 12px';
          deleteBtn.style.cursor = 'pointer';
          deleteBtn.style.flexShrink = '0';
          deleteBtn.onclick = () => {
            const deletedValue = objectData[key];
            delete objectData[key];
            // Record property deletion in undo stack
            this.propertyUndoStack.push({
              type: 'delete',
              key: key,
              value: deletedValue
            });
            this.propertyRedoStack = [];
            // Mark object type as unsaved
            if (this.currentPropertyObjectType) {
              this.unsavedLayers.add(this.currentPropertyObjectType);
              this.updateLayerList();
            }
            renderProperties();
          };

          inputContainer.appendChild(valueInput);
          inputContainer.appendChild(deleteBtn);
          propertyDiv.appendChild(inputContainer);
          propertyList.appendChild(propertyDiv);
        }
      }

      if (Object.keys(objectData).filter(k => !excludedKeys.has(k)).length === 0) {
        const noPropsDiv = document.createElement("div");
        noPropsDiv.style.color = 'rgba(255, 255, 255, 0.6)';
        noPropsDiv.style.fontStyle = 'italic';
        noPropsDiv.innerText = 'No custom properties';
        propertyList.appendChild(noPropsDiv);
      }

      // Add new property button
      const addPropDiv = document.createElement("div");
      addPropDiv.style.marginTop = '10px';
      addPropDiv.style.paddingTop = '10px';
      addPropDiv.style.borderTop = '1px solid rgba(46, 204, 113, 0.2)';

      const addPropBtn = document.createElement("button");
      addPropBtn.innerText = '+ Add Property';
      addPropBtn.style.width = '100%';
      addPropBtn.style.padding = '8px';
      addPropBtn.style.background = 'rgba(46, 204, 113, 0.2)';
      addPropBtn.style.color = 'rgba(46, 204, 113, 0.8)';
      addPropBtn.style.border = '1px solid rgba(46, 204, 113, 0.4)';
      addPropBtn.style.borderRadius = '3px';
      addPropBtn.style.cursor = 'pointer';
      addPropBtn.onclick = () => {
        this.openAddPropertyModal(objectData, excludedKeys, renderProperties);
      };

      addPropDiv.appendChild(addPropBtn);
      propertyList.appendChild(addPropDiv);
    };

    renderProperties();

    content.appendChild(propertyList);
    this.propertiesPanel.appendChild(content);

    // Add to tile editor container
      document.body.appendChild(this.propertiesPanel);
  }


  private openAddPropertyModal(objectData: any, excludedKeys: Set<string>, onComplete: () => void) {
    // Create modal overlay
    const modalOverlay = document.createElement("div");
    modalOverlay.className = "ui";
    modalOverlay.style.position = 'fixed';
    modalOverlay.style.top = '0';
    modalOverlay.style.left = '0';
    modalOverlay.style.width = '100%';
    modalOverlay.style.height = '100%';
    modalOverlay.style.background = 'rgba(0, 0, 0, 0.7)';
    modalOverlay.style.display = 'flex';
    modalOverlay.style.justifyContent = 'center';
    modalOverlay.style.alignItems = 'center';
    modalOverlay.style.zIndex = '10001';

    // Create modal
    const modal = document.createElement("div");
    modal.className = "ui";
    modal.style.background = 'rgba(30, 30, 40, 0.95)';
    modal.style.border = '1px solid rgba(46, 204, 113, 0.3)';
    modal.style.borderRadius = '10px';
    modal.style.padding = '20px';
    modal.style.width = '400px';
    modal.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.6)';

    // Title
    const title = document.createElement("h3");
    title.className = "ui";
    title.innerText = 'Add Property';
    title.style.color = 'rgba(46, 204, 113, 0.8)';
    title.style.margin = '0 0 20px 0';
    title.style.fontSize = '1.2em';
    modal.appendChild(title);

    // Property name field
    const nameLabel = document.createElement("label");
    nameLabel.className = "ui";
    nameLabel.innerText = 'Property Name';
    nameLabel.style.display = 'block';
    nameLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    nameLabel.style.marginBottom = '5px';
    nameLabel.style.fontSize = '0.9em';
    modal.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.className = "ui";
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g., targetMap';
    nameInput.style.width = '100%';
    nameInput.style.padding = '8px';
    nameInput.style.marginBottom = '15px';
    nameInput.style.background = 'rgba(0, 0, 0, 0.3)';
    nameInput.style.color = 'rgba(255, 255, 255, 0.9)';
    nameInput.style.border = '1px solid rgba(46, 204, 113, 0.3)';
    nameInput.style.borderRadius = '3px';
    nameInput.style.boxSizing = 'border-box';
    modal.appendChild(nameInput);

    // Type dropdown
    const typeLabel = document.createElement("label");
    typeLabel.className = "ui";
    typeLabel.innerText = 'Value Type';
    typeLabel.style.display = 'block';
    typeLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    typeLabel.style.marginBottom = '5px';
    typeLabel.style.fontSize = '0.9em';
    modal.appendChild(typeLabel);

    const typeSelect = document.createElement("select");
    typeSelect.className = "ui";
    typeSelect.style.width = '100%';
    typeSelect.style.padding = '8px';
    typeSelect.style.marginBottom = '15px';
    typeSelect.style.background = 'rgba(0, 0, 0, 0.3)';
    typeSelect.style.color = 'rgba(255, 255, 255, 0.9)';
    typeSelect.style.border = '1px solid rgba(46, 204, 113, 0.3)';
    typeSelect.style.borderRadius = '3px';
    typeSelect.style.boxSizing = 'border-box';

    const types = ['string', 'bool', 'int', 'float', 'color', 'file', 'object'];
    types.forEach(type => {
      const option = document.createElement("option");
      option.className = "ui";
      option.value = type;
      option.innerText = type.charAt(0).toUpperCase() + type.slice(1);
      typeSelect.appendChild(option);
    });
    modal.appendChild(typeSelect);

    // Value field
    const valueLabel = document.createElement("label");
    valueLabel.className = "ui";
    valueLabel.innerText = 'Value';
    valueLabel.style.display = 'block';
    valueLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    valueLabel.style.marginBottom = '5px';
    valueLabel.style.fontSize = '0.9em';
    modal.appendChild(valueLabel);

    const valueInput = document.createElement("input");
    valueInput.className = "ui";
    valueInput.type = 'text';
    valueInput.placeholder = 'Enter value';
    valueInput.style.width = '100%';
    valueInput.style.padding = '8px';
    valueInput.style.marginBottom = '20px';
    valueInput.style.background = 'rgba(0, 0, 0, 0.3)';
    valueInput.style.color = 'rgba(255, 255, 255, 0.9)';
    valueInput.style.border = '1px solid rgba(46, 204, 113, 0.3)';
    valueInput.style.borderRadius = '3px';
    valueInput.style.boxSizing = 'border-box';
    modal.appendChild(valueInput);

    // Buttons
    const buttonContainer = document.createElement("div");
    buttonContainer.className = "ui";
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.justifyContent = 'flex-end';

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ui";
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.padding = '8px 16px';
    cancelBtn.style.background = 'rgba(100, 100, 100, 0.3)';
    cancelBtn.style.color = 'rgba(255, 255, 255, 0.8)';
    cancelBtn.style.border = '1px solid rgba(100, 100, 100, 0.5)';
    cancelBtn.style.borderRadius = '3px';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.onclick = () => {
      modalOverlay.remove();
    };
    buttonContainer.appendChild(cancelBtn);

    const addBtn = document.createElement("button");
    addBtn.className = "ui";
    addBtn.innerText = 'Add';
    addBtn.style.padding = '8px 16px';
    addBtn.style.background = 'rgba(46, 204, 113, 0.3)';
    addBtn.style.color = 'rgba(46, 204, 113, 0.8)';
    addBtn.style.border = '1px solid rgba(46, 204, 113, 0.5)';
    addBtn.style.borderRadius = '3px';
    addBtn.style.cursor = 'pointer';
    addBtn.onclick = () => {
      const propName = nameInput.value.trim();
      const propValue = valueInput.value.trim();

      if (!propName) {
        alert('Please enter a property name');
        return;
      }

      if (excludedKeys.has(propName) || propName.toLowerCase() === 'name') {
        alert('This property name is reserved');
        return;
      }

      if (Object.prototype.hasOwnProperty.call(objectData, propName)) {
        alert('Property already exists');
        return;
      }

      if (!propValue) {
        alert('Please enter a value');
        return;
      }

      // Convert and validate value based on type
      let convertedValue: any;
      const selectedType = typeSelect.value;

      switch (selectedType) {
        case 'bool': {
          const boolLower = propValue.toLowerCase();
          if (boolLower !== 'true' && boolLower !== 'false') {
            alert('Bool value must be "true" or "false"');
            return;
          }
          convertedValue = boolLower === 'true';
          break;
        }
        case 'int': {
          const intValue = parseInt(propValue, 10);
          if (isNaN(intValue) || propValue !== String(intValue)) {
            alert('Int value must be a whole number (e.g., 42, -5)');
            return;
          }
          convertedValue = intValue;
          break;
        }
        case 'float': {
          const floatValue = parseFloat(propValue);
          if (isNaN(floatValue)) {
            alert('Float value must be a valid number (e.g., 3.14, -5.5, 10)');
            return;
          }
          convertedValue = floatValue;
          break;
        }
        case 'color':
          // Color can be any string (hex, rgb, color name, etc.)
          convertedValue = propValue;
          break;
        case 'file':
          // File path/reference can be any string
          convertedValue = propValue;
          break;
        case 'object':
          try {
            convertedValue = JSON.parse(propValue);
          } catch (e) {
            alert('Object value must be valid JSON (e.g., {"key": "value"})');
            return;
          }
          break;
        case 'string':
        default:
          convertedValue = propValue;
          break;
      }

      objectData[propName] = convertedValue;
      // Record property creation in undo stack
      this.propertyUndoStack.push({
        type: 'create',
        key: propName,
        value: convertedValue
      });
      this.propertyRedoStack = [];

      // Mark object layer as unsaved
      if (this.currentPropertyObjectType) {
        this.unsavedLayers.add(this.currentPropertyObjectType);
        this.updateLayerList();
      }

      modalOverlay.remove();
      onComplete();
    };
    buttonContainer.appendChild(addBtn);

    modal.appendChild(buttonContainer);
    modalOverlay.appendChild(modal);
    document.body.appendChild(modalOverlay);

    // Focus on name input
    nameInput.focus();
  }

  public renderPreview() {
    if (!this.isActive || !window.mapData || !ctx) return;

    ctx.save();

    if (this.isMapDraggingSelection && this.mapDragStartTile && this.mapDragEndTile) {
      const minX = Math.min(this.mapDragStartTile.x, this.mapDragEndTile.x);
      const maxX = Math.max(this.mapDragStartTile.x, this.mapDragEndTile.x);
      const minY = Math.min(this.mapDragStartTile.y, this.mapDragEndTile.y);
      const maxY = Math.max(this.mapDragStartTile.y, this.mapDragEndTile.y);

      if (this.currentTool === 'erase') {
        ctx.fillStyle = 'rgba(231, 76, 60, 0.3)';
        ctx.strokeStyle = 'rgba(255, 89, 71, 1.0)';
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      }

      ctx.fillRect(
        minX * window.mapData.tilewidth,
        minY * window.mapData.tileheight,
        (maxX - minX + 1) * window.mapData.tilewidth,
        (maxY - minY + 1) * window.mapData.tileheight
      );

      ctx.lineWidth = 2;
      ctx.strokeRect(
        minX * window.mapData.tilewidth,
        minY * window.mapData.tileheight,
        (maxX - minX + 1) * window.mapData.tilewidth,
        (maxY - minY + 1) * window.mapData.tileheight
      );
      ctx.restore();
      return;
    }

    if (!this.previewTilePos) {
      ctx.restore();
      return;
    }

    if (this.isShiftHeld && this.lastPlacedTilePos && this.currentTool !== 'erase') {
      const lineTiles = this.getLineTiles(this.lastPlacedTilePos.x, this.lastPlacedTilePos.y, this.previewTilePos.x, this.previewTilePos.y);

      const tileToUse = this.currentTool === 'paste' ? this.copiedTile : this.selectedTile;
      if (tileToUse) {
        const baseGID = getTileBaseGid(tileToUse);
        const tileset = window.mapData.tilesets.find((t: any) =>
          t.firstgid <= baseGID && baseGID < t.firstgid + t.tilecount
        );
        if (tileset) {
          const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
          if (image && image.complete) {
            const localId = baseGID - tileset.firstgid;
            const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
            const srcX = (localId % tilesPerRow) * tileset.tilewidth;
            const srcY = Math.floor(localId / tilesPerRow) * tileset.tileheight;
            const tw = window.mapData.tilewidth;
            const th = window.mapData.tileheight;

            ctx.globalAlpha = 0.75;
            ctx.imageSmoothingEnabled = false;

            for (const pos of lineTiles) {
              const wx = pos.x * tw;
              const wy = pos.y * th;

              drawTileWithFlags(ctx, image, srcX, srcY, tileset.tilewidth, tileset.tileheight, wx, wy, tw, th, tileToUse);

              ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
              ctx.lineWidth = 2;
              ctx.strokeRect(wx, wy, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
      ctx.restore();
      return;
    }

    ctx.globalAlpha = 0.75;
    ctx.imageSmoothingEnabled = false;

    if (this.currentTool === 'paint' && this.selectedTiles.length > 0) {
      try {
        for (let row = 0; row < this.selectedTiles.length; row++) {
          for (let col = 0; col < this.selectedTiles[row].length; col++) {
            const tileId = this.selectedTiles[row][col];
            const worldX = (this.previewTilePos.x + col) * window.mapData.tilewidth;
            const worldY = (this.previewTilePos.y + row) * window.mapData.tileheight;

            if (tileId === 0) {
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
              ctx.lineWidth = 1;
              ctx.strokeRect(worldX, worldY, window.mapData.tilewidth, window.mapData.tileheight);
              continue;
            }

            const baseGID = getTileBaseGid(tileId);
            const tileset = window.mapData.tilesets.find((t: any) =>
              t.firstgid <= baseGID && baseGID < t.firstgid + t.tilecount
            );

            if (!tileset) continue;

            const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
            if (!image || !image.complete) continue;

            const localTileId = baseGID - tileset.firstgid;
            const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
            const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
            const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;
            const tw = window.mapData.tilewidth;
            const th = window.mapData.tileheight;

            drawTileWithFlags(ctx, image, srcX, srcY, tileset.tilewidth, tileset.tileheight, worldX, worldY, tw, th, tileId);

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 2;
            ctx.strokeRect(worldX, worldY, window.mapData.tilewidth, window.mapData.tileheight);
          }
        }
      } catch (e) {
        console.error('Error drawing preview tile:', e);
      }
      ctx.restore();
      return;
    }

    if (this.currentTool === 'erase') {
      const worldX = this.previewTilePos.x * window.mapData.tilewidth;
      const worldY = this.previewTilePos.y * window.mapData.tileheight;

      ctx.fillStyle = 'rgba(231, 76, 60, 0.3)';
      ctx.fillRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.strokeStyle = 'rgba(255, 89, 71, 1.0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.restore();
      return;
    }

    let tileToPreview: number | null = null;
    if (this.currentTool === 'paint' && this.selectedTile) {
      tileToPreview = this.selectedTile;
    } else if (this.currentTool === 'paste' && this.copiedTile !== null) {
      tileToPreview = this.copiedTile;
    } else if (this.currentTool === 'copy') {
      // Show white outline for copy mode
      const worldX = this.previewTilePos.x * window.mapData.tilewidth;
      const worldY = this.previewTilePos.y * window.mapData.tileheight;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.restore();
      return;
    }

    if ((this.currentTool === 'paint' && !this.selectedTile) ||
        (this.currentTool === 'paste' && this.copiedTile === 0)) {
      const worldX = this.previewTilePos.x * window.mapData.tilewidth;
      const worldY = this.previewTilePos.y * window.mapData.tileheight;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.restore();
      return;
    }

    if (tileToPreview === null || tileToPreview === 0) {
      ctx.restore();
      return;
    }

    const baseGID = getTileBaseGid(tileToPreview);
    const tileset = window.mapData.tilesets.find((t: any) =>
      t.firstgid <= baseGID && baseGID < t.firstgid + t.tilecount
    );

    if (!tileset) {
      ctx.restore();
      return;
    }

    const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
    if (!image || !image.complete) {
      ctx.restore();
      return;
    }

    const localTileId = baseGID - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

    const worldX = this.previewTilePos.x * window.mapData.tilewidth;
    const worldY = this.previewTilePos.y * window.mapData.tileheight;

    try {
      drawTileWithFlags(ctx, image, srcX, srcY, tileset.tilewidth, tileset.tileheight, worldX, worldY, window.mapData.tilewidth, window.mapData.tileheight, tileToPreview);
    } catch (e) {
      console.error('Error drawing preview tile:', e);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      worldX,
      worldY,
      window.mapData.tilewidth,
      window.mapData.tileheight
    );

    ctx.restore();
  }
}

const tileEditor = new TileEditor();

(window as any).tileEditor = tileEditor;

export default tileEditor;
