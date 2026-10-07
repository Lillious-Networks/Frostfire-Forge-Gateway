// Using items: a consumable in the bags (a double-click) or on the hotbar (its
// key, or a click). The server makes every use (USE_ITEM) and answers with the
// player's bags and stats; this file sends the request, draws consumables on
// the hotbar with how many are left, and draws the cooldown clock over them.
//
// A hotbar slot holds a consumable the way it holds a spell, under the name
// "item:<item name>", so the saved hotbar needs nothing new.
//
// There are two cooldowns (ITEM_COOLDOWN): the one every consumable shares,
// and the home item's own.
import { config } from "../web/global.js";
import Cache from "./cache.js";

const cache = Cache.getInstance();

/** What a hotbar slot's name starts with when it holds an item, not a spell. */
export const ITEM_PREFIX = "item:";

type Kind = "consumable" | "home";
interface Remembered { iconUrl: string | null; home: boolean; quality?: string }

const lower = (text: unknown) => String(text ?? "").toLowerCase();
const amount = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
const missingIcon = () => `${config.ASSET_SERVER_URL}/icon?name=missing_icon`;

/** The item a hotbar slot holds, when it holds one. */
export function itemOfSlot(slot: HTMLElement | null | undefined): string | null {
  const name = slot?.dataset?.spellName;
  return name && name.startsWith(ITEM_PREFIX) ? name.slice(ITEM_PREFIX.length) : null;
}

/** The item of that name in the player's bags. */
export function heldItem(name: string | null | undefined): any | null {
  if (!name) return null;
  return (cache.inventory || []).find((item: any) => lower(item.name) === lower(name)) ?? null;
}

/** Whether an item is the home item: the one that takes its player home, and is never used up. */
export function teleportsHome(item: any): boolean {
  return !!item && item.type === "consumable" && !!item.teleports_home && item.teleports_home !== "0";
}

/** Whether using an item does anything. */
export function isUsable(item: any): boolean {
  if (!item || item.type !== "consumable") return false;
  return teleportsHome(item) || amount(item.restore_health) > 0 || amount(item.restore_stamina) > 0;
}

/** What using an item does, in the words of its tooltip. Nothing for an item with no use. */
export function useText(item: any): string | null {
  if (!isUsable(item)) return null;
  if (teleportsHome(item)) return "Use: Returns you to your home inn.";
  const parts = [
    amount(item.restore_health) > 0 ? `${amount(item.restore_health)} health` : "",
    amount(item.restore_stamina) > 0 ? `${amount(item.restore_stamina)} stamina` : "",
  ].filter(Boolean);
  return `Use: Restores ${parts.join(" and ")}.`;
}

// ------------------------------------------------- items no longer in the bags

// A consumable stays on the hotbar when the last one is used: what it looked like is kept here, and
// across visits, so its slot can still be drawn.
const REMEMBERED_KEY = "hotbar-items";
let remembered: Record<string, Remembered> = {};
try {
  remembered = JSON.parse(localStorage.getItem(REMEMBERED_KEY) || "{}") || {};
} catch {
  remembered = {};
}

function remember(item: any): void {
  const next: Remembered = { iconUrl: item.iconUrl || null, home: teleportsHome(item), quality: item.quality };
  const key = lower(item.name);
  const before = remembered[key];
  if (before && before.iconUrl === next.iconUrl && before.home === next.home && before.quality === next.quality) return;
  remembered[key] = next;
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(remembered));
  } catch {
    // Kept for this visit only.
  }
}

/** The item a hotbar slot holds, as much as is known of it: from the bags, or as it was when last seen there. */
export function itemForSlot(slot: HTMLElement): any | null {
  const name = itemOfSlot(slot);
  if (!name) return null;
  const held = heldItem(name);
  if (held) return held;
  const known = remembered[lower(name)];
  return known ? { name, type: "consumable", quality: known.quality || "common", iconUrl: known.iconUrl, teleports_home: known.home, quantity: 0 } : null;
}

const kindOf = (item: any): Kind => (teleportsHome(item) ? "home" : "consumable");

// ------------------------------------------------------------------- cooldowns

const cooldowns: Partial<Record<Kind, { start: number; end: number }>> = {};
let frame = 0;

const hotbarSlots = () => Array.from(document.querySelectorAll("#hotbar #grid .slot")) as HTMLDivElement[];
const bagSlots = () => Array.from(document.querySelectorAll("#inventory #grid .slot")) as HTMLDivElement[];

/** Every slot on screen that holds a usable item of a kind: in the bags and on the hotbar. */
function slotsOf(kind: Kind): HTMLDivElement[] {
  const bags = bagSlots().filter((slot) => {
    const item = heldItem(slot.dataset.itemName);
    return isUsable(item) && kindOf(item) === kind;
  });
  const bar = hotbarSlots().filter((slot) => {
    const item = itemForSlot(slot);
    return !!item && kindOf(item) === kind;
  });
  return [...bags, ...bar];
}

/**
 * How long is left of a cooldown, as it is written over the clock: hours rounded up while more
 * than an hour is left ("2h" for 1 hour 15 minutes, "1h" for the hour exactly), then the minutes
 * left ("59m"), and seconds only in the last minute ("42s").
 */
export function cooldownLabel(remainingMs: number): string {
  const left = Math.max(0, Number(remainingMs) || 0);
  if (left >= 3_600_000) return `${Math.ceil(left / 3_600_000)}h`;
  if (left >= 60_000) return `${Math.floor(left / 60_000)}m`;
  // Rounded up, so the last second reads "1s", and never past 59: just under a minute is not "60s".
  return `${Math.min(59, Math.max(1, Math.ceil(left / 1000)))}s`;
}

