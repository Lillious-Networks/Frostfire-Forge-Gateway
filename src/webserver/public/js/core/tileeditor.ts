import { sendRequest } from "./socket.js";
import { canvas, ctx, collisionTilesDebugCheckbox, noPvpDebugCheckbox } from "./ui.js";
import { renderChunkToCanvas, clearChunkFromCache } from "./map.js";

declare global {
  interface Window {
    mapData?: any;
  }
}

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

interface PanelDragState {
  panel: HTMLElement;
  header: HTMLElement;
  isDragging: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
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
  private dimOtherLayers: boolean = false;
  private objectLayerVisibility: Map<string, boolean> = new Map();
  private layerVisibility: Map<string, boolean> = new Map();
  private minimizedPanelPositions: Map<string, { top: string, left: string, transform: string }> = new Map();
  private unsavedLayers: Set<string> = new Set();
  private undoStack: (TileChange | TileChangeGroup | ObjectMutation)[] = [];
  private redoStack: (TileChange | TileChangeGroup | ObjectMutation)[] = [];
  private copiedTile: number | null = null;
  private isMouseDown: boolean = false;
  private previewTilePos: { x: number, y: number } | null = null;
  private hoveredTilesetPos: { x: number, y: number } | null = null;
  private lastSaveTime: number = 0;
  private saveCooldownMs: number = 500;

  private isSelectingTiles: boolean = false;
  private selectionStartTile: { x: number, y: number } | null = null;
  private selectionEndTile: { x: number, y: number } | null = null;
  private selectedTiles: number[][] = [];

  private isPanningTileset: boolean = false;
  private tilesetPanStartX: number = 0;
  private tilesetPanStartY: number = 0;
  private tilesetScrollStartX: number = 0;
  private tilesetScrollStartY: number = 0;

  private isResizing: boolean = false;
  private resizeStartX: number = 0;
  private resizeStartY: number = 0;
  private resizeStartWidth: number = 0;
  private resizeStartHeight: number = 0;

  private panels: Map<string, PanelDragState> = new Map();

  private container: HTMLElement;
  private toolbarPanel: HTMLElement;
  private layersPanel: HTMLElement;
  private tilesetPanel: HTMLElement;
  private tilesetHeader: HTMLElement;
  private paintBtn: HTMLElement;
  private eraseBtn: HTMLElement;
  private copyBtn: HTMLElement;
  private pasteBtn: HTMLElement;
  private undoBtn: HTMLElement;
  private redoBtn: HTMLElement;
  private saveBtn: HTMLElement;
  private resetViewBtn: HTMLElement;
  private toggleOpacityBtn: HTMLElement;
  private toggleGridBtn: HTMLElement;
  private layersList: HTMLElement;
  private objectsPanel: HTMLElement;
  private objectsList: HTMLElement;
  private tilesetTabs: HTMLElement;
  private tilesetContainer: HTMLElement;
  private tilesetCanvas: HTMLCanvasElement;
  private tilesetCtx: CanvasRenderingContext2D;
  private resizeHandle: HTMLElement;

  constructor() {

    this.container = document.getElementById('tile-editor-container') as HTMLElement;
    this.toolbarPanel = document.getElementById('tile-editor-toolbar-panel') as HTMLElement;
    this.layersPanel = document.getElementById('tile-editor-layers-panel') as HTMLElement;
    this.tilesetPanel = document.getElementById('tile-editor-tileset-panel') as HTMLElement;

    this.tilesetHeader = this.tilesetPanel.querySelector('.te-panel-header') as HTMLElement;
    this.resizeHandle = this.tilesetPanel.querySelector('.te-resize-handle') as HTMLElement;

    this.paintBtn = document.getElementById('te-tool-paint') as HTMLElement;
    this.eraseBtn = document.getElementById('te-tool-erase') as HTMLElement;
    this.copyBtn = document.getElementById('te-copy') as HTMLElement;
    this.pasteBtn = document.getElementById('te-paste') as HTMLElement;
    this.undoBtn = document.getElementById('te-undo') as HTMLElement;
    this.redoBtn = document.getElementById('te-redo') as HTMLElement;
    this.saveBtn = document.getElementById('te-save') as HTMLElement;
    this.resetViewBtn = document.getElementById('te-reset-view') as HTMLElement;
    this.toggleOpacityBtn = document.getElementById('te-toggle-opacity') as HTMLElement;
    this.toggleGridBtn = document.getElementById('te-toggle-grid') as HTMLElement;
    this.layersList = document.getElementById('tile-editor-layers-list') as HTMLElement;
    this.objectsPanel = document.getElementById('tile-editor-objects-panel') as HTMLElement;
    this.objectsList = document.getElementById('tile-editor-objects-list') as HTMLElement;
    this.tilesetTabs = document.getElementById('tile-editor-tileset-tabs') as HTMLElement;
    this.tilesetContainer = document.getElementById('tile-editor-tileset-container') as HTMLElement;
    this.tilesetCanvas = document.getElementById('tile-editor-tileset-canvas') as HTMLCanvasElement;
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;

    this.initializePanels();
    this.setupEventListeners();
  }

  private initializePanels() {

    const toolbarHeader = this.toolbarPanel.querySelector('.te-panel-header') as HTMLElement;
    this.panels.set('toolbar', {
      panel: this.toolbarPanel,
      header: toolbarHeader || this.toolbarPanel,
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    const layersHeader = this.layersPanel.querySelector('.te-panel-header') as HTMLElement;
    this.panels.set('layers', {
      panel: this.layersPanel,
      header: layersHeader || this.layersPanel,
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    const objectsPanelHeader = this.objectsPanel.querySelector('.te-panel-header') as HTMLElement;
    this.panels.set('objects', {
      panel: this.objectsPanel,
      header: objectsPanelHeader,
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    this.panels.set('tileset', {
      panel: this.tilesetPanel,
      header: this.tilesetHeader,
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    this.loadPanelPositions();
    this.loadMinimizedStates();

    const closeButtons = document.querySelectorAll('.te-panel-close');
    closeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const panelType = target.getAttribute('data-panel');
        if (panelType === 'tileset') {
          this.toggle();
        } else if (panelType === 'objects') {
          this.objectsPanel.style.display = 'none';
        }
      });
    });

    const minimizeButtons = document.querySelectorAll('.te-panel-minimize');
    minimizeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const panelType = target.getAttribute('data-panel');
        if (panelType) {
          this.togglePanelMinimize(panelType);
        }
      });
    });

    const panelHeaders = document.querySelectorAll('.te-panel-header');
    panelHeaders.forEach(header => {
      header.addEventListener('click', (e) => {
        // If clicking on a minimized panel header, toggle maximize
        const panelId = (header.parentElement as any)?.id;
        if (panelId && (header.parentElement as HTMLElement).classList.contains('minimized')) {
          const panelType = panelId.replace('tile-editor-', '').replace('-panel', '');
          this.togglePanelMinimize(panelType);
        }
      });
    });
  }

