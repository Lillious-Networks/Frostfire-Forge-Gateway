// Targeting for server-authoritative creatures.
// Mouse: left click targets, right click targets and starts auto-attack.
// Touch: tap targets; tap the current target again to auto-attack; tap a
// lootable corpse to loot it (touch has no right click).
import { sendRequest, getIsLoaded } from "./socket.js";
import { isSelfActionLocked } from "./death.js";
import Cache from "./cache.js";
import { getCameraX, getCameraY } from "./renderer.js";
import { canvas } from "./ui.js";
import { creatures, creatureAt, creatureTargetKey, getAutoAttackingId, parseCreatureTarget, setAutoAttackingId } from "./creature.js";
import creatureEditor from "./creatureeditor.js";
import { getScreenView, screenToWorldCss } from "./skeletons.js";

const cache = Cache.getInstance();

/** Extra world pixels around a creature that still count as a tap on it. */
const TOUCH_SLOP = 24;
/** Extra world pixels around a creature that still count as a mouse click on it. */
const CLICK_SLOP = 10;
/** A touch this short and still is a tap, not a joystick drag or long-press. */
const TAP_MAX_MS = 500;
const TAP_MAX_MOVE_PX = 12;
/** A synthetic click right after a handled tap is ignored (it would re-hit-test without slop). */
const CLICK_AFTER_TAP_MS = 700;
let lastTouchTapAt = 0;

/**
 * Screen point -> world point. Uses the shared projection so touch devices get
 * the 0.85 render zoom right; the plain formula below it ignores the zoom and
 * put every tap off target, further off the further it was from the centre.
 */
function worldFromClient(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const view = getScreenView();
  if (view) return screenToWorldCss(clientX - rect.left, clientY - rect.top, view);
  const screenX = clientX - rect.left;
  const screenY = clientY - rect.top;
  let mapCenterOffsetX = 0;
  if (window.mapData) {
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    if (mapWidth < window.innerWidth) mapCenterOffsetX = (window.innerWidth - mapWidth) / 2;
  }
  return {
    x: screenX - window.innerWidth / 2 + getCameraX() - mapCenterOffsetX,
    y: screenY - window.innerHeight / 2 + getCameraY(),
  };
}

function shouldIgnore(event: MouseEvent): boolean {
  if (!getIsLoaded()) return true;
  if ((window as any).tileEditor?.isActive) return true;
  if (cache.groundTargetingSpell) return true;
  return !!(event.target as HTMLElement)?.closest?.(".ui");
}

function clearPlayerTargets(): void {
  for (const p of cache.players) {
    if (p?.targeted) p.targeted = false;
  }
}

export function stopCreatureAutoAttack(): void {
  if (getAutoAttackingId() === null) return;
  setAutoAttackingId(null);
  sendRequest({ type: "CREATURE_ATTACK", data: { id: null } });
}

/** A target further than this (world px) from the local player is dropped. */
const MAX_TARGET_DISTANCE = 600;

/**
 * Drop the current target once it is too far from the local player: a targeted
 * creature (stopping auto-attack on it) or a targeted player. Uses server
 * positions, not render positions. Called every frame; cheap when nothing is
 * targeted.
 */
export function dropDistantTarget(self: any): void {
  const sx = self?.position?.x;
  const sy = self?.position?.y;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
  const tooFar = (x: number, y: number) => (x - sx) ** 2 + (y - sy) ** 2 > MAX_TARGET_DISTANCE ** 2;

  const creatureId = parseCreatureTarget(cache.targetId);
  if (creatureId !== null) {
    const c = creatures.get(creatureId);
    if (c && tooFar(c.x, c.y)) {
      cache.targetId = null;
      stopCreatureAutoAttack();
    }
  }

  for (const p of cache.players) {
    if (p?.targeted && p.id !== self.id && p.position && tooFar(p.position.x, p.position.y)) {
      p.targeted = false;
    }
  }
}

export function startCreatureAutoAttack(id: number): void {
  if (isSelfActionLocked()) return;
  setAutoAttackingId(id);
  sendRequest({ type: "CREATURE_ATTACK", data: { id } });
}

