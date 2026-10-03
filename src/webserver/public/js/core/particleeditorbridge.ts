const WIND_BURST_CYCLE = 3000;
const WIND_BURST_RAMP_UP = 400;
const WIND_BURST_HOLD = 200;
const WIND_BURST_RAMP_DOWN = 400;

class WindBurstTracker {
  private windBurstIntensity: number = 0;
  private windBurstTimer: number = 0;

  update(deltaTimeMs: number): void {
    this.windBurstTimer += deltaTimeMs;
    if (this.windBurstTimer >= WIND_BURST_CYCLE) { this.windBurstTimer -= WIND_BURST_CYCLE; }
    const rup = WIND_BURST_RAMP_UP, hld = rup + WIND_BURST_HOLD, rdn = hld + WIND_BURST_RAMP_DOWN;
    if (this.windBurstTimer < rup) this.windBurstIntensity = (this.windBurstTimer / WIND_BURST_RAMP_UP) * Math.sin(Math.PI / 2);
    else if (this.windBurstTimer < hld) this.windBurstIntensity = 1;
    else if (this.windBurstTimer < rdn) this.windBurstIntensity = Math.cos(((this.windBurstTimer - hld) / WIND_BURST_RAMP_DOWN) * Math.PI / 2);
    else this.windBurstIntensity = 0;
  }
  getIntensity(): number { return this.windBurstIntensity; }
  reset(): void { this.windBurstTimer = 0; this.windBurstIntensity = 0; }
}
const windBurst = new WindBurstTracker();

function calculateWindSpeed(baseWindSpeed: number, burstIntensity: number): number { return baseWindSpeed + baseWindSpeed * burstIntensity * 0.5; }
function applyWindVelocity(vx: number, vy: number, windSpeed: number, windDirection: string | null, maxVelX: number, maxVelY: number): { vx: number; vy: number } {
  let newVx: number;
  if (windDirection && windSpeed > 0 && (windDirection === "left" || windDirection === "right")) {
    const rad = (windDirection === "left" ? 180 : 0) * (Math.PI / 180);
    newVx = Math.min(Math.max(vx, -maxVelX + Math.cos(rad) * windSpeed * 0.5), maxVelX + Math.cos(rad) * windSpeed * 0.5);
  } else { newVx = Math.min(Math.max(vx, -maxVelX), maxVelX); }
  return { vx: newVx, vy: Math.min(Math.max(vy, -maxVelY), maxVelY) };
}
function getWindBias(windSpeed: number, windDirection: string | null): { x: number; y: number } {
  const bias = { x: 0, y: 0 };
  if (windDirection && (windDirection === "left" || windDirection === "right")) { bias.x = Math.cos((windDirection === "left" ? 180 : 0) * Math.PI / 180) * windSpeed * 0.5; }
  return bias;
}

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const RENAME_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

class ParticleEditorBridge {
  private particles: any[] = [];
  private selectedParticleName: string | null = null;
  private previewParticles: any[] = [];
  private lastEmitInterval: number = 0;
  private animFrameId: number | null = null;
  private lastFrameTime: number = 0;
  private searchQuery: string = "";

