// Game-window half of the weather editor: owns the popup window and relays its
// messages to the server. Mirrors spelleditor.ts; the weather editor has no
// in-world tools, and nothing it is sent holds an asset path.
import { sendRequest } from "./socket.js";

// The spell editor's size: narrower than 1240 and the summary beside the form drops under it.
const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;

class WeatherEditor {
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
    const url = window.location.origin + "/weather-editor";
    // The size the editor's workbench is laid out for, where the screen allows, in the middle of the screen
    // and two steps down and right of the item editor, so one does not open exactly over another.
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2)) + 40;
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2)) + 40;
    this.editorWindow = window.open(url, "WeatherEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    this.lastData = null;
    sendRequest({ type: "WEATHER_EDITOR_LIST", data: null });
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
    this.lastData = data;
    this.toEditor({ type: "data", data });
  }

  onResult(data: any): void {
    // Every answer to a change carries the weathers as they then stand.
    if (data?.data) this.lastData = data.data;
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
        // What was sent before the popup could listen: the newest list stands for all of it, the rest follows.
        if (this.lastData) this.editorWindow?.postMessage({ type: "data", data: this.lastData }, "*");
        for (const queued of this.queue.splice(0)) {
          if (queued.type !== "data") this.editorWindow?.postMessage(queued, "*");
        }
        break;
      case "request":
        // Only weather editor packets leave from here; the server re-checks
        // permission on every one of them.
        if (typeof msg.packet === "string" && msg.packet.startsWith("WEATHER_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const weatherEditor = new WeatherEditor();
export default weatherEditor;
