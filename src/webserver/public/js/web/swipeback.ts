// Edge swipe (left-to-right) to go back, with a finger-following animation.
// For App view (touch devices): drag in from the left edge and the page
// follows; release past the threshold and it slides away, then navigates.
// Touch devices only; inert everywhere else.
(() => {
  const container = document.querySelector('.container') as HTMLElement;
  const backButton = document.querySelector('.home-button') as HTMLElement;
  if (!container || !backButton) return;

  // Touch-capable devices only (App view / mobile browsers).
  if (!('ontouchstart' in window) && navigator.maxTouchPoints <= 0) return;

  const EDGE = 32; // px from the left edge where a swipe may start
  const CLAIM = 14; // px of rightward travel before the gesture is claimed
  const THRESHOLD = 110; // px of travel needed to trigger going back
  const FOLLOW = 1; // page follows the finger 1:1 while dragging
  const HINT_KEY = 'swipeback-hint-shown';

  let startX = 0;
  let startY = 0;
  let followX = 0;
  let active = false; // tracking a candidate swipe
  let claimed = false; // owning the gesture (blocking scroll)
  let done = false; // navigating away, ignore further input

  function targetOk(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el || !el.closest) return true;
    if (el.closest('.modal-overlay')) return false; // never hijack modal gestures
    if (el.closest('input, textarea, select')) return false; // nor text editing
    return true;
  }

  function setFollow(dx: number): void {
    const w = window.innerWidth;
    followX = Math.min(Math.max(dx, 0), w);
    container.style.transition = 'none';
    container.style.transform = `translateX(${followX * FOLLOW}px)`;
    container.style.opacity = `${1 - (followX / w) * 0.35}`;
    container.classList.add('swipe-drag');
    // The back button rides along and lights up past the threshold.
    backButton.style.transition = 'none';
    backButton.style.transform = `translateX(${Math.min(followX * 0.18, 16)}px)`;
    backButton.classList.toggle('swipe-armed', followX >= THRESHOLD);
  }

  function springBack(): void {
    container.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
    container.style.transform = '';
    container.style.opacity = '';
    container.classList.remove('swipe-drag');
    backButton.style.transition = '';
    backButton.style.transform = '';
    backButton.classList.remove('swipe-armed');
    followX = 0;
    window.setTimeout(() => {
      if (!claimed) container.style.transition = '';
    }, 260);
  }

  function goBack(): void {
    done = true;
    const w = window.innerWidth;
    container.style.transition = 'transform 0.22s ease-out, opacity 0.22s ease-out';
    container.style.transform = `translateX(${w}px)`;
    container.style.opacity = '0';
    window.setTimeout(() => {
      window.location.href = '/game';
    }, 230);
  }

  document.addEventListener('touchstart', (e: TouchEvent) => {
    if (done || active || e.touches.length !== 1) return;
    if (e.touches[0].clientX > EDGE) return;
    if (!targetOk(e.target)) return;
    active = true;
    claimed = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e: TouchEvent) => {
    if (!active || done || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!claimed) {
      // Vertical scrolling (and pull-to-refresh) keep gestures that
      // move mostly up/down; taps pass through untouched.
      if (dx < 0 || Math.abs(dy) > Math.abs(dx)) {
        active = false;
        return;
      }
      if (dx < CLAIM) return;
      claimed = true;
    }
    if (dx <= 0) {
      setFollow(0);
      return;
    }
    e.preventDefault();
    setFollow(dx);
  }, { passive: false });

  function endTouch(): void {
    if (!active || done) return;
    active = false;
    if (!claimed) return;
    claimed = false;
    if (followX >= THRESHOLD) {
      goBack();
      return;
    }
    springBack();
  }

  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', () => {
    if (done) return;
    if (claimed) {
      claimed = false;
      active = false;
      springBack();
    } else {
      active = false;
    }
  });

  // One-time nudge teaching the gesture, shortly after load.
  function hintSeen(): boolean {
    try {
      return window.sessionStorage.getItem(HINT_KEY) === '1';
    } catch {
      return true; // storage blocked: skip the hint
    }
  }
  function markHintSeen(): void {
    try {
      window.sessionStorage.setItem(HINT_KEY, '1');
    } catch {
      // ignore (private mode etc.)
    }
  }
  if (!hintSeen()) {
    markHintSeen();
    window.setTimeout(() => {
      if (done || active) return;
      // No hint when the button itself is hidden (e.g. touch devices).
      if (window.getComputedStyle(backButton).display === 'none') return;
      backButton.classList.add('swipe-hint');
      window.setTimeout(() => backButton.classList.remove('swipe-hint'), 1400);
    }, 900);
  }
})();
