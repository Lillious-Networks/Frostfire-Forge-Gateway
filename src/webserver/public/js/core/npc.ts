import { getLines } from "./chat.js";
import { npcImage, createCachedImage } from "./images.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { getIsLoaded } from "./socket.js";
import { initializeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";

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
            Math.round(this.position.y - frame.height / 2 + oy)
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

      const currentTime = performance.now();
      const emitInterval = (particle.interval || 1) * 16.67;

      if (!npc.lastEmitTime[particle.name || '']) {
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }

      if (!npc.particleArrays[particle.name || '']) {
        npc.particleArrays[particle.name || ''] = [];
      }

      if (currentTime - npc.lastEmitTime[particle.name || ''] >= emitInterval) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;
        const windDirection = typeof particle.weather === 'object' ? particle.weather.wind_direction : null;
        const windSpeed = typeof particle.weather === 'object' ? particle.weather.wind_speed || 0 : 0;

        const windBias = {
          x: 0,
          y: 0
        }

        if (windDirection !== null && (windDirection === 'left' || windDirection === 'right')) {

          const windDirectionRad = (windDirection === 'left' ? 180 :
                                  windDirection === 'right' ? 0 : 180) * Math.PI / 180;
          windBias.x = Math.cos(windDirectionRad) * windSpeed * 0.5;
          windBias.y = Math.sin(windDirectionRad) * windSpeed * 0.5;
        }

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

        const particleArray = npc.particleArrays[particle.name || ''];
        if (particleArray.length >= particle.amount) {
          const removed = particleArray.shift();
          particlePool.release(removed);
        }

        particleArray.push(newParticle);
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }

      const particles = npc.particleArrays[particle.name || ''];
      if (particles.length === 0) {
        context.globalAlpha = 1;
        return;
      }

      const npcPosX = npc.position.x + 16;
      const npcPosY = npc.position.y + 24;
      const weatherData = typeof particle.weather === 'object' ? particle.weather : null;
      const windSpeed = weatherData?.wind_speed || 0;
      const windDirection = weatherData?.wind_direction || null;
      let windForceX = 0, windForceY = 0;

      if (windDirection !== 'none' && (windDirection === 'left' || windDirection === 'right')) {
        const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
        windForceX = Math.cos(windDirectionRad) * windSpeed * 0.01;
        windForceY = Math.sin(windDirectionRad) * windSpeed * 0.01;
      }

      const maxVelX = particle.velocity.x + (windSpeed * 0.2);
      const maxVelY = particle.velocity.y + (windSpeed * 0.2);
      const gravX = particle.gravity.x;
      const gravY = particle.gravity.y;
      const fadeInDur = particle.lifetime * 0.4;
      const fadeOutDur = particle.lifetime * 0.4;
      const particleOpacity = particle.opacity;
      const particleColor = particle.color || "white";

      // Set blend mode once for all particles
      context.globalCompositeOperation = 'lighter';

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.currentLife -= deltaTime * 1000;

        if (p.currentLife <= 0) {
          particles.splice(i, 1);
          continue;
        }

        // Update physics - apply forces and velocity
        if (gravX !== 0 || gravY !== 0 || windForceX !== 0 || windForceY !== 0) {
          p.velocity.x += gravX * deltaTime + windForceX;
          p.velocity.y += gravY * deltaTime + windForceY;

          p.velocity.x = Math.min(Math.max(p.velocity.x, -maxVelX), maxVelX);
          p.velocity.y = Math.min(Math.max(p.velocity.y, -maxVelY), maxVelY);
        }

        // Always apply velocity to position (moved outside the force check)
        p.localposition.x += p.velocity.x * deltaTime;
        p.localposition.y += p.velocity.y * deltaTime;

        // Calculate alpha
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

        // Draw particle with gradient
        const renderX = npcPosX - (p.size / 2) + p.localposition.x;
        const renderY = npcPosY - (p.size / 2) + p.localposition.y;
        const radius = p.size / 2;
        const cx = renderX + radius;
        const cy = renderY + radius;

        const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);

        gradient.addColorStop(0, particleColor);
        gradient.addColorStop(1, particleColor + "00");

        // Add glow effect with shadow
        context.shadowColor = particleColor;
        context.shadowBlur = Math.max(4, radius * 0.8);
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;

        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fillStyle = gradient;
        context.fill();

        // Reset shadow
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
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

export { createNPC, reinitNpcSprite, particlePool };