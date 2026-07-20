import Cache from "./cache.js";
const cache = Cache.getInstance();
import { cachedPlayerId, setSelfPlayerSpriteLoaded } from "./socket.js";
import { updateFriendOnlineStatus, updateFriendsList } from "./friends.js";
import { getCameraX, getCameraY, setCameraX, setCameraY, getWeatherType } from "./renderer.js";
import { createPartyUI, createGuildUI, updateGuildMemberOnlineStatus, positionText } from "./ui.js";
import { updateXp } from "./xp.js";
import { getLines } from "./chat.js";
import { getCachedImage } from "./images.js";
import { config } from "../web/global.js";
import { particlePool, getParticleSprite } from "./npc.js";
import { initializeLayeredAnimation } from "./layeredAnimation.js";
import { getVisibleLayersSorted } from "./layeredAnimation.js";

async function createPlayer(data: any) {

  if (data.id === cachedPlayerId) {
    positionText.innerText = `Position: ${Math.round(data.location.x)}, ${Math.round(data.location.y)}`;
  }

  updateFriendOnlineStatus(data.username, true);
  cache.onlinePlayers.add(data.username.toLowerCase());
  updateGuildMemberOnlineStatus(data.username, true);

  let layeredAnimationPromise = null;

  if (data.spriteData && (data.spriteData.bodySprite || data.spriteData.headSprite)) {
    layeredAnimationPromise = initializeLayeredAnimation(
      data.spriteData.mountSprite || null,
      data.spriteData.bodySprite || null,
      data.spriteData.headSprite || null,
      data.spriteData.armorHelmetSprite || null,
      data.spriteData.armorShoulderguardsSprite || null,
      data.spriteData.armorNeckSprite || null,
      data.spriteData.armorHandsSprite || null,
      data.spriteData.armorChestSprite || null,
      data.spriteData.armorFeetSprite || null,
      data.spriteData.armorLegsSprite || null,
      data.spriteData.armorWeaponSprite || null,
      data.spriteData.animationState || 'idle'
    );
  } else if (data.bodySprite && data.headSprite) {

    layeredAnimationPromise = initializeLayeredAnimation(
      data.mountSprite || null,
      data.bodySprite,
      data.headSprite,
      data.armorHelmetSprite || null,
      data.armorShoulderguardsSprite || null,
      data.armorNeckSprite || null,
      data.armorHandsSprite || null,
      data.armorChestSprite || null,
      data.armorFeetSprite || null,
      data.armorLegsSprite || null,
      data.armorWeaponSprite || null,
      data.animationState || 'idle'
    );
  }

  if (!cache.pendingPlayers) {
    cache.pendingPlayers = new Map();
  }

  const player = {
    id: data.id,
    username: data.username,
    userid: data.userid,
    layeredAnimation: null as null | LayeredAnimation,
    _layerCanvases: {} as Record<string, HTMLCanvasElement>,
    lastDirection: "down" as string,
    friends: data.friends || [],
    position: {
      x: Math.round(data.location.x),
      y: Math.round(data.location.y),
    },
    serverPosition: {
      x: Math.round(data.location.x),
      y: Math.round(data.location.y),
    },
    renderPosition: {
      x: Math.round(data.location.x),
      y: Math.round(data.location.y),
    },
    lastServerUpdate: 0,
    lastInputTime: 0,
    velocity: { x: 0, y: 0 },
    chat: "",
    isStealth: data.isStealth,
    isVanished: data.isVanished || false,
    isAdmin: data.isAdmin,
    isGuest: data.isGuest || false,
    _adminColorHue: Math.floor(Math.random() * 360),
    targeted: false,
    stats: data.stats,
    typing: false,
    typingTimeout: null as NodeJS.Timeout | null,
    party: data.party || null,
    guild: data.guild || null,
    guild_name: data.guild_name || null,
    mounted: data.mounted || false,
    moving: data.location.moving || false,
    canmove: true,  // Can be set to false when being dragged by an admin
    currency: data.currency || { copper: 0, silver: 0, gold: 0 },
    chatType: "global" as "global" | "party" | "guild" | "whisper",
    damageNumbers: [] as Array<{
      value: number;
      x: number;
      y: number;
      startTime: number;
      isHealing: boolean;
      isCrit: boolean;
      isMiss?: boolean;
      isAbsorb?: boolean;
    }>,
    castingSpell: null as string | null,
    castingStartTime: 0,
    castingDuration: 0,
    castingInterrupted: false,
    castingInterruptedProgress: undefined as number | undefined,
    activeEffects: [] as Array<any>,
    _effectParticleArrays: undefined as Record<string, any[]> | undefined,
    _effectLastEmitTime: undefined as Record<string, number> | undefined,
    showEffectParticles: function (context: CanvasRenderingContext2D, dtSec: number) {
      const now = Date.now();
      const effects = this.activeEffects?.filter((e: any) => e.endTime > now) || [];
      if (effects.length === 0) return;

      if (!this._effectParticleArrays) this._effectParticleArrays = {};
      if (!this._effectLastEmitTime) this._effectLastEmitTime = {};

      for (const effect of effects) {
        const particles = effect.particles as any[] | undefined;
        if (!particles || particles.length === 0) continue;

        for (const particleDef of particles) {
          const name = particleDef.name || '';
          const key = `${effect.id}_${name}`;
          const amount = Math.max(Number(particleDef.amount) || 1, 1);

          const emitIntervalMs = Math.max(Number(particleDef.interval) || 10, 1);
          const lastTime = (this._effectLastEmitTime as Record<string, number>)[key] || 0;
          if (now - lastTime >= emitIntervalMs) {
            (this._effectLastEmitTime as Record<string, number>)[key] = now;

            if (!(this._effectParticleArrays as Record<string, any[]>)[key]) {
              (this._effectParticleArrays as Record<string, any[]>)[key] = [];
            }
            const arr = (this._effectParticleArrays as Record<string, any[]>)[key];

            for (let a = 0; a < amount; a++) {
              const p = particlePool.acquire();
              const lifeMs = Number(particleDef.lifetime) || 1000;
              p.currentLife = lifeMs;
              p.lifetime = lifeMs;
              p.size = Number(particleDef.size) || 5;
              p.color = particleDef.color || '#ffffff';
              p.opacity = Number(particleDef.opacity) || 1;
              p.gravity = particleDef.gravity ? { x: Number(particleDef.gravity.x || 0), y: Number(particleDef.gravity.y || 0) } : { x: 0, y: 0 };
              p.velocity = particleDef.velocity ? { x: Number(particleDef.velocity.x || 0), y: Number(particleDef.velocity.y || 0) } : { x: 0, y: 0 };
              const spreadX = (Math.random() - 0.5) * (Number(particleDef.spread?.x) || 0);
              const spreadY = (Math.random() - 0.5) * (Number(particleDef.spread?.y) || 0);
              p.localposition = { x: spreadX, y: spreadY };
              p.glow_intensity = Number(particleDef.glow_intensity) || 0;

              arr.push(p);
            }
          }
        }
      }

      // Update and render existing effect particles (world → screen via offset)
      const activeKeys = new Set<string>();
      for (const effect of effects) {
        const particles = effect.particles as any[] | undefined;
        if (!particles || particles.length === 0) continue;
        for (const particleDef of particles) {
          activeKeys.add(`${effect.id}_${particleDef.name || ''}`);
        }
      }

      for (const [key, arr] of Object.entries(this._effectParticleArrays as Record<string, any[]>)) {
        if (!activeKeys.has(key)) {
          for (const pp of arr) particlePool.release(pp);
          delete (this._effectParticleArrays as Record<string, any[]>)[key];
          delete (this._effectLastEmitTime as Record<string, number>)[key];
          continue;
        }

        const parts = key.split('_');
        const particleName = parts.slice(1).join('_');
        let particleDef: any = null;
        for (const effect of effects) {
          const pd = (effect.particles as any[])?.find((p: any) => p.name === particleName);
          if (pd) { particleDef = pd; break; }
        }
        if (!particleDef) continue;

        const gravX = Number(particleDef.gravity?.x || 0);
        const gravY = Number(particleDef.gravity?.y || 0);
        const baseColor = particleDef.color || '#ffffff';
        const baseOpacity = Number(particleDef.opacity) || 1;
        const glowIntensity = Number(particleDef.glow_intensity) || 0;
        const particleSprite = getParticleSprite(baseColor, (Number(particleDef.size) || 5) / 2, glowIntensity);

        context.save();
        context.globalCompositeOperation = 'lighter';
        context.shadowColor = 'transparent';
        context.shadowBlur = 0;

        for (let k = arr.length - 1; k >= 0; k--) {
          const pp = arr[k];
          pp.currentLife -= dtSec * 1000;
          if (pp.currentLife <= 0) {
            particlePool.release(pp);
            arr.splice(k, 1);
            continue;
          }

          pp.velocity.y += gravY * dtSec;
          pp.velocity.x += gravX * dtSec;
          pp.localposition.x += pp.velocity.x * dtSec;
          pp.localposition.y += pp.velocity.y * dtSec;

          const lifeElapsed = pp.lifetime - pp.currentLife;
          const fadeInDur = pp.lifetime * 0.4;
          const fadeOutDur = pp.lifetime * 0.4;
          let alpha;
          if (lifeElapsed < fadeInDur) {
            alpha = (lifeElapsed / fadeInDur) * baseOpacity;
          } else if (pp.currentLife < fadeOutDur) {
            alpha = (pp.currentLife / fadeOutDur) * baseOpacity;
          } else {
            alpha = baseOpacity;
          }

          // World coordinates — rendered inside ctx.translate(offsetX, offsetY)
          context.globalAlpha = alpha;
          const cx = this.renderPosition.x + pp.localposition.x;
          const cy = this.renderPosition.y + pp.localposition.y;
          context.drawImage(
            particleSprite.canvas,
            cx - particleSprite.half,
            cy - particleSprite.half,
            particleSprite.half * 2,
            particleSprite.half * 2
          );
        }

        context.restore();
      }
    },
    showDebuffs: function (context: CanvasRenderingContext2D) {
      if (!Array.isArray(this.activeEffects) || this.activeEffects.length === 0) return;

      const now = Date.now();
      // Buffs first, then debuffs. Visual-only effects excluded.
      const active = this.activeEffects
        .filter((e: any) => !e.isVisual && e.endTime > now)
        .sort((a: any, b: any) => (a.isDebuff ? 1 : 0) - (b.isDebuff ? 1 : 0))
        .slice(0, 10);
      if (active.length === 0) return;

      const iconSize = 18;
      const gap = 3;
      const maxPerRow = 5;
      const timerHeight = 12;
      const rowHeight = iconSize + timerHeight + gap;
      const baseIconY = this.renderPosition.y - 87;

      const rows: any[][] = [];
      for (let i = 0; i < active.length; i += maxPerRow) {
        rows.push(active.slice(i, i + maxPerRow));
      }

      context.save();
      context.imageSmoothingEnabled = false;

      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const rowWidth = row.length * iconSize + (row.length - 1) * gap;
        let x = Math.round(this.renderPosition.x - rowWidth / 2);
        const y = Math.round(baseIconY - r * rowHeight);

        for (const effect of row) {
          const isDebuff = effect.isDebuff === true;
          const iconUrl = effect.icon
            || cache.spells?.[effect.spell]?.spriteUrl
            || `${config.ASSET_SERVER_URL}/icon?name=missing_icon`;
          const img = getCachedImage(iconUrl);

          context.fillStyle = "rgba(0, 0, 0, 0.6)";
          context.fillRect(x - 1, y - 1, iconSize + 2, iconSize + 2);

          if (img.complete && img.naturalWidth > 0) {
            context.drawImage(img, x, y, iconSize, iconSize);
          }

          context.strokeStyle = isDebuff ? "rgba(255, 90, 90, 0.9)" : "rgba(120, 170, 255, 0.9)";
          context.lineWidth = 1;
          context.strokeRect(x - 0.5, y - 0.5, iconSize + 1, iconSize + 1);

          const stacks = Number(effect.stacks) || 1;
          if (stacks > 1) {
            context.font = "bold 10px 'Comic Relief'";
            context.textAlign = "right";
            context.fillStyle = "#ffd75e";
            context.strokeStyle = "black";
            context.lineWidth = 2;
            context.strokeText(`${stacks}`, x + iconSize, y + iconSize - 1);
            context.fillText(`${stacks}`, x + iconSize, y + iconSize - 1);
          }

          const remaining = Math.ceil((effect.endTime - now) / 1000);
          if (remaining > 0) {
            context.font = "bold 10px 'Comic Relief'";
            context.textAlign = "center";
            context.fillStyle = "white";
            context.strokeStyle = "black";
            context.lineWidth = 2;
            context.strokeText(`${remaining}`, x + iconSize / 2, y + iconSize + timerHeight - 2);
            context.fillText(`${remaining}`, x + iconSize / 2, y + iconSize + timerHeight - 2);
          }

          x += iconSize + gap;
        }
      }

      context.restore();
    },
    showChat: function (context: CanvasRenderingContext2D) {

      if (this.chat) {
        if (this.chat.trim() !== "") {

          let chatColor = "white";
          if (this.chatType === "party") {
            chatColor = "#86b3ff";
          }

          context.fillStyle = "black";
          context.fillStyle = chatColor;
          context.textAlign = "center";
          context.shadowBlur = 1;
          context.shadowColor = "black";
          context.shadowOffsetX = 1;
          context.shadowOffsetY = 1;
          context.font = "14px 'Comic Relief'";
          const lines = getLines(context, this.chat, 500).reverse();
          let startingPosition = this.renderPosition.y - 20;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 20;
            const textWidth = context.measureText(lines[i]).width;
            context.fillStyle = "rgba(0, 0, 0, 0.2)";
            context.fillRect(
              this.renderPosition.x - textWidth/2 - 5,
              startingPosition - 17,
              textWidth + 10,
              20
            );
            context.fillStyle = chatColor;
            context.fillText(lines[i], this.renderPosition.x, startingPosition);
          }
        }
      }

      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    },
    showDamageNumbers: function (context: CanvasRenderingContext2D) {
      const now = performance.now();
      const duration = 1000;

      this.damageNumbers = this.damageNumbers.filter(
        (dmg) => now - dmg.startTime < duration
      );

      for (const dmg of this.damageNumbers) {
        const elapsed = now - dmg.startTime;
        const progress = elapsed / duration;

        const yOffset = progress * 40;
        const displayY = dmg.y - yOffset;

        const opacity = 1 - progress;

        if (dmg.isCrit && !dmg.isHealing) {
          context.font = "bold 28px 'Comic Relief'";
        } else {
          context.font = "bold 20px 'Comic Relief'";
        }
        context.textAlign = "center";

        if (dmg.isAbsorb) {
          context.fillStyle = `rgba(180, 220, 255, ${opacity})`;
          context.strokeStyle = `rgba(60, 110, 180, ${opacity})`;
        } else if (dmg.isMiss) {

          context.fillStyle = `rgba(255, 255, 255, ${opacity})`;
          context.strokeStyle = `rgba(100, 100, 100, ${opacity})`;
        } else if (dmg.isHealing) {
          context.fillStyle = `rgba(0, 255, 0, ${opacity})`;
          context.strokeStyle = `rgba(0, 100, 0, ${opacity})`;
        } else if (dmg.isCrit) {

          context.fillStyle = `rgba(255, 215, 0, ${opacity})`;
          context.strokeStyle = `rgba(255, 140, 0, ${opacity})`;
        } else {
          context.fillStyle = `rgba(255, 0, 0, ${opacity})`;
          context.strokeStyle = `rgba(139, 0, 0, ${opacity})`;
        }

        const displayText = dmg.isMiss
          ? "Miss"
          : dmg.isAbsorb
          ? `+${dmg.value}`
          : dmg.isCrit && !dmg.isHealing
          ? `${dmg.value}!`
          : `${dmg.value}`;

        context.lineWidth = 3;
        context.strokeText(
          displayText,
          dmg.x,
          displayY
        );
        context.fillText(
          displayText,
          dmg.x,
          displayY
        );
      }

      context.fillStyle = "white";
      context.strokeStyle = "black";
      context.lineWidth = 1;
    },
    showCastbar: function (context: CanvasRenderingContext2D) {
      if (!this.castingSpell) return;
      if (this.castingDuration === 0 && !this.castingInterrupted) {
        this.castingSpell = null;
        return;
      }

      const now = performance.now();
      const elapsed = now - this.castingStartTime;

      let progress;
      if (this.castingInterrupted) {
        if (this.castingSpell === "Failed") {
          progress = 1.0;
        } else {
          progress = Math.max(this.castingInterruptedProgress || 0, 0.15);
        }
      } else {
        progress = Math.min(elapsed / this.castingDuration, 1);
      }

      const barWidth = 110;
      const barHeight = 10;
      const barX = this.renderPosition.x - barWidth / 2;
      const barY = this.renderPosition.y - 38;

      // Background
      context.fillStyle = "rgba(8, 8, 16, 0.9)";
      context.beginPath();
      context.roundRect(barX, barY, barWidth, barHeight, 3);
      context.fill();

      // Border
      context.strokeStyle = "rgba(160, 150, 130, 0.4)";
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(barX, barY, barWidth, barHeight, 3);
      context.stroke();

      // Fill color based on state
      if (this.castingInterrupted) {
        if (this.castingSpell === "Failed") {
          context.fillStyle = "rgba(220, 60, 60, 0.95)";
        } else {
          context.fillStyle = "rgba(120, 120, 130, 0.95)";
        }
      } else {
        context.fillStyle = "rgba(212, 168, 38, 0.95)";
      }

      context.beginPath();
      context.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, barHeight - 2, 2);
      context.fill();

      // Highlight
      context.fillStyle = "rgba(255, 255, 255, 0.12)";
      context.beginPath();
      context.roundRect(barX + 1, barY + 1, (barWidth - 2) * progress, (barHeight - 2) / 2, [2, 2, 0, 0]);
      context.fill();

      // Spell name
      context.font = "bold 10px 'Comic Relief'";
      context.fillStyle = "#e8e0d0";
      context.textAlign = "center";
      context.shadowColor = "rgba(0, 0, 0, 0.9)";
      context.shadowBlur = 3;
      context.fillText(this.castingSpell, this.renderPosition.x, barY - 5);
      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      if (this.castingInterrupted && elapsed >= 1500) {
        this.castingSpell = null;
        this.castingInterrupted = false;
        this.castingInterruptedProgress = undefined;
      } else if (!this.castingInterrupted && progress >= 1) {
        this.castingSpell = null;
      }
    },
    renderAnimation: function (context: CanvasRenderingContext2D) {

      if (!this.layeredAnimation) {
        return;
      }

      this.renderLayeredAnimation(context);
    },
    renderLayeredAnimation: function (context: CanvasRenderingContext2D) {
      if (!this.layeredAnimation) return;

      const layers = getVisibleLayersSorted(this.layeredAnimation);
      if (layers.length === 0) return;

      if (!this._layerCanvases) {
        this._layerCanvases = {};
      }

      context.save();

      context.imageSmoothingEnabled = false;

      if (this.isStealth || this.isVanished) {
        context.globalAlpha = 0.5;
      }

      for (const layer of layers) {
        if (layer.frames.length === 0) continue;

        const frame = layer.frames[layer.currentFrame];
        if (!frame || !frame.imageElement?.complete) continue;

        const isMounted: boolean = this.layeredAnimation.layers.mount !== null;
        const layerKey = `${layer.type}_${this.layeredAnimation.currentAnimationName}_${layer.currentFrame}_${isMounted}`;
        if (!this._layerCanvases[layerKey]) {
          const layerCanvas = document.createElement('canvas');
          layerCanvas.width = frame.width;
          layerCanvas.height = frame.height;
          const layerCtx = layerCanvas.getContext('2d');

          if (layerCtx) {

            layerCtx.imageSmoothingEnabled = false;
            layerCtx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
            layerCtx.drawImage(frame.imageElement, 0, 0);
          }

          this._layerCanvases[layerKey] = layerCanvas;
        }

        const layerCanvas = this._layerCanvases[layerKey];
        const offsetX = frame.offset?.x || 0;
        const offsetY = frame.offset?.y || 0;

        context.drawImage(
          layerCanvas,
          Math.round(this.renderPosition.x - frame.width / 2 + offsetX),
          Math.round(this.renderPosition.y - frame.height / 2 + offsetY)
        );
      }

      context.restore();
    },
    show: function (context: CanvasRenderingContext2D, currentPlayer?: any) {

      const uiOffset = 10;

      const shadowsDisabled = getWeatherType() === "thunderstorm";

      let shadow: { width: number; height: number; fillStyle: string; borderColor: string };
      if (this.targeted) {
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
        this.renderPosition.x,
        this.renderPosition.y + 16,
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
        this.renderPosition.x,
        this.renderPosition.y + 16,
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

      context.globalAlpha = 1;
      context.font = "14px 'Comic Relief'";

      if (this.isStealth) {
        context.fillStyle = "rgba(97, 168, 255, 1)";
      } else {
        context.fillStyle = "white";
      }

      context.textAlign = "center";

      if (!currentPlayer) return;

      let nameColor: string | undefined;

      const isCurrent = data.id === currentPlayer?.id;
      const isVisible = !this.isStealth;

      if (this.isAdmin && isVisible) {

        nameColor = "#ff2252ff";
      }

      if (isCurrent && isVisible && !this.isAdmin) {
        nameColor = "#ffe561";
      } else if (this.isStealth) {
        nameColor = "rgba(97, 168, 255, 1)";
      } else if (!nameColor) {
        if (currentPlayer.party?.includes(this.username)) {
          nameColor = "#00ff88ff";
        } else if (currentPlayer.friends.includes(this.username)) {
          nameColor = "#00b7ffff";
        } else {
          nameColor = "#FFFFFF";
        }
      }

      context.fillStyle = nameColor;

      context.shadowColor = "black";
      context.shadowBlur = 2;
      context.shadowOffsetX = 0;
      context.strokeStyle = "black";

      const isGuest = this?.isGuest;
      if (isGuest) {
        data.username = "Guest";
      } else {
        const u = data?.username;
        if (!u) {

          document.cookie.split(";").forEach(function(c) {
            document.cookie = c.trim().split("=")[0] + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT";
          });

          sessionStorage.clear();

          window.location.href = "/";
        } else {
          data.username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
        }
      }

      context.strokeText(
        data.username,
        this.renderPosition.x,
        this.renderPosition.y + 40 + uiOffset
      );
      context.fillText(
        data.username,
        this.renderPosition.x,
        this.renderPosition.y + 40 + uiOffset
      );

      const guildOffset = this.guild_name ? 16 : 0;

      if (this.guild_name) {
        context.font = "12px 'Comic Relief'";
        context.fillStyle = "#c9a655";
        context.shadowBlur = 1;
        context.strokeText(
          `<${this.guild_name}>`,
          this.renderPosition.x,
          this.renderPosition.y + 56 + uiOffset
        );
        context.fillText(
          `<${this.guild_name}>`,
          this.renderPosition.x,
          this.renderPosition.y + 56 + uiOffset
        );
        context.shadowBlur = 2;
      }

      if (!this.isStealth) {
        if (data.id === cachedPlayerId || this.targeted) {
          context.fillStyle = "rgba(0, 0, 0, 0.8)";
          context.fillRect(this.renderPosition.x - 50, this.renderPosition.y + 46 + guildOffset + uiOffset, 100, 3);

          context.shadowBlur = 2;

          const maxHealth = this.stats.total_max_health || this.stats.max_health;
          const healthPercent = this.stats.health / maxHealth;
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
            this.renderPosition.x - 50,
            this.renderPosition.y + 46 + guildOffset + uiOffset,
            healthPercent * 100,
            3
          );

          const absorbtion = this.stats.absorbtion || 0;
          if (absorbtion > 0) {
            const absorbWidth = Math.min(absorbtion / maxHealth, 1) * 100;
            const absorbX = this.renderPosition.x - 50;
            const absorbY = this.renderPosition.y + 46 + guildOffset + uiOffset;
            context.save();
            context.shadowColor = "rgba(180, 220, 255, 0.7)";
            context.shadowBlur = 5;
            context.fillStyle = "rgba(180, 220, 255, 0.4)";
            context.fillRect(absorbX, absorbY, absorbWidth, 3);
            context.shadowColor = "rgba(200, 230, 255, 0.95)";
            context.shadowBlur = 7;
            context.fillStyle = "rgba(210, 235, 255, 0.6)";
            context.fillRect(absorbX + Math.max(0, absorbWidth - 1.5), absorbY, 2, 3);
            context.restore();
          }
        }

        if (data.id === cachedPlayerId || this.targeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.renderPosition.x - 50, this.renderPosition.y + 51 + guildOffset + uiOffset, 100, 3);
        context.fillStyle = "#469CD9";
        const maxStamina = this.stats.total_max_stamina || this.stats.max_stamina;
        context.fillRect(
          this.renderPosition.x - 50,
            this.renderPosition.y + 51 + guildOffset + uiOffset,
            (this.stats.stamina / maxStamina) * 100,
            3
          );
        }

        if (data.id === cachedPlayerId || this.targeted) {

          context.textAlign = "left";
          context.font = "12px 'Comic Relief'";
          context.fillStyle = "white";

          context.shadowColor = "black";
          context.shadowBlur = 2;
            const offsetX = this.renderPosition.x - 60 - (this.stats.level.toString().length * 5);
          context.fillText(`${this.stats.level}`, offsetX, this.renderPosition.y + 55 + guildOffset + uiOffset);
        }
      }

      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      this.renderAnimation(context);
    },
  };

  if (!cache.pendingPlayers) {
    cache.pendingPlayers = new Map();
  }
  cache.pendingPlayers.set(player.id, player);

  if (layeredAnimationPromise) {
    const anim = await layeredAnimationPromise;
    // Don't overwrite if SPRITE_SHEET_ANIMATION already set a richer animation (e.g. with armor)
    if (!player.layeredAnimation) {
      player.layeredAnimation = anim;
    }

    // Wait for all animation frames to actually load before showing player
    await new Promise<void>((resolve) => {
      const checkFramesLoaded = () => {
        const layers = Object.values(player.layeredAnimation!.layers).filter(l => l !== null);
        const allFramesLoaded = layers.every(layer => {
          if (!layer || !layer.frames || layer.frames.length === 0) return true;
          return layer.frames.every(frame => {
            if (!frame || !frame.imageElement) return false;
            return frame.imageElement.complete && frame.imageElement.naturalWidth > 0;
          });
        });

        if (allFramesLoaded) {
          resolve();
        } else {
          requestAnimationFrame(checkFramesLoaded);
        }
      };
      checkFramesLoaded();
    });
  }

  cache.players.add(player);

  if (cache.pendingPlayers) {
    cache.pendingPlayers.delete(player.id);
  }

  // Apply effects: prefer pendingEffects (from the later EFFECTS packet, already
  // has endTime computed at the moment the packet was received) over data.effects
  // (from the spawn packet, whose remaining values are stale by the time
  // createPlayer finishes async animation loading).
  // Only set if the EFFECTS handler didn't already set activeEffects directly.
  if (!Array.isArray(player.activeEffects) || player.activeEffects.length === 0) {
    const pendingList = cache.pendingEffects?.get(player.id);
    if (pendingList && pendingList.length > 0) {
      player.activeEffects = pendingList;
      player.isVanished = pendingList.some((e: any) => e.id?.startsWith && e.id.startsWith("vanish:"));
    } else if (Array.isArray(data.effects) && data.effects.length > 0) {
      const nowMs = Date.now();
      player.activeEffects = data.effects.map((e: any) => ({
        ...e,
        endTime: nowMs + (Number(e.remaining) || 0) * 1000,
      }));
      player.isVanished = data.effects.some((e: any) => e.id?.startsWith && e.id.startsWith("vanish:"));
    }
  }
  if (cache.pendingEffects) {
    cache.pendingEffects.delete(player.id);
  }

  if (data.id === cachedPlayerId) {
    setSelfPlayerSpriteLoaded(true);
  }

  if (data.id === cachedPlayerId) {
    setCameraX(player.position.x - window.innerWidth / 2 + 8);
    setCameraY(player.position.y - window.innerHeight / 2 + 48);
    window.scrollTo(getCameraX(), getCameraY());
    updateFriendsList({friends: data.friends || []});
    createPartyUI(data.party || [], Array.from(cache.players));
    createGuildUI(data.guild || [], data.guild_name || null);
    updateXp(data.stats.xp, data.stats.level, data.stats.max_xp);
  }
}

export { createPlayer };