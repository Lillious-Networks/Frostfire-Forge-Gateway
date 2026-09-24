// Quality frame around an item icon: the coloured border (rainbow for
// legendary) the loot table editor introduced, used wherever the game or an
// editor shows an item icon. Styles: .item-frame in game.css.

export const ITEM_QUALITIES = ["common", "uncommon", "rare", "epic", "legendary"];

/** A known quality name, lowercased; anything else is common. */
export function qualityOf(quality: unknown): string {
  const value = String(quality ?? "").toLowerCase();
  return ITEM_QUALITIES.includes(value) ? value : "common";
}

/** Turn an existing icon container (a slot, a thumbnail) into a quality frame. */
export function applyItemFrame(el: HTMLElement, quality: unknown): void {
  el.classList.add("item-frame");
  el.dataset.quality = qualityOf(quality);
}

/** A framed item icon `size` px square; a "?" stands in when there is no icon. */
export function itemFrame(iconUrl: string | null | undefined, quality: unknown, size: number, alt = ""): HTMLSpanElement {
  const frame = document.createElement("span");
  applyItemFrame(frame, quality);
  frame.style.width = `${size}px`;
  frame.style.height = `${size}px`;
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = alt;
    img.loading = "lazy";
    img.addEventListener("error", () => { img.style.display = "none"; });
    frame.appendChild(img);
  } else {
    const missing = document.createElement("span");
    missing.className = "item-frame-missing";
    missing.textContent = "?";
    frame.appendChild(missing);
  }
  return frame;
}

/** Same frame as HTML, for code that builds rows from template strings. */
export function itemFrameHtml(iconUrl: string, quality: unknown, size: number, alt: string, imgClass = ""): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const img = iconUrl
    ? `<img${imgClass ? ` class="${imgClass}"` : ""} src="${escape(iconUrl)}" alt="${escape(alt)}" onerror="this.style.display='none'">`
    : `<span class="item-frame-missing">?</span>`;
  return `<span class="item-frame" data-quality="${qualityOf(quality)}" style="width:${size}px;height:${size}px">${img}</span>`;
}
