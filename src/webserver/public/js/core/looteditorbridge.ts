class LootEditorBridge {
  private tables: any[] = [];
  private selectedTableId: number | null = null;
  private selectedTableData: any = null;
  private tq = "";
  private itemsByName: Map<string, any> = new Map();

  private tableListEl: HTMLElement;
  private itemListEl: HTMLElement;
  private nameInput: HTMLInputElement;
  private itemSearchInput: HTMLInputElement;
  private itemResultsEl: HTMLElement;

  constructor() {
    this.tableListEl = document.getElementById("le-table-list")!;
    this.itemListEl = document.getElementById("le-item-list")!;
    this.nameInput = document.getElementById("le-inp-name") as HTMLInputElement;
    this.itemSearchInput = document.getElementById("le-inp-item-name") as HTMLInputElement;
    this.itemResultsEl = document.getElementById("le-item-results")!;

    document.getElementById("le-btn-refresh")!.addEventListener("click", () => this.send({ type: "refresh" }));
    document.getElementById("le-btn-delete")!.addEventListener("click", () => { if (this.selectedTableId) this.send({ type: "deleteTable", id: this.selectedTableId }); });

    document.getElementById("le-btn-create")!.addEventListener("click", () => {
      const n = this.nameInput.value.trim(); if (!n) return;
      this.send({ type: "createTable", name: n }); this.nameInput.value = "";
    });

    (document.getElementById("le-table-search") as HTMLInputElement).addEventListener("input", () => {
      this.tq = (document.getElementById("le-table-search") as HTMLInputElement).value.toLowerCase(); this.renderTables();
    });

    this.itemSearchInput.addEventListener("input", () => this.filterItems());
    this.itemSearchInput.addEventListener("focus", () => this.filterItems());
    document.addEventListener("click", (e) => {
      if (!this.itemResultsEl.contains(e.target as Node) && e.target !== this.itemSearchInput) {
        this.itemResultsEl.style.display = "none";
      }
    });

    document.querySelectorAll(".editor-tab-btn").forEach(b => b.addEventListener("click", () => this.switchTab(b.getAttribute("data-tab")!)));
    window.addEventListener("message", e => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  private send(msg: any) { if (window.opener) window.opener.postMessage(msg, "*"); }

  private iconWrap(iconUrl: string, quality: string, size: number): string {
    const q = (quality || "common").toLowerCase();
    const inner = iconUrl
      ? `<img src="${iconUrl}" onerror="this.style.display='none'" width="${size - 6}" height="${size - 6}" style="border-radius:3px">`
      : `<span style="font-size:10px;color:#888">?</span>`;
    return `<span class="le-item-icon-wrap ${q}" style="width:${size}px;height:${size}px">${inner}</span>`;
  }

  private filterItems() {
    const q = this.itemSearchInput.value.trim().toLowerCase();
    if (!q) { this.itemResultsEl.style.display = "none"; return; }
    this.itemResultsEl.innerHTML = "";
    let count = 0;
    for (const [name, data] of this.itemsByName) {
      if (name.toLowerCase().indexOf(q) === -1) continue;
      if (count >= 20) break;
      const el = document.createElement("div");
      el.className = "le-item-result";
      el.style.cssText = "display:flex;align-items:center;gap:8px";
      el.innerHTML = `${this.iconWrap(data.iconUrl || "", data.quality || "common", 34)}<span class="editor-item-label" style="flex:1;min-width:100px;font-size:12px">${name}</span><span style="color:#888;font-size:10px;margin-right:4px">${data.quality || "common"}</span><button type="button" class="le-add-btn">Add</button>`;

      el.querySelector(".le-add-btn")!.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!this.selectedTableId) return;
        this.send({ type: "addItem", tableId: this.selectedTableId, itemName: name, quality: data.quality || "common", minQty: 1, maxQty: 1, chance: 100 });
        this.itemSearchInput.value = "";
        this.itemResultsEl.style.display = "none";
        this.switchTab("items");
      });

      this.itemResultsEl.appendChild(el);
      count++;
    }
    this.itemResultsEl.style.display = count > 0 ? "block" : "none";
  }

  private onMessage(e: MessageEvent) {
    if (e.source !== window.opener) return;
    const m = e.data;
    switch (m.type) {
      case "init": this.tables = m.tables || []; if (m.itemCache) { this.itemsByName = m.itemCache; } this.renderTables(); if (m.selectedTable) this.selectTable(m.selectedTable); break;
      case "tableListUpdate": this.tables = m.tables || []; if (m.itemCache) { this.itemsByName = m.itemCache; } this.renderTables(); if (this.selectedTableId) { const t = this.tables.find((x: any) => x.id === this.selectedTableId); if (t) { this.selectedTableData = t; this.populateForm(t); } } break;
      case "tableSelectUpdate": if (m.table) { this.selectedTableId = m.table.id; this.selectedTableData = m.table; this.populateForm(m.table); this.renderTables(); } break;
      case "close": window.close(); break;
    }
  }

  private renderTables() {
    this.tableListEl.innerHTML = "";
    for (const t of this.tables) {
      const label = `#${t.id} ${t.name}`;
      if (this.tq && label.toLowerCase().indexOf(this.tq) === -1) continue;
      const el = document.createElement("div");
      el.className = "editor-item" + (t.id === this.selectedTableId ? " active" : "");
      el.innerHTML = `<span class="editor-item-label">${label}</span><span class="editor-item-icon">(${t.items?.length || 0} items)</span>`;
      el.addEventListener("click", () => this.selectTable(t));
      this.tableListEl.appendChild(el);
    }
  }

  private selectTable(t: any) { this.selectedTableId = t.id; const fresh = this.tables.find((x: any) => x.id === t.id); this.selectedTableData = fresh || t; this.populateForm(this.selectedTableData); this.send({ type: "selectTable", id: t.id }); this.renderTables(); }

  private populateForm(t: any) {
    const el = document.getElementById("le-display-id"); if (el) el.textContent = t.id ? `#${t.id}` : "—";
    this.nameInput.value = t.name || "";
    this.renderItems();
  }

  private getIconForItem(itemName: string): string {
    const data = this.itemsByName.get(itemName);
    return data?.iconUrl || "";
  }

  private renderItems() {
    this.itemListEl.innerHTML = "";
    const items = this.selectedTableData?.items || [];
    if (items.length > 0) {
      const hdr = document.createElement("div");
      hdr.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.5px";
      hdr.innerHTML = `<span style="width:38px;flex-shrink:0"></span><span style="flex:1">Item</span><span style="width:48px;text-align:center">Min</span><span style="width:48px;text-align:center">Max</span><span style="width:50px;text-align:center">Drop</span><span style="width:24px"></span>`;
      this.itemListEl.appendChild(hdr);
    }
    for (const it of items) {
      const iconUrl = this.getIconForItem(it.item_name);
      const el = document.createElement("div");
      el.className = "editor-item";
      el.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px";
      el.innerHTML = `${this.iconWrap(iconUrl, it.quality || "common", 38)}<span class="editor-item-label" style="flex:1">${it.item_name}</span><input class="le-inline-inp" type="number" value="${it.min_quantity ?? 1}" min="1" max="999" style="width:48px" title="Min quantity"><input class="le-inline-inp" type="number" value="${it.max_quantity ?? 1}" min="1" max="999" style="width:48px" title="Max quantity"><input class="le-inline-inp" type="number" value="${it.drop_chance ?? 100}" min="0" max="100" step="0.1" style="width:50px" title="Drop chance %"><button class="editor-item-remove" data-id="${it.id}">&times;</button>`;

      el.querySelector("button")?.addEventListener("click", ev => { ev.stopPropagation(); this.send({ type: "removeItem", itemId: it.id }); });

      const inps = el.querySelectorAll(".le-inline-inp") as NodeListOf<HTMLInputElement>;
      const onSave = () => {
        let minQty = parseInt(inps[0]?.value) || 1;
        let maxQty = parseInt(inps[1]?.value) || 1;
        let chance = parseFloat(inps[2]?.value);
        if (isNaN(chance) || chance < 0) chance = 0;
        if (chance > 100) chance = 100;
        if (minQty < 1) minQty = 1;
        if (maxQty < 1) maxQty = 1;
        if (minQty > maxQty) maxQty = minQty;
        inps[0].value = String(minQty);
        inps[1].value = String(maxQty);
        inps[2].value = String(chance);
        this.send({
          type: "updateItem",
          itemId: it.id,
          tableId: this.selectedTableId,
          quality: it.quality || "common",
          minQty, maxQty, chance
        });
      };
      inps.forEach(inp => { inp.addEventListener("change", onSave); inp.addEventListener("blur", onSave); });

      this.itemListEl.appendChild(el);
    }
  }

  private switchTab(tab: string) {
    document.querySelectorAll(".editor-tab-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    document.querySelectorAll(".editor-tab-panel").forEach(p => p.classList.toggle("active", p.getAttribute("data-tab") === tab));
  }
}

new LootEditorBridge();
