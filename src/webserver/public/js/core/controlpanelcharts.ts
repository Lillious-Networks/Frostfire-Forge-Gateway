// The control panel's charts, drawn as inline SVG: a line over time with axes
// and a readout under the pointer, the small trend line of a headline figure,
// and the bars of a breakdown. Marks carry the data colour; every word and
// number is written in the text colours.
import { clock, el, num, svg } from "./toolkit.js";

/** One reading: when, in seconds since the epoch, and the figure (null where it was not known). */
export interface Point { t: number; v: number | null }

export interface LineChartOptions {
  /** What is charted, for the readout and for screen readers. */
  label: string;
  /** The figure with its unit, as the readout writes it. */
  format: (value: number) => string;
  /** The figure as the axis writes it: shorter, the unit in the chart's title. */
  axis: (value: number) => string;
  /** Pixels of plot and axis together. */
  height: number;
  /** Whether the scale starts at zero, or just under the lowest reading. */
  fromZero: boolean;
  /** The scale never ends lower than this, so a quiet line near zero is not blown up to fill the plot. */
  minTop?: number;
  /** A level worth seeing when the readings come near it. */
  threshold?: { value: number; label: string };
}

const MARGIN = { top: 12, right: 14, bottom: 24, left: 46 };

/** A scale of round numbers from at most `low` to at least `high`, in about `steps` steps. */
function roundScale(low: number, high: number, steps: number): { low: number; high: number; step: number } {
  const span = Math.max(high - low, 1e-9);
  const rough = span / steps;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  return { low: Math.floor(low / step) * step, high: Math.ceil(high / step) * step, step };
}

/** Seconds between the labels of the time axis, for a window this long and this many labels at most. */
function timeStep(span: number, most: number): number {
  const steps = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200];
  return steps.find((step) => span / step <= most) ?? 86400;
}

/**
 * A single line over time. It redraws to the width it is given, and shows the
 * reading nearest the pointer (or, with the arrow keys, the one focused).
 */
export class LineChart {
  readonly element: HTMLElement;
  private plot = svg("svg", { class: "cp-plot-svg", role: "img", tabindex: 0 });
  private tip = el("div", "cp-plot-tip");
  private empty = el("div", "cp-plot-empty");
  private points: Point[] = [];
  private from = 0;
  private to = 1;
  private gap = Infinity;
  private width = 0;
  /** The reading the readout is on, as an index into the readings that have a figure. */
  private at: number | null = null;
  private drawn: Point[] = [];
  private scale = { low: 0, high: 1, step: 1 };

  constructor(private options: LineChartOptions) {
    this.element = el("div", "cp-plot");
    this.element.style.height = `${options.height}px`;
    this.tip.hidden = true;
    this.empty.hidden = true;
    this.element.append(this.plot, this.tip, this.empty);

    this.plot.addEventListener("pointermove", (e) => this.point(this.nearest(e.clientX - this.plot.getBoundingClientRect().left)));
    this.plot.addEventListener("pointerleave", () => this.point(null));
    this.plot.addEventListener("blur", () => this.point(null));
    this.plot.addEventListener("focus", () => {
      if (this.at === null && this.drawn.length) this.point(this.drawn.length - 1);
    });
    this.plot.addEventListener("keydown", (e) => {
      if (!this.drawn.length) return;
      const now = this.at ?? this.drawn.length - 1;
      const next = e.key === "ArrowLeft" ? now - 1 : e.key === "ArrowRight" ? now + 1 : e.key === "Home" ? 0 : e.key === "End" ? this.drawn.length - 1 : null;
      if (e.key === "Escape") this.point(null);
      if (next === null) return;
      e.preventDefault();
      this.point(Math.min(this.drawn.length - 1, Math.max(0, next)));
    });
    new ResizeObserver(() => {
      const width = Math.floor(this.element.clientWidth);
      if (width && width !== this.width) this.draw();
    }).observe(this.element);
  }

  /**
   * Draws the readings that fall in the window `from`..`to` (seconds). Two
   * readings further apart than `gap` are not joined: the server was not
   * taking readings in between.
   */
  update(points: Point[], from: number, to: number, gap: number): void {
    this.points = points;
    this.from = from;
    this.to = to;
    this.gap = gap;
    this.draw();
  }

  private x(t: number): number {
    const inner = this.width - MARGIN.left - MARGIN.right;
    return MARGIN.left + ((t - this.from) / (this.to - this.from)) * inner;
  }

  private y(v: number): number {
    const inner = this.options.height - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + (1 - (v - this.scale.low) / (this.scale.high - this.scale.low)) * inner;
  }

