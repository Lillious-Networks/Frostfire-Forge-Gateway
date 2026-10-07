// The trade window: what this player offers on one side, what the other
// player offers on the other, and who has accepted. The server holds the trade
// and sends it whole after every change (TRADE_STATE); this window shows what
// it was sent, and sends back this player's side whenever they change it.
// Nothing moves until both have accepted, and the server makes the swap.
import { config } from "../web/global.js";
import { sendRequest } from "./socket.js";
import Cache from "./cache.js";
import { itemFrame } from "./itemframe.js";
import { setupItemTooltip, hideItemTooltip } from "./tooltip.js";
import { openInventory } from "./input.js";

const cache = Cache.getInstance();

interface Coins { gold: number; silver: number; copper: number }
interface TradeItem { name: string; quantity: number; quality?: string; icon?: string | null; iconUrl?: string; [field: string]: unknown }
interface TradeSide { items: TradeItem[]; coins: Coins }
interface TradeState {
  partner: string;
  mine: TradeSide;
  theirs: TradeSide;
  accepted: { mine: boolean; theirs: boolean };
  /** Milliseconds until the server lets the trade be accepted. */
  acceptIn: number;
}

/** How many different items one side holds: the server's limit, shown as that many slots. */
const SLOTS = 8;
/** The most of each coin a purse holds. */
const COIN_LIMITS: Coins = { gold: 9999999, silver: 99, copper: 99 };
const COIN_KINDS: Array<keyof Coins> = ["gold", "silver", "copper"];
/** How long after the last key before typed coins are sent. */
const COINS_SENT_AFTER = 400;

/** A phone or a tablet: no mouse, so no right-click and no hover. */
const TOUCH = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

let state: TradeState | null = null;
let popup: HTMLDivElement | null = null;
/** When (performance.now) the trade can be accepted. */
let acceptAt = 0;
let acceptTimer = 0;
let coinTimer = 0;
/** Coins were typed and are not sent yet: what the server says of them is not shown over what is being typed. */
let coinsPending = false;

const shown = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);
const whole = (value: unknown, most: number) => Math.min(most, Math.max(0, Math.floor(Number(value) || 0)));
const iconOf = (item: TradeItem) => item.iconUrl || (item.icon ? `${config.ASSET_SERVER_URL}/icon?name=${encodeURIComponent(item.icon)}` : null);

/** Whether a trade is open. */
export function isTrading(): boolean {
  return state !== null;
}

/** Sends this player's side as it should now be. The server answers with the trade, changed or not. */
function sendOffer(items: Array<{ name: string; quantity: number }>, coins: Coins) {
  sendRequest({
    type: "TRADE_OFFER",
    data: { items: items.map(({ name, quantity }) => ({ name, quantity })), coins },
  });
}

/** The coins typed into this player's side. */
function typedCoins(): Coins {
  const coins = { ...(state?.mine.coins ?? { gold: 0, silver: 0, copper: 0 }) };
  for (const kind of COIN_KINDS) {
    const input = popup?.querySelector(`input[data-coin="${kind}"]`) as HTMLInputElement | null;
    if (input) coins[kind] = whole(input.value, COIN_LIMITS[kind]);
  }
  return coins;
}

function sendTypedCoins() {
  window.clearTimeout(coinTimer);
  if (!state || !coinsPending) return;
  coinsPending = false;
  sendOffer(state.mine.items, typedCoins());
}

/**
 * How many of an item in the bags can be traded: what is held less what is in use (one worn, or
 * one for each bag slot it is in), which is also what the bags show of it.
 */
function spareOf(name: string): number {
  const held = (cache.inventory || []).find((item: any) => String(item.name).toLowerCase() === name.toLowerCase());
  if (!held) return 0;
  let inUse = 0;
  if (held.equipped) {
    const isBag = held.bag_slots != null && held.bag_slots > 0 && cache.bags;
    inUse = isBag
      ? ["slot_1", "slot_2", "slot_3", "slot_4"].filter((slot) => String(cache.bags[slot] ?? "").toLowerCase() === String(held.name).toLowerCase()).length
      : 1;
  }
  return Math.max(0, (Number(held.quantity) || 0) - inUse);
}

