import {
  windBurst,
  calculateWindSpeed,
  applyWindVelocity,
  getWindBias,
} from "./windphysics.ts";

class ParticleEditor {
  public isActive: boolean = false;
  private selectedParticle: Particle | null = null;
  private particles: Particle[] = [];
  private previewParticles: Array<any> = [];
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
  private lastFrameTime: number = 0;

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
      "pe-particle-glow-intensity",
      "pe-particle-time",
      "pe-particle-time-on",
      "pe-particle-time-off",
    ];

    const checkboxIds = new Set([
      "pe-particle-visible",
      "pe-particle-weather",
      "pe-particle-time",
    ]);

    for (const id of inputIds) {
      const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
      if (element) {
        this.formInputs[id] = element;
        // Store initial value to detect actual changes
        if (checkboxIds.has(id)) {
          element.setAttribute("data-initial-value", (element as HTMLInputElement).checked ? "true" : "false");
        } else {
          element.setAttribute("data-initial-value", element.value);
        }
        // Use 'change' event for checkboxes, 'input' for other elements
        const eventType = checkboxIds.has(id) ? "change" : "input";
        element.addEventListener(eventType, () => this.onFormValueChange());
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

    // Close button for properties panel
    const propertiesPanel = document.getElementById("particle-editor-properties-panel");
    if (propertiesPanel) {
      const closeBtn = propertiesPanel.querySelector(".pe-panel-close") as HTMLButtonElement;
      if (closeBtn) {
        closeBtn.addEventListener("click", () => this.setPropertiesPanelVisible(false));
      }
    }

    // Search input
    const searchInput = document.getElementById("pe-particle-search") as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.refreshParticleList();
      });
    }

    // Affected by time checkbox - toggle visible checkbox readonly state
    const affectedByTimeCheckbox = document.getElementById("pe-particle-time") as HTMLInputElement;
    const visibleCheckbox = document.getElementById("pe-particle-visible") as HTMLInputElement;
    const timeOnInput = document.getElementById("pe-particle-time-on") as HTMLInputElement;
    const timeOffInput = document.getElementById("pe-particle-time-off") as HTMLInputElement;

    const updateVisibleCheckbox = () => {
      if (!affectedByTimeCheckbox || !visibleCheckbox) return;

      if (affectedByTimeCheckbox.checked) {
        visibleCheckbox.disabled = true;
        visibleCheckbox.checked = true;
      } else {
        visibleCheckbox.disabled = false;
      }
    };

    if (affectedByTimeCheckbox && visibleCheckbox) {
      affectedByTimeCheckbox.addEventListener("change", updateVisibleCheckbox);
    }

    // Also update visible checkbox when time inputs change
    if (timeOnInput) {
      timeOnInput.addEventListener("change", updateVisibleCheckbox);
    }
    if (timeOffInput) {
      timeOffInput.addEventListener("change", updateVisibleCheckbox);
    }

    // Tab switching functionality
    const tabButtons = document.querySelectorAll(".pe-tab-button");
    const tabPanels = document.querySelectorAll(".pe-tab-panel");

    tabButtons.forEach((button) => {
      button.addEventListener("click", (e) => {
        const tabName = (button as HTMLElement).getAttribute("data-tab");
        if (!tabName) return;

        // Remove active class from all buttons
        tabButtons.forEach((btn) => btn.classList.remove("pe-tab-active"));
        // Hide all tab panels
        tabPanels.forEach((panel) => {
          (panel as HTMLElement).style.display = "none";
        });

        // Add active class to clicked button
        (button as HTMLElement).classList.add("pe-tab-active");
        // Show corresponding tab panel
        const targetPanel = document.querySelector(`.pe-tab-${tabName}-panel`) as HTMLElement;
        if (targetPanel) {
          targetPanel.style.display = "block";
        }

        // Store tab preference
        if (this.selectedParticle) {
          localStorage.setItem(`pe-tab-preference-${this.selectedParticle.name}`, tabName);
        }
      });
    });
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
          // Don't drag if clicking on buttons
          if ((e.target as HTMLElement).closest("button")) {
            return;
          }
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
      item.className = "pe-particle-item ui";
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
    // Update visible checkbox state based on time
    this.updateVisibleStateBasedOnTime();
    // Clear preview when switching particles
    this.updatePreview();
    // Show properties and preview panels when a particle is selected
    this.setPropertiesPanelVisible(true);
    this.setPreviewPanelVisible(true);

    // Restore saved tab preference
    const savedTab = localStorage.getItem(`pe-tab-preference-${particle.name}`);
    if (savedTab) {
      const tabButton = document.querySelector(`[data-tab="${savedTab}"]`) as HTMLElement;
      if (tabButton) {
        tabButton.click();
      }
    }
  }

  /**
   * Coerce any value to a boolean, handling strings, numbers, and actual booleans
   * "0", 0, false, null, undefined, "" -> false
   * "1", 1, true, "true", "yes" -> true
   */
  private coerceToBoolean(value: any): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const lower = value.toLowerCase().trim();
      return lower === "1" || lower === "true" || lower === "yes";
    }
    return Boolean(value);
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
    if (inputs["pe-particle-visible"]) (inputs["pe-particle-visible"] as HTMLInputElement).checked = this.coerceToBoolean(particle.visible);
    if (inputs["pe-particle-weather"]) (inputs["pe-particle-weather"] as HTMLInputElement).checked = this.coerceToBoolean(particle.affected_by_weather);
    if (inputs["pe-particle-zindex"]) inputs["pe-particle-zindex"].value = String((particle as any).zIndex || 0);
    if (inputs["pe-particle-glow-intensity"]) {
      inputs["pe-particle-glow-intensity"].value = String((particle as any).glow_intensity || 0);
    }
    if (inputs["pe-particle-time"]) (inputs["pe-particle-time"] as HTMLInputElement).checked = this.coerceToBoolean((particle as any).affected_by_time);
    if (inputs["pe-particle-time-on"]) inputs["pe-particle-time-on"].value = (particle as any).time_on || "";
    if (inputs["pe-particle-time-off"]) inputs["pe-particle-time-off"].value = (particle as any).time_off || "";

    // Disable visible checkbox if affected_by_time is enabled
    const visibleCheckbox = inputs["pe-particle-visible"] as HTMLInputElement;
    const affectedByTime = this.coerceToBoolean((particle as any).affected_by_time);
    if (visibleCheckbox) {
      visibleCheckbox.disabled = affectedByTime;
      if (affectedByTime) {
        visibleCheckbox.checked = true;
      }
    }
  }

  private getFormData(): Particle {
    const inputs = this.formInputs;
    // Get particle name from text element (not an input)
    const nameElement = document.getElementById("pe-particle-name");
    const particleName = nameElement?.textContent || null;

    // If affected_by_time is enabled, visible must always be true (time controls visibility)
    const affectedByTime = (inputs["pe-particle-time"] as HTMLInputElement).checked;
    const visible = affectedByTime ? true : (inputs["pe-particle-visible"] as HTMLInputElement).checked;

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
      visible: visible,
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
      weather: (inputs["pe-particle-weather"] as HTMLInputElement).checked ? {
        name: "rainy",
        wind_speed: 20,
        wind_direction: "left",
        ambience: 0,
        temperature: 15,
        humidity: 80,
        precipitation: 5,
      } : "none",
      affected_by_weather: (inputs["pe-particle-weather"] as HTMLInputElement).checked,
      zIndex: Number((inputs["pe-particle-zindex"] as HTMLInputElement).value) || 0,
      glow_intensity: inputs["pe-particle-glow-intensity"] ? Number((inputs["pe-particle-glow-intensity"] as HTMLInputElement).value) || 0 : 0,
      affected_by_time: (inputs["pe-particle-time"] as HTMLInputElement).checked,
      time_on: (inputs["pe-particle-time-on"] as HTMLInputElement).value || null,
      time_off: (inputs["pe-particle-time-off"] as HTMLInputElement).value || null,
      currentLife: null,
      initialVelocity: null,
    } as Particle;
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
        scale: 1,
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
        glow_intensity: 0,
        affected_by_time: false,
        time_on: null,
        time_off: null,
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
    this.updateVisibleStateBasedOnTime();
    this.updatePreview();
  }

  private updateVisibleStateBasedOnTime() {
    const inputs = this.formInputs;
    const affectedByTime = (inputs["pe-particle-time"] as HTMLInputElement)?.checked;
    const visibleCheckbox = inputs["pe-particle-visible"] as HTMLInputElement;

    if (!visibleCheckbox || !affectedByTime) return;

    const timeOn = (inputs["pe-particle-time-on"] as HTMLInputElement)?.value;
    const timeOff = (inputs["pe-particle-time-off"] as HTMLInputElement)?.value;

    if (timeOn && timeOff) {
      const now = new Date();
      const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      let isVisible: boolean;
      if (timeOn < timeOff) {
        // Normal case: time_on < time_off (e.g., 09:00 to 18:00)
        isVisible = currentTimeStr >= timeOn && currentTimeStr < timeOff;
      } else if (timeOn > timeOff) {
        // Wrapped case: time_on > time_off (e.g., 22:00 to 06:00, wraps midnight)
        isVisible = currentTimeStr >= timeOn || currentTimeStr < timeOff;
      } else {
        // Same time, always visible
        isVisible = true;
      }

      visibleCheckbox.checked = isVisible;
    }
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

    // Flip canvas horizontally for preview display
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);

    const now = performance.now();
    let deltaTime = (now - this.lastFrameTime) / 1000; // Convert to seconds (matches renderer.ts)
    // Clamp deltaTime to max 16.67ms (60 FPS) to prevent large jumps when tab loses focus
    deltaTime = Math.min(deltaTime, 0.01667);
    const deltaTimeMs = deltaTime * 1000; // Back to milliseconds for wind burst
    this.lastFrameTime = now;

    // Update wind burst cycle - creates pulsating wind effect
    windBurst.update(deltaTimeMs);

    // Emit new particles - match NPC emission timing (interval in milliseconds based on 16.67ms frame time)
    if (particle.interval && particle.interval > 0) {
      const emitInterval = particle.interval / 60 * 1000; // Frame-rate independent: convert 60 FPS frame interval to milliseconds
      this.lastEmitInterval += deltaTime * 1000;

      while (this.lastEmitInterval >= emitInterval && this.previewParticles.length < particle.amount) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;

        // Get wind bias for initial velocity
        const weatherData = typeof particle.weather === 'object' ? particle.weather : null;
        const windDirection = weatherData?.wind_direction || null;
        const windSpeed = weatherData?.wind_speed || 0;
        const windBias = getWindBias(windSpeed, windDirection);

        // Use same spread calculation as NPC: (Math.random() < 0.5 ? -1 : 1) * Math.random() * spread
        const spreadX = (Math.random() < 0.5 ? -1 : 1) * Math.random() * particle.spread.x;
        const spreadY = (Math.random() < 0.5 ? -1 : 1) * Math.random() * particle.spread.y;

        this.previewParticles.push({
          x: canvas.width / 2 + (particle.localposition?.x || 0) + spreadX,
          y: canvas.height / 2 + (particle.localposition?.y || 0) + spreadY,
          vx: particle.velocity.x + windBias.x,
          vy: particle.velocity.y + windBias.y,
          lifetime: baseLifetime + randomLifetimeExtension,
          currentLife: baseLifetime + randomLifetimeExtension,
          size: particle.size || 5,
          color: particle.color || "white",
          glow_intensity: particle.glow_intensity || 0,
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

      // Apply weather effects if affected_by_weather is enabled
      let windSpeed = 0;
      let windDirection = null;
      if (particle.affected_by_weather) {
        const weatherData = typeof particle.weather === 'object' ? particle.weather : null;
        const baseWindSpeed = weatherData?.wind_speed || 0;
        windSpeed = calculateWindSpeed(
          baseWindSpeed,
          windBurst.getIntensity()
        );
        windDirection = weatherData?.wind_direction || null;
      }

      // Update physics - apply gravity
      p.vy += particle.gravity.y * deltaTime;
      p.vx += particle.gravity.x * deltaTime;

      // Clamp velocity based on base particle velocity only
      const maxVelX = Math.abs(particle.velocity.x) || 1;
      const maxVelY = Math.abs(particle.velocity.y) || 1;

      // Apply wind velocity clamping using shared function (matches npc.ts)
      const newVelocity = applyWindVelocity(
        p.vx,
        p.vy,
        windSpeed,
        windDirection,
        maxVelX,
        maxVelY
      );
      p.vx = newVelocity.vx;
      p.vy = newVelocity.vy;

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

      // Add glow effect with shadow based on glow_intensity
      if (p.glow_intensity > 0) {
        ctx.shadowColor = p.color;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        // Draw multiple glow layers for stronger effect
        const baseBlur = Math.max(4, radius * 0.8);
        const glowLayers = Math.ceil(p.glow_intensity);
        const glowOpacity = (p.glow_intensity - Math.floor(p.glow_intensity));

        // Draw main glow layers
        for (let g = 0; g < glowLayers; g++) {
          ctx.shadowBlur = baseBlur + (g * 8 * p.glow_intensity);
          ctx.globalAlpha = alpha * Math.max(0.3, 1 - (g * 0.2));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
          ctx.fill();
        }

        // Draw partial glow layer if fractional intensity
        if (glowOpacity > 0) {
          ctx.shadowBlur = baseBlur + ((glowLayers - 1) * 8 * p.glow_intensity);
          ctx.globalAlpha = alpha * glowOpacity * 0.5;
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
          ctx.fill();
        }

        // Restore alpha and reset shadow
        ctx.globalAlpha = alpha;
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      } else {
        // No glow when intensity is 0
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Reset blend mode and alpha
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Restore canvas transform (undo flip)
    ctx.restore();

    // Draw guide lines (after restore so they're not flipped)
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
