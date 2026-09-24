// Quest state cache, packet handlers and objective tracker HUD.
// The quest frame (questframe.js) and quest log (questlog.js) render from
// this module's state; the server remains authoritative for everything.
import { sendRequest, cachedPlayerId, itemsByName } from "./socket.js";
import Cache from "./cache.js";
import { config } from "../web/global.js";
import { getCachedImage } from "./images.js";
import { setupItemTooltip } from "./tooltip.js";
import { applyItemFrame } from "./itemframe.js";
import { levelColor } from "./creature.js";

export interface QuestObjectiveDef {
  id: number;
  quest_id: number;
  type: string;
  target: string;
  required_count: number;
  description: string | null;
}

export interface QuestRewardDef {
  id: number;
  quest_id: number;
  item_name: string;
  quantity: number;
  is_choice: boolean;
}

export interface QuestDef {
  id: number;
  name: string;
  zone: string | null;
  offer_text: string;
  description: string;
  progress_text: string;
  completion_text: string;
  required_level: number;
  quest_level: number;
  xp_reward: number;
  copper_reward: number;
  repeatable: string;
  next_quest_id: number | null;
  objectives: QuestObjectiveDef[];
  rewards: QuestRewardDef[];
  prerequisites: number[];
}

export interface QuestEntry {
  quest_id: number;
  state: string;
  accepted_at: number;
  completed_at: number;
  times_completed: number;
  progress: Record<number, number>;
}

const MAX_TRACKED = 5;
const NPC_INTERACT_RADIUS = 120;

const state = {
  active: [] as QuestEntry[],
  completed: [] as number[],
  defs: new Map<number, QuestDef>(),
  markers: new Map<number, string>(),
  markerMap: "",
  tracked: new Set<number>(),
  selectedQuestId: null as number | null,
  lastNpcId: null as number | null,
  nearestNpcId: null as number | null,
};

function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selfPlayer(): any | null {
  const cache = Cache.getInstance();
  const players = cache.players instanceof Map ? Array.from(cache.players.values()) : Array.from(cache.players || []);
  return players.find((p: any) => p.id === cachedPlayerId) || null;
}

export function selfLevel(): number {
  const level = Number(selfPlayer()?.stats?.level);
  return Number.isFinite(level) && level > 0 ? level : 1;
}

/**
 * Fill `${player...}` placeholders in NPC text from the current player:
 * `${player.name}` is the username, `${player.level}` the level, and any
 * other dotted path (e.g. `${player.stats.health}`, `${player.guild}`)
 * resolves against the player object. Unknown paths stay as written.
 */
export function formatNpcText(text: unknown): string {
  const raw = String(text ?? "");
  if (!raw.includes("${")) return raw;
  const self: any = selfPlayer();
  return raw.replace(/\$\{player\.([A-Za-z0-9_.]+)\}/g, (match: string, path: string) => {
    if (!self) return match;
    let value: unknown;
    if (path === "name") {
      value = self.username;
    } else if (path === "level") {
      value = self.stats?.level;
    } else {
      let cur: any = self;
      for (const part of path.split(".")) {
        if (cur === null || cur === undefined) break;
        cur = cur[part];
      }
      value = cur;
    }
    if (value === undefined || value === null) return match;
    if (typeof value === "object") return match;
    return String(value);
  });
}

export function getQuest(id: number): QuestDef | undefined {
  return state.defs.get(Number(id));
}

export function getEntry(questId: number): QuestEntry | undefined {
  return state.active.find((e) => e.quest_id === Number(questId));
}

export function getActiveQuests(): QuestEntry[] {
  return state.active;
}

export function getCompletedQuests(): number[] {
  return state.completed;
}

export function cacheQuestDef(quest: QuestDef): void {
  if (quest && quest.id !== undefined && quest.id !== null) {
    state.defs.set(Number(quest.id), quest);
  }
}

export function getSelectedQuestId(): number | null {
  return state.selectedQuestId;
}

export function setSelectedQuestId(id: number | null): void {
  state.selectedQuestId = id;
}

export function isTracked(questId: number): boolean {
  return state.tracked.has(Number(questId));
}

