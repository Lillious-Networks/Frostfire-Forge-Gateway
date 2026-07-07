import { weatherCanvas, weatherCtx } from "./ui.ts";
import {
  windBurst,
  calculateWindSpeed
} from "./windphysics.ts";

const isMobileDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
const buffer = 200;
let width: number = window.innerWidth + buffer * 2;
let height: number = (window.visualViewport?.height || window.innerHeight) + buffer * 2;

// Re-assigning canvas.width/height wipes the backing store and resets the 2D
// context. On iOS, visualViewport resize fires constantly (dynamic address bar,
// rubber-band scroll), so we guard against no-op resizes to avoid blanking the
// particle layer mid-animation, which shows up as flicker once WebKit stops
// promoting the canvas to its own compositing layer.
function resizeWeatherCanvas(): void {
  const rawDpr = window.devicePixelRatio || 1;
  const dpr = isMobileDevice ? Math.min(rawDpr, 2) : rawDpr;
  width = window.innerWidth + buffer * 2;
  height = (window.visualViewport?.height || window.innerHeight) + buffer * 2;

  const targetWidth = Math.round(width * dpr);
  const targetHeight = Math.round(height * dpr);

  if (weatherCanvas.width === targetWidth && weatherCanvas.height === targetHeight) {
    return;
  }

  weatherCanvas.width = targetWidth;
  weatherCanvas.height = targetHeight;
  weatherCanvas.style.width = width + "px";
  weatherCanvas.style.height = height + "px";

  if (weatherCtx) {
    weatherCtx.setTransform(1, 0, 0, 1, 0, 0);
    weatherCtx.scale(dpr, dpr);
  }
}

resizeWeatherCanvas();

window.addEventListener("resize", resizeWeatherCanvas);
window.visualViewport?.addEventListener("resize", resizeWeatherCanvas);

let cameraOffsetX = 0;
let cameraOffsetY = 0;

let lastFrameTime = performance.now();
const TARGET_FPS = 60;
const FRAME_TIME = 1000 / TARGET_FPS;

class SplashParticle {
  worldX = 0;
  worldY = 0;
  alpha = 0;
  radius = 0;
  maxRadius = 0;
  growthRate = 0;
  active = false;

  init(x: number, y: number, depthFactor: number = 1) {

    this.worldX = x + cameraOffsetX;
    this.worldY = y + cameraOffsetY;
    this.alpha = 0.8;
    this.radius = 1;

    this.maxRadius = (3 + Math.random() * 3) * depthFactor;
    this.growthRate = 0.5 * depthFactor;
    this.active = true;
  }

  update(deltaTime: number) {
    if (!this.active) return;
    this.alpha -= 0.05 * deltaTime;
    this.radius += this.growthRate * deltaTime;
    if (this.alpha <= 0 || this.radius >= this.maxRadius * 2) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;

    const screenX = this.worldX - cameraOffsetX;
    const screenY = this.worldY - cameraOffsetY;

    if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) return;

