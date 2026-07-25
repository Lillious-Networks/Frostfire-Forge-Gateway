import Cache from "./cache.js";

const QUALITY_COLORS: Record<string, string> = {
  common: "#9d9d9d",
  uncommon: "#1eff00",
  rare: "#0070dd",
  epic: "#a335ee",
  legendary: "#ff8000",
};

interface LootParticle {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

const particles: LootParticle[] = [];
let lastFrameTime = performance.now();

function spawnParticles(x: number, y: number, color: string, count: number): void {
  for (let i = 0; i < count; i++) {
    particles.push({
      x: x + (Math.random() - 0.5) * 10,
      y: y - 2 - Math.random() * 14,
      vy: -0.15 - Math.random() * 0.3,
      life: 0,
      maxLife: 600 + Math.random() * 800,
      color,
      size: 1.5 + Math.random() * 2,
    });
  }
}

const particleSpawnTimers = new Map<string, number>();

export function renderLoot(
  ctx: CanvasRenderingContext2D,
  cameraX: number,
  cameraY: number,
  canvasWidth: number,
  canvasHeight: number,
  playerId: string | null,
): void {
  const cache = Cache.getInstance();
  const lootItems = cache.loot || [];

  if (lootItems.length === 0 && particles.length === 0) return;

  const now = performance.now();
  const delta = now - lastFrameTime;
  lastFrameTime = now;

  const floatOffset = Math.sin(now * 0.002) * 4;

  ctx.save();
  ctx.shadowBlur = 8;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += delta;
    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
      continue;
    }
    p.y += p.vy * (delta / 16);
    p.vy -= 0.01;

    const lifeProgress = p.life / p.maxLife;
    const alpha = lifeProgress < 0.2 ? lifeProgress / 0.2 : (1 - (lifeProgress - 0.2) / 0.8);
    if (alpha <= 0) continue;

    ctx.globalAlpha = alpha;
    ctx.shadowColor = p.color;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  for (const loot of lootItems) {
    const sx = loot.x;
    const sy = loot.y;

    const quality = loot.quality?.toLowerCase() || "common";
    const color = QUALITY_COLORS[quality] || QUALITY_COLORS.common;
    const isOwn = String(loot.ownerId) === String(playerId);

    const iconSize = 24;
    const iconHalf = iconSize / 2;
    const iconX = sx - iconHalf;
    const iconY = sy - 48 + floatOffset;

    const shadowW = 8 + floatOffset * 1.2;
    const shadowH = 3 + floatOffset * 0.6;
    const shadowY = sy - 8 + floatOffset;
    if (shadowW > 0 && shadowH > 0) {
      ctx.beginPath();
      ctx.ellipse(sx, shadowY, shadowW, shadowH, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fill();
    }

    const backlightRadius = 20 + (isOwn ? 6 : 0);
    const gradient = ctx.createRadialGradient(sx, iconY + iconHalf, 2, sx, iconY + iconHalf, backlightRadius);
    gradient.addColorStop(0, color + "66");
    gradient.addColorStop(0.7, color + "22");
    gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient;
    ctx.fillRect(sx - backlightRadius, iconY + iconHalf - backlightRadius, backlightRadius * 2, backlightRadius * 2);

    const img = lootImageCache?.get(loot.iconUrl);
    if (img && img.complete) {
      ctx.drawImage(img, iconX, iconY, iconSize, iconSize);
    }

    if (loot.quantity > 1) {
      ctx.font = "bold 9px 'Comic Relief', sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = "#FFF1DA";
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 2;
      ctx.fillText(`x${loot.quantity}`, sx + iconHalf - 2, iconY + iconSize - 2);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    if (!isOwn) {
      const dx = sx - cameraX;
      const dy = sy - cameraY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 150 && loot.ownerName) {
        const text = `Owned by ${loot.ownerName.charAt(0).toUpperCase() + loot.ownerName.slice(1)}`;
        ctx.font = "bold 10px 'Comic Relief', sans-serif";
        ctx.textAlign = "center";
        const tw = ctx.measureText(text).width;
        const th = 12;
        const tx = sx;
        const ty = iconY - 8;
        const pad = 6;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(tx - tw/2 - pad + r, ty - th - pad);
        ctx.lineTo(tx + tw/2 + pad - r, ty - th - pad);
        ctx.arcTo(tx + tw/2 + pad, ty - th - pad, tx + tw/2 + pad, ty - th - pad + r, r);
        ctx.lineTo(tx + tw/2 + pad, ty + pad - r);
        ctx.arcTo(tx + tw/2 + pad, ty + pad, tx + tw/2 + pad - r, ty + pad, r);
        ctx.lineTo(tx - tw/2 - pad + r, ty + pad);
        ctx.arcTo(tx - tw/2 - pad, ty + pad, tx - tw/2 - pad, ty + pad - r, r);
        ctx.lineTo(tx - tw/2 - pad, ty - th - pad + r);
        ctx.arcTo(tx - tw/2 - pad, ty - th - pad, tx - tw/2 - pad + r, ty - th - pad, r);
        ctx.closePath();
        ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        ctx.fill();
        ctx.fillStyle = "#ff4444";
        ctx.fillText(text, sx, ty - 2);
      }
    }

    const timerKey = `${loot.id}_particles`;
    const lastSpawn = particleSpawnTimers.get(timerKey) || 0;
    if (now - lastSpawn > 200) {
      spawnParticles(sx, sy - 30 + floatOffset, color, isOwn ? 3 : 1);
      particleSpawnTimers.set(timerKey, now);
    }
  }
}

let lootImageCache: Map<string, HTMLImageElement> | null = null;

export function setLootImageCache(cache: Map<string, HTMLImageElement>): void {
  lootImageCache = cache;
}

export function preloadLootIcon(url: string): void {
  if (!url) return;
  if (!lootImageCache) lootImageCache = new Map();
  if (lootImageCache.has(url)) return;
  const img = new Image();
  img.src = url;
  lootImageCache.set(url, img);
}

export function renderLootInteractionHint(
  ctx: CanvasRenderingContext2D,
  cameraX: number,
  cameraY: number,
  canvasWidth: number,
  canvasHeight: number,
  progress: number,
  playerId: string | null,
): void {
  if (progress < 0) return;
  const cache = Cache.getInstance();
  const lootItems = cache.loot || [];
  if (!playerId) return;

  let nearestLoot: any = null;
  let nearestDist = Infinity;

  for (const loot of lootItems) {
    if (String(loot.ownerId) !== String(playerId)) continue;
    const dx = loot.x - cameraX;
    const dy = loot.y - cameraY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < nearestDist && dist <= 100) {
      nearestDist = dist;
      nearestLoot = { x: loot.x, y: loot.y };
    }
  }

  if (!nearestLoot) return;

  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;

  const dpr = window.devicePixelRatio || 1;
  const x = (nearestLoot.x - cameraX + canvasWidth / (dpr * 2)) * dpr;
  const y = (nearestLoot.y - 70 - cameraY + canvasHeight / (dpr * 2)) * dpr;
  const radius = 14 * dpr;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (progress > 0) {
    const angle = progress * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4 * dpr, -Math.PI / 2, -Math.PI / 2 + angle);
    ctx.strokeStyle = "#FFD700";
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold ${12 * dpr}px 'Comic Relief', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("E", x, y);

  ctx.restore();
}
