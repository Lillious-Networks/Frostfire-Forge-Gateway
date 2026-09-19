// Fonts for text drawn on the canvas, matching the HTML UI.

/** Numbers: the hotbar's number font (game.css `.hotbar-key`). */
export const NUMBER_FONT = "'Alfa Slab One', sans-serif";

/** Everything else. */
export const TEXT_FONT = "'Comic Relief'";

/** Number font for text that is a number (optionally signed, e.g. "+50 XP", "120!"), else the text font. */
export const fontFor = (text: string): string => (/^[+-]?\d/.test(text) ? NUMBER_FONT : TEXT_FONT);
