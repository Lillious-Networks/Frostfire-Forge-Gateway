// Form fields for the tool windows, built from a definition: the label, the
// control, the hint under it and the problem with it, in the markup that
// css/tools.css styles. An editor describes its fields and this draws them.
//
// ------------------------------ how to use ------------------------------
//
//   const fields = new FieldRenderer({
//     rerender: () => this.render(),                          // draw the form again (a field that shows or hides others)
//     assetOptions: (field, value) => [...],                  // what an "asset" or "sheet" field offers, when the field has no `assets` of its own
//     flags: [{ bit: 1, label: "Hostile" }],                  // the boxes of a "flags" field
//     missingImage: () => `${assetServer}/icon?name=missing_icon`,   // tried once when a picture fails to load
//   });
//   const grid = el("div", "tl-fields");                      // the grid fields sit in
//   grid.appendChild(fields.renderField(field, target, touch, { error, disabled }));
//
// renderField(field, target, touch, state?) edits target[field.key] in place
// and calls touch() after every change. `state.error` is the problem to show
// under it, `state.disabled` turns its controls off. It returns the field's
// element, which carries data-field="<field.path or field.key>".
//
// A field definition:
//   { key, label, type, hint?, ... }
//   type "text"       one line.            + maxLength, placeholder
//        "textarea"   several lines; takes the whole row.   + maxLength, rows
//        "number"     "" is stored as null. + min, max, step, unit ("pixels", "seconds": written inside the field)
//        "select"     a dropdown.          + options: () => [{ value, label }]. A value made of digits is stored as a number,
//                                            unless the field says asText (a map may be called "42").
//                                            A stored value that is not offered stays visible as its own choice.
//        "segmented"  the same, side by side, for two to four choices: one stop for the Tab key, the arrow keys move
//                     through the choices, and each button carries its value as data-value.
//        "switch"     on or off, stored as true or false.
//        "checkbox"   the same as a tick box.
//        "flags"      a box of tick boxes, one per bit of the context's `flags`; takes the whole row.
//        "asset"      a button showing the picked entry, opening a searchable picker.
//                     + assets: () => [{ value, label, image?, quality? }], noIcons (names only), searchFirst (nothing listed until typed),
//                       fallback (the icon shown where there is no picture)
//        "sheet"      the same; the context's assetOptions(field, value) says what is offered (field.slot tells it which).
//        "list"       names kept as one comma-separated text (null when empty), shown as chips with a picker to add one.
//                     + assets (what can be added), known: (name) => boolean (a name that fails it is marked), noun ("particle")
//        "money"      gold, silver and copper boxes for an amount stored in copper.
//        "readonly"   the value, written out; not editable.
//   Any field:  hint       a line under the control, in plain words (read out with the control, or with the group
//                          of them, by a screen reader)
//               rerender   draw the form again after it changes
//               wide       take the whole row;   newRow   start a new row
//               path       where its problems are reported, when that is not its key ("effects.0.value")
//
// Also here: orderFields(fields) (switches and tick boxes after the rest,
// flags last), sheetOptions(sheetsBySlot, slot, current), pick(values),
// nameList("a, b") -> ["a", "b"], COPPER_PER_SILVER, COPPER_PER_GOLD, and an
// amount of copper written for reading: coins(1250) is an element, "12" and
// "50" each with its coin mark (null when it is nothing); coinWords(1250) is
// "12 silver and 50 copper", for a sentence.
//
// Problems: setFieldError(element, "Damage must be a whole number.") marks a
// field and shows the words under it; setFieldError(element, null) clears it.
// FieldRenderer.openAssetPicker(title, options, onPick, { icons, searchFirst, current, fallback })
// opens the picker on its own.
import { el, icon, listed, num, openDialog, searchBox, segments, switchControl, thumb, type IconName } from "./toolkit.js";

export type FieldType =
  | "text" | "textarea" | "number" | "select" | "segmented" | "switch" | "checkbox" | "flags"
  | "asset" | "sheet" | "list" | "money" | "readonly";

export interface Option {
  value: string | number;
  label: string;
}

