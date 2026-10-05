// Game-window half of the player editor: owns the popup window and relays its
// messages to the server. It opens on one player, from /player edit or from
// the player context menu; the editor has no in-world tools.
import { sendRequest } from "./socket.js";
import { config } from "../web/global.js";

const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;

class PlayerEditor {
  public isActive = false;

  private editorWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;

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

  /** Open the editor on a player: a username, or the id of one on screen. An open editor switches to them. */
  open(target: string): void {
    if (!this.editorWindow || this.editorWindow.closed) {
      const url = window.location.origin + "/player-editor";
      // The size the editor's workbench is laid out for, where the screen allows, in the middle of the screen.
      const area = window.screen as Screen & { availLeft?: number; availTop?: number };
      const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
      const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
      const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2));
      const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
      this.editorWindow = window.open(url, "PlayerEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
      if (!this.editorWindow) {
        this.isActive = false;
        return;
      }
      this.isActive = true;
      this.bridgeReady = false;
      this.queue = [];
      this.closeWatcher = setInterval(() => {
        if (this.editorWindow?.closed) this.close();
      }, 500);
    } else {
      this.editorWindow.focus();
    }
    sendRequest({ type: "PLAYER_EDITOR_LOAD", data: { target } });
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
    // The popup builds icon URLs itself: the server sends icon names.
    this.toEditor({ type: "data", data: { ...data, assetServerUrl: config.ASSET_SERVER_URL } });
  }

  onResults(data: any): void {
    this.toEditor({ type: "results", data });
  }

  onResult(data: any): void {
    this.toEditor({ type: "result", ...data });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    if (event.source !== this.editorWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.editorWindow?.postMessage(queued, "*");
        break;
      case "request":
        // Only this editor's packets; the server re-checks permission on every one.
        if (typeof msg.packet === "string" && msg.packet.startsWith("PLAYER_EDITOR_")) {
          sendRequest({ type: msg.packet, data: msg.data });
        }
        break;
      case "editorClosed":
        this.close();
        break;
    }
  }
}

const playerEditor = new PlayerEditor();
export default playerEditor;
