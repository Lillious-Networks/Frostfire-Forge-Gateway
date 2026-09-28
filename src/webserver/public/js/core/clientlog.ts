// Forwards console errors/warnings and uncaught errors to the webserver
// (POST /api/client-log), so problems on devices without devtools (phones)
// show up in the server log. Messages still print to the console as usual.
// The first batch also carries a one-line device/WebGL report.

type Level = "error" | "warn" | "info";

const ENDPOINT = "/api/client-log";
const FLUSH_INTERVAL_MS = 2000;
const MAX_QUEUE = 50;
const MAX_MESSAGE = 2000;

const queue: Array<{ level: Level; message: string }> = [];
let sentDeviceReport = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sending = false;

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deviceReport(): string {
  const parts = [
    `ua=${navigator.userAgent}`,
    `screen=${screen.width}x${screen.height}`,
    `dpr=${window.devicePixelRatio}`,
    `url=${location.pathname}`,
  ];
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) {
      parts.push(
        `webgl2 maxTexture=${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
        `maxArrayLayers=${gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)}`,
        `maxRenderbuffer=${gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)}`,
      );
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } else {
      parts.push("webgl2=unavailable");
    }
  } catch {
    parts.push("webgl2=error");
  }
  return `device: ${parts.join(" | ")}`;
}

function enqueue(level: Level, message: string): void {
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ level, message: message.slice(0, MAX_MESSAGE) });
  if (!flushTimer) flushTimer = setTimeout(() => void flush(false), FLUSH_INTERVAL_MS);
}

async function flush(unloading: boolean): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0 || (sending && !unloading)) return;
  if (!sentDeviceReport) {
    sentDeviceReport = true;
    queue.unshift({ level: "info", message: deviceReport() });
  }
  const body = JSON.stringify({ entries: queue.splice(0, queue.length) });

  // On page hide the page may be torn down; sendBeacon survives that.
  if (unloading && navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
    return;
  }
  sending = true;
  try {
    // Failures are dropped silently: logging them would feed back into here.
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => {});
  } finally {
    sending = false;
    if (queue.length > 0 && !flushTimer) flushTimer = setTimeout(() => void flush(false), FLUSH_INTERVAL_MS);
  }
}

function wrapConsole(level: "error" | "warn"): void {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      enqueue(level, args.map(describe).join(" "));
    } catch {
      // Never let forwarding break the caller.
    }
  };
}

wrapConsole("error");
wrapConsole("warn");

window.addEventListener("error", (event) => {
  const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
  enqueue("error", `uncaught: ${event.error ? describe(event.error) : event.message}${where}`);
});

window.addEventListener("unhandledrejection", (event) => {
  enqueue("error", `unhandled rejection: ${describe(event.reason)}`);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flush(true);
});
window.addEventListener("pagehide", () => void flush(true));

export {};