const worldFromEvent = (event: MouseEvent) => worldFromClient(event.clientX, event.clientY);

// Capture phase so a creature click never falls through to player/NPC selection.
document.addEventListener(
  "click",
  (event) => {
    if (shouldIgnore(event)) return;
    // The tap handler below already dealt with this touch; its synthetic click
    // would re-test without touch slop and could clear the target it just set.
    if (Date.now() - lastTouchTapAt < CLICK_AFTER_TAP_MS) {
      event.stopPropagation();
      return;
    }
    const world = worldFromEvent(event);
    const creature = creatureAt(world.x, world.y, false, CLICK_SLOP);
    if (!creature) {
      if (parseCreatureTarget(cache.targetId) !== null) {
        cache.targetId = null;
        stopCreatureAutoAttack();
      }
      return;
    }
    event.stopPropagation();
    clearPlayerTargets();
    if (parseCreatureTarget(cache.targetId) !== creature.id) stopCreatureAutoAttack();
    cache.targetId = creatureTargetKey(creature.id);
  },
  true
);

document.addEventListener(
  "contextmenu",
  (event) => {
    if (shouldIgnore(event)) return;
    const world = worldFromEvent(event);
    // While the editor is open, right-click opens creature admin actions instead.
    if (creatureEditor.isActive && creatureEditor.creatureAction(world.x, world.y)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const creature = creatureAt(world.x, world.y, false, CLICK_SLOP);
    if (!creature) {
      const corpse = creatureAt(world.x, world.y, true, CLICK_SLOP);
      if (corpse?.lootable) {
        event.preventDefault();
        event.stopPropagation();
        sendRequest({ type: "CREATURE_LOOT", data: { id: corpse.id } });
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearPlayerTargets();
    cache.targetId = creatureTargetKey(creature.id);
    startCreatureAutoAttack(creature.id);
  },
  true
);

// ------------------------------------------------------------------ touch

let touchStartX = 0;
let touchStartY = 0;
let touchStartAt = 0;
let touchTargetUi = false;

const isTouchDevice = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

// Passive listeners: they never block scrolling, the joystick or zoom handling.
document.addEventListener(
  "touchstart",
  (event) => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartAt = Date.now();
    // Taps on HUD panels, the joystick or buttons are not world taps.
    touchTargetUi = !!(event.target as HTMLElement)?.closest?.(".ui");
  },
  { passive: true, capture: true }
);

document.addEventListener(
  "touchend",
  (event) => {
    if (!isTouchDevice() || touchTargetUi) return;
    if (!getIsLoaded() || (window as any).tileEditor?.isActive || cache.groundTargetingSpell) return;
    const touch = event.changedTouches[0];
    if (!touch || event.changedTouches.length !== 1) return;
    if (Date.now() - touchStartAt > TAP_MAX_MS) return;
    if (Math.abs(touch.clientX - touchStartX) > TAP_MAX_MOVE_PX) return;
    if (Math.abs(touch.clientY - touchStartY) > TAP_MAX_MOVE_PX) return;

    const world = worldFromClient(touch.clientX, touch.clientY);
    const creature = creatureAt(world.x, world.y, false, TOUCH_SLOP);
    if (creature) {
      lastTouchTapAt = Date.now();
      // Tapping the creature you already have targeted attacks it.
      if (parseCreatureTarget(cache.targetId) === creature.id) {
        if (getAutoAttackingId() !== creature.id) startCreatureAutoAttack(creature.id);
        return;
      }
      clearPlayerTargets();
      stopCreatureAutoAttack();
      cache.targetId = creatureTargetKey(creature.id);
      return;
    }

    const corpse = creatureAt(world.x, world.y, true, TOUCH_SLOP);
    if (corpse?.lootable) {
      lastTouchTapAt = Date.now();
      sendRequest({ type: "CREATURE_LOOT", data: { id: corpse.id } });
    }
    // Empty ground: left to the normal click, which clears the target.
  },
  { passive: true, capture: true }
);