/** Puts one of an item from the bags on this player's side. More of a stack is offered by raising its amount. */
export function offerItem(name: string) {
  if (!state) return;
  const held = (cache.inventory || []).find((item: any) => String(item.name).toLowerCase() === name.toLowerCase());
  if (!held || state.mine.items.some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
  const coins = coinsPending ? typedCoins() : state.mine.coins;
  coinsPending = false;
  sendOffer([...state.mine.items, { name: held.name, quantity: 1 }], coins);
}

function withdrawItem(name: string) {
  if (!state) return;
  hideItemTooltip();
  sendOffer(state.mine.items.filter((item) => item.name !== name), state.mine.coins);
}

function changeAmount(name: string, quantity: number) {
  if (!state) return;
  sendOffer(state.mine.items.map((item) => (item.name === name ? { ...item, quantity } : item)), state.mine.coins);
}

function cancelTrade() {
  sendRequest({ type: "TRADE_CANCEL", data: null });
}

// Escape cancels the trade, or leaves the field being typed in. Seen first, so the game's own Escape (the pause menu) is not opened under the window.
function onKey(event: KeyboardEvent) {
  if (event.code !== "Escape" || !popup) return;
  event.stopPropagation();
  const field = document.activeElement as HTMLElement | null;
  if (field && popup.contains(field) && field.tagName === "INPUT") field.blur();
  else cancelTrade();
}

/** One offered item in a slot. On this player's side it can be taken back, and a stack's amount changed. */
function slotFor(item: TradeItem | undefined, own: boolean): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "trade-slot";
  if (!item) return slot;

  slot.classList.add("filled");
  slot.appendChild(itemFrame(iconOf(item), item.quality, 40, item.name));
  setupItemTooltip(slot, () => ({ ...item, iconUrl: iconOf(item) }));

  const held = Math.max(spareOf(item.name), item.quantity);
  if (own && held > 1) {
    // A stack: its amount is a field, from one up to all that is spare of it.
    const amount = document.createElement("input");
    amount.type = "number";
    amount.className = "trade-amount";
    amount.min = "1";
    amount.max = String(held);
    amount.value = String(item.quantity);
    amount.title = `How many to offer, of ${held}`;
    amount.addEventListener("change", () => {
      const wanted = Math.min(held, Math.max(1, Math.floor(Number(amount.value) || 1)));
      amount.value = String(wanted);
      if (wanted !== item.quantity) changeAmount(item.name, wanted);
    });
    amount.addEventListener("keydown", (event) => { if (event.key === "Enter") amount.blur(); });
    slot.appendChild(amount);
  } else if (item.quantity > 1) {
    const count = document.createElement("span");
    count.className = "trade-count";
    count.innerText = String(item.quantity);
    slot.appendChild(count);
  }

  if (own) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "trade-remove";
    remove.innerText = "×";
    remove.title = "Take back";
    remove.setAttribute("aria-label", `Take back ${item.name}`);
    remove.addEventListener("click", () => withdrawItem(item.name));
    slot.appendChild(remove);
    slot.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      withdrawItem(item.name);
    });
  }
  return slot;
}

function slotsFor(side: TradeSide, own: boolean): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "trade-slots";
  for (let index = 0; index < SLOTS; index++) grid.appendChild(slotFor(side.items[index], own));
  return grid;
}

/** A side's coins: fields on this player's side, amounts on the other. */
function coinsFor(side: TradeSide, own: boolean): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "trade-coins";
  for (const kind of COIN_KINDS) {
    const coin = document.createElement("label");
    coin.className = "currency-item";
    const icon = document.createElement("div");
    icon.className = `currency-icon currency-icon-${kind}`;
    coin.appendChild(icon);
    if (own) {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "trade-coin";
      input.dataset.coin = kind;
      input.min = "0";
      input.max = String(COIN_LIMITS[kind]);
      input.value = String(side.coins[kind]);
      input.setAttribute("aria-label", `${shown(kind)} to offer`);
      input.addEventListener("input", () => {
        coinsPending = true;
        window.clearTimeout(coinTimer);
        coinTimer = window.setTimeout(sendTypedCoins, COINS_SENT_AFTER);
      });
      input.addEventListener("change", sendTypedCoins);
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
      coin.appendChild(input);
    } else {
      const amount = document.createElement("span");
      amount.className = "currency-amount";
      amount.innerText = String(side.coins[kind]);
      coin.appendChild(amount);
    }
    row.appendChild(coin);
  }
  return row;
}

function sideFor(title: string, side: TradeSide, accepted: boolean, own: boolean): HTMLDivElement {
  const column = document.createElement("div");
  column.className = `trade-side${accepted ? " accepted" : ""}`;
  const heading = document.createElement("h3");
  const name = document.createElement("span");
  name.className = "trade-title";
  name.innerText = title;
  const mark = document.createElement("span");
  mark.className = "trade-accepted";
  mark.innerText = accepted ? "Accepted" : "";
  heading.append(name, mark);
  column.append(heading, slotsFor(side, own), coinsFor(side, own));

  if (own) {
    // Items are dragged here from the bags.
    column.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("inventory-item-name")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("drop");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drop"));
    column.addEventListener("drop", (event) => {
      column.classList.remove("drop");
      const name = event.dataTransfer?.getData("inventory-item-name");
      if (!name) return;
      event.preventDefault();
      event.stopPropagation();
      offerItem(name);
    });
  }
  return column;
}

