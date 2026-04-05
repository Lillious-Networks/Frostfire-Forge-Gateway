import { getLines } from "./chat.js";
import { npcImage, createCachedImage } from "./images.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import { getIsLoaded } from "./socket.js";
import { initializeLayeredAnimation, getVisibleLayersSorted } from "./layeredAnimation.js";

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

        const newParticle: Particle = {
          ...particle,
          localposition: {
            x: Number(particle.localposition?.x || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.x),
            y: Number(particle.localposition?.y || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.y)
          },
          velocity: {
            x: Number(particle.velocity.x || 0) + windBias.x,
            y: Number(particle.velocity.y || 0) + windBias.y
          },
          lifetime: baseLifetime + randomLifetimeExtension,
          currentLife: baseLifetime + randomLifetimeExtension,
          opacity: particle.opacity || 1,
          visible: true,
          size: particle.size || 5,
          color: particle.color || 'white',
          gravity: { ...particle.gravity },
          weather: typeof particle.weather === 'object' ? { ...particle.weather } : 'none'
        };

        if (npc.particleArrays[particle.name || ''].length >= particle.amount) {
          npc.particleArrays[particle.name || ''].shift();
        }

        npc.particleArrays[particle.name || ''].push(newParticle);
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }

      const particles = npc.particleArrays[particle.name || ''];
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        p.currentLife -= deltaTime * 1000;

        if (p.currentLife <= 0) {
          particles.splice(i, 1);
          continue;
        }

        if (!p.localposition) {
          p.localposition = { x: 0, y: 0 };
        }

        if (p.velocity && p.gravity) {
          const windDirection = typeof p.weather === 'object' ? p.weather.wind_direction : null;
          const windSpeed = typeof p.weather === 'object' ? p.weather.wind_speed || 0 : 0;
          const windForce = {
            x: 0,
            y: 0
          };

          if (windDirection !== 'none' && (windDirection === 'left' || windDirection === 'right')) {
            const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
            windForce.x = Math.cos(windDirectionRad) * windSpeed * 0.01;
            windForce.y = Math.sin(windDirectionRad) * windSpeed * 0.01;
          }

          p.velocity.x += p.gravity.x * deltaTime + windForce.x;
          p.velocity.y += p.gravity.y * deltaTime + windForce.y;

          const maxVelocity = {
            x: particle.velocity.x + (windSpeed * 0.2),
            y: particle.velocity.y + (windSpeed * 0.2)
          };

          p.velocity.x = Math.min(Math.max(p.velocity.x, -maxVelocity.x), maxVelocity.x);
          p.velocity.y = Math.min(Math.max(p.velocity.y, -maxVelocity.y), maxVelocity.y);

          p.localposition.x += p.velocity.x * deltaTime;
          p.localposition.y += p.velocity.y * deltaTime;
        }

        const centerX = npc.position.x + 16 - (p.size / 2);
        const centerY = npc.position.y + 24 - (p.size / 2);
        const renderX = centerX + p.localposition.x;
        const renderY = centerY + p.localposition.y;

        const fadeInDuration = p.lifetime * 0.4;
        const fadeOutDuration = p.lifetime * 0.4;
        let alpha;

        if (p.lifetime - p.currentLife < fadeInDuration) {

          alpha = ((p.lifetime - p.currentLife) / fadeInDuration) * p.opacity;
        } else if (p.currentLife < fadeOutDuration) {

          alpha = (p.currentLife / fadeOutDuration) * p.opacity;
        } else {

          alpha = p.opacity;
        }

        context.globalAlpha = alpha;

        context.beginPath();
        context.arc(renderX + p.size/2, renderY + p.size/2, p.size/2, 0, Math.PI * 2);
        context.fillStyle = p.color || "white";
        context.fill();
      }

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

export { createNPC, reinitNpcSprite };