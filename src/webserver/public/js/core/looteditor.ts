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
    this.editorWindow = window.open(window.location.origin + "/loot-editor", "LootEditor", "width=900,height=650,left=120,top=80,location=no,toolbar=no,menubar=no,status=no");
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
    const sr = (window as any).sendRequest;
    switch (msg.type) {
      case "selectTable": { const t = this.tables.find((x: any) => x.id === msg.id); if (t) { this.selectedTableId = t.id; this.sendToEditor({ type: "tableSelectUpdate", table: t }); } break; }
      case "createTable": { if (sr && msg.name) sr({ type: "COMMAND", data: { command: `loottable create "${msg.name}"` } }); setTimeout(() => this.loadTables(), 300); break; }
      case "deleteTable": { if (sr && msg.id) sr({ type: "COMMAND", data: { command: `loottable delete ${msg.id}` } }); this.selectedTableId = null; setTimeout(() => this.loadTables(), 300); break; }
      case "refresh": { this.loadTables(); break; }
      case "addItem": { if (sr && msg.tableId && msg.itemName) sr({ type: "COMMAND", data: { command: `loottable additem ${msg.tableId} "${msg.itemName}" ${msg.minQty || 1} ${msg.maxQty || 1} ${msg.chance || 100} ${msg.quality || "common"}` } }); setTimeout(() => this.loadTables(), 300); break; }
      case "removeItem": { if (sr) sr({ type: "COMMAND", data: { command: `loottable removeitem ${msg.itemId}` } }); setTimeout(() => this.loadTables(), 300); break; }
      case "updateItem": { if (sr && msg.itemId) sr({ type: "COMMAND", data: { command: `loottable updateitem ${msg.itemId} ${msg.minQty || 1} ${msg.maxQty || 1} ${msg.chance || 100} ${msg.quality || "common"}` } }); setTimeout(() => this.loadTables(), 300); break; }
      case "editorClosed": { this.onWindowClosed(); break; }
    }
  };

  private loadTables() { const sr = (window as any).sendRequest; if (sr) sr({ type: "LIST_LOOT_TABLES", data: null }); }

  public handleTableList(tables: any[]) {
    this.tables = tables || [];
    if (this.isActive && this.editorWindow) {
      this.sendToEditor({ type: "tableListUpdate", tables: this.tables, itemCache: this.getItemCache() });
    }
  }
}

const instance = new LootEditor();
(window as any).lootEditor = instance;
export default instance;
