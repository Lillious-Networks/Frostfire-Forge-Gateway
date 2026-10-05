// Game-window half of the spell editor: owns the popup window and relays its
// messages to the server. Mirrors itemeditor.ts; the spell editor has no
// in-world tools.
import { sendRequest } from "./socket.js";
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

const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;

class SpellEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;
  private lastData: any = null;

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    // The game page is going away (refresh, close, navigation): take the
    // popup with it, since the reloaded page has no link back to it.
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
    const url = window.location.origin + "/spell-editor";
    // The size the editor's workbench is laid out for, where the screen allows, in the middle of the screen
    // and a step down and right of the item editor, so one does not open exactly over the other.
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2)) + 20;
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2)) + 20;
    this.editorWindow = window.open(url, "SpellEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    sendRequest({ type: "SPELL_EDITOR_LIST", data: null });
    this.closeWatcher = setInterval(() => {
      if (this.editorWindow?.closed) this.close();
    }, 500);
  }

  close(): void {
    this.isActive = false;
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
    this.bridgeReady = false;
    this.queue = [];
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
    // Only the icon list holds asset paths. The popup builds icon URLs itself
    // for spells whose icon is not in the list.
    this.lastData = { ...data, icons: withAssetUrls(data?.icons ?? []), assetServerUrl: config.ASSET_SERVER_URL };
    this.toEditor({ type: "data", data: this.lastData });
  }

  onResults(data: any): void {
    // Spells carry icon names, not paths: nothing to prefix.
    this.toEditor({ type: "results", data });
  }

  onResult(data: any): void {
    this.toEditor({ type: "result", ...data });
  }

  onUpdated(data: any): void {
    this.toEditor({ type: "updated", by: data?.by ?? "someone" });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    // Every editor's popup posts to this same window. Only this editor's own
    // popup is listened to, or each request of another editor would be sent
    // to the server a second time from here.
    if (!this.editorWindow || event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.editorWindow?.postMessage(queued, "*");
        if (this.lastData) this.toEditor({ type: "data", data: this.lastData });
        break;
      case "request":
        // Only spell editor packets leave from here; the server re-checks
        // permission on every one of them.
        if (typeof msg.packet === "string" && msg.packet.startsWith("SPELL_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const spellEditor = new SpellEditor();
export default spellEditor;