  private saveBtn: HTMLElement;
  private resetBtn: HTMLElement;
  /** A particle to select once the list (re)arrives: one just created, renamed or duplicated. */
  private pendingSelect: string | null = null;
  /** The form holds edits that have not been saved. */
  private dirty: boolean = false;
  private searchInput: HTMLInputElement;
  private particleListEl: HTMLElement;
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  constructor() {
    this.saveBtn = document.getElementById("btn-save")!;
    this.resetBtn = document.getElementById("btn-reset")!;
    this.searchInput = document.getElementById("particle-search") as HTMLInputElement;
    this.particleListEl = document.getElementById("particle-list")!;
    this.previewCanvas = document.getElementById("particle-preview-canvas") as HTMLCanvasElement;
    this.previewCtx = this.previewCanvas.getContext("2d")!;

    const inputIds = ["inp-size","inp-opacity","inp-brightness","inp-color","inp-zindex","inp-glow","inp-glow-radius","inp-visible","inp-static","inp-vel-x","inp-vel-y","inp-grav-x","inp-grav-y","inp-spread-x","inp-spread-y","inp-lpos-x","inp-lpos-y","inp-weather","inp-lifetime","inp-interval","inp-amount","inp-stagger","inp-time","inp-timeon","inp-timeoff"];
    for (const id of inputIds) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) { this.inputs[id] = el; el.addEventListener("input", () => this.onFormChange()); el.addEventListener("change", () => this.onFormChange()); }
    }

    this.saveBtn.addEventListener("click", () => this.saveParticle());
    this.resetBtn.addEventListener("click", () => this.resetForm());
    this.searchInput.addEventListener("input", () => { this.searchQuery = this.searchInput.value; this.renderParticleList(); });

    document.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")!));
    });

    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    // Backup for the game page closing us on unload: if the game tab is gone,
    // this editor has nothing to talk to, so close.
    if (window.opener) {
      setInterval(() => {
        if (!window.opener || window.opener.closed) window.close();
      }, 1000);
    }

    this.updateChrome();
    this.startPreviewLoop();
    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  private send(msg: any): void { if (window.opener) window.opener.postMessage(msg, "*"); }
  private onKeyDown(e: KeyboardEvent): void {
    // Ctrl+S saves from anywhere, including while typing in a field.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.saveParticle(); }
  }

  private status(text: string): void {
    const el = document.getElementById("pe-status");
    if (el) el.textContent = text;
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window.opener) return;
    const msg = e.data;
    switch (msg.type) {
      case "init": this.handleInit(msg.particles || []); break;
      case "particleData": this.loadParticle(msg.particle); break;
      case "close": window.close(); break;
    }
  }

  /** The particle list (re)arrived: after opening, and after every create, rename, duplicate or delete. */
  private handleInit(particles: any[]): void {
    this.particles = particles;
    if (this.particles.length === 0) this.send({ type: "requestParticles" });
    if (this.pendingSelect && this.findParticle(this.pendingSelect)) {
      this.selectedParticleName = this.pendingSelect;
      this.pendingSelect = null;
      this.loadParticle(this.findParticle(this.selectedParticleName));
    } else if (this.selectedParticleName && !this.findParticle(this.selectedParticleName) && !this.pendingSelect) {
      // The open particle is gone (deleted here or elsewhere): close it.
      this.selectedParticleName = null;
      this.dirty = false;
    }
    if (!this.selectedParticleName && !this.pendingSelect && this.particles.length > 0) {
      this.selectedParticleName = this.particles[0].name;
      this.loadParticle(this.particles[0]);
    }
    this.renderParticleList();
    this.updateChrome();
  }

  private renderParticleList(): void {
    this.particleListEl.innerHTML = "";
    const q = this.searchQuery.toLowerCase();
    // New particles start from a pinned row at the top of the list.
    const newRow = document.createElement("div");
    newRow.className = "editor-item ce-new-row";
    newRow.title = "New particle";
    const newLabel = document.createElement("span");
    newLabel.className = "editor-item-label";
    newLabel.textContent = "+ New particle";
    newRow.appendChild(newLabel);
    newRow.addEventListener("click", () => this.showNewModal());
    this.particleListEl.appendChild(newRow);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (q && p.name.toLowerCase().indexOf(q) === -1) continue;
      const item = document.createElement("div");
      item.className = "editor-item" + (p.name === this.selectedParticleName ? " active" : "");
      item.title = p.name;
      const label = document.createElement("span");
      label.className = "editor-item-label";
      label.textContent = p.name;
      item.appendChild(label);
      item.appendChild(this.rowAction("ce-row-copy", RENAME_ICON, `Rename ${p.name}`, () => this.showRenameModal(p.name)));
      item.appendChild(this.rowAction("ce-row-copy", COPY_ICON, `Duplicate ${p.name}`, () => this.showDuplicateModal(p)));
      item.appendChild(this.rowAction("ce-row-delete", TRASH_ICON, `Delete ${p.name}`, () => this.showDeleteModal(p.name)));
      item.addEventListener("click", () => this.selectParticle(p.name));
      this.particleListEl.appendChild(item);
    }
  }

  /** Icon button on a list row; acts on that row's particle without selecting it. */
  private rowAction(className: string, icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = icon;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private selectParticle(name: string): void {
    if (name === this.selectedParticleName) return;
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    const p = this.findParticle(name);
    if (!p) return;
    this.selectedParticleName = name;
    this.loadParticle(p);
    this.renderParticleList();
    this.updateChrome();
    this.status("");
  }

  private findParticle(name: string): any { for (const p of this.particles) { if (p.name === name) return p; } return null; }

  /** A stored particle in the shape getFormData() gives, with the defaults filled in. */
  private normalize(p: any): any {
    const toBool = (val: any) => val === true || val === 1 || val === "true" || val === "1";
    const xy = (val: any) => {
      if (typeof val === "string") { const parts = val.split(","); return { x: Number(parts[0]) || 0, y: Number(parts[1]) || 0 }; }
      return { x: Number(val?.x) || 0, y: Number(val?.y) || 0 };
    };
    return {
      name: p.name, size: p.size ?? 5, opacity: p.opacity ?? 0.8, brightness: p.brightness ?? 1, color: p.color || "#ffffff",
      zIndex: p.zIndex ?? p.zindex ?? 0, glow_intensity: p.glow_intensity ?? 0, glow_radius: p.glow_radius ?? 0,
      static_light: toBool(p.static_light), visible: p.visible != null ? toBool(p.visible) : true,
      velocity: xy(p.velocity), gravity: xy(p.gravity), spread: xy(p.spread), localposition: xy(p.localposition),
      affected_by_weather: toBool(p.affected_by_weather),
      lifetime: p.lifetime ?? 1000, interval: p.interval ?? 100, amount: p.amount ?? 10, staggertime: p.staggertime ?? 0,
      affected_by_time: toBool(p.affected_by_time), time_on: p.time_on || "", time_off: p.time_off || "",
    };
  }

  private loadParticle(p: any): void {
    if (!p) return;
    this.updatePreview();
    const d = this.normalize(p);
    const v = (key: string, val: any) => { const el = this.inputs[key] as HTMLInputElement | null; if (el) { if (el.type === "checkbox") el.checked = !!val; else el.value = val != null ? String(val) : ""; } };
    v("inp-size", d.size);
    v("inp-opacity", d.opacity);
    v("inp-brightness", d.brightness);
    v("inp-color", d.color);
    v("inp-zindex", d.zIndex);
    v("inp-glow", d.glow_intensity);
    v("inp-glow-radius", d.glow_radius);
    v("inp-static", d.static_light);
    v("inp-visible", d.visible);
    v("inp-vel-x", d.velocity.x); v("inp-vel-y", d.velocity.y);
    v("inp-grav-x", d.gravity.x); v("inp-grav-y", d.gravity.y);
    v("inp-spread-x", d.spread.x); v("inp-spread-y", d.spread.y);
    v("inp-lpos-x", d.localposition.x); v("inp-lpos-y", d.localposition.y);
    v("inp-weather", d.affected_by_weather);
    v("inp-lifetime", d.lifetime);
    v("inp-interval", d.interval);
    v("inp-amount", d.amount);
    v("inp-stagger", d.staggertime);
    v("inp-time", d.affected_by_time);
    v("inp-timeon", d.time_on); v("inp-timeoff", d.time_off);
    this.syncValueLabel("inp-size");
    this.syncValueLabel("inp-opacity");
    this.syncValueLabel("inp-brightness");
    this.syncValueLabel("inp-glow");
    this.syncValueLabel("inp-glow-radius");
    this.dirty = false;
    this.updateChrome();
  }

  /**
   * Form, preview and save icon only show while a particle is open; with none
   * (e.g. it was deleted) an empty-state message takes their place.
   */
  private updateChrome(): void {
    const has = !!this.selectedParticleName;
    const body = document.getElementById("pe-body");
    const empty = document.getElementById("pe-empty");
    if (body) body.hidden = !has;
    if (empty) empty.hidden = has;
    this.saveBtn.hidden = !has;
    this.resetBtn.hidden = !has || !this.dirty;
    this.saveBtn.classList.toggle("has-changes", has && this.dirty);
    this.saveBtn.title = has && this.dirty ? "Save changes (Ctrl+S)" : "No unsaved changes";
    const title = document.getElementById("pe-display-name");
    if (title) title.textContent = this.selectedParticleName || "—";
    const sub = document.getElementById("pe-display-sub");
    if (sub) {
      const isStatic = (this.inputs["inp-static"] as HTMLInputElement | undefined)?.checked;
      sub.textContent = (isStatic ? "static light" : "emitter") + (this.dirty ? " · unsaved changes" : "");
    }
  }

  private getFormData(): any {
    const gv = (key: string, isFloat?: boolean) => { const el = this.inputs[key] as HTMLInputElement | null; if (!el) return 0; if (el.type === "checkbox") return el.checked; const v = isFloat ? parseFloat(el.value) : parseInt(el.value, 10); return isNaN(v) ? 0 : v; };
    const gs = (key: string) => { const el = this.inputs[key] as HTMLInputElement | null; return el ? el.value : ""; };
    return {
      name: this.selectedParticleName || "", size: gv("inp-size"), opacity: gv("inp-opacity", true), brightness: gv("inp-brightness", true), color: gs("inp-color"),
      zIndex: gv("inp-zindex"), glow_intensity: gv("inp-glow", true), glow_radius: gv("inp-glow-radius", true), static_light: (this.inputs["inp-static"] as HTMLInputElement)?.checked ?? false, visible: (this.inputs["inp-visible"] as HTMLInputElement)?.checked ?? true,
      velocity: { x: gv("inp-vel-x", true), y: gv("inp-vel-y", true) }, gravity: { x: gv("inp-grav-x", true), y: gv("inp-grav-y", true) },
      spread: { x: gv("inp-spread-x", true), y: gv("inp-spread-y", true) }, localposition: { x: gv("inp-lpos-x", true), y: gv("inp-lpos-y", true) },
      affected_by_weather: (this.inputs["inp-weather"] as HTMLInputElement)?.checked ?? false,
      lifetime: gv("inp-lifetime"), interval: gv("inp-interval"), amount: gv("inp-amount"), staggertime: gv("inp-stagger", true),
      affected_by_time: (this.inputs["inp-time"] as HTMLInputElement)?.checked ?? false,
      time_on: gs("inp-timeon"), time_off: gs("inp-timeoff"), scale: 1, currentLife: 0, initialVelocity: { x: 0, y: 0 }, weather: {},
    };
  }

  private onFormChange(): void {
    this.syncValueLabel("inp-size");
    this.syncValueLabel("inp-opacity");
    this.syncValueLabel("inp-brightness");
    this.syncValueLabel("inp-glow");
    this.syncValueLabel("inp-glow-radius");
    this.updatePreview();
    if (this.selectedParticleName) { this.dirty = true; this.updateChrome(); }
  }
  private syncValueLabel(id: string): void {
    const el = this.inputs[id] as HTMLInputElement | null; if (!el || el.type !== "range") return;
    const label = document.getElementById("val-" + id.replace("inp-", "")); if (label) label.textContent = parseFloat(el.value).toString();
  }
  private resetForm(): void { const p = this.findParticle(this.selectedParticleName!); if (p) this.loadParticle(p); else this.updatePreview(); this.status("Reverted"); }
  private saveParticle(): void {
    if (!this.selectedParticleName) return; const data = this.getFormData();
    this.send({ type: "saveParticle", particle: data }); const idx = this.particles.findIndex((p) => p.name === data.name);
    if (idx >= 0) this.particles[idx] = data;
    this.dirty = false;
    this.updateChrome();
    this.status("Saved");
  }

  private showNewModal(): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    const taken = (n: string) => this.particles.some((p) => p.name.toLowerCase() === n.toLowerCase());
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>New Particle</h3><input type="text" id="modal-name" placeholder="Particle name"><p id="modal-error" style="color:#e74c3c;font-size:12px;margin:6px 0 0 0;min-height:14px"></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-confirm btn-primary">Create</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    const input = box.querySelector("#modal-name") as HTMLInputElement, error = box.querySelector("#modal-error") as HTMLElement;
    const confirmNew = () => {
      const name = input.value.trim();
      if (!name) return;
      if (name.includes(",")) { error.textContent = "Names cannot contain commas."; return; }
      if (taken(name)) { error.textContent = "A particle with that name already exists."; return; }
      overlay.remove();
      this.dirty = false;
      this.pendingSelect = name;
      this.send({ type: "createParticle", name });
      this.status("Created");
    };
    box.querySelector(".btn-confirm")!.addEventListener("click", confirmNew);
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmNew(); if (e.key === "Escape") overlay.remove(); });
    input.focus();
  }

  /** Rename: the server renames the particle and the NPCs, spells and mounts that use it. */
  private showRenameModal(from: string): void {
    if (!from) return;
    const open = from === this.selectedParticleName;
    // The renamed particle is reloaded from the server, which drops unsaved edits.
    if (open && this.dirty && !window.confirm("Renaming discards unsaved changes. Continue?")) return;
    const taken = (n: string) => this.particles.some((p) => p.name.toLowerCase() === n.toLowerCase() && p.name !== from);
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Rename Particle</h3><input type="text" id="modal-name" placeholder="New particle name"><p id="modal-error" style="color:#e74c3c;font-size:12px;margin:6px 0 0 0;min-height:14px"></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-confirm">Rename</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    const input = box.querySelector("#modal-name") as HTMLInputElement, error = box.querySelector("#modal-error") as HTMLElement;
    input.value = from;
    const confirm = () => {
      const to = input.value.trim();
      if (!to || to === from) { overlay.remove(); return; }
      if (to.includes(",")) { error.textContent = "Names cannot contain commas."; return; }
      if (taken(to)) { error.textContent = "A particle with that name already exists."; return; }
      overlay.remove();
      if (open) { this.pendingSelect = to; this.dirty = false; }
      this.send({ type: "renameParticle", from, to });
      this.status("Renamed");
    };
    box.querySelector(".btn-confirm")!.addEventListener("click", confirm);
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") overlay.remove(); });
    input.focus(); input.select();
  }

  /** Duplicate: a copy of a list row's particle under a new name; the open one is copied with the settings currently in the form. */
  private showDuplicateModal(source: any): void {
    if (!source?.name) return;
    const open = source.name === this.selectedParticleName;
    if (!open && this.dirty && !window.confirm("Discard unsaved changes?")) return;
    const taken = (n: string) => this.particles.some((p) => p.name.toLowerCase() === n.toLowerCase());
    let suggestion = `${source.name} Copy`;
    for (let k = 2; taken(suggestion); k++) suggestion = `${source.name} Copy ${k}`;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Duplicate Particle</h3><input type="text" id="modal-name" placeholder="New particle name"><p id="modal-error" style="color:#e74c3c;font-size:12px;margin:6px 0 0 0;min-height:14px"></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-confirm">Duplicate</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    const input = box.querySelector("#modal-name") as HTMLInputElement, error = box.querySelector("#modal-error") as HTMLElement;
    input.value = suggestion;
    const confirm = () => {
      const name = input.value.trim();
      if (!name) return;
      if (name.includes(",")) { error.textContent = "Names cannot contain commas."; return; }
      if (taken(name)) { error.textContent = "A particle with that name already exists."; return; }
      overlay.remove();
      this.pendingSelect = name;
      this.dirty = false;
      this.send({ type: "duplicateParticle", particle: { ...(open ? this.getFormData() : this.normalize(source)), name } });
      this.status("Copy made");
    };
    box.querySelector(".btn-confirm")!.addEventListener("click", confirm);
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") overlay.remove(); });
    input.focus(); input.select();
  }

  /** Delete a particle from its list row. Closes it if it is the open one. */
  private showDeleteModal(name: string): void {
    if (!name) return;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Delete Particle</h3><p></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-danger">Delete</button></div>';
    box.querySelector("p")!.textContent = `Delete ${name}? NPCs, spells and mounts using it lose the effect.`;
    overlay.appendChild(box); document.body.appendChild(overlay);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    document.addEventListener("keydown", onKey);
    box.querySelector(".btn-danger")!.addEventListener("click", () => {
      close();
      if (name === this.selectedParticleName) { this.selectedParticleName = null; this.dirty = false; this.updateChrome(); }
      this.particles = this.particles.filter((p) => p.name !== name);
      this.renderParticleList();
      this.send({ type: "deleteParticle", name });
      this.status("Deleted");
    });
    box.querySelector(".btn-cancel")!.addEventListener("click", close);
  }

  private switchTab(tabName: string): void {
    document.querySelectorAll(".editor-tab-btn").forEach((b) => { b.classList.toggle("active", b.getAttribute("data-tab") === tabName); });
    document.querySelectorAll(".editor-tab-panel").forEach((p) => { p.classList.toggle("active", p.getAttribute("data-tab") === tabName); });
  }

  private updatePreview(): void { this.previewParticles = []; this.lastEmitInterval = 0; }

  private colorToRgba(color: string, alpha: number): string {
    let r = 255, g = 255, b = 255;
    if (color && color[0] === "#") {
      let hex = color.slice(1);
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const n = parseInt(hex, 16);
      if (!isNaN(n)) { r = (n >> 16) & 0xff; g = (n >> 8) & 0xff; b = n & 0xff; }
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  private addFeatheredStops(gradient: CanvasGradient, color: string): void {
    gradient.addColorStop(0, this.colorToRgba(color, 0.55));
    gradient.addColorStop(0.15, this.colorToRgba(color, 0.4));
    gradient.addColorStop(0.35, this.colorToRgba(color, 0.2));
    gradient.addColorStop(0.6, this.colorToRgba(color, 0.07));
    gradient.addColorStop(1, this.colorToRgba(color, 0));
  }

  private startPreviewLoop(): void {
    if (this.animFrameId) return;
    // Every frame, like the game: the particle clock below is capped at one 60 FPS frame.
    const loop = () => { this.renderPreview(); this.animFrameId = requestAnimationFrame(loop); };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** The last sprite baked, and the settings it was baked from. */
  private sprite: { key: string; canvas: HTMLCanvasElement; half: number } | null = null;

  /**
   * The particle's sprite, baked exactly as the game bakes it (npc.ts getParticleSprite): the glow halo out to its
   * reach stacked once per unit of Intensity, the feathered core, then the whole stacked once per unit of Brightness.
   * Keep the two in step: the preview is only right while this matches.
   */
  private getSprite(color: string, radius: number, glowIntensity: number, glowRadius: number, brightness: number): { canvas: HTMLCanvasElement; half: number } {
    const key = `${color}|${radius}|${glowIntensity}|${glowRadius}|${brightness}`;
    if (this.sprite?.key === key) return this.sprite;
    const reach = glowIntensity > 0 ? (glowRadius > 0 ? glowRadius : Math.max(6, radius * 2)) : 0;
    const outer = radius + reach, sizeCss = Math.ceil(2 * outer) + 2, half = sizeCss / 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sizeCss); canvas.height = Math.max(1, sizeCss);
    const sctx = canvas.getContext("2d")!;
    sctx.globalCompositeOperation = "lighter";
    if (glowIntensity > 0) {
      const halo = sctx.createRadialGradient(half, half, 0, half, half, outer), edge = Math.min(0.95, radius / outer);
      halo.addColorStop(0, this.colorToRgba(color, 0.5)); halo.addColorStop(edge, this.colorToRgba(color, 0.32));
      halo.addColorStop(edge + (1 - edge) * 0.35, this.colorToRgba(color, 0.12)); halo.addColorStop(edge + (1 - edge) * 0.7, this.colorToRgba(color, 0.03));
      halo.addColorStop(1, this.colorToRgba(color, 0)); sctx.fillStyle = halo;
      const whole = Math.floor(glowIntensity), frac = glowIntensity - whole;
      for (let g = 0; g < whole + (frac > 0 ? 1 : 0); g++) { sctx.globalAlpha = g < whole ? 0.5 : frac * 0.5; sctx.fillRect(0, 0, sizeCss, sizeCss); }
    }
    const grad = sctx.createRadialGradient(half, half, 0, half, half, radius); this.addFeatheredStops(grad, color);
    sctx.globalAlpha = 1; sctx.fillStyle = grad; sctx.beginPath(); sctx.arc(half, half, radius, 0, Math.PI * 2); sctx.fill();
    let out = canvas;
    if (brightness !== 1) {
      out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height;
      const bctx = out.getContext("2d")!;
      bctx.globalCompositeOperation = "lighter";
      const whole = Math.floor(brightness), frac = brightness - whole;
      for (let b = 0; b < whole + (frac > 0 ? 1 : 0); b++) { bctx.globalAlpha = b < whole ? 1 : frac; bctx.drawImage(canvas, 0, 0); }
    }
    this.sprite = { key, canvas: out, half };
    return this.sprite;
  }

  /**
   * The particle as the game runs it (npc.ts updateParticle, the same in sourceparticles.ts): same clock, emission,
   * spread, physics, fade and sprite. The crosshair is the point it is attached to; +X is right and +Y is down.
   */
  private renderPreview(): void {
    if (!this.previewCtx) return;
    const ctx = this.previewCtx, canvas = this.previewCanvas, pData = this.getFormData();
    ctx.fillStyle = "#222"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.selectedParticleName) return;
    const radius = (pData.size || 5) / 2, glowIntensity = pData.glow_intensity || 0;
    const brightness = Number.isFinite(pData.brightness) ? Math.max(0, pData.brightness) : 1;
    ctx.save();
    // big particles (size and glow radius go to 512) are shown zoomed out to fit the preview
    {
      const reach = glowIntensity > 0 ? (pData.glow_radius > 0 ? pData.glow_radius : Math.max(6, radius * 2)) : 0;
      const extent = radius + reach + Math.max(Math.abs(pData.localposition.x), Math.abs(pData.localposition.y)) + Math.max(Math.abs(pData.spread.x), Math.abs(pData.spread.y)) * 0.5;
      const k = Math.min(1, (Math.min(canvas.width, canvas.height) / 2 - 4) / Math.max(1, extent));
      if (k < 1) { ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(k, k); ctx.translate(-canvas.width / 2, -canvas.height / 2); }
    }

    // the game's clock: the frame delta capped at one 60 FPS frame, driving emission, aging and physics alike
    const now = performance.now(), dt = Math.min((now - this.lastFrameTime) / 1000, 0.01667); this.lastFrameTime = now;
    const originX = canvas.width / 2, originY = canvas.height / 2;
    const sprite = this.getSprite(pData.color || "white", radius, glowIntensity, pData.glow_radius || 0, brightness);
    ctx.globalCompositeOperation = 'lighter';

    // a static light: one steady light at the particle's position, nothing emitted
    if (pData.static_light) {
      this.previewParticles.length = 0; this.lastEmitInterval = 0;
      ctx.globalAlpha = pData.opacity ?? 1;
      ctx.drawImage(sprite.canvas, originX + pData.localposition.x - sprite.half, originY + pData.localposition.y - sprite.half, sprite.half * 2, sprite.half * 2);
    } else {
      const emitInt = (pData.interval || 1) / 60 * 1000; this.lastEmitInterval += dt * 1000;
      while (this.lastEmitInterval >= emitInt && this.previewParticles.length < (pData.amount || 1)) {
        const randExt = Math.random() * (pData.staggertime || 0), baseLife = pData.lifetime || 1000;
        const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any;
        const wBias = getWindBias(wd?.wind_speed || 0, wd?.wind_direction || null);
        this.previewParticles.push({
          x: pData.localposition.x + (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.x * 0.5,
          y: pData.localposition.y + (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.y * 0.5,
          vx: pData.velocity.x + wBias.x, vy: pData.velocity.y + wBias.y,
          lifetime: baseLife + randExt, currentLife: baseLife + randExt,
        });
        this.lastEmitInterval -= emitInt;
      }

      windBurst.update(dt * 1000);
      let wSpd = 0, wDir: string | null = null;
      if (pData.affected_by_weather) { const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any; wSpd = calculateWindSpeed(wd?.wind_speed || 0, windBurst.getIntensity()); wDir = wd?.wind_direction || null; }
      const maxVelX = Math.abs(pData.velocity.x) || 1, maxVelY = Math.abs(pData.velocity.y) || 1;
      for (let i = this.previewParticles.length - 1; i >= 0; i--) {
        const pp = this.previewParticles[i]; pp.currentLife -= dt * 1000;
        if (pp.currentLife <= 0) { this.previewParticles.splice(i, 1); continue; }
        pp.vy += pData.gravity.y * dt; pp.vx += pData.gravity.x * dt;
        const nv = applyWindVelocity(pp.vx, pp.vy, wSpd, wDir, maxVelX, maxVelY); pp.vx = nv.vx; pp.vy = nv.vy;
        pp.x += pp.vx * dt; pp.y += pp.vy * dt;
        const fIn = pp.lifetime * 0.4, fOut = pp.lifetime * 0.4; let alpha: number;
        if (pp.lifetime - pp.currentLife < fIn) alpha = ((pp.lifetime - pp.currentLife) / fIn) * pData.opacity;
        else if (pp.currentLife < fOut) alpha = (pp.currentLife / fOut) * pData.opacity; else alpha = pData.opacity;
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite.canvas, originX + pp.x - sprite.half, originY + pp.y - sprite.half, sprite.half * 2, sprite.half * 2);
      }
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

new ParticleEditorBridge();
