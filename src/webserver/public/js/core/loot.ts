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
  hue?: number;
}

const particles: LootParticle[] = [];
let lastFrameTime = performance.now();

function spawnParticles(x: number, y: number, color: string, count: number, isLegendary: boolean = false): void {
  for (let i = 0; i < count; i++) {
    particles.push({
      x: x + (Math.random() - 0.5) * 10,
      y: y - 2 - Math.random() * 14,
      vy: -0.15 - Math.random() * 0.3,
      life: 0,
      maxLife: 600 + Math.random() * 800,
      color,
      size: isLegendary ? 3 + Math.random() * 3 : 1.5 + Math.random() * 2,
      ...(isLegendary ? { hue: Math.random() * 360 } : {}),
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

  const localUsername = playerId ? Array.from(cache.players).find(p => p.id === playerId)?.username : null;

  const floatOffset = Math.round(Math.sin(now * 0.002) * 4);

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
    if (p.hue !== undefined) {
      p.hue = (p.hue + 1.2) % 360;
      const r = p.size;
      const minibubble = ctx.createRadialGradient(p.x - r * 0.25, p.y - r * 0.25, 0, p.x, p.y, r);
      minibubble.addColorStop(0, `hsla(${p.hue}, 65%, 70%, 0.8)`);
      minibubble.addColorStop(0.4, `hsla(${(p.hue + 40) % 360}, 60%, 60%, 0.4)`);
      minibubble.addColorStop(1, `hsla(${(p.hue + 60) % 360}, 55%, 55%, 0)`);
      ctx.shadowColor = `hsla(${p.hue}, 70%, 55%, 0.3)`;
      ctx.fillStyle = minibubble;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      const spark = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, 0, p.x - r * 0.3, p.y - r * 0.35, r * 0.4);
      spark.addColorStop(0, `rgba(255, 255, 255, ${0.7 * alpha})`);
      spark.addColorStop(1, "transparent");
      ctx.fillStyle = spark;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.shadowColor = p.color;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  for (const loot of lootItems) {
    const sx = loot.x;
    const sy = loot.y;

    const quality = loot.quality?.toLowerCase() || "common";
    const color = QUALITY_COLORS[quality] || QUALITY_COLORS.common;
    const isOwn = String(loot.ownerId) === String(localUsername);

    const iconSize = 30;
    const iconHalf = iconSize / 2;
    const iconX = sx - iconHalf;
    const iconY = sy - 52 + floatOffset;

    const shadowW = 8 + floatOffset * 1.2;
    const shadowH = 3 + floatOffset * 0.6;
    const shadowY = sy - 8 + floatOffset;
    if (shadowW > 0 && shadowH > 0) {
      ctx.beginPath();
      ctx.ellipse(sx, shadowY, shadowW, shadowH, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.fill();
    }

    const backlightRadius = 30;

    if (quality !== "legendary") {
      const gradient = ctx.createRadialGradient(sx, iconY + iconHalf, 2, sx, iconY + iconHalf, backlightRadius);
      gradient.addColorStop(0, color + "66");
      gradient.addColorStop(0.7, color + "22");
      gradient.addColorStop(1, "transparent");
      ctx.fillStyle = gradient;
      ctx.fillRect(sx - backlightRadius, iconY + iconHalf - backlightRadius, backlightRadius * 2, backlightRadius * 2);
    }

    const img = lootImageCache?.get(loot.iconUrl);
    if (img && img.complete) {
      ctx.drawImage(img, iconX, iconY, iconSize, iconSize);
    }

    if (quality === "legendary") {
      const hueOffset = (now * 0.03) % 360;
      const cx = sx;
      const cy = iconY + iconHalf;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, backlightRadius, 0, Math.PI * 2);
      ctx.clip();

      const baseGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, backlightRadius);
      baseGlow.addColorStop(0, `hsla(${(hueOffset + 0) % 360}, 70%, 65%, 0.02)`);
      baseGlow.addColorStop(0.15, `hsla(${(hueOffset + 60) % 360}, 70%, 62%, 0.08)`);
      baseGlow.addColorStop(0.3, `hsla(${(hueOffset + 120) % 360}, 75%, 58%, 0.12)`);
      baseGlow.addColorStop(0.5, `hsla(${(hueOffset + 180) % 360}, 70%, 62%, 0.12)`);
      baseGlow.addColorStop(0.7, `hsla(${(hueOffset + 240) % 360}, 75%, 58%, 0.09)`);
      baseGlow.addColorStop(0.88, `hsla(${(hueOffset + 300) % 360}, 70%, 62%, 0.05)`);
      baseGlow.addColorStop(1, `hsla(${(hueOffset + 350) % 360}, 70%, 65%, 0.01)`);
      ctx.fillStyle = baseGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, backlightRadius, 0, Math.PI * 2);
      ctx.fill();

      const swirlSegments = 24;
      for (let i = 0; i < swirlSegments; i++) {
        const angle = (i / swirlSegments) * Math.PI * 2;
        const swirlHue = (hueOffset + angle * 25 + Math.sin(angle * 2.5 + hueOffset * 0.02) * 35) % 360;
        const r1 = backlightRadius * 0.15;
        const r2 = backlightRadius * 0.95;
        const grad = ctx.createLinearGradient(
          cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1,
          cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2,
        );
        grad.addColorStop(0, `hsla(${swirlHue}, 65%, 62%, 0)`);
        grad.addColorStop(0.35, `hsla(${swirlHue}, 60%, 60%, 0.045)`);
        grad.addColorStop(0.7, `hsla(${swirlHue}, 60%, 62%, 0.03)`);
        grad.addColorStop(1, `hsla(${swirlHue}, 65%, 62%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, backlightRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      const lightX = cx - backlightRadius * 0.3;
      const lightY = cy - backlightRadius * 0.38;
      const lightR = backlightRadius * 0.45;
      const highlight = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, lightR);
      highlight.addColorStop(0, "rgba(255, 255, 255, 0.55)");
      highlight.addColorStop(0.15, "rgba(255, 255, 255, 0.25)");
      highlight.addColorStop(0.45, "rgba(255, 255, 255, 0.04)");
      highlight.addColorStop(1, "transparent");
      ctx.fillStyle = highlight;
      ctx.beginPath();
      ctx.arc(cx, cy, backlightRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, backlightRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.lineWidth = 1;
      ctx.stroke();
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
      spawnParticles(sx, sy - 30 + floatOffset, color, isOwn ? 3 : 1, quality === "legendary");
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

  const localUsername = Array.from(cache.players).find(p => p.id === playerId)?.username;
  if (!localUsername) return;

  let nearestLoot: any = null;
  let nearestDist = Infinity;

  for (const loot of lootItems) {
    if (String(loot.ownerId) !== String(localUsername)) continue;
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

export function renderLootChests(
  ctx: CanvasRenderingContext2D,
  cameraX: number, cameraY: number,
  _playerId: string | null,
): void {
  const cache = Cache.getInstance();
  const chests = cache.lootChests || [];
  if (chests.length === 0) return;

  const now = performance.now();
  const fo = Math.round(Math.sin(now * 0.0015) * 3);
  ctx.save();
  for (const c of chests) {
    const sx = c.x, sy = c.y;
    const sz = 44, h = sz / 2, x = sx - h, y = sy - 56 + fo;
    const sw = 10 + fo * 1.2, sh = 4 + fo * 0.6, sy2 = sy - 6 + fo;
    if (sw > 0 && sh > 0) { ctx.beginPath(); ctx.ellipse(sx, sy2, sw, sh, 0, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fill(); }
    const gs = 36;
    const g = ctx.createRadialGradient(sx, sy - 36, 2, sx, sy - 36, gs);
    g.addColorStop(0, "rgba(255,215,0,0.12)"); g.addColorStop(0.7, "rgba(255,215,0,0.03)"); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(sx - gs, sy - 36 - gs, gs * 2, gs * 2);
    const img = lootImageCache?.get(c.iconUrl);
    if (img && img.complete) { ctx.drawImage(img, x, y, sz, sz); }
    ctx.font = "bold 9px 'Comic Relief', sans-serif"; ctx.textAlign = "center";
    ctx.fillStyle = "#FFD700"; ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 3;
    ctx.fillText("F", sx, y - 8);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  }
  ctx.restore();
}

export function renderChestInteractionHint(
  ctx: CanvasRenderingContext2D,
  cameraX: number, cameraY: number,
  canvasWidth: number, canvasHeight: number,
  progress: number, playerId: string | null,
): void {
  if (progress < 0) return;
  const cache = Cache.getInstance();
  const chests = cache.lootChests || [];
  if (!playerId || chests.length === 0) return;
  let nc: any = null, nd = Infinity;
  for (const c of chests) {
    const d = Math.sqrt((c.x - cameraX) ** 2 + (c.y - cameraY) ** 2);
    if (d < nd && d <= 120) { nd = d; nc = { x: c.x, y: c.y }; }
  }
  if (!nc) return;
  ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; ctx.globalAlpha = 1; ctx.lineWidth = 2;
  const dpr = window.devicePixelRatio || 1;
  const rx = (nc.x - cameraX + canvasWidth / (dpr * 2)) * dpr;
  const ry = (nc.y - 72 - cameraY + canvasHeight / (dpr * 2)) * dpr;
  const rr = 15 * dpr;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (progress > 0) {
    ctx.beginPath(); ctx.arc(rx, ry, rr + 4 * dpr, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 3 * dpr; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fill();
  ctx.strokeStyle = "rgba(255,215,0,0.8)"; ctx.lineWidth = 2 * dpr; ctx.stroke();
  ctx.fillStyle = "#FFD700"; ctx.font = `bold ${12 * dpr}px 'Comic Relief', sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("F", rx, ry);
  ctx.restore();
}

(window as any).renderLootChests = renderLootChests;
(window as any).renderChestInteractionHint = renderChestInteractionHint;
