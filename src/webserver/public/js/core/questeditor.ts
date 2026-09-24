// Game-window half of the quest editor: owns the popup window and relays its
// messages to the server. Mirrors itemeditor.ts.
import { sendRequest } from "./socket.js";
import { config } from "../web/global.js";

class QuestEditor {
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
    const url = window.location.origin + "/quest-editor";
    this.editorWindow = window.open(url, "QuestEditor", "width=1100,height=780,left=110,top=70,location=no,toolbar=no,menubar=no,status=no");
    if (!this.editorWindow) {
      this.isActive = false;
      return;
    }
    this.bridgeReady = false;
    sendRequest({ type: "QUEST_EDITOR_DATA", data: null });
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
    // The popup builds icon URLs itself from item names.
    this.lastData = { ...data, assetServerUrl: config.ASSET_SERVER_URL };
    this.toEditor({ type: "data", data: this.lastData });
  }

  onResults(data: any): void {
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
    if (event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.editorWindow?.postMessage(queued, "*");
        if (this.lastData) this.toEditor({ type: "data", data: this.lastData });
        break;
      case "request":
        // The server re-checks permission on every one of these.
        sendRequest({ type: msg.packet, data: msg.data });
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const questEditor = new QuestEditor();
export default questEditor;
