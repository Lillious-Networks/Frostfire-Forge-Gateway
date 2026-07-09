import { npcImage, createCachedImage } from "./images.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { initializeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";
import { particlePool, getParticleSprite } from "./npc.js";
import { getWeatherType } from "./renderer.js";
import {
  windBurst,
  calculateWindSpeed,
  applyWindVelocity,
  getWindBias,
} from "./windphysics.ts";

// Normalize particle to ensure all required properties exist
function normalizeParticle(particle: any): any {
  return {
    name: particle.name || 'unknown',
    size: particle.size !== undefined ? particle.size : 5,
    color: particle.color || '#ffffff',
    velocity: particle.velocity || { x: 0, y: 0 },
    lifetime: particle.lifetime !== undefined ? particle.lifetime : 1000,
    scale: particle.scale !== undefined ? particle.scale : 1,
    opacity: particle.opacity !== undefined ? particle.opacity : 1,
    visible: particle.visible !== false,
    gravity: particle.gravity || { x: 0, y: 0 },
    localposition: particle.localposition || { x: 0, y: 0 },
    interval: particle.interval !== undefined ? particle.interval : 10,
    amount: particle.amount !== undefined ? particle.amount : 1,
    staggertime: particle.staggertime !== undefined ? particle.staggertime : 0,
    currentLife: particle.currentLife || null,
    initialVelocity: particle.initialVelocity || null,
    spread: particle.spread || { x: 0, y: 0 },
    weather: particle.weather || 'none',
    affected_by_weather: particle.affected_by_weather || false
  };
}

async function reinitEntitySprite(entity: any) {
  entity.layeredAnimation = null;
  entity.staticImage = null;
  try {
    const layers = entity.spriteLayers;
    if (entity.sprite_type === 'animated' && layers) {
      entity.layeredAnimation = await initializeLayeredAnimation(
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
        `idle_${entity.direction || 'down'}`
      );
    } else if (entity.sprite_type === 'static' && layers?.body?.imageUrl) {
      entity.staticImage = await createCachedImage(layers.body.imageUrl);
    }
  } catch (e) {
    console.error("Error loading entity sprite:", e);
  }
}

function getAggroColor(aggroType: string): string {
  switch (aggroType) {
    case 'friendly':
      return '#00FF00'; // Green
    case 'aggressive':
      return '#FF0000'; // Red
    case 'neutral':
    default:
      return '#FFA500'; // Orange
  }
}

