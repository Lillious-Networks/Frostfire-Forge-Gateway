// Particle emitter/renderer for sources drawn at their raw position (player
// effect particles). NPCs have their own centred variant in npc.ts.
import { particlePool, getParticleSprite } from "./npc.js";
import { windBurst, calculateWindSpeed, applyWindVelocity, getWindBias } from "./windphysics.ts";

export function updateSourceParticle(particle: Particle, entity: any, context: CanvasRenderingContext2D, deltaTime: number): void {

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
