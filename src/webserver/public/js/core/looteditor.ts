const EDITOR_WIDTH = 1280;
const EDITOR_HEIGHT = 820;

class LootEditor {
  public isActive: boolean = false;
  private tables: any[] = [];
  private selectedTableId: number | null = null;
  private editorWindow: Window | null = null;
  private bridgeReady: boolean = false;
  private messageQueue: any[] = [];
  private windowCloseInterval: ReturnType<typeof setInterval> | null = null;

  public toggle() { if (this.isActive) { this.closeEditor(); } else { this.openEditor(); } }

  private openEditor() {
    this.isActive = true;
    // The size the editor's workbench is laid out for, where the screen allows, in the middle of the screen.
    const area = window.screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.min(EDITOR_WIDTH, area.availWidth - 40);
    const height = Math.min(EDITOR_HEIGHT, area.availHeight - 80);
    const left = (area.availLeft ?? 0) + Math.max(0, Math.round((area.availWidth - width) / 2));
    const top = (area.availTop ?? 0) + Math.max(0, Math.round((area.availHeight - height) / 2));
    this.editorWindow = window.open(window.location.origin + "/loot-editor", "LootEditor", `width=${width},height=${height},left=${left},top=${top},location=no,toolbar=no,menubar=no,status=no`);
    if (!this.editorWindow) { this.isActive = false; return; }
    this.windowCloseInterval = setInterval(() => { if (this.editorWindow && this.editorWindow.closed) this.onWindowClosed(); }, 500);
    window.addEventListener("message", this.onBridgeMessage);
    window.addEventListener("beforeunload", this.onPageUnload);
    this.loadTables();
  }

  private onPageUnload = () => { this.closeEditor(); };

  private closeEditor() {
    this.isActive = false;
    if (this.editorWindow && !this.editorWindow.closed) { this.editorWindow.postMessage({ type: "close" }, "*"); this.editorWindow.close(); }
    this.editorWindow = null; this.bridgeReady = false; this.messageQueue = [];
    if (this.windowCloseInterval) { clearInterval(this.windowCloseInterval); this.windowCloseInterval = null; }
    window.removeEventListener("message", this.onBridgeMessage);
    window.removeEventListener("beforeunload", this.onPageUnload);
  }

  private onWindowClosed() {
    if (this.windowCloseInterval) { clearInterval(this.windowCloseInterval); this.windowCloseInterval = null; }
    this.editorWindow = null; this.bridgeReady = false; this.messageQueue = []; this.isActive = false;
    window.removeEventListener("message", this.onBridgeMessage);
    window.removeEventListener("beforeunload", this.onPageUnload);
  }

  private sendToEditor(msg: any) {
    if (this.bridgeReady && this.editorWindow) { this.editorWindow.postMessage(msg, "*"); }
    else { this.messageQueue.push(msg); }
  }

  private markBridgeReady() {
    if (!this.bridgeReady) { this.bridgeReady = true; while (this.messageQueue.length) this.editorWindow!.postMessage(this.messageQueue.shift()!, "*"); }
  }

  private getItemCache(): Map<string, any> {
    return (window as any).itemsByName || new Map();
  }

  private syncToBridge() {
    this.sendToEditor({ type: "init", tables: this.tables, selectedTableId: this.selectedTableId, selectedTable: this.tables.find((t: any) => t.id === this.selectedTableId) || null, itemCache: this.getItemCache() });
  }

  private onBridgeMessage = (e: MessageEvent) => {
    if (!this.editorWindow || e.source !== this.editorWindow) return;
    this.markBridgeReady();
    const msg = e.data;
    if (msg.type === "bridgeReady") { this.syncToBridge(); return; }
    switch (msg.type) {
      case "selectTable": { const t = this.tables.find((x: any) => x.id === msg.id); if (t) { this.selectedTableId = t.id; this.sendToEditor({ type: "tableSelectUpdate", table: t }); } break; }
      // A change to the tables: the server checks it, makes it, and answers with LOOT_EDITOR_RESULT.
      case "request": { this.sendToServer(msg.packet, msg.data); break; }
      case "refresh": { this.loadTables(); break; }
      case "editorClosed": { this.onWindowClosed(); break; }
    }
  };

  private sendToServer(type: string, data: any) { const sr = (window as any).sendRequest; if (sr) sr({ type, data }); }

  private loadTables() { this.sendToServer("LIST_LOOT_TABLES", null); }

  public handleTableList(tables: any[]) {
    this.tables = tables || [];
    if (this.isActive && this.editorWindow) {
      this.sendToEditor({ type: "tableListUpdate", tables: this.tables, itemCache: this.getItemCache() });
    }
  }

  /** The server's answer to a change: whether it was made, why not when it was not, and the tables as they now stand. */
  public handleResult(result: any) {
    if (Array.isArray(result?.tables)) this.tables = result.tables;
    if (this.selectedTableId !== null && !this.tables.some((t: any) => t.id === this.selectedTableId)) this.selectedTableId = null;
    if (this.isActive && this.editorWindow) {
      this.sendToEditor({ ...result, type: "result", itemCache: this.getItemCache() });
    }
  }
}

const instance = new LootEditor();
(window as any).lootEditor = instance;
export default instance;
