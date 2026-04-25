import Cache from "./cache.js";
const cache = Cache.getInstance();
import { cachedPlayerId, setSelfPlayerSpriteLoaded } from "./socket.js";
import { updateFriendOnlineStatus, updateFriendsList } from "./friends.js";
import { getCameraX, getCameraY, setCameraX, setCameraY } from "./renderer.js";
import { createPartyUI, positionText } from "./ui.js";
import { updateXp } from "./xp.js";
import  { typingImage } from "./images.js";
import { getLines } from "./chat.js";
import { initializeLayeredAnimation } from "./layeredAnimation.js";
import { getVisibleLayersSorted } from "./layeredAnimation.js";

async function createPlayer(data: any) {

  if (data.id === cachedPlayerId) {
    positionText.innerText = `Position: ${Math.round(data.location.x)}, ${Math.round(data.location.y)}`;
  }

  updateFriendOnlineStatus(data.username, true);

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
    isAdmin: data.isAdmin,
    isGuest: data.isGuest || false,
    _adminColorHue: Math.floor(Math.random() * 360),
    targeted: false,
    stats: data.stats,
    typing: false,
    typingTimeout: null as NodeJS.Timeout | null,
    typingImage: typingImage,
    party: data.party || null,
    mounted: data.mounted || false,
    moving: data.location.moving || false,
    canmove: true,  // Can be set to false when being dragged by an admin
    currency: data.currency || { copper: 0, silver: 0, gold: 0 },
    chatType: "global" as "global" | "party" | "whisper",
    damageNumbers: [] as Array<{
      value: number;
      x: number;
      y: number;
      startTime: number;
      isHealing: boolean;
      isCrit: boolean;
      isMiss?: boolean;
    }>,
    castingSpell: null as string | null,
    castingStartTime: 0,
    castingDuration: 0,
    castingInterrupted: false,
    castingInterruptedProgress: undefined as number | undefined,
    showChat: function (context: CanvasRenderingContext2D) {

      if (this.typing && this.typingImage) {

        if (this.isStealth) {
          context.globalAlpha = 0.8;
        }

        context.shadowColor = "black";
        context.shadowBlur = 2;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;

        context.drawImage(
          this.typingImage,
          this.renderPosition.x - this.typingImage.width / 1.5,
          this.renderPosition.y - this.typingImage.height - 25,
          this.typingImage.width / 1.5,
          this.typingImage.height / 1.5
        );

        context.globalAlpha = 1;
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
      }

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

        if (dmg.isMiss) {

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

      const barWidth = 120;
      const barHeight = 12;
      const barX = this.position.x - barWidth / 2;
      const barY = this.position.y - 45;

      context.shadowColor = "rgba(0, 0, 0, 0.7)";
      context.shadowBlur = 8;
      context.shadowOffsetY = 3;

      context.fillStyle = "rgba(15, 15, 25, 0.95)";
      context.fillRect(barX, barY, barWidth, barHeight);

      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;

      context.fillStyle = "rgba(10, 10, 15, 0.8)";
      context.fillRect(barX + 1, barY + 1, barWidth - 2, barHeight - 2);

      if (this.castingInterrupted) {
        if (this.castingSpell === "Failed") {

          const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
          gradient.addColorStop(0, "#ef4444");
          gradient.addColorStop(0.5, "#dc2626");
          gradient.addColorStop(1, "#b91c1c");
          context.fillStyle = gradient;

          context.shadowColor = "rgba(239, 68, 68, 0.8)";
          context.shadowBlur = 10;
        } else {

          const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
          gradient.addColorStop(0, "#9ca3af");
          gradient.addColorStop(0.5, "#6b7280");
          gradient.addColorStop(1, "#4b5563");
          context.fillStyle = gradient;

          context.shadowColor = "rgba(107, 114, 128, 0.5)";
          context.shadowBlur = 6;
        }
      } else {

        const gradient = context.createLinearGradient(barX, barY, barX, barY + barHeight);
        gradient.addColorStop(0, "#a78bfa");
        gradient.addColorStop(0.5, "#8b5cf6");
        gradient.addColorStop(1, "#7c3aed");
        context.fillStyle = gradient;

        context.shadowColor = "rgba(139, 92, 246, 0.7)";
        context.shadowBlur = 12;
      }

      context.fillRect(barX + 2, barY + 2, (barWidth - 4) * progress, barHeight - 4);

      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      const highlightGradient = context.createLinearGradient(barX, barY, barX, barY + barHeight / 2);
      highlightGradient.addColorStop(0, "rgba(255, 255, 255, 0.25)");
      highlightGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      context.fillStyle = highlightGradient;
      context.fillRect(barX + 2, barY + 2, (barWidth - 4) * progress, (barHeight - 4) / 2);

      context.strokeStyle = "rgba(255, 255, 255, 0.15)";
      context.lineWidth = 1.5;
      context.strokeRect(barX + 0.5, barY + 0.5, barWidth - 1, barHeight - 1);

      context.font = "bold 11px 'Comic Relief'";
      context.fillStyle = "white";
      context.textAlign = "center";
      context.shadowColor = "rgba(0, 0, 0, 0.9)";
      context.shadowBlur = 4;
      context.shadowOffsetY = 1;
      const spellText = this.castingInterrupted ? this.castingSpell : this.castingSpell;
      context.fillText(spellText, this.position.x, barY - 5);

      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetY = 0;

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

      if (this.isStealth) {
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

      if (!this.isStealth) {
        if (data.id === cachedPlayerId || this.targeted) {
          context.fillStyle = "rgba(0, 0, 0, 0.8)";
          context.fillRect(this.renderPosition.x - 50, this.renderPosition.y + 46 + uiOffset, 100, 3);

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
            this.renderPosition.y + 46 + uiOffset,
            healthPercent * 100,
            3
          );
        }

        if (data.id === cachedPlayerId || this.targeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.renderPosition.x - 50, this.renderPosition.y + 51 + uiOffset, 100, 3);
        context.fillStyle = "#469CD9";
        const maxStamina = this.stats.total_max_stamina || this.stats.max_stamina;
        context.fillRect(
          this.renderPosition.x - 50,
            this.renderPosition.y + 51 + uiOffset,
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
          context.fillText(`${this.stats.level}`, offsetX, this.renderPosition.y + 55 + uiOffset);
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
    player.layeredAnimation = await layeredAnimationPromise;

    cache.players.add(player);

    if (cache.pendingPlayers) {
      cache.pendingPlayers.delete(player.id);
    }

    if (data.id === cachedPlayerId) {
      setSelfPlayerSpriteLoaded(true);
    }
  } else {


    cache.players.add(player);

    if (cache.pendingPlayers) {
      cache.pendingPlayers.delete(player.id);
    }
  }

  if (data.id === cachedPlayerId) {
    setCameraX(player.position.x - window.innerWidth / 2 + 8);
    setCameraY(player.position.y - window.innerHeight / 2 + 48);
    window.scrollTo(getCameraX(), getCameraY());
    updateFriendsList({friends: data.friends || []});
    createPartyUI(data.party || [], Array.from(cache.players));
    updateXp(data.stats.xp, data.stats.level, data.stats.max_xp);
  }
}

export { createPlayer };