export interface AssetOption {
  value: string | number;
  label: string;
  /** Preview image URL, when the asset has one. */
  image?: string | null;
  /** Item quality: the thumbnail gets the item's coloured quality frame. */
  quality?: string | null;
}

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** A line under the control, in plain words. */
  hint?: string;
  /** For "select" and "segmented": the choices. */
  options?: () => Option[];
  /** For "select" and "segmented": keep a value made of digits as text (the name of a map, not a number). */
  asText?: boolean;
  /** For "asset", "sheet" and "list": what the picker offers. */
  assets?: () => AssetOption[];
  /** For "sheet": which sprite sheet slot to browse. */
  slot?: string;
  /** For "asset", "sheet" and "list": names only, no pictures. */
  noIcons?: boolean;
  /** For "asset" and "sheet": show nothing until something is typed. */
  searchFirst?: boolean;
  /** For "asset" and "sheet": the icon shown where there is no picture. */
  fallback?: IconName;
  /** For "list": whether a name is one that exists. A name that is not is marked. */
  known?: (name: string) => boolean;
  /** For "list": what one entry is called, lower case ("particle"). */
  noun?: string;
  /** For "number". */
  min?: number;
  max?: number;
  step?: number;
  /** For "number": what it is counted in ("pixels"), written inside the field. */
  unit?: string;
  /** For "text" and "textarea". */
  maxLength?: number;
  placeholder?: string;
  /** For "textarea": how many lines tall it starts. */
  rows?: number;
  /** Draw the form again after this field changes (fields that reveal others). */
  rerender?: boolean;
  /** Take the whole row of the grid. */
  wide?: boolean;
  /** Start a new row of the grid at this field. */
  newRow?: boolean;
  /** Where its problems are reported, when that is not its key. */
  path?: string;
}

export interface FieldState {
  /** The problem to show under the field. */
  error?: string | null;
  /** Turn its controls off (a record that cannot be changed here). */
  disabled?: boolean;
}

export interface FieldContext {
  /** Draw the surrounding form again (for fields that reveal other fields). */
  rerender(): void;
  /** What an "asset" or "sheet" field offers, when the field has no `assets` of its own. */
  assetOptions?(field: Field, value: unknown): AssetOption[];
  /** Flag bits for "flags" fields. */
  flags?: Array<{ bit: number; label: string }>;
  /** An image to try once when an asset's own fails to load. */
  missingImage?(): string | null;
}

export interface PickerOptions {
  /** Show each entry's picture. Without it the picker is a list of names. */
  icons?: boolean;
  /** Show nothing until something is typed. */
  searchFirst?: boolean;
  /** The value picked now, marked in the list. */
  current?: unknown;
  fallback?: IconName;
}

/** Coin denominations, as the currency system uses them: 100 copper per silver, 100 silver per gold. */
export const COPPER_PER_SILVER = 100;
export const COPPER_PER_GOLD = 100 * COPPER_PER_SILVER;

export const pick = (values: string[]) => () => values.map((v) => ({ value: v, label: v }));

/** An amount of copper as the coins it makes: [how many, "gold" | "silver" | "copper"], without the coins there are none of. */
export function coinParts(copper: unknown): Array<[number, "gold" | "silver" | "copper"]> {
  const total = Math.max(0, Math.floor(Number(copper) || 0));
  const parts: Array<[number, "gold" | "silver" | "copper"]> = [
    [Math.floor(total / COPPER_PER_GOLD), "gold"],
    [Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER), "silver"],
    [total % COPPER_PER_SILVER, "copper"],
  ];
  return parts.filter(([amount]) => amount > 0);
}

/** An amount of copper in a sentence: "12 gold, 5 silver and 3 copper". Nothing at all is "no money". */
export function coinWords(copper: unknown): string {
  const parts = coinParts(copper).map(([amount, coin]) => `${num(amount)} ${coin}`);
  return parts.length ? listed(parts) : "no money";
}

/** An amount of copper to look at: each number with its coin mark after it. Null when it is nothing. */
export function coins(copper: unknown): HTMLElement | null {
  const parts = coinParts(copper);
  if (parts.length === 0) return null;
  const box = el("span", "tl-coins");
  for (const [amount, coin] of parts) {
    const part = el("span", "tl-coins-part", num(amount));
    part.appendChild(el("span", `tl-coin tl-coin-${coin}`));
    box.appendChild(part);
  }
  const said = parts.map(([amount, coin]) => `${num(amount)} ${coin}`).join(", ");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", said);
  box.title = said;
  return box;
}

