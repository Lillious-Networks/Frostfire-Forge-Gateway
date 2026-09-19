// Game-window half of the creature editor: owns the popup window, relays its
// messages to the server, and provides the in-world tools (spawn placement,
// patrol drawing, context menu, debug overlay).
import { sendRequest, getIsLoaded } from "./socket.js";
import { getCameraX, getCameraY } from "./renderer.js";
import { canvas } from "./ui.js";
import Cache from "./cache.js";
import { creatureAt } from "./creature.js";
import { config } from "../web/global.js";

/**
 * The game server sends asset paths, not URLs: it reaches the asset server on an
 * internal address the browser cannot resolve. Prefix them with the asset server
 * this client was configured with.
 */
function withAssetUrls<T>(value: T): T {
  if (typeof value === "string") {
    return (value.startsWith("/") ? `${config.ASSET_SERVER_URL}${value}` : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(withAssetUrls) as unknown as T;
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [key, entry] of Object.entries(value)) out[key] = withAssetUrls(entry);
    return out;
  }
  return value;
}

const cache = Cache.getInstance();

export interface DebugCreature {
  id: number;
  spawnId: number;
  state: string;
  home: { x: number; y: number };
  combatStart: { x: number; y: number } | null;
  radii: { aggro: number; assist: number; callForHelp: number; leash: number; wander: number };
  path: Array<{ x: number; y: number }>;
  victimId: string | null;
  threat: Array<{ unitId: string; name: string; threat: number; pctOfVictim: number }>;
}

type ToolMode = "none" | "placeSpawn" | "drawPath";

