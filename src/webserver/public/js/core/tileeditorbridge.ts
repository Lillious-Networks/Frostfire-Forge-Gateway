// Map editor popup: the tile palette, the layers and the tools. The painting
// itself happens in the game window (js/core/tileeditor.ts); this window says
// what to paint with. The two talk over postMessage, and none of that
// conversation is changed here.
//
// The window is built from the shared kit (css/tools.css, js/core/toolkit.ts)
// but not from the editor workbench, which is for a list of records and a
// form: this is a tool window. What is its own is in css/mapeditor.css (me-*).
//
// The game window tells this one little: the map's tilesets and layers, which
// layer is selected, which layers are locked or have unsaved edits, and the
// tiles picked up from the map. It does not answer a Save, a tool change or
// the choice of an object layer, so what is shown here is only what it said.
import { arrowKeys, brandName, button, count, el, empty, icon, iconButton, num, oneStop, pill, screen, segments, setIcon, toast, tooltip, type IconName } from "./toolkit.js";

type Tool = "paint" | "erase" | "copy" | "paste";

const TOOLS: Array<{ id: Tool; label: string; key: string; glyph: IconName; does: string }> = [
  { id: "paint", label: "Paint", key: "P", glyph: "brush", does: "Paint the picked tiles onto the selected layer" },
  { id: "erase", label: "Erase", key: "E", glyph: "eraser", does: "Erase tiles from the selected layer" },
  { id: "copy", label: "Copy", key: "C", glyph: "copy", does: "Pick tiles up from the map, in the game window" },
  { id: "paste", label: "Paste", key: "V", glyph: "paste", does: "Put the picked tiles down as they were copied" },
];

const OBJECTS: Array<{ type: string; glyph: IconName }> = [
  { type: "Graveyards", glyph: "headstone" },
  { type: "Warps", glyph: "portal" },
];

/** How large the tiles of the palette can be shown: whole multiples, so every pixel stays a square. */
const ZOOMS = [1, 2, 3, 4];
const ZOOM_KEY = "ff-map-editor-zoom";
/** With nothing from the game window for this long, the page says so. */
const WAIT_MS = 12000;
/** How long a Save may go without the game window's answer before it is called not saved. */
const SAVE_WAIT_MS = 1500;

class TileEditorBridge {
  private sideEl = document.getElementById("me-side") as HTMLElement;
  private topEl = document.getElementById("me-topbar") as HTMLElement;
  private toolbarEl = document.getElementById("me-toolbar") as HTMLElement;
  private pageEl = document.getElementById("me-page") as HTMLElement;

  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private saveBtn!: HTMLButtonElement;
  private layersList = el("div", "tl-list");
  private objectsList = el("div", "tl-list");
  private layerCount = el("span", "tl-count");
  private tilesetTabs = el("div", "tl-tabs");
  private tilesetContainer = el("div", "me-stage");
  private tilesetCanvas = el("canvas", "me-canvas");
  private tilesetCtx: CanvasRenderingContext2D;
  private stageNote = el("div", "me-stage-note");
  private zoomSeg!: HTMLElement;
  private pickedEl = el("div", "me-foot-picked");
  private underEl = el("div", "me-foot-under");
  private legendEl = el("div", "me-legend");
  private titleEl = el("h1", "tl-title", "Map Editor");
  private noteEl = el("span", "tl-record-note");
  private statusEl = el("div", "me-status");

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

  /** The four tools are off (the selected layer is locked, or an object layer is selected), and Paste is off. */
  private toolsOff = false;
  private pasteOff = false;
  /** How many times each tile of the palette is magnified. Only how large the canvas is shown: what is drawn on it is the same. */
  private zoom = 1;
  /** The game window has sent the map. */
  private inited = false;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  /** A Save has been sent and the game window has not said the layers are saved yet. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tileset pictures the game window sent that could not be read. */
  private brokenImages = new Set<number>();
  /** The tileset to go back to once the game window has sent the map again. */
  private wantedTileset: number | null = null;
  private pictureTimer: ReturnType<typeof setTimeout> | null = null;
  private pictureLate = false;

