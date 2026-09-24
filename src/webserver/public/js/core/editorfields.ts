// Shared editor form machinery, extracted verbatim from the creature editor
// bridge so every editor renders the same fields, pickers and popups: the
// NPC appearance tab and any future editor use this instead of copying it.
export type FieldType =
  | "text" | "number" | "select" | "checkbox" | "flags" | "readonly"
  | "sheet" | "asset" | "money";

export interface AssetOption {
  value: string | number;
  label: string;
  /** Preview image URL, when the asset has one. */
  image?: string | null;
}

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: () => Array<{ value: string | number; label: string }>;
  /** For "asset" fields: the browsable list shown in the picker popup. */
  assets?: () => AssetOption[];
  step?: number;
  hint?: string;
  /** For "sheet" fields: which sprite sheet slot to browse. */
  slot?: string;
  /** Re-render the form after this field changes (fields that reveal others). */
  rerender?: boolean;
  /** For "asset" and "sheet" fields: a text-only list, no image column. */
  noIcons?: boolean;
  /** For "asset" and "sheet" fields: show nothing until the user types. */
  searchFirst?: boolean;
  /** Start a new row of the form grid at this field. */
  newRow?: boolean;
}

/** Coin denominations, as the currency system uses them: 100 copper per silver, 100 silver per gold. */
export const COPPER_PER_SILVER = 100;
export const COPPER_PER_GOLD = 100 * COPPER_PER_SILVER;

export const pick = (values: string[]) => () => values.map((v) => ({ value: v, label: v }));

/**
 * Checkboxes always come after the other fields, and the full-width flag grid
 * last of all; within each group the declared order is kept.
 */
export function orderFields(fields: Field[]): Field[] {
  const rank = (field: Field) => (field.type === "flags" ? 2 : field.type === "checkbox" ? 1 : 0);
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index)
    .map(({ field }) => field);
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

export interface FieldRendererContext {
  /** Resolve the browsable options for an "asset" or "sheet" field. */
  assetOptions(field: Field, value: unknown): AssetOption[];
  /** Re-render the surrounding form (for fields that reveal other fields). */
  rerender(): void;
  /** Flag bits for "flags" fields; omitted when the editor has none. */
  flags?: Array<{ bit: number; label: string }>;
}

export class FieldRenderer {
  constructor(private ctx: FieldRendererContext) {}

