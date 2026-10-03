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
  private newBtn: HTMLElement;
  private deleteBtn: HTMLElement;
  private duplicateBtn: HTMLElement | null;
  /** A particle to select once the list (re)arrives: the copy just made by Duplicate. */
  private pendingSelect: string | null = null;
  private searchInput: HTMLInputElement;
  private particleListEl: HTMLElement;
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

  constructor() {
    this.saveBtn = document.getElementById("btn-save")!;
    this.resetBtn = document.getElementById("btn-reset")!;
    this.newBtn = document.getElementById("btn-new")!;
    this.deleteBtn = document.getElementById("btn-delete")!;
    this.duplicateBtn = document.getElementById("btn-duplicate");
    document.getElementById("btn-rename")?.addEventListener("click", () => this.showRenameModal());
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
    this.newBtn.addEventListener("click", () => this.showNewModal());
    this.deleteBtn.addEventListener("click", () => this.showDeleteModal());
    this.duplicateBtn?.addEventListener("click", () => this.showDuplicateModal());
    this.searchInput.addEventListener("input", () => { this.searchQuery = this.searchInput.value; this.renderParticleList(); });

    document.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")!));
    });

    window.addEventListener("message", (e) => this.onMessage(e));
    window.addEventListener("beforeunload", () => { if (window.opener) window.opener.postMessage({ type: "editorClosed" }, "*"); });
    window.addEventListener("keydown", (e) => this.onKeyDown(e));

    this.startPreviewLoop();
    if (window.opener) window.opener.postMessage({ type: "bridgeReady" }, "*");
  }

  private send(msg: any): void { if (window.opener) window.opener.postMessage(msg, "*"); }
  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); this.saveParticle(); }
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window.opener) return;
    const msg = e.data;
    switch (msg.type) {
      case "init": this.particles = msg.particles || []; this.renderParticleList(); if (this.particles.length > 0 && !this.selectedParticleName) this.selectParticle(this.particles[0].name); if (this.particles.length === 0) this.send({ type: "requestParticles" });
        if (this.pendingSelect && this.particles.some((p) => p.name === this.pendingSelect)) { this.selectParticle(this.pendingSelect); this.pendingSelect = null; }
        break;
      case "particleData": this.loadParticle(msg.particle); break;
      case "close": window.close(); break;
    }
  }

  private renderParticleList(): void {
    this.particleListEl.innerHTML = "";
    const q = this.searchQuery.toLowerCase();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (q && p.name.toLowerCase().indexOf(q) === -1) continue;
      const item = document.createElement("div");
      item.className = "editor-item" + (p.name === this.selectedParticleName ? " active" : "");
      item.textContent = p.name;
      item.addEventListener("click", () => this.selectParticle(p.name));
      this.particleListEl.appendChild(item);
    }
  }

  private selectParticle(name: string): void {
    this.selectedParticleName = name;
    this.renderParticleList();
    const p = this.findParticle(name);
    if (p) this.loadParticle(p);
  }

  private findParticle(name: string): any { for (const p of this.particles) { if (p.name === name) return p; } return null; }

  private loadParticle(p: any): void {
    this.updatePreview();
    const toBool = (val: any) => val === true || val === 1 || val === "true" || val === "1";
    const v = (key: string, val: any) => { const el = this.inputs[key] as HTMLInputElement | null; if (el) { if (el.type === "checkbox") el.checked = toBool(val); else el.value = val != null ? String(val) : ""; } };
    v("inp-size", p.size != null ? p.size : 5);
    v("inp-opacity", p.opacity != null ? p.opacity : 0.8);
    v("inp-brightness", p.brightness != null ? p.brightness : 1);
    v("inp-color", p.color || "#ffffff");
    v("inp-zindex", p.zIndex != null ? p.zIndex : (p.zindex != null ? p.zindex : 0));
    v("inp-glow", p.glow_intensity != null ? p.glow_intensity : 0);
    v("inp-glow-radius", p.glow_radius != null ? p.glow_radius : 0);
    v("inp-static", !!p.static_light);
    v("inp-visible", p.visible != null ? p.visible : true);
    v("inp-vel-x", p.velocity ? p.velocity.x : 0); v("inp-vel-y", p.velocity ? p.velocity.y : 0);
    v("inp-grav-x", p.gravity ? p.gravity.x : 0); v("inp-grav-y", p.gravity ? p.gravity.y : 0);
    v("inp-spread-x", p.spread ? p.spread.x : 0); v("inp-spread-y", p.spread ? p.spread.y : 0);
    v("inp-lpos-x", p.localposition ? p.localposition.x : 0); v("inp-lpos-y", p.localposition ? p.localposition.y : 0);
    v("inp-weather", p.affected_by_weather || false);
    v("inp-lifetime", p.lifetime != null ? p.lifetime : 1000);
    v("inp-interval", p.interval != null ? p.interval : 100);
    v("inp-amount", p.amount != null ? p.amount : 10);
    v("inp-stagger", p.staggertime != null ? p.staggertime : 0);
    v("inp-time", p.affected_by_time || false);
    v("inp-timeon", p.time_on || ""); v("inp-timeoff", p.time_off || "");
    this.syncValueLabel("inp-size");
    this.syncValueLabel("inp-opacity");
    this.syncValueLabel("inp-brightness");
    this.syncValueLabel("inp-glow");
    this.syncValueLabel("inp-glow-radius");
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
  }
  private syncValueLabel(id: string): void {
    const el = this.inputs[id] as HTMLInputElement | null; if (!el || el.type !== "range") return;
    const label = document.getElementById("val-" + id.replace("inp-", "")); if (label) label.textContent = parseFloat(el.value).toString();
  }
  private resetForm(): void { const p = this.findParticle(this.selectedParticleName!); if (p) this.loadParticle(p); else this.updatePreview(); }
  private saveParticle(): void {
    if (!this.selectedParticleName) return; const data = this.getFormData();
    this.send({ type: "saveParticle", particle: data }); const idx = this.particles.findIndex((p) => p.name === data.name);
    if (idx >= 0) this.particles[idx] = data;
  }

  private showNewModal(): void {
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Create New Particle</h3><input type="text" id="modal-name" placeholder="Particle name"><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-confirm">Create</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    const input = box.querySelector("#modal-name") as HTMLInputElement;
    box.querySelector(".btn-confirm")!.addEventListener("click", () => { const name = input.value.trim(); if (name) { overlay.remove(); this.send({ type: "createParticle", name }); } });
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { const name = input.value.trim(); if (name) { overlay.remove(); this.send({ type: "createParticle", name }); } } if (e.key === "Escape") { overlay.remove(); } });
    input.focus();
  }

  /** Rename: the server renames the particle and the NPCs, spells and mounts that use it. */
  private showRenameModal(): void {
    const from = this.selectedParticleName;
    if (!from) return;
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
      this.pendingSelect = to;
      this.selectedParticleName = null;
      this.send({ type: "renameParticle", from, to });
    };
    box.querySelector(".btn-confirm")!.addEventListener("click", confirm);
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") overlay.remove(); });
    input.focus(); input.select();
  }

  /** Duplicate: a copy of the selected particle, with the settings currently in the form, under a new name. */
  private showDuplicateModal(): void {
    if (!this.selectedParticleName) return;
    const taken = (n: string) => this.particles.some((p) => p.name.toLowerCase() === n.toLowerCase());
    let suggestion = `${this.selectedParticleName} Copy`;
    for (let k = 2; taken(suggestion); k++) suggestion = `${this.selectedParticleName} Copy ${k}`;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Duplicate Particle</h3><input type="text" id="modal-name" placeholder="New particle name"><p id="modal-error" style="color:#e74c3c;font-size:12px;margin:6px 0 0 0;min-height:14px"></p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-confirm">Duplicate</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    const input = box.querySelector("#modal-name") as HTMLInputElement, error = box.querySelector("#modal-error") as HTMLElement;
    input.value = suggestion;
    const confirm = () => {
      const name = input.value.trim();
      if (!name) return;
      if (taken(name)) { error.textContent = "A particle with that name already exists."; return; }
      overlay.remove();
      this.pendingSelect = name;
      this.send({ type: "duplicateParticle", particle: { ...this.getFormData(), name } });
    };
    box.querySelector(".btn-confirm")!.addEventListener("click", confirm);
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") overlay.remove(); });
    input.focus(); input.select();
  }

  private showDeleteModal(): void {
    if (!this.selectedParticleName) return;
    const overlay = document.createElement("div"); overlay.className = "editor-modal-overlay";
    const box = document.createElement("div"); box.className = "editor-modal-box";
    box.innerHTML = '<h3>Delete Particle</h3><p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0 0 14px 0">Delete <strong>' + this.selectedParticleName + '</strong>?</p><div class="editor-modal-actions"><button class="btn-cancel">Cancel</button><button class="btn-danger">Delete</button></div>';
    overlay.appendChild(box); document.body.appendChild(overlay);
    box.querySelector(".btn-danger")!.addEventListener("click", () => { overlay.remove(); this.send({ type: "deleteParticle", name: this.selectedParticleName }); });
    box.querySelector(".btn-cancel")!.addEventListener("click", () => { overlay.remove(); });
    document.addEventListener("keydown", function handler(e) { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", handler); } });
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
    let lastTime = 0; const frameMs = 33;
    const loop = (time: number) => { if (time - lastTime >= frameMs) { lastTime = time; this.renderPreview(); } this.animFrameId = requestAnimationFrame(loop); };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** One particle as the game draws it (npc.ts getParticleSprite), Brightness included: the whole particle stacked
   * once per unit of brightness, the fraction a partial copy. */
  private drawGlowDot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, intensity: number, glowRadius: number, alpha: number, brightness: number = 1): void {
    const whole = Math.floor(brightness), frac = brightness - whole;
    for (let b = 0; b < whole + (frac > 0 ? 1 : 0); b++) this.drawGlowDotOnce(ctx, x, y, radius, color, intensity, glowRadius, alpha * (b < whole ? 1 : frac));
  }

  /** The particle once: the glow halo out to its radius, stacked once per unit of intensity, then the feathered core. */
  private drawGlowDotOnce(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, intensity: number, glowRadius: number, alpha: number): void {
    if (intensity > 0) {
      const outer = radius + (glowRadius > 0 ? glowRadius : Math.max(6, radius * 2)), edge = Math.min(0.95, radius / outer);
      const halo = ctx.createRadialGradient(x, y, 0, x, y, outer);
      halo.addColorStop(0, this.colorToRgba(color, 0.5)); halo.addColorStop(edge, this.colorToRgba(color, 0.32));
      halo.addColorStop(edge + (1 - edge) * 0.35, this.colorToRgba(color, 0.12)); halo.addColorStop(edge + (1 - edge) * 0.7, this.colorToRgba(color, 0.03));
      halo.addColorStop(1, this.colorToRgba(color, 0)); ctx.fillStyle = halo;
      const whole = Math.floor(intensity), frac = intensity - whole;
      for (let g = 0; g < whole + (frac > 0 ? 1 : 0); g++) { ctx.globalAlpha = alpha * (g < whole ? 0.5 : frac * 0.5); ctx.fillRect(x - outer, y - outer, outer * 2, outer * 2); }
    }
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius); this.addFeatheredStops(grad, color);
    ctx.globalAlpha = alpha; ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }

  private renderPreview(): void {
    if (!this.previewCtx) return;
    const ctx = this.previewCtx, canvas = this.previewCanvas, pData = this.getFormData();
    ctx.fillStyle = "#222"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(canvas.width, canvas.height); ctx.scale(-1, -1);
    // big particles (size and glow radius go to 512) are shown zoomed out to fit the preview
    {
      const r = (pData.size || 5) / 2, reach = pData.glow_intensity > 0 ? (pData.glow_radius > 0 ? pData.glow_radius : Math.max(6, r * 2)) : 0;
      const extent = r + reach + Math.max(Math.abs(pData.localposition?.x || 0), Math.abs(pData.localposition?.y || 0)) + Math.max(Math.abs(pData.spread?.x || 0), Math.abs(pData.spread?.y || 0));
      const k = Math.min(1, (Math.min(canvas.width, canvas.height) / 2 - 4) / Math.max(1, extent));
      if (k < 1) { ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(k, k); ctx.translate(-canvas.width / 2, -canvas.height / 2); }
    }

    const now = performance.now(); let dt = (now - this.lastFrameTime) / 1000; dt = Math.min(dt, 0.05); const dtMs = dt * 1000; this.lastFrameTime = now;
    windBurst.update(dtMs);

    // a static light: one steady light at the particle's position (the game's npc.ts static_light), nothing emitted
    if (pData.static_light) {
      this.previewParticles.length = 0; this.lastEmitInterval = 0;
      ctx.globalCompositeOperation = 'lighter';
      this.drawGlowDot(ctx, canvas.width / 2 + (pData.localposition ? pData.localposition.x : 0), canvas.height / 2 - (pData.localposition ? pData.localposition.y : 0),
        (pData.size || 5) / 2, pData.color || "white", pData.glow_intensity || 0, pData.glow_radius || 0, pData.opacity ?? 1, pData.brightness ?? 1);
    }

    if (!pData.static_light && pData.interval && pData.interval > 0) {
      const emitInt = pData.interval / 60 * 1000; this.lastEmitInterval += dt * 1000;
      while (this.lastEmitInterval >= emitInt && this.previewParticles.length < pData.amount) {
        const randExt = Math.random() * (pData.staggertime || 0), baseLife = pData.lifetime || 1000;
        const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any;
        const wDir = wd?.wind_direction || null, wSpd = wd?.wind_speed || 0, wBias = getWindBias(wSpd, wDir);
        const spX = (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.x, spY = (Math.random() < 0.5 ? -1 : 1) * Math.random() * pData.spread.y;
        this.previewParticles.push({
          x: canvas.width / 2 + (pData.localposition ? pData.localposition.x : 0) + spX,
          y: canvas.height / 2 - (pData.localposition ? pData.localposition.y : 0) + spY,
          vx: -(pData.velocity.x + wBias.x), vy: -(pData.velocity.y + wBias.y),
          lifetime: baseLife + randExt, currentLife: baseLife + randExt, size: pData.size || 5, color: pData.color || "white", glow_intensity: pData.glow_intensity || 0, glow_radius: pData.glow_radius || 0, brightness: pData.brightness ?? 1,
        });
        this.lastEmitInterval -= emitInt;
      }
    }

    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.previewParticles.length - 1; i >= 0; i--) {
      const pp = this.previewParticles[i]; pp.currentLife -= dt * 1000;
      if (pp.currentLife <= 0) { this.previewParticles.splice(i, 1); continue; }
      let wSpd = 0, wDir: string | null = null;
      if (pData.affected_by_weather) { const wd = (typeof pData.weather === 'object' ? pData.weather : null) as any; wSpd = calculateWindSpeed(wd?.wind_speed || 0, windBurst.getIntensity()); wDir = wd?.wind_direction || null; }
      pp.vy -= pData.gravity.y * dt; pp.vx -= pData.gravity.x * dt;
      const nv = applyWindVelocity(pp.vx, pp.vy, wSpd, wDir, Math.abs(pData.velocity.x) || 1, Math.abs(pData.velocity.y) || 1); pp.vx = nv.vx; pp.vy = nv.vy;
      pp.x += pp.vx * dt; pp.y += pp.vy * dt;
      const fIn = pp.lifetime * 0.4, fOut = pp.lifetime * 0.4; let alpha: number;
      if (pp.lifetime - pp.currentLife < fIn) alpha = ((pp.lifetime - pp.currentLife) / fIn) * pData.opacity;
      else if (pp.currentLife < fOut) alpha = (pp.currentLife / fOut) * pData.opacity; else alpha = pData.opacity;
      // the game's particle (npc.ts getParticleSprite): halo out to the Radius setting stacked per unit of Intensity, the
      // core, and the whole stacked per unit of Brightness
      this.drawGlowDot(ctx, pp.x, pp.y, pp.size / 2, pp.color, pp.glow_intensity, pp.glow_radius, alpha, pp.brightness);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(canvas.width / 2, 0); ctx.lineTo(canvas.width / 2, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
    ctx.setLineDash([]);
  }
}

new ParticleEditorBridge();
