// Fields only the particle editor has: a slider with its exact number beside
// it, a colour field and a time-of-day field. They are made of the kit's
// classes, in the markup of a toolfields.ts field, and styled in
// css/particleeditor.css (pe-*). Nothing here knows about particles; they stay
// here, out of the shared system, until a second tool needs one.
//
// ------------------------------ how to use ------------------------------
//
//   sliderField({ key, label, min, max, step, unit?, hint? }, target, touch)
//        edits target[key], a number kept within min..max on the steps of the slider, by dragging or by typing
//   colourField({ key, label, hint? }, target, touch)      edits target[key], "#rrggbb"
//   timeField({ key, label, hint? }, target, touch)        edits target[key], "HH:MM" or ""
//        each returns the field's element, which carries data-field="<key>", and calls touch() after every change
//   rangeValue(value, min, max, step)  colourValue(value)  timeValue(value)
//        what those controls make of a stored value: the number a slider would hold, the colour and the time the
//        browser's own fields would
import { setFieldError } from "./toolfields.js";
import { el } from "./toolkit.js";

let ids = 0;

// ------------------------------------------------------------------ values

/**
 * What a slider makes of a value: kept within its ends and on its steps, the
 * way the browser does it for a range input (which is what does it here).
 */
export function rangeValue(value: unknown, min: number, max: number, step: number): number {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = value !== null && value !== undefined ? String(value) : "";
  return Number(input.value);
}

/**
 * A stored colour as the colour field holds it, "#rrggbb" in lower case. The
 * short form "#abc" is read as "#aabbcc"; what the browser's colour field
 * cannot read at all comes out black, as it always has.
 */
export function colourValue(value: unknown): string {
  const text = String(value ?? "").trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  const input = document.createElement("input");
  input.type = "color";
  input.value = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : text;
  return input.value;
}

/** A stored time of day as the time field holds it: "HH:MM", or "" when it is not a time. */
export function timeValue(value: unknown): string {
  const input = document.createElement("input");
  input.type = "time";
  input.value = value !== null && value !== undefined ? String(value) : "";
  return input.value;
}

// ------------------------------------------------------------------ fields

function fieldShell(key: string, labelText: string, className = ""): { wrap: HTMLElement; label: HTMLLabelElement; id: string } {
  const wrap = el("div", "tl-field" + (className ? ` ${className}` : ""));
  wrap.dataset.field = key;
  const id = `pe-f${++ids}`;
  const label = el("label", "tl-field-label", labelText);
  label.htmlFor = id;
  wrap.appendChild(label);
  return { wrap, label, id };
}

function addHint(wrap: HTMLElement, control: HTMLElement, hint?: string): void {
  if (!hint) return;
  const line = el("span", "tl-field-hint", hint);
  line.id = `${control.id}-hint`;
  control.setAttribute("aria-describedby", line.id);
  wrap.appendChild(line);
}

export interface SliderOptions {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** What it is counted in ("px"), written inside the number beside the slider. */
  unit?: string;
  hint?: string;
}

/**
 * A slider on one line: its label, the track, and the exact number, which can
 * be typed. Whatever is typed is kept to what the slider itself can hold.
 */
export function sliderField(opts: SliderOptions, target: any, touch: () => void): HTMLElement {
  const { wrap, id } = fieldShell(opts.key, opts.label, "tl-field-wide pe-slider");
  const range = el("input", "pe-range");
  range.type = "range";
  range.id = id;
  range.min = String(opts.min);
  range.max = String(opts.max);
  range.step = String(opts.step);
  range.value = String(target[opts.key]);

  const exact = el("input", "tl-input tl-input-number");
  exact.type = "number";
  exact.min = range.min;
  exact.max = range.max;
  exact.step = range.step;
  exact.setAttribute("aria-label", `${opts.label}, exact value`);
  const box = el("div", "tl-affix pe-slider-number");
  box.appendChild(exact);
  if (opts.unit) {
    exact.style.paddingRight = `calc(${opts.unit.length}ch + 18px)`;
    box.appendChild(el("span", "tl-affix-unit", opts.unit));
  }

  /** How far along the track the value is, for the filled part of it. */
  const paint = () => {
    const span = opts.max - opts.min;
    range.style.setProperty("--pe-fill", `${span > 0 ? ((Number(range.value) - opts.min) / span) * 100 : 0}%`);
  };
  const store = () => {
    target[opts.key] = Number(range.value);
    paint();
    touch();
  };
  exact.value = String(Number(range.value));
  paint();
  range.addEventListener("input", () => {
    exact.value = String(Number(range.value));
    store();
  });
  exact.addEventListener("input", () => {
    // Half a number ("", "-", "0.") changes nothing yet.
    if (exact.value === "" || !Number.isFinite(Number(exact.value))) return;
    range.value = exact.value;
    store();
  });
  // On leaving the box it shows what was kept: within the ends, on a step.
  exact.addEventListener("change", () => (exact.value = String(Number(range.value))));

  wrap.append(range, box);
  addHint(wrap, range, opts.hint);
  return wrap;
}

/** A colour: a swatch that opens the system's colour picker, and its code, which can be typed or pasted. */
export function colourField(opts: { key: string; label: string; hint?: string }, target: any, touch: () => void): HTMLElement {
  const { wrap, id } = fieldShell(opts.key, opts.label);
  const picker = el("input");
  picker.type = "color";
  picker.value = String(target[opts.key] ?? "");
  picker.setAttribute("aria-label", `${opts.label}, pick from a palette`);
  const swatch = el("span", "pe-colour-swatch");
  swatch.appendChild(picker);
  const code = el("input", "tl-input pe-colour-code");
  code.type = "text";
  code.id = id;
  code.maxLength = 7;
  code.spellcheck = false;
  code.autocomplete = "off";

  const show = () => swatch.style.setProperty("--pe-colour", picker.value);
  const store = () => {
    target[opts.key] = picker.value;
    show();
    touch();
  };
  code.value = picker.value;
  show();
  picker.addEventListener("input", () => {
    code.value = picker.value;
    setFieldError(wrap, null);
    store();
  });
  code.addEventListener("input", () => {
    const typed = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(code.value.trim());
    // Half a code changes nothing yet.
    if (!typed) return;
    picker.value = colourValue(`#${typed[1]}`);
    setFieldError(wrap, null);
    store();
  });
  // On leaving the box: the colour that was kept, or why what was typed was not.
  code.addEventListener("change", () => {
    const typed = code.value.trim();
    const kept = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.test(typed);
    code.value = picker.value;
    setFieldError(wrap, kept || !typed ? null : `"${typed}" is not a colour code. One looks like #ff8a3d.`);
  });

  const line = el("div", "pe-colour");
  line.append(swatch, code);
  wrap.appendChild(line);
  addHint(wrap, code, opts.hint);
  return wrap;
}

/** A time of day, typed or picked with the browser's own time field. */
export function timeField(opts: { key: string; label: string; hint?: string }, target: any, touch: () => void): HTMLElement {
  const { wrap, id } = fieldShell(opts.key, opts.label);
  const input = el("input", "tl-input tl-input-number pe-time");
  input.type = "time";
  input.id = id;
  input.value = String(target[opts.key] ?? "");
  const store = () => {
    target[opts.key] = input.value;
    touch();
  };
  input.addEventListener("input", store);
  input.addEventListener("change", store);
  wrap.appendChild(input);
  addHint(wrap, input, opts.hint);
  return wrap;
}
