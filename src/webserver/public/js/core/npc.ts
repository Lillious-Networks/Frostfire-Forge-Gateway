import { getLines } from "./chat.js";
import { npcImage, createCachedImage } from "./images.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { getIsLoaded } from "./socket.js";
import { initializeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";
import { getServerTime } from "./ambience.js";
import {
  windBurst,
  calculateWindSpeed,
  applyWindVelocity,
  getWindBias,
} from "./windphysics.ts";

// Particle object pool to avoid GC pressure
class ParticlePool {
  private pool: any[] = [];
  private poolSize = 2000;

  constructor() {
    // Pre-allocate particles
    for (let i = 0; i < this.poolSize; i++) {
      this.pool.push({
        currentLife: 0,
        lifetime: 0,
        size: 0,
        color: 'white',
        opacity: 1,
        visible: true,
        velocity: { x: 0, y: 0 },
        gravity: { x: 0, y: 0 },
        localposition: { x: 0, y: 0 },
        weather: 'none',
        zIndex: 0
      });
    }
  }

  acquire(): any {
    return this.pool.length > 0 ? this.pool.pop() : this.createNew();
  }

  release(particle: any): void {
    if (this.pool.length < this.poolSize) {
      this.pool.push(particle);
    }
  }

  private createNew(): any {
    return {
      currentLife: 0,
      lifetime: 0,
      size: 0,
      color: 'white',
      opacity: 1,
      visible: true,
      velocity: { x: 0, y: 0 },
      gravity: { x: 0, y: 0 },
      localposition: { x: 0, y: 0 },
      weather: 'none',
      zIndex: 0
    };
  }
}

const particlePool = new ParticlePool();

// Cache of pre-rendered particle sprites keyed by color|size|glow. Baking the
// radial gradient (and any glow) once and reusing it via drawImage avoids the
// costly per-frame createRadialGradient / shadowBlur work that tanks FPS on iOS.
const particleSpriteCache = new Map<string, { canvas: HTMLCanvasElement; half: number }>();

function getParticleSprite(color: string, radius: number, glowIntensity: number): { canvas: HTMLCanvasElement; half: number } {
  const key = `${color}|${radius}|${glowIntensity}`;
  const cached = particleSpriteCache.get(key);
  if (cached) return cached;

  // Bake at a fixed 1x scale on every device. shadowBlur and additive clamping
  // are resolution-dependent, so baking at the device dpr made iOS (2x) glow at a
  // different brightness than PC (1x). A constant scale keeps the rasterization —
  // and thus brightness — identical everywhere (matching the 1x PC/editor look).
  const scale = 1;

  let baseBlur = 0;
  let glowLayers = 0;
  let glowOpacity = 0;
  let pad = 0;
  if (glowIntensity > 0) {
    baseBlur = Math.max(4, radius * 0.8);
    glowLayers = Math.ceil(glowIntensity);
    glowOpacity = glowIntensity - Math.floor(glowIntensity);
    const maxBlur = baseBlur + (glowLayers - 1) * 8 * glowIntensity;
    // Canvas shadowBlur is a Gaussian (std-dev ~ blur/2) whose alpha is below
    // 1/255 (imperceptible) past ~1.66x the blur. Pad to 2x for a safety margin
    // while keeping the additive fill area as small as possible for FPS.
    pad = Math.ceil(maxBlur * 2) + 4;
  }

  const sizeCss = Math.ceil(2 * (radius + pad));
  const half = sizeCss / 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(sizeCss * scale));
  canvas.height = Math.max(1, Math.ceil(sizeCss * scale));
  const sctx = canvas.getContext("2d")!;
  sctx.scale(scale, scale);

  const gradient = sctx.createRadialGradient(half, half, 0, half, half, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, color + "00");

  // Accumulate exactly like the live draw so drawing the sprite with globalAlpha
  // reproduces the same additive result.
  sctx.globalCompositeOperation = "lighter";
  sctx.fillStyle = gradient;

  if (glowIntensity > 0) {
    sctx.shadowColor = color;
    sctx.shadowOffsetX = 0;
    sctx.shadowOffsetY = 0;

    for (let g = 0; g < glowLayers; g++) {
      sctx.shadowBlur = baseBlur + (g * 8 * glowIntensity);
      sctx.globalAlpha = Math.max(0.3, 1 - (g * 0.2));
      sctx.beginPath();
      sctx.arc(half, half, radius, 0, Math.PI * 2);
      sctx.fill();
    }

    if (glowOpacity > 0) {
      sctx.shadowBlur = baseBlur + ((glowLayers - 1) * 8 * glowIntensity);
      sctx.globalAlpha = glowOpacity * 0.5;
      sctx.beginPath();
      sctx.arc(half, half, radius, 0, Math.PI * 2);
      sctx.fill();
    }
  } else {
    sctx.globalAlpha = 1;
    sctx.beginPath();
    sctx.arc(half, half, radius, 0, Math.PI * 2);
    sctx.fill();
  }

  const sprite = { canvas, half };
  particleSpriteCache.set(key, sprite);
  return sprite;
}