  constructor() {
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;
    try {
      const kept = Number(localStorage.getItem(ZOOM_KEY));
      if (ZOOMS.includes(kept)) this.zoom = kept;
    } catch {
      // No storage here: the palette opens at its usual size.
    }

    this.buildSide();
    this.buildTop();
    this.buildToolbar();
    this.buildPalette();
    this.paintStatus();
    this.paintTools();
    this.paintPicked();

    // Opened by hand, not from the game: there is no game window to talk to.
    if (!window.opener) {
      this.standalone();
      return;
    }

    this.setupEventListeners();
    this.setupMessageListener();
    this.setupBeforeUnload();
    this.startPaletteAnimation();

    this.waiting();
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

  // ---------------------------------------------------- building the window

  private buildSide() {
    const brand = el("div", "tl-brand");
    const brandMark = el("span", "tl-brand-mark");
    brandMark.appendChild(icon("flame", 18));
    const name = el("span", "tl-brand-words");
    name.append(el("span", "tl-brand-name", brandName()), el("span", "tl-brand-sub", "Map Editor"));
    brand.append(brandMark, name);

    const part = (title: string, list: HTMLElement, className: string, tail?: HTMLElement) => {
      const box = el("div", `me-side-part ${className}`);
      const head = el("div", "tl-list-head");
      const heading = el("h2", "tl-list-title", title);
      heading.id = `me-${title.toLowerCase()}-title`;
      head.appendChild(heading);
      if (tail) head.appendChild(tail);
      list.setAttribute("role", "list");
      list.setAttribute("aria-labelledby", heading.id);
      box.append(head, list);
      return box;
    };
    this.layerCount.hidden = true;
    const layers = part("Layers", this.layersList, "me-side-layers", this.layerCount);
    const objects = part("Objects", this.objectsList, "me-side-objects");
    // Up and down move through the rows of a list, as in any list.
    for (const list of [this.layersList, this.objectsList]) {
      list.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const rows = [...list.querySelectorAll<HTMLElement>(".tl-list-open")];
        const at = rows.indexOf((document.activeElement as HTMLElement)?.closest(".tl-list-row")?.querySelector(".tl-list-open") as HTMLElement);
        if (at < 0) return;
        e.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      });
    }
    this.sideEl.append(brand, layers, objects);
  }

  private buildTop() {
    const thumb = el("span", "tl-thumb tl-thumb-lg");
    thumb.setAttribute("aria-hidden", "true");
    thumb.appendChild(icon("map", 18));
    const slot = el("span", "tl-record-thumb");
    slot.appendChild(thumb);
    const said = el("div", "tl-record-words");
    said.append(this.titleEl, this.noteEl);
    const record = el("div", "tl-record");
    record.append(slot, said);
    this.statusEl.setAttribute("role", "status");

    const undo = iconButton("undo", "Undo (Ctrl+Z)", () => this.send({ type: 'command', name: 'undo' }));
    const redo = iconButton("redo", "Redo (Ctrl+Y)", () => this.send({ type: 'command', name: 'redo' }));
    this.saveBtn = button("Save", () => this.save(), { icon: "save" });
    const actions = el("div", "tl-topbar-actions");
    actions.append(undo, redo, el("span", "tl-topbar-rule"), this.saveBtn);
    this.topEl.append(record, this.statusEl, actions);
  }

  private buildToolbar() {
    const group = el("div", "tl-seg me-tools");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Tool");
    for (const tool of TOOLS) {
      const btn = el("button", "tl-seg-item");
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.dataset.value = tool.id;
      btn.append(icon(tool.glyph, 15), el("span", "", tool.label), el("kbd", "tl-kbd", tool.key));
      // Paste only does anything once a tile has been picked.
      btn.addEventListener('click', () => {
        if (tool.id !== 'paste' || this.selectedTile !== null) this.setTool(tool.id);
      });
      this.toolBtns.set(tool.id, btn);
      group.appendChild(btn);
    }
    arrowKeys(group);

    const rotate = button("Rotate", () => this.send({ type: 'command', name: 'rotateTile' }), { icon: "restart", kind: "quiet", tip: "Turn the picked tiles a quarter turn (Z)" });
    rotate.appendChild(el("kbd", "tl-kbd me-key", "Z"));

    const grid = button("Grid", () => this.send({ type: 'command', name: 'toggleGrid' }), { icon: "grid", kind: "quiet", fold: true, tip: "Show or hide the grid in the game window" });
    const clear = button("Clear edits", () => this.send({ type: 'command', name: 'clear' }), { icon: "history", kind: "quiet", fold: true, tip: "Take back every edit of mine that is not saved" });
    const end = el("div", "me-toolbar-end");
    end.append(grid, clear);

    this.toolbarEl.append(el("span", "me-toolbar-title", "Tool"), group, rotate, end);
  }

  private buildPalette() {
    const inner = el("div", "tl-page-inner");
    const card = el("section", "tl-card me-palette");
    card.setAttribute("aria-label", "Tile palette");

    this.tilesetTabs.setAttribute("role", "tablist");
    this.tilesetTabs.setAttribute("aria-label", "Tilesets");
    // Left and right move through the tilesets and show the one they land on.
    this.tilesetTabs.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const all = [...this.tilesetTabs.querySelectorAll<HTMLElement>(".tl-tab")];
      const next = all[(all.indexOf(document.activeElement as HTMLElement) + step + all.length) % all.length];
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.click();
    });
    // The wheel moves along the tabs when there are more than fit.
    this.tilesetTabs.addEventListener("wheel", (e) => {
      if (this.tilesetTabs.scrollWidth <= this.tilesetTabs.clientWidth || e.ctrlKey) return;
      e.preventDefault();
      this.tilesetTabs.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: false });
    this.tilesetTabs.addEventListener("scroll", () => this.paintTabEnds());
    window.addEventListener("resize", () => this.paintTabEnds());

    this.zoomSeg = segments(ZOOMS.map((z) => [String(z), `${z}×`] as [string, string]), String(this.zoom), (z) => this.setZoom(Number(z)), "Size of the tiles");
    const zoom = el("div", "me-zoom");
    zoom.append(el("span", "", "Zoom"), this.zoomSeg);
    tooltip(zoom, "How large the tiles are shown. Ctrl and the wheel change it too.");
    const head = el("div", "me-palette-head");
    head.append(this.tilesetTabs, zoom);

    this.tilesetCanvas.setAttribute("role", "img");
    this.tilesetCanvas.setAttribute("aria-label", "The tiles of the tileset in view");
    this.tilesetContainer.append(this.tilesetCanvas, this.stageNote);

    const legendMark = el("span", "me-legend-mark");
    this.legendEl.append(legendMark, el("span", "", "moves"));
    tooltip(this.legendEl, "A yellow corner marks a tile that is animated");
    const foot = el("div", "me-foot");
    foot.append(this.pickedEl, this.legendEl, this.underEl);

    card.append(head, this.tilesetContainer, foot);
    inner.appendChild(card);
    this.pageEl.appendChild(inner);
  }

  // ----------------------------------------------- nothing to show, and why

  /** Something in place of the tileset: the palette is hidden behind it until there is one to show. */
  private showNote(...nodes: Node[]) {
    this.stageNote.replaceChildren(...nodes);
    this.stageNote.hidden = false;
    this.tilesetCanvas.hidden = true;
  }

  private hideNote() {
    this.stageNote.hidden = true;
    this.stageNote.replaceChildren();
    this.tilesetCanvas.hidden = false;
  }

  /** The tabs fade out at an end that has more tilesets beyond it. */
  private paintTabEnds() {
    const tabs = this.tilesetTabs;
    tabs.classList.toggle("has-more-before", tabs.scrollLeft > 1);
    tabs.classList.toggle("has-more-after", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
  }

  private standalone() {
    for (const control of document.querySelectorAll<HTMLButtonElement>("button")) control.disabled = true;
    empty(this.layersList, "plug", "Not connected", "The layers are listed here once the editor is opened from the game.");
    this.sideEl.querySelector<HTMLElement>(".me-side-objects")!.hidden = true;
    this.statusEl.hidden = true;
    this.noteEl.hidden = true;
    const box = el("div");
    screen(box, "plug", "This window opens from the game", "Log in to the game as an admin and open the map editor from there. It stays connected to your game, and what you pick here is painted there.");
    this.showNote(box.firstElementChild!);
  }

  /** Until the game window sends the map: the shapes of what is loading. If nothing has come after a while, the page says so. */
  private waiting() {
    this.inited = false;
    this.layersList.replaceChildren();
    this.layersList.setAttribute("aria-busy", "true");
    for (let i = 0; i < 6; i++) this.layersList.appendChild(el("div", "tl-skeleton tl-skeleton-row"));
    this.objectsList.replaceChildren(el("div", "tl-skeleton tl-skeleton-row"), el("div", "tl-skeleton tl-skeleton-row"));
    const wait = el("div", "me-stage-wait");
    wait.setAttribute("aria-busy", "true");
    wait.append(el("p", "", "Waiting for the game window to send the map. It does so once it has synced it with the server."), el("div", "tl-skeleton"));
    this.showNote(wait);
    this.paintStatus();
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      this.layersList.removeAttribute("aria-busy");
      this.layersList.replaceChildren();
      empty(this.layersList, "plug", "Nothing to list", "The game window has not sent the map yet.");
      this.objectsList.replaceChildren();
      const box = el("div");
      const said = screen(box, "plug", "The game window is not answering", "Nothing has come back for the map editor yet. Check that your game is still connected and that your account may edit maps, then try again.");
      said.appendChild(button("Try again", () => {
        this.waiting();
        this.notifyReady();
      }, { icon: "refresh", kind: "primary" }));
      this.showNote(said);
    }, WAIT_MS);
  }

  /**
   * What the palette shows in place of a tileset it cannot draw: that the map
   * has none, that the picture of this one is on its way, or that it never
   * came. With a tileset to draw, the note is taken away.
   */
  private paintStage() {
    if (!this.inited) return;
    if (this.pictureTimer) clearTimeout(this.pictureTimer);
    this.pictureTimer = null;
    const tileset = this.tilesets[this.currentTilesetIndex];
    const image = this.tilesetImages[this.currentTilesetIndex];
    const name = tileset ? String(tileset.name || `Tileset ${this.currentTilesetIndex + 1}`) : "";
    this.legendEl.hidden = !tileset || this.getAnimatedTilesForTileset(tileset).size === 0;
    if (!tileset) {
      const box = el("div");
      this.showNote(empty(box, "image", "This map has no tilesets", "There is nothing to pick tiles from. Tilesets are added to the map file, on the asset server."));
      return;
    }
    if (image && image.complete) {
      this.pictureLate = false;
      this.hideNote();
      return;
    }
    const again = () => button("Ask the game window again", () => {
      // The game window sends everything again, which goes back to the first tileset: come back to this one after.
      this.wantedTileset = this.currentTilesetIndex;
      this.pictureLate = false;
      this.brokenImages.delete(this.currentTilesetIndex);
      this.paintStage();
      this.notifyReady();
    }, { icon: "refresh" });
    const box = el("div");
    if (this.brokenImages.has(this.currentTilesetIndex)) {
      const said = empty(box, "alert", `The picture of ${name} could not be read`, "The game window sent it, but it is not a picture this window can show.");
      said.appendChild(again());
      this.showNote(said);
    } else if (this.pictureLate) {
      const said = empty(box, "image", `The picture of ${name} has not arrived`, "The game window sends a tileset's picture once it has loaded it itself.");
      said.appendChild(again());
      this.showNote(said);
    } else {
      const wait = el("div", "me-stage-wait");
      wait.setAttribute("aria-busy", "true");
      wait.append(el("p", "", `Fetching the picture of ${name} from the game window.`), el("div", "tl-skeleton"));
      this.showNote(wait);
      this.pictureTimer = setTimeout(() => {
        this.pictureLate = true;
        this.paintStage();
      }, WAIT_MS);
    }
  }

  // ------------------------------------------- what the game window sends

  /** The name of the map being edited. The game window does not send it: it is read from where the game window keeps it. */
  private mapName(): string {
    try {
      const name = (window.opener as any)?.mapData?.name;
      return typeof name === "string" ? name : "";
    } catch {
      return "";
    }
  }

  private handleInit(msg: any) {
    this.inited = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.layersList.removeAttribute("aria-busy");

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

    // Back to the tileset that was in view when the game window was asked to send everything again.
    const wanted = this.wantedTileset;
    this.wantedTileset = null;
    if (wanted !== null && wanted > 0 && wanted < this.tilesets.length) this.selectTileset(wanted);

    const name = this.mapName();
    this.titleEl.textContent = name || "Map Editor";
    this.titleEl.title = name;
    document.title = name ? `${name} · Map Editor` : "Map Editor";
    this.paintStage();
    this.paintStatus();
    this.paintPicked();
  }

  private handleTilesetImage(msg: any) {
    const img = new Image();
    img.onload = () => {
      this.tilesetImages[msg.index] = img;
      this.brokenImages.delete(msg.index);
      if (msg.index === this.currentTilesetIndex) {
        this.drawTileset();
        this.paintStage();
      }
    };
    img.onerror = () => {
      this.brokenImages.add(msg.index);
      if (msg.index === this.currentTilesetIndex) this.paintStage();
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
    this.paintObjectMarks();
    this.paintStatus();
    this.saveAnswered();
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
    this.paintPicked();
  }

  // ------------------------------------------------------------------ tools

  private setEditButtonsLocked(locked: boolean): void {
    this.toolsOff = locked;
    this.pasteOff = locked;
    this.paintTools();
    this.paintStatus();
  }

  private updatePasteButtonState(): void {
    const isLocked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    this.pasteOff = this.selectedTile === null || isLocked || !!this.selectedObject;
    this.paintTools();
    this.paintStatus();
  }

  /** Why the tools are off, for the tooltip of each. */
  private whyOff(): string {
    if (this.selectedObject) return `${this.selectedObject} is selected: the tools work on tile layers. Select a layer to use them.`;
    if (this.selectedLayer && (this.layerLocked.get(this.selectedLayer) ?? false)) return `${this.selectedLayer} is locked. Unlock it to use the tools on it.`;
    return "The tools are off for what is selected. Select a layer to use them.";
  }

  /** Which tool is in use, and which can be picked now. */
  private paintTools(): void {
    for (const tool of TOOLS) {
      const btn = this.toolBtns.get(tool.id);
      if (!btn) continue;
      const checked = this.currentTool === tool.id;
      // Paste can do nothing without a tile, so it is off then too.
      const off = tool.id === 'paste' ? this.pasteOff || this.selectedTile === null : this.toolsOff;
      btn.setAttribute("aria-checked", String(checked));
      btn.disabled = off;
      btn.title = !off ? `${tool.does} (${tool.key})` : tool.id === 'paste' ? this.whyNoPaste() : this.whyOff();
    }
    // The tool in use is the one the Tab key lands on, or the first that can be used while it is off.
    const group = this.toolBtns.get("paint")?.parentElement;
    if (group) oneStop(group);
  }

  /** Why Paste is off: it has rules of its own on top of the other tools'. */
  private whyNoPaste(): string {
    const locked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
    if (this.toolsOff || this.selectedObject || locked) return this.whyOff();
    if (this.selectedTile === null) return "Nothing to paste yet: pick one tile first";
    // The tile was picked here, and the game window has said nothing since: the button waits for it, the key does not.
    return "Press V to paste the tile just picked. The button turns on when the game window next reports what is selected.";
  }

  private setupEventListeners() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));

    this.tilesetCanvas.addEventListener('mousedown', (e) => this.onTilesetMouseDown(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseup', (e) => this.onTilesetMouseUp(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));

    // Ctrl and the wheel change the size of the tiles, about the tile under the pointer.
    this.tilesetContainer.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const at = ZOOMS.indexOf(this.zoom) + (e.deltaY < 0 ? 1 : -1);
      if (at < 0 || at >= ZOOMS.length) return;
      const box = this.tilesetContainer.getBoundingClientRect();
      this.setZoom(ZOOMS[at], { x: e.clientX - box.left, y: e.clientY - box.top });
    }, { passive: false });
    // The palette is a surface to drag on: the browser's own menu has no place on it.
    this.tilesetContainer.addEventListener('contextmenu', (e) => e.preventDefault());
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
      this.save();
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
    this.paintTools();
    this.paintStatus();
  }

  /**
   * Save: the game window is asked to, as ever. It answers by saying the layers
   * have no unsaved edits left; when it says nothing, it did not save (it
   * shows why itself), and that is said here rather than left to be guessed.
   */
  private save() {
    this.send({ type: 'command', name: 'save' });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveBtn.classList.add("is-busy");
    this.saveBtn.setAttribute("aria-busy", "true");
    this.saveTimer = setTimeout(() => {
      this.saveDone();
      toast("The game window did not save the map.\nIt shows the reason itself: a warp that is not valid, or a save straight after another.", "error");
    }, SAVE_WAIT_MS);
  }

  private saveDone() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveBtn.classList.remove("is-busy");
    this.saveBtn.removeAttribute("aria-busy");
  }

  /** The game window sent the layers again: if a Save was waiting on that and nothing is unsaved now, it went through. */
  private saveAnswered() {
    if (!this.saveTimer || this.unsavedLayers.size > 0) return;
    this.saveDone();
    toast("Saved the map.");
  }

  // ----------------------------------------------------------------- status

  /** The top bar: the layer and the tool in use, and whether anything is unsaved. */
  private paintStatus(): void {
    const tool = TOOLS.find((t) => t.id === this.currentTool);
    const pills: HTMLElement[] = [];
    if (!this.inited) {
      if (window.opener) pills.push(pill("Waiting for the game window", "wait"));
    } else {
      const locked = this.selectedLayer ? (this.layerLocked.get(this.selectedLayer) ?? false) : false;
      let layer: HTMLElement;
      if (this.selectedObject) layer = this.statusPill(this.selectedObject, "info", OBJECTS.find((o) => o.type === this.selectedObject)?.glyph ?? "layers", "The object layer selected in the game window");
      else if (this.selectedLayer) layer = this.statusPill(locked ? `${this.selectedLayer} · locked` : this.selectedLayer, locked ? "warning" : "", locked ? "lock" : "layers", locked ? "The selected layer is locked: unlock it to paint on it" : "The layer the tools work on");
      else layer = this.statusPill("No layer selected", "", "layers", "Select a layer on the left to paint on it");
      layer.classList.add("me-pill-layer");
      pills.push(layer);
      if (tool) {
        const using = this.statusPill(tool.label, "", tool.glyph, `The tool in use: ${tool.does.charAt(0).toLowerCase()}${tool.does.slice(1)}`);
        using.classList.add("me-pill-tool");
        pills.push(using);
      }
      const unsaved = [...this.unsavedLayers];
      const saved = unsaved.length
        ? this.statusPill(count(unsaved.length, "layer") + " unsaved", "warning", "dot", `Not saved yet: ${unsaved.join(", ")}`)
        : this.statusPill("No unsaved edits", "", "check", "Everything painted has been saved");
      saved.classList.add("me-pill-saved");
      pills.push(saved);
      this.noteEl.textContent = `${count(this.layerData.length, "layer")} · ${count(this.tilesets.length, "tileset")}`;
    }
    this.noteEl.hidden = !this.inited;
    this.statusEl.replaceChildren(...pills);
    if (this.saveBtn) {
      this.saveBtn.classList.toggle("tl-btn-primary", this.unsavedLayers.size > 0);
      tooltip(this.saveBtn, this.unsavedLayers.size > 0 ? "Save the map (Ctrl+S)" : "Save the map (Ctrl+S). Nothing here is unsaved.");
    }
  }

  private statusPill(text: string, level: string, glyph: IconName | "dot", tip: string): HTMLElement {
    const node = pill(text, level, glyph);
    node.title = tip;
    return node;
  }

  // ----------------------------------------------------------------- layers

  private buildLayerList() {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".me-layer")?.dataset.layer;
    const which = (document.activeElement as HTMLElement | null)?.dataset.part;
    this.layersList.replaceChildren();
    this.layerCount.hidden = this.layerData.length === 0;
    this.layerCount.textContent = num(this.layerData.length);

    if (this.layerData.length === 0) {
      if (this.inited) empty(this.layersList, "layers", "No layers", "This map has no tile layers to paint on.");
      return;
    }

    this.layerData.forEach((layer: any) => {
      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');
      const isShadow = layer.name.toLowerCase().includes('shadow');

      if (!this.layerVisibility.has(layer.name)) {
        this.layerVisibility.set(layer.name, true);
      }
      if (!this.layerLocked.has(layer.name)) {
        this.layerLocked.set(layer.name, layer.locked ?? false);
      }

      const kind = isCollision ? { cls: "collision", glyph: "ban" as IconName, said: "Collision layer" }
        : isNoPvp ? { cls: "nopvp", glyph: "shield" as IconName, said: "No-PvP zone layer" }
        : isShadow ? { cls: "shadow", glyph: "moon" as IconName, said: "Shadow layer" }
        : { cls: "tiles", glyph: "layers" as IconName, said: "Tile layer" };

      const row = el("div", "tl-list-row me-layer");
      row.setAttribute("role", "listitem");
      row.dataset.layer = layer.name;
      row.dataset.kind = kind.said;

      const open = el("button", "tl-list-open");
      open.type = "button";
      open.dataset.part = "open";
      const kindMark = el("span", `me-kind me-kind-${kind.cls}`);
      kindMark.appendChild(icon(kind.glyph, 15));
      open.append(kindMark, el("span", "tl-list-name", layer.name));
      open.addEventListener('click', () => this.send({ type: 'layerSelect', layerName: layer.name }));

      const lock = iconButton("lock", "", () => {
        const newLocked = !(this.layerLocked.get(layer.name) ?? false);
        this.layerLocked.set(layer.name, newLocked);
        this.updateLayerListItem(layer.name);
        this.send({ type: 'layerLock', layerName: layer.name, locked: newLocked });
      }, { size: 15 });
      lock.classList.add("me-toggle");
      lock.dataset.part = "lock";
      const eye = iconButton("eye", "", () => {
        const newVisibility = !(this.layerVisibility.get(layer.name) ?? true);
        this.layerVisibility.set(layer.name, newVisibility);
        this.updateLayerListItem(layer.name);
        this.send({ type: 'layerToggle', layerName: layer.name, visible: newVisibility });
      }, { size: 15 });
      eye.classList.add("me-toggle");
      eye.dataset.part = "eye";
      const actions = el("span", "me-layer-actions");
      actions.append(lock, eye);

      row.append(open, actions);
      this.layersList.appendChild(row);
      this.paintLayerRow(row);
    });
    if (focused) this.layersList.querySelector<HTMLElement>(`.me-layer[data-layer="${CSS.escape(focused)}"] [data-part="${which ?? "open"}"]`)?.focus({ preventScroll: true });
  }

  /** How a layer's row stands: selected, locked, hidden, with unsaved edits. */
  private paintLayerRow(row: HTMLElement) {
    const name = row.dataset.layer ?? "";
    const isVisible = this.layerVisibility.get(name) ?? true;
    const isLocked = this.layerLocked.get(name) ?? false;
    const isUnsaved = this.unsavedLayers.has(name);
    const isActive = this.selectedLayer === name && !this.selectedObject;
    row.classList.toggle("is-selected", isActive);
    row.classList.toggle("is-locked", isLocked);
    row.classList.toggle("is-unseen", !isVisible);

    const open = row.querySelector<HTMLElement>(".tl-list-open")!;
    if (isActive) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
    const states = [row.dataset.kind, isLocked ? "locked" : "", isVisible ? "" : "hidden in the game window", isUnsaved ? "unsaved edits" : ""].filter(Boolean);
    open.title = `${name} (${states.join(", ")})`;
    open.querySelector(".me-unsaved")?.remove();
    if (isUnsaved) {
      const dot = el("span", "me-unsaved");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "unsaved edits");
      open.appendChild(dot);
    }

    const lock = row.querySelector<HTMLButtonElement>('[data-part="lock"]')!;
    setIcon(lock, isLocked ? "lock" : "unlock", 15);
    lock.classList.toggle("is-locked", isLocked);
    lock.setAttribute("aria-pressed", String(isLocked));
    lock.setAttribute("aria-label", isLocked ? `Unlock ${name}` : `Lock ${name}`);
    tooltip(lock, isLocked ? "Locked: nobody can paint on it. Click to unlock." : "Lock, so nobody paints on it");
    const eye = row.querySelector<HTMLButtonElement>('[data-part="eye"]')!;
    setIcon(eye, isVisible ? "eye" : "eyeOff", 15);
    eye.classList.toggle("is-unseen", !isVisible);
    eye.setAttribute("aria-pressed", String(!isVisible));
    eye.setAttribute("aria-label", isVisible ? `Hide ${name}` : `Show ${name}`);
    tooltip(eye, isVisible ? "Hide in my game window" : "Hidden in my game window. Click to show.");
  }

  private layerRows(): HTMLElement[] {
    return [...this.layersList.querySelectorAll<HTMLElement>('.me-layer')];
  }

  private updateLayerListItem(layerName: string) {
    for (const row of this.layerRows()) {
      if (row.dataset.layer === layerName) this.paintLayerRow(row);
    }
    this.paintStatus();
  }

  private updateLayerSelection() {
    for (const row of this.layerRows()) this.paintLayerRow(row);
    this.paintStatus();
  }

  private buildObjectList() {
    this.objectsList.replaceChildren();

    OBJECTS.forEach(({ type, glyph }) => {
      if (!this.objectLayerVisibility.has(type)) {
        this.objectLayerVisibility.set(type, true);
      }

      const row = el("div", "tl-list-row me-layer");
      row.setAttribute("role", "listitem");
      row.dataset.object = type;

      const open = el("button", "tl-list-open");
      open.type = "button";
      const kindMark = el("span", "me-kind me-kind-object");
      kindMark.appendChild(icon(glyph, 15));
      open.append(kindMark, el("span", "tl-list-name", type));
      open.addEventListener('click', () => this.send({ type: 'objectSelect', objectType: type }));

      const eye = iconButton("eye", "", () => {
        const newVisibility = !(this.objectLayerVisibility.get(type) ?? true);
        this.objectLayerVisibility.set(type, newVisibility);
        this.updateObjectListItem(type);
        this.send({ type: 'objectToggle', objectType: type, visible: newVisibility });
      }, { size: 15 });
      eye.classList.add("me-toggle");
      const actions = el("span", "me-layer-actions");
      actions.appendChild(eye);

      row.append(open, actions);
      this.objectsList.appendChild(row);
      this.paintObjectRow(row);
    });
  }

  private paintObjectRow(row: HTMLElement) {
    const type = row.dataset.object ?? "";
    const isVisible = this.objectLayerVisibility.get(type) ?? true;
    const isUnsaved = this.unsavedLayers.has(type);
    const isActive = this.selectedObject === type;
    row.classList.toggle("is-selected", isActive);
    row.classList.toggle("is-unseen", !isVisible);
    const open = row.querySelector<HTMLElement>(".tl-list-open")!;
    if (isActive) open.setAttribute("aria-current", "true");
    else open.removeAttribute("aria-current");
    open.title = `${type}: select to place, move and remove them in the game window${isUnsaved ? " (unsaved edits)" : ""}`;
    open.querySelector(".me-unsaved")?.remove();
    if (isUnsaved) {
      const dot = el("span", "me-unsaved");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", "unsaved edits");
      open.appendChild(dot);
    }
    const eye = row.querySelector<HTMLButtonElement>(".me-toggle")!;
    setIcon(eye, isVisible ? "eye" : "eyeOff", 15);
    eye.classList.toggle("is-unseen", !isVisible);
    eye.setAttribute("aria-pressed", String(!isVisible));
    eye.setAttribute("aria-label", isVisible ? `Hide ${type}` : `Show ${type}`);
    tooltip(eye, isVisible ? "Hide in my game window" : "Hidden in my game window. Click to show.");
  }

  private objectRows(): HTMLElement[] {
    return [...this.objectsList.querySelectorAll<HTMLElement>('.me-layer')];
  }

  private updateObjectListItem(type: string) {
    for (const row of this.objectRows()) {
      if (row.dataset.object === type) this.paintObjectRow(row);
    }
  }

  private updateObjectSelection() {
    for (const row of this.objectRows()) this.paintObjectRow(row);
    this.paintStatus();
  }

  /** The object layers have unsaved edits of their own, which arrive with the tile layers'. */
  private paintObjectMarks() {
    for (const row of this.objectRows()) this.paintObjectRow(row);
  }

  // ---------------------------------------------------------------- tilesets

  private buildTilesetTabs() {
    this.tilesetTabs.replaceChildren();

    this.tilesets.forEach((tileset: any, index: number) => {
      const tabName = tileset.name || `Tileset ${index + 1}`;
      const tab = el("button", "tl-tab");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.appendChild(el("span", "", tabName));
      tab.title = tabName;
      tab.addEventListener('click', () => this.selectTileset(index));
      this.tilesetTabs.appendChild(tab);
    });
    this.paintTabEnds();

    if (this.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;

    const tabs = this.tilesetTabs.querySelectorAll<HTMLElement>('.tl-tab');
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      if (i === index) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    });

    this.drawTileset();
    this.send({ type: 'tilesetSelect', index });
    this.pictureLate = false;
    this.paintStage();
    this.paintPicked();
  }

  /** Show the tiles `zoom` times their size. With a point of the palette given, the tile under it stays under it. */
  private setZoom(zoom: number, about?: { x: number; y: number }) {
    const box = this.tilesetContainer;
    const pad = this.tilesetCanvas.offsetLeft;
    const at = about ?? { x: box.clientWidth / 2, y: box.clientHeight / 2 };
    const tileX = (box.scrollLeft + at.x - pad) / this.zoom;
    const tileY = (box.scrollTop + at.y - pad) / this.zoom;
    this.zoom = zoom;
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // No storage here: the size is kept for this visit only.
    }
    for (const item of this.zoomSeg.querySelectorAll<HTMLElement>('[role="radio"]')) item.setAttribute("aria-checked", String(item.dataset.value === String(zoom)));
    oneStop(this.zoomSeg);
    this.sizeCanvas();
    box.scrollLeft = tileX * zoom + pad - at.x;
    box.scrollTop = tileY * zoom + pad - at.y;
  }

  /** How large the canvas is shown: its own pixels, each `zoom` across. What is drawn on it does not change. */
  private sizeCanvas() {
    this.tilesetCanvas.style.width = `${this.tilesetCanvas.width * this.zoom}px`;
    this.tilesetCanvas.style.height = `${this.tilesetCanvas.height * this.zoom}px`;
  }

  // --- Tileset Canvas Rendering ---

  private drawTileset() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    const image = this.tilesetImages[this.currentTilesetIndex];

    if (!tileset || !image || !image.complete) return;

    const scale = 1;
    this.tilesetCanvas.width = tileset.imagewidth * scale;
    this.tilesetCanvas.height = tileset.imageheight * scale;
    this.sizeCanvas();

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

  // ------------------------------------------- what is picked, in words

  /** Which tileset a tile belongs to, and where it is in it. */
  private placeOf(tileId: number): { tileset: any; column: number; row: number } | null {
    const base = tileId & 0x0FFFFFFF;
    for (const tileset of this.tilesets) {
      if (base < tileset.firstgid || base >= tileset.firstgid + tileset.tilecount) continue;
      const perRow = Math.max(1, Math.floor(tileset.imagewidth / tileset.tilewidth));
      const local = base - tileset.firstgid;
      return { tileset, column: local % perRow, row: Math.floor(local / perRow) };
    }
    return null;
  }

  /** How a picked tile has been turned with Rotate, from the marks the map format keeps on it. */
  private turnOf(tileId: number): string {
    const flags = (tileId & 0xE0000000) >>> 0;
    return flags === 0 ? "" : flags === 0xA0000000 ? ", turned a quarter" : flags === 0xC0000000 ? ", turned a half" : flags === 0x60000000 ? ", turned three quarters" : ", flipped";
  }

  /** Under the palette: what is picked to paint with. */
  private paintPicked() {
    let said: string;
    let none = false;
    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const w = Math.abs(this.selectionEndTile.x - this.selectionStartTile.x) + 1;
      const h = Math.abs(this.selectionEndTile.y - this.selectionStartTile.y) + 1;
      said = w * h === 1 ? "Picking 1 tile" : `Picking ${num(w)} × ${num(h)} tiles`;
    } else if (this.selectedTiles.length > 0 && this.selectedTiles[0].length > 0) {
      const h = this.selectedTiles.length;
      const w = this.selectedTiles[0].length;
      const first = this.selectedTiles[0][0];
      const place = this.placeOf(first);
      const from = this.selectedTilesFromMap ? " from the map" : place ? ` from ${place.tileset.name || "the tileset"}` : "";
      if (w * h === 1) said = `Picked: 1 tile${from}${place && !this.selectedTilesFromMap ? `, column ${num(place.column + 1)}, row ${num(place.row + 1)}` : ""}${this.turnOf(first)}`;
      else said = `Picked: ${num(w)} × ${num(h)} tiles${from}${this.selectedTilesFromMap && first ? this.turnOf(first) : ""}`;
    } else if (this.selectedTile) {
      const place = this.placeOf(this.selectedTile);
      said = `Picked: 1 tile${place ? ` from ${place.tileset.name || "the tileset"}, column ${num(place.column + 1)}, row ${num(place.row + 1)}` : ""}${this.turnOf(this.selectedTile)}`;
    } else {
      said = "Nothing picked. Click a tile, or drag across several.";
      none = true;
    }
    this.pickedEl.classList.toggle("is-none", none);
    this.pickedEl.replaceChildren(el("span", "", said));
    this.pickedEl.title = said;
    this.paintUnder();
  }

  /** Under the palette, at the end: the tile under the pointer, or how large the tileset is. */
  private paintUnder() {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return void (this.underEl.textContent = "");
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);
    const at = this.hoveredTilesetPos;
    if (at && at.x >= 0 && at.y >= 0 && at.x < cols && at.y < rows) this.underEl.textContent = `Column ${num(at.x + 1)}, row ${num(at.y + 1)}`;
    else this.underEl.textContent = `${num(cols)} × ${num(rows)} tiles of ${num(tileset.tilewidth)} px`;
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

    // (the canvas is shown `zoom` times its size: a point on screen is that many times further in than the tile it is on)
    const x = (e.clientX - rect.left) / this.zoom;
    const y = (e.clientY - rect.top) / this.zoom;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    this.isSelectingTiles = true;
    this.selectionStartTile = { x: tileX, y: tileY };
    this.selectionEndTile = { x: tileX, y: tileY };

    this.drawTileset();
    this.paintPicked();
  }

  private onTilesetMouseUp(_e: MouseEvent) {
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
    this.paintTools();
    this.paintPicked();
  }

  private onTilesetMouseMove(e: MouseEvent) {
    const tileset = this.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoom;
    const y = (e.clientY - rect.top) / this.zoom;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    if (this.isSelectingTiles) {
      this.selectionEndTile = { x: tileX, y: tileY };
      this.drawTileset();
      this.paintPicked();
      return;
    }

    if (!this.hoveredTilesetPos || this.hoveredTilesetPos.x !== tileX || this.hoveredTilesetPos.y !== tileY) {
      this.hoveredTilesetPos = { x: tileX, y: tileY };
      this.drawTileset();
      this.paintUnder();
    }
  }

  private onTilesetMouseLeave() {
    if (this.isSelectingTiles) {
      this.isSelectingTiles = false;
      this.drawTileset();
      this.paintPicked();
    }

    if (this.hoveredTilesetPos) {
      this.hoveredTilesetPos = null;
      this.drawTileset();
      this.paintUnder();
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
    this.tilesetContainer.classList.add("is-panning");
  }

  private onTilesetPan(e: MouseEvent) {
    if (!this.isPanningTileset) return;
    e.preventDefault();
    const deltaX = e.clientX - this.tilesetPanStartX;
    const deltaY = e.clientY - this.tilesetPanStartY;
    this.tilesetContainer.scrollLeft = this.tilesetScrollStartX - deltaX;
    this.tilesetContainer.scrollTop = this.tilesetScrollStartY - deltaY;
  }

  private onTilesetPanEnd(_e: MouseEvent) {
    if (!this.isPanningTileset) return;
    this.isPanningTileset = false;
    this.tilesetContainer.classList.remove("is-panning");
  }
}

new TileEditorBridge();
