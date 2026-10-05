// What the quest editor and the NPC editor share and no other tool has: a
// field that holds several picks out of a list. A quest has the quests that
// come before it and the NPCs that give and take it; an NPC has its quests and
// its particles. The picks are shown as chips (the kit's .tl-chips), each with
// its own way out, and a button opens a dialog where all that can be picked is
// listed to tick. Styles: css/questnpcparts.css (classes qn-*). It is one
// implementation for its two editors and stays here, under its own names,
// until a third tool needs it.
//
// ------------------------------ how to use ------------------------------
//
//   grid.appendChild(manyField({
//     path: "prerequisites", label: "Prerequisites", noun: "quest",
//     hint: "Quests that must be completed before this one is offered.",
//     choices: () => [{ value: 3, label: "A Rat Problem", mark: "#3", note: "#3" }],
//     get: () => quest.prerequisites,
//     set: (next) => { quest.prerequisites = next; markChanged(); },
//     error: problems.prerequisites,
//   }));
//
// `set` is called at every tick in the dialog and at every chip removed, as
// the pickers of the old editors did. A pick that is not among the choices
// (a deleted quest, an NPC that no longer gives quests) is still shown, marked,
// and can be removed. pickMany() opens the dialog on its own.
import { button, el, empty, icon, num, openDialog, searchBox } from "./toolkit.js";
import { setFieldError } from "./toolfields.js";

export interface Choice<T extends number | string = number | string> {
  value: T;
  /** Its name. */
  label: string;
  /** More about it, at the end of its line in the dialog: "#12 · main". */
  note?: string;
  /** What tells it from another of the same name, beside the name on its chip: "#12". */
  mark?: string;
}

export interface ManyField<T extends number | string> {
  /** Where its problems are reported, and how the page finds it again after a redraw. */
  path: string;
  label: string;
  /** A line under the chips, in plain words. */
  hint?: string;
  /** What one pick is called, lower case ("quest"), and several ("quests" unless given). */
  noun: string;
  plural?: string;
  choices(): Choice<T>[];
  get(): T[];
  set(next: T[]): void;
  /** The problem to show under the field. */
  error?: string | null;
  /** What a pick that is not among the choices is, for its tooltip: "this quest no longer exists". */
  gone?: string;
  /** Called when the dialog has closed. */
  onDone?(): void;
}

/**
 * The dialog: everything that can be picked, each with a tick box, and a
 * search field. A tick is passed on at once; Done, Escape and a click outside
 * close it.
 */
export function pickMany<T extends number | string>(
  title: string,
  choices: Choice<T>[],
  picked: T[],
  onChange: (next: T[]) => void,
  opts: { plural: string; onClose?: () => void }
): void {
  let selected = [...picked];
  const dialog = openDialog(title, { onClose: opts.onClose });
  const list = el("div", "qn-picks");
  const tally = el("span", "tl-muted");
  tally.setAttribute("role", "status");
  const paintTally = () => {
    // A pick that is not among the choices has no line to tick here, and still counts.
    const gone = selected.filter((value) => !choices.some((c) => c.value === value)).length;
    tally.textContent = `${num(selected.length)} selected${gone ? ` (${num(gone)} not in this list)` : ""}`;
  };

  const paint = (query: string) => {
    list.replaceChildren();
    dialog.body.querySelector(".tl-empty")?.remove();
    const matches = choices.filter((c) => !query || `${c.label} ${c.note ?? ""}`.toLowerCase().includes(query));
    if (matches.length === 0) {
      if (choices.length === 0) empty(dialog.body, "list", `There are no ${opts.plural} to pick yet`);
      else empty(dialog.body, "search", "Nothing matches that search", "Check the spelling, or search for less of the name.");
      return;
    }
    for (const choice of matches) {
      const row = el("label", "qn-pick");
      row.title = choice.note ? `${choice.label} (${choice.note})` : choice.label;
      const box = el("input");
      box.type = "checkbox";
      box.checked = selected.includes(choice.value);
      box.addEventListener("change", () => {
        if (!box.checked) selected = selected.filter((value) => value !== choice.value);
        else if (!selected.includes(choice.value)) selected.push(choice.value);
        onChange([...selected]);
        paintTally();
      });
      row.append(box, el("span", "qn-pick-name", choice.label));
      if (choice.note) row.appendChild(el("span", "qn-pick-note", choice.note));
      list.appendChild(row);
    }
  };

  const search = searchBox(`Search ${opts.plural}`, (value) => paint(value.trim().toLowerCase()));
  dialog.tools.appendChild(search.root);
  dialog.body.appendChild(list);
  dialog.foot.append(tally, button("Done", () => dialog.close(), { kind: "primary" }));
  paintTally();
  paint("");
  search.input.focus();
}

let ids = 0;

/** A field holding several picks: its label, the picks as chips, the button that opens the dialog, its hint and its problem. */
export function manyField<T extends number | string>(def: ManyField<T>): HTMLElement {
  const plural = def.plural ?? `${def.noun}s`;
  const wrap = el("div", "tl-field tl-field-wide");
  wrap.dataset.field = def.path;
  const label = el("span", "tl-field-label", def.label);
  label.id = `qn-f${++ids}-label`;
  const chips = el("div", "tl-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-labelledby", label.id);

  const open = button(`Choose ${plural}`, () => {
    pickMany(def.label, def.choices(), def.get(), (next) => {
      def.set(next);
      paint();
    }, {
      plural,
      onClose: () => {
        paint();
        // The page may have been drawn again under the dialog; then it is for the page to put the focus back.
        if (open.isConnected) open.focus();
        def.onDone?.();
      },
    });
  }, { icon: "list", small: true });
  open.classList.add("qn-open");
  open.setAttribute("aria-haspopup", "dialog");

  const paint = () => {
    const choices = def.choices();
    const picked = def.get();
    chips.replaceChildren();
    for (const value of picked) {
      const choice = choices.find((c) => c.value === value);
      const name = choice ? choice.label : typeof value === "number" ? `#${value}` : String(value);
      const chip = el("span", "tl-chip" + (choice ? "" : " is-missing"));
      chip.title = choice ? (choice.note ? `${choice.label} (${choice.note})` : choice.label) : `${name}: ${def.gone ?? `this ${def.noun} cannot be picked any more`}`;
      chip.appendChild(el("span", "", name));
      if (choice?.mark) chip.appendChild(el("span", "qn-chip-mark", choice.mark));
      const remove = el("button", "tl-chip-x");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${name}`);
      remove.appendChild(icon("close", 12));
      remove.addEventListener("click", () => {
        def.set(def.get().filter((other) => other !== value));
        paint();
        open.focus();
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
    if (picked.length === 0) chips.appendChild(el("span", "tl-chips-none", "None"));
    chips.appendChild(open);
  };
  paint();

  wrap.append(label, chips);
  if (def.hint) {
    const hint = el("span", "tl-field-hint", def.hint);
    hint.id = `${label.id}-hint`;
    // Read out with the group of picks, as the hint of a single control is with that control.
    chips.setAttribute("aria-describedby", hint.id);
    wrap.appendChild(hint);
  }
  if (def.error) setFieldError(wrap, def.error);
  return wrap;
}
