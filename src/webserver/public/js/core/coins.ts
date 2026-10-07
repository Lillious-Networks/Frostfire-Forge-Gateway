// Money as the game shows it: an amount counted in copper, written out as
// gold, silver and copper with their coin icons. Nothing is written for none.

export function coinHtml(totalCopper: number): string {
  const total = Math.max(0, Math.floor(Number(totalCopper) || 0));
  if (total <= 0) return "";
  const gold = Math.floor(total / 10000);
  const silver = Math.floor((total % 10000) / 100);
  const copper = total % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-gold"></span>${gold}</span>`);
  if (silver > 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-silver"></span>${silver}</span>`);
  if (copper > 0 || parts.length === 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-copper"></span>${copper}</span>`);
  return parts.join("");
}

/** What a vendor pays for one of an item, in copper: one when the item says nothing, and nothing for an item vendors never buy. */
export function sellPriceOf(item: any): number {
  // Nor for the home item, which stays with its player.
  if (!item || item.type === "quest" || (item.type === "consumable" && item.teleports_home && item.teleports_home !== "0")) return 0;
  const price = item.sell_price;
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return 1;
  return Math.max(0, Math.trunc(Number(price)));
}
