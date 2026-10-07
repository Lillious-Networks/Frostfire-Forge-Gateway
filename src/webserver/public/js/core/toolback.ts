// What a tool window needs on a touch screen that it does not with a mouse: a way back to the game, and not to be
// zoomed (the end of this file).
//
// The control panel and the editors each open in a window of their own (window.open, from the game). With a mouse
// that window has the browser's own frame to close it by. A phone or a tablet shows it as a whole screen with no
// frame at all, and there was nothing to leave it by. USER REPORT 2026-10-07: "panels like control panel work on
// mobile but there's no way to go back to the game".
//
// So, in a window the game opened, on a touch screen, the bar across the top starts with a "Back to game" button:
// it closes this window, which is what brings the game back. Every tool window is built from toolkit.ts, which
// loads this, and has that bar (.tl-topbar, css/tools.css).

const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)");

function backButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tl-btn tl-back";
  button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg><span>Back to game</span>';
  button.addEventListener("click", () => {
    window.close();
    // A window that would not close (the browser kept it): the game's window is asked to come forward at least.
    setTimeout(() => { try { window.opener?.focus(); } catch { /* not allowed: the window stays as it is */ } }, 300);
  });
  return button;
}

function install(): void {
  if (!window.opener) return;
  const bar = document.querySelector(".tl-topbar");
  if (!bar) return;
  const button = backButton();
  // First in the bar, where "back" is looked for. The window's own script fills the bar after this, and may fill it
  // again: the button is put back whenever it has been taken out.
  const place = () => {
    button.hidden = !TOUCH.matches;
    if (bar.firstElementChild !== button) bar.prepend(button);
  };
  place();
  new MutationObserver(place).observe(bar, { childList: true });
  TOUCH.addEventListener("change", place);
}

/**
 * A tool window is not zoomed on a touch screen (USER REQUEST 2026-10-07: "Prevent zooming in on these windows on
 * mobile"). Three things zoomed it, and each has its own stop:
 *  - tapping a field, whose text is smaller than a phone likes: the page's viewport line says the scale stays at 1
 *    (each tool's .html);
 *  - a double tap: touch-action in css/tools.css;
 *  - two fingers spread apart, which an iPhone allows whatever the viewport line says: stopped here.
 * With a mouse nothing is stopped: Ctrl and the wheel still zoom the window, as in any other.
 */
function noPinchZoom(): void {
  if (!TOUCH.matches) return;
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  document.addEventListener("touchmove", (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
}

/**
 * The side pane of the map editor and of the animation editor, on a small window (a phone, either way up). An
 * editor of records has its list slide over the page there, on a button of its own (tooleditor.ts, showList).
 * These two are not built from that shell but are laid out the same, a side pane and the page beside it, and had
 * the same fault: the pane took most of a phone's width. They are given the same button here, first in the top
 * bar (after the way back to the game), and the same class on the window, which css/tools.css slides the pane by.
 * It stays out until it is put away, by the button again or a tap beside it: what is in it is worked with for a
 * while, not picked from once. USER REQUEST 2026-10-07: "Update other panels to work on mobile landscape and
 * portrait".
 */
function sidePane(): void {
  const app = document.querySelector<HTMLElement>(".tl-app.me-app, .tl-app.an-app");
  const bar = app?.querySelector(".tl-topbar");
  if (!app || !bar || !app.querySelector(".tl-side")) return;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tl-icon-btn tl-list-toggle";
  toggle.setAttribute("aria-label", "Show or hide the side panel");
  toggle.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01"/></svg>';
  toggle.addEventListener("click", () => app.classList.toggle("is-list-open"));
  // It only moves a pane of this window: a window that switches every button off (the map editor does, opened by
  // hand with no game to talk to) is not to switch this one off with them, or the pane could not be reached.
  new MutationObserver(() => { if (toggle.disabled) toggle.disabled = false; }).observe(toggle, { attributes: true, attributeFilter: ["disabled"] });
  const scrim = document.createElement("div");
  scrim.className = "tl-scrim";
  scrim.addEventListener("click", () => app.classList.remove("is-list-open"));
  app.appendChild(scrim);
  // Before the bar's own things, and after the way back to the game when that is there: put back when the window's
  // script fills the bar again.
  const place = () => {
    const back = bar.querySelector(":scope > .tl-back");
    const wanted = back ? back.nextElementSibling : bar.firstElementChild;
    if (wanted !== toggle) bar.insertBefore(toggle, back ? back.nextSibling : bar.firstChild);
  };
  place();
  new MutationObserver(place).observe(bar, { childList: true });
}

/**
 * A tool window keeps to the part of the screen that is seen, on a touch screen. Turned from sideways to upright
 * and back, a phone's browser left the window laid out for the way it had been held and what is seen of it moved:
 * everything stood about a hundred px too low (USER REPORT 2026-10-07: "All panels get shifted down by about 100px
 * when rotated from landscape to portrait and back"). So the window is pinned to the top of the screen and given
 * the height that is seen (css/tools.css reads --tl-vh), and both are put right again whenever the phone is turned,
 * the window is shown again or the browser's own bars come and go: at once, and a few times after, because the
 * browser is still settling when it tells of it. Left alone while a field has the keyboard, which is the browser
 * moving the page on purpose.
 */
function keepToScreen(): void {
  if (!TOUCH.matches) return;
  const settle = () => {
    const active = document.activeElement as HTMLElement | null;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable) return;
    if (window.scrollX !== 0 || window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) !== 0) window.scrollTo(0, 0);
    document.documentElement.style.setProperty("--tl-vh", `${Math.round(window.visualViewport?.height || window.innerHeight)}px`);
  };
  const soon = () => { for (const delay of [0, 120, 400, 900]) setTimeout(settle, delay); };
  document.documentElement.classList.add("tl-touch");
  soon();
  for (const type of ["resize", "orientationchange", "pageshow", "focus"]) window.addEventListener(type, soon);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(); });
  // (and when a field gives the keyboard back)
  document.addEventListener("focusout", soon);
  window.visualViewport?.addEventListener("resize", settle);
  window.visualViewport?.addEventListener("scroll", settle);
}

if (typeof document !== "undefined") {
  noPinchZoom();
  keepToScreen();
  const ready = () => { install(); sidePane(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
}

export {};