  private togglePanelMinimize(panelType: string) {
    const panelState = this.panels.get(panelType);
    if (!panelState) return;

    const panel = panelState.panel;
    panel.classList.toggle('minimized');

    if (panel.classList.contains('minimized')) {
      // Save current position before minimizing
      const style = getComputedStyle(panel);
      const savedPos = {
        top: panel.style.top || style.top,
        left: panel.style.left || style.left,
        transform: panel.style.transform || style.transform
      };

      // For tileset panel that hasn't been moved, use default centered positioning
      if (panelType === 'tileset' && (panel.style.top === '' && panel.style.left === '')) {
        savedPos.top = '50%';
        savedPos.left = '50%';
        savedPos.transform = 'translate(-50%, -50%)';
      }

      this.minimizedPanelPositions.set(panelType, savedPos);
    } else {
      // Restore saved position
      const savedPos = this.minimizedPanelPositions.get(panelType);
      if (savedPos) {
        panel.style.bottom = 'auto';
        panel.style.right = 'auto';
        panel.style.top = savedPos.top;
        panel.style.left = savedPos.left;
        panel.style.transform = savedPos.transform;
      }
    }

    // Recalculate all minimized panel positions
    this.updateMinimizedPanelPositions();
    this.saveMinimizedStates();
  }