  private draw(): void {
    const { height, fromZero, minTop, threshold, label, format, axis } = this.options;
    this.width = Math.floor(this.element.clientWidth);
    if (!this.width) return;
    const kept = this.at !== null ? this.drawn[this.at]?.t : null;
    this.plot.replaceChildren();
    this.plot.setAttribute("viewBox", `0 0 ${this.width} ${height}`);
    this.plot.setAttribute("width", String(this.width));
    this.plot.setAttribute("height", String(height));

    this.drawn = this.points.filter((p) => p.v !== null && p.t >= this.from && p.t <= this.to);
    const values = this.drawn.map((p) => p.v as number);
    const lowest = values.length ? Math.min(...values) : 0;
    const highest = values.length ? Math.max(...values) : 0;
    const top = Math.max(highest, minTop ?? 0);
    this.scale = fromZero
      ? roundScale(0, top || 1, 4)
      // A little room under the lowest reading, never below zero.
      : roundScale(Math.max(0, lowest - (top - lowest || top * 0.1 || 1) * 0.25), top + (top - lowest || top * 0.1 || 1) * 0.1, 4);

    const right = this.width - MARGIN.right;
    const bottom = height - MARGIN.bottom;
    const grid = svg("g", { class: "cp-plot-grid" });
    for (let value = this.scale.low; value <= this.scale.high + this.scale.step / 2; value += this.scale.step) {
      const y = Math.round(this.y(value)) + 0.5;
      grid.appendChild(svg("line", { x1: MARGIN.left, x2: right, y1: y, y2: y, class: value === this.scale.low ? "cp-plot-base" : "" }));
      // With nothing to measure there is no scale to write beside the lines.
      if (!values.length) continue;
      const text = svg("text", { x: MARGIN.left - 8, y: y + 4, "text-anchor": "end", class: "cp-plot-label" });
      text.textContent = axis(value);
      grid.appendChild(text);
    }
    // The labels of the time axis fall on round times of the admin's own clock.
    const offset = new Date(this.to * 1000).getTimezoneOffset() * 60;
    const step = timeStep(this.to - this.from, Math.max(2, Math.floor((right - MARGIN.left) / 72)));
    this.plot.appendChild(grid);
    let taken = -Infinity;
    for (let t = Math.ceil((this.from - offset) / step) * step + offset; t <= this.to; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      grid.appendChild(svg("line", { x1: x, x2: x, y1: bottom, y2: bottom + 4, class: "cp-plot-base" }));
      // A label hard against an end of the axis is written inwards from its mark, so it is not cut off.
      const anchor = x < MARGIN.left + 28 ? "start" : x > right - 28 ? "end" : "middle";
      const text = svg("text", { x, y: bottom + 17, "text-anchor": anchor, class: "cp-plot-label" });
      text.textContent = clock(t * 1000);
      grid.appendChild(text);
      // One that would run into the label before it is left out; its mark stays.
      const box = text.getBBox();
      if (box.x < taken + 10) text.remove();
      else taken = box.x + box.width;
    }

    if (threshold && threshold.value < this.scale.high && threshold.value > this.scale.low) {
      const y = Math.round(this.y(threshold.value)) + 0.5;
      const mark = svg("g", { class: "cp-plot-threshold" });
      mark.appendChild(svg("line", { x1: MARGIN.left, x2: right, y1: y, y2: y }));
      const text = svg("text", { x: right, y: y - 5, "text-anchor": "end", class: "cp-plot-label" });
      text.textContent = threshold.label;
      mark.appendChild(text);
      this.plot.appendChild(mark);
    }

    // The line, broken where the readings stop. Where the scale starts at zero, a wash
    // of its colour fills down to the axis; on a scale that does not, that would
    // show an amount that is not there.
    const runs: Point[][] = [];
    for (const [i, p] of this.drawn.entries()) {
      if (i === 0 || p.t - this.drawn[i - 1].t > this.gap) runs.push([]);
      runs[runs.length - 1].push(p);
    }
    for (const run of runs) {
      const line = run.map((p, i) => `${i ? "L" : "M"}${this.x(p.t).toFixed(1)} ${this.y(p.v as number).toFixed(1)}`).join("");
      if (run.length > 1) {
        const area = `${line}L${this.x(run[run.length - 1].t).toFixed(1)} ${bottom}L${this.x(run[0].t).toFixed(1)} ${bottom}Z`;
        if (fromZero) this.plot.appendChild(svg("path", { d: area, class: "cp-plot-area" }));
        this.plot.appendChild(svg("path", { d: line, class: "cp-plot-line" }));
      } else {
        this.plot.appendChild(svg("circle", { cx: this.x(run[0].t), cy: this.y(run[0].v as number), r: 2, class: "cp-plot-dot" }));
      }
    }
    const last = this.drawn[this.drawn.length - 1];
    if (last) this.plot.appendChild(svg("circle", { cx: this.x(last.t), cy: this.y(last.v as number), r: 4, class: "cp-plot-end" }));

    const marker = svg("g", { class: "cp-plot-marker" });
    marker.appendChild(svg("line", { y1: MARGIN.top, y2: bottom }));
    marker.appendChild(svg("circle", { r: 4.5 }));
    marker.style.display = "none";
    this.plot.appendChild(marker);
    // The whole plot answers the pointer, not only the line.
    this.plot.appendChild(svg("rect", { x: 0, y: 0, width: this.width, height, fill: "transparent" }));

    this.empty.hidden = this.drawn.length > 0;
    this.empty.textContent = this.points.some((p) => p.v !== null) ? "No readings in this stretch of time." : "No readings yet. The first is taken within 15 seconds of the server starting.";
    this.plot.setAttribute("aria-label", this.drawn.length
      ? `${label}: ${format(last.v as number)} now, from ${format(lowest)} to ${format(highest)} over this time. Use the arrow keys to read each point.`
      : `${label}: no readings yet.`);

    // The readout stays on the reading it was on while new ones arrive.
    const again = kept === null || kept === undefined ? -1 : this.drawn.findIndex((p) => p.t === kept);
    this.at = null;
    this.point(again >= 0 ? again : null);
  }

