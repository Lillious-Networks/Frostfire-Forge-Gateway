import { inventoryUI, spellBookUI, friendsListUI, guildContainer, collectablesUI } from "./ui.js";

// State management
let isMenuOpen = false;

// DOM elements
const radialMenuBtn = document.getElementById('radial-menu-btn');
const radialMenu = document.getElementById('radial-menu');
const radialOverlay = document.getElementById('radial-menu-overlay');
const radialItems = document.querySelectorAll('.radial-item');

// Detect touch device
const isTouchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * Calculate circular positions for radial items
 * 8 items at 45° intervals, starting from top (12 o'clock)
 */
function calculateRadialPositions() {
  const itemCount = radialItems.length;
  const radius = 110; // Distance from center

  radialItems.forEach((item, index) => {
    const angle = (index / itemCount) * Math.PI * 2 - Math.PI / 2; // Start from top
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    // Position relative to 140x140 center (50% of 280x280 container)
    item.style.left = `calc(50% + ${x}px - 25px)`;
    item.style.top = `calc(50% + ${y}px - 25px)`;
  });
}

/**
 * Open the radial menu
 */
function openRadialMenu() {
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
  if (!isMenuOpen) return;

  isMenuOpen = false;
  radialMenu.classList.add('closing');
  radialMenu.classList.remove('active');
  radialOverlay.classList.remove('active');
  radialMenuBtn.classList.remove('active');

  // Remove hidden class after animation completes
  setTimeout(() => {
    if (!isMenuOpen) {
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

    // Don't dispatch if no hotkey (e.g., Settings)
    if (hotkey && hotkey !== 'null') {
      dispatchHotkey(hotkey);
    }

    closeRadialMenu();
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
