// The vendor window: what an NPC sells, and what this player sold lately and
// can buy back. The server holds the stock and makes every deal; it sends the
// window's contents after each one (VENDOR_STOCK), along with the player's
// bags and coins. Selling is done from the bags: a right-click on an item
// there, while this window is open, sells all of it that is spare.
import { config } from "../web/global.js";
import { sendRequest, cachedPlayerId } from "./socket.js";
import Cache from "./cache.js";
import { itemFrame } from "./itemframe.js";
import { setupItemTooltip, hideItemTooltip } from "./tooltip.js";
import { openInventory } from "./input.js";
import { coinHtml } from "./coins.js";

const cache = Cache.getInstance();

interface StockItem { name: string; price: number; quality?: string; icon?: string | null; iconUrl?: string; [field: string]: unknown }
interface SoldItem extends StockItem { quantity: number }
interface VendorState { npcId: number; name: string | null; items: StockItem[]; buyback: SoldItem[] }
type Tab = "buy" | "buyback";

/** The most of an item bought in one purchase: the server's limit. */
const BUY_AMOUNT_MAX = 999;
/** How far the player may walk from the vendor before the window closes: a little past where the server stops dealing. */
const CLOSE_RADIUS = 160;
const QUALITY_COLORS: Record<string, string> = {
  common: "#FFF1DA", uncommon: "#1eff00", rare: "#4d9bff", epic: "#c06bff", legendary: "#ff8000",
};

/** A phone or a tablet: no mouse, so no right-click and no hover. */
const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

let state: VendorState | null = null;
let popup: HTMLDivElement | null = null;
let tab: Tab = "buy";
/** The amount typed beside each item, kept while the window is drawn again. */
const amounts = new Map<string, number>();

const iconOf = (item: StockItem) => item.iconUrl || (item.icon ? `${config.ASSET_SERVER_URL}/icon?name=${encodeURIComponent(item.icon)}` : null);
const amountOf = (name: string) => amounts.get(name) ?? 1;

/** Whether the vendor window is open. */
export function isVendorOpen(): boolean {
  return state !== null;
}

/** The player's coins, counted in copper. */
function purse(): number {
  const me: any = Array.from(cache.players).find((player: any) => player.id === cachedPlayerId);
  const held = me?.currency ?? {};
  return (Number(held.gold) || 0) * 10000 + (Number(held.silver) || 0) * 100 + (Number(held.copper) || 0);
}

/** Sells an item from the bags to the vendor: all of it that is spare. */
export function sellItem(name: string) {
  if (!state) return;
  hideItemTooltip();
  sendRequest({ type: "VENDOR_SELL", data: { npcId: state.npcId, item: name } });
}

// Escape closes the window, or leaves the field being typed in. Seen first, so the game's own Escape (the pause menu) is not opened under it.
function onKey(event: KeyboardEvent) {
  if (event.code !== "Escape" || !popup) return;
  event.stopPropagation();
  const field = document.activeElement as HTMLElement | null;
  if (field && popup.contains(field) && field.tagName === "INPUT") field.blur();
  else closeVendor();
}

/** The cost of something, in coins. Nothing to pay is said in a word. */
function priceEl(copper: number, affordable: boolean): HTMLSpanElement {
  const price = document.createElement("span");
  price.className = `vendor-price${affordable ? "" : " short"}`;
  if (copper > 0) price.innerHTML = coinHtml(copper);
  else price.innerText = "Free";
  return price;
}

function nameEl(item: StockItem, quantity = 1): HTMLSpanElement {
  const name = document.createElement("span");
  name.className = "vendor-name";
  name.style.color = QUALITY_COLORS[String(item.quality ?? "common").toLowerCase()] ?? QUALITY_COLORS.common;
  name.innerText = quantity > 1 ? `${item.name} x${quantity}` : item.name;
  return name;
}

function rowFor(item: StockItem): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "vendor-row";
  row.appendChild(itemFrame(iconOf(item), item.quality, 36, item.name));
  setupItemTooltip(row, () => ({ ...item, iconUrl: iconOf(item) }));
  return row;
}

/** One thing the vendor sells: how many to buy, and the button that buys them. */
function stockRow(item: StockItem): HTMLDivElement {
  const row = rowFor(item);
  const cost = () => item.price * amountOf(item.name);
  const price = priceEl(item.price, purse() >= cost());

  const amount = document.createElement("input");
  amount.type = "number";
  amount.className = "vendor-amount";
  amount.min = "1";
  amount.max = String(BUY_AMOUNT_MAX);
  amount.value = String(amountOf(item.name));
  amount.setAttribute("aria-label", `How many ${item.name} to buy`);

  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "vendor-buy";
  buy.innerText = "Buy";
  buy.addEventListener("click", () => {
    hideItemTooltip();
    sendRequest({ type: "VENDOR_BUY", data: { npcId: state!.npcId, item: item.name, quantity: amountOf(item.name) } });
  });

  // The price shown is for one; whether the amount asked for can be paid shows on it and on the button.
  const afford = () => {
    const can = purse() >= cost();
    price.classList.toggle("short", !can);
    buy.disabled = !can;
    buy.title = can ? "" : "You cannot afford that.";
  };
  amount.addEventListener("input", () => {
    amounts.set(item.name, Math.min(BUY_AMOUNT_MAX, Math.max(1, Math.floor(Number(amount.value) || 1))));
    afford();
  });
  amount.addEventListener("change", () => { amount.value = String(amountOf(item.name)); });
  amount.addEventListener("keydown", (event) => { if (event.key === "Enter") buy.click(); });
  afford();

  row.append(nameEl(item), price, amount, buy);
  return row;
}

