// What the NPC editor suggests while a gossip line or a script is typed: the
// details of the player that a gossip line can hold (${player.name}), and the
// members of the NPC a script can use (dialogue(), position.x). The list
// appears under the text box at the caret's word; the arrow keys move through
// it, Enter or Tab takes one, Escape closes it. Styles: .ne-complete in
// css/npceditor.css.
//
//   const completer = new Completer();
//   completer.attach(textarea, GOSSIP_RULES, () => { /* the text was changed by a suggestion */ });
//   completer.hide();        // when the page is drawn again
import { el } from "./toolkit.js";

export interface Suggestion {
  /** What is written in place of what was typed. */
  insert: string;
  /** How it is listed. */
  label: string;
  /** What it is, at the end of its line. */
  hint: string;
  /** More can follow it: the list stays open for the next part. */
  keepOpen: boolean;
  /** How far before the end of what was written the caret goes: inside the brackets of a call. */
  caretBack?: number;
}

export interface CompleterRules {
  /** The text being completed, which ends at the caret; null when there is nothing to suggest for. `after` is what follows the caret. */
  token(before: string, after: string): string | null;
  candidates(token: string): Suggestion[];
  /** What replaces the token in the text box. */
  written(item: Suggestion): string;
  /** How a suggestion reads in the list. */
  listed(item: Suggestion): string;
}

const GOSSIP_TOP: Array<{ path: string; hint: string; branch?: boolean }> = [
  { path: "name", hint: "username" },
  { path: "username", hint: "login name" },
  { path: "userid", hint: "account id" },
  { path: "level", hint: "level" },
  { path: "guild_name", hint: "guild name" },
  { path: "mounted", hint: "mounted?" },
  { path: "isAdmin", hint: "admin?" },
  { path: "isGuest", hint: "guest?" },
  { path: "stats", hint: "stats…", branch: true },
  { path: "currency", hint: "currency…", branch: true },
];

const GOSSIP_STATS = [
  "level", "xp", "max_xp", "health", "max_health", "total_max_health",
  "stamina", "max_stamina", "total_max_stamina", "stat_damage", "stat_armor",
  "stat_health", "stat_stamina", "stat_critical_chance", "stat_critical_damage",
  "stat_avoidance",
];

const GOSSIP_CURRENCY = ["copper", "silver", "gold"];

/** Candidates for the inner text of an unclosed ${...}; [] means no list. */
function gossipCandidates(inner: string): Suggestion[] {
  const leaf = (base: string, path: string, hint: string): Suggestion => ({ insert: `${base}${path}`, label: `${base}${path}`, hint, keepOpen: false });
  if (!inner || (!inner.includes(".") && "player".startsWith(inner))) {
    return [{ insert: "player.", label: "player", hint: "current player…", keepOpen: true }];
  }
  if (inner === "player" || inner.startsWith("player.")) {
    const rest = inner.startsWith("player.") ? inner.slice("player.".length) : "";
    if (rest.includes(".")) {
      const [head, ...tailParts] = rest.split(".");
      const tail = tailParts.join(".");
      const pool = head === "stats" ? GOSSIP_STATS : head === "currency" ? GOSSIP_CURRENCY : null;
      if (!pool || tail.includes(".")) return [];
      return pool
        .filter((f) => f.toLowerCase().startsWith(tail.toLowerCase()))
        .map((f) => leaf("player." + head + ".", f, head === "stats" ? "stat" : "coins"));
    }
    const out: Suggestion[] = [];
    for (const f of GOSSIP_TOP) {
      if (!f.path.toLowerCase().startsWith(rest.toLowerCase())) continue;
      if (f.branch) out.push({ insert: `player.${f.path}.`, label: `player.${f.path}.`, hint: f.hint, keepOpen: true });
      else out.push(leaf("player.", f.path, f.hint));
    }
    return out;
  }
  return [];
}

/** A gossip line: the list only ever appears inside an unclosed ${...} expression. */
export const GOSSIP_RULES: CompleterRules = {
  token: (before) => /(\$\{[A-Za-z0-9_.]*)$/.exec(before)?.[1] ?? null,
  candidates: (token) => gossipCandidates(token.slice(2)),
  // A branch (player, stats…) leaves the expression open for the next part; a leaf closes it.
  written: (item) => "${" + item.insert + (item.keepOpen ? "" : "}"),
  listed: (item) => "${" + item.label + "}",
};

const SCRIPT_TOP: Array<{ path: string; hint: string; branch?: boolean; fn?: boolean }> = [
  { path: "id", hint: "npc id" },
  { path: "name", hint: "name" },
  { path: "dialog", hint: "dialog line" },
  { path: "gossip", hint: "gossip chain" },
  { path: "hidden", hint: "hidden?" },
  { path: "direction", hint: "facing" },
  { path: "position", hint: "position…", branch: true },
  { path: "particles", hint: "particles" },
  { path: "sprite_type", hint: "sprite type" },
  { path: "quest_giver", hint: "quest giver?" },
  { path: "dialogue", hint: "draw bubble()", fn: true },
  { path: "show", hint: "draw sprite()", fn: true },
  { path: "updateParticle", hint: "emit particle()", fn: true },
];

const SCRIPT_POSITION = ["x", "y"];

/** Candidates for a trailing bare identifier; [] means no list. */
function scriptCandidates(token: string): Suggestion[] {
  const leaf = (insert: string, label: string, hint: string, caretBack?: number): Suggestion => ({ insert, label, hint, keepOpen: false, caretBack });
  if (token.includes(".")) {
    const [head, ...tailParts] = token.split(".");
    const tail = tailParts.join(".");
    if (head !== "position" || tail.includes(".")) return [];
    return SCRIPT_POSITION
      .filter((f) => f.toLowerCase().startsWith(tail.toLowerCase()))
      .map((f) => leaf(`position.${f}`, `position.${f}`, "coord"));
  }
  const out: Suggestion[] = [];
  for (const f of SCRIPT_TOP) {
    if (!f.path.toLowerCase().startsWith(token.toLowerCase())) continue;
    if (f.branch) out.push({ insert: `${f.path}.`, label: `${f.path}.`, hint: f.hint, keepOpen: true });
    else if (f.fn) out.push(leaf(`${f.path}()`, f.path, f.hint, 1));
    else out.push(leaf(f.path, f.path, f.hint));
  }
  return out;
}

/**
 * A script runs with the NPC as `this`, so the candidates are plain members of
 * the NPC and nothing is wrapped around them. Only at the end of a word:
 * typing in the middle of one must not open the list or rewrite the text.
 */
export const SCRIPT_RULES: CompleterRules = {
  token: (before, after) => (after && /[A-Za-z0-9_]/.test(after[0]) ? null : /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before)?.[1] ?? null),
  candidates: scriptCandidates,
  written: (item) => item.insert,
  listed: (item) => item.label,
};