/** The Accept button as it now stands: waiting out the delay after a change, ready, or already pressed. */
function refreshAccept() {
  const accept = popup?.querySelector("#trade-accept") as HTMLButtonElement | null;
  const status = popup?.querySelector(".trade-status") as HTMLElement | null;
  if (!accept || !status || !state) return;
  window.clearTimeout(acceptTimer);

  const wait = acceptAt - performance.now();
  if (state.accepted.mine) {
    accept.disabled = true;
    accept.innerText = "Accepted";
    status.innerText = `Waiting for ${shown(state.partner)} to accept.`;
  } else if (wait > 0) {
    accept.disabled = true;
    accept.innerText = "Accept";
    status.innerText = "The offer changed. Look it over.";
    acceptTimer = window.setTimeout(refreshAccept, wait);
  } else {
    accept.disabled = false;
    accept.innerText = "Accept";
    // On a touch screen there is no right-click and nothing is dragged between windows: two taps on an item offer it (events.ts).
    const how = TOUCH ? "Double-tap an item in your bags to offer it." : "Drag items here from your bags, or right-click them.";
    status.innerText = state.accepted.theirs ? `${shown(state.partner)} has accepted.` : how;
  }
}

function render() {
  if (!state || !popup) return;
  // Coins being typed are kept as typed: the other player changing their side must not wipe the field under the cursor.
  const typing = document.activeElement as HTMLInputElement | null;
  const keep = coinsPending && typing && popup.contains(typing) && typing.dataset.coin
    ? { coin: typing.dataset.coin, value: typing.value }
    : null;

  hideItemTooltip();
  const body = popup.querySelector(".trade-body") as HTMLElement;
  body.replaceChildren(
    sideFor("You offer", state.mine, state.accepted.mine, true),
    sideFor(`${shown(state.partner)} offers`, state.theirs, state.accepted.theirs, false),
  );
  (popup.querySelector("h2") as HTMLElement).innerText = `Trade with ${shown(state.partner)}`;

  if (keep) {
    const again = popup.querySelector(`input[data-coin="${keep.coin}"]`) as HTMLInputElement | null;
    if (again) {
      again.value = keep.value;
      again.focus();
    }
  }
  refreshAccept();
}

function build(): HTMLDivElement {
  const made = document.createElement("div");
  made.id = "trade-window";
  made.className = "ui";
  made.setAttribute("role", "dialog");
  made.setAttribute("aria-label", "Trade");

  const title = document.createElement("h2");
  const body = document.createElement("div");
  body.className = "trade-body";
  const status = document.createElement("p");
  status.className = "trade-status";

  const accept = document.createElement("button");
  accept.id = "trade-accept";
  accept.type = "button";
  accept.addEventListener("click", () => {
    // Coins still being typed are part of what is accepted: they are sent first.
    sendTypedCoins();
    sendRequest({ type: "TRADE_ACCEPT", data: null });
  });
  const cancel = document.createElement("button");
  cancel.id = "trade-cancel";
  cancel.type = "button";
  cancel.innerText = "Cancel";
  cancel.addEventListener("click", cancelTrade);

  const buttons = document.createElement("div");
  buttons.className = "button-container";
  buttons.append(accept, cancel);
  made.append(title, body, status, buttons);
  // A right-click on the window is not a right-click on the world under it.
  made.addEventListener("contextmenu", (event) => event.preventDefault());
  return made;
}

/** The trade as the server now has it (TRADE_STATE): opens the window the first time, and the bags with it. */
export function showTrade(data: TradeState) {
  if (!data || !data.mine || !data.theirs) return;
  const opening = state === null;
  state = data;
  acceptAt = performance.now() + (Number(data.acceptIn) || 0);

  if (!popup) {
    popup = build();
    document.body.appendChild(popup);
    document.addEventListener("keydown", onKey, true);
  }
  if (opening) {
    coinsPending = false;
    document.getElementById("invitation-popup")?.remove();
    openInventory();
  }
  render();
}

/** The trade ended (TRADE_CLOSED), completed or not: the window goes. */
export function closeTrade() {
  window.clearTimeout(acceptTimer);
  window.clearTimeout(coinTimer);
  document.removeEventListener("keydown", onKey, true);
  hideItemTooltip();
  popup?.remove();
  popup = null;
  state = null;
  coinsPending = false;
}
