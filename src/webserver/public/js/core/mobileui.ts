// State management
let isMenuOpen = false;

// DOM elements
const radialMenuBtn = document.getElementById('radial-menu-btn') as HTMLElement | null;
const radialMenu = document.getElementById('radial-menu') as HTMLElement | null;
const radialOverlay = document.getElementById('radial-menu-overlay') as HTMLElement | null;
const radialItems = document.querySelectorAll('.radial-item') as NodeListOf<HTMLElement>;

/**
 * Calculate circular positions for radial items
 * 8 items at 45° intervals, starting from top (12 o'clock)
 */
function calculateRadialPositions() {
  const visibleItems = Array.from(radialItems).filter(item => {
    if (item.classList.contains("admin-only") && !item.classList.contains("visible")) return false;
    return true;
  });
  const itemCount = visibleItems.length;
  const radius = 110;

  visibleItems.forEach((item, index) => {
    const angle = (index / itemCount) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    item.style.left = `calc(50% + ${x}px - 25px)`;
    item.style.top = `calc(50% + ${y}px - 25px)`;
  });
}

/**
 * Open the radial menu
 */
function openRadialMenu() {
  if (!radialMenu || !radialOverlay || !radialMenuBtn) return;
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
  });
});

// Initialize positions on load
document.addEventListener('DOMContentLoaded', () => {
  calculateRadialPositions();
});

// Recalculate on resize
window.addEventListener('resize', calculateRadialPositions);

// Export closeRadialMenu for use in other modules
export { closeRadialMenu, openRadialMenu, toggleRadialMenu, calculateRadialPositions };
