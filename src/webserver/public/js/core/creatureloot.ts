// Corpse loot window for server-authoritative creatures. Styled with the loot
// chest window classes; all taking is validated server-side.
import { sendRequest } from "./socket.js";
import { itemFrameHtml } from "./itemframe.js";

const QUALITY_COLORS: Record<string, string> = {
  common: "#9d9d9d", uncommon: "#1eff00", rare: "#0070dd", epic: "#a335ee", legendary: "#ff8000",
};

let activePopup: HTMLElement | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function formatMoney(copper: number): string {
  const gold = Math.floor(copper / 10000);
  const silver = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return [gold ? `${gold}g` : "", silver ? `${silver}s` : "", c ? `${c}c` : ""].filter(Boolean).join(" ") || "0c";
}

function close(): void {
  activePopup?.remove();
  activePopup = null;
}

export function showCreatureLoot(creatureId: number, items: any[], copper: number): void {
  close();
  const popup = document.createElement("div");
  popup.id = "creature-loot-popup";
  popup.className = "popup loot-chest-popup";

  const rows = items
    .map((item: any) => {
      const quality = String(item.quality || "common");
      const color = QUALITY_COLORS[quality] || QUALITY_COLORS.common;
      const name = escapeHtml(String(item.itemName));
      return `<div class="loot-chest-item" data-index="${Number(item.index)}">
        <label class="loot-item-checkbox-label"><input type="checkbox" class="loot-item-checkbox" data-index="${Number(item.index)}" checked></label>
        ${itemFrameHtml(String(item.iconUrl || ""), quality, 36, String(item.itemName), "loot-item-icon")}
        <span class="loot-item-name" style="color:${color}">${name}</span>
        <span class="loot-item-quality">${escapeHtml(quality.charAt(0).toUpperCase() + quality.slice(1))}</span>
        <span class="loot-item-qty">x${Number(item.quantity)}</span>
      </div>`;
    })
    .join("");
  const money = copper > 0 ? `<div class="loot-chest-item"><span class="loot-item-name" style="color:#ffd75e">${formatMoney(copper)}</span></div>` : "";

  popup.innerHTML = `<div class="loot-chest-bg">
      <div class="loot-chest-header"><h2>Loot</h2><button class="loot-chest-close" id="close-creature-loot">&times;</button></div>
      <div class="loot-chest-items-list">${money}${rows}</div>
      <div class="loot-chest-footer">
        <button class="loot-btn loot-btn-secondary" id="take-selected-creature-loot">Take Selected</button>
        <button class="loot-btn loot-btn-primary" id="take-all-creature-loot">Take All</button>
      </div>
    </div>`;
  document.body.appendChild(popup);
  activePopup = popup;

  popup.querySelector("#close-creature-loot")?.addEventListener("click", close);
  popup.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.code === "Escape") close();
  });
  popup.querySelector("#take-selected-creature-loot")?.addEventListener("click", () => {
    const checked = popup.querySelectorAll(".loot-item-checkbox:checked") as NodeListOf<HTMLInputElement>;
    const indices = Array.from(checked).map((cb) => parseInt(cb.dataset.index || "0", 10));
    sendRequest({ type: "CREATURE_LOOT_TAKE", data: { id: creatureId, indices } });
    close();
  });
  popup.querySelector("#take-all-creature-loot")?.addEventListener("click", () => {
    sendRequest({ type: "CREATURE_LOOT_TAKE", data: { id: creatureId } });
    close();
  });
}