/** One of the player's latest sales: what it was, and the button that buys it back for what they were paid. */
function soldRow(item: SoldItem, index: number): HTMLDivElement {
  const row = rowFor(item);
  const can = purse() >= item.price;
  const back = document.createElement("button");
  back.type = "button";
  back.className = "vendor-buy";
  back.innerText = "Buy back";
  back.disabled = !can;
  back.title = can ? "" : "You cannot afford that.";
  back.addEventListener("click", () => {
    hideItemTooltip();
    sendRequest({ type: "VENDOR_BUYBACK", data: { npcId: state!.npcId, index } });
  });
  row.append(nameEl(item, item.quantity), priceEl(item.price, can), back);
  return row;
}

function render() {
  if (!state || !popup) return;
  hideItemTooltip();
  (popup.querySelector("h2") as HTMLElement).innerText = state.name || "Vendor";

  const tabs = popup.querySelector(".vendor-tabs") as HTMLElement;
  tabs.replaceChildren(...(["buy", "buyback"] as Tab[]).map((which) => {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "vendor-tab";
    pick.setAttribute("role", "tab");
    pick.setAttribute("aria-selected", String(tab === which));
    pick.innerText = which === "buy" ? "Buy" : `Buyback${state!.buyback.length > 0 ? ` (${state!.buyback.length})` : ""}`;
    pick.addEventListener("click", () => {
      tab = which;
      render();
    });
    return pick;
  }));

  const list = popup.querySelector(".vendor-list") as HTMLElement;
  const scrolled = list.scrollTop;
  const rows = tab === "buy" ? state.items.map(stockRow) : state.buyback.map(soldRow);
  if (rows.length === 0) {
    const none = document.createElement("p");
    none.className = "vendor-none";
    none.innerText = tab === "buy" ? "Nothing for sale." : "Nothing to buy back. What you sell here is kept until you log out.";
    list.replaceChildren(none);
  } else {
    list.replaceChildren(...rows);
    list.scrollTop = scrolled;
  }
}

function build(): HTMLDivElement {
  const made = document.createElement("div");
  made.id = "vendor-window";
  made.className = "ui";
  made.setAttribute("role", "dialog");
  made.setAttribute("aria-label", "Vendor");

  const title = document.createElement("h2");
  const tabs = document.createElement("div");
  tabs.className = "vendor-tabs";
  tabs.setAttribute("role", "tablist");
  const list = document.createElement("div");
  list.className = "vendor-list";
  const hint = document.createElement("p");
  hint.className = "vendor-hint";
  // On a touch screen there is no right-click: two taps on the item sell it (events.ts).
  hint.innerText = TOUCH ? "Double-tap an item in your bags to sell it." : "Right-click an item in your bags to sell it.";

  const close = document.createElement("button");
  close.id = "vendor-close";
  close.type = "button";
  close.innerText = "Close";
  close.addEventListener("click", closeVendor);
  const buttons = document.createElement("div");
  buttons.className = "button-container";
  buttons.appendChild(close);

  made.append(title, tabs, list, hint, buttons);
  // A right-click on the window is not a right-click on the world under it.
  made.addEventListener("contextmenu", (event) => event.preventDefault());
  return made;
}

/** What the vendor stocks and what can be bought back (VENDOR_STOCK): opens the window the first time, and the bags with it. */
export function showVendor(data: VendorState) {
  if (!data || !Array.isArray(data.items)) return;
  const opening = state === null || state.npcId !== data.npcId;
  state = { npcId: Number(data.npcId), name: data.name ?? null, items: data.items, buyback: Array.isArray(data.buyback) ? data.buyback : [] };

  if (!popup) {
    popup = build();
    document.body.appendChild(popup);
    document.addEventListener("keydown", onKey, true);
  }
  if (opening) {
    tab = "buy";
    amounts.clear();
    openInventory();
  }
  // The last sale was bought back: there is nothing more to show on that tab.
  if (tab === "buyback" && state.buyback.length === 0) tab = "buy";
  render();
}

/** The window goes: the player closed it, walked off, or the server said the vendor no longer deals with them (VENDOR_CLOSED). */
export function closeVendor() {
  document.removeEventListener("keydown", onKey, true);
  hideItemTooltip();
  popup?.remove();
  popup = null;
  state = null;
  amounts.clear();
}

/** The player's coins changed while the window is open: what they can afford is shown again. */
export function refreshVendor() {
  if (state) render();
}

// Walking away from the vendor closes the window, as it does a quest giver's. Past the radius the server refuses a deal anyway.
(window as any).updateVendorProximity = (playerX: number, playerY: number) => {
  if (!state) return;
  const npc = (cache.npcs || []).find((held: any) => Number(held.id) === state!.npcId);
  if (!npc || npc.hidden) return closeVendor();
  const x = Number(npc.position?.x);
  const y = Number(npc.position?.y);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.hypot(playerX - x, playerY - y) > CLOSE_RADIUS) closeVendor();
};