function createEntity(data: any) {
  const entity: Entity = {
    id: data.id,
    name: (data.name || "").charAt(0).toUpperCase() + (data.name || "").slice(1),
    direction: data.location?.direction || "down",
    sprite_type: data.sprite_type || 'none',
    spriteLayers: data.spriteLayers || null,
    layeredAnimation: null,
    staticImage: null,
    position: {
      x: data.location.x,
      y: data.location.y,
    },
    particles: (Array.isArray(data.particles) ? data.particles.map(normalizeParticle) : []),
    particleArrays: {} as any,
    lastEmitTime: {} as any,
    damageNumbers: [] as Array<{
      value: number;
      x: number;
      y: number;
      startTime: number;
      isHealing: boolean;
      isCrit: boolean;
      isMiss?: boolean;
    }>,
    health: data.health || 100,
    max_health: data.max_health || 100,
    level: data.level || 1,
    aggro_type: data.aggro_type || 'neutral',
    target: null,
    combatState: 'idle',

    updatePosition: function (x: number, y: number) {
      this.position.x = x;
      this.position.y = y;
    },

    takeDamage: function (amount: number) {
      this.health = Math.max(0, this.health - amount);
      if (this.health <= 0) {
        this.combatState = 'dead';
      }
    },

    show: function (context: CanvasRenderingContext2D) {
      if (!context || this.combatState === 'dead') return;
      context.globalAlpha = 1;

      const uiOffset = 10;
      const isTargeted = (cache as any).targetId === this.id;

      // Draw shadow (changes color when targeted, just like players)
      const shadowsDisabled = getWeatherType() === "thunderstorm";
      let shadow: { width: number; height: number; fillStyle: string; borderColor: string };
      if (isTargeted) {
        shadow = {
          width: 18,
          height: 7,
          fillStyle: "rgba(255, 0, 0, 0.35)",
          borderColor: "rgba(255, 0, 0, 0.8)"
        };
      } else {
        shadow = {
          width: 15,
          height: 5,
          fillStyle: "rgba(0, 0, 0, 0.35)",
          borderColor: "transparent"
        };
      }

      if (!shadowsDisabled) {
      context.save();
      context.beginPath();
      context.ellipse(
        this.position.x,
        this.position.y + 16,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.strokeStyle = shadow.borderColor;
      context.lineWidth = 1;
      context.stroke();

      context.beginPath();
      context.ellipse(
        this.position.x,
        this.position.y + 16,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.fillStyle = shadow.fillStyle;
      context.fill();
      context.closePath();
      context.restore();
      }

      // Render sprite
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

      // Render nameplate with aggro color
      context.font = "14px 'Comic Relief'";
      context.textAlign = "center";
      context.shadowColor = "black";
      context.shadowBlur = 2;
      context.shadowOffsetX = 0;
      context.strokeStyle = "black";
      context.fillStyle = getAggroColor(this.aggro_type);

      if ((this as any).name?.trim()) {
        const nameX = this.position.x;
        const nameY = this.position.y + 40 + uiOffset;
        context.strokeText((this as any).name, nameX, nameY);
        context.fillText((this as any).name, nameX, nameY);
      }


      // Render health bar (only when targeted, exactly like players)
      if (isTargeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.position.x - 50, this.position.y + 46 + uiOffset, 100, 3);

        context.shadowBlur = 2;

        const maxHealth = this.max_health;
        const healthPercent = this.health / maxHealth;
        if (healthPercent < 0.3) {
          context.fillStyle = "#C81D1D";
        } else if (healthPercent < 0.5) {
          context.fillStyle = "#C87C1D";
        } else if (healthPercent < 0.8) {
          context.fillStyle = "#C8C520";
        } else {
          context.fillStyle = "#519D41";
        }

        context.fillRect(
          this.position.x - 50,
          this.position.y + 46 + uiOffset,
          healthPercent * 100,
          3
        );
      }

      // Render level (only when targeted)
      if (isTargeted) {
        context.textAlign = "left";
        context.font = "12px 'Comic Relief'";
        context.fillStyle = "white";

        context.shadowColor = "black";
        context.shadowBlur = 2;
        const offsetX = this.position.x - 60 - (this.level.toString().length * 5);
        context.fillText(`${this.level}`, offsetX, this.position.y + 51 + uiOffset);
      }

      // Draw aggro indicator
      if (this.combatState === 'aggro' || this.combatState === 'combat') {
        context.save();
        context.strokeStyle = getAggroColor(this.aggro_type);
        context.lineWidth = 2;
        context.beginPath();
        context.arc(this.position.x, this.position.y, 32, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }

      // Render damage numbers
      const duration = 1000;
      const now = performance.now();

      (this as any).damageNumbers = (this as any).damageNumbers.filter(
        (dmg: any) => now - dmg.startTime < duration
      );

      for (const dmg of (this as any).damageNumbers) {
        const elapsed = now - dmg.startTime;
        const progress = elapsed / duration;

        const yOffset = progress * 40;
        const displayY = dmg.y - yOffset;

        const opacity = 1 - progress;

        if (dmg.isCrit) {
          context.font = "bold 28px 'Comic Relief'";
        } else {
          context.font = "bold 20px 'Comic Relief'";
        }
        context.textAlign = "center";

        if (dmg.isMiss) {
          context.fillStyle = `rgba(255, 255, 255, ${opacity})`;
          context.strokeStyle = `rgba(100, 100, 100, ${opacity})`;
        } else if (dmg.isHealing) {
          context.fillStyle = `rgba(0, 255, 0, ${opacity})`;
          context.strokeStyle = `rgba(0, 100, 0, ${opacity})`;
        } else if (dmg.isCrit) {
          context.fillStyle = `rgba(255, 215, 0, ${opacity})`;
          context.strokeStyle = `rgba(200, 150, 0, ${opacity})`;
        } else {
          context.fillStyle = `rgba(255, 100, 100, ${opacity})`;
          context.strokeStyle = `rgba(150, 0, 0, ${opacity})`;
        }

        context.lineWidth = 3;
        context.strokeText(dmg.value.toString(), dmg.x, displayY);
        context.fillText(dmg.value.toString(), dmg.x, displayY);
      }

      context.shadowColor = "transparent";
      context.shadowBlur = 0;
    },

    updateParticle: (particle: Particle, entity: any, context: CanvasRenderingContext2D, deltaTime: number) => {

      if (!entity.particleArrays) {
        entity.particleArrays = {};
        entity.lastEmitTime = {};
      }

      const emitInterval = (particle.interval || 1) / 60 * 1000; // Frame-rate independent: convert 60 FPS frame interval to milliseconds

      // Match the particle editor preview: cap the per-frame delta at one 60 FPS
      // frame and drive emission from that same clock. iOS throttles
      // requestAnimationFrame, so the renderer lets deltaTime spike up to ~500ms.
      // If emission ran on wall-clock time while aging used the capped delta,
      // particles would spawn faster than they die and pile up (brighter overlap,
      // worse FPS). Sharing one clamped clock keeps spawn/death balanced.
      const clampedDelta = Math.min(deltaTime, 0.01667);

      if (entity.lastEmitTime[particle.name || ''] === undefined) {
        entity.lastEmitTime[particle.name || ''] = 0;
      }

      if (!entity.particleArrays[particle.name || '']) {
        entity.particleArrays[particle.name || ''] = [];
      }

      const particleArray = entity.particleArrays[particle.name || ''];
      entity.lastEmitTime[particle.name || ''] += clampedDelta * 1000;

      while (entity.lastEmitTime[particle.name || ''] >= emitInterval && particleArray.length < (particle.amount || 1)) {
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
        newParticle.gravity = particle.gravity ? { ...particle.gravity } : { x: 0, y: 0 };
        newParticle.weather = typeof particle.weather === 'object' ? { ...particle.weather } : 'none';
        newParticle.localposition.x = Number(particle.localposition?.x || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread?.x || 0) * 0.5;
        newParticle.localposition.y = Number(particle.localposition?.y || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread?.y || 0) * 0.5;
        newParticle.velocity.x = Number(particle.velocity?.x || 0) + windBias.x;
        newParticle.velocity.y = Number(particle.velocity?.y || 0) + windBias.y;

        particleArray.push(newParticle);
        entity.lastEmitTime[particle.name || ''] -= emitInterval;
      }

      const particles = entity.particleArrays[particle.name || ''];
      if (particles.length === 0) {
        context.globalAlpha = 1;
        return;
      }

      // Update wind burst cycle - creates pulsating wind effect
      const deltaTimeMs = clampedDelta * 1000; // Convert deltaTime back to ms
      windBurst.update(deltaTimeMs);

      const entityPosX = entity.position.x;
      const entityPosY = entity.position.y;

      // Only apply wind if particle is affected by weather
      let windSpeed = 0;
      let windDirection = null;
      if (particle.affected_by_weather) {
        const weatherData = typeof particle.weather === 'object' ? particle.weather : null;
        const baseWindSpeed = weatherData?.wind_speed || 0;
        windSpeed = calculateWindSpeed(baseWindSpeed, windBurst.getIntensity());
        windDirection = weatherData?.wind_direction || null;
      }

      const gravX = particle.gravity?.x || 0;
      const gravY = particle.gravity?.y || 0;

      // Velocity caps based on base particle velocity, wind can push beyond this
      const maxVelX = Math.abs(particle.velocity?.x || 0) || 1;
      const maxVelY = Math.abs(particle.velocity?.y || 0) || 1;
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

        // Update physics - apply forces and velocity
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
        const cx = entityPosX + p.localposition.x;
        const cy = entityPosY + p.localposition.y;
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

  // Add to cache
  cache.entities.push(entity);

  // Initialize sprite asynchronously
  reinitEntitySprite(entity);

  return entity;
}

export { createEntity, reinitEntitySprite, normalizeParticle };