export function toggleTracked(questId: number): void {
  const id = Number(questId);
  if (state.tracked.has(id)) {
    state.tracked.delete(id);
  } else {
    state.tracked.add(id);
    while (state.tracked.size > MAX_TRACKED) {
      const oldest = state.tracked.values().next().value as number | undefined;
      if (oldest === undefined) break;
      state.tracked.delete(oldest);
    }
  }
  renderTracker();
}

function ensureTrackedDefaults(): void {
  for (const entry of state.active) {
    if (state.tracked.size >= MAX_TRACKED) break;
    state.tracked.add(entry.quest_id);
  }
  // Drop tracked ids that are no longer active.
  for (const id of Array.from(state.tracked)) {
    if (!state.active.some((e) => e.quest_id === id)) state.tracked.delete(id);
  }
}

export function questLevelColor(quest: QuestDef): string {
  return levelColor(quest.quest_level || quest.required_level || 1, selfLevel());
}

export function objectiveLabel(objective: QuestObjectiveDef): string {
  if (objective.description) return objective.description;
  if (objective.type === "kill") return `Slay ${objective.target}`;
  if (objective.type === "collect") return `${objective.target}`;
  if (objective.type === "talk") return "Talk to quest giver";
  return `Explore ${objective.target}`;
}

export function objectiveText(quest: QuestDef, entry: QuestEntry | undefined): string[] {
  return (quest.objectives || []).map((o) => {
    const count = Math.min(Number(entry?.progress?.[o.id]) || 0, o.required_count);
    const done = count >= o.required_count;
    return `${objectiveLabel(o)} ${count}/${o.required_count}${done ? " ✓" : ""}`;
  });
}

function findItemDetails(itemName: string): any | undefined {
  const key = String(itemName).toLowerCase();
  const byName = itemsByName.get(itemName) || itemsByName.get(key);
  if (byName) return byName;
  const cache = Cache.getInstance();
  const inventory = Array.isArray(cache.inventory) ? cache.inventory : [];
  return inventory.find((i: any) => String(i?.name || i?.item || "").toLowerCase() === key);
}

export function iconUrlForItem(itemName: string): string {
  const url = findItemDetails(itemName)?.iconUrl;
  if (url) return url;
  return `${config.ASSET_SERVER_URL}/icon?name=${encodeURIComponent(itemName)}`;
}

// Full item details for the tooltip: stats, quality, type, description.
// Falls back to a bare name so the tooltip still opens for unknown items.
export function rewardItemDetails(itemName: string, quantity: number): any {
  const details = findItemDetails(itemName);
  if (details) return { ...details, quantity };
  return { name: itemName, quantity };
}

// Reward icon slot reusing the .slot markup so item tooltips work for free.
export function makeRewardSlot(itemName: string, quantity: number, opts?: { choice?: boolean; selected?: boolean; onClick?: () => void }): HTMLDivElement {
  const slot = document.createElement("div");
  slot.className = "quest-reward-slot ui" + (opts?.choice ? " choice" : "") + (opts?.selected ? " selected" : "");
  // Same quality border as inventory and loot windows.
  applyItemFrame(slot, findItemDetails(itemName)?.quality);
  const img = getCachedImage(iconUrlForItem(itemName));
  slot.appendChild(img);
  if (quantity > 1) {
    const qty = document.createElement("span");
    qty.className = "quest-reward-qty";
    qty.textContent = String(quantity);
    slot.appendChild(qty);
  }
  // Hover on desktop, press-and-hold inspect on touch (shared helper also
  // suppresses the follow-up tap so a hold never selects a choice reward).
  setupItemTooltip(slot, () => rewardItemDetails(itemName, quantity));
  if (opts?.onClick) {
    slot.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onClick!();
    });
  }
  return slot;
}

export function formatCopper(copper: number): string {
  const total = Math.max(0, Math.floor(Number(copper) || 0));
  const gold = Math.floor(total / 10000);
  const silver = Math.floor((total % 10000) / 100);
  const rest = total % 100;
  const parts: string[] = [];
  if (gold) parts.push(`${gold}g`);
  if (silver) parts.push(`${silver}s`);
  if (rest || parts.length === 0) parts.push(`${rest}c`);
  return parts.join(" ");
}

// ------------------------------------------------------------ tracker HUD

