// What every tool window is built from: elements, icons, the way numbers,
// names and times are written for reading, and the small parts that
// css/tools.css styles (buttons, tags, toasts, dialogs, tooltips). It was taken
// out of the control panel so that the editors are made of the same pieces.
//
// ------------------------------ how to use ------------------------------
//
// Elements
//   el(tag, className?, text?)                 an HTML element
//   svg(tag, attrs?)                           an SVG element
//   icon(name, size = 16)                      one of ICONS as inline SVG, in the colour of the text around it
//
// Words and numbers
//   shown(username)                            "aldric" -> "Aldric" (display only; send the name as stored)
//   words(value)                               "ring_1" -> "Ring 1", "damage_over_time" -> "Damage over time"
//   num(1204) -> "1,204"      short(2.34) -> "2.3"      count(4, "item") -> "4 items"
//   duration(seconds)  memory(megabytes)  clock(ms)  dayAndTime(ms)  ago(ms)  listed(["a","b","c"]) -> "a, b and c"
//
// Buttons and small parts
//   button(label, onClick, { icon, kind, small, block, fold, add, tip })
//        kind: "primary" | "danger" | "danger-solid" | "quiet" | "quiet-danger"
//        fold: under 1200px wide only the icon shows (give it an icon; the label becomes its tooltip)
//   iconButton(iconName, label, onClick, { danger, size })    icon only; the label is its name and its tooltip
//   setIcon(button, iconName, size = 16)       another icon in a button, in place of the one it has
//   setBusy(button, on)                        a spinner in place of the label while an answer is on its way
//   forbid(control, why)                       grey a control out, with the reason as its tooltip
//   tag(text, kind?, iconName?)                kind: "good" | "warning" | "danger" | "info" | "muted" | "you"
//   pill(text, level?, mark?)                  level: "good" | "warning" | "danger" | "info" | "wait"; mark: "dot" or an icon name
//   avatar(username, large?)                   the first letter in a circle
//   thumb(image, { size, fallback, quality, missing })   a square holding an icon; see below
//   card(parent, title, lead?)                 -> { root, tools, body }: a titled section
//   titleCount(card.root, 12)                  how many of them there are, beside a card's title
//   subcard({ title, lead?, thumb?, open?, onToggle?, wrong? })   -> { root, fold, title, lead, tools, body }: one
//                                              record of several inside a card. With onToggle its head is a button
//                                              that folds the body away (fill the body only while `open`); `wrong`
//                                              outlines it in red.
//   note(text | lines, tone?, iconName?)       tone: "" (information) | "warning" | "danger" | "plain"
//   empty(parent, iconName, title, text?)      "nothing here", inside a card or a list
//   screen(parent, iconName, title, text)      a whole page that has only a reason to show
//   segments(options, value, onPick, label)    a few choices side by side: one stop for the Tab key, the arrow keys
//                                              move through them and pick; each button carries data-value
//   arrowKeys(group) / oneStop(group)          the same keys and the same one stop for a set of [role=radio] built
//                                              by hand; call oneStop again after the pick was changed from outside
//   switchControl(on, label, onToggle)         an on/off switch
//   searchBox(placeholder, onInput)            -> { root, input }: a search field with its icon
//   tooltip(node, text)                        words shown beside a control under the pointer or the focus
//
// Feedback
//   toast(text, kind = "info")                 a note in the corner that leaves by itself: "info", "warning" (something
//                                              to put right first, or to know) or "error" (it failed or was refused;
//                                              stays longer). A second line is shown smaller under the first.
//   await confirmDialog({ title, body, okLabel, cancelLabel?, danger? })   -> true when agreed.
//                                              Use it before anything that cannot be taken back.
//   await noticeDialog(title, body)            why what was asked for was not done, when that is more than a toast can hold
//   await leaveDialog(name)                    -> "save" | "discard" | "stay": asked on the way out of something with
//                                              unsaved changes, where saving first is one of the ways out
//   await askText({ title, body?, label, okLabel, value?, maxLength?, tidy?, check?, className? })
//                                              -> what was typed, or null: a question answered with one line of text.
//                                              check(text) says what is wrong with it, or null when it will do.
//   openDialog(title, { onClose? })            -> { dialog, tools, body, foot, close }: a wide dialog to fill in
//   In every question the last button is the yes and the first the no; Escape and a click outside are the no.
//
// A thumbnail: thumb(url, { size: "lg", fallback: "box", quality: "rare", missing: url2, lazy: true })
//   shows the image; if it fails to load it tries `missing` once, then shows
//   the fallback icon. With `quality` it gets the game's rarity frame. `lazy`
//   is for a long grid of them: each loads when it scrolls into view.
//
// Nothing here talks to the server or knows about any one tool.
import { applyItemFrame } from "./itemframe.js";
// On a touch screen, a way back to the game in every window built from this.
import "./toolback.js";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/** The icons: drawn on a 24 by 24 grid as strokes, in the colour of the text around them. */
const ICONS = {
  dashboard: "M4 4h6.5v8H4z M13.5 4H20v4.5h-6.5z M13.5 12H20v8h-6.5z M4 15.5h6.5V20H4z",
  players: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19 M10 10.5A3.25 3.25 0 1 0 10 4a3.25 3.25 0 0 0 0 6.5z M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4 M15.5 4.2a3.25 3.25 0 0 1 0 6.1",
  megaphone: "M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1z M15 9a4.2 4.2 0 0 1 0 6 M18 6.5a8 8 0 0 1 0 11",
  server: "M4 5h16v6H4z M4 13h16v6H4z M7.5 8h.01 M7.5 16h.01",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a13.5 13.5 0 0 1 0 18 M12 3a13.5 13.5 0 0 0 0 18",
  box: "M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16z M3.5 8 12 12.5 20.5 8 M12 12.5v8",
  refresh: "M21 5v5h-5 M3 19v-5h5 M5.2 9.5a7.5 7.5 0 0 1 12.4-2.8L21 10 M3 14l3.4 3.3a7.5 7.5 0 0 0 12.4-2.8",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  close: "M6 6l12 12 M18 6 6 18",
  alert: "M12 4 2.8 19.5h18.4z M12 10v4.5 M12 17h.01",
  check: "M5 12.5l4.5 4.5L19 7.5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01",
  lock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  shield: "M12 3l7.5 3v5.5c0 4.5-3.1 8-7.5 9.5-4.4-1.5-7.5-5-7.5-9.5V6z",
  eyeOff: "M3 3l18 18 M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a13 13 0 0 1-2.6 3.4 M6.6 6.7A13 13 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.3 9.3 0 0 0 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  arrowDown: "M12 5v14 M6 13l6 6 6-6",
  user: "M18 20v-1.5a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4V20 M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  chip: "M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4",
  gauge: "M4.5 17.5a8.5 8.5 0 1 1 15 0 M12 13.5l4-5.5",
  paw: "M12 20c-2.6 0-4.5-1.3-4.5-3.2 0-2.2 2.2-4.3 4.5-4.3s4.5 2.1 4.5 4.3c0 1.9-1.9 3.2-4.5 3.2z M6.2 11.5a1.6 1.9 0 1 0 0-3.8 1.6 1.9 0 0 0 0 3.8z M17.8 11.5a1.6 1.9 0 1 0 0-3.8 1.6 1.9 0 0 0 0 3.8z M9.6 8a1.6 2 0 1 0 0-4 1.6 2 0 0 0 0 4z M14.4 8a1.6 2 0 1 0 0-4 1.6 2 0 0 0 0 4z",
  power: "M12 3v9 M7 6.3a8 8 0 1 0 10 0",
  restart: "M20 12a8 8 0 1 1-2.6-5.9 M20 4v5h-5",
  trash: "M4 7h16 M9 7V4h6v3 M6.5 7l1 13h9l1-13 M10 11v5 M14 11v5",
  plus: "M12 5v14 M5 12h14",
  send: "M21 3 10.5 13.5 M21 3l-6.5 18-4-7.5L3 9.5z",
  cloud: "M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a3.75 3.75 0 0 1-.5 7.5z",
  pin: "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  plug: "M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4",
  flame: "M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.2 1.6 1 2.5 2 2.7-.6-3 0-6 1-8.5z",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  key: "M14.5 9.5a4 4 0 1 0-3.6 4L8 16.5V19H5.5v-2.5l5.4-5.4 M15.5 8.5h.01",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  move: "M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M5.7 5.7l12.6 12.6",
  // Added for the editors.
  save: "M5 4h11l4 4v12H4V4z M8 4v5h7V4 M8 20v-6h8v6",
  copy: "M9 9h11v11H9z M6 15H4V4h11v2",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h10",
  image: "M4 5h16v14H4z M4 16l4.5-4.5 4 4 3-3L20 17 M9 10.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z",
  wand: "M5 19 15.5 8.5 M14 7l3 3 M18 3v3 M16.5 4.5h3 M20 10v2 M19 11h2 M10 3v2 M9 4h2",
  pencil: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  eye: "M2.5 12c1-2 4.5-6 9.5-6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  layers: "M12 3.5 3.5 8 12 12.5 20.5 8z M3.5 12 12 16.5 20.5 12 M3.5 16 12 20.5 20.5 16",
  bolt: "M13 3 5 13.5h6L10 21l8.5-11h-6z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 12h.01",
  map: "M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2z M9 4.5v13 M15 6.5v13",
  brush: "M19.5 4.5 10 14 M12.5 16.5l-5-5 M7.5 11.5l-1.2 1.2a3 3 0 0 0-.8 1.5l-1 5.3 5.3-1a3 3 0 0 0 1.5-.8l1.2-1.2",
  scroll: "M7 4h11v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-1h10v1a2 2 0 0 0 2 2 M7 4a2 2 0 0 0-2 2v10 M10 8.5h5 M10 12h5",
  coins: "M9 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M14.8 10.6a5 5 0 1 1-4.3 8",
  undo: "M4 9h10a5.5 5.5 0 0 1 0 11h-4 M8 5 4 9l4 4",
  grip: "M9 6h.01 M9 12h.01 M9 18h.01 M15 6h.01 M15 12h.01 M15 18h.01",
  more: "M6 12h.01 M12 12h.01 M18 12h.01",
  sparkle: "M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z M19 16.5v3 M17.5 18h3",
  sword: "M19.5 4.5h-4L7 13l4 4 8.5-8.5z M5.5 13.5l5 5 M4 20l3.5-3.5",
  bag: "M6 8.5h12l1 11.5H5z M9 8.5V7a3 3 0 0 1 6 0v1.5",
  folder: "M3.5 6.5h6l2 2.5h9v10.5h-17z",
  filter: "M4 5h16l-6 7.5V19l-4-2v-4.5z",
  // Added for the tools with a canvas or a map: playing and stepping, drawing tools, what stands in the world.
  play: "M7.5 5v14l11-7z",
  pause: "M8.5 5.5v13 M15.5 5.5v13",
  stop: "M6.5 6.5h11v11h-11z",
  back: "M19 12H5 M11 6l-6 6 6 6",
  redo: "M20 9H10a5.5 5.5 0 0 0 0 11h4 M16 5l4 4-4 4",
  history: "M4 12a8 8 0 1 0 2.6-5.9 M4 4v5h5 M12 8v4.5l3 1.5",
  eraser: "M20 20H9.5l-4.9-4.9a1.5 1.5 0 0 1 0-2.1L13 4.6a1.5 1.5 0 0 1 2.1 0l4.3 4.3a1.5 1.5 0 0 1 0 2.1L10.5 20 M8.6 9l6.4 6.4",
  paste: "M8.5 5H6v15h12V5h-2.5 M8.5 3.5h7v3h-7z M9 11.5h6 M9 15.5h4",
  grid: "M4 4h16v16H4z M4 9.33h16 M4 14.67h16 M9.33 4v16 M14.67 4v16",
  unlock: "M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  route: "M6 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8.5 17h6a2.5 2.5 0 0 0 0-5h-5a2.5 2.5 0 0 1 0-5h6",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  headstone: "M7 20v-9a5 5 0 0 1 10 0v9 M4.5 20h15 M12 9.5v5 M10 11.5h4",
  portal: "M12 21a9 9 0 1 1 9-9 M12 17a5 5 0 1 1 5-5 M12 12h.01",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
} as const;