async function reinitNpcSprite(npc: any) {
  npc.layeredAnimation = null;
  npc.staticImage = null;
  try {
    const layers = npc.spriteLayers;
    if (npc.sprite_type === 'animated' && layers) {
      npc.layeredAnimation = await initializeLayeredAnimation(
        null,
        layers.body || null,
        layers.head || null,
        layers.helmet || null,
        layers.shoulderguards || null,
        layers.neck || null,
        layers.hands || null,
        layers.chest || null,
        layers.feet || null,
        layers.legs || null,
        layers.weapon || null,
        `idle_${npc.direction || 'down'}`
      );
    } else if (npc.sprite_type === 'static' && layers?.body?.imageUrl) {
      npc.staticImage = await createCachedImage(layers.body.imageUrl);
    }
  } catch (e) {
    console.error("Error loading NPC sprite:", e);
  }
}

function createNPC(data: any) {
  const npc: NPC = {
    id: data.id,
    name: data.name || "",
    dialog: data.dialog || "",
    hidden: data?.hidden ?? false,
    direction: data.location?.direction || "down",
    sprite_type: data.sprite_type || 'none',
    spriteLayers: data.spriteLayers || null,
    layeredAnimation: null,
    staticImage: null,
    position: {
      x: data.location.x,
      y: data.location.y,
    },
    particles: data.particles || [],
    quest: data.quest || null,
    dialogue: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (this.dialog) {
        if (this.dialog.trim() !== "") {
          context.fillStyle = "black";
          context.fillStyle = "white";
          context.font = "14px 'Comic Relief'";
          context.textAlign = "center";

          const lines = getLines(context, this.dialog, 500).reverse();
          let startingPosition = this.position.y - 12;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 15;
            const offsetX = (this as any).layeredAnimation ? 0 : 16;
          context.fillText(lines[i], this.position.x + offsetX, startingPosition);
          }
        }
      }
    },
    show: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (!context || this.hidden) return;
      context.globalAlpha = 1;

      if (this.layeredAnimation) {
        const layers = getVisibleLayersSorted(this.layeredAnimation);
        context.save();
        context.imageSmoothingEnabled = false;
        for (const layer of layers) {
          if (!layer.frames.length) continue;
          const frame = layer.frames[layer.currentFrame];
          if (!frame?.imageElement?.complete || !frame.imageElement.naturalWidth) continue;
          const ox = frame.offset?.x || 0;
          const oy = frame.offset?.y || 0;
          context.drawImage(
            frame.imageElement,
            Math.round(this.position.x - frame.width / 2 + ox),
            Math.round(this.position.y - frame.height / 2 + oy),
            frame.width,
            frame.height
          );
        }
        context.restore();
      } else if ((this as any).staticImage?.complete && (this as any).staticImage.naturalWidth > 0) {
        const img = (this as any).staticImage as HTMLImageElement;
        context.drawImage(
          img,
          Math.round(this.position.x - img.width / 2),
          Math.round(this.position.y - img.height / 2)
        );
      } else {
        if (!npcImage) return;
        context.drawImage(npcImage, this.position.x, this.position.y, npcImage.width, npcImage.height);
      }

      if ((this as any).name?.trim()) {
        context.save();
        context.font = "14px 'Comic Relief'";
        context.textAlign = "center";
        context.shadowColor = "black";
        context.shadowBlur = 2;
        context.shadowOffsetX = 0;
        context.strokeStyle = "black";
        context.fillStyle = "gold";
        const offsetX = (this as any).layeredAnimation ? 0 : 16;
        const nameX = this.position.x + offsetX;
        const nameY = this.position.y + 44;
        context.strokeText((this as any).name, nameX, nameY);
        context.fillText((this as any).name, nameX, nameY);
        context.restore();
      }
    },
    updateParticle: async (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => {

      if (!npc.particleArrays) {
        npc.particleArrays = {};
        npc.lastEmitTime = {};
      }

      // Check if particle should be visible based on time (using server time)
      if ((particle as any).affected_by_time && (particle as any).time_on && (particle as any).time_off) {
        const serverTimeObj = getServerTime();
        const currentTimeMinutes = serverTimeObj.hours * 60 + serverTimeObj.minutes;

        const timeOnParts = ((particle as any).time_on as string).split(':');
        const timeOffParts = ((particle as any).time_off as string).split(':');
        const timeOnMinutes = parseInt(timeOnParts[0]) * 60 + parseInt(timeOnParts[1]);
        const timeOffMinutes = parseInt(timeOffParts[0]) * 60 + parseInt(timeOffParts[1]);

        // Check if particle is visible based on time window
        const isVisible = timeOnMinutes < timeOffMinutes
          ? currentTimeMinutes >= timeOnMinutes && currentTimeMinutes < timeOffMinutes
          : timeOnMinutes > timeOffMinutes
            ? currentTimeMinutes >= timeOnMinutes || currentTimeMinutes < timeOffMinutes
            : true;

        // Skip particle emission if not visible based on time window
        if (!isVisible) {
          return;
        }
      } else if (!particle.visible) {
        // If not affected by time, check the visible flag
        return;
      }

      const emitInterval = (particle.interval || 1) / 60 * 1000; // Frame-rate independent: convert 60 FPS frame interval to milliseconds

      // Match the particle editor preview: cap the per-frame delta at one 60 FPS
      // frame and drive emission from that same clock. iOS throttles
      // requestAnimationFrame, so the renderer lets deltaTime spike up to ~500ms.
      // If emission ran on wall-clock time while aging used the capped delta,
      // particles would spawn faster than they die and pile up (brighter overlap,
      // worse FPS). Sharing one clamped clock keeps spawn/death balanced.
      const clampedDelta = Math.min(deltaTime, 0.01667);

      if (npc.lastEmitTime[particle.name || ''] === undefined) {
        npc.lastEmitTime[particle.name || ''] = 0;
      }

      if (!npc.particleArrays[particle.name || '']) {
        npc.particleArrays[particle.name || ''] = [];
      }

      const particleArray = npc.particleArrays[particle.name || ''];
      npc.lastEmitTime[particle.name || ''] += clampedDelta * 1000;

      while (npc.lastEmitTime[particle.name || ''] >= emitInterval && particleArray.length < (particle.amount || 1)) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;
        const windDirection = typeof particle.weather === 'object' ? particle.weather.wind_direction : null;
        const windSpeed = typeof particle.weather === 'object' ? particle.weather.wind_speed || 0 : 0;

        const windBias = getWindBias(windSpeed, windDirection);

        // Reuse pooled particle object
        const newParticle = particlePool.acquire();
        newParticle.size = particle.size || 5;
        newParticle.color = particle.color || 'white';
        newParticle.opacity = particle.opacity || 1;
        newParticle.visible = true;
        newParticle.lifetime = baseLifetime + randomLifetimeExtension;
        newParticle.currentLife = baseLifetime + randomLifetimeExtension;
        newParticle.zIndex = particle.zIndex || 0;
        newParticle.gravity.x = particle.gravity.x;
        newParticle.gravity.y = particle.gravity.y;
        newParticle.weather = typeof particle.weather === 'object' ? { ...particle.weather } : 'none';
        newParticle.localposition.x = Number(particle.localposition?.x || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.x);
        newParticle.localposition.y = Number(particle.localposition?.y || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.y);
        newParticle.velocity.x = Number(particle.velocity.x || 0) + windBias.x;
        newParticle.velocity.y = Number(particle.velocity.y || 0) + windBias.y;

        particleArray.push(newParticle);
        npc.lastEmitTime[particle.name || ''] -= emitInterval;
      }

      const particles = npc.particleArrays[particle.name || ''];
      if (particles.length === 0) {
        context.globalAlpha = 1;
        return;
      }

      // Check if we should render particles based on time window (using server time)
      if ((particle as any).affected_by_time && (particle as any).time_on && (particle as any).time_off) {
        const serverTimeObj = getServerTime();
        const currentTimeMinutes = serverTimeObj.hours * 60 + serverTimeObj.minutes;

        const timeOnParts = ((particle as any).time_on as string).split(':');
        const timeOffParts = ((particle as any).time_off as string).split(':');
        const timeOnMinutes = parseInt(timeOnParts[0]) * 60 + parseInt(timeOnParts[1]);
        const timeOffMinutes = parseInt(timeOffParts[0]) * 60 + parseInt(timeOffParts[1]);

        // Check if particle is visible based on time window
        const isVisible = timeOnMinutes < timeOffMinutes
          ? currentTimeMinutes >= timeOnMinutes && currentTimeMinutes < timeOffMinutes
          : timeOnMinutes > timeOffMinutes
            ? currentTimeMinutes >= timeOnMinutes || currentTimeMinutes < timeOffMinutes
            : true;

        // Don't render particles if outside time window
        if (!isVisible) {
          context.globalAlpha = 1;
          return;
        }
      }

      // Update wind burst cycle - creates pulsating wind effect
      const deltaTimeMs = clampedDelta * 1000; // Convert deltaTime back to ms
      windBurst.update(deltaTimeMs);

      const npcPosX = npc.position.x + 16;
      const npcPosY = npc.position.y + 24;

      // Only apply wind if particle is affected by weather
      let windSpeed = 0;
      let windDirection = null;
      if (particle.affected_by_weather) {
        const weatherData = typeof particle.weather === 'object' ? particle.weather : null;
        const baseWindSpeed = weatherData?.wind_speed || 0;
        windSpeed = calculateWindSpeed(baseWindSpeed, windBurst.getIntensity());
        windDirection = weatherData?.wind_direction || null;
      }

      const gravX = particle.gravity.x;
      const gravY = particle.gravity.y;

      // Velocity caps based on base particle velocity, wind can push beyond this
      const maxVelX = Math.abs(particle.velocity.x) || 1;
      const maxVelY = Math.abs(particle.velocity.y) || 1;
      const particleOpacity = particle.opacity;
      const particleColor = particle.color || "white";
      const glowIntensity = particle.glow_intensity || 0;

      // Set blend mode once for all particles. Use additive 'lighter' on every
      // platform so iOS matches desktop/editor brightness instead of rendering
      // ~2x dimmer with plain alpha compositing.
      context.globalCompositeOperation = 'lighter';
      // Clear any stray shadow state from earlier draws so it can't re-blur the sprite.
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;

      // The gradient + glow are identical for every particle of this config, so
      // look the sprite up once per frame instead of per particle.
      const particleSprite = getParticleSprite(particleColor, (particle.size || 5) / 2, glowIntensity);

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.currentLife -= clampedDelta * 1000;

        if (p.currentLife <= 0) {
          particles.splice(i, 1);
          particlePool.release(p);
          continue;
        }

        // Update physics - apply forces and velocity (match preview logic exactly)
        // Use capped delta on mobile to prevent physics explosions
        const physDelta = clampedDelta;

        // Apply gravity
        p.velocity.y += gravY * physDelta;
        p.velocity.x += gravX * physDelta;

        // Apply wind velocity clamping
        const newVelocity = applyWindVelocity(
          p.velocity.x,
          p.velocity.y,
          windSpeed,
          windDirection,
          maxVelX,
          maxVelY
        );
        p.velocity.x = newVelocity.vx;
        p.velocity.y = newVelocity.vy;

        // Always apply velocity to position
        p.localposition.x += p.velocity.x * physDelta;
        p.localposition.y += p.velocity.y * physDelta;

        // Calculate alpha (fade durations based on this particle's own lifetime
        // so staggertime extensions match the editor preview)
        const fadeInDur = p.lifetime * 0.4;
        const fadeOutDur = p.lifetime * 0.4;
        const lifeElapsed = p.lifetime - p.currentLife;
        let alpha;
        if (lifeElapsed < fadeInDur) {
          alpha = (lifeElapsed / fadeInDur) * particleOpacity;
        } else if (p.currentLife < fadeOutDur) {
          alpha = (p.currentLife / fadeOutDur) * particleOpacity;
        } else {
          alpha = particleOpacity;
        }

        context.globalAlpha = alpha;

        // Draw the pre-rendered sprite (gradient + glow baked once). globalAlpha
        // above applies the fade; additive 'lighter' blending is unchanged, so the
        // composited result matches the previous per-frame draw.
        const cx = npcPosX + p.localposition.x;
        const cy = npcPosY + p.localposition.y;
        context.drawImage(
          particleSprite.canvas,
          cx - particleSprite.half,
          cy - particleSprite.half,
          particleSprite.half * 2,
          particleSprite.half * 2
        );
      }

      // Reset blend mode
      context.globalCompositeOperation = 'source-over';

      context.globalAlpha = 1;
    }
  };

  cache.npcs.push(npc);

  reinitNpcSprite(npc);

  (async function () {
    try {
      getIsLoaded();
      new Function(
        "with(this) { " + decodeURIComponent(data.script) + " }"
      ).call(npc);
    } catch (e) {
      console.error("Error initializing NPC:", e);
    }
  }).call(npc);
}

function deleteNPC(npc: any) {
  // Remove from cache
  const idx = cache.npcs.findIndex((n: any) => n.id === npc.id);
  if (idx >= 0) {
    cache.npcs.splice(idx, 1);
  }
}

export { createNPC, reinitNpcSprite, particlePool, getParticleSprite, deleteNPC };