  /** The reading nearest a horizontal position of the plot, in pixels. */
  private nearest(px: number): number | null {
    if (!this.drawn.length) return null;
    let best = 0;
    let distance = Infinity;
    for (const [i, p] of this.drawn.entries()) {
      const d = Math.abs(this.x(p.t) - px);
      if (d < distance) {
        best = i;
        distance = d;
      }
    }
    return best;
  }

  private point(index: number | null): void {
    const marker = this.plot.querySelector<SVGGElement>(".cp-plot-marker");
    this.at = index;
    const p = index === null ? null : this.drawn[index];
    if (!marker || !p) {
      if (marker) marker.style.display = "none";
      this.tip.hidden = true;
      return;
    }
    const x = this.x(p.t);
    const y = this.y(p.v as number);
    marker.style.display = "";
    marker.querySelector("line")!.setAttribute("x1", String(Math.round(x) + 0.5));
    marker.querySelector("line")!.setAttribute("x2", String(Math.round(x) + 0.5));
    marker.querySelector("circle")!.setAttribute("cx", String(x));
    marker.querySelector("circle")!.setAttribute("cy", String(y));

    // The figure leads, what it is and when follow.
    this.tip.replaceChildren(el("strong", "", this.options.format(p.v as number)), el("span", "", this.options.label), el("time", "", clock(p.t * 1000, this.to - this.from <= 3600)));
    this.tip.hidden = false;
    const half = this.tip.offsetWidth / 2;
    this.tip.style.left = `${Math.min(this.width - half - 4, Math.max(half + 4, x))}px`;
    // Above the point, or under it where there is no room above.
    const above = y - this.tip.offsetHeight - 12;
    this.tip.style.top = `${above >= 0 ? above : y + 14}px`;
  }
}

/**
 * The small trend line of a headline figure: no axes, no readout, the last
 * reading marked. It stretches to the width it is given.
 */
export function sparkline(readings: Array<number | null>): HTMLElement {
  const wrap = el("div", "cp-spark");
  // A trend, not every reading: at most 40 points, each the average of its stretch.
  const size = Math.max(1, Math.ceil(readings.length / 40));
  const values: Array<number | null> = [];
  for (let i = 0; i < readings.length; i += size) {
    const stretch = readings.slice(i, i + size).filter((v): v is number => v !== null);
    values.push(stretch.length ? stretch.reduce((sum, v) => sum + v, 0) / stretch.length : null);
  }
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return wrap;
  const low = Math.min(...known);
  const high = Math.max(...known);
  const span = high - low || 1;
  // A flat line sits in the middle rather than on the floor.
  const y = (v: number) => (high === low ? 16 : 4 + (1 - (v - low) / span) * 24);
  const marks: Array<{ x: number; y: number }> = [];
  values.forEach((v, i) => {
    if (v !== null) marks.push({ x: (i / (values.length - 1)) * 100, y: y(v) });
  });
  const line = marks.map((m) => `${m.x.toFixed(2)} ${m.y.toFixed(2)}`).join("L");
  const first = marks[0];
  const last = marks[marks.length - 1];
  const picture = svg("svg", { viewBox: "0 0 100 32", preserveAspectRatio: "none", "aria-hidden": "true" });
  picture.appendChild(svg("path", { d: `M${line}L${last.x.toFixed(2)} 32L${first.x.toFixed(2)} 32Z`, class: "cp-spark-area" }));
  picture.appendChild(svg("path", { d: `M${line}`, class: "cp-spark-line", "vector-effect": "non-scaling-stroke" }));
  wrap.appendChild(picture);
  const end = el("span", "cp-spark-end");
  end.style.left = `${last.x}%`;
  end.style.top = `${(last.y / 32) * 100}%`;
  wrap.appendChild(end);
  return wrap;
}