  private loadMinimizedStates() {
    try {
      const saved = localStorage.getItem('tile-editor-minimized-states');
      if (!saved) return;

      const minimizedStates = JSON.parse(saved);
      Object.entries(minimizedStates).forEach(([panelType, isMinimized]: [string, any]) => {
        if (isMinimized) {
          const panelState = this.panels.get(panelType);
          if (panelState) {
            const panel = panelState.panel;
            panel.classList.add('minimized');

            // Save the position before it was minimized
            if (panelType === 'tileset') {
              this.minimizedPanelPositions.set(panelType, {
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)'
              });
            }
          }
        }
      });

      // Recalculate positions for all minimized panels
      this.updateMinimizedPanelPositions();
    } catch (e) {
      console.error('Error loading minimized states:', e);
    }
  }

  private saveMinimizedStates() {
    try {
      const minimizedStates: { [key: string]: boolean } = {};
      this.panels.forEach((panelState, panelType) => {
        minimizedStates[panelType] = panelState.panel.classList.contains('minimized');
      });
      localStorage.setItem('tile-editor-minimized-states', JSON.stringify(minimizedStates));
    } catch (e) {
      console.error('Error saving minimized states:', e);
    }
  }

  private updateMinimizedPanelPositions() {
    const minimizedPanels = Array.from(document.querySelectorAll('.te-floating-panel.minimized'));
    minimizedPanels.forEach((panel, index) => {
      const offset = index * 50; // Stack them vertically with 50px spacing
      (panel as HTMLElement).style.bottom = `${20 + offset}px`;
      (panel as HTMLElement).style.right = '20px';
      (panel as HTMLElement).style.top = 'auto';
      (panel as HTMLElement).style.left = 'auto';
      (panel as HTMLElement).style.transform = 'none';
    });
  }

  private setupEventListeners() {

    this.paintBtn.addEventListener('click', () => this.setTool('paint'));
    this.eraseBtn.addEventListener('click', () => this.setTool('erase'));
    this.copyBtn.addEventListener('click', () => this.setTool('copy'));
    this.pasteBtn.addEventListener('click', () => {

      if (this.copiedTile !== null) {
        this.setTool('paste');
      }
    });

    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    this.saveBtn.addEventListener('click', () => this.save());
    this.resetViewBtn.addEventListener('click', () => this.resetPanelPositions());
    this.toggleOpacityBtn.addEventListener('click', () => this.toggleLayerOpacity());
    this.toggleGridBtn.addEventListener('click', () => this.toggleGrid());

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));

    this.panels.forEach((panelState, id) => {
      panelState.header.addEventListener('mousedown', (e) => this.onPanelDragStart(id, e));
    });

    document.addEventListener('mousemove', (e) => this.onPanelDrag(e));
    document.addEventListener('mouseup', () => this.onPanelDragEnd());

    this.tilesetCanvas.addEventListener('mousedown', (e) => this.onTilesetMouseDown(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseup', (e) => this.onTilesetMouseUp(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));

    this.resizeHandle.addEventListener('mousedown', (e) => this.onResizeStart(e));
    document.addEventListener('mousemove', (e) => this.onResize(e));
    document.addEventListener('mouseup', () => this.onResizeEnd());

    canvas.addEventListener('mousemove', (e) => this.onMapMouseMove(e));
    canvas.addEventListener('mousedown', (e) => this.onMapMouseDown(e));
    canvas.addEventListener('mouseup', () => this.onMapMouseUp());
    canvas.addEventListener('mouseleave', () => this.onMapMouseUp());
    canvas.addEventListener('contextmenu', (e) => this.onMapContextMenu(e));
  }

  public toggle() {
    this.isActive = !this.isActive;
    this.container.style.display = this.isActive ? 'block' : 'none';

    if (this.isActive) {

      this.panels.forEach(panelState => {
        panelState.panel.style.display = 'flex';
      });
      this.initialize();
    } else {

      collisionTilesDebugCheckbox.checked = false;
      noPvpDebugCheckbox.checked = false;

      const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
      if (gridCheckbox) {
        gridCheckbox.checked = false;
      }
      this.toggleGridBtn.classList.remove('active');
    }
  }

  private initialize() {
    if (!window.mapData) return;

    // Convert graveyards and warps from arrays to objects for editor convenience
    this.convertMapObjectsToEditorFormat();

    this.loadLayers();
    this.loadObjectLayers();
    this.loadTilesets();

    this.updatePasteButtonState();

    this.toggleOpacityBtn.classList.remove('active');
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
          map: w.map,
          x: w.x,
          y: w.y,
          position: w.position,
          size: w.size,
          layer: w.layer
        };
      });
      window.mapData.warps = warpsObj;
    }
  }

  private loadLayers() {
    if (!window.mapData) return;

    this.layersList.innerHTML = '';

    const firstChunk = window.mapData.loadedChunks.values().next().value;
    if (!firstChunk) return;

    const layers = firstChunk.layers
      .sort((a: any, b: any) => a.zIndex - b.zIndex);

    layers.forEach((layer: any) => {
      // Initialize visibility if not set
      if (!this.layerVisibility.has(layer.name)) {
        this.layerVisibility.set(layer.name, true);
      }

      const layerItem = document.createElement('div');
      layerItem.className = 'te-layer-item ui';

      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');

      let colorStyle = '';
      if (isCollision) {
        colorStyle = 'color: #ff9999;';
      } else if (isNoPvp) {
        colorStyle = 'color: #99ff99;';
      }

      const isVisible = this.layerVisibility.get(layer.name) ?? true;
      const eyeEmoji = isVisible ? '👁️' : '🚫';

      layerItem.innerHTML = `<span class="te-layer-label" style="${colorStyle}">${layer.name}</span><span class="te-layer-eye">${eyeEmoji}</span>`;

      layerItem.addEventListener('click', (e) => {
        // If clicking on the eye emoji area, toggle visibility
        if ((e.target as HTMLElement).classList.contains('te-layer-eye')) {
          const isCurrentlyVisible = this.layerVisibility.get(layer.name) ?? true;
          const newVisibility = !isCurrentlyVisible;
          this.layerVisibility.set(layer.name, newVisibility);

          // Update the eye emoji
          const eyeSpan = layerItem.querySelector('.te-layer-eye') as HTMLElement;
          if (eyeSpan) {
            eyeSpan.textContent = newVisibility ? '👁️' : '🚫';
          }
        } else {
          // Otherwise select the layer
          this.selectLayer(layer.name);
        }
      });

      this.layersList.appendChild(layerItem);
    });

    if (layers.length > 0) {
      const firstNonSpecial = layers.find((l: any) => {
        const name = l.name.toLowerCase();
        return !name.includes('collision') && !name.includes('nopvp') && !name.includes('no-pvp');
      });
      this.selectLayer(firstNonSpecial ? firstNonSpecial.name : layers[0].name);
    }
  }

  private selectLayer(layerName: string) {
    this.selectedLayer = layerName;
    this.selectedObject = null;
    this.selectedObjectName = null;
    this.deleteButtonCoords = null;

    // Clear object selection highlighting
    const objectItems = this.objectsList.querySelectorAll('.te-object-layer-item');
    objectItems.forEach((item) => {
      item.classList.remove('active');
    });

    const layerItems = this.layersList.querySelectorAll('.te-layer-item');
    layerItems.forEach((item) => {
      const labelSpan = item.querySelector('.te-layer-label');
      if (labelSpan?.textContent === layerName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    const lowerName = layerName.toLowerCase();
    const isCollision = lowerName.includes('collision');
    const isNoPvp = lowerName.includes('nopvp') || lowerName.includes('no-pvp');

    collisionTilesDebugCheckbox.checked = isCollision;

    noPvpDebugCheckbox.checked = isNoPvp;
  }

  private hasObjectLayerChanges(objectType: 'Graveyards' | 'Warps'): boolean {
    // Track all objects that have been created, deleted, or modified
    const objectStates = new Map<string, { created: boolean, deleted: boolean }>();

    // Process all mutations for this object type
    this.undoStack.forEach(item => {
      if ('type' in item && (item.type === 'graveyard' || item.type === 'warp')) {
        const mutation = item as ObjectMutation;
        const isGraveyard = mutation.type === 'graveyard';
        const isWarp = mutation.type === 'warp';

        // Only care about this object type
        if ((objectType === 'Graveyards' && !isGraveyard) || (objectType === 'Warps' && !isWarp)) {
          return;
        }

        if (!objectStates.has(mutation.name)) {
          objectStates.set(mutation.name, { created: false, deleted: false });
        }

        const state = objectStates.get(mutation.name)!;

        // Check if this is a creation (oldState is null) or deletion (newState is null)
        const isCreation = mutation.oldState === null && mutation.newState !== null;
        const isDeletion = mutation.oldState !== null && mutation.newState === null;

        if (isCreation) {
          state.created = true;
        } else if (isDeletion) {
          state.deleted = true;
        }
      }
    });

    // Check if there are any net changes
    // If an object was created and then deleted, it cancels out
    // Otherwise, if it was created, deleted, renamed, or modified, it's a change
    for (const [, state] of objectStates) {
      if (state.created && state.deleted) {
        // Created and deleted = net zero change, skip
        continue;
      }
      // Any other state means there's an actual change
      return true;
    }

    return false;
  }

  private updateLayerList() {
    // Update regular tile layers
    const layerItems = this.layersList.querySelectorAll('.te-layer-item');
    layerItems.forEach((item) => {
      const labelSpan = item.querySelector('.te-layer-label') as HTMLElement;
      if (labelSpan) {
        const layerName = labelSpan.textContent?.replace(' *', '') || '';
        if (this.unsavedLayers.has(layerName)) {
          // Add star if not already present
          if (!labelSpan.textContent?.includes('*')) {
            labelSpan.textContent = `${layerName} *`;
          }
        } else {
          // Remove star if present
          labelSpan.textContent = layerName;
        }
      }
    });

    // Update object layers - clean up unsaved status if no actual changes exist
    const objectItems = this.objectsList.querySelectorAll('.te-object-layer-item');
    objectItems.forEach((item) => {
      const labelSpan = item.querySelector('.te-object-label') as HTMLElement;
      if (labelSpan) {
        const objectType = labelSpan.textContent?.replace(' *', '') || '';

        // Check if object layer actually has changes in undo stack
        const hasChanges = objectType === 'Graveyards' || objectType === 'Warps'
          ? this.hasObjectLayerChanges(objectType as 'Graveyards' | 'Warps')
          : false;

        if (hasChanges || this.unsavedLayers.has(objectType)) {
          // Add star if not already present
          if (!labelSpan.textContent?.includes('*')) {
            labelSpan.textContent = `${objectType} *`;
          }
        } else {
          // Remove star if present
          labelSpan.textContent = objectType;
        }
      }
    });
  }

  private loadObjectLayers() {
    // Create buttons for Graveyards and Warps
    const objectTypes = ['Graveyards', 'Warps'];

    // Initialize visibility map - all visible by default
    objectTypes.forEach(type => {
      if (!this.objectLayerVisibility.has(type)) {
        this.objectLayerVisibility.set(type, true);
      }
    });

    this.objectsList.innerHTML = '';

    // Create label items for each object type with eye emoji
    objectTypes.forEach(type => {
      const item = document.createElement('div');
      item.className = 'te-object-layer-item ui';

      const isVisible = this.objectLayerVisibility.get(type) ?? true;
      const eyeEmoji = isVisible ? '👁️' : '🚫';

      item.innerHTML = `<span class="te-object-label">${type}</span><span class="te-object-eye">${eyeEmoji}</span>`;

      item.addEventListener('click', (e) => {
        // If clicking on the eye emoji area, toggle visibility
        if ((e.target as HTMLElement).classList.contains('te-object-eye')) {
          const isCurrentlyVisible = this.objectLayerVisibility.get(type) ?? true;
          const newVisibility = !isCurrentlyVisible;
          this.objectLayerVisibility.set(type, newVisibility);

          // Update the eye emoji
          const eyeSpan = item.querySelector('.te-object-eye') as HTMLElement;
          if (eyeSpan) {
            eyeSpan.textContent = newVisibility ? '👁️' : '🚫';
          }
        } else {
          // Otherwise select the object
          this.selectObject(type);
        }
      });

      this.objectsList.appendChild(item);
    });
  }

  public isObjectLayerVisible(layerName: string): boolean {
    return this.objectLayerVisibility.get(layerName) ?? true;
  }

  public isLayerVisible(layerName: string): boolean {
    return this.layerVisibility.get(layerName) ?? true;
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

    // Clear layer selection highlighting
    const layerItems = this.layersList.querySelectorAll('.te-layer-item');
    layerItems.forEach((item) => {
      item.classList.remove('active');
    });

    // Update object layer highlighting
    const objectItems = this.objectsList.querySelectorAll('.te-object-layer-item');
    objectItems.forEach((item) => {
      const labelSpan = item.querySelector('.te-object-label');
      if (labelSpan?.textContent === objectType) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Disable Map Tools buttons when object layer is selected
    this.paintBtn.classList.add('disabled');
    this.eraseBtn.classList.add('disabled');
    this.copyBtn.classList.add('disabled');
    this.pasteBtn.classList.add('disabled');
    (this.paintBtn as HTMLButtonElement).disabled = true;
    (this.eraseBtn as HTMLButtonElement).disabled = true;
    (this.copyBtn as HTMLButtonElement).disabled = true;
    (this.pasteBtn as HTMLButtonElement).disabled = true;
  }

  private deselectObject() {
    this.selectedObject = null;
    this.selectedObjectName = null;
    this.deleteButtonCoords = null;

    // Clear object layer highlighting
    const objectItems = this.objectsList.querySelectorAll('.te-object-layer-item');
    objectItems.forEach((item) => {
      item.classList.remove('active');
    });

    // Re-enable Map Tools buttons
    this.paintBtn.classList.remove('disabled');
    this.eraseBtn.classList.remove('disabled');
    this.copyBtn.classList.remove('disabled');
    this.pasteBtn.classList.remove('disabled');
    (this.paintBtn as HTMLButtonElement).disabled = false;
    (this.eraseBtn as HTMLButtonElement).disabled = false;
    (this.copyBtn as HTMLButtonElement).disabled = false;
    (this.pasteBtn as HTMLButtonElement).disabled = false;
  }

  private loadTilesets() {
    if (!window.mapData) return;

    this.tilesetTabs.innerHTML = '';

    window.mapData.tilesets.forEach((tileset: any, index: number) => {
      const tab = document.createElement('div');
      const tabName = tileset.name || `Tileset ${index + 1}`;
      tab.className = 'te-tileset-tab ui';
      tab.textContent = tabName;
      tab.title = tabName;
      tab.addEventListener('click', () => this.selectTileset(index));
      this.tilesetTabs.appendChild(tab);
    });

    if (window.mapData.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;

    const tabs = this.tilesetTabs.querySelectorAll('.te-tileset-tab');
    tabs.forEach((tab, i) => {
      if (i === index) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    this.drawTileset();
  }

  private drawTileset() {
    if (!window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    const image = window.mapData.images[this.currentTilesetIndex];

    if (!image || !tileset) return;

    const scale = 1;
    this.tilesetCanvas.width = tileset.imagewidth * scale;
    this.tilesetCanvas.height = tileset.imageheight * scale;

    this.tilesetCtx.imageSmoothingEnabled = false;
    this.tilesetCtx.drawImage(image, 0, 0, tileset.imagewidth * scale, tileset.imageheight * scale);

    this.tilesetCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.tilesetCtx.lineWidth = 1;

    const tileWidth = tileset.tilewidth * scale;
    const tileHeight = tileset.tileheight * scale;
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);

    for (let x = 0; x <= cols; x++) {
      this.tilesetCtx.beginPath();
      this.tilesetCtx.moveTo(x * tileWidth, 0);
      this.tilesetCtx.lineTo(x * tileWidth, rows * tileHeight);
      this.tilesetCtx.stroke();
    }

    for (let y = 0; y <= rows; y++) {
      this.tilesetCtx.beginPath();
      this.tilesetCtx.moveTo(0, y * tileHeight);
      this.tilesetCtx.lineTo(cols * tileWidth, y * tileHeight);
      this.tilesetCtx.stroke();
    }

    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
      const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
      const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
      const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
      this.tilesetCtx.fillRect(
        minX * tileWidth,
        minY * tileHeight,
        (maxX - minX + 1) * tileWidth,
        (maxY - minY + 1) * tileHeight
      );

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 2;
      this.tilesetCtx.strokeRect(
        minX * tileWidth,
        minY * tileHeight,
        (maxX - minX + 1) * tileWidth,
        (maxY - minY + 1) * tileHeight
      );
    }

    else if (this.selectedTiles.length > 0) {
      const height = this.selectedTiles.length;
      const width = this.selectedTiles[0].length;

      const firstTileId = this.selectedTiles[0][0];
      if (firstTileId >= tileset.firstgid && firstTileId < tileset.firstgid + tileset.tilecount) {
        const localTileId = firstTileId - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const startX = (localTileId % tilesPerRow);
        const startY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
        this.tilesetCtx.fillRect(
          startX * tileWidth,
          startY * tileHeight,
          width * tileWidth,
          height * tileHeight
        );

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(
          startX * tileWidth,
          startY * tileHeight,
          width * tileWidth,
          height * tileHeight
        );
      }
    }

    else if (this.selectedTile && this.selectedTile >= tileset.firstgid && this.selectedTile < tileset.firstgid + tileset.tilecount) {
      const localTileId = this.selectedTile - tileset.firstgid;
      const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
      const selectedX = (localTileId % tilesPerRow);
      const selectedY = Math.floor(localTileId / tilesPerRow);

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 3;
      this.tilesetCtx.strokeRect(
        selectedX * tileWidth,
        selectedY * tileHeight,
        tileWidth,
        tileHeight
      );
    }

    if (this.hoveredTilesetPos && !this.isSelectingTiles) {
      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      this.tilesetCtx.fillRect(
        this.hoveredTilesetPos.x * tileWidth,
        this.hoveredTilesetPos.y * tileHeight,
        tileWidth,
        tileHeight
      );
    }
  }

  private onTilesetMouseDown(e: MouseEvent) {
    if (!window.mapData || e.button !== 0) return;

    // Prevent any tileset interaction when an object layer is selected
    if (this.selectedObject) {
      return;
    }

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const containerRect = this.tilesetContainer.getBoundingClientRect();

    if (e.clientX < containerRect.left || e.clientX > containerRect.right ||
        e.clientY < containerRect.top || e.clientY > containerRect.bottom) {
      return;
    }

    const scale = 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    this.isSelectingTiles = true;
    this.selectionStartTile = { x: tileX, y: tileY };
    this.selectionEndTile = { x: tileX, y: tileY };

    this.drawTileset();
  }

  private onTilesetMouseUp(e: MouseEvent) {
    if (!window.mapData || !this.isSelectingTiles) return;

    this.isSelectingTiles = false;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset || !this.selectionStartTile || !this.selectionEndTile) return;

    const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
    const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
    const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
    const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);

    this.selectedTiles = [];
    for (let y = minY; y <= maxY; y++) {
      const row: number[] = [];
      for (let x = minX; x <= maxX; x++) {
        const localTileId = y * tilesPerRow + x;
        const globalTileId = tileset.firstgid + localTileId;
        row.push(globalTileId);
      }
      this.selectedTiles.push(row);
    }

    if (this.selectedTiles.length === 1 && this.selectedTiles[0].length === 1) {
      this.selectedTile = this.selectedTiles[0][0];
    } else {
      this.selectedTile = null;
    }

    this.setTool('paint');

    this.drawTileset();
  }

  private onTilesetMouseMove(e: MouseEvent) {
    if (!window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const scale = 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    if (this.isSelectingTiles) {
      this.selectionEndTile = { x: tileX, y: tileY };
      this.drawTileset();
      return;
    }

    if (!this.hoveredTilesetPos || this.hoveredTilesetPos.x !== tileX || this.hoveredTilesetPos.y !== tileY) {
      this.hoveredTilesetPos = { x: tileX, y: tileY };
      this.drawTileset();
    }
  }

  private onTilesetMouseLeave() {

    if (this.isSelectingTiles) {
      this.isSelectingTiles = false;
      this.drawTileset();
    }

    if (this.hoveredTilesetPos) {
      this.hoveredTilesetPos = null;
      this.drawTileset();
    }
  }

  private onMapMouseMove(e: MouseEvent) {
    if (!this.isActive || !window.mapData) {
      this.previewTilePos = null;
      return;
    }

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const worldX = worldPos.x;
    const worldY = worldPos.y;

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
        if (!warpData.position) {
          warpData.position = {};
        }
        warpData.position.x = newX;
        warpData.position.y = newY;
        warpData.x = newX;
        warpData.y = newY;

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

    if (this.isMouseDown && this.currentTool === 'paint') {
      this.placeTile(tileX, tileY);
    } else if (this.isMouseDown && this.currentTool === 'erase') {
      this.eraseTile(tileX, tileY);
    } else if (this.isMouseDown && this.currentTool === 'paste') {
      this.pasteTile(tileX, tileY);
    }
  }

  private onMapMouseDown(e: MouseEvent) {
    if (!this.isActive || !window.mapData) return;

    if ((e.target as HTMLElement).closest('#tile-editor-container')) {
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
      this.copyTileFromWorld(tileX, tileY);
      return;
    }

    if (e.button === 0) {
      this.isMouseDown = true;


      if (this.currentTool === 'paint') {
        this.placeTile(tileX, tileY);
      } else if (this.currentTool === 'erase') {
        this.eraseTile(tileX, tileY);
      } else if (this.currentTool === 'paste') {
        this.pasteTile(tileX, tileY);
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

    // Finalize warp resizing
    if (this.resizingWarp && window.mapData) {
      const warpData = (window.mapData.warps as any)[this.resizingWarp.name];
      if (warpData) {
        // Snap position to whole numbers
        if (warpData.position) {
          warpData.position.x = Math.round(warpData.position.x);
          warpData.position.y = Math.round(warpData.position.y);
        }
        warpData.x = Math.round(warpData.x);
        warpData.y = Math.round(warpData.y);

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

  private onPanelDragStart(panelId: string, e: MouseEvent) {
    const panelState = this.panels.get(panelId);
    if (!panelState) return;

    const target = e.target as HTMLElement;

    if (target.classList.contains('te-panel-close')) return;

    if (panelId === 'toolbar' && target.tagName === 'BUTTON') return;

    if (panelId === 'layers' && (target.classList.contains('te-layer-item') || target.closest('.te-layer-item'))) return;

    panelState.isDragging = true;
    panelState.startX = e.clientX;
    panelState.startY = e.clientY;

    const rect = panelState.panel.getBoundingClientRect();
    panelState.offsetX = rect.left;
    panelState.offsetY = rect.top;

    panelState.header.style.cursor = 'grabbing';
    panelState.panel.style.zIndex = '1001';
  }

  private onPanelDrag(e: MouseEvent) {
    this.panels.forEach(panelState => {
      if (!panelState.isDragging) return;

      const deltaX = e.clientX - panelState.startX;
      const deltaY = e.clientY - panelState.startY;

      let newX = panelState.offsetX + deltaX;
      let newY = panelState.offsetY + deltaY;

      const panelRect = panelState.panel.getBoundingClientRect();
      const maxX = window.innerWidth - panelRect.width;
      const maxY = window.innerHeight - panelRect.height;

      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      panelState.panel.style.transform = 'none';
      panelState.panel.style.left = `${newX}px`;
      panelState.panel.style.top = `${newY}px`;
      panelState.panel.style.right = 'auto';
      panelState.panel.style.bottom = 'auto';
    });
  }

  private onPanelDragEnd() {
    this.panels.forEach((panelState, id) => {
      if (!panelState.isDragging) return;

      panelState.isDragging = false;

      if (id === 'toolbar' || id === 'layers') {
        panelState.panel.style.cursor = 'grab';
      } else {
        panelState.header.style.cursor = 'grab';
      }
      panelState.panel.style.zIndex = '1000';

      this.savePanelPosition(id, panelState.panel);
    });
  }

  private onTilesetPanStart(e: MouseEvent) {

    if (e.button !== 1) return;

    e.preventDefault();
    this.isPanningTileset = true;
    this.tilesetPanStartX = e.clientX;
    this.tilesetPanStartY = e.clientY;
    this.tilesetScrollStartX = this.tilesetContainer.scrollLeft;
    this.tilesetScrollStartY = this.tilesetContainer.scrollTop;

    this.tilesetContainer.style.cursor = 'grabbing';
  }

  private onTilesetPan(e: MouseEvent) {
    if (!this.isPanningTileset) return;

    e.preventDefault();

    const deltaX = e.clientX - this.tilesetPanStartX;
    const deltaY = e.clientY - this.tilesetPanStartY;

    this.tilesetContainer.scrollLeft = this.tilesetScrollStartX - deltaX;
    this.tilesetContainer.scrollTop = this.tilesetScrollStartY - deltaY;
  }

  private onTilesetPanEnd(e: MouseEvent) {
    if (!this.isPanningTileset) return;

    this.isPanningTileset = false;
    this.tilesetContainer.style.cursor = '';
  }

  private onResizeStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    this.isResizing = true;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;
    this.resizeStartWidth = this.tilesetPanel.offsetWidth;
    this.resizeStartHeight = this.tilesetPanel.offsetHeight;

    this.tilesetPanel.style.transition = 'none';
  }

  private onResize(e: MouseEvent) {
    if (!this.isResizing) return;

    e.preventDefault();

    const deltaX = e.clientX - this.resizeStartX;
    const deltaY = e.clientY - this.resizeStartY;

    let newWidth = this.resizeStartWidth + deltaX;
    let newHeight = this.resizeStartHeight + deltaY;

    const minWidth = 400;
    const minHeight = 300;
    const maxWidth = window.innerWidth * 0.9;
    const maxHeight = window.innerHeight * 0.9;

    newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
    newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));

    this.tilesetPanel.style.width = `${newWidth}px`;
    this.tilesetPanel.style.height = `${newHeight}px`;
  }

  private onResizeEnd() {
    if (!this.isResizing) return;

    this.isResizing = false;

    this.tilesetPanel.style.transition = '';
  }

  private loadPanelPositions() {
    try {
      const saved = localStorage.getItem('tile-editor-panel-positions');
      if (!saved) return;

      const positions = JSON.parse(saved);
      this.panels.forEach((panelState, id) => {
        const position = positions[id];
        if (position) {
          panelState.panel.style.transform = 'none';
          panelState.panel.style.left = `${position.x}px`;
          panelState.panel.style.top = `${position.y}px`;
          panelState.panel.style.right = 'auto';
          panelState.panel.style.bottom = 'auto';
        }
      });
    } catch (e) {
      console.error('Error loading panel positions:', e);
    }
  }

  private savePanelPosition(panelId: string, panel: HTMLElement) {
    try {
      const saved = localStorage.getItem('tile-editor-panel-positions');
      const positions = saved ? JSON.parse(saved) : {};

      const rect = panel.getBoundingClientRect();
      positions[panelId] = {
        x: rect.left,
        y: rect.top
      };

      localStorage.setItem('tile-editor-panel-positions', JSON.stringify(positions));
    } catch (e) {
      console.error('Error saving panel position:', e);
    }
  }

  private resetPanelPositions() {

    localStorage.removeItem('tile-editor-panel-positions');

    this.panels.forEach(panelState => {
      panelState.panel.style.left = '';
      panelState.panel.style.top = '';
      panelState.panel.style.right = '';
      panelState.panel.style.bottom = '';
      panelState.panel.style.transform = '';
    });

    this.tilesetPanel.style.width = '';
    this.tilesetPanel.style.height = '';

  }

  private toggleLayerOpacity() {
    this.dimOtherLayers = !this.dimOtherLayers;

    if (this.dimOtherLayers) {
      this.toggleOpacityBtn.classList.add('active');
    } else {
      this.toggleOpacityBtn.classList.remove('active');
    }

  }

  public shouldDimLayer(layerName: string): boolean {
    return this.dimOtherLayers && layerName !== this.selectedLayer;
  }

  private toggleGrid() {
    const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
    if (gridCheckbox) {
      gridCheckbox.checked = !gridCheckbox.checked;

      if (gridCheckbox.checked) {
        this.toggleGridBtn.classList.add('active');
      } else {
        this.toggleGridBtn.classList.remove('active');
      }

    }
  }

  private screenToWorld(screenX: number, screenY: number): { x: number, y: number } {

    const cameraX = (window as any).cameraX || 0;
    const cameraY = (window as any).cameraY || 0;

    return {
      x: screenX - (window.innerWidth / 2) + cameraX,
      y: screenY - (window.innerHeight / 2) + cameraY
    };
  }

  private placeTile(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    if (this.selectedTiles.length > 0) {
      this.placeMultipleTiles(tileX, tileY);
      return;
    }

    if (!this.selectedTile) return;

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

    this.rerenderChunk(chunkX, chunkY);
  }

  private placeMultipleTiles(startTileX: number, startTileY: number) {
    if (!this.selectedLayer || !window.mapData || this.selectedTiles.length === 0) return;

    const chunkSize = window.mapData.chunkSize;
    const affectedChunks = new Set<string>();
    const changeGroup: TileChange[] = [];

    for (let row = 0; row < this.selectedTiles.length; row++) {
      for (let col = 0; col < this.selectedTiles[row].length; col++) {
        const tileId = this.selectedTiles[row][col];
        const worldTileX = startTileX + col;
        const worldTileY = startTileY + row;

        const chunkX = Math.floor(worldTileX / chunkSize);
        const chunkY = Math.floor(worldTileY / chunkSize);
        const localTileX = worldTileX % chunkSize;
        const localTileY = worldTileY % chunkSize;

        const chunkKey = `${chunkX}-${chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);

        if (!chunk) continue;

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

        affectedChunks.add(chunkKey);
      }
    }

    if (changeGroup.length > 0) {
      this.undoStack.push({ changes: changeGroup });
      this.redoStack = [];

      // Mark layer as unsaved
      this.unsavedLayers.add(this.selectedLayer);
      this.updateLayerList();
    }

    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });
  }

  private eraseTile(tileX: number, tileY: number) {
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

    this.rerenderChunk(chunkX, chunkY);
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

    this.copiedTile = tileId;

    if (tileId > 0) {
      this.selectedTile = tileId;

      const tilesetIndex = window.mapData.tilesets.findIndex((t: any) =>
        t.firstgid <= tileId && tileId < t.firstgid + t.tilecount
      );

      if (tilesetIndex !== -1 && tilesetIndex !== this.currentTilesetIndex) {
        this.selectTileset(tilesetIndex);
      } else if (tilesetIndex !== -1) {

        this.drawTileset();
      }

      this.scrollToSelectedTile();
    }

    this.setTool('paste');
    this.updatePasteButtonState();
  }

  private pasteTile(tileX: number, tileY: number) {

    if (this.copiedTile === null || !this.selectedLayer || !window.mapData) return;

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

    this.rerenderChunk(chunkX, chunkY);
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
              warpData.x = mutation.oldState.x;
            }
            if (mutation.oldState.y !== undefined) {
              if (!warpData.position) warpData.position = {};
              warpData.position.y = mutation.oldState.y;
              warpData.y = mutation.oldState.y;
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
    const affectedChunks = new Set<string>();

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

        affectedChunks.add(chunkKey);
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

      affectedChunks.add(chunkKey);
      // Mark layer as unsaved when undoing
      this.unsavedLayers.add(change.layerName);
      this.redoStack.push(change);
    }

    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });

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
    const affectedChunks = new Set<string>();

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

        affectedChunks.add(chunkKey);
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

      affectedChunks.add(chunkKey);
      // Mark layer as unsaved when redoing
      this.unsavedLayers.add(change.layerName);
      this.undoStack.push(change);
    }

    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });

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
    propertyList.style.display = 'flex';
    propertyList.style.flexDirection = 'column';
    propertyList.style.gap = '10px';

    // Render properties
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
        deleteBtn.innerText = '−';
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
                data: [...layer.data]
              }))
            });
          }
        }
      });
    });

    const chunks = Array.from(chunkChanges.values());

    chunks.forEach(chunk => {
    });

    // Count objects being saved
    // Convert graveyards and warps from objects to arrays for saving
    const graveyardsArray = window.mapData?.graveyards
      ? Object.entries(window.mapData.graveyards).map(([name, data]: [string, any]) => ({
          name,
          ...data
        }))
      : [];

    const warpsArray = window.mapData?.warps
      ? Object.entries(window.mapData.warps).map(([name, data]: [string, any]) => ({
          name,
          ...data
        }))
      : [];

    const objectCount = graveyardsArray.length + warpsArray.length;

    const savePayload: any = {
      type: 'SAVE_MAP',
      data: {
        mapName: window.mapData.name,
        chunks: chunks,
        graveyards: graveyardsArray,
        warps: warpsArray
      }
    };

    sendRequest(savePayload);

    chunks.forEach(chunk => {
      clearChunkFromCache(window.mapData.name, chunk.chunkX, chunk.chunkY);
    });

    this.undoStack = [];
    this.redoStack = [];

    // Clear unsaved layers tracking
    this.unsavedLayers.clear();
    this.updateLayerList();

    // Show save notification with object count
    const message = objectCount > 0
      ? `Saved with ${objectCount} object${objectCount !== 1 ? 's' : ''}`
      : 'Saved';
    console.log(message);
  }

  private setTool(tool: 'paint' | 'erase' | 'copy' | 'paste') {
    this.currentTool = tool;

    this.paintBtn.classList.toggle('active', tool === 'paint');
    this.eraseBtn.classList.toggle('active', tool === 'erase');
    this.copyBtn.classList.toggle('active', tool === 'copy');
    this.pasteBtn.classList.toggle('active', tool === 'paste');

    // Deselect object layer when switching to a tile tool
    if (this.selectedObject) {
      this.deselectObject();
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.isActive) return;

    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    // Don't allow mode changes when an object layer is selected
    if (this.selectedObject && ['p', 'e', 'c', 'v'].includes(e.key)) {
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
      // If properties panel is open, undo property changes instead of tiles
      if (this.propertiesPanel && this.propertiesPanel.parentNode) {
        this.propertyUndo();
      } else {
        this.undo();
      }
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
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
    // Handle key up events if needed
  }

  private onMapContextMenu(e: MouseEvent) {
    if (!this.isActive || !window.mapData) return;

    // Check if clicking on tile editor container
    if ((e.target as HTMLElement).closest('#tile-editor-container')) {
      return;
    }

    e.preventDefault();

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const worldX = worldPos.x;
    const worldY = worldPos.y;

    // Remove existing context menu
    const existingMenu = document.getElementById("context-menu");
    if (existingMenu) existingMenu.remove();

    // Create context menu
    const contextMenu = document.createElement("div");
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

    contextMenu.appendChild(ul);
    document.body.appendChild(contextMenu);
    document.addEventListener("click", () => contextMenu.remove(), { once: true });
  }

  private createGraveyardAtPosition(x: number, y: number) {
    if (!window.mapData || !window.mapData.graveyards) return;

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
    if (!window.mapData || !window.mapData.warps) return;

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
    closeButton.innerText = '×';
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
              // Mark object type as unsaved
              if (this.currentPropertyObjectType) {
                this.unsavedLayers.add(this.currentPropertyObjectType);
                this.updateLayerList();
              }
            }
          });

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
          deleteBtn.innerText = '−';
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
    const container = document.getElementById('tile-editor-container');
    if (container) {
      container.appendChild(this.propertiesPanel);
    } else {
      document.body.appendChild(this.propertiesPanel);
    }
  }

  private openAddPropertyModal(objectData: any, excludedKeys: Set<string>, onComplete: () => void) {
    // Create modal overlay
    const modalOverlay = document.createElement("div");
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
    modal.style.background = 'rgba(30, 30, 40, 0.95)';
    modal.style.border = '1px solid rgba(46, 204, 113, 0.3)';
    modal.style.borderRadius = '10px';
    modal.style.padding = '20px';
    modal.style.width = '400px';
    modal.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.6)';

    // Title
    const title = document.createElement("h3");
    title.innerText = 'Add Property';
    title.style.color = 'rgba(46, 204, 113, 0.8)';
    title.style.margin = '0 0 20px 0';
    title.style.fontSize = '1.2em';
    modal.appendChild(title);

    // Property name field
    const nameLabel = document.createElement("label");
    nameLabel.innerText = 'Property Name';
    nameLabel.style.display = 'block';
    nameLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    nameLabel.style.marginBottom = '5px';
    nameLabel.style.fontSize = '0.9em';
    modal.appendChild(nameLabel);

    const nameInput = document.createElement("input");
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
    typeLabel.innerText = 'Value Type';
    typeLabel.style.display = 'block';
    typeLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    typeLabel.style.marginBottom = '5px';
    typeLabel.style.fontSize = '0.9em';
    modal.appendChild(typeLabel);

    const typeSelect = document.createElement("select");
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
      option.value = type;
      option.innerText = type.charAt(0).toUpperCase() + type.slice(1);
      typeSelect.appendChild(option);
    });
    modal.appendChild(typeSelect);

    // Value field
    const valueLabel = document.createElement("label");
    valueLabel.innerText = 'Value';
    valueLabel.style.display = 'block';
    valueLabel.style.color = 'rgba(46, 204, 113, 0.8)';
    valueLabel.style.marginBottom = '5px';
    valueLabel.style.fontSize = '0.9em';
    modal.appendChild(valueLabel);

    const valueInput = document.createElement("input");
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
    buttonContainer.style.display = 'flex';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.justifyContent = 'flex-end';

    const cancelBtn = document.createElement("button");
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

  private updatePasteButtonState() {

    if (this.copiedTile === null) {
      (this.pasteBtn as HTMLButtonElement).disabled = true;
      this.pasteBtn.style.opacity = '0.5';
      this.pasteBtn.style.cursor = 'not-allowed';
    } else {
      (this.pasteBtn as HTMLButtonElement).disabled = false;
      this.pasteBtn.style.opacity = '1';
      this.pasteBtn.style.cursor = 'pointer';
    }
  }

  private scrollToSelectedTile() {
    if (!this.selectedTile || !window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    if (this.selectedTile < tileset.firstgid || this.selectedTile >= tileset.firstgid + tileset.tilecount) {
      return;
    }

    const localTileId = this.selectedTile - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const tileX = (localTileId % tilesPerRow);
    const tileY = Math.floor(localTileId / tilesPerRow);

    const tilePixelX = tileX * tileset.tilewidth;
    const tilePixelY = tileY * tileset.tileheight;

    const containerWidth = this.tilesetContainer.clientWidth;
    const containerHeight = this.tilesetContainer.clientHeight;

    const scrollLeft = tilePixelX - (containerWidth / 2) + (tileset.tilewidth / 2);
    const scrollTop = tilePixelY - (containerHeight / 2) + (tileset.tileheight / 2);

    this.tilesetContainer.scrollTo({
      left: Math.max(0, scrollLeft),
      top: Math.max(0, scrollTop),
      behavior: 'smooth'
    });
  }

  public renderPreview() {
    if (!this.isActive || !this.previewTilePos || !window.mapData || !ctx) return;

    ctx.save();
    ctx.globalAlpha = 0.6;

    if (this.currentTool === 'paint' && this.selectedTiles.length > 0) {
      try {
        for (let row = 0; row < this.selectedTiles.length; row++) {
          for (let col = 0; col < this.selectedTiles[row].length; col++) {
            const tileId = this.selectedTiles[row][col];
            if (tileId === 0) continue;

            const tileset = window.mapData.tilesets.find((t: any) =>
              t.firstgid <= tileId && tileId < t.firstgid + t.tilecount
            );

            if (!tileset) continue;

            const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
            if (!image || !image.complete) continue;

            const localTileId = tileId - tileset.firstgid;
            const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
            const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
            const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

            const worldX = (this.previewTilePos.x + col) * window.mapData.tilewidth;
            const worldY = (this.previewTilePos.y + row) * window.mapData.tileheight;

            ctx.drawImage(
              image,
              srcX, srcY,
              tileset.tilewidth, tileset.tileheight,
              worldX, worldY,
              window.mapData.tilewidth, window.mapData.tileheight
            );
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

    const tileset = window.mapData.tilesets.find((t: any) =>
      t.firstgid <= tileToPreview! && tileToPreview! < t.firstgid + t.tilecount
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

    const localTileId = tileToPreview - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

    const worldX = this.previewTilePos.x * window.mapData.tilewidth;
    const worldY = this.previewTilePos.y * window.mapData.tileheight;

    try {
      ctx.drawImage(
        image,
        srcX, srcY,
        tileset.tilewidth, tileset.tileheight,
        worldX, worldY,
        window.mapData.tilewidth, window.mapData.tileheight
      );
    } catch (e) {
      console.error('Error drawing preview tile:', e);
    }

    ctx.restore();
  }
}

const tileEditor = new TileEditor();

(window as any).tileEditor = tileEditor;

export default tileEditor;
