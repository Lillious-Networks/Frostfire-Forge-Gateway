class TileEditorBridge {
  private paintBtn: HTMLElement;
  private eraseBtn: HTMLElement;
  private copyBtn: HTMLElement;
  private pasteBtn: HTMLElement;
  private undoBtn: HTMLElement;
  private redoBtn: HTMLElement;
  private saveBtn: HTMLElement;
  private toggleGridBtn: HTMLElement;
  private clearBtn: HTMLElement;
  private layersList: HTMLElement;
  private objectsList: HTMLElement;
  private tilesetTabs: HTMLElement;
  private tilesetContainer: HTMLElement;
  private tilesetCanvas: HTMLCanvasElement;
  private tilesetCtx: CanvasRenderingContext2D;

  private tilesets: any[] = [];
  private tilesetImages: HTMLImageElement[] = [];
  private currentTilesetIndex: number = 0;

  private layerData: any[] = [];
  private layerVisibility: Map<string, boolean> = new Map();
  private layerLocked: Map<string, boolean> = new Map();
  private objectLayerVisibility: Map<string, boolean> = new Map();
  private unsavedLayers: Set<string> = new Set();

  private currentTool: string = 'paint';
  private selectedLayer: string | null = null;
  private selectedObject: string | null = null;
  private selectedTile: number | null = null;
  private selectedTiles: number[][] = [];
  private selectedTilesFromMap: boolean = false;

  private hoveredTilesetPos: { x: number; y: number } | null = null;
  private isSelectingTiles: boolean = false;
  private selectionStartTile: { x: number; y: number } | null = null;
  private selectionEndTile: { x: number; y: number } | null = null;

  private isPanningTileset: boolean = false;
  private tilesetPanStartX: number = 0;
  private tilesetPanStartY: number = 0;
  private tilesetScrollStartX: number = 0;
  private tilesetScrollStartY: number = 0;

  private paletteAnimRunning = false;
  private lastPaletteAnimSignature = '';

  constructor() {
    this.paintBtn = document.getElementById('te-tool-paint') as HTMLElement;
    this.eraseBtn = document.getElementById('te-tool-erase') as HTMLElement;
    this.copyBtn = document.getElementById('te-copy') as HTMLElement;
    this.pasteBtn = document.getElementById('te-paste') as HTMLElement;
    this.undoBtn = document.getElementById('te-undo') as HTMLElement;
    this.redoBtn = document.getElementById('te-redo') as HTMLElement;
    this.saveBtn = document.getElementById('te-save') as HTMLElement;
    this.toggleGridBtn = document.getElementById('te-toggle-grid') as HTMLElement;
    this.clearBtn = document.getElementById('te-clear') as HTMLElement;
    this.layersList = document.getElementById('editor-layers-list') as HTMLElement;
    this.objectsList = document.getElementById('editor-objects-list') as HTMLElement;
    this.tilesetTabs = document.getElementById('editor-tileset-tabs') as HTMLElement;
    this.tilesetContainer = document.getElementById('editor-tileset-container') as HTMLElement;
    this.tilesetCanvas = document.getElementById('editor-tileset-canvas') as HTMLCanvasElement;
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;

    this.setupEventListeners();
    this.setupMessageListener();
    this.setupBeforeUnload();
    this.startPaletteAnimation();

    this.notifyReady();
  }

  private notifyReady() {
    if (window.opener) {
      window.opener.postMessage({ type: 'bridgeReady' }, '*');
    }
  }

  private setupBeforeUnload() {
    window.addEventListener('beforeunload', () => {
      if (window.opener) {
        window.opener.postMessage({ type: 'editorClosed' }, '*');
      }
    });
  }

  private setupMessageListener() {
    window.addEventListener('message', (e) => {
      if (e.source !== window.opener) return;

      const msg = e.data;
      switch (msg.type) {
        case 'init':
          this.handleInit(msg);
          break;
        case 'tilesetImage':
          this.handleTilesetImage(msg);
          break;
        case 'layerUpdate':
          this.handleLayerUpdate(msg);
          break;
        case 'toolUpdate':
          this.handleToolUpdate(msg);
          break;
        case 'layerSelectUpdate':
          this.handleLayerSelectUpdate(msg);
          break;
        case 'layerVisibilityUpdate':
          this.handleLayerVisibilityUpdate(msg);
          break;
        case 'layerLockUpdate':
          this.handleLayerLockUpdate(msg);
          break;
        case 'objectSelectUpdate':
          this.handleObjectSelectUpdate(msg);
          break;
        case 'objectVisibilityUpdate':
          this.handleObjectVisibilityUpdate(msg);
          break;
        case 'tileSelectUpdate':
          this.handleTileSelectUpdate(msg);
          break;
        case 'close':
          window.close();
          break;
      }
    });
  }

  private send(msg: any) {
    if (window.opener) {
      window.opener.postMessage(msg, '*');
    }
  }

  private handleInit(msg: any) {
    this.tilesets = msg.tilesets || [];
    this.currentTilesetIndex = 0;

    this.layerData = msg.layers || [];

    this.layerVisibility.clear();
    if (msg.layerVisibility) {
      msg.layerVisibility.forEach(([key, val]: [string, boolean]) => this.layerVisibility.set(key, val));
    }
    this.layerLocked.clear();
    if (msg.layerLocked) {
      msg.layerLocked.forEach(([key, val]: [string, boolean]) => this.layerLocked.set(key, val));
    }
    this.objectLayerVisibility.clear();
    this.objectLayerVisibility.set('Graveyards', msg.objectVisibility?.Graveyards ?? true);
    this.objectLayerVisibility.set('Warps', msg.objectVisibility?.Warps ?? true);

    this.unsavedLayers.clear();
    if (msg.unsavedLayers) {
      msg.unsavedLayers.forEach((s: string) => this.unsavedLayers.add(s));
    }

    this.currentTool = msg.tool || 'paint';
    this.selectedLayer = msg.selectedLayer || null;
    this.selectedObject = msg.selectedObject || null;
    this.selectedTile = msg.selectedTile || null;
    this.selectedTiles = msg.selectedTiles || [];
    this.selectedTilesFromMap = msg.selectedTilesFromMap || false;

    this.updateToolButtons();
    this.buildLayerList();
    this.buildObjectList();
    this.buildTilesetTabs();
    this.updatePasteButtonState();
  }

  private handleTilesetImage(msg: any) {
    const img = new Image();
    img.onload = () => {
      this.tilesetImages[msg.index] = img;
      if (msg.index === this.currentTilesetIndex) {
        this.drawTileset();
      }
    };
    img.src = msg.dataUrl;
  }

  private handleLayerUpdate(msg: any) {
    this.layerData = msg.layers || [];
    this.unsavedLayers.clear();
    if (msg.unsavedLayers) {
      msg.unsavedLayers.forEach((s: string) => this.unsavedLayers.add(s));
    }
    this.buildLayerList();
  }

  private handleToolUpdate(msg: any) {
    this.currentTool = msg.tool;
    this.updateToolButtons();
    this.updatePasteButtonState();
  }

  private handleLayerSelectUpdate(msg: any) {
    this.selectedLayer = msg.layerName;
    this.selectedObject = null;
    this.updateLayerSelection();
    this.updateObjectSelection();
    this.updatePasteButtonState();

    const isLocked = this.layerLocked.get(msg.layerName) ?? false;
    this.setEditButtonsLocked(isLocked);
  }

  private handleLayerVisibilityUpdate(msg: any) {
    this.layerVisibility.set(msg.layerName, msg.visible);
    this.updateLayerListItem(msg.layerName);
  }

  private handleLayerLockUpdate(msg: any) {
    this.layerLocked.set(msg.layerName, msg.locked);
    this.updateLayerListItem(msg.layerName);

    if (this.selectedLayer === msg.layerName) {
      this.setEditButtonsLocked(msg.locked);
      this.updatePasteButtonState();
    }
  }

  private handleObjectSelectUpdate(msg: any) {
    this.selectedObject = msg.objectType;
    this.selectedLayer = null;
    this.updateLayerSelection();
    this.updateObjectSelection();
    this.updatePasteButtonState();

    this.setEditButtonsLocked(!!msg.objectType);
  }

  private handleObjectVisibilityUpdate(msg: any) {
    this.objectLayerVisibility.set(msg.objectType, msg.visible);
    this.updateObjectListItem(msg.objectType);
  }

  private handleTileSelectUpdate(msg: any) {
    this.selectedTile = msg.tileId;
    this.selectedTiles = msg.selectedTiles || [];
    this.selectedTilesFromMap = msg.selectedTilesFromMap || false;
    this.updatePasteButtonState();
    this.drawTileset();
  }

  private setEditButtonsLocked(locked: boolean): void {
    const btns = [this.paintBtn, this.eraseBtn, this.copyBtn, this.pasteBtn] as HTMLButtonElement[];
    btns.forEach(btn => {
      btn.classList.toggle('disabled', locked);
      btn.disabled = locked;
    });
  }

  private updatePasteButtonState(): void {
    const isLocked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    const disabled = this.selectedTile === null || isLocked || !!this.selectedObject;
    (this.pasteBtn as HTMLButtonElement).disabled = disabled;
    this.pasteBtn.style.opacity = disabled ? '0.5' : '1';
    this.pasteBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  }

  private setupEventListeners() {
    this.paintBtn.addEventListener('click', () => this.setTool('paint'));
    this.eraseBtn.addEventListener('click', () => this.setTool('erase'));
    this.copyBtn.addEventListener('click', () => this.setTool('copy'));
    this.pasteBtn.addEventListener('click', () => {
      if (this.selectedTile !== null) {
        this.setTool('paste');
      }
    });

    this.undoBtn.addEventListener('click', () => this.send({ type: 'command', name: 'undo' }));
    this.redoBtn.addEventListener('click', () => this.send({ type: 'command', name: 'redo' }));
    this.saveBtn.addEventListener('click', () => this.send({ type: 'command', name: 'save' }));
    this.toggleGridBtn.addEventListener('click', () => this.send({ type: 'command', name: 'toggleGrid' }));
    this.clearBtn.addEventListener('click', () => this.send({ type: 'command', name: 'clear' }));

    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.tilesetCanvas.addEventListener('mousedown', (e) => this.onTilesetMouseDown(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseup', (e) => this.onTilesetMouseUp(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));
  }

  private onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    if (this.selectedObject && ['p', 'e', 'c', 'v'].includes(e.key)) return;

    const isLocked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    if (isLocked && ['p', 'e', 'v'].includes(e.key)) return;

    if (e.key === 'p') this.setTool('paint');
    if (e.key === 'e') this.setTool('erase');
    if (e.key === 'c') this.setTool('copy');
    if (e.key === 'v' && this.selectedTile !== null) this.setTool('paste');

    if (e.key === 'z' && !e.ctrlKey) {
      e.preventDefault();
      this.send({ type: 'command', name: 'rotateTile' });
    }

    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      this.send({ type: 'command', name: 'undo' });
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      this.send({ type: 'command', name: 'redo' });
    }
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this.send({ type: 'command', name: 'save' });
    }
  }

  private setTool(tool: string) {
    if (tool !== 'copy' && this.selectedLayer && (this.layerLocked.get(this.selectedLayer) ?? false)) return;

    this.currentTool = tool;
    this.updateToolButtons();

    if (this.selectedObject) {
      this.send({ type: 'objectSelect', objectType: null });
    }

    this.send({ type: 'toolChange', tool });
  }

  private updateToolButtons() {
    this.paintBtn.classList.toggle('active', this.currentTool === 'paint');
    this.eraseBtn.classList.toggle('active', this.currentTool === 'erase');
    this.copyBtn.classList.toggle('active', this.currentTool === 'copy');
    this.pasteBtn.classList.toggle('active', this.currentTool === 'paste');
  }

  private buildLayerList() {
    this.layersList.innerHTML = '';

    if (this.layerData.length === 0) return;

    this.layerData.forEach((layer: any) => {
      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');

      if (!this.layerVisibility.has(layer.name)) {
        this.layerVisibility.set(layer.name, true);
      }
      if (!this.layerLocked.has(layer.name)) {
        this.layerLocked.set(layer.name, layer.locked ?? false);
      }

      const layerItem = document.createElement('div');
      layerItem.className = 'te-layer-item ui';

      let colorStyle = '';
      if (isCollision) colorStyle = 'color: #ff9999;';
      else if (isNoPvp) colorStyle = 'color: #99ff99;';

      const isVisible = this.layerVisibility.get(layer.name) ?? true;
      const eyeEmoji = isVisible ? '👁️' : '🚫';
      const isLocked = this.layerLocked.get(layer.name) ?? false;
      const lockEmoji = isLocked ? '🔒' : '🔓';
      const isUnsaved = this.unsavedLayers.has(layer.name);
      const labelText = isUnsaved ? `${layer.name} *` : layer.name;

      if (isLocked) layerItem.classList.add('locked');
      if (this.selectedLayer === layer.name && !this.selectedObject) layerItem.classList.add('active');

      layerItem.innerHTML = `<span class="te-layer-label" style="${colorStyle}">${labelText}</span><span class="te-layer-lock">${lockEmoji}</span><span class="te-layer-eye">${eyeEmoji}</span>`;

      layerItem.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('te-layer-lock')) {
          const newLocked = !(this.layerLocked.get(layer.name) ?? false);
          this.layerLocked.set(layer.name, newLocked);
          this.updateLayerListItem(layer.name);
          this.send({ type: 'layerLock', layerName: layer.name, locked: newLocked });
        } else if ((e.target as HTMLElement).classList.contains('te-layer-eye')) {
          const newVisibility = !(this.layerVisibility.get(layer.name) ?? true);
          this.layerVisibility.set(layer.name, newVisibility);
          this.updateLayerListItem(layer.name);
          this.send({ type: 'layerToggle', layerName: layer.name, visible: newVisibility });
        } else {
          this.send({ type: 'layerSelect', layerName: layer.name });
        }
      });

      this.layersList.appendChild(layerItem);
    });
  }

  private updateLayerListItem(layerName: string) {
    const items = this.layersList.querySelectorAll('.te-layer-item');
    items.forEach(item => {
      const label = item.querySelector('.te-layer-label');
      const labelText = label?.textContent?.replace(' *', '') || '';
      if (labelText === layerName) {
        const isVisible = this.layerVisibility.get(layerName) ?? true;
        const eyeSpan = item.querySelector('.te-layer-eye');
        if (eyeSpan) eyeSpan.textContent = isVisible ? '👁️' : '🚫';

        const isLocked = this.layerLocked.get(layerName) ?? false;
        const lockSpan = item.querySelector('.te-layer-lock');
        if (lockSpan) lockSpan.textContent = isLocked ? '🔒' : '🔓';

        if (isLocked) item.classList.add('locked');
        else item.classList.remove('locked');
      }
    });
  }

  private updateLayerSelection() {
    const items = this.layersList.querySelectorAll('.te-layer-item');
    items.forEach(item => {
      const label = item.querySelector('.te-layer-label');
      const labelText = label?.textContent?.replace(' *', '') || '';
      if (labelText === this.selectedLayer && !this.selectedObject) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  private buildObjectList() {
    const objectTypes = ['Graveyards', 'Warps'];
    this.objectsList.innerHTML = '';

    objectTypes.forEach(type => {
      if (!this.objectLayerVisibility.has(type)) {
        this.objectLayerVisibility.set(type, true);
      }

      const item = document.createElement('div');
      item.className = 'te-object-layer-item ui';

      const isVisible = this.objectLayerVisibility.get(type) ?? true;
      const eyeEmoji = isVisible ? '👁️' : '🚫';

      if (this.selectedObject === type) item.classList.add('active');

      item.innerHTML = `<span class="te-object-label">${type}</span><span class="te-object-eye">${eyeEmoji}</span>`;

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('te-object-eye')) {
          const newVisibility = !(this.objectLayerVisibility.get(type) ?? true);
          this.objectLayerVisibility.set(type, newVisibility);
          this.updateObjectListItem(type);
          this.send({ type: 'objectToggle', objectType: type, visible: newVisibility });
        } else {
          this.send({ type: 'objectSelect', objectType: type });
        }
      });

      this.objectsList.appendChild(item);
    });
  }

  private updateObjectListItem(type: string) {
    const items = this.objectsList.querySelectorAll('.te-object-layer-item');
    items.forEach(item => {
      const label = item.querySelector('.te-object-label');
      if (label?.textContent === type) {
        const isVisible = this.objectLayerVisibility.get(type) ?? true;
        const eyeSpan = item.querySelector('.te-object-eye');
        if (eyeSpan) eyeSpan.textContent = isVisible ? '👁️' : '🚫';
      }
    });
  }

  private updateObjectSelection() {
    const items = this.objectsList.querySelectorAll('.te-object-layer-item');
    items.forEach(item => {
      const label = item.querySelector('.te-object-label');
      if (label?.textContent === this.selectedObject) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  private buildTilesetTabs() {
    this.tilesetTabs.innerHTML = '';

    this.tilesets.forEach((tileset: any, index: number) => {
      const tab = document.createElement('div');
      const tabName = tileset.name || `Tileset ${index + 1}`;
      tab.className = 'te-tileset-tab ui';
      tab.textContent = tabName;
      tab.title = tabName;
      tab.addEventListener('click', () => this.selectTileset(index));
      this.tilesetTabs.appendChild(tab);
    });

    if (this.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;

    const tabs = this.tilesetTabs.querySelectorAll('.te-tileset-tab');
    tabs.forEach((tab, i) => {
      tab.classList.toggle('active', i === index);
    });

    this.drawTileset();
    this.send({ type: 'tilesetSelect', index });
  }

  // --- Tileset Canvas Rendering ---

  private drawTileset() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const image = this.tilesetImages[this.currentTilesetIndex];

    if (!tileset || !image || !image.complete) return;

    const scale = 1;
    this.tilesetCanvas.width = tileset.imagewidth * scale;
    this.tilesetCanvas.height = tileset.imageheight * scale;

    this.tilesetCtx.imageSmoothingEnabled = false;
    this.tilesetCtx.drawImage(image, 0, 0, tileset.imagewidth * scale, tileset.imageheight * scale);

    const animatedTiles = this.getAnimatedTilesForTileset(tileset);
    if (animatedTiles.size > 0) {
      const animTilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
      const animTw = tileset.tilewidth * scale;
      const animTh = tileset.tileheight * scale;
      const animNow = performance.now();
      animatedTiles.forEach((info, localId) => {
        const col = localId % animTilesPerRow;
        const rowIdx = Math.floor(localId / animTilesPerRow);
        const destX = col * animTw;
        const destY = rowIdx * animTh;
        const frameTileId = this.getCurrentAnimationTileId(info.animation, info.totalDuration, animNow);
        const srcX = (frameTileId % animTilesPerRow) * tileset.tilewidth;
        const srcY = Math.floor(frameTileId / animTilesPerRow) * tileset.tileheight;

        this.tilesetCtx.clearRect(destX, destY, animTw, animTh);
        this.tilesetCtx.drawImage(
          image,
          srcX, srcY, tileset.tilewidth, tileset.tileheight,
          destX, destY, animTw, animTh
        );

        const badge = Math.max(4, Math.min(animTw, animTh) * 0.28);
        this.tilesetCtx.fillStyle = 'rgba(255, 210, 40, 0.9)';
        this.tilesetCtx.beginPath();
        this.tilesetCtx.moveTo(destX, destY);
        this.tilesetCtx.lineTo(destX + badge, destY);
        this.tilesetCtx.lineTo(destX, destY + badge);
        this.tilesetCtx.closePath();
        this.tilesetCtx.fill();
      });
    }

    this.tilesetCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.tilesetCtx.lineWidth = 1;

    const tileWidth = tileset.tilewidth * scale;
    const tileHeight = tileset.tileheight * scale;
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);

    this.tilesetCtx.beginPath();

    for (let x = 0; x <= cols; x++) {
      this.tilesetCtx.moveTo(x * tileWidth, 0);
      this.tilesetCtx.lineTo(x * tileWidth, rows * tileHeight);
    }

    for (let y = 0; y <= rows; y++) {
      this.tilesetCtx.moveTo(0, y * tileHeight);
      this.tilesetCtx.lineTo(cols * tileWidth, y * tileHeight);
    }

    this.tilesetCtx.stroke();

    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
      const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
      const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
      const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
      this.tilesetCtx.fillRect(minX * tileWidth, minY * tileHeight, (maxX - minX + 1) * tileWidth, (maxY - minY + 1) * tileHeight);

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 2;
      this.tilesetCtx.strokeRect(minX * tileWidth, minY * tileHeight, (maxX - minX + 1) * tileWidth, (maxY - minY + 1) * tileHeight);
    } else if (this.selectedTiles.length > 0 && !this.selectedTilesFromMap) {
      const height = this.selectedTiles.length;
      const width = this.selectedTiles[0].length;

      const firstTileId = this.selectedTiles[0][0];
      if (firstTileId >= tileset.firstgid && firstTileId < tileset.firstgid + tileset.tilecount) {
        const localTileId = firstTileId - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const startX = (localTileId % tilesPerRow);
        const startY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
        this.tilesetCtx.fillRect(startX * tileWidth, startY * tileHeight, width * tileWidth, height * tileHeight);

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(startX * tileWidth, startY * tileHeight, width * tileWidth, height * tileHeight);
      }
    } else if (this.selectedTile) {
      const baseGID = this.selectedTile & 0x0FFFFFFF;
      if (baseGID >= tileset.firstgid && baseGID < tileset.firstgid + tileset.tilecount) {
        const localTileId = baseGID - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const selectedX = (localTileId % tilesPerRow);
        const selectedY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(selectedX * tileWidth, selectedY * tileHeight, tileWidth, tileHeight);
      }
    }

    if (this.hoveredTilesetPos && !this.isSelectingTiles) {
      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      this.tilesetCtx.fillRect(this.hoveredTilesetPos.x * tileWidth, this.hoveredTilesetPos.y * tileHeight, tileWidth, tileHeight);
    }
  }

  private getAnimatedTilesForTileset(tileset: any): Map<number, { animation: Array<{ tileid: number; duration: number }>; totalDuration: number }> {
    const lookup = new Map<number, { animation: Array<{ tileid: number; duration: number }>; totalDuration: number }>();
    if (!tileset || !Array.isArray(tileset.tiles)) return lookup;
    for (const tile of tileset.tiles) {
      if (!Array.isArray(tile.animation) || tile.animation.length === 0) continue;
      const totalDuration = tile.animation.reduce((sum: number, frame: any) => sum + (frame.duration || 0), 0);
      lookup.set(tile.id, { animation: tile.animation, totalDuration });
    }
    return lookup;
  }

  private getCurrentAnimationTileId(animation: Array<{ tileid: number; duration: number }>, totalDuration: number, now: number): number {
    if (!animation || animation.length === 0) return 0;
    if (totalDuration <= 0) return animation[0].tileid;
    let t = now % totalDuration;
    for (let i = 0; i < animation.length; i++) {
      if (t < animation[i].duration) return animation[i].tileid;
      t -= animation[i].duration;
    }
    return animation[animation.length - 1].tileid;
  }

  private computePaletteAnimSignature(): string {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const animated = this.getAnimatedTilesForTileset(tileset);
    if (animated.size === 0) return '';
    const now = performance.now();
    let sig = '';
    animated.forEach((info, localId) => {
      sig += `${localId}:${this.getCurrentAnimationTileId(info.animation, info.totalDuration, now)};`;
    });
    return sig;
  }

  private startPaletteAnimation() {
    if (this.paletteAnimRunning) return;
    this.paletteAnimRunning = true;
    const tick = () => {
      if (this.tilesetCtx && this.tilesets.length > 0) {
        const sig = this.computePaletteAnimSignature();
        if (sig !== this.lastPaletteAnimSignature) {
          this.lastPaletteAnimSignature = sig;
          this.drawTileset();
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // --- Tileset Canvas Mouse Events ---

  private onTilesetMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;

    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const containerRect = this.tilesetContainer.getBoundingClientRect();

    if (e.clientX < containerRect.left || e.clientX > containerRect.right ||
        e.clientY < containerRect.top || e.clientY > containerRect.bottom) {
      return;
    }

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    this.isSelectingTiles = true;
    this.selectionStartTile = { x: tileX, y: tileY };
    this.selectionEndTile = { x: tileX, y: tileY };

    this.drawTileset();
  }

  private onTilesetMouseUp(e: MouseEvent) {
    if (!this.isSelectingTiles) return;

    this.isSelectingTiles = false;
    this.selectedTilesFromMap = false;

    const tileset = this.tilesets[this.currentTilesetIndex];
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

    this.send({
      type: 'tileSelect',
      tileId: this.selectedTile,
      tilesetIndex: this.currentTilesetIndex,
      selectedTiles: this.selectedTiles,
      selectedTilesFromMap: this.selectedTilesFromMap
    });

    this.drawTileset();
  }

  private onTilesetMouseMove(e: MouseEvent) {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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

  // --- Tileset Panning ---

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
}

new TileEditorBridge();