export type IconName = keyof typeof ICONS;

/** One icon, sized in pixels. It is decoration: the words beside it say what it means. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const node = svg("svg", {
    viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  });
  node.classList.add("tl-icon");
  node.appendChild(svg("path", { d: ICONS[name] }));
  return node;
}

// ------------------------------------------------------- words and numbers

/**
 * A username as it is shown, first letter a capital, as the game shows names (the server stores them lower case).
 * For display only: what is sent to the server is the username as stored.
 */
export const shown = (username: unknown): string => {
  const name = String(username ?? "");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * A stored value written for reading: "ring_1" -> "Ring 1", "damage_over_time" -> "Damage over time".
 * For the fixed words of the game (a type, a slot, a quality), not for the names people give things.
 */
export function words(value: unknown): string {
  const text = String(value ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const WHOLE = new Intl.NumberFormat();

/** 1204 -> "1,204". */
export const num = (value: number): string => WHOLE.format(Math.round(value));

/** 2.34 -> "2.3", 12 -> "12": one decimal while the number is small enough for it to matter. */
export function short(value: number): string {
  return Math.abs(value) < 10 && !Number.isInteger(value) ? value.toFixed(1) : num(value);
}

/** "1 player", "4 players". */
export function count(value: number, one: string, many = `${one}s`): string {
  return `${num(value)} ${value === 1 ? one : many}`;
}

/** 93784 -> "1 d 2 h", 11520 -> "3 h 12 min", 75 -> "1 min 15 s". The two largest units that are not zero. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const parts: Array<[number, string]> = [[Math.floor(s / 86400), "d"], [Math.floor((s % 86400) / 3600), "h"], [Math.floor((s % 3600) / 60), "min"], [s % 60, "s"]];
  const from = parts.findIndex(([value]) => value > 0);
  if (from < 0) return "0 s";
  return parts.slice(from, from + 2).filter(([value], i) => i === 0 || value > 0).map(([value, unit]) => `${value} ${unit}`).join(" ");
}

/** 512 -> "512 MB", 1536 -> "1.5 GB". */
export function memory(megabytes: number): string {
  if (megabytes < 1024) return `${num(megabytes)} MB`;
  const gigabytes = megabytes / 1024;
  return `${gigabytes >= 100 ? num(gigabytes) : gigabytes.toFixed(gigabytes >= 10 ? 1 : 2).replace(/\.?0+$/, "")} GB`;
}

/** The time of day, as the admin's own machine writes it. */
export function clock(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString([], seconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

/** "Today, 14:02", "Yesterday, 21:14", "4 Oct, 10:50". */
export function dayAndTime(ms: number, now = Date.now()): string {
  const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(now) - midnight(ms)) / 86400000);
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day}, ${clock(ms)}`;
}

/** "just now", "4 min ago", "3 h ago", then the day and time. */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return dayAndTime(ms, now);
}

/** "a", "a and b", "a, b and c". */
export function listed(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------- feedback

/** Where toasts are stacked: the page's own #tl-toasts, or one made on the spot. */
function toastHost(): HTMLElement {
  let host = document.getElementById("tl-toasts");
  if (!host) {
    host = el("div", "tl-toasts");
    host.id = "tl-toasts";
    document.body.appendChild(host);
  }
  return host;
}

/**
 * A short note in the corner that leaves by itself. "warning" is for what
 * needs putting right before it can be done, or was done with something to
 * know about it; "error" is for what failed or was refused, and stays longer.
 */
export function toast(text: string, kind: "info" | "warning" | "error" = "info"): void {
  const host = toastHost();
  const box = el("div", `tl-toast tl-toast-${kind}`);
  box.setAttribute("role", kind === "error" ? "alert" : "status");
  // What the server answers is passed on as it is: it may be a refusal in its own words, so it is not dressed as a success.
  box.appendChild(icon(kind === "info" ? "info" : "alert", 16));
  const [first, ...rest] = text.split("\n");
  const said = el("div", "tl-toast-words");
  said.appendChild(el("div", "tl-toast-text", first));
  if (rest.length) said.appendChild(el("div", "tl-toast-more", rest.join("\n")));
  box.appendChild(said);
  const close = el("button", "tl-icon-btn tl-toast-close");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.appendChild(icon("close", 14));
  box.appendChild(close);

  let timer: ReturnType<typeof setTimeout>;
  const leave = () => {
    box.classList.add("is-leaving");
    setTimeout(() => box.remove(), 180);
  };
  const wait = () => (timer = setTimeout(leave, kind === "error" ? 9000 : kind === "warning" ? 7000 : 5000));
  close.addEventListener("click", leave);
  box.addEventListener("pointerenter", () => clearTimeout(timer));
  box.addEventListener("pointerleave", wait);
  host.appendChild(box);
  while (host.childElementCount > 4) host.firstElementChild?.remove();
  wait();
}

export interface ConfirmOptions {
  /** The question, naming what it is about: "Delete Iron Sword?" */
  title: string;
  /** What happens on yes, in a sentence or two. Several strings are several paragraphs. */
  body: string | string[];
  /** What the yes button says: the action, not "OK". */
  okLabel: string;
  cancelLabel?: string;
  /** False for a question whose yes loses nothing. Dangerous by default: the yes button is red. */
  danger?: boolean;
  /** Nothing is being asked: there is only something to read, and one button to close it. */
  notice?: boolean;
}

/**
 * Asks before something that cannot be taken back. Resolves true when the
 * admin has read what it will do and agreed; Escape, Cancel and a click
 * outside the box are all a no.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const danger = options.danger !== false;
    const dialog = el("dialog", "tl-dialog");
    const badge = el("div", "tl-dialog-badge" + (danger ? "" : " tl-dialog-badge-plain"));
    badge.appendChild(icon(danger ? "alert" : "info", 20));
    const heading = el("h2", "tl-dialog-title", options.title);
    heading.id = "tl-dialog-title";
    const lines = Array.isArray(options.body) ? options.body : [options.body];
    const body = lines.length === 1 ? el("p", "tl-dialog-body", lines[0]) : el("div", "tl-dialog-body");
    if (lines.length > 1) for (const line of lines) body.appendChild(el("p", "", line));
    body.id = "tl-dialog-body";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", body.id);
    const said = el("div", "tl-dialog-words");
    said.append(heading, body);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (agreed: boolean) => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(agreed);
    };
    const actions = el("div", "tl-dialog-actions");
    const cancel = el("button", "tl-btn", options.cancelLabel ?? "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(false));
    const ok = el("button", options.notice ? "tl-btn" : `tl-btn ${danger ? "tl-btn-danger-solid" : "tl-btn-primary"}`, options.okLabel);
    ok.type = "button";
    ok.addEventListener("click", () => answer(true));
    if (options.notice) actions.append(ok);
    else actions.append(cancel, ok);
    dialog.append(top, actions);
    // A click on the dimmed page around the box is a no, and so is Escape.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer(false);
    });
    dialog.addEventListener("close", () => answer(false));
    document.body.appendChild(dialog);
    dialog.showModal();
    (options.notice ? ok : cancel).focus();
  });
}

/**
 * Something the admin has to read before going on, which a toast would take
 * away too soon: why what they asked for was not done. One button closes it.
 */
export function noticeDialog(title: string, body: string | string[]): Promise<boolean> {
  return confirmDialog({ title, body, okLabel: "Close", notice: true });
}

/**
 * Asked on the way out of something with changes that are not saved, where
 * saving them first is one of the ways out: save and leave, throw the changes
 * away, or stay. Escape and a click outside the box are "stay". Each button
 * carries its answer as data-choice.
 */
export function leaveDialog(name: string): Promise<"save" | "discard" | "stay"> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "tl-dialog tl-dialog-three");
    const badge = el("div", "tl-dialog-badge tl-dialog-badge-plain");
    badge.appendChild(icon("save", 20));
    const heading = el("h2", "tl-dialog-title", "Save your changes before leaving?");
    heading.id = "tl-leave-title";
    const body = el("p", "tl-dialog-body", `What you changed in ${name} has not been saved. Leaving it without saving loses those changes.`);
    body.id = "tl-leave-body";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", body.id);
    const said = el("div", "tl-dialog-words");
    said.append(heading, body);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (choice: "save" | "discard" | "stay") => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(choice);
    };
    const choice = (label: string, value: "save" | "discard" | "stay", kind: string) => {
      const btn = el("button", `tl-btn${kind}`, label);
      btn.type = "button";
      btn.dataset.choice = value;
      btn.addEventListener("click", () => answer(value));
      return btn;
    };
    const actions = el("div", "tl-dialog-actions");
    const save = choice("Save and leave", "save", " tl-btn-primary");
    actions.append(choice("Keep editing", "stay", ""), choice("Discard changes", "discard", " tl-btn-danger"), save);
    dialog.append(top, actions);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer("stay");
    });
    dialog.addEventListener("close", () => answer("stay"));
    document.body.appendChild(dialog);
    dialog.showModal();
    save.focus();
  });
}

export interface AskOptions {
  /** What is being asked for: "New loot table". */
  title: string;
  /** A sentence on what to type and what happens with it. */
  body?: string;
  /** What the field holds: "Name". */
  label: string;
  /** What the yes button says: the action, not "OK". */
  okLabel: string;
  /** What the field starts with, selected so that typing replaces it. */
  value?: string;
  icon?: IconName;
  /** The most that can be typed. No limit unless given. */
  maxLength?: number;
  /** Cleans up what was typed before it counts as an answer. An answer that comes out empty is not accepted. */
  tidy?(typed: string): string;
  /**
   * What is wrong with an answer, in a sentence, or null when it will do. It is
   * given the answer as it would be returned, also when nothing was typed ("");
   * an empty answer is never accepted, whatever it says of one.
   */
  check?(answer: string): string | null;
  /** A class of the tool's own on the box, to tell it from a yes-or-no question. */
  className?: string;
}

/**
 * Asks for one line of text: the name of something new, a username. Resolves
 * with it, trimmed, once something that passes `check` has been typed and
 * agreed to (Enter is the yes button); what is wrong with an answer is said
 * under the field. Escape, Cancel and a click outside the box are all a no,
 * and resolve null.
 */
export function askText(options: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "tl-dialog" + (options.className ? ` ${options.className}` : ""));
    const badge = el("div", "tl-dialog-badge tl-dialog-badge-plain");
    badge.appendChild(icon(options.icon ?? "pencil", 20));
    const heading = el("h2", "tl-dialog-title", options.title);
    heading.id = "tl-ask-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const said = el("div", "tl-dialog-words");
    said.appendChild(heading);
    const top = el("div", "tl-dialog-top");
    top.append(badge, said);

    const input = el("input", "tl-input");
    input.type = "text";
    input.id = "tl-ask-input";
    if (options.maxLength) input.maxLength = options.maxLength;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = options.value ?? "";
    if (options.body) {
      const body = el("p", "tl-dialog-body", options.body);
      body.id = "tl-ask-body";
      said.appendChild(body);
      input.setAttribute("aria-describedby", body.id);
    }
    const label = el("label", "tl-field-label", options.label);
    label.htmlFor = input.id;
    const field = el("div", "tl-field tl-dialog-field");
    field.append(label, input);
    // The problem with an answer, said under the field. toolfields.ts has the same for a field of a form.
    const complain = (message: string | null) => {
      field.querySelector(".tl-field-error")?.remove();
      field.classList.toggle("has-error", !!message);
      if (!message) return void input.removeAttribute("aria-invalid");
      input.setAttribute("aria-invalid", "true");
      const line = el("span", "tl-field-error");
      line.setAttribute("role", "alert");
      line.append(icon("alert", 13), el("span", "", message));
      field.appendChild(line);
    };

    // Answered once, as soon as a button is pressed: the browser only says "closed" when it next draws.
    let answered = false;
    const answer = (value: string | null) => {
      if (answered) return;
      answered = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const submit = () => {
      const typed = input.value.trim();
      const value = options.tidy ? options.tidy(typed) : typed;
      // With nothing typed there is nothing to send: the field asks again, in the words of `check` when it has any.
      const wrong = options.check ? options.check(value) ?? (value ? null : "") : value ? null : "";
      if (wrong !== null) {
        if (wrong) complain(wrong);
        return input.focus();
      }
      answer(value);
    };
    const actions = el("div", "tl-dialog-actions");
    const cancel = el("button", "tl-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => answer(null));
    const ok = el("button", "tl-btn tl-btn-primary", options.okLabel);
    ok.type = "button";
    ok.addEventListener("click", submit);
    actions.append(cancel, ok);
    input.addEventListener("input", () => complain(null));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      submit();
    });
    dialog.append(top, field, actions);
    // A click on the dimmed page around the box is a no, and so is Escape.
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      answer(null);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) answer(null);
    });
    dialog.addEventListener("close", () => answer(null));
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

export interface DialogParts {
  dialog: HTMLDialogElement;
  /** Under the title: a search field, a filter. Hidden while empty. */
  tools: HTMLElement;
  /** The part that scrolls. */
  body: HTMLElement;
  /** Buttons along the bottom. Hidden while empty. */
  foot: HTMLElement;
  close(): void;
}

/**
 * A wide dialog with a title and a close button, to fill in: a picker, a
 * longer form. Escape, the close button and a click outside all close it.
 */
export function openDialog(title: string, opts: { onClose?: () => void } = {}): DialogParts {
  const dialog = el("dialog", "tl-dialog tl-dialog-wide");
  const heading = el("h2", "tl-dialog-title", title);
  heading.id = "tl-dialog-wide-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const head = el("div", "tl-dialog-head");
  const shut = el("button", "tl-icon-btn");
  shut.type = "button";
  shut.setAttribute("aria-label", "Close");
  shut.appendChild(icon("close", 16));
  head.append(heading, shut);
  const tools = el("div", "tl-dialog-tools");
  const body = el("div", "tl-dialog-scroll");
  const foot = el("div", "tl-dialog-foot");
  dialog.append(head, tools, body, foot);

  // Done once, at once: the browser only says "closed" when it next draws.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    opts.onClose?.();
  };
  shut.addEventListener("click", close);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("close", close);
  document.body.appendChild(dialog);
  dialog.showModal();
  // Parts nobody filled take no room.
  queueMicrotask(() => {
    tools.hidden = tools.childElementCount === 0;
    foot.hidden = foot.childElementCount === 0;
  });
  return { dialog, tools, body, foot, close };
}

let tipBox: HTMLElement | null = null;
let tipTimer: ReturnType<typeof setTimeout> | null = null;
let tipWatch: ReturnType<typeof setInterval> | null = null;
const tipped = new WeakSet<HTMLElement>();

function hideTip(): void {
  if (tipTimer) clearTimeout(tipTimer);
  if (tipWatch) clearInterval(tipWatch);
  tipTimer = tipWatch = null;
  tipBox?.remove();
  tipBox = null;
}

function showTip(node: HTMLElement): void {
  hideTip();
  const text = node.dataset.tip;
  if (!text || !node.isConnected) return;
  const box = el("div", "tl-tooltip", text);
  box.setAttribute("role", "tooltip");
  // Inside an open dialog, or it would be drawn behind it.
  (node.closest("dialog") ?? document.body).appendChild(box);
  const at = node.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.min(window.innerWidth - size.width - 8, Math.max(8, at.left + at.width / 2 - size.width / 2));
  const below = at.bottom + 6;
  const top = below + size.height > window.innerHeight - 8 ? at.top - size.height - 6 : below;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  tipBox = box;
  // The control may be redrawn away from under it.
  tipWatch = setInterval(() => {
    if (!node.isConnected) hideTip();
  }, 400);
}

/**
 * Words shown beside a control while the pointer rests on it or the keyboard
 * focus is on it. An icon-only control also takes them as its name. Calling it
 * again changes the words.
 */
export function tooltip<T extends HTMLElement>(node: T, text: string): T {
  node.dataset.tip = text;
  if (tipped.has(node)) return node;
  tipped.add(node);
  node.addEventListener("pointerenter", () => {
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(node), 350);
  });
  node.addEventListener("pointerleave", hideTip);
  node.addEventListener("pointerdown", hideTip);
  node.addEventListener("focus", () => {
    if (node.matches(":focus-visible")) showTip(node);
  });
  node.addEventListener("blur", hideTip);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
  return node;
}

// ------------------------------------------------------------------- parts

export interface ButtonOptions {
  icon?: IconName;
  kind?: "primary" | "danger" | "danger-solid" | "quiet" | "quiet-danger";
  small?: boolean;
  /** As wide as what it sits in. */
  block?: boolean;
  /** Under 1200px wide only the icon shows; the label becomes the tooltip. */
  fold?: boolean;
  /** "Add another": a dashed outline the width of the list it adds to. */
  add?: boolean;
  /** Words for a tooltip. */
  tip?: string;
}

/** A button: an icon if it has one, then its label. */
export function button(label: string, onClick: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const btn = el("button", "tl-btn" + (opts.kind ? ` tl-btn-${opts.kind}` : "") + (opts.small ? " tl-btn-sm" : "") + (opts.block ? " tl-btn-block" : "") + (opts.fold ? " tl-btn-fold" : "") + (opts.add ? " tl-btn-add" : ""));
  btn.type = "button";
  if (opts.icon) btn.appendChild(icon(opts.icon, opts.small ? 13 : 15));
  btn.appendChild(el("span", "", label));
  btn.addEventListener("click", onClick);
  if (opts.tip || opts.fold) tooltip(btn, opts.tip ?? label);
  return btn;
}

/** A button that is only an icon. The label is what a screen reader says and what the tooltip shows. */
export function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, opts: { danger?: boolean; size?: number } = {}): HTMLButtonElement {
  const btn = el("button", "tl-icon-btn" + (opts.danger ? " tl-icon-btn-danger" : ""));
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.appendChild(icon(name, opts.size ?? 16));
  btn.addEventListener("click", onClick);
  return tooltip(btn, label);
}

/** Puts another icon in a button made here, in place of the one it has: play for pause, an open lock for a closed one. */
export function setIcon<T extends HTMLElement>(btn: T, name: IconName, size = 16): T {
  btn.querySelector("svg")?.replaceWith(icon(name, size));
  return btn;
}

/** Shows a button as waiting for the server's answer, or as done waiting. */
export function setBusy(btn: HTMLElement | null, on: boolean): void {
  if (!btn) return;
  btn.classList.toggle("is-busy", on);
  if (on) btn.setAttribute("aria-busy", "true");
  else btn.removeAttribute("aria-busy");
}

/** Grey a control out, with why. The first reason given stands. */
export function forbid<T extends HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(control: T, why: string): T {
  if (!control.disabled) {
    control.disabled = true;
    control.title = why;
    control.dataset.why = why;
  }
  return control;
}

export function tag(text: string, kind = "", name?: IconName): HTMLElement {
  const node = el("span", "tl-tag" + (kind ? ` tl-tag-${kind}` : ""));
  if (name) node.appendChild(icon(name, 12));
  node.appendChild(el("span", "", text));
  return node;
}

/** A state in a word: a dot (or an icon) and the word, in the colour of how things stand. */
export function pill(text: string, level = "", mark: IconName | "dot" = "dot"): HTMLElement {
  const node = el("span", "tl-pill" + (level ? ` tl-pill-${level}` : ""));
  node.append(mark === "dot" ? el("span", "tl-pill-dot") : icon(mark, 13), el("span", "", text));
  return node;
}

export function avatar(username: string, large = false): HTMLElement {
  const node = el("span", "tl-avatar" + (large ? " tl-avatar-lg" : ""), username.charAt(0).toUpperCase() || "?");
  node.setAttribute("aria-hidden", "true");
  return node;
}

export interface ThumbOptions {
  size?: "" | "lg" | "xl";
  /** The icon shown when there is no image, or none could be loaded. */
  fallback?: IconName;
  /** An item's quality: the square gets the game's rarity frame. */
  quality?: unknown;
  /** An image to try once if the first fails to load. */
  missing?: string | null;
  /** Load the image only when it scrolls into view: for a long grid, not for a list that is drawn again often. */
  lazy?: boolean;
}

/**
 * Images that would not load, and when. A list is drawn again at every answer
 * of the server: an image that is not there is not asked for each time, only
 * again after a minute in case it was the asset server that was away.
 */
const failedImages = new Map<string, number>();
const RETRY_IMAGE_MS = 60000;
const worthTrying = (src: string | null | undefined): src is string => !!src && Date.now() - (failedImages.get(src) ?? -RETRY_IMAGE_MS) >= RETRY_IMAGE_MS;

/** A square holding an icon. Without an image, or with one that will not load, it shows the fallback icon. */
export function thumb(image: string | null | undefined, opts: ThumbOptions = {}): HTMLElement {
  const box = el("span", "tl-thumb" + (opts.size ? ` tl-thumb-${opts.size}` : ""));
  box.setAttribute("aria-hidden", "true");
  if (opts.quality !== undefined) applyItemFrame(box, opts.quality);
  const size = opts.size === "xl" ? 22 : opts.size === "lg" ? 18 : 14;
  const blank = () => {
    if (opts.fallback) box.replaceChildren(icon(opts.fallback, size));
    else box.replaceChildren();
  };
  // The image itself, then the stand-in for a missing one. With no image at all there is nothing to stand in for.
  const sources = image ? [image, opts.missing].filter(worthTrying) : [];
  if (!sources.length) {
    blank();
    return box;
  }
  const img = el("img");
  img.alt = "";
  if (opts.lazy) img.loading = "lazy";
  let at = 0;
  img.addEventListener("error", () => {
    failedImages.set(sources[at], Date.now());
    at++;
    if (at < sources.length) img.src = sources[at];
    else blank();
  });
  img.src = sources[0];
  box.appendChild(img);
  return box;
}

/** A titled part of a page: what it is, a line on what it is for, and room for its controls. */
export function card(parent: HTMLElement, title: string, lead = ""): { root: HTMLElement; tools: HTMLElement; body: HTMLElement } {
  const root = el("section", "tl-card");
  const head = el("header", "tl-card-head");
  const said = el("div", "tl-card-words");
  said.appendChild(el("h2", "tl-card-title", title));
  if (lead) said.appendChild(el("p", "tl-card-lead", lead));
  const tools = el("div", "tl-card-tools");
  head.append(said, tools);
  const body = el("div", "tl-card-body");
  root.append(head, body);
  parent.appendChild(root);
  return { root, tools, body };
}

/** How many of them there are, beside a card's title. */
export function titleCount(cardRoot: HTMLElement, total: number): void {
  cardRoot.querySelector(".tl-card-title")?.appendChild(el("span", "tl-count", num(total)));
}

export interface SubcardOptions {
  title: string;
  /** A line under the title: what it is, or what it does. */
  lead?: string;
  thumb?: HTMLElement;
  /** Makes the head a button that opens the body and folds it away. */
  onToggle?(): void;
  /** With onToggle: whether the body shows now. */
  open?: boolean;
  /** Something in it is wrong: it is outlined in red, open or folded. */
  wrong?: boolean;
}

/**
 * One record of several inside a card: an ability of a creature, a loot table
 * in a list of them. Its head holds what it is and, in `tools`, what can be
 * done to it. With `onToggle` the head is a button (`fold`) and the record
 * folds down to that one line; `body` is only on the page while it is open.
 */
export function subcard(opts: SubcardOptions): { root: HTMLElement; fold: HTMLButtonElement | null; title: HTMLElement; lead: HTMLElement; tools: HTMLElement; body: HTMLElement } {
  const open = opts.onToggle ? !!opts.open : true;
  const root = el("div", "tl-subcard" + (opts.onToggle && open ? " is-open" : "") + (opts.wrong ? " has-error" : ""));
  const title = el("span", "tl-subcard-title", opts.title);
  const lead = el("span", "tl-subcard-lead", opts.lead ?? "");
  const said = el("span", "tl-subcard-words");
  said.append(title, lead);
  const tools = el("span", "tl-subcard-tools");
  const head = el("div", "tl-subcard-head");
  let fold: HTMLButtonElement | null = null;
  if (opts.onToggle) {
    fold = el("button", "tl-subcard-fold");
    fold.type = "button";
    fold.setAttribute("aria-expanded", String(open));
    fold.appendChild(icon("chevronRight", 15));
    if (opts.thumb) fold.appendChild(opts.thumb);
    fold.appendChild(said);
    fold.addEventListener("click", opts.onToggle);
    head.appendChild(fold);
  } else {
    if (opts.thumb) head.appendChild(opts.thumb);
    head.appendChild(said);
  }
  head.appendChild(tools);
  const body = el("div", "tl-subcard-body");
  root.appendChild(head);
  if (open) root.appendChild(body);
  return { root, fold, title, lead, tools, body };
}

/** A boxed remark inside the page. Several lines are listed one under the other. */
export function note(text: string | string[], tone: "" | "warning" | "danger" | "plain" = "", name?: IconName): HTMLElement {
  const box = el("div", "tl-note" + (tone ? ` tl-note-${tone}` : ""));
  box.appendChild(icon(name ?? (tone === "danger" || tone === "warning" ? "alert" : "info"), 15));
  const said = el("div", "tl-note-words");
  for (const line of Array.isArray(text) ? text : [text]) said.appendChild(el("div", "", line));
  box.appendChild(said);
  return box;
}

export function empty(parent: HTMLElement, name: IconName, title: string, text = ""): HTMLElement {
  const box = el("div", "tl-empty");
  box.appendChild(icon(name, 22));
  box.appendChild(el("div", "tl-empty-title", title));
  if (text) box.appendChild(el("div", "tl-empty-text", text));
  parent.appendChild(box);
  return box;
}

/** A page that has nothing to show but a reason. */
export function screen(parent: HTMLElement, name: IconName, title: string, text: string): HTMLElement {
  const box = el("div", "tl-screen");
  const badge = el("div", "tl-screen-badge");
  badge.appendChild(icon(name, 26));
  box.append(badge, el("h2", "tl-screen-title", title), el("p", "tl-screen-text", text));
  parent.appendChild(box);
  return box;
}

/**
 * A few choices side by side, one of them picked. `label` names the set for a
 * screen reader; leave it out for a set that is named by a label beside it.
 * Each button carries its value as data-value. The set is one stop for the Tab
 * key, and the arrow keys move through it.
 */
export function segments<T extends string>(options: Array<[T, string]>, value: T | null, onPick: (value: T) => void, label = ""): HTMLElement {
  const group = el("div", "tl-seg");
  group.setAttribute("role", "radiogroup");
  if (label) group.setAttribute("aria-label", label);
  for (const [key, text] of options) {
    const btn = el("button", "tl-seg-item", text);
    btn.type = "button";
    btn.dataset.value = key;
    if (label) btn.dataset.fk = `seg:${label}:${key}`;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(key === value));
    btn.addEventListener("click", () => {
      for (const other of group.children) other.setAttribute("aria-checked", String(other === btn));
      onPick(key);
    });
    group.appendChild(btn);
  }
  arrowKeys(group);
  return group;
}

/**
 * Makes a set of choices one stop for the Tab key: the choice that is picked
 * (the first, when none is) takes the focus, and the arrow keys reach the
 * rest. Call it again after the pick was changed from outside.
 */
export function oneStop(group: HTMLElement): void {
  const choices = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  const usable = choices.filter((choice) => !(choice as HTMLButtonElement).disabled);
  const stop = usable.find((choice) => choice.getAttribute("aria-checked") === "true") ?? usable[0];
  for (const choice of choices) choice.tabIndex = choice === stop ? 0 : -1;
}

/**
 * The arrow keys (and Home and End) move through a set of choices and pick
 * the one they land on, as they do in a group of radio buttons, and the set
 * is one stop for the Tab key.
 */
export function arrowKeys(group: HTMLElement): void {
  oneStop(group);
  // A pick made with the pointer moves the stop too, once the click has marked it.
  group.addEventListener("click", () => queueMicrotask(() => oneStop(group)));
  group.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const choices = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((choice) => !choice.disabled);
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? choices[0] : e.key === "End" ? choices[choices.length - 1] : choices[(at + step + choices.length) % choices.length];
    if (!next) return;
    e.preventDefault();
    // Picking may redraw the page; the page puts the focus back on the choice picked.
    next.focus();
    next.click();
  });
}

/** An on/off switch. `label` is its name for a screen reader; put the visible words beside it. */
export function switchControl(on: boolean, label: string, onToggle: (on: boolean) => void): HTMLButtonElement {
  const toggle = el("button", "tl-switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(on));
  toggle.setAttribute("aria-label", label);
  toggle.appendChild(el("span", "tl-switch-knob"));
  toggle.addEventListener("click", () => {
    const next = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(next));
    onToggle(next);
  });
  return toggle;
}

/** A search field with its magnifying glass. */
export function searchBox(placeholder: string, onInput: (value: string) => void): { root: HTMLElement; input: HTMLInputElement } {
  const root = el("div", "tl-search");
  const input = el("input", "tl-input");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("input", () => onInput(input.value));
  root.append(icon("search", 15), input);
  return { root, input };
}
