import { serverTime, ambience, ambienceCool, sunFlare, timeOverrideSlider, timeOverrideLabel, timeOverrideCheckbox, timelapseBtn } from "./ui.ts";

let timeOfDay: string | null = null;
let lastMinute: number | null = null;
let hasWeather: boolean = false;
let overrideHour: number | null = null;
let stormActive: boolean = false;

// 0 = full daylight, 1 = full night. Drives the additive light map so glowing
// particles actually emit light once the ambience overlay darkens the scene.
let nightFactor: number = 0;
function getNightFactor(): number { return nightFactor; }

timeOverrideSlider.addEventListener("input", () => {
  overrideHour = parseFloat(timeOverrideSlider.value);
  const h = Math.floor(overrideHour);
  const m = Math.floor((overrideHour - h) * 60 + 0.5);
  timeOverrideLabel.textContent = `${h}:${m.toString().padStart(2, "0")}`;
  updateAmbience();
});

timeOverrideCheckbox.addEventListener("change", () => {
  updateAmbience();
});

// Get effective time-of-day — slider overrides server time if touched
function getEffectiveTime(): { hours: number; minutes: number } {
  if (overrideHour !== null && timeOverrideCheckbox.checked) {
    const h = Math.floor(overrideHour);
    const m = Math.floor((overrideHour - h) * 60 + 0.5);
    return { hours: h, minutes: m };
  }
  return getServerTime();
}

function getServerTime(): { hours: number; minutes: number } {
  if (!timeOfDay) {
    return { hours: 0, minutes: 0 };
  }

  const date = new Date(timeOfDay);
  if (isNaN(date.getTime())) {
    return { hours: 0, minutes: 0 };
  }

  return {
    hours: date.getHours(),
    minutes: date.getMinutes()
  };
}

function updateTime(time: string) {
  if (!time) return;

  timeOfDay = time;
  const date = new Date(timeOfDay);
  if (isNaN(date.getTime())) return;

  const hours = date.getHours() % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  serverTime.innerText = `${hours}:${minutes}:${seconds} ${
    date.getHours() < 12 ? "AM" : "PM"
  }`;

  if (lastMinute === null || date.getMinutes() !== lastMinute) {
    updateAmbience();
    lastMinute = date.getMinutes();
  }
}

