import { getCameraX, getCameraY } from "./renderer.js";
import Cache from "./cache.js";
import { sendRequest } from "./socket.js";
import { reinitEntitySprite } from "./entity.js";

const cache = Cache.getInstance();

const ENTITY_HIT_W = 32;
const ENTITY_HIT_H = 48;

class EntityEditor {
  public isActive: boolean = false;
  private selectedEntity: any = null;
  private entities: any[] = [];
  private isDirty: boolean = false;
  private currentMode: 'entities' | 'spawnpoints' = 'entities';

  private draggingEntity: any = null;
  private dragStarted: boolean = false;
  private dragOffsetX: number = 0;
  private dragOffsetY: number = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  private container: HTMLElement | null = null;
  private propertiesPanel: HTMLElement | null = null;
  private entityListPanel: HTMLElement | null = null;
  private entityListEl: HTMLElement | null = null;
  private availableParticles: string[] = [];
  private particleDefinitions: Map<string, any> = new Map();

  constructor() {
    this.boundMouseDown = this.onMouseDown.bind(this);
    this.boundMouseMove = this.onMouseMove.bind(this);
    this.boundMouseUp = this.onMouseUp.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);
  }

  public toggle() {
    this.isActive = !this.isActive;
    const container = document.getElementById("entity-editor-container");
    if (!container) {
      return;
    }
    container.style.display = this.isActive ? "block" : "none";
    if (this.isActive) {
      if (!this.container) {
        this.createUI();
        this.setupPanelDragAndMinimize();
        this.loadStoredPanelStates();
      }
      // Ensure panels are visible when reopening
      if (this.entityListPanel) {
        this.entityListPanel.style.display = "flex";
      }
      if (this.propertiesPanel) {
        this.propertiesPanel.style.display = "none"; // Keep properties hidden until an entity is selected
      }
      this.loadEntities();
      this.loadParticleOptions();
      this.selectedEntity = null;
      this.isDirty = false;
      this.setPropertiesPanelVisible(false);
      document.addEventListener("mousedown", this.boundMouseDown, { capture: true });
      document.addEventListener("mousemove", this.boundMouseMove);
      document.addEventListener("mouseup", this.boundMouseUp);
      document.addEventListener("keydown", this.boundKeyDown);
    } else {
      this.stopDrag();
      document.removeEventListener("mousedown", this.boundMouseDown, { capture: true });
      document.removeEventListener("mousemove", this.boundMouseMove);
      document.removeEventListener("mouseup", this.boundMouseUp);
      document.removeEventListener("keydown", this.boundKeyDown);
    }
  }

  private screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: Math.floor(clientX - window.innerWidth / 2 + getCameraX()),
      y: Math.floor(clientY - window.innerHeight / 2 + getCameraY()),
    };
  }

  private findEntityAtWorld(wx: number, wy: number): { live: any; data: any } | null {
    for (const liveEntity of cache.entities) {
      const ex = liveEntity.position?.x ?? 0;
      const ey = liveEntity.position?.y ?? 0;
      if (wx >= ex - ENTITY_HIT_W / 2 && wx <= ex + ENTITY_HIT_W / 2 &&
          wy >= ey - ENTITY_HIT_H / 2 && wy <= ey + ENTITY_HIT_H / 2) {
        const data = this.entities.find((e) => e.id === liveEntity.id) ?? null;
        return { live: liveEntity, data };
      }
    }
    return null;
  }

  private onMouseDown(e: MouseEvent) {
    if (!this.isActive || this.currentMode !== 'entities') return;
    if ((e.target as HTMLElement).closest(".ee-floating-panel")) return;

    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);
    const found = this.findEntityAtWorld(wx, wy);

    if (e.button === 0) {
      if (found) {
        this.selectedEntity = found.data;
        this.draggingEntity = found.live;
        this.dragStarted = false;
        this.dragOffsetX = found.live.position.x - wx;
        this.dragOffsetY = found.live.position.y - wy;
        this.updatePropertiesPanel();
        this.setPropertiesPanelVisible(true);
      }
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.draggingEntity) return;
    const { x: wx, y: wy } = this.screenToWorld(e.clientX, e.clientY);
    const newX = wx + this.dragOffsetX;
    const newY = wy + this.dragOffsetY;

    if (!this.dragStarted && (Math.abs(newX - this.draggingEntity.position.x) > 5 ||
        Math.abs(newY - this.draggingEntity.position.y) > 5)) {
      this.dragStarted = true;
    }

    if (this.dragStarted) {
      this.draggingEntity.position.x = newX;
      this.draggingEntity.position.y = newY;
      if (this.selectedEntity) {
        this.selectedEntity.position = { ...this.selectedEntity.position, x: newX, y: newY };
        // Update the form fields to reflect the dragged position
        const xInput = this.propertiesPanel?.querySelector("input[data-field='position']") as HTMLInputElement;
        if (xInput) {
          // Update position display in form
          this.updatePropertiesPanel();
        }
      }
      this.isDirty = true;
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (this.dragStarted && this.draggingEntity && this.selectedEntity) {
      this.isDirty = true;
      this.updateEntityInUI();
      // Update form to show new position
      this.updatePropertiesPanel();
    }
    this.stopDrag();
  }

  private stopDrag() {
    this.draggingEntity = null;
    this.dragStarted = false;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "s" && e.ctrlKey) {
      e.preventDefault();
      if (this.selectedEntity && this.isDirty) {
        this.saveEntity();
      }
    }
  }

  private createUI() {
    try {
      this.container = document.getElementById("entity-editor-container");
      if (!this.container) {
        console.error("Entity editor container not found in DOM");
        return;
      }
      this.container.style.position = "fixed";
      this.container.style.top = "0";
      this.container.style.left = "0";
      this.container.style.width = "100%";
      this.container.style.height = "100%";
      this.container.style.zIndex = "9999";
      this.container.style.pointerEvents = "none";

      // List panel
      this.entityListPanel = document.createElement("div");
      this.entityListPanel.id = "entity-editor-list-panel";
      this.entityListPanel.className = "ee-floating-panel";
      this.entityListPanel.style.left = "50px";
      this.entityListPanel.style.top = "50px";
      this.entityListPanel.style.width = "300px";
      this.entityListPanel.style.display = "flex";
      this.entityListPanel.style.flexDirection = "column";
      this.entityListPanel.style.zIndex = "1000";
      this.entityListPanel.style.pointerEvents = "auto";

      const listHeader = document.createElement("div");
      listHeader.className = "ee-panel-header";
      const listTitle = document.createElement("span");
      listTitle.className = "ee-panel-title";
      listTitle.textContent = "Entities";
      listHeader.appendChild(listTitle);

      const listMinimizeBtn = document.createElement("button");
      listMinimizeBtn.className = "ee-panel-minimize";
      listMinimizeBtn.textContent = "−";
      listHeader.appendChild(listMinimizeBtn);

      const listCloseBtn = document.createElement("button");
      listCloseBtn.className = "ee-panel-close";
      listCloseBtn.textContent = "×";
      listHeader.appendChild(listCloseBtn);

      const listContent = document.createElement("div");
      listContent.className = "ee-panel-content";

      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.placeholder = "Search entities...";
      searchInput.setAttribute("data-search", "entities");
      searchInput.setAttribute("autocorrect", "off");
      searchInput.setAttribute("autocomplete", "off");
      searchInput.setAttribute("spellcheck", "false");
      searchInput.style.marginBottom = "8px";

      this.entityListEl = document.createElement("div");

      const newEntityBtn = document.createElement("button");
      newEntityBtn.id = "ee-new-entity";
      newEntityBtn.textContent = "+ New Entity";

      listContent.appendChild(searchInput);
      listContent.appendChild(this.entityListEl);
      listContent.appendChild(newEntityBtn);

      this.entityListPanel.appendChild(listHeader);
      this.entityListPanel.appendChild(listContent);

      // Properties panel
      this.propertiesPanel = document.createElement("div");
      this.propertiesPanel.id = "entity-editor-properties-panel";
      this.propertiesPanel.className = "ee-floating-panel";
      this.propertiesPanel.style.right = "50px";
      this.propertiesPanel.style.top = "50px";
      this.propertiesPanel.style.width = "350px";
      this.propertiesPanel.style.display = "none";
      this.propertiesPanel.style.flexDirection = "column";
      this.propertiesPanel.style.zIndex = "1000";
      this.propertiesPanel.style.pointerEvents = "auto";

      const propsHeader = document.createElement("div");
      propsHeader.className = "ee-panel-header";

      const saveBtn = document.createElement("button");
      saveBtn.id = "ee-save-entity-header";
      saveBtn.className = "ee-panel-save";
      saveBtn.textContent = "💾";
      saveBtn.title = "Save Entity";
      propsHeader.appendChild(saveBtn);

      const propsTitle = document.createElement("span");
      propsTitle.className = "ee-panel-title";
      propsTitle.textContent = "Properties";
      propsHeader.appendChild(propsTitle);

      const propsMinimizeBtn = document.createElement("button");
      propsMinimizeBtn.className = "ee-panel-minimize";
      propsMinimizeBtn.textContent = "−";
      propsHeader.appendChild(propsMinimizeBtn);

      const closeBtn = document.createElement("button");
      closeBtn.className = "ee-panel-close";
      closeBtn.textContent = "×";
      propsHeader.appendChild(closeBtn);

      const propsContent = document.createElement("div");
      propsContent.className = "ee-panel-content";

      const fields = [
        { label: "Name", field: "name", type: "text" },
        { label: "Aggro Type", field: "aggro_type", type: "select", options: ["friendly", "neutral", "aggressive"] },
        { label: "Level", field: "level", type: "number", min: 1, max: 100 },
        { label: "Max Health", field: "max_health", type: "number", min: 1, max: 9999 },
        { label: "Speed", field: "speed", type: "number", min: 0, max: 1000 },
        { label: "Aggro Range", field: "aggro_range", type: "number", min: 0, max: 9999 },
        { label: "Aggro Leash", field: "aggro_leash", type: "number", min: 0, max: 9999 },
        { label: "Sprite Body", field: "sprite_body", type: "text" },
        { label: "Sprite Head", field: "sprite_head", type: "text" },
        { label: "Sprite Helmet", field: "sprite_helmet", type: "text" },
        { label: "Sprite Shoulder Guards", field: "sprite_shoulderguards", type: "text" },
        { label: "Sprite Neck", field: "sprite_neck", type: "text" },
        { label: "Sprite Hands", field: "sprite_hands", type: "text" },
        { label: "Sprite Chest", field: "sprite_chest", type: "text" },
        { label: "Sprite Feet", field: "sprite_feet", type: "text" },
        { label: "Sprite Legs", field: "sprite_legs", type: "text" },
        { label: "Sprite Weapon", field: "sprite_weapon", type: "text" }
      ];

      fields.forEach(fieldConfig => {
        const group = document.createElement("div");
        const label = document.createElement("label");
        label.textContent = fieldConfig.label;

        let input: HTMLElement;
        if (fieldConfig.type === "select") {
          input = document.createElement("select");
          (fieldConfig.options || []).forEach(opt => {
            const option = document.createElement("option");
            option.value = opt;
            option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
            (input as HTMLSelectElement).appendChild(option);
          });
        } else {
          input = document.createElement("input");
          (input as HTMLInputElement).type = fieldConfig.type;
          if (fieldConfig.type === "number") {
            (input as HTMLInputElement).min = String(fieldConfig.min || 1);
            (input as HTMLInputElement).max = String(fieldConfig.max || 100);
          } else if (fieldConfig.type === "text") {
            // Disable autocorrect on text fields
            (input as HTMLInputElement).setAttribute("autocorrect", "off");
            (input as HTMLInputElement).setAttribute("autocomplete", "off");
            (input as HTMLInputElement).setAttribute("spellcheck", "false");
          }
        }

        (input as any).setAttribute("data-field", fieldConfig.field);

        group.appendChild(label);
        group.appendChild(input);
        propsContent.appendChild(group);
      });

      const particlesGroup = document.createElement("div");
      const particlesLabel = document.createElement("label");
      particlesLabel.textContent = "Particles";
      const particlesSearch = document.createElement("input");
      particlesSearch.type = "text";
      particlesSearch.placeholder = "Search particles...";
      particlesSearch.setAttribute("data-search", "particles");
      particlesSearch.setAttribute("autocorrect", "off");
      particlesSearch.setAttribute("autocomplete", "off");
      particlesSearch.setAttribute("spellcheck", "false");
      const particlesList = document.createElement("div");
      particlesList.setAttribute("data-particles-list", "true");
      particlesList.style.maxHeight = "200px";
      particlesList.style.overflowY = "auto";

      particlesGroup.appendChild(particlesLabel);
      particlesGroup.appendChild(particlesSearch);
      particlesGroup.appendChild(particlesList);
      propsContent.appendChild(particlesGroup);

      // Add event listener for particle search input
      particlesSearch.addEventListener("input", () => this.updateParticlesList());
      particlesSearch.addEventListener("click", (e) => e.stopPropagation());

      const deleteBtn = document.createElement("button");
      deleteBtn.id = "ee-delete-entity";
      deleteBtn.textContent = "Delete";
      propsContent.appendChild(deleteBtn);

      this.propertiesPanel.appendChild(propsHeader);
      this.propertiesPanel.appendChild(propsContent);

      this.container!.appendChild(this.entityListPanel);
      this.container!.appendChild(this.propertiesPanel);

      // Event listeners
      newEntityBtn.addEventListener("click", () => this.createNewEntity());
      listCloseBtn.addEventListener("click", () => { this.toggle(); }); // Close entire editor when X is clicked on list panel
      closeBtn.addEventListener("click", () => this.setPropertiesPanelVisible(false));
      saveBtn.addEventListener("click", () => this.saveEntity());
      deleteBtn.addEventListener("click", () => this.deleteEntity());
      searchInput.addEventListener("input", () => this.updateEntityList());
    } catch (error) {
      console.error("Error creating entity editor UI:", error);
    }
  }

  private setupPanelDragAndMinimize() {
    const panels = [
      { panel: this.entityListPanel, storageKey: "ee-list-pos" },
      { panel: this.propertiesPanel, storageKey: "ee-props-pos" },
    ];

    for (const { panel, storageKey } of panels) {
      if (!panel) continue;

      const header = panel.querySelector(".ee-panel-header") as HTMLElement;
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

      const minimizeBtn = panel.querySelector(".ee-panel-minimize");
      if (minimizeBtn) {
        minimizeBtn.addEventListener("click", () => {
          const content = panel!.querySelector(".ee-panel-content") as HTMLElement;
          if (content) {
            content.style.display =
              content.style.display === "none" ? "block" : "none";
          }
          panel!.classList.toggle("minimized");
        });
      }
    }
  }

  private loadStoredPanelStates() {
    const panels = [
      { panel: this.entityListPanel, storageKey: "ee-list-pos", defaultX: 50, defaultY: 50 },
      { panel: this.propertiesPanel, storageKey: "ee-props-pos", defaultX: 400, defaultY: 50 },
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

  private loadEntities() {
    sendRequest({ type: "LIST_ENTITIES", data: null });
  }

  public setEntities(entities: any[]) {
    this.entities = Array.isArray(entities) ? entities : [];
    // Resolve particles for all entities if definitions are available
    for (const entity of this.entities) {
      if (this.particleDefinitions.size > 0) {
        this.resolveEntityParticles(entity);
      }
    }
    // Don't update cached entities here - only for UI editing
    this.updateEntityList();
  }

  private resolveEntityParticles(entity: any) {
    if (!entity.particles) return;

    // Convert particle names (strings) to full particle objects
    if (Array.isArray(entity.particles)) {
      entity.particles = entity.particles.map((p: any) => {
        // If it's already a full object with properties, normalize it
        if (typeof p === 'object' && p !== null && p.name && p.size !== undefined) {
          return this.normalizeParticle(p);
        }
        // If it's a string, look up the full definition
        if (typeof p === 'string') {
          const definition = this.particleDefinitions.get(p);
          if (definition) {
            return this.normalizeParticle(definition);
          }
          // Fallback: create a normalized particle with required properties
          return this.normalizeParticle({ name: p });
        }
        // If it's an object but missing properties, treat it as a name lookup
        if (typeof p === 'object' && p !== null && p.name && typeof p.name === 'string') {
          const definition = this.particleDefinitions.get(p.name);
          if (definition) {
            return this.normalizeParticle(definition);
          }
          return this.normalizeParticle(p);
        }
        return this.normalizeParticle(p);
      });
    }
  }

  private normalizeParticle(particle: any): any {
    return {
      name: particle.name || 'unknown',
      size: particle.size !== undefined ? particle.size : 5,
      color: particle.color || '#ffffff',
      velocity: particle.velocity || { x: 0, y: 0 },
      lifetime: particle.lifetime !== undefined ? particle.lifetime : 1000,
      scale: particle.scale !== undefined ? particle.scale : 1,
      opacity: particle.opacity !== undefined ? particle.opacity : 1,
      visible: particle.visible !== false,
      gravity: particle.gravity || { x: 0, y: 0 },
      localposition: particle.localposition || { x: 0, y: 0 },
      interval: particle.interval !== undefined ? particle.interval : 10,
      amount: particle.amount !== undefined ? particle.amount : 1,
      staggertime: particle.staggertime !== undefined ? particle.staggertime : 0,
      currentLife: particle.currentLife || null,
      initialVelocity: particle.initialVelocity || null,
      spread: particle.spread || { x: 0, y: 0 },
      weather: particle.weather || 'none',
      affected_by_weather: particle.affected_by_weather || false
    };
  }

  public addEntity(entity: any) {
    if (!entity || !entity.id) return;
    // Don't add duplicates
    if (this.entities.some((e) => e.id === entity.id)) return;
    this.entities.push(entity);
    this.updateEntityList();
  }

  public updateEntity(updatedEntity: any) {
    if (!updatedEntity || !updatedEntity.id) return;
    const entityIndex = this.entities.findIndex((e) => e.id === updatedEntity.id);
    if (entityIndex === -1) return;

    // Only update the list, don't update the selected entity if it's being edited
    this.entities[entityIndex] = updatedEntity;

    // Only refresh the list UI if the entity isn't selected
    if (this.selectedEntity?.id !== updatedEntity.id) {
      this.updateEntityList();
    } else {
      // For the selected entity, just update the list rendering without changing the properties
      this.updateEntityList();
    }
  }

  private loadParticleOptions() {
    sendRequest({ type: "LIST_PARTICLES", data: null });
  }

  public setParticleOptions(particles: any[]) {
    if (Array.isArray(particles)) {
      this.availableParticles = particles.map((p: any) => p.name || p);
      // Store full particle definitions for later use
      particles.forEach((p: any) => {
        const name = p.name || p;
        this.particleDefinitions.set(name, p);
      });
      // Re-resolve all loaded entities now that we have particle definitions
      for (const entity of this.entities) {
        this.resolveEntityParticles(entity);
      }
      // If an entity is selected, update its particles display
      if (this.selectedEntity) {
        this.updatePropertiesPanel();
      }
      // Update UI
      this.updateEntityList();
    } else {
      this.availableParticles = [];
      this.particleDefinitions.clear();
    }
  }

  private updateEntityList() {
    if (!this.entityListEl) return;
    this.entityListEl.innerHTML = "";

    const searchInput = this.entityListPanel?.querySelector("input[data-search='entities']") as HTMLInputElement;
    const searchQuery = searchInput?.value?.toLowerCase() || "";
    const filtered = this.entities.filter((e) =>
      (e.name || "").toLowerCase().startsWith(searchQuery)
    );

    for (const entity of filtered) {
      const item = document.createElement("div");
      item.style.padding = "8px";
      item.style.marginBottom = "6px";
      item.style.background = "rgba(255, 255, 255, 0.05)";
      item.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      item.style.borderRadius = "6px";
      item.style.cursor = "pointer";
      item.style.fontSize = "12px";
      item.style.color = "white";
      item.style.transition = "all 0.2s";

      if (this.selectedEntity?.id === entity.id) {
        item.style.background = "rgba(46, 204, 113, 0.3)";
        item.style.borderColor = "rgba(46, 204, 113, 0.6)";
      }

      const name = document.createElement("strong");
      name.style.display = "block";
      name.style.marginBottom = "2px";
      name.textContent = entity.name || "Unnamed";

      // Apply color based on aggro_type
      if (entity.aggro_type === "friendly") {
        name.style.color = "rgba(46, 204, 113, 0.9)"; // Green
      } else if (entity.aggro_type === "aggressive") {
        name.style.color = "rgba(231, 76, 60, 0.9)"; // Red
      } else {
        name.style.color = "rgba(255, 255, 255, 0.8)"; // White (neutral)
      }

      const info = document.createElement("div");
      info.style.fontSize = "11px";
      info.style.color = "rgba(255, 255, 255, 0.7)";
      info.textContent = `Lvl ${entity.level} • ${entity.aggro_type}`;

      item.appendChild(name);
      item.appendChild(info);

      item.addEventListener("click", () => {
        this.selectedEntity = entity;
        this.updateEntityList();
        this.updatePropertiesPanel();
        this.setPropertiesPanelVisible(true);
      });

      item.addEventListener("mouseenter", () => {
        if (this.selectedEntity?.id !== entity.id) {
          item.style.background = "rgba(255, 255, 255, 0.08)";
          item.style.borderColor = "rgba(46, 204, 113, 0.3)";
        }
      });

      item.addEventListener("mouseleave", () => {
        if (this.selectedEntity?.id !== entity.id) {
          item.style.background = "rgba(255, 255, 255, 0.05)";
          item.style.borderColor = "rgba(255, 255, 255, 0.1)";
        }
      });

      this.entityListEl.appendChild(item);
    }
  }

  private updatePropertiesPanel() {
    if (!this.propertiesPanel || !this.selectedEntity) return;

    this.propertiesPanel.querySelectorAll("[data-field]").forEach((field: any) => {
      const fieldName = field.getAttribute("data-field");
      field.value = this.selectedEntity[fieldName] ?? "";
    });

    // Update particles list
    this.updateParticlesList();
  }

  private updateParticlesList() {
    if (!this.propertiesPanel || !this.selectedEntity) return;

    const particlesList = this.propertiesPanel.querySelector("[data-particles-list]") as HTMLElement;
    const particlesSearch = this.propertiesPanel.querySelector("[data-search='particles']") as HTMLInputElement;

    if (!particlesList) return;

    const searchQuery = (particlesSearch?.value || "").toLowerCase();
    const currentParticles = Array.isArray(this.selectedEntity.particles) ? this.selectedEntity.particles : [];
    const currentParticleNames = new Set(currentParticles.map((p: any) => {
      // Extract name properly - handle strings and objects
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && p !== null && typeof p.name === 'string') return p.name;
      return '';
    }).filter(Boolean));

    // Filter available particles
    const filtered = this.availableParticles.filter((name: string) =>
      name.toLowerCase().includes(searchQuery)
    );

    // Clear and rebuild the list
    particlesList.innerHTML = "";

    if (filtered.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.padding = "8px";
      emptyMsg.style.color = "rgba(255, 255, 255, 0.5)";
      emptyMsg.textContent = searchQuery ? "No particles found" : "No particles available";
      particlesList.appendChild(emptyMsg);
      return;
    }

    for (const particleName of filtered) {
      const isActive = currentParticleNames.has(particleName);

      const itemContainer = document.createElement("div");
      itemContainer.style.padding = "8px";
      itemContainer.style.marginBottom = "4px";
      itemContainer.style.background = isActive ? "rgba(100, 200, 100, 0.2)" : "rgba(255, 255, 255, 0.05)";
      itemContainer.style.borderLeft = isActive ? "3px solid #64c864" : "3px solid transparent";
      itemContainer.style.display = "flex";
      itemContainer.style.alignItems = "center";
      itemContainer.style.gap = "8px";
      itemContainer.style.cursor = "pointer";
      itemContainer.style.userSelect = "none";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isActive;
      checkbox.style.cursor = "pointer";
      checkbox.setAttribute("data-particle-name", particleName);

      const label = document.createElement("label");
      label.textContent = particleName;
      label.style.cursor = "pointer";
      label.style.flex = "1";

      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        this.toggleParticleOnEntity(particleName, checkbox.checked);
      });

      itemContainer.addEventListener("click", (e) => {
        e.stopPropagation();
        checkbox.checked = !checkbox.checked;
        this.toggleParticleOnEntity(particleName, checkbox.checked);
      });

      itemContainer.appendChild(checkbox);
      itemContainer.appendChild(label);
      particlesList.appendChild(itemContainer);
    }
  }

  private toggleParticleOnEntity(particleName: string, isActive: boolean) {
    if (!this.selectedEntity) return;

    if (!Array.isArray(this.selectedEntity.particles)) {
      this.selectedEntity.particles = [];
    }

    const particleIndex = this.selectedEntity.particles.findIndex(
      (p: any) => (p.name || p) === particleName
    );

    if (isActive && particleIndex === -1) {
      // Add particle - use normalized definition
      const particleDef = this.particleDefinitions.get(particleName);
      if (particleDef) {
        this.selectedEntity.particles.push(this.normalizeParticle(particleDef));
      } else {
        // Fallback: create normalized particle from name
        this.selectedEntity.particles.push(this.normalizeParticle({ name: particleName }));
      }
      this.isDirty = true;
    } else if (!isActive && particleIndex !== -1) {
      // Remove particle
      this.selectedEntity.particles.splice(particleIndex, 1);
      this.isDirty = true;
    }

    // Update UI to reflect changes
    this.updateParticlesList();
  }

  private updateEntityInUI() {
    if (!this.entityListPanel) return;
    this.updateEntityList();
  }

  private setPropertiesPanelVisible(visible: boolean) {
    if (this.propertiesPanel) {
      this.propertiesPanel.style.display = visible ? "flex" : "none";
    }
  }

  public selectEntity(entity: any) {
    if (!entity || !entity.id) return;

    // Find the entity in our list
    const foundEntity = this.entities.find((e: any) => e.id === entity.id);
    if (!foundEntity) return;

    this.selectedEntity = foundEntity;

    // Sync particles from live cached entity (which has fully resolved particles)
    const cachedEntity = cache.entities.find((e: any) => e.id === entity.id);
    if (cachedEntity && cachedEntity.particles) {
      this.selectedEntity.particles = cachedEntity.particles;
    }

    // Ensure particles are resolved before displaying
    if (this.particleDefinitions.size > 0) {
      this.resolveEntityParticles(this.selectedEntity);
    }

    this.updateEntityList();
    this.updatePropertiesPanel();
    this.setPropertiesPanelVisible(true);
  }

  private createNewEntity() {
    const modal = document.getElementById("ee-new-entity-modal");
    const input = document.getElementById("ee-new-entity-name-input") as HTMLInputElement;
    const confirmBtn = document.getElementById("ee-modal-confirm");
    const cancelBtn = document.getElementById("ee-modal-cancel");

    if (!modal || !input) return;

    // Clear input and show modal
    input.value = "";
    modal.classList.add("visible");
    input.focus();

    // Handle confirm
    const confirmHandler = () => {
      const name = input.value.trim();
      if (!name) {
        alert("Entity name is required");
        return;
      }

      const currentPlayer = Array.from(cache.players)[0];
      const playerPos = currentPlayer?.position || { x: 0, y: 0 };
      const newEntity = {
        name,
        map: currentPlayer?.location?.map || "main",
        position: {
          x: playerPos.x || 0,
          y: playerPos.y || 0,
          direction: "down",
        },
        max_health: 100,
        level: 1,
        aggro_type: "neutral",
        sprite_type: "animated",
        sprite_body: "player_body_base",
        sprite_head: "player_head_base",
        particles: [],
      };

      // Hide modal and cleanup
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);

      sendRequest({ type: "ADD_ENTITY", data: newEntity });

      // Store the entity name so we can auto-select it after loading
      const createdEntityName = name;

      // Reload entity list after the entity is created on the server
      setTimeout(() => {
        this.loadEntities();
        // After list is loaded, find and select the newly created entity
        setTimeout(() => {
          const createdEntity = this.entities.find((e) => e.name === createdEntityName);
          if (createdEntity) {
            this.selectedEntity = createdEntity;
            this.updateEntityList();
            this.updatePropertiesPanel();
            this.setPropertiesPanelVisible(true);
          }
        }, 200);
      }, 300);
    };

    // Handle cancel
    const cancelHandler = () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
    };

    confirmBtn?.addEventListener("click", confirmHandler);
    cancelBtn?.addEventListener("click", cancelHandler);

    // Allow Enter key to confirm
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmHandler();
      if (e.key === "Escape") cancelHandler();
    }, { once: true });
  }

  private saveEntity() {
    if (!this.selectedEntity) return;

    this.propertiesPanel?.querySelectorAll("[data-field]").forEach((field: any) => {
      const fieldName = field.getAttribute("data-field");
      const value = field.value;
      // Keep null/empty values as null, don't convert empty strings to 0
      if (value === "" || value === null) {
        this.selectedEntity[fieldName] = null;
      } else {
        this.selectedEntity[fieldName] = isNaN(value) ? value : Number(value);
      }
    });

    // Update the cached entity object immediately so game world reflects changes
    const cachedEntity = cache.entities.find((e: any) => e.id === this.selectedEntity.id);
    if (cachedEntity) {
      if (this.selectedEntity.aggro_type !== undefined) {
        cachedEntity.aggro_type = this.selectedEntity.aggro_type;
      }
      if (this.selectedEntity.name !== undefined) {
        cachedEntity.name = this.selectedEntity.name;
      }
      if (this.selectedEntity.health !== undefined) {
        cachedEntity.health = this.selectedEntity.health;
      }
      if (this.selectedEntity.level !== undefined) {
        cachedEntity.level = this.selectedEntity.level;
      }
      if (this.selectedEntity.speed !== undefined) {
        cachedEntity.speed = this.selectedEntity.speed;
      }
      if (this.selectedEntity.aggro_range !== undefined) {
        cachedEntity.aggro_range = this.selectedEntity.aggro_range;
      }
      if (this.selectedEntity.aggro_leash !== undefined) {
        cachedEntity.aggro_leash = this.selectedEntity.aggro_leash;
      }
      // Update particles on cached entity with full normalized versions
      if (this.selectedEntity.particles !== undefined) {
        // Ensure cached entity gets full normalized particles
        cachedEntity.particles = Array.isArray(this.selectedEntity.particles)
          ? this.selectedEntity.particles.map((p: any) => {
              // If it's already a normalized object, keep it
              if (typeof p === 'object' && p !== null && p.name && p.size !== undefined) {
                return p;
              }
              // If it's a string, resolve it
              if (typeof p === 'string') {
                const def = this.particleDefinitions.get(p);
                return def ? this.normalizeParticle(def) : this.normalizeParticle({ name: p });
              }
              // Otherwise normalize it
              return this.normalizeParticle(p);
            })
          : [];
        // Reset particle runtime state
        cachedEntity.particleArrays = {};
        cachedEntity.lastEmitTime = {};
      }
      // Reset animation state when saving
      const direction = this.selectedEntity.location?.direction || "down";
      cachedEntity.direction = direction;
      cachedEntity.combatState = "idle";
      // Reinitialize sprite to reset animation to idle
      reinitEntitySprite(cachedEntity);
    }

    // Ensure direction is set in the entity data being saved
    if (!this.selectedEntity.location) {
      this.selectedEntity.location = {};
    }
    this.selectedEntity.location.direction = cachedEntity?.direction || "down";

    this.isDirty = false;
    // Update UI list to reflect color change
    this.updateEntityList();

    // Convert particle objects back to names for storage
    const entityToSave = { ...this.selectedEntity };
    if (Array.isArray(entityToSave.particles)) {
      entityToSave.particles = entityToSave.particles.map((p: any) => {
        // If it's a full particle object, extract just the name
        if (typeof p === 'object' && p !== null && p.name) {
          return p.name;
        }
        // If it's already a string, keep it
        return p;
      });
    }

    sendRequest({ type: "SAVE_ENTITY", data: entityToSave });
  }

  private deleteEntity() {
    if (!this.selectedEntity) return;

    const modal = document.getElementById("ee-delete-entity-modal");
    const nameSpan = document.getElementById("ee-delete-entity-name");
    const confirmBtn = document.getElementById("ee-delete-confirm");
    const cancelBtn = document.getElementById("ee-delete-cancel");

    if (!modal || !nameSpan) return;

    // Show modal with entity name
    nameSpan.textContent = this.selectedEntity.name || "Unnamed Entity";
    modal.classList.add("visible");

    // Handle confirm
    const confirmHandler = () => {
      const deletedEntity = this.selectedEntity;
      const deletedId = deletedEntity.id;
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);

      // Clear selection and hide properties panel before sending request
      this.selectedEntity = null;
      this.setPropertiesPanelVisible(false);

      // Remove from UI
      if (this.entities) {
        this.entities = this.entities.filter((e) => e.id !== deletedId);
        this.updateEntityList();
      }

      // Remove from cache immediately (don't wait for combatState animation)
      const entityIndex = cache.entities.findIndex((e: any) => e.id === deletedId);
      if (entityIndex > -1) {
        cache.entities.splice(entityIndex, 1);
      }

      // Send delete request to server
      sendRequest({ type: "DELETE_ENTITY", data: deletedEntity });
    };

    // Handle cancel
    const cancelHandler = () => {
      modal.classList.remove("visible");
      confirmBtn?.removeEventListener("click", confirmHandler);
      cancelBtn?.removeEventListener("click", cancelHandler);
    };

    confirmBtn?.addEventListener("click", confirmHandler);
    cancelBtn?.addEventListener("click", cancelHandler);

    // Allow Escape key to cancel
    const escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelHandler();
        document.removeEventListener("keydown", escapeHandler);
      }
    };
    document.addEventListener("keydown", escapeHandler);
  }
}

const entityEditor = new EntityEditor();
(window as any).entityEditor = entityEditor;

export default entityEditor;
export { entityEditor };