    ctx.strokeStyle = `rgba(200,230,255,${this.alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(screenX, screenY, this.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

class RainParticle {
  x = 0;
  y = 0;
  speed = 0;
  length = 0;
  tilt = 0;
  opacity = 0;
  trail: Array<{ x: number; y: number; alpha: number }> = [];
  splashHeight = 0;

  constructor(spawnY?: number) {
    this.reset(spawnY);
  }

  reset(spawnY?: number) {
    this.x = Math.random() * width;
    this.y = spawnY ?? Math.random() * height;
    this.speed = 30 + Math.random() * 20;

    const baseLength = 2;
    this.length = baseLength;
    this.tilt = -0.5 + Math.random();
    this.opacity = 0.8 + Math.random() * 0.2;
    this.trail = [];

    this.splashHeight = height * (0.4 + Math.random() * 0.6);
  }

  update(deltaTime: number, windSpeed: number = 0, windDirection: string | null = null) {
    this.y += this.speed * deltaTime;

    // Apply wind force to horizontal movement
    let windTilt = this.tilt;
    if (windDirection && (windDirection === 'left' || windDirection === 'right')) {
      const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
      windTilt = Math.cos(windDirectionRad) * windSpeed * 0.5;
    }

    this.x += windTilt * deltaTime;

    this.trail.push({ x: this.x, y: this.y, alpha: this.opacity });
    if (this.trail.length > this.length) this.trail.shift();

    if (this.y >= this.splashHeight && this.trail.length > 0) {
      const splash = splashPool.find(s => !s.active);
      if (splash) {

        const depthFactor = this.splashHeight / height;
        splash.init(this.x, this.splashHeight, depthFactor);
      }

      this.reset(0);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (this.trail.length < 2) return;

    ctx.strokeStyle = `rgba(200,230,255,${this.opacity})`;
    ctx.lineWidth = 1;
    ctx.lineCap = "round";

    ctx.beginPath();
    const first = this.trail[0];
    ctx.moveTo(first.x, first.y);
    for (const point of this.trail) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }
}

class SnowParticle {
  x = 0;
  y = 0;
  speed = 0;
  size = 0;
  opacity = 0;
  windSpeed = 0;
  turbulence = 0;
  rotation = 0;
  rotationSpeed = 0;
  time = 0;
  depth = 0;
  meltHeight = 0;

  constructor(spawnY?: number) {
    this.reset(spawnY);
  }

  reset(spawnY?: number) {
    this.x = Math.random() * width;
    this.y = spawnY ?? Math.random() * height;

    this.depth = Math.random();
    const depthFactor = 0.3 + this.depth * 0.7;

    this.speed = (4 + Math.random() * 8) * depthFactor;
    this.size = (1 + Math.random() * 1.5) * depthFactor;
    this.opacity = (0.85 + Math.random() * 0.15);

    this.windSpeed = (3 + Math.random() * 5) * depthFactor;
    this.turbulence = Math.random() * 2;

    this.rotation = Math.random() * Math.PI * 2;
    this.rotationSpeed = (Math.random() - 0.5) * 0.1 * depthFactor;
    this.time = Math.random() * 100;

    this.meltHeight = height * (0.4 + Math.random() * 0.6);
  }

  update(deltaTime: number, windSpeed: number = 0, windDirection: string | null = null) {

    this.y += this.speed * deltaTime;

    // Use provided wind speed if available, otherwise use the particle's internal wind speed
    const effectiveWindSpeed = windSpeed || this.windSpeed;

    // Apply wind force to horizontal movement
    let windTilt: number;
    if (windDirection && (windDirection === 'left' || windDirection === 'right')) {
      const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
      windTilt = Math.cos(windDirectionRad) * effectiveWindSpeed * 0.5;
    } else {
      // Use default wind behavior when no specific direction
      windTilt = effectiveWindSpeed * deltaTime;
    }

    this.x += windTilt * deltaTime;

    this.time += 0.02 * deltaTime;
    this.x += Math.sin(this.time * this.turbulence) * 0.8 * deltaTime;
    this.y += Math.cos(this.time * this.turbulence * 0.7) * 0.3 * deltaTime;

    this.rotation += this.rotationSpeed * deltaTime;

    if (this.y >= this.meltHeight) {
      const melt = meltPool.find(m => !m.active);
      if (melt) {
        melt.init(this.x, this.meltHeight, this.size);
      }

      this.reset(-20);
    }

    if (this.x > width + 50 || this.x < -50) {
      this.reset(-20);
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(0, 0, this.size, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.arc(0, 0, this.size * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

const rainParticles: RainParticle[] = [];
const rainCount = isMobileDevice ? 25 : 100;
for (let i = 0; i < rainCount; i++) {
  rainParticles.push(new RainParticle(Math.random() * height));
}

class MeltParticle {
  worldX = 0;
  worldY = 0;
  alpha = 0;
  size = 0;
  active = false;

  init(x: number, y: number, snowSize: number) {
    this.worldX = x + cameraOffsetX;
    this.worldY = y + cameraOffsetY;
    this.alpha = 0.6;
    this.size = snowSize * 1.5;
    this.active = true;
  }

  update(deltaTime: number) {
    if (!this.active) return;
    this.alpha -= 0.025 * deltaTime;
    this.size += 0.15 * deltaTime;
    if (this.alpha <= 0) this.active = false;
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.active) return;

    const screenX = this.worldX - cameraOffsetX;
    const screenY = this.worldY - cameraOffsetY;

    if (screenX < -50 || screenX > width + 50 || screenY < -50 || screenY > height + 50) return;

    ctx.fillStyle = `rgba(210,230,250,${this.alpha * 0.4})`;
    ctx.beginPath();
    ctx.arc(screenX, screenY, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

const snowParticles: SnowParticle[] = [];
const snowCount = isMobileDevice ? 80 : 400;
for (let i = 0; i < snowCount; i++) {
  snowParticles.push(new SnowParticle(Math.random() * height));
}

const meltPoolSize = isMobileDevice ? 25 : 100;
const meltPool: MeltParticle[] = [];
for (let i = 0; i < meltPoolSize; i++) {
  meltPool.push(new MeltParticle());
}

const splashPoolSize = isMobileDevice ? 25 : 100;
const splashPool: SplashParticle[] = [];
for (let i = 0; i < splashPoolSize; i++) {
  splashPool.push(new SplashParticle());
}

let lightningOverlay: HTMLDivElement | null = null;
let lightningFlashIntensity = 0;
let lightningTriggered = false;
let lightningFlickerCount = 0;

interface LightningBolt {
  worldX: number;
  worldY: number;
  alpha: number;
  age: number;
  segments: Array<{ x: number; y: number }>;
}

const activeBolts: LightningBolt[] = [];

function ensureLightningOverlay() {
  if (!lightningOverlay) {
    lightningOverlay = document.createElement('div');
    lightningOverlay.id = 'lightning-flash';
    lightningOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#aaccff;z-index:51;pointer-events:none;opacity:0;';
    document.body.appendChild(lightningOverlay);
  }
}

function triggerLightning() {
  ensureLightningOverlay();
  lightningFlashIntensity = 1;
  lightningTriggered = true;
  lightningFlickerCount = 0;
}

function updateLightning(deltaTime: number) {
  if (lightningFlashIntensity > 0) {
    lightningFlashIntensity -= deltaTime * 0.08;
    if (lightningFlashIntensity < 0) lightningFlashIntensity = 0;

    if (lightningFlashIntensity < 0.3 && lightningFlickerCount < 2) {
      lightningFlashIntensity = 1;
      lightningFlickerCount++;
    }

    if (lightningOverlay) {
      lightningOverlay.style.opacity = (lightningFlashIntensity * 0.15).toFixed(3);
    }
  }

  if (lightningTriggered && lightningFlashIntensity <= 0.01) {
    lightningFlashIntensity = 0;
    lightningTriggered = false;
    if (lightningOverlay) {
      lightningOverlay.style.opacity = '0';
    }
  }

  for (let i = activeBolts.length - 1; i >= 0; i--) {
    const bolt = activeBolts[i];
    bolt.age += deltaTime;
    bolt.alpha -= deltaTime * 0.06;
    if (bolt.alpha <= 0) {
      activeBolts.splice(i, 1);
    }
  }
}

function generateBoltSegments(x: number, y: number): Array<{ x: number; y: number }> {
  const segments: Array<{ x: number; y: number }> = [];
  const boltLength = 250 + Math.random() * 200;
  const numSegments = 8 + Math.floor(Math.random() * 6);
  const stepY = boltLength / numSegments;

  let cx = x;
  let cy = y - boltLength;
  segments.push({ x: cx, y: cy });

  for (let i = 1; i < numSegments; i++) {
    cx += (Math.random() - 0.5) * 60;
    cy += stepY;
    segments.push({ x: cx, y: cy });
  }

  segments.push({ x: cx + (Math.random() - 0.5) * 20, y: y });
  return segments;
}

function addLightningStrike(worldX: number, worldY: number) {
  triggerLightning();
  activeBolts.push({
    worldX,
    worldY,
    alpha: 1,
    age: 0,
    segments: generateBoltSegments(worldX, worldY),
  });
}

function drawBolts() {
  if (activeBolts.length === 0 || !weatherCtx) return;

  for (const bolt of activeBolts) {
    const STRIKE_DURATION = 0.2;
    const progress = Math.min(bolt.age / STRIKE_DURATION, 1);
    const easedProgress = 1 - Math.pow(1 - progress, 3);

    const maxIdx = bolt.segments.length - 1;
    const visibleIdx = easedProgress * maxIdx;
    const floorIdx = Math.floor(visibleIdx);
    const frac = visibleIdx - floorIdx;

    const ctx = weatherCtx;
    ctx.save();
    ctx.globalAlpha = bolt.alpha;

    ctx.strokeStyle = '#aaccff';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(bolt.segments[0].x - cameraOffsetX, bolt.segments[0].y - cameraOffsetY);
    for (let i = 1; i <= floorIdx; i++) {
      ctx.lineTo(bolt.segments[i].x - cameraOffsetX, bolt.segments[i].y - cameraOffsetY);
    }
    if (frac > 0 && floorIdx < maxIdx) {
      const seg = bolt.segments[floorIdx];
      const next = bolt.segments[floorIdx + 1];
      ctx.lineTo(
        (seg.x + (next.x - seg.x) * frac) - cameraOffsetX,
        (seg.y + (next.y - seg.y) * frac) - cameraOffsetY
      );
    }
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(bolt.segments[0].x - cameraOffsetX, bolt.segments[0].y - cameraOffsetY);
    for (let i = 1; i <= floorIdx; i++) {
      ctx.lineTo(bolt.segments[i].x - cameraOffsetX, bolt.segments[i].y - cameraOffsetY);
    }
    if (frac > 0 && floorIdx < maxIdx) {
      const seg = bolt.segments[floorIdx];
      const next = bolt.segments[floorIdx + 1];
      ctx.lineTo(
        (seg.x + (next.x - seg.x) * frac) - cameraOffsetX,
        (seg.y + (next.y - seg.y) * frac) - cameraOffsetY
      );
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

function weather(type: string, weatherData?: any): void {
  if (!weatherCtx) return;

  const currentTime = performance.now();
  const deltaMs = currentTime - lastFrameTime;
  lastFrameTime = currentTime;

  const deltaTime = deltaMs / FRAME_TIME;

  windBurst.update(deltaMs);

  const baseWindSpeed = weatherData?.wind_speed || 0;
  const windSpeed = calculateWindSpeed(baseWindSpeed, windBurst.getIntensity());
  const windDirection = weatherData?.wind_direction || null;

  weatherCtx.clearRect(0, 0, width, height);

  updateLightning(deltaTime);

  if (type === "rainy" || type === "thunderstorm") {

    for (const p of rainParticles) {
      p.update(deltaTime, windSpeed, windDirection);
      p.draw(weatherCtx);
    }

    for (const s of splashPool) {
      s.update(deltaTime);
      s.draw(weatherCtx);
    }

    if (type === "thunderstorm") {
      drawBolts();
    }
  } else if (type === "snowy") {

    for (const p of snowParticles) {
      p.update(deltaTime, windSpeed, windDirection);
      p.draw(weatherCtx);
    }

    for (const m of meltPool) {
      m.update(deltaTime);
      m.draw(weatherCtx);
    }
  }
}

function updateWeatherCanvas(cameraX: number, cameraY: number): void {

  const halfViewportWidth = (window.innerWidth / 2);
  const halfViewportHeight = ((window.visualViewport?.height || window.innerHeight) / 2);

  cameraOffsetX = cameraX - halfViewportWidth - buffer;
  cameraOffsetY = cameraY - halfViewportHeight - buffer;
}

export { weather, updateWeatherCanvas, addLightningStrike };