function smoothstep(t: number) {
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function parseHex(color: string) {
  const c = parseInt(color.slice(1), 16);
  return { r: (c >> 16) & 0xff, g: (c >> 8) & 0xff, b: c & 0xff };
}

function lerpColor(color1: string, color2: string, t: number) {
  const a = parseHex(color1);
  const b = parseHex(color2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// Time-of-day keyframes. Each phase defines:
//  top/bottom  -> vertical sky gradient colors (multiplied over the scene)
//  opacity     -> strength of the darkening multiply layer
//  warm        -> additive dawn/dusk glow color (screen blend)
//  warmOpacity -> strength of the warm glow layer
const phases = [
  { hour: 0,  top: "#2a1a5e", bottom: "#2a1a50", opacity: 0.68, warm: "#000000", warmOpacity: 0 },
  { hour: 4,  top: "#2c2068", bottom: "#2a1e5c", opacity: 0.62, warm: "#000000", warmOpacity: 0 },
  { hour: 5,  top: "#3a2f7a", bottom: "#4e3d8a", opacity: 0.5,  warm: "#3a2140", warmOpacity: 0.12 },
  { hour: 6,  top: "#6b5a8f", bottom: "#ffab73", opacity: 0.3,  warm: "#ff8340", warmOpacity: 0.32 },
  { hour: 7,  top: "#bcd6e8", bottom: "#ffe0c0", opacity: 0.12, warm: "#ffcaa0", warmOpacity: 0.18 },
  { hour: 12, top: "#dff0ff", bottom: "#eaf6ff", opacity: 0.05, warm: "#ffffff", warmOpacity: 0.05 },
  { hour: 18, top: "#dff0ff", bottom: "#ffe8cf", opacity: 0.08, warm: "#ffcf9a", warmOpacity: 0.14 },
  { hour: 19, top: "#8a6a8f", bottom: "#ff7a4d", opacity: 0.28, warm: "#ff6a30", warmOpacity: 0.34 },
  { hour: 20, top: "#32266e", bottom: "#2e2266", opacity: 0.52, warm: "#2a1838", warmOpacity: 0.1 },
  { hour: 24, top: "#2a1a5e", bottom: "#2a1a50", opacity: 0.68, warm: "#000000", warmOpacity: 0 },
];

// Daytime window used to fade the sun flare in/out around dawn and dusk.
function dayWindow(hour24: number): number {
  const fadeInStart = 5, fadeInEnd = 7;
  const fadeOutStart = 17, fadeOutEnd = 19;
  if (hour24 < fadeInStart || hour24 > fadeOutEnd) return 0;
  if (hour24 < fadeInEnd) return smoothstep((hour24 - fadeInStart) / (fadeInEnd - fadeInStart));
  if (hour24 > fadeOutStart) return 1 - smoothstep((hour24 - fadeOutStart) / (fadeOutEnd - fadeOutStart));
  return 1;
}

function hideSunFlare() {
  sunFlare.style.opacity = "0";
}

// Soft directional god rays from an always off-screen sun.
function updateSunFlare(hour24: number, stormy: boolean) {
  const vis = dayWindow(hour24);
  if (stormy || vis < 0.01) {
    hideSunFlare();
    return;
  }

  const W = window.innerWidth;
  const H = window.innerHeight;

  // Sun travels dawn (left) -> dusk (right), kept well outside the viewport.
  const dayT = Math.min(1, Math.max(0, (hour24 - 5) / 14));
  const sunX = (-0.35 + 1.7 * dayT) * W;

  // Higher (further above the top edge) near noon, lower near the horizon.
  const elevation = Math.sin(dayT * Math.PI); // 0..1..0
  const sunY = -(0.15 + 0.55 * elevation) * H;

  // Ray travel direction: from the sun toward the visible scene.
  const cx = W / 2;
  const cy = H / 2;
  const angleDeg = Math.atan2(cx - sunX, -(cy - sunY)) * 180 / Math.PI;

  // Warmer near the horizon, paler near noon.
  const horizonness = 1 - elevation;
  const rayColor = lerpColor("#fff3d2", "#ffb877", horizonness);
  const rayOpacity = (0.16 + horizonness * 0.24) * vis;

  sunFlare.style.opacity = "1";
  sunFlare.style.setProperty("--sun-x", `${sunX.toFixed(0)}px`);
  sunFlare.style.setProperty("--sun-y", `${sunY.toFixed(0)}px`);
  sunFlare.style.setProperty("--rays-angle", `${angleDeg.toFixed(1)}deg`);
  sunFlare.style.setProperty("--rays-color", rayColor);
  sunFlare.style.setProperty("--rays-opacity", rayOpacity.toFixed(3));
}

function updateAmbience() {
  const effective = getEffectiveTime();
  const effectiveHasTime = (overrideHour !== null && timeOverrideCheckbox.checked) || timeOfDay;

  if (!effectiveHasTime || !hasWeather) {
    ambience.style.opacity = "0";
    ambience.style.setProperty("--ambience-warm-opacity", "0");
    ambienceCool.style.opacity = "0";
    hideSunFlare();
    nightFactor = 0;
    return;
  }

  if (stormActive) {
    ambience.style.background = "#2a3045";
    ambience.style.opacity = "0.65";
    ambience.style.setProperty("--ambience-warm-opacity", "0");
    ambienceCool.style.opacity = "0";
    hideSunFlare();
    nightFactor = 0.5;
    return;
  }

  const hour24 = effective.hours + effective.minutes / 60;

  let phase1, phase2;
  for (let i = 0; i < phases.length - 1; i++) {
    if (hour24 >= phases[i].hour && hour24 <= phases[i + 1].hour) {
      phase1 = phases[i];
      phase2 = phases[i + 1];
      break;
    }
  }
  if (!phase1 || !phase2) return;

  const t = (hour24 - phase1.hour) / (phase2.hour - phase1.hour);
  const easedT = smoothstep(t);

  const top = lerpColor(phase1.top, phase2.top, easedT);
  const bottom = lerpColor(phase1.bottom, phase2.bottom, easedT);
  const warm = lerpColor(phase1.warm, phase2.warm, easedT);
  const warmOpacity = phase1.warmOpacity + (phase2.warmOpacity - phase1.warmOpacity) * easedT;

  // Tie the darkening strength exactly to the shadow fade window: brightest when
  // shadows are fully present (day), darkest when they are gone (night). dayWindow
  // here mirrors shadows.ts smoothWindow, so the two transition in lockstep.
  const DAY_OPACITY = 0.05;
  const NIGHT_OPACITY = 0.66;
  const day = dayWindow(hour24);
  const opacity = NIGHT_OPACITY + (DAY_OPACITY - NIGHT_OPACITY) * day;
  nightFactor = 1 - day;

  ambience.style.background = `linear-gradient(to bottom, ${top} 0%, ${bottom} 100%)`;
  ambience.style.opacity = opacity.toFixed(2);
  ambience.style.setProperty("--ambience-warm", `linear-gradient(to bottom, ${warm} 0%, transparent 70%)`);
  ambience.style.setProperty("--ambience-warm-opacity", warmOpacity.toFixed(2));

  // Additive cool moonlight tint at night so the blue actually shows instead of
  // reading as flat black (the multiply base layer can only darken).
  const coolOpacity = nightFactor * 0.15;
  ambienceCool.style.background = "radial-gradient(ellipse 120% 100% at 50% 40%, #2a2ab0 0%, #3a2088 100%)";
  ambienceCool.style.opacity = coolOpacity.toFixed(2);

  updateSunFlare(hour24, false);
}

function setHasWeather(weather: boolean) {
  hasWeather = weather;
  updateAmbience();
}

function setStormAmbience(active: boolean) {
  stormActive = active;
  updateAmbience();
}

window.addEventListener("resize", () => updateAmbience());

let timelapseRaf: number | null = null;
let timelapseLastTick = 0;
let timelapseTime = 0; // continuous hour value, avoids slider stepping

function startTimelapse() {
  if (timelapseRaf) return;

  timeOverrideCheckbox.checked = true;
  document.body.classList.add("timelapse-active");

  document.querySelectorAll(".ui").forEach((el) => {
    if (el.id !== "ambience-overlay") {
      el.classList.add("ui-hidden-in-timelapse");
    }
  });

  timelapseBtn.textContent = "Timelapse (ESC to stop)";
  timelapseLastTick = performance.now();
  timelapseTime = parseFloat(timeOverrideSlider.value);

  function tick(now: number) {
    const dt = now - timelapseLastTick;
    timelapseLastTick = now;
    // 50 in-game minutes per real second
    timelapseTime += (50 / 60) * (dt / 1000);
    if (timelapseTime >= 24) timelapseTime -= 24;

    overrideHour = timelapseTime;
    timeOverrideSlider.value = timelapseTime.toFixed(4);
    const h = Math.floor(timelapseTime);
    const m = Math.floor((timelapseTime - h) * 60 + 0.5);
    timeOverrideLabel.textContent = `${h}:${m.toString().padStart(2, "0")}`;
    updateAmbience();
    timelapseRaf = requestAnimationFrame(tick);
  }

  timelapseRaf = requestAnimationFrame(tick);
}

function stopTimelapse() {
  if (!timelapseRaf) return;
  cancelAnimationFrame(timelapseRaf);
  timelapseRaf = null;
  document.body.classList.remove("timelapse-active");
  document.querySelectorAll(".ui-hidden-in-timelapse").forEach((el) => {
    el.classList.remove("ui-hidden-in-timelapse");
  });
  timelapseBtn.textContent = "Timelapse";
}

timelapseBtn.addEventListener("click", () => {
  if (timelapseRaf) {
    stopTimelapse();
  } else {
    startTimelapse();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && timelapseRaf) {
    stopTimelapse();
  }
});

export { updateTime, getServerTime, getEffectiveTime, setHasWeather, setStormAmbience, getNightFactor };