/**
 * Switches and tick boxes always come after the other fields, and the
 * full-width flag grid last of all; within each group the declared order is kept.
 */
export function orderFields(fields: Field[]): Field[] {
  const rank = (field: Field) => (field.type === "flags" ? 2 : field.type === "checkbox" || field.type === "switch" ? 1 : 0);
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field);
}

/** The names in a comma-separated list, each once. */
export function nameList(value: unknown): string[] {
  const names: string[] = [];
  for (const part of String(value ?? "").split(",")) {
    const name = part.trim();
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

/** Sprite sheets the asset server reported for a slot, plus whatever the entry already uses. */
export function sheetOptions(
  sheetsBySlot: Record<string, Array<{ name: string; image: string | null }>>,
  slot: string,
  current: string
): AssetOption[] {
  const sheets = sheetsBySlot?.[slot] ?? [];
  const options: AssetOption[] = [
    { value: "", label: "None" },
    ...sheets.map((sheet) => ({ value: sheet.name, label: sheet.name, image: sheet.image })),
  ];
  if (current && !sheets.some((sheet) => sheet.name === current)) {
    options.push({ value: current, label: `${current} (not on the asset server)` });
  }
  return options;
}

let ids = 0;

/**
 * Marks a field as having a problem and says what it is under the control, or
 * clears the problem with `null`. The field keeps its hint.
 */
export function setFieldError(wrap: HTMLElement | null, message?: string | null): void {
  if (!wrap) return;
  wrap.querySelector(":scope > .tl-field-error")?.remove();
  wrap.classList.toggle("has-error", !!message);
  for (const control of wrap.querySelectorAll<HTMLElement>("input, select, textarea, .tl-picker, .tl-seg")) {
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
  if (!message) return;
  const line = el("span", "tl-field-error");
  line.setAttribute("role", "alert");
  line.append(icon("alert", 13), el("span", "", message));
  wrap.appendChild(line);
}

export class FieldRenderer {
  constructor(private ctx: FieldContext) {}

  /**
   * One form field. It edits `target[field.key]` and calls `touch` on change.
   * A `hint` is a line under the control; `state.error` is shown under that.
   */
  renderField(field: Field, target: any, touch: () => void, state: FieldState = {}): HTMLElement {
    const toggle = field.type === "switch" || field.type === "checkbox";
    const wide = field.wide || field.type === "textarea" || field.type === "flags" || field.type === "list";
    const wrap = el("div", "tl-field" + (wide ? " tl-field-wide" : "") + (toggle ? " tl-field-toggle" : "") + (field.newRow ? " tl-field-row-start" : ""));
    wrap.dataset.field = field.path ?? field.key;
    const id = `tl-f${++ids}`;
    const hintId = field.hint ? `${id}-hint` : "";

    const control = toggle ? this.toggle(field, target, touch, id) : this.control(field, target, touch, id);
    if (!toggle) {
      // A label names one control; a group of them (flags, coins, chips) is named as a group.
      const grouped = field.type === "flags" || field.type === "money" || field.type === "list" || field.type === "segmented" || field.type === "readonly";
      const label = el(grouped ? "span" : "label", "tl-field-label", field.label);
      if (label instanceof HTMLLabelElement) label.htmlFor = id;
      else {
        label.id = `${id}-label`;
        control.setAttribute("role", control.getAttribute("role") ?? "group");
        control.setAttribute("aria-labelledby", label.id);
      }
      wrap.appendChild(label);
    }
    wrap.appendChild(control);
    if (field.hint) {
      const hint = el("span", "tl-field-hint", field.hint);
      hint.id = hintId;
      wrap.appendChild(hint);
      // Read out with the control it is about; with the group, where the field is several controls.
      (wrap.querySelector<HTMLElement>(`#${id}`) ?? control).setAttribute("aria-describedby", hintId);
    }
    if (state.disabled) {
      for (const node of wrap.querySelectorAll<HTMLInputElement>("input, select, textarea, button")) node.disabled = true;
      if (field.type === "list") {
        // Nothing can be added or taken away: show the names, or that there are none.
        control.querySelector(":scope > .tl-btn")?.remove();
        if (!control.querySelector(".tl-chip")) control.appendChild(el("span", "tl-chips-none", "None"));
      }
    }
    if (state.error) setFieldError(wrap, state.error);
    return wrap;
  }

  /** A switch or a tick box on one line with its label. */
  private toggle(field: Field, target: any, touch: () => void, id: string): HTMLElement {
    const line = el("div", "tl-toggle");
    const label = el("label", "tl-toggle-label", field.label);
    label.htmlFor = id;
    const changed = (on: boolean) => {
      target[field.key] = on;
      touch();
      if (field.rerender) this.ctx.rerender();
    };
    if (field.type === "switch") {
      const control = switchControl(!!target[field.key], field.label, changed);
      control.id = id;
      line.append(control, label);
      // A click on the words works the switch, as it would a tick box.
      label.addEventListener("click", (e) => {
        e.preventDefault();
        if (!control.disabled) control.click();
      });
    } else {
      const box = el("input");
      box.type = "checkbox";
      box.id = id;
      box.checked = !!target[field.key];
      box.addEventListener("change", () => changed(box.checked));
      line.append(box, label);
    }
    return line;
  }

  private control(field: Field, target: any, touch: () => void, id: string): HTMLElement {
    const value = target[field.key];

    if (field.type === "flags") {
      const box = el("div", "tl-checks");
      for (const flag of this.ctx.flags ?? []) {
        const line = el("label", "tl-check");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = (Number(value) & flag.bit) !== 0;
        cb.addEventListener("change", () => {
          target[field.key] = cb.checked ? Number(target[field.key]) | flag.bit : Number(target[field.key]) & ~flag.bit;
          touch();
        });
        line.append(cb, el("span", "", flag.label));
        box.appendChild(line);
      }
      return box;
    }

    if (field.type === "asset" || field.type === "sheet") return this.pickerField(field, target, touch, id);
    if (field.type === "list") return this.listField(field, target, touch);
    if (field.type === "money") return this.moneyField(field, value, target, touch);

    if (field.type === "readonly") {
      return el("div", "tl-readonly", value === null || value === undefined || value === "" ? "None" : String(value));
    }

    if (field.type === "select" || field.type === "segmented") {
      const options = [...(field.options?.() ?? [])];
      const current = String(value ?? "");
      // A stored value that is no longer offered stays visible instead of showing blank, and says what it is.
      if (current && !options.some((o) => String(o.value) === current)) options.unshift({ value: current, label: `${current} (not one of the choices)` });
      const store = (raw: string) => {
        target[field.key] = !field.asText && /^-?\d+$/.test(raw) ? Number(raw) : raw;
        touch();
        if (field.rerender) this.ctx.rerender();
      };
      if (field.type === "segmented") return segments(options.map((option) => [String(option.value), option.label] as [string, string]), current, store);
      const select = el("select", "tl-input tl-select");
      select.id = id;
      // Nothing stored yet and no empty choice to stand for it: say so, in place of a blank box.
      if (!current && !options.some((o) => String(o.value) === "")) {
        const none = el("option", "", "Choose…");
        none.value = "";
        none.disabled = true;
        none.hidden = true;
        select.appendChild(none);
      }
      for (const option of options) {
        const node = el("option", "", option.label);
        node.value = String(option.value);
        select.appendChild(node);
      }
      select.value = current;
      select.addEventListener("change", () => store(select.value));
      return select;
    }

    if (field.type === "textarea") {
      const area = el("textarea", "tl-input tl-textarea");
      area.id = id;
      area.spellcheck = false;
      area.rows = field.rows ?? 3;
      if (field.maxLength) area.maxLength = field.maxLength;
      if (field.placeholder) area.placeholder = field.placeholder;
      area.value = value === null || value === undefined ? "" : String(value);
      area.addEventListener("input", () => {
        target[field.key] = area.value;
        touch();
      });
      return area;
    }

    const input = el("input", "tl-input" + (field.type === "number" ? " tl-input-number" : ""));
    input.id = id;
    input.type = field.type === "number" ? "number" : "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    if (field.type === "number") {
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step) input.step = String(field.step);
    } else if (field.maxLength) input.maxLength = field.maxLength;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      if (field.type === "number") target[field.key] = input.value === "" ? null : Number(input.value);
      else target[field.key] = input.value;
      touch();
    });
    if (!field.unit) return input;
    // The unit sits inside the field, to the right of the number.
    const box = el("div", "tl-affix");
    input.style.paddingRight = `calc(${field.unit.length}ch + 18px)`;
    box.append(input, el("span", "tl-affix-unit", field.unit));
    return box;
  }

  private offered(field: Field, value: unknown): AssetOption[] {
    return field.assets?.() ?? this.ctx.assetOptions?.(field, value) ?? [];
  }

  /**
   * Asset fields open a searchable picker rather than a dropdown: asset lists get
   * long, and a dropdown cannot show the pictures.
   */
  private pickerField(field: Field, target: any, touch: () => void, id: string): HTMLElement {
    const btn = el("button", "tl-picker");
    btn.type = "button";
    btn.id = id;
    btn.setAttribute("aria-haspopup", "dialog");

    const paint = () => {
      const current = target[field.key];
      const match = this.offered(field, current).find((o) => String(o.value) === String(current ?? ""));
      btn.replaceChildren();
      if (!field.noIcons) btn.appendChild(this.thumbOf(match, field.fallback));
      const none = current === null || current === undefined || current === "";
      btn.appendChild(el("span", "tl-picker-name" + (none ? " is-none" : ""), match?.label ?? (none ? "None" : String(current))));
    };
    paint();

    btn.addEventListener("click", () => {
      this.openAssetPicker(field.label, this.offered(field, target[field.key]), (option) => {
        target[field.key] = option.value;
        touch();
        if (field.rerender) this.ctx.rerender();
        else {
          paint();
          btn.focus();
        }
      }, { icons: !field.noIcons, searchFirst: field.searchFirst, current: target[field.key], fallback: field.fallback });
    });
    return btn;
  }

  private thumbOf(option: AssetOption | undefined, fallback: IconName | undefined, lazy = false): HTMLElement {
    return thumb(option?.image, {
      fallback: fallback ?? "image", missing: this.ctx.missingImage?.() ?? null, lazy,
      ...(option?.quality ? { quality: option.quality } : {}),
    });
  }

  /**
   * The searchable picker: every entry with its picture when it has one, or a
   * list of names. Picking an entry closes it; so do Escape, the close button
   * and a click outside.
   */
  openAssetPicker(title: string, options: AssetOption[], onPick: (option: AssetOption) => void, opts: PickerOptions = {}): void {
    const icons = opts.icons !== false;
    const dialog = openDialog(title);
    const list = el("div", icons ? "tl-asset-grid" : "tl-asset-list");
    const shown = el("span", "tl-muted");
    const current = opts.current === undefined ? null : String(opts.current ?? "");
    let matches: AssetOption[] = [];

    const choose = (option: AssetOption) => {
      dialog.close();
      onPick(option);
    };
    const paint = (query: string) => {
      list.replaceChildren();
      dialog.body.querySelector(".tl-empty")?.remove();
      const none = (name: IconName, heading: string, text: string) => {
        const box = el("div", "tl-empty");
        box.append(icon(name, 22), el("div", "tl-empty-title", heading), el("div", "tl-empty-text", text));
        dialog.body.appendChild(box);
        shown.textContent = "";
      };
      if (opts.searchFirst && !query) {
        matches = [];
        return none("search", "Type to search", `There are ${num(options.length)} to pick from. Type part of a name to list the ones that match.`);
      }
      matches = options.filter((o) => !query || o.label.toLowerCase().includes(query));
      if (matches.length === 0) return none("search", "Nothing matches that search", "Check the spelling, or search for less of the name.");
      shown.textContent = matches.length === options.length ? `${num(options.length)} to pick from` : `${num(matches.length)} of ${num(options.length)}`;
      for (const option of matches) {
        const tile = el("button", "tl-asset" + (current !== null && String(option.value) === current ? " is-selected" : ""));
        tile.type = "button";
        tile.title = option.label;
        if (icons) tile.appendChild(this.thumbOf(option, option.value === "" ? "ban" : opts.fallback, true));
        tile.appendChild(el("span", "tl-asset-name", option.label));
        if (tile.classList.contains("is-selected")) tile.setAttribute("aria-current", "true");
        tile.addEventListener("click", () => choose(option));
        list.appendChild(tile);
      }
    };

    const search = searchBox("Search by name", (value) => paint(value.trim().toLowerCase()));
    // Enter picks the only match, so a full name can be typed and taken.
    search.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && matches.length === 1) choose(matches[0]);
    });
    dialog.tools.append(search.root, shown);
    dialog.body.appendChild(list);
    paint("");
    search.input.focus();
    list.querySelector(".is-selected")?.scrollIntoView({ block: "center" });
  }

  /**
   * Names kept as one comma-separated text, shown as chips that can each be
   * removed, with a picker of what can be added.
   */
  private listField(field: Field, target: any, touch: () => void): HTMLElement {
    const chips = el("div", "tl-chips");
    const noun = field.noun ?? "entry";
    const paint = () => {
      chips.replaceChildren();
      const names = nameList(target[field.key]);
      const write = (next: string[]) => {
        target[field.key] = next.length ? next.join(",") : null;
        touch();
        paint();
      };
      for (const name of names) {
        const exists = field.known ? field.known(name) : true;
        const chip = el("span", "tl-chip" + (exists ? "" : " is-missing"));
        chip.title = exists ? name : `${name}: this ${noun} does not exist`;
        chip.appendChild(el("span", "", name));
        const remove = el("button", "tl-chip-x");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${name}`);
        remove.appendChild(icon("close", 12));
        remove.addEventListener("click", () => write(names.filter((n) => n !== name)));
        chip.appendChild(remove);
        chips.appendChild(chip);
      }
      const add = el("button", "tl-btn tl-btn-sm");
      add.type = "button";
      add.append(icon("plus", 13), el("span", "", `Add ${noun}`));
      add.addEventListener("click", () => {
        const free = (field.assets?.() ?? []).filter((o) => !names.some((n) => n.toLowerCase() === String(o.value).toLowerCase()));
        this.openAssetPicker(field.label, free, (option) => write([...names, String(option.value)]), { icons: !field.noIcons, fallback: field.fallback });
      });
      chips.appendChild(add);
    };
    paint();
    return chips;
  }

  /**
   * Gold, silver and copper boxes for an amount stored as a single copper
   * total (what the server keeps and drops). Silver and copper are 0-99; each
   * edit writes the combined total back.
   */
  private moneyField(field: Field, value: unknown, target: any, touch: () => void): HTMLElement {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const row = el("div", "tl-money");
    const coins = [
      { name: "Gold", cls: "gold", amount: Math.floor(total / COPPER_PER_GOLD), max: null },
      { name: "Silver", cls: "silver", amount: Math.floor((total % COPPER_PER_GOLD) / COPPER_PER_SILVER), max: 99 },
      { name: "Copper", cls: "copper", amount: total % COPPER_PER_SILVER, max: 99 },
    ];
    const inputs: HTMLInputElement[] = [];
    const write = () => {
      const [gold, silver, copper] = inputs.map((input) => Math.max(0, Math.floor(Number(input.value) || 0)));
      target[field.key] = gold * COPPER_PER_GOLD + silver * COPPER_PER_SILVER + copper;
      touch();
    };
    for (const coin of coins) {
      const part = el("label", "tl-money-part");
      part.title = coin.name;
      const input = el("input", "tl-input tl-input-number");
      input.type = "number";
      input.min = "0";
      if (coin.max !== null) input.max = String(coin.max);
      input.step = "1";
      input.value = String(coin.amount);
      input.setAttribute("aria-label", `${field.label}, ${coin.name.toLowerCase()}`);
      input.addEventListener("input", write);
      // On leaving the box, tidy it: whole numbers, and silver and copper capped at 99.
      input.addEventListener("change", () => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        input.value = String(coin.max === null ? n : Math.min(coin.max, n));
        write();
      });
      inputs.push(input);
      part.append(input, el("span", `tl-coin tl-coin-${coin.cls}`));
      row.appendChild(part);
    }
    return row;
  }
}
