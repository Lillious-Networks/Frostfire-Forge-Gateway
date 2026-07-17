import Cache from "./cache.js";

const tooltip = document.getElementById("item-tooltip") as HTMLDivElement;
const tooltipName = document.getElementById("tooltip-name") as HTMLDivElement;
const tooltipType = document.getElementById("tooltip-type") as HTMLDivElement;
const tooltipStats = document.getElementById("tooltip-stats") as HTMLDivElement;
const tooltipDescription = document.getElementById("tooltip-description") as HTMLDivElement;

let currentTooltipElement: HTMLElement | null = null;
let currentItemData: any = null;
let currentMouseX: number = 0;
let currentMouseY: number = 0;
let currentTooltipKind: "item" | "spell" | null = null;

function showItemTooltip(element: HTMLElement, itemData: any, mouseX: number, mouseY: number, compareMode: boolean = false) {
  if (!tooltip || !itemData) return;

  currentTooltipElement = element;
  currentItemData = itemData;
  currentMouseX = mouseX;
  currentMouseY = mouseY;
  currentTooltipKind = "item";

  tooltipName.className = "ui";
  tooltipName.innerText = "";
  tooltipType.innerText = "";
  tooltipStats.innerHTML = "";
  tooltipDescription.innerText = "";

  tooltipName.innerText = itemData.name || "Unknown Item";
  if (itemData.quality) {
    tooltipName.classList.add(itemData.quality.toLowerCase());
  }

  if (itemData.type === "equipment" && itemData.equipment_slot) {
    const slotName = itemData.equipment_slot.replace(/_/g, " ");
    let typeText = `${slotName.charAt(0).toUpperCase() + slotName.slice(1)}`;

    if (itemData.level_requirement) {

      const cache = Cache.getInstance();
      const playerLevel = cache.players.size > 0
        ? Array.from(cache.players).find((p: any) => p.id === (window as any).cachedPlayerId)?.stats?.level || 1
        : 1;

      const meetsRequirement = playerLevel >= itemData.level_requirement;
      const requirementText = ` (Requires Level ${itemData.level_requirement})`;

      if (!meetsRequirement) {

        tooltipType.innerHTML = `${typeText}<span style="color: #ff6b6b;">${requirementText}</span>`;
      } else {

        typeText += requirementText;
        tooltipType.innerText = typeText;
      }
    } else {
      tooltipType.innerText = typeText;
    }
  } else if (itemData.type) {
    tooltipType.innerText = itemData.type.charAt(0).toUpperCase() + itemData.type.slice(1);
  }

  let equippedItem: any = null;
  if (compareMode && itemData.type === "equipment" && itemData.equipment_slot) {
    const cache = Cache.getInstance();
    const equippedItemName = cache.equipment?.[itemData.equipment_slot];
    if (equippedItemName && cache.inventory) {
      equippedItem = cache.inventory.find((item: any) => item.name === equippedItemName);
    }
  }

  const statNames = [
    { key: 'stat_damage', label: 'Damage', suffix: '' },
    { key: 'stat_armor', label: 'Armor', suffix: '%' },
    { key: 'stat_health', label: 'Health', suffix: '' },
    { key: 'stat_stamina', label: 'Stamina', suffix: '' },
    { key: 'stat_critical_chance', label: 'Critical Chance', suffix: '%' },
    { key: 'stat_critical_damage', label: 'Critical Damage', suffix: '%' },
    { key: 'stat_avoidance', label: 'Avoidance', suffix: '%' }
  ];

  let hasStats = false;
  statNames.forEach(({ key, label, suffix }) => {
    const itemValue = itemData[key] || 0;
    const equippedValue = equippedItem?.[key] || 0;

    if (itemValue !== 0 || (compareMode && equippedItem && equippedValue !== 0)) {
      hasStats = true;
      const statDiv = document.createElement("div");

      if (compareMode && equippedItem) {

        const difference = itemValue - equippedValue;
        if (difference > 0) {

          statDiv.style.color = "#4ade80";
          statDiv.innerText = `+${itemValue}${suffix} ${label} (+${difference}${suffix})`;
        } else if (difference < 0) {

          statDiv.style.color = "#ff6b6b";
          statDiv.innerText = `+${itemValue}${suffix} ${label} (${difference}${suffix})`;
        } else {

          statDiv.innerText = `+${itemValue}${suffix} ${label}`;
        }
      } else {

        statDiv.innerText = `+${itemValue}${suffix} ${label}`;
      }

      tooltipStats.appendChild(statDiv);
    }
  });

  if (!hasStats) {
    tooltipStats.style.display = "none";
  } else {
    tooltipStats.style.display = "block";
  }

  if (itemData.description) {
    tooltipDescription.innerText = itemData.description;
  } else {
    tooltipDescription.style.display = "none";
  }

  tooltip.style.display = "block";

  positionTooltip(mouseX, mouseY);
}

