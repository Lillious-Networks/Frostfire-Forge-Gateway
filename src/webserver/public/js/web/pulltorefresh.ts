// Pull-to-refresh for App view (mobile WebViews without browser chrome and
// therefore without native pull-to-refresh). Drives the #ptr-indicator
// element: the rotate icon follows the finger, releasing past the threshold
// reloads the page. Touch devices only; inert everywhere else.
(() => {
  const indicator = document.getElementById('ptr-indicator') as HTMLElement;
  const icon = document.getElementById('ptr-icon') as HTMLElement;
  const label = document.getElementById('ptr-label');
  if (!indicator || !icon) return;

  // Touch-capable devices only (App view / mobile browsers).
  if (!('ontouchstart' in window) && navigator.maxTouchPoints <= 0) return;

  const THRESHOLD = 75; // px of resisted pull needed to trigger a refresh
  const MAX_PULL = 130; // px of resisted pull before the indicator caps out
  const RESISTANCE = 0.45; // finger travel multiplier (rubber-band feel)
  const SHOW_SLOP = 8; // px of finger travel before the indicator appears
  const ICON_DEG_PER_PX = 4; // rotate-icon spin rate while pulling

  let startY = 0;
  let startX = 0;
  let pullPx = 0;
  let pulling = false; // tracking a candidate gesture
  let shown = false; // indicator is visible (a real drag was detected)
  let refreshing = false;

  function atTop(): boolean {
    const el = document.scrollingElement;
    return (el ? el.scrollTop : window.scrollY) <= 0;
  }

  // True when an inner scroll container above the document (e.g. the realm
  // list, a replay overlay) can still scroll up: the gesture belongs to it.
  // Without this, pages whose document never scrolls would hand EVERY
  // downward drag to pull-to-refresh, flashing the indicator constantly.
  function innerScrollerNeedsGesture(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return false;
    let node: HTMLElement | null = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const oy = window.getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1 && node.scrollTop > 0) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function setPull(px: number): void {
    pullPx = px;
    // -150% keeps pull=0 fully above the viewport regardless of pill height.
    indicator.style.transform = `translate(-50%, calc(-150% + ${px}px))`;
    icon.style.transform = `rotate(${px * ICON_DEG_PER_PX}deg)`;
    const ready = px >= THRESHOLD;
    indicator.classList.toggle('ptr-ready', ready);
    if (label) label.textContent = ready ? 'Release to refresh' : 'Pull to refresh';
  }

  function reset(): void {
    pulling = false;
    shown = false;
    pullPx = 0;
    indicator.classList.remove('ptr-pulling', 'ptr-ready');
    indicator.style.transform = '';
    icon.style.transform = '';
  }

  document.addEventListener('touchstart', (e: TouchEvent) => {
    if (refreshing || pulling || e.touches.length !== 1) return;
    const t = e.target as HTMLElement | null;
    // Never hijack gestures inside modal dialogs.
    if (t && t.closest && t.closest('.modal-overlay')) return;
    if (innerScrollerNeedsGesture(e.target)) return;
    if (!atTop()) return;
    pulling = true;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    // Note: the indicator stays hidden until a real downward drag is
    // detected in touchmove (a tap must never flash it).
  }, { passive: true });

  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (!pulling || refreshing || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    // Mostly-horizontal drags belong to the edge swipe-back gesture.
    if (Math.abs(dx) > Math.abs(dy)) {
      reset();
      return;
    }
    if (dy <= 0 || !atTop()) {
      if (shown && dy <= 0) setPull(0);
      return;
    }
    if (!shown) {
      if (dy < SHOW_SLOP) return; // not a drag yet: keep the indicator hidden
      shown = true;
      indicator.classList.add('ptr-pulling');
    }
    // Take over the gesture so the page doesn't rubber-band underneath.
    e.preventDefault();
    setPull(Math.min(dy * RESISTANCE, MAX_PULL));
  }, { passive: false });

  function endTouch(): void {
    if (!pulling || refreshing) return;
    if (pullPx >= THRESHOLD) {
      refreshing = true;
      indicator.classList.remove('ptr-pulling', 'ptr-ready');
      indicator.classList.add('ptr-refreshing');
      // Settle the pill at the top while the icon spins (CSS animation
      // overrides the inline rotate below).
      indicator.style.transform = 'translate(-50%, 0)';
      if (label) label.textContent = 'Refreshing…';
      window.setTimeout(() => window.location.reload(), 350);
    } else {
      reset();
    }
  }

  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', () => { if (!refreshing) reset(); });
})();