let ids = 0;

export class Completer {
  private box: HTMLElement | null = null;
  /** The part of the box that holds the suggestions and scrolls. */
  private list: HTMLElement | null = null;
  /** The text box the list is open for, with its rules and what to do once a suggestion is taken. */
  private open: { area: HTMLTextAreaElement; rules: CompleterRules; onApplied: () => void } | null = null;
  private items: Suggestion[] = [];
  private index = 0;
  /** Where in the text the token being completed starts. */
  private start = 0;

  /** Suggest in this text box by these rules. `onApplied` is called after a suggestion has changed its text. */
  attach(area: HTMLTextAreaElement, rules: CompleterRules, onApplied: () => void): void {
    const update = () => this.update(area, rules, onApplied);
    area.setAttribute("aria-autocomplete", "list");
    area.addEventListener("input", update);
    area.addEventListener("click", update);
    // A click on a suggestion takes the focus for a moment: the list is still needed then.
    area.addEventListener("blur", () => window.setTimeout(() => {
      if (this.open?.area === area) this.hide();
    }, 150));
    area.addEventListener("keydown", (e) => {
      // The keys are only taken while the list is showing: otherwise Enter is a new line and Tab moves on.
      if (this.open?.area !== area || this.items.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = this.items.length;
        this.paint((this.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.apply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    });
  }

  private update(area: HTMLTextAreaElement, rules: CompleterRules, onApplied: () => void): void {
    if (document.activeElement !== area) return this.hide();
    const caret = area.selectionStart ?? area.value.length;
    const token = rules.token(area.value.slice(0, caret), area.value.slice(caret));
    const items = token ? rules.candidates(token) : [];
    if (!token || items.length === 0) return this.hide();
    this.open = { area, rules, onApplied };
    this.items = items;
    this.start = caret - token.length;
    this.paint(0);
  }

  private paint(selected: number): void {
    if (!this.open) return;
    const { area, rules } = this.open;
    this.index = selected;
    if (!this.box || !this.list) {
      this.box = el("div", "ne-complete");
      this.list = el("div", "ne-complete-list");
      this.list.id = `ne-complete-${++ids}`;
      this.list.setAttribute("role", "listbox");
      this.list.setAttribute("aria-label", "Suggestions");
      // The keys that work the list, said once under it: they stay in view while the list scrolls.
      const keys = el("div", "ne-complete-keys");
      const key = (does: string, ...names: string[]) => {
        const group = el("span", "ne-complete-key");
        for (const name of names) group.appendChild(el("span", "tl-kbd", name));
        group.append(does);
        return group;
      };
      keys.append(key("to move", "↑", "↓"), key("to insert", "Enter"), key("to close", "Esc"));
      this.box.append(this.list, keys);
      document.body.appendChild(this.box);
    }
    const box = this.box;
    const list = this.list;
    list.replaceChildren();
    this.items.forEach((item, i) => {
      const row = el("div", "ne-complete-row");
      row.id = `${list.id}-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === selected));
      row.append(el("span", "ne-complete-name", rules.listed(item)), el("span", "ne-complete-hint", item.hint));
      // The text box keeps the keyboard: the row is taken without taking the focus.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.index = i;
        this.apply();
      });
      list.appendChild(row);
    });

    area.setAttribute("aria-controls", list.id);
    area.setAttribute("aria-activedescendant", `${list.id}-${selected}`);
    box.hidden = false;
    // Under the text box, kept inside the window.
    const at = area.getBoundingClientRect();
    const size = box.getBoundingClientRect();
    const below = at.bottom + 4;
    box.style.left = `${Math.round(Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8)))}px`;
    box.style.top = `${Math.round(below + size.height > window.innerHeight - 8 ? Math.max(8, at.top - size.height - 4) : below)}px`;
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  private apply(): void {
    const item = this.items[this.index];
    if (!this.open || !item) return this.hide();
    const { area, rules, onApplied } = this.open;
    const caret = area.selectionStart ?? area.value.length;
    const written = rules.written(item);
    area.value = area.value.slice(0, this.start) + written + area.value.slice(caret);
    const after = this.start + written.length - (item.caretBack ?? 0);
    area.focus();
    area.setSelectionRange(after, after);
    onApplied();
    if (item.keepOpen) this.update(area, rules, onApplied);
    else this.hide();
  }

  /** Take the list away: nothing is being completed any more. */
  hide(): void {
    if (this.box) this.box.hidden = true;
    this.open?.area.removeAttribute("aria-activedescendant");
    this.open = null;
    this.items = [];
    this.index = 0;
  }
}
