import { sendRequest } from "./socket.js";

const QUALITY_COLORS: Record<string, string> = {
  common: "#9d9d9d", uncommon: "#1eff00", rare: "#0070dd", epic: "#a335ee", legendary: "#ff8000",
};

let activePopup: HTMLElement | null = null;

export function showLootChestPopup(chestId: string, items: any[]): void {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  const popup = document.createElement("div");
  popup.id = "loot-chest-popup";
  popup.className = "popup loot-chest-popup";
  let itemsHtml = "";
  items.forEach((item: any) => {
    const qColor = QUALITY_COLORS[item.quality] || QUALITY_COLORS.common;
    itemsHtml += `<div class="loot-chest-item" data-index="${item.index}">
        <label class="loot-item-checkbox-label"><input type="checkbox" class="loot-item-checkbox" data-index="${item.index}" checked></label>
        <img class="loot-item-icon" src="${item.iconUrl}" alt="${item.itemName}" onerror="this.style.display='none'">
        <span class="loot-item-name" style="color:${qColor}">${item.itemName}</span>
        <span class="loot-item-quality">${item.quality.charAt(0).toUpperCase() + item.quality.slice(1)}</span>
        <span class="loot-item-qty">x${item.quantity}</span>
      </div>`;
  });
  popup.innerHTML = `<div class="loot-chest-bg">
      <div class="loot-chest-header"><h2>Loot Chest</h2><button class="loot-chest-close" id="close-loot-chest">&times;</button></div>
      <div class="loot-chest-items-list">${itemsHtml}</div>
      <div class="loot-chest-footer">
        <button class="loot-btn loot-btn-secondary" id="take-selected-items">Take Selected</button>
        <button class="loot-btn loot-btn-primary" id="take-all-items">Take All</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
  activePopup = popup;
  popup.querySelector("#close-loot-chest")?.addEventListener("click", closePopup);
  popup.addEventListener("keydown", (ev: KeyboardEvent) => { if (ev.code === "Escape") closePopup(); });
  popup.querySelector("#take-selected-items")?.addEventListener("click", () => {
    const checkboxes = popup.querySelectorAll(".loot-item-checkbox:checked") as NodeListOf<HTMLInputElement>;
    const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index || "0"));
    if (indices.length > 0) { sendRequest({ type: "TAKE_CHEST_ITEMS", data: { chestId, indices } }); closePopup(); }
  });
  popup.querySelector("#take-all-items")?.addEventListener("click", () => {
    sendRequest({ type: "TAKE_ALL_CHEST_ITEMS", data: { chestId } }); closePopup();
  });
}

function closePopup(): void { if (activePopup) { activePopup.remove(); activePopup = null; } }
