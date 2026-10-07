import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import controlPanel from "./controlpanel.js";

// State management
let isMenuOpen = false;

// DOM elements
const radialMenuBtn = document.getElementById('radial-menu-btn') as HTMLElement | null;
const radialMenu = document.getElementById('radial-menu') as HTMLElement | null;
const radialOverlay = document.getElementById('radial-menu-overlay') as HTMLElement | null;
const radialItems = document.querySelectorAll('.radial-item') as NodeListOf<HTMLElement>;

/**
 * Calculate circular positions for radial items
 * The items at even intervals, starting from top (12 o'clock)
 */
function calculateRadialPositions() {
  // (only the entries that are shown: one that is for admins is not there for anyone else, and leaves no gap)
  const shown = Array.from(radialItems).filter((item) => !item.hidden);
  const itemCount = shown.length;
  const radius = 110;

  shown.forEach((item, index) => {
    const angle = (index / itemCount) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    item.style.left = `calc(50% + ${x}px - 25px)`;
    item.style.top = `calc(50% + ${y}px - 25px)`;
  });
}

/**
 * The entries that are for admins (data-admin, in game.html) are shown to an admin and to nobody else, looked at each
 * time the menu opens: the role can be given or taken while the game is open. What they do is still the server's to
 * allow. USER REQUEST 2026-10-07: "Add a new entry in the action menu for admins only that opens the control panel".
 */
function showAdminEntries() {
  const self: any = Array.from(Cache.getInstance().players as Iterable<any>).find((player) => player.id === cachedPlayerId);
  const isAdmin = !!self?.isAdmin;
  let changed = false;
  radialItems.forEach((item) => {
    if (!item.hasAttribute('data-admin') || item.hidden === !isAdmin) return;
    item.hidden = !isAdmin;
    changed = true;
  });
  if (changed) calculateRadialPositions();
}

/**
 * Open the radial menu
 */
function openRadialMenu() {
  if (!radialMenu || !radialOverlay || !radialMenuBtn) return;
  showAdminEntries();
  isMenuOpen = true;
  radialMenu.classList.remove('hidden', 'closing');
  radialMenu.classList.add('active');
  radialOverlay.classList.add('active');
  radialMenuBtn.classList.add('active');
}

/**
 * Close the radial menu
 */
function closeRadialMenu() {
  if (!isMenuOpen || !radialMenu || !radialOverlay || !radialMenuBtn) return;

  isMenuOpen = false;
  radialMenu.classList.add('closing');
  radialMenu.classList.remove('active');
  radialOverlay.classList.remove('active');
  radialMenuBtn.classList.remove('active');

  // Remove hidden class after animation completes
  setTimeout(() => {
    if (!isMenuOpen && radialMenu) {
      radialMenu.classList.add('hidden');
    }
  }, 300);
}

/**
 * Toggle radial menu open/close
 */
function toggleRadialMenu() {
  if (isMenuOpen) {
    closeRadialMenu();
  } else {
    openRadialMenu();
  }
}

/**
 * Dispatch a hotkey event as if user pressed the key
 */
function dispatchHotkey(keyCode: string) {
  const event = new KeyboardEvent('keydown', {
    code: keyCode,
    key: keyCode === 'KeyB' ? 'b' :
         keyCode === 'KeyP' ? 'p' :
         keyCode === 'KeyC' ? 'c' :
         keyCode === 'KeyO' ? 'o' :
         keyCode === 'KeyG' ? 'g' :
         keyCode === 'KeyK' ? 'k' :
         keyCode === 'KeyM' ? 'm' :
         keyCode === 'KeyQ' ? 'q' : '',
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
}

// Event listeners
radialMenuBtn?.addEventListener('click', toggleRadialMenu);

radialOverlay?.addEventListener('click', closeRadialMenu);

radialItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    const hotkey = item.getAttribute('data-hotkey');

    // Close menu first, then dispatch hotkey to avoid race conditions on mobile
    closeRadialMenu();

    // Add small delay to ensure menu closes before hotkey is processed
    if (hotkey && hotkey !== 'null') {
      setTimeout(() => {
        dispatchHotkey(hotkey);
      }, 50);
    }

    // The control panel has no key. Its window is opened here, in the tap itself: a phone's browser only lets a
    // window open while a tap is being answered. Sent as the /cp command, the window opened when the server's
    // answer came back, after the tap was over, and the browser refused it (USER REPORT 2026-10-07: "Nothing
    // opens"). The command only ever checked the role and told this page to open the window; everything the panel
    // then asks for is checked by the server, request by request, so nothing is opened up by not asking first.
    if (item.getAttribute('data-action') === 'controlpanel') {
      controlPanel.toggle();
    }
  });
});

// Initialize positions on load
document.addEventListener('DOMContentLoaded', () => {
  calculateRadialPositions();
});

// Recalculate on resize
window.addEventListener('resize', calculateRadialPositions);

// Export closeRadialMenu for use in other modules
export { closeRadialMenu, openRadialMenu, toggleRadialMenu };