export function renderTracker(): void {
  const el = document.getElementById("quest-tracker");
  if (!el) return;
  const tracked = state.active.filter((e) => state.tracked.has(e.quest_id));
  if (tracked.length === 0) {
    el.style.display = "none";
    el.innerHTML = "";
    return;
  }
  el.style.display = "block";
  el.innerHTML = "";
  for (const entry of tracked.slice(0, MAX_TRACKED)) {
    const quest = getQuest(entry.quest_id);
    if (!quest) continue;
    const title = document.createElement("div");
    title.className = "quest-tracker-title ui";
    title.textContent = `${quest.name}${entry.state === "ready" ? " (Complete)" : ""}`;
    title.addEventListener("click", () => {
      setSelectedQuestId(quest.id);
      import("./questlog.js").then((m) => m.openQuestLog(quest.id));
    });
    el.appendChild(title);
    for (const line of objectiveText(quest, entry)) {
      const row = document.createElement("div");
      row.className = "quest-tracker-obj ui" + (line.endsWith("✓") ? " done" : "");
      row.textContent = line;
      el.appendChild(row);
    }
  }
}

// ------------------------------------------------------------ markers

export function setMarkers(map: string, markers: Record<number, string>): void {
  state.markerMap = String(map || "").replace(".json", "");
  state.markers = new Map(
    Object.entries(markers || {}).map(([id, marker]) => [Number(id), String(marker)])
  );
}

export function getMarker(npcId: number): string | null {
  return state.markers.get(Number(npcId)) || null;
}

// ------------------------------------------------------------ NPC interact

