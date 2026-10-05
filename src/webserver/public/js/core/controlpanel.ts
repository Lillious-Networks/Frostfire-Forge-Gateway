// Game-window half of the server control panel: owns the popup window and
// relays its messages to the server. The panel stands in for the admin chat
// commands and opens from /cp (or /controlpanel). It has no in-world tools of
// its own.
import { sendRequest } from "./socket.js";

/** The size the dashboard is laid out for, where the screen has the room. */
const PANEL_WIDTH = 1440;
const PANEL_HEIGHT = 900;

class ControlPanel {
  public isActive = false;

  private panelWindow: Window | null = null;
  private bridgeReady = false;
  private queue: any[] = [];
  private closeWatcher: ReturnType<typeof setInterval> | null = null;

  constructor() {
    window.addEventListener("message", (e) => this.onBridgeMessage(e));
    // The game page is going away (refresh, close, navigation): take the
    // popup with it, since the reloaded page has no link back to it.
    window.addEventListener("pagehide", () => {
      try {
        if (this.panelWindow && !this.panelWindow.closed) this.panelWindow.close();
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
    const url = window.location.origin + "/control-panel";
    // As large as the dashboard wants, no larger than the screen, in the middle of it.
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(PANEL_WIDTH, area.availWidth - 40);
    const height = Math.min(PANEL_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2));
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
    this.panelWindow = window.open(url, "ControlPanel", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.panelWindow) {
      this.isActive = false;
      return;
    }
    // The popup asks for what it shows once it has loaded.
    this.bridgeReady = false;
    this.queue = [];
    this.closeWatcher = setInterval(() => {
      if (this.panelWindow?.closed) this.close();
    }, 500);
  }

  close(): void {
    this.isActive = false;
    if (this.closeWatcher) {
      clearInterval(this.closeWatcher);
      this.closeWatcher = null;
    }
    try {
      this.panelWindow?.close();
    } catch {
      // Window already gone.
    }
    this.panelWindow = null;
    this.bridgeReady = false;
    this.queue = [];
  }

  private toPanel(msg: any): void {
    if (!this.panelWindow || this.panelWindow.closed) return;
    if (!this.bridgeReady) {
      this.queue.push(msg);
      return;
    }
    this.panelWindow.postMessage(msg, "*");
  }

  // -------------------------------------------------------- server messages

  onData(data: any): void {
    this.toPanel({ type: "data", data });
  }

  onResults(data: any): void {
    this.toPanel({ type: "results", data });
  }

  onResult(data: any): void {
    this.toPanel({ type: "result", ...data });
  }

  private onBridgeMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!msg?.type) return;
    // Every admin window posts to this same window. Only the control panel's
    // own popup is listened to, or each request of an editor would be sent
    // to the server a second time from here.
    if (!this.panelWindow || event.source !== this.panelWindow) return;
    switch (msg.type) {
      case "bridgeReady":
        this.bridgeReady = true;
        for (const queued of this.queue.splice(0)) this.panelWindow.postMessage(queued, "*");
        break;
      case "request":
        // Only control panel packets leave from here; the server checks who
        // is asking, and each action's own permission, on every one of them.
        if (typeof msg.packet === "string" && msg.packet.startsWith("CONTROL_PANEL_")) {
          sendRequest({ type: msg.packet, data: msg.data });
        }
        break;
      case "panelClosed":
        this.close();
        break;
    }
  }
}

const controlPanel = new ControlPanel();
export default controlPanel;
