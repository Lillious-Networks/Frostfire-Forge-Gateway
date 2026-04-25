class ParticleEditor {
  public isActive: boolean = false;
  private selectedParticle: Particle | null = null;
  private particles: Particle[] = [];
  private previewParticles: Array<any> = [];
  private lastEmitTime: number = 0;
  private lastEmitInterval: number = 0;
  private isDirty: boolean = false;
  private searchQuery: string = "";

  // UI Elements
  private container: HTMLElement | null = null;
  private propertiesPanel: HTMLElement | null = null;
  private particleListPanel: HTMLElement | null = null;
  private previewPanel: HTMLElement | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewContext: CanvasRenderingContext2D | null = null;
  private particleList: HTMLElement | null = null;

  // Form inputs
  private formInputs: { [key: string]: HTMLInputElement | HTMLSelectElement } = {};

  // Animation loop
  private animationFrameId: number | null = null;

  public toggle() {
    this.isActive = !this.isActive;
    const container = document.getElementById("particle-editor-container");
    if (container) {
      container.style.display = this.isActive ? "block" : "none";
      if (this.isActive) {
        this.loadParticles();
        if (!this.container) {
          this.createUI();
        }
        // Always restart animation loop when opening
        this.startPreviewLoop();
        // Reset selected particle and preview when opening
        this.selectedParticle = null;
        this.updatePreview();
        // Hide properties and preview panels initially
        this.setPropertiesPanelVisible(false);
        this.setPreviewPanelVisible(false);
      } else {
        this.cleanup();
      }
    }
  }

  private setPropertiesPanelVisible(visible: boolean) {
    const panel = document.getElementById("particle-editor-properties-panel");
    if (panel) {
      panel.style.display = visible ? "block" : "none";
    }
  }

  private setPreviewPanelVisible(visible: boolean) {
    const panel = document.getElementById("particle-editor-preview-panel");
    if (panel) {
      panel.style.display = visible ? "block" : "none";
    }
  }

  private createUI() {
    this.container = document.getElementById("particle-editor-container");
    if (!this.container) {
      console.error("particle-editor-container not found!");
      return;
    }

    this.propertiesPanel = document.getElementById("particle-editor-properties-panel");
    this.particleListPanel = document.getElementById("particle-editor-list-panel");
    this.previewPanel = document.getElementById("particle-editor-preview-panel");
    this.previewCanvas = document.getElementById("particle-preview-canvas") as HTMLCanvasElement;
    this.particleList = document.getElementById("particle-list");

    if (this.previewCanvas) {
      this.previewCanvas.width = 400;
      this.previewCanvas.height = 300;
      this.previewContext = this.previewCanvas.getContext("2d");
    }

    this.setupFormInputs();
    this.setupEventListeners();
    this.setupPanelDragAndResize();
    this.loadStoredPanelStates();
  }

  private setupFormInputs() {
    const inputIds = [
      "pe-particle-size",
      "pe-particle-color",
      "pe-particle-velocity-x",
      "pe-particle-velocity-y",
      "pe-particle-lifetime",
      "pe-particle-opacity",
      "pe-particle-gravity-x",
      "pe-particle-gravity-y",
      "pe-particle-localpos-x",
      "pe-particle-localpos-y",
      "pe-particle-interval",
      "pe-particle-amount",
      "pe-particle-staggertime",
      "pe-particle-spread-x",
      "pe-particle-spread-y",
      "pe-particle-visible",
      "pe-particle-weather",
      "pe-particle-zindex",
    ];

    for (const id of inputIds) {
      const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
      if (element) {
        this.formInputs[id] = element;
        // Store initial value to detect actual changes
        element.setAttribute("data-initial-value", element.value);
        // Update preview only when value actually changes (input event fires as user types)
        element.addEventListener("input", () => this.onFormValueChange());
      }
    }
  }

  private setupEventListeners() {
    // New particle button
    const newParticleBtn = document.getElementById("pe-new-particle");
    if (newParticleBtn) {
      newParticleBtn.addEventListener("click", () => this.createNewParticle());
    }

    // Save button
    const saveBtn = document.getElementById("pe-save-particle");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => this.saveParticle());
    }

    // Reset button
    const resetBtn = document.getElementById("pe-reset-particle");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => this.resetParticle());
    }

    // Delete button
    const deleteBtn = document.getElementById("pe-delete-particle");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => this.deleteParticle());
    }

    // Search input
    const searchInput = document.getElementById("pe-particle-search") as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.refreshParticleList();
      });
    }
  }

  private setupPanelDragAndResize() {
    const panels = [
      { panel: this.propertiesPanel, storageKey: "pe-properties-pos" },
      { panel: this.particleListPanel, storageKey: "pe-list-pos" },
      { panel: this.previewPanel, storageKey: "pe-preview-pos" },
    ];

    for (const { panel, storageKey } of panels) {
      if (!panel) continue;

      const header = panel.querySelector(".pe-panel-header") as HTMLElement;
      if (header) {
        let isDown = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener("mousedown", (e) => {
          isDown = true;
          offsetX = (e as MouseEvent).clientX - panel!.offsetLeft;
          offsetY = (e as MouseEvent).clientY - panel!.offsetTop;
        });

        document.addEventListener("mousemove", (e) => {
          if (!isDown) return;
          panel!.style.left = (e.clientX - offsetX) + "px";
          panel!.style.top = (e.clientY - offsetY) + "px";
          localStorage.setItem(storageKey, JSON.stringify({
            x: panel!.offsetLeft,
            y: panel!.offsetTop,
          }));
        });

        document.addEventListener("mouseup", () => {
          isDown = false;
        });
      }

      const minimizeBtn = panel.querySelector(".pe-panel-minimize");
      if (minimizeBtn) {
        minimizeBtn.addEventListener("click", () => {
          const content = panel!.querySelector(".pe-panel-content") as HTMLElement;
          if (content) {
            content.style.display =
              content.style.display === "none" ? "block" : "none";
          }
        });
      }

      const closeBtn = panel.querySelector(".pe-panel-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          // Close button on list panel closes entire editor
          if (panel === this.particleListPanel) {
            this.toggle();
          } else {
            panel!.style.display = "none";
          }
        });
      }
    }
  }

  private loadStoredPanelStates() {
    const panels = [
      { panel: this.propertiesPanel, storageKey: "pe-properties-pos", defaultX: 50, defaultY: 50 },
      { panel: this.particleListPanel, storageKey: "pe-list-pos", defaultX: 500, defaultY: 50 },
      { panel: this.previewPanel, storageKey: "pe-preview-pos", defaultX: 900, defaultY: 50 },
    ];

    for (const { panel, storageKey, defaultX, defaultY } of panels) {
      if (!panel) continue;

      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const { x, y } = JSON.parse(stored);
        panel.style.left = x + "px";
        panel.style.top = y + "px";
      } else {
        panel.style.left = defaultX + "px";
        panel.style.top = defaultY + "px";
      }
    }
  }

  private async loadParticles() {
    try {
      // Use the sendRequest function from socket.ts if available
      const sendRequest = (window as any).sendRequest;
      if (sendRequest) {
        sendRequest({
          type: "LIST_PARTICLES",
          data: null,
        });
      } else {
        console.warn("sendRequest function not available - window.sendRequest is:", (window as any).sendRequest);
      }
    } catch (error) {
      console.error("Error loading particles:", error);
    }
  }

  public setParticles(particles: Particle[]) {
    this.particles = particles;
    this.refreshParticleList();
  }

  public addParticleListItem(data: any) {
    // Handle both full packet object and direct particle array
    if (Array.isArray(data)) {
      this.setParticles(data);
    } else if (data.type === "PARTICLE_LIST" && data.data) {
      this.setParticles(data.data);
    } else if (data.data && Array.isArray(data.data)) {
      this.setParticles(data.data);
    } else {
      console.warn("Unexpected data format in addParticleListItem:", data);
    }
  }

  private refreshParticleList() {
    if (!this.particleList) return;

    this.particleList.innerHTML = "";

    // Filter particles based on search query (match from start of name)
    const filteredParticles = this.particles.filter(particle =>
      (particle.name || "").toLowerCase().startsWith(this.searchQuery)
    );

    for (const particle of filteredParticles) {
      const item = document.createElement("div");
      item.className = "pe-particle-item";
      item.textContent = particle.name || "Unnamed";

      // Add selected class if this is the currently selected particle
      if (this.selectedParticle?.name === particle.name) {
        item.classList.add("selected");
      }

      item.addEventListener("click", () => {
        this.selectParticle(particle);
      });

      this.particleList.appendChild(item);
    }
  }

  private selectParticle(particle: Particle) {
    this.selectedParticle = particle;
    this.populateForm(particle);
    this.refreshParticleList();
    // Clear dirty flag when selecting a particle
    this.isDirty = false;
    this.updateParticleNameDisplay();
    // Clear preview when switching particles
    this.updatePreview();
    // Show properties and preview panels when a particle is selected
    this.setPropertiesPanelVisible(true);
    this.setPreviewPanelVisible(true);
  }

  private populateForm(particle: Particle) {
    const inputs = this.formInputs;
    // Set particle name as text (not an input)
    const nameElement = document.getElementById("pe-particle-name");
    if (nameElement) nameElement.textContent = particle.name || "";
    if (inputs["pe-particle-size"]) inputs["pe-particle-size"].value = String(particle.size || 1);
    if (inputs["pe-particle-color"]) inputs["pe-particle-color"].value = particle.color || "white";
    if (inputs["pe-particle-velocity-x"]) inputs["pe-particle-velocity-x"].value = String(particle.velocity.x || 0);
    if (inputs["pe-particle-velocity-y"]) inputs["pe-particle-velocity-y"].value = String(particle.velocity.y || 0);
    if (inputs["pe-particle-lifetime"]) inputs["pe-particle-lifetime"].value = String(particle.lifetime || 100);
    if (inputs["pe-particle-opacity"]) inputs["pe-particle-opacity"].value = String(particle.opacity || 1);
    if (inputs["pe-particle-gravity-x"]) inputs["pe-particle-gravity-x"].value = String(particle.gravity.x || 0);
    if (inputs["pe-particle-gravity-y"]) inputs["pe-particle-gravity-y"].value = String(particle.gravity.y || 0);
    if (inputs["pe-particle-localpos-x"]) inputs["pe-particle-localpos-x"].value = String(particle.localposition?.x || 0);
    if (inputs["pe-particle-localpos-y"]) inputs["pe-particle-localpos-y"].value = String(particle.localposition?.y || 0);
    if (inputs["pe-particle-interval"]) inputs["pe-particle-interval"].value = String(particle.interval || 1);
    if (inputs["pe-particle-amount"]) inputs["pe-particle-amount"].value = String(particle.amount || 1);
    if (inputs["pe-particle-staggertime"]) inputs["pe-particle-staggertime"].value = String(particle.staggertime || 0);
    if (inputs["pe-particle-spread-x"]) inputs["pe-particle-spread-x"].value = String(particle.spread.x || 0);
    if (inputs["pe-particle-spread-y"]) inputs["pe-particle-spread-y"].value = String(particle.spread.y || 0);
    if (inputs["pe-particle-visible"]) (inputs["pe-particle-visible"] as HTMLInputElement).checked = Boolean(particle.visible);
    if (inputs["pe-particle-weather"]) (inputs["pe-particle-weather"] as HTMLInputElement).checked = Boolean(particle.affected_by_weather);
    if (inputs["pe-particle-zindex"]) inputs["pe-particle-zindex"].value = String((particle as any).zIndex || 0);
  }

  private getFormData(): Particle {
    const inputs = this.formInputs;
    // Get particle name from text element (not an input)
    const nameElement = document.getElementById("pe-particle-name");
    const particleName = nameElement?.textContent || null;

    return {
      scale: 1,  // Add scale property to match Particle interface
      name: particleName,
      size: Number((inputs["pe-particle-size"] as HTMLInputElement).value) || 1,
      color: (inputs["pe-particle-color"] as HTMLInputElement).value || "white",
      velocity: {
        x: Number((inputs["pe-particle-velocity-x"] as HTMLInputElement).value) || 0,
        y: Number((inputs["pe-particle-velocity-y"] as HTMLInputElement).value) || 0,
      },
      lifetime: Number((inputs["pe-particle-lifetime"] as HTMLInputElement).value) || 100,
      opacity: Number((inputs["pe-particle-opacity"] as HTMLInputElement).value) || 1,
      visible: (inputs["pe-particle-visible"] as HTMLInputElement).checked,
      gravity: {
        x: Number((inputs["pe-particle-gravity-x"] as HTMLInputElement).value) || 0,
        y: Number((inputs["pe-particle-gravity-y"] as HTMLInputElement).value) || 0,
      },
      localposition: {
        x: Number((inputs["pe-particle-localpos-x"] as HTMLInputElement).value) || 0,
        y: Number((inputs["pe-particle-localpos-y"] as HTMLInputElement).value) || 0,
      },
      interval: Number((inputs["pe-particle-interval"] as HTMLInputElement).value) || 1,
      amount: Number((inputs["pe-particle-amount"] as HTMLInputElement).value) || 1,
      staggertime: Number((inputs["pe-particle-staggertime"] as HTMLInputElement).value) || 0,
      spread: {
        x: Number((inputs["pe-particle-spread-x"] as HTMLInputElement).value) || 0,
        y: Number((inputs["pe-particle-spread-y"] as HTMLInputElement).value) || 0,
      },
      weather: "none",
      affected_by_weather: (inputs["pe-particle-weather"] as HTMLInputElement).checked,
      zIndex: Number((inputs["pe-particle-zindex"] as HTMLInputElement).value) || 0,
      currentLife: null,
      initialVelocity: null,
    };
  }

  private createNewParticle() {
    const modal = document.getElementById("pe-new-particle-modal");
    const input = document.getElementById("pe-new-particle-name-input") as HTMLInputElement;
    const confirmBtn = document.getElementById("pe-modal-confirm");
    const cancelBtn = document.getElementById("pe-modal-cancel");

    if (!modal || !input) return;

    // Clear input and show modal
    input.value = "";
    modal.classList.add("visible");
    input.focus();

    // Handle confirm
    const confirmHandler = () => {
      const name = input.value.trim();
      if (!name) {
        alert("Particle name is required");
        return;
      }

      const newParticle: Particle = {
        name,
        size: 1,
        color: "white",
        velocity: { x: 0, y: 0 },
        lifetime: 100,
        opacity: 1,
        visible: true,
        gravity: { x: 0, y: 0 },
        localposition: { x: 0, y: 0 },
        interval: 1,
        amount: 1,
        staggertime: 0,
        spread: { x: 0, y: 0 },
        weather: "none",
        affected_by_weather: false,
        zIndex: 0,
        currentLife: null,
        initialVelocity: null,
      } as Particle;

      // Hide modal and cleanup
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);

      this.selectParticle(newParticle);
    };

    // Handle cancel
    const cancelHandler = () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
    };

    // Handle enter key
    const enterHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        confirmHandler();
        input.removeEventListener("keypress", enterHandler);
      } else if (e.key === "Escape") {
        cancelHandler();
        input.removeEventListener("keypress", enterHandler);
      }
    };

    confirmBtn?.addEventListener("click", confirmHandler);
    cancelBtn?.addEventListener("click", cancelHandler);
    input.addEventListener("keypress", enterHandler);
  }

  private async saveParticle() {
    const particle = this.getFormData();

    if (!particle.name) {
      alert("Particle name is required");
      return;
    }

    try {
      const sendRequest = (window as any).sendRequest;
      if (sendRequest) {
        // Serialize vectors as comma-separated strings and exclude scale
        const { scale, currentLife, initialVelocity, weather, ...particleData } = particle;
        const serializedParticle = {
          ...particleData,
          velocity: `${particle.velocity.x},${particle.velocity.y}`,
          gravity: `${particle.gravity.x},${particle.gravity.y}`,
          localposition: `${particle.localposition?.x || 0},${particle.localposition?.y || 0}`,
          spread: `${particle.spread.x},${particle.spread.y}`,
          zIndex: particle.zIndex || 0,
        };

        sendRequest({
          type: "SAVE_PARTICLE",
          data: serializedParticle,
        });

        // Reload particles list after saving to include the newly created particle
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for server to process
        await this.loadParticles();

        // Use the form data we just saved (not the reloaded data) to ensure latest values
        this.selectedParticle = particle;
        this.populateForm(particle);
        this.refreshParticleList();
        // Clear dirty flag after saving
        this.isDirty = false;
        this.updateParticleNameDisplay();
        // Show properties and preview panels (keep preview rendering without interruption)
        this.setPropertiesPanelVisible(true);
        this.setPreviewPanelVisible(true);
      } else {
        console.error("sendRequest not available");
      }
    } catch (error) {
      console.error("Error saving particle:", error);
    }
  }

  private resetParticle() {
    if (!this.selectedParticle) {
      alert("Please select a particle to reset");
      return;
    }

    // Reload the particle from the current selected particle (undoing any unsaved changes)
    this.populateForm(this.selectedParticle);
    this.isDirty = false;
    this.updateParticleNameDisplay();
    this.updatePreview();
  }

  private async deleteParticle() {
    if (!this.selectedParticle?.name) {
      alert("Please select a particle to delete");
      return;
    }

    const modal = document.getElementById("pe-delete-particle-modal");
    const nameElement = document.getElementById("pe-delete-particle-name");
    const confirmBtn = document.getElementById("pe-delete-confirm");
    const cancelBtn = document.getElementById("pe-delete-cancel");

    if (!modal || !nameElement) return;

    // Show modal with particle name
    nameElement.textContent = this.selectedParticle.name;
    modal.classList.add("visible");

    // Handle confirm
    const confirmHandler = async () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
      document.removeEventListener("keypress", enterHandler);

      try {
        const sendRequest = (window as any).sendRequest;
        if (sendRequest) {
          sendRequest({
            type: "DELETE_PARTICLE",
            data: { name: this.selectedParticle!.name },
          });
          this.selectedParticle = null;
          // Close properties and preview panels
          this.setPropertiesPanelVisible(false);
          this.setPreviewPanelVisible(false);
          // Reset preview
          this.updatePreview();
          // Reload particles list
          this.loadParticles();
        } else {
          console.error("sendRequest not available");
        }
      } catch (error) {
        console.error("Error deleting particle:", error);
      }
    };

    // Handle cancel
    const cancelHandler = () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
      document.removeEventListener("keypress", enterHandler);
    };

    // Handle enter/escape keys
    const enterHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        confirmHandler();
      } else if (e.key === "Escape") {
        cancelHandler();
      }
    };

    confirmBtn?.addEventListener("click", confirmHandler);
    cancelBtn?.addEventListener("click", cancelHandler);
    document.addEventListener("keypress", enterHandler);
  }

  private onFormValueChange() {
    // Called when any form input value changes
    if (this.selectedParticle) {
      this.isDirty = true;
      this.updateParticleNameDisplay();
    }
    this.updatePreview();
  }

  private updateParticleNameDisplay() {
    const nameElement = document.getElementById("pe-particle-name");
    if (nameElement && this.selectedParticle) {
      nameElement.textContent = this.selectedParticle.name;
    }
    this.updateDirtyIndicator();
  }

  private updateDirtyIndicator() {
    const indicator = document.getElementById("pe-dirty-indicator");
    if (indicator) {
      indicator.style.display = this.isDirty ? "inline" : "none";
    }
  }

  private updatePreview() {
    // Update preview particles with current form data
    this.previewParticles = [];
    this.lastEmitTime = performance.now();
    this.lastEmitInterval = 0;
  }

  private startPreviewLoop() {
    // Cancel any existing animation loop
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    const renderLoop = () => {
      this.renderPreview();
      this.animationFrameId = requestAnimationFrame(renderLoop);
    };
    this.animationFrameId = requestAnimationFrame(renderLoop);
  }

  private renderPreview() {
    if (!this.previewCanvas || !this.previewContext) return;

    const ctx = this.previewContext;
    const canvas = this.previewCanvas;
    const particle = this.getFormData();

    // Clear canvas
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const timeSinceLastFrame = Math.min(33, now - this.lastEmitTime || 0); // Clamp to 33ms max
    const deltaTime = timeSinceLastFrame / 1000; // Convert to seconds
    this.lastEmitTime = now;

    // Emit new particles - match NPC emission timing (interval in milliseconds based on 16.67ms frame time)
    if (particle.interval && particle.interval > 0) {
      const emitInterval = particle.interval * 16.67;
      this.lastEmitInterval += deltaTime * 1000;

      while (this.lastEmitInterval >= emitInterval && this.previewParticles.length < particle.amount) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;

        // Use same spread calculation as NPC: (Math.random() < 0.5 ? -1 : 1) * Math.random() * spread
        const spreadX = (Math.random() < 0.5 ? -1 : 1) * Math.random() * particle.spread.x;
        const spreadY = (Math.random() < 0.5 ? -1 : 1) * Math.random() * particle.spread.y;

        this.previewParticles.push({
          x: canvas.width / 2 + (particle.localposition?.x || 0) + spreadX,
          y: canvas.height / 2 + (particle.localposition?.y || 0) + spreadY,
          vx: particle.velocity.x,
          vy: particle.velocity.y,
          lifetime: baseLifetime + randomLifetimeExtension,
          currentLife: baseLifetime + randomLifetimeExtension,
          size: particle.size || 5,
          color: particle.color || "white",
        });

        this.lastEmitInterval -= emitInterval;
      }
    }

    // Set additive blend mode to match in-game rendering
    ctx.globalCompositeOperation = 'lighter';

    // Update and render particles
    for (let i = this.previewParticles.length - 1; i >= 0; i--) {
      const p = this.previewParticles[i];

      // Update lifetime
      p.currentLife -= deltaTime * 1000;

      // Remove dead particles
      if (p.currentLife <= 0) {
        this.previewParticles.splice(i, 1);
        continue;
      }

      // Update physics - match NPC physics
      p.vy += particle.gravity.y * deltaTime;
      p.vx += particle.gravity.x * deltaTime;

      // Clamp velocity to match NPC velocity limiting
      const maxVelocityX = Math.abs(particle.velocity.x);
      const maxVelocityY = Math.abs(particle.velocity.y);
      p.vx = Math.min(Math.max(p.vx, -maxVelocityX), maxVelocityX);
      p.vy = Math.min(Math.max(p.vy, -maxVelocityY), maxVelocityY);

      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;

      // Render particle with fade in/out like NPC
      const fadeInDuration = p.lifetime * 0.4;
      const fadeOutDuration = p.lifetime * 0.4;
      let alpha;

      if (p.lifetime - p.currentLife < fadeInDuration) {
        // Fade in
        alpha = ((p.lifetime - p.currentLife) / fadeInDuration) * particle.opacity;
      } else if (p.currentLife < fadeOutDuration) {
        // Fade out
        alpha = (p.currentLife / fadeOutDuration) * particle.opacity;
      } else {
        // Full opacity
        alpha = particle.opacity;
      }

      ctx.globalAlpha = alpha;

      // Draw particle with radial gradient to match in-game rendering exactly
      const radius = p.size / 2;
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      gradient.addColorStop(0, p.color);
      gradient.addColorStop(1, p.color + "00");

      // Add glow effect with shadow
      ctx.shadowColor = p.color;
      ctx.shadowBlur = Math.max(4, radius * 0.8);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Reset shadow
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    // Reset blend mode and alpha
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Draw guide lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private cleanup() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}

const particleEditor = new ParticleEditor();
(window as any).particleEditor = particleEditor;
export default particleEditor;