export function updateNpcInteraction(playerX: number, playerY: number, playerMap: string): void {
  const cache = Cache.getInstance();
  const npcs = cache.npcs || [];
  const nmap = (playerMap || "").replace(".json", "").toLowerCase();
  let nearestId: number | null = null;
  let nearestDist = Infinity;
  for (const npc of npcs) {
    if (!npc || npc.hidden) continue;
    const npcMap = String((npc as any).map ?? "").replace(".json", "").toLowerCase();
    // World NPCs carry no map field; only filter when both sides name one.
    if (npcMap && nmap && npcMap !== nmap) continue;
    const nx = Number(npc.position?.x);
    const ny = Number(npc.position?.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
    const d = Math.hypot(playerX - nx, playerY - ny);
    if (d < nearestDist && d <= NPC_INTERACT_RADIUS) {
      nearestDist = d;
      nearestId = Number(npc.id);
    }
  }
  state.nearestNpcId = Number.isFinite(nearestId as number) ? nearestId : null;
}

/**
 * Quest relevance for an NPC: a marker (offer / progress / turn-in), or an
 * incomplete talk objective pointing at it. Anything else has no quest
 * business, so interacting must do nothing at all.
 */
export function hasQuestBusiness(npcId: number): boolean {
  if (state.markers.get(Number(npcId))) return true;
  const target = String(npcId);
  for (const entry of state.active) {
    const quest = state.defs.get(entry.quest_id);
    if (!quest?.objectives) continue;
    for (const o of quest.objectives) {
      if (o.type === "talk" && String(o.target) === target) {
        const count = Number(entry.progress?.[o.id]) || 0;
        if (count < o.required_count) return true;
      }
    }
  }
  return false;
}

function npcGossipLines(npcId: number): string[] {
  const npc = (Cache.getInstance().npcs || []).find((n: any) => Number(n.id) === Number(npcId));
  const raw = typeof (npc as any)?.gossip === "string" ? (npc as any).gossip : "";
  return raw.split("\n").map((s: string) => s.trim()).filter(Boolean);
}

export function hasGossip(npcId: number): boolean {
  return npcGossipLines(npcId).length > 0;
}

/** Interactable when the NPC has gossip to share or quest business. */
export function canInteractWith(npcId: number): boolean {
  return hasGossip(npcId) || hasQuestBusiness(npcId);
}

export function tryInteractNpc(): void {
  if (state.nearestNpcId === null || state.nearestNpcId === undefined) return;
  if (!canInteractWith(state.nearestNpcId)) return;
  // Talking jumps the gossip chain for an immediate visible response; the
  // per-frame tick keeps it rotating afterwards.
  import("./npc.js").then((m) => {
    try {
      m.advanceNpcGossip(state.nearestNpcId as number);
    } catch {
      // Visual only; the interact packet below still goes out.
    }
  });
  state.lastNpcId = state.nearestNpcId;
  sendRequest({ type: "NPC_INTERACT", data: { npcId: state.nearestNpcId } });
}

const isTouchDevice = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/**
 * Touch-only tap-to-talk (the E badge is desktop-only). Hit-tests an NPC at
 * world coords and talks when it has quest business and is in range.
 * Returns true when it interacted.
 */
export function tryTapInteractNpcAt(worldX: number, worldY: number): boolean {
  if (!isTouchDevice()) return false;
  const cache = Cache.getInstance();
  const slop = 24;
  const npc = (cache.npcs || []).find((n: any) => {
    if (!n || n.hidden) return false;
    const nx = Number(n.position?.x);
    const ny = Number(n.position?.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    return (
      worldX >= nx - 16 - slop && worldX <= nx + 32 + slop &&
      worldY >= ny - 24 - slop && worldY <= ny + 48 + slop
    );
  });
  if (!npc) return false;
  const id = Number((npc as any).id);
  if (!canInteractWith(id)) return false;
  import("./npc.js").then((m) => {
    try {
      m.advanceNpcGossip(id);
    } catch {
      // Visual only; the interact packet below still goes out.
    }
  });
  const self = selfPlayer();
  const px = Number(self?.position?.x);
  const py = Number(self?.position?.y);
  if (Number.isFinite(px) && Number.isFinite(py)) {
    if (Math.hypot(px - Number(npc.position.x), py - Number(npc.position.y)) > NPC_INTERACT_RADIUS) return false;
  }
  state.lastNpcId = id;
  sendRequest({ type: "NPC_INTERACT", data: { npcId: id } });
  return true;
}

(window as any).updateNpcInteraction = updateNpcInteraction;

export function getNearestNpcId(): number | null {
  return state.nearestNpcId;
}

export function getLastNpcId(): number | null {
  return state.lastNpcId;
}

export function setLastNpcId(id: number | null): void {
  state.lastNpcId = id;
}

// ------------------------------------------------------------ view refresh

export function refreshQuestViews(): void {
  refreshViews();
}

function refreshViews(): void {
  renderTracker();
  import("./questframe.js").then((m) => {
    try {
      m.refreshOpenFrame();
    } catch {
      // Frame module not ready.
    }
  });
  import("./questlog.js").then((m) => {
    try {
      m.refreshOpenLog();
    } catch {
      // Log module not ready.
    }
  });
}

// ------------------------------------------------------------ packet entry

export function handleQuestLog(data: any): void {
  state.active = Array.isArray(data?.active) ? data.active : [];
  state.completed = Array.isArray(data?.completed) ? data.completed : [];
  for (const quest of data?.definitions || []) {
    if (quest && quest.id !== undefined) state.defs.set(Number(quest.id), quest);
  }
  ensureTrackedDefaults();
  refreshViews();
}

export function handleQuestLogEntry(data: any): void {
  const quest = data?.quest;
  if (quest && quest.id !== undefined) state.defs.set(Number(quest.id), quest);
  const entry = data?.entry as QuestEntry | null;
  if (entry) {
    state.active = state.active.filter((e) => e.quest_id !== entry.quest_id);
    state.active.push(entry);
    state.completed = state.completed.filter((id) => id !== entry.quest_id);
  } else if (data?.removed && quest) {
    const id = Number(quest.id);
    state.active = state.active.filter((e) => e.quest_id !== id);
    if (!state.completed.includes(id)) state.completed.push(id);
    state.tracked.delete(id);
  }
  ensureTrackedDefaults();
  refreshViews();
  if (entry && (entry.state === "active" || entry.state === "ready")) {
    import("./questframe.js").then((m) => {
      try {
        m.closeOfferIfAccepted(entry.quest_id);
      } catch {
        // Frame module not ready.
      }
    });
  }
}

export function handleQuestProgress(data: any): void {
  const questId = Number(data?.questId);
  const entry = getEntry(questId);
  if (!entry) return;
  for (const update of data?.updates || []) {
    entry.progress[Number(update.objectiveId)] = Number(update.count) || 0;
    if (update.questReady) entry.state = "ready";
  }
  const quest = getQuest(questId);
  if (quest && !state.tracked.has(questId) && state.tracked.size < MAX_TRACKED) {
    state.tracked.add(questId);
  }
  refreshViews();
}

export function handleQuestMarkers(data: any): void {
  setMarkers(String(data?.map || ""), (data?.markers || {}) as Record<number, string>);
}

export { escapeHtml };