function positionTooltip(mouseX: number, mouseY: number) {
  if (!tooltip) return;

  const offset = 15;
  const padding = 10;

  const rect = tooltip.getBoundingClientRect();
  const tooltipWidth = rect.width;
  const tooltipHeight = rect.height;

  let x = mouseX + offset;
  let y = mouseY + offset;

  if (x + tooltipWidth > window.innerWidth - padding) {
    x = mouseX - tooltipWidth - offset;
  }

  if (y + tooltipHeight > window.innerHeight - padding) {
    y = mouseY - tooltipHeight - offset;
  }

  if (x < padding) {
    x = padding;
  }

  if (y < padding) {
    y = padding;
  }

  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideItemTooltip() {
  if (tooltip) {
    tooltip.style.display = "none";
    currentTooltipElement = null;
    currentItemData = null;
    currentTooltipKind = null;
  }
}

function updateTooltipPosition(mouseX: number, mouseY: number) {
  if (tooltip && tooltip.style.display === "block") {
    positionTooltip(mouseX, mouseY);
  }
}

function setupItemTooltip(element: HTMLElement, getItemData: () => any) {

  const handleMouseEnter = (e: MouseEvent) => {
    const itemData = getItemData();
    if (itemData && itemData.name) {

      const compareMode = e.shiftKey;
      showItemTooltip(element, itemData, e.clientX, e.clientY, compareMode);
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (currentTooltipElement === element) {
      updateTooltipPosition(e.clientX, e.clientY);

      const itemData = getItemData();
      if (itemData && itemData.name) {
        const compareMode = e.shiftKey;
        showItemTooltip(element, itemData, e.clientX, e.clientY, compareMode);
      }
    }
  };

  const handleMouseLeave = () => {
    if (currentTooltipElement === element) {
      hideItemTooltip();
    }
  };

  (element as any)._tooltipHandlers = {
    mouseenter: handleMouseEnter,
    mousemove: handleMouseMove,
    mouseleave: handleMouseLeave
  };

  element.addEventListener("mouseenter", handleMouseEnter);
  element.addEventListener("mousemove", handleMouseMove);
  element.addEventListener("mouseleave", handleMouseLeave);
}

function removeItemTooltip(element: HTMLElement) {
  const handlers = (element as any)._tooltipHandlers;
  if (handlers) {
    element.removeEventListener("mouseenter", handlers.mouseenter);
    element.removeEventListener("mousemove", handlers.mousemove);
    element.removeEventListener("mouseleave", handlers.mouseleave);
    delete (element as any)._tooltipHandlers;
  }

  if (currentTooltipElement === element) {
    hideItemTooltip();
  }
}

function showSpellTooltip(element: HTMLElement, spellData: any, mouseX: number, mouseY: number, anchor: "cursor" | "bottom-right" = "cursor") {
  if (!tooltip || !spellData) return;

  currentTooltipElement = element;
  currentItemData = spellData;
  currentMouseX = mouseX;
  currentMouseY = mouseY;
  currentTooltipKind = "spell";

  tooltipName.className = "ui";
  tooltipName.classList.add("common");
  tooltipName.innerText = "";
  tooltipType.innerText = "";
  tooltipStats.innerHTML = "";
  tooltipDescription.innerText = "";

  const rawName = spellData.name || "Unknown Spell";
  tooltipName.innerText = rawName.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

  tooltipType.innerText = spellData.isDebuff ? "Debuff" : spellData.activeEffect ? "Buff" : "Spell";

  const lines: { text: string; color: string }[] = [];

  const damage = Number(spellData.damage) || 0;
  if (damage > 0) {
    lines.push({ text: `${damage} Damage`, color: "#ff6b6b" });
  } else if (damage < 0) {
    lines.push({ text: `${Math.abs(damage)} Healing`, color: "#4ade80" });
  }

  if (Array.isArray(spellData.effects)) {
    for (const effect of spellData.effects) {
      if (!effect) continue;
      if (effect.type === "absorbtion") {
        const duration = effect.duration ? ` for ${effect.duration}s` : "";
        lines.push({ text: `${effect.value} Absorb Shield${duration}`, color: "#7ab8ff" });
      } else if (effect.type === "damage_over_time") {
        const interval = Number(effect.interval) || 1;
        const duration = Number(effect.duration) || 0;
        let text = `${effect.value} Damage every ${interval}s for ${duration}s`;
        if (effect.stackable) {
          text += ` (stacks up to ${effect.max_stacks || 5})`;
        }
        lines.push({ text, color: "#9ade4a" });
      } else if (effect.type === "interrupt") {
        const duration = Number(effect.duration) || 3;
        lines.push({ text: `Interrupts spell casting, locking spells for ${duration}s`, color: "#ffd75e" });
      }
    }
  }

  // Live info for an effect currently applied to the player (buff/debuff bar)
  if (spellData.activeEffect) {
    const active = spellData.activeEffect;
    const stacks = Number(active.stacks) || 1;
    const value = Number(active.value) || 0;
    if (spellData.isDebuff && value > 0) {
      const interval = Number(active.interval) || 1;
      lines.push({ text: `Taking ${value * stacks} Damage every ${interval}s`, color: "#ff6b6b" });
    }
    if (stacks > 1) {
      lines.push({ text: `${stacks} Stacks`, color: "#ffd75e" });
    }
    const remaining = Number(active.remaining) || 0;
    if (remaining > 0) {
      lines.push({ text: `${remaining}s Remaining`, color: "#bdbdbd" });
    }
  }

  if (!spellData.activeEffect) {
    if (spellData.mana) lines.push({ text: `${spellData.mana} Mana`, color: "#469cd9" });
    if (spellData.cast_time) lines.push({ text: `${spellData.cast_time}s Cast Time`, color: "#bdbdbd" });
    if (spellData.cooldown) lines.push({ text: `${spellData.cooldown}s Cooldown`, color: "#bdbdbd" });
  }

  if (lines.length > 0) {
    lines.forEach(({ text, color }) => {
      const statDiv = document.createElement("div");
      statDiv.style.color = color;
      statDiv.innerText = text;
      tooltipStats.appendChild(statDiv);
    });
    tooltipStats.style.display = "block";
  } else {
    tooltipStats.style.display = "none";
  }

  if (spellData.description) {
    tooltipDescription.style.display = "block";
    tooltipDescription.innerText = spellData.description;
  } else {
    tooltipDescription.style.display = "none";
  }

  tooltip.style.display = "block";
  if (anchor === "bottom-right") {
    positionTooltipBottomRight();
  } else {
    positionTooltip(mouseX, mouseY);
  }
}

function positionTooltipBottomRight() {
  if (!tooltip) return;
  const padding = 10;
  const rect = tooltip.getBoundingClientRect();
  const x = window.innerWidth - rect.width - padding;
  const y = window.innerHeight - rect.height - padding;
  tooltip.style.left = `${Math.max(padding, x)}px`;
  tooltip.style.top = `${Math.max(padding, y)}px`;
}

function setupSpellTooltip(element: HTMLElement, getSpellData: () => any, options?: { anchor?: "cursor" | "bottom-right" }) {
  const anchor = options?.anchor || "cursor";

  const handleMouseEnter = (e: MouseEvent) => {
    const spellData = getSpellData();
    if (spellData && spellData.name) {
      showSpellTooltip(element, spellData, e.clientX, e.clientY, anchor);
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (currentTooltipElement === element && anchor === "cursor") {
      updateTooltipPosition(e.clientX, e.clientY);
    }
  };

  const handleMouseLeave = () => {
    if (currentTooltipElement === element) {
      hideItemTooltip();
    }
  };

  (element as any)._tooltipHandlers = {
    mouseenter: handleMouseEnter,
    mousemove: handleMouseMove,
    mouseleave: handleMouseLeave
  };

  element.addEventListener("mouseenter", handleMouseEnter);
  element.addEventListener("mousemove", handleMouseMove);
  element.addEventListener("mouseleave", handleMouseLeave);
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Shift" && currentTooltipElement && currentItemData && currentTooltipKind === "item") {

    showItemTooltip(currentTooltipElement, currentItemData, currentMouseX, currentMouseY, true);
  }
});

document.addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.key === "Shift" && currentTooltipElement && currentItemData && currentTooltipKind === "item") {

    showItemTooltip(currentTooltipElement, currentItemData, currentMouseX, currentMouseY, false);
  }
});

export { setupItemTooltip, removeItemTooltip, showItemTooltip, hideItemTooltip, updateTooltipPosition, setupSpellTooltip, showSpellTooltip };
