import { serverTime, ambience, timeOverrideSlider, timeOverrideLabel, timeOverrideCheckbox, timelapseBtn } from "./ui.ts";

let timeOfDay: string | null = null;
let lastMinute: number | null = null;
let hasWeather: boolean = false;
let overrideHour: number | null = null;
let stormActive: boolean = false;

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

function updateAmbience() {
  const effective = getEffectiveTime();
  const effectiveHasTime = (overrideHour !== null && timeOverrideCheckbox.checked) || timeOfDay;

  if (!effectiveHasTime || !hasWeather) {
    ambience.style.backgroundColor = "transparent";
    ambience.style.opacity = "0";
    return;
  }

  if (stormActive) {
    ambience.style.backgroundColor = "#2a3045";
    ambience.style.opacity = "0.65";
    return;
  }

  const hour24 = effective.hours + effective.minutes / 60;

  function smoothstep(t: number) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  function lerpColor(color1: string, color2: string, t: number) {
    const c1 = parseInt(color1.slice(1), 16);
    const c2 = parseInt(color2.slice(1), 16);
    const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff;
    const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff;
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `rgb(${r},${g},${b})`;
  }

  const phases = [
    { hour: 0,   color: "#0b0033", opacity: 0.6 },
    { hour: 4,   color: "#0b1a40", opacity: 0.55 },
    { hour: 5,   color: "#2a1a5e", opacity: 0.45 },
    { hour: 6,   color: "#ff9966", opacity: 0.3 },
    { hour: 7,   color: "#add8e6", opacity: 0.1 },
    { hour: 12,  color: "#87ceeb", opacity: 0.05 },
    { hour: 18,  color: "#87ceeb", opacity: 0.05 },
    { hour: 19,  color: "#ff6347", opacity: 0.25 },
    { hour: 20,  color: "#191970", opacity: 0.5 },
    { hour: 24,  color: "#0b0033", opacity: 0.6 }
  ];

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

  const blendedColor = lerpColor(phase1.color, phase2.color, easedT);
  const blendedOpacity = phase1.opacity + (phase2.opacity - phase1.opacity) * easedT;

  ambience.style.backgroundColor = blendedColor;
  ambience.style.opacity = blendedOpacity.toFixed(2);
}

function setHasWeather(weather: boolean) {
  hasWeather = weather;
  updateAmbience();
}

function setStormAmbience(active: boolean) {
  stormActive = active;
  updateAmbience();
}

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

export { updateTime, getServerTime, getEffectiveTime, setHasWeather, setStormAmbience };