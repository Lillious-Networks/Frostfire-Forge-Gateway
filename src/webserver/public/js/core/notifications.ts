// The game's notifications: short messages from the server, and what the connection is doing.
//
// They are stacked at the bottom right, over everything else on the page. A new one is added at
// the bottom, which moves the ones before it up. Each closes by itself once it has had time to be
// read, or at once from the x beside it.
//
// USER REQUEST 2026-10-06: "They should be on the bottom right and as multiple come in, shift them
// upwards. Allow closing them early too with an x next to each one. It should be on top of all
// layers."

/** How long a notification stays (ms): this, and a little for each character of it. */
const BASE_MS = 5000;
const PER_CHARACTER_MS = 100;
/** How many are shown at once: past it, the oldest goes. */
const SHOWN_MAX = 5;
/** How long the way out takes (ms): the CSS transition of `.game-notification`. */
const LEAVE_MS = 220;

interface Shown {
  node: HTMLDivElement;
  message: string;
  /** Stays until it is closed or replaced: what the connection is doing. */
  standing: boolean;
  timer: number;
}

const shown: Shown[] = [];

function stack(): HTMLElement | null {
  let container = document.getElementById("game-notifications");
  if (!container && document.body) {
    container = document.createElement("div");
    container.id = "game-notifications";
    container.className = "ui";
    document.body.appendChild(container);
  }
  if (container && !container.hasAttribute("role")) {
    // Read out as they arrive, without taking the player's place on the page.
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
  }
  return container;
}

/** Takes a notification away: it fades and closes up, and the ones above it come down. */
function dismiss(entry: Shown): void {
  const index = shown.indexOf(entry);
  if (index === -1) return;
  shown.splice(index, 1);
  window.clearTimeout(entry.timer);
  const node = entry.node;
  // From the height it has to none, so the stack closes up smoothly.
  node.style.height = `${node.offsetHeight}px`;
  void node.offsetHeight;
  node.classList.add("leaving");
  node.style.height = "0px";
  window.setTimeout(() => node.remove(), LEAVE_MS);
}

/** Starts, or starts again, the time a notification has before it closes by itself. */
function lastFor(entry: Shown, ms: number): void {
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => dismiss(entry), ms);
}

/** Leaves the game for the page it was entered from: the connection is gone for good. */
function leaveGame(): void {
  if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") window.close();
  else window.location.href = "/";
}

/**
 * Shows a notification. `autoClose`: it closes by itself; one that does not stands until it is
 * closed, or until the next standing one takes its place (the connection's attempts follow each
 * other in one notification, not a pile of them). `reconnect`: the game is left once it has been
 * shown for its time, whether or not it was closed.
 */
export function showNotification(message: string, autoClose: boolean = true, reconnect: boolean = false): void {
  const text = String(message ?? "");
  const lasts = BASE_MS + text.length * PER_CHARACTER_MS;
  if (reconnect) window.setTimeout(leaveGame, lasts);

  const container = stack();
  if (!container) return;

  // The same message again while it is still shown: it is shown for its time again, not twice.
  const same = shown.find((entry) => entry.message === text && entry.standing === !autoClose);
  if (same) {
    if (autoClose) lastFor(same, lasts);
    same.node.classList.remove("again");
    void same.node.offsetHeight;
    same.node.classList.add("again");
    return;
  }
  if (!autoClose) shown.filter((entry) => entry.standing).forEach(dismiss);

  const node = document.createElement("div");
  node.className = "game-notification ui";
  const body = document.createElement("div");
  body.className = "game-notification-text ui";
  body.innerText = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "game-notification-close ui";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  node.append(body, close);

  const entry: Shown = { node, message: text, standing: !autoClose, timer: 0 };
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss(entry);
  });
  // A click on a notification is not a click on the world under it.
  node.addEventListener("mousedown", (event) => event.stopPropagation());

  shown.push(entry);
  container.appendChild(node);
  // Drawn where it starts from, then let in.
  void node.offsetHeight;
  node.classList.add("in");

  if (autoClose) lastFor(entry, lasts);
  // Past the most shown at once, the oldest goes: one that closes by itself before one that stands.
  while (shown.length > SHOWN_MAX) dismiss(shown.find((held) => !held.standing) ?? shown[0]!);
}