class CreatureEditor {
  public isActive = false;
  public mode: ToolMode = "none";
  public debugCreatures: DebugCreature[] = [];
  public debugOn = false;
  public pathPoints: Array<{ x: number; y: number; wait_ms: number }> = [];

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    document.addEventListener("click", (e) => this.onWorldClick(e), true);
    document.addEventListener("keydown", (e) => this.onKeyDown(e));
    // The game page is going away (refresh, close, navigation): take the
    // popup with it, since the reloaded page has no link back to it. Only the
    // window is closed here - the connection is closing too.
    window.addEventListener("pagehide", () => {
      try {
        if (this.editorWindow && !this.editorWindow.closed) this.editorWindow.close();
      } catch {
        // Window already gone.
      }
    });
  }

  toggle(): void {
    if (this.isActive) this.close();
    else this.open();
  }

  private open(): void {
    this.isActive = true;
    const url = window.location.origin + "/creature-editor";
    this.editorWindow = window.open(url, "CreatureEditor", "width=1150,height=780,left=100,top=60,location=no,toolbar=no,menubar=no,status=no");
    this.bridgeReady = false;
    sendRequest({ type: "CREATURE_EDITOR_LIST", data: null });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
    }, 500);
  }

  close(): void {
    this.isActive = false;
    this.mode = "none";
    this.pathPoints = [];
    this.setDebug(false);
    if (this.closeWatcher) {
      clearInterval(this.closeWatcher);
      this.closeWatcher = null;
    }
    try {
      this.editorWindow?.close();
    } catch {
      // Window already gone.
    }
    this.editorWindow = null;
    sendRequest({ type: "CREATURE_EDITOR_CLOSE", data: null });
  }

  private toEditor(msg: any): void {
    if (!this.editorWindow || this.editorWindow.closed) return;
    if (!this.bridgeReady) {
      this.queue.push(msg);
      return;
    }
    this.editorWindow.postMessage(msg, "*");
  }

  // -------------------------------------------------------- server messages

  onData(data: any): void {
    this.lastData = withAssetUrls(data);
    this.toEditor({ type: "data", data: this.lastData });
  }

  onResult(data: any): void {
    this.toEditor({ type: "result", ...data });
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  onDebug(data: any): void {
    this.debugCreatures = Array.isArray(data?.creatures) ? data.creatures : [];
  }

  /** Spawn points on the player's current map, for the placement overlay. */
  spawnsOnMap(map: string): any[] {
    return (this.lastData?.spawns ?? []).filter((s: any) => s.map === map);
  }

  templateName(id: number): string {
    return this.lastData?.templates?.find((t: any) => t.id === id)?.name ?? `#${id}`;
  }

  private setDebug(on: boolean): void {
    this.debugOn = on;
    if (!on) this.debugCreatures = [];
    sendRequest({ type: "CREATURE_DEBUG_SUBSCRIBE", data: { on } });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.editorWindow?.postMessage(queued, "*");
        if (this.lastData) this.toEditor({ type: "data", data: this.lastData });
        break;
      case "editorClosed":
        this.close();
        break;
      case "request":
        sendRequest({ type: msg.packet, data: msg.data });
        break;
      case "debug":
        this.setDebug(!!msg.on);
        break;
      case "placeSpawn":
        this.mode = "placeSpawn";
        document.body.style.cursor = "crosshair";
        break;
      case "drawPath":
        this.mode = "drawPath";
        this.pathPoints = Array.isArray(msg.points) ? [...msg.points] : [];
        document.body.style.cursor = "crosshair";
        break;
    }
  }

  // ------------------------------------------------------------ world input

  private worldFromEvent(event: MouseEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    let mapCenterOffsetX = 0;
    if (window.mapData) {
      const mapWidth = window.mapData.width * window.mapData.tilewidth;
      if (mapWidth < window.innerWidth) mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
    }
    return {
      x: Math.round(event.clientX - rect.left - window.innerWidth / 2 + getCameraX() - mapCenterOffsetX),
      y: Math.round(event.clientY - rect.top - window.innerHeight / 2 + getCameraY()),
    };
  }

  private currentMap(): string {
    return String(window.mapData?.name ?? "").replace(".json", "");
  }

  private onWorldClick(event: MouseEvent): void {
    if (!this.isActive || this.mode === "none" || !getIsLoaded()) return;
    if ((event.target as HTMLElement)?.closest?.(".ui")) return;
    event.stopPropagation();
    event.preventDefault();
    const point = this.worldFromEvent(event);

    if (this.mode === "placeSpawn") {
      this.toEditor({ type: "pointPicked", what: "spawn", x: point.x, y: point.y, map: this.currentMap() });
      this.mode = "none";
      document.body.style.cursor = "";
      return;
    }
    // drawPath: shift-click adds a 2s wait at the new point.
    this.pathPoints.push({ x: point.x, y: point.y, wait_ms: event.shiftKey ? 2000 : 0 });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.isActive || this.mode === "none") return;
    if (event.key === "Escape") {
      this.mode = "none";
      this.pathPoints = [];
      document.body.style.cursor = "";
      return;
    }
    if (event.key === "Enter" && this.mode === "drawPath") {
      this.toEditor({ type: "pointPicked", what: "path", points: this.pathPoints, map: this.currentMap() });
      this.mode = "none";
      document.body.style.cursor = "";
    }
  }

  /** Right-click actions on a creature while the editor is open. */
  creatureAction(worldX: number, worldY: number): boolean {
    if (!this.isActive) return false;
    const creature = creatureAt(worldX, worldY);
    if (!creature) return false;
    const choice = prompt(`${creature.name} (#${creature.id})\n1 = kill, 2 = reset (evade), 3 = respawn now`, "1");
    if (choice === "1") sendRequest({ type: "CREATURE_EDITOR_ACTION", data: { action: "kill", creatureId: creature.id } });
    else if (choice === "2") sendRequest({ type: "CREATURE_EDITOR_ACTION", data: { action: "reset", creatureId: creature.id } });
    else if (choice === "3") sendRequest({ type: "CREATURE_EDITOR_ACTION", data: { action: "respawn", creatureId: creature.id } });
    return true;
  }

  targetedThreat(): DebugCreature | null {
    const targetId = typeof cache.targetId === "string" && cache.targetId.startsWith("c:") ? Number(cache.targetId.slice(2)) : null;
    if (targetId === null) return null;
    return this.debugCreatures.find((c) => c.id === targetId) ?? null;
  }
}

const creatureEditor = new CreatureEditor();
export default creatureEditor;