function overlayOf(slot: HTMLDivElement): HTMLDivElement {
  let overlay = slot.querySelector(".item-cooldown") as HTMLDivElement | null;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "cooldown-overlay item-cooldown";
    const time = document.createElement("span");
    time.className = "cooldown-time";
    overlay.appendChild(time);
    slot.appendChild(overlay);
  }
  return overlay;
}

/** Draws a slot's clock: how far round it is, and how long is left written over it. */
function drawClock(slot: HTMLDivElement, progress: number, label: string): void {
  const overlay = overlayOf(slot);
  overlay.style.background = `conic-gradient(transparent ${progress * 360}deg, rgba(0, 0, 0, 0.6) ${progress * 360}deg)`;
  const time = overlay.firstElementChild as HTMLElement | null;
  // Written only when it changes: the clock is drawn every frame.
  if (time && time.textContent !== label) time.textContent = label;
}

// Drawn every frame while a cooldown runs, so slots the bags have just drawn again get their clock too.
function tick(): void {
  const now = performance.now();
  let running = false;
  for (const kind of Object.keys(cooldowns) as Kind[]) {
    const cooldown = cooldowns[kind]!;
    const total = cooldown.end - cooldown.start;
    const progress = total > 0 ? Math.max(0, Math.min(1, (now - cooldown.start) / total)) : 1;
    const over = now >= cooldown.end;
    const label = cooldownLabel(cooldown.end - now);
    for (const slot of slotsOf(kind)) {
      if (over) slot.querySelector(".item-cooldown")?.remove();
      else drawClock(slot, progress, label);
    }
    if (over) delete cooldowns[kind];
    else running = true;
  }
  frame = running ? requestAnimationFrame(tick) : 0;
}

/** A cooldown started, or is still running as the player logs in: `remaining` of `total` milliseconds are left. */
export function startItemCooldown(kind: string, remaining: number, total: number): void {
  if (kind !== "consumable" && kind !== "home") return;
  const left = Number(remaining) || 0;
  const whole = Math.max(left, Number(total) || 0);
  if (left <= 0) return;
  const now = performance.now();
  cooldowns[kind] = { start: now - (whole - left), end: now + left };
  if (!frame) frame = requestAnimationFrame(tick);
}

/** Every item cooldown ends now: an admin reset them (COOLDOWNS_RESET). */
export function clearItemCooldowns(): void {
  for (const kind of Object.keys(cooldowns) as Kind[]) cooldowns[kind]!.end = 0;
  // Each is over as the clock next reads it, which takes it off its slots.
  if (frame) cancelAnimationFrame(frame);
  tick();
}

/** Whether an item cannot be used yet. */
function onCooldown(item: any): boolean {
  const cooldown = cooldowns[kindOf(item)];
  return !!cooldown && performance.now() < cooldown.end;
}

// ------------------------------------------------------------------------ using

/** Asks the server to use an item from the bags. Nothing is sent for one that is not held, has no use, or is on cooldown. */
export function useItem(name: string | null | undefined): boolean {
  const item = heldItem(name);
  if (!item || !isUsable(item) || onCooldown(item)) return false;
  (window as any).sendRequest?.({ type: "USE_ITEM", data: { item: item.name } });
  return true;
}

// ------------------------------------------------------------------- the hotbar

/** Draws a hotbar slot that holds an item: its icon, how many are left, and greyed when there are none. */
function drawSlot(slot: HTMLDivElement): void {
  const name = itemOfSlot(slot);
  if (!name) {
    // A spell, or nothing: what an item left behind goes.
    slot.classList.remove("item-out");
    slot.querySelector(".hotbar-item-count")?.remove();
    slot.querySelector(".item-cooldown")?.remove();
    return;
  }
  const held = heldItem(name);
  if (held) remember(held);
  const item = itemForSlot(slot);
  // A spell's clock left on the slot goes with the rest: only the key and this item's own clock stay.
  const kept = Array.from(slot.children).filter((child) => child.classList.contains("hotbar-key") || child.classList.contains("item-cooldown"));
  slot.innerHTML = "";
  kept.forEach((child) => slot.appendChild(child));

  const icon = new Image();
  icon.draggable = false;
  icon.addEventListener("error", () => {
    if (icon.src !== missingIcon()) icon.src = missingIcon();
  }, { once: true });
  icon.src = item?.iconUrl || missingIcon();
  slot.appendChild(icon);

  const count = held ? amount(held.quantity) : 0;
  // The home item is never used up: how many there are says nothing.
  if (!item || !teleportsHome(item)) {
    const badge = document.createElement("div");
    badge.className = "hotbar-item-count";
    badge.textContent = String(count);
    slot.appendChild(badge);
  }
  slot.classList.toggle("item-out", count === 0);
}

/** Draws every hotbar slot that holds an item again: after the bags changed, or the hotbar did. */
export function refreshHotbarItems(): void {
  hotbarSlots().forEach(drawSlot);
  if (Object.keys(cooldowns).length > 0 && !frame) frame = requestAnimationFrame(tick);
}

/** Puts an item from the bags on a hotbar slot. Whether it was: only an item with a use goes there. */
export function placeItemOnHotbar(slot: HTMLDivElement, name: string | null | undefined): boolean {
  const item = heldItem(name);
  if (!item || !isUsable(item)) return false;
  slot.dataset.spellName = ITEM_PREFIX + item.name;
  slot.classList.remove("empty");
  drawSlot(slot);
  return true;
}