export interface Bar { label: string; value: number; note?: string; onPick?: () => void }

/** One bar to a row, longest first as given, each with its figure at the tip. */
export function barList(bars: Bar[], unit: (value: number) => string): HTMLElement {
  const list = el("div", "cp-bars");
  const most = Math.max(1, ...bars.map((bar) => bar.value));
  const total = bars.reduce((sum, bar) => sum + bar.value, 0) || 1;
  for (const bar of bars) {
    const row = el(bar.onPick ? "button" : "div", "cp-bar-row");
    if (row instanceof HTMLButtonElement) {
      row.type = "button";
      row.addEventListener("click", () => bar.onPick?.());
    }
    row.title = `${bar.label}: ${unit(bar.value)}, ${Math.round((bar.value / total) * 100)}% of everyone online`;
    row.appendChild(el("span", "cp-bar-label", bar.label));
    const track = el("span", "cp-bar-track");
    const fill = el("span", "cp-bar-fill");
    // The stylesheet turns the share into a length that leaves room for the figure at the tip.
    fill.style.setProperty("--share", String(bar.value / most));
    track.appendChild(fill);
    track.appendChild(el("span", "cp-bar-value", num(bar.value)));
    row.appendChild(track);
    row.appendChild(el("span", "cp-bar-share", bar.note ?? `${Math.round((bar.value / total) * 100)}%`));
    list.appendChild(row);
  }
  return list;
}

/** Columns side by side for groups that have an order, each with its figure on the cap. */
export function columns(bars: Bar[], unit: (value: number) => string): HTMLElement {
  const chart = el("div", "cp-cols");
  const most = Math.max(1, ...bars.map((bar) => bar.value));
  for (const bar of bars) {
    const col = el("div", "cp-col");
    col.title = `${bar.label}: ${unit(bar.value)}`;
    const stack = el("div", "cp-col-stack");
    stack.appendChild(el("span", "cp-col-value", num(bar.value)));
    const fill = el("span", "cp-col-fill");
    fill.style.setProperty("--share", String(bar.value / most));
    if (!bar.value) fill.classList.add("cp-col-none");
    stack.appendChild(fill);
    col.appendChild(stack);
    col.appendChild(el("span", "cp-col-label", bar.label));
    chart.appendChild(col);
  }
  return chart;
}

/** One bar split into its parts, with a legend that names each part and gives its figure. */
export function shares(parts: Array<{ label: string; value: number }>, unit: (value: number) => string): HTMLElement {
  const wrap = el("div", "cp-shares");
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const bar = el("div", "cp-shares-bar");
  const legend = el("div", "cp-shares-legend");
  parts.forEach((part, i) => {
    const share = total ? Math.round((part.value / total) * 100) : 0;
    if (part.value > 0) {
      const piece = el("span", `cp-shares-piece cp-series-${i + 1}`);
      piece.style.flexGrow = String(part.value);
      piece.title = `${part.label}: ${unit(part.value)}, ${share}%`;
      bar.appendChild(piece);
    }
    const row = el("div", "cp-shares-row");
    row.appendChild(el("span", `cp-shares-key cp-series-${i + 1}`));
    row.appendChild(el("span", "cp-shares-label", part.label));
    row.appendChild(el("span", "cp-shares-value", num(part.value)));
    row.appendChild(el("span", "cp-shares-share", `${share}%`));
    legend.appendChild(row);
  });
  if (!total) bar.classList.add("cp-shares-none");
  wrap.append(bar, legend);
  return wrap;
}

/** How full something is against its limit. The colour of the fill says how close that is. */
export function meter(percent: number, label: string): HTMLElement {
  const wrap = el("div", "cp-meter");
  const level = percent >= 80 ? "danger" : percent >= 50 ? "warning" : "good";
  wrap.classList.add(`cp-meter-${level}`);
  wrap.setAttribute("role", "meter");
  wrap.setAttribute("aria-valuemin", "0");
  wrap.setAttribute("aria-valuemax", "100");
  wrap.setAttribute("aria-valuenow", String(Math.round(percent)));
  wrap.setAttribute("aria-label", label);
  const fill = el("span", "cp-meter-fill");
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  wrap.appendChild(fill);
  return wrap;
}
