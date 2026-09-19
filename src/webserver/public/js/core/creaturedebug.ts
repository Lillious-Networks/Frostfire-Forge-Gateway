// Editor overlays drawn in the game world: spawn markers, the patrol path being
// drawn, aggro/leash circles and the live threat list.
import creatureEditor from "./creatureeditor.js";
import { creatures } from "./creature.js";

const COLORS = {
  aggro: "rgba(255, 80, 80, 0.75)",
  assist: "rgba(255, 170, 60, 0.6)",
  callForHelp: "rgba(255, 220, 80, 0.5)",
  leash: "rgba(80, 160, 255, 0.6)",
  wander: "rgba(120, 255, 140, 0.5)",
  path: "rgba(255, 255, 255, 0.8)",
  spawn: "rgba(120, 200, 255, 0.9)",
};

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, dash: number[] = []): void {
  if (radius <= 0) return;
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function polyline(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, color: string, close: boolean): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  if (close && points.length > 2) ctx.closePath();
  ctx.stroke();
  ctx.font = "bold 10px 'Comic Relief'";
  ctx.textAlign = "center";
  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(String(i + 1), p.x, p.y - 8);
  });
  ctx.restore();
}

/** Drawn in world space, after creatures. */
export function renderCreatureEditorOverlays(ctx: CanvasRenderingContext2D, currentMap: string): void {
  if (!creatureEditor.isActive) return;

  // Saved spawn points on this map.
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "10px 'Comic Relief'";
  for (const spawn of creatureEditor.spawnsOnMap(currentMap)) {
    ctx.strokeStyle = COLORS.spawn;
    ctx.fillStyle = COLORS.spawn;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(spawn.x - 6, spawn.y);
    ctx.lineTo(spawn.x, spawn.y - 6);
    ctx.lineTo(spawn.x + 6, spawn.y);
    ctx.lineTo(spawn.x, spawn.y + 6);
    ctx.closePath();
    ctx.stroke();
    ctx.fillText(`${creatureEditor.templateName(spawn.template_id)} #${spawn.id}`, spawn.x, spawn.y - 10);
  }
  ctx.restore();

  if (creatureEditor.mode === "drawPath") polyline(ctx, creatureEditor.pathPoints, COLORS.path, false);

  if (!creatureEditor.debugOn) return;
  for (const debug of creatureEditor.debugCreatures) {
    const view = creatures.get(debug.id);
    if (!view) continue;
    const x = view.renderX;
    const y = view.renderY + 8;
    circle(ctx, x, y, debug.radii.aggro, COLORS.aggro);
    circle(ctx, x, y, debug.radii.assist, COLORS.assist, [4, 4]);
    circle(ctx, x, y, debug.radii.callForHelp, COLORS.callForHelp, [2, 6]);
    circle(ctx, debug.home.x, debug.home.y, debug.radii.wander, COLORS.wander, [6, 4]);
    const leashCenter = debug.combatStart ?? debug.home;
    circle(ctx, leashCenter.x, leashCenter.y, debug.radii.leash, COLORS.leash, [8, 6]);
    if (debug.path.length > 0) polyline(ctx, [{ x, y }, ...debug.path], "rgba(255,255,255,0.35)", false);

    ctx.save();
    ctx.font = "bold 10px 'Comic Relief'";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${debug.state}${debug.victimId ? ` → ${debug.threat.find((t) => t.unitId === debug.victimId)?.name ?? ""}` : ""}`, x, y - 44);
    ctx.restore();
  }
}

/** Threat table for the targeted creature, drawn in screen space. */
export function renderThreatPanel(ctx: CanvasRenderingContext2D): void {
  if (!creatureEditor.isActive || !creatureEditor.debugOn) return;
  const debug = creatureEditor.targetedThreat();
  if (!debug || debug.threat.length === 0) return;

  const width = 230;
  const rowHeight = 14;
  const height = 22 + debug.threat.length * rowHeight;
  const x = 12;
  const y = window.innerHeight - height - 12;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.strokeRect(x, y, width, height);
  ctx.font = "bold 11px 'Comic Relief'";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffd75e";
  ctx.fillText(`Threat — creature #${debug.id}`, x + 8, y + 15);

  ctx.font = "10px 'Comic Relief'";
  debug.threat.forEach((entry, i) => {
    const rowY = y + 28 + i * rowHeight;
    const isVictim = entry.unitId === debug.victimId;
    // 110% (melee) and 130% (ranged) are the thresholds to pull aggro.
    const marker = isVictim ? "◀" : entry.pctOfVictim >= 130 ? "130%+" : entry.pctOfVictim >= 110 ? "110%+" : "";
    ctx.fillStyle = isVictim ? "#ff8080" : "#ffffff";
    ctx.fillText(entry.name, x + 8, rowY);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(entry.threat)} (${Math.round(entry.pctOfVictim)}%) ${marker}`, x + width - 8, rowY);
    ctx.textAlign = "left";
  });
  ctx.restore();
}