  /**
   * One form field. It edits `target[field.key]` and calls `touch` on change.
   */
  renderField(field: Field, target: any, touch: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ce-field"
      + (field.type === "flags" ? " ce-field-wide" : "")
      + (field.type === "money" ? " ce-field-money" : "")
      + (field.newRow ? " ce-field-row-start" : "");
    const value = target[field.key];

    if (field.type === "checkbox") {
      wrap.classList.add("ce-field-check");
      const line = document.createElement("label");
      line.className = "editor-form-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      cb.addEventListener("change", () => {
        target[field.key] = cb.checked;
        touch();
      });
      line.appendChild(cb);
      line.appendChild(document.createTextNode(` ${field.label}`));
      wrap.appendChild(line);
      return wrap;
    }

    const label = document.createElement("label");
    label.className = "editor-form-label";
    label.textContent = field.label;
    wrap.appendChild(label);

    if (field.type === "flags") {
      const box = document.createElement("div");
      box.className = "editor-flags";
      for (const flag of this.ctx.flags ?? []) {
        const id = `flag-${flag.bit}`;
        const line = document.createElement("label");
        line.className = "editor-form-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = id;
        cb.checked = (Number(value) & flag.bit) !== 0;
        cb.addEventListener("change", () => {
          target[field.key] = cb.checked ? Number(target[field.key]) | flag.bit : Number(target[field.key]) & ~flag.bit;
          touch();
        });
        line.appendChild(cb);
        line.appendChild(document.createTextNode(` ${flag.label}`));
        box.appendChild(line);
      }
      wrap.appendChild(box);
      return wrap;
    }

    if (field.type === "asset" || field.type === "sheet") {
      wrap.appendChild(this.renderPickerField(field, target, touch));
      return wrap;
    }

    if (field.type === "money") {
      wrap.appendChild(this.renderMoneyField(field, value, target, touch));
      return wrap;
    }

    if (field.type === "select") {
      const options = field.options?.() ?? [];
      const select = document.createElement("select");
      select.className = "editor-form-input";
      for (const option of options) {
        const el = document.createElement("option");
        el.value = String(option.value);
        el.textContent = option.label;
        select.appendChild(el);
      }
      select.value = String(value ?? "");
      select.addEventListener("change", () => {
        const raw = select.value;
        target[field.key] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
        touch();
        if (field.rerender) this.ctx.rerender();
      });
      wrap.appendChild(select);
      return wrap;
    }

    const input = document.createElement("input");
    input.className = "editor-form-input";
    input.type = field.type === "number" ? "number" : "text";
    input.spellcheck = false;
    if (field.step) input.step = String(field.step);
    input.value = value === null || value === undefined ? "" : String(value);
    input.addEventListener("input", () => {
      if (field.type === "number") target[field.key] = input.value === "" ? null : Number(input.value);
      else target[field.key] = input.value;
      touch();
    });
    wrap.appendChild(input);
    return wrap;
  }

  /**
   * Asset fields open a searchable popup rather than a dropdown: asset lists get
   * long, and a dropdown cannot show the images.
   */
  private renderPickerField(field: Field, target: any, touch: () => void): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ce-asset-button";

    const paint = () => {
      const current = target[field.key];
      const match = this.ctx.assetOptions(field, current).find((o) => String(o.value) === String(current ?? ""));
      button.innerHTML = "";
      if (!field.noIcons) {
        const thumb = document.createElement("span");
        thumb.className = "ce-asset-thumb";
        if (match?.image) {
          const img = document.createElement("img");
          img.src = match.image;
          img.alt = "";
          img.loading = "lazy";
          thumb.appendChild(img);
        }
        button.appendChild(thumb);
      }
      const text = document.createElement("span");
      text.className = "ce-asset-name";
      text.textContent = match?.label ?? (current ? String(current) : "None");
      button.appendChild(text);
    };
    paint();

    button.addEventListener("click", () => {
      this.openAssetPicker(field.label, this.ctx.assetOptions(field, target[field.key]), !field.noIcons, (option) => {
        target[field.key] = option.value;
        touch();
        if (field.rerender) this.ctx.rerender();
        else paint();
      }, !!field.searchFirst);
    });
    return button;
  }

  /** Searchable asset browser. With `icons`, entries show their image when they have one. */
  openAssetPicker(title: string, options: AssetOption[], icons: boolean, onPick: (option: AssetOption) => void, searchFirst = false): void {
    const overlay = document.createElement("div");
    overlay.className = "editor-modal-overlay";
    const box = document.createElement("div");
    box.className = "editor-modal-box ce-asset-picker";
    const heading = document.createElement("h3");
    heading.textContent = title;
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search...";
    search.spellcheck = false;
    const list = document.createElement("div");
    list.className = "ce-asset-list";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };

    const paintList = () => {
      const query = search.value.toLowerCase();
      list.innerHTML = "";
      if (searchFirst && !query) {
        const empty = document.createElement("div");
        empty.className = "editor-empty";
        empty.textContent = "Type to search.";
        list.appendChild(empty);
        return;
      }
      const matches = options.filter((o) => !query || o.label.toLowerCase().includes(query));
      if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "editor-empty";
        empty.textContent = "Nothing matches that search.";
        list.appendChild(empty);
        return;
      }
      for (const option of matches) {
        const row = document.createElement("div");
        row.className = "ce-asset-row";
        if (icons) {
          const thumb = document.createElement("span");
          thumb.className = "ce-asset-thumb";
          if (option.image) {
            const img = document.createElement("img");
            img.src = option.image;
            img.alt = "";
            img.loading = "lazy";
            thumb.appendChild(img);
          }
          row.appendChild(thumb);
        }
        const text = document.createElement("span");
        text.className = "ce-asset-name";
        text.textContent = option.label;
        row.appendChild(text);
        row.addEventListener("click", () => {
          onPick(option);
          close();
        });
        list.appendChild(row);
      }
    };

    search.addEventListener("input", paintList);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);

    box.appendChild(heading);
    box.appendChild(search);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paintList();
    search.focus();
  }

  /**
   * Gold, silver and copper inputs for an amount stored as a single copper
   * total (what the server keeps and drops). Silver and copper are 0-99; each
   * edit writes the combined total back to the draft.
   */
  renderMoneyField(field: Field, value: unknown, target: any, touch: () => void): HTMLElement {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const row = document.createElement("div");
    row.className = "ce-money";

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
      const part = document.createElement("label");
      part.className = `ce-money-part ce-money-${coin.cls}`;
      const input = document.createElement("input");
      input.className = "editor-form-input";
      input.type = "number";
      input.min = "0";
      if (coin.max !== null) input.max = String(coin.max);
      input.step = "1";
      input.value = String(coin.amount);
      input.setAttribute("aria-label", `${field.label} ${coin.name.toLowerCase()}`);
      input.addEventListener("input", write);
      // On leaving the box, tidy it: whole numbers, and silver/copper capped at 99.
      input.addEventListener("change", () => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        input.value = String(coin.max === null ? n : Math.min(coin.max, n));
        write();
      });
      inputs.push(input);
      part.appendChild(input);
      // The same coin icons as the in-game currency display (game.css).
      const unit = document.createElement("span");
      unit.className = `currency-icon currency-icon-${coin.cls} ce-money-icon`;
      part.title = coin.name;
      part.appendChild(unit);
      row.appendChild(part);
    }
    return row;
  }
}
