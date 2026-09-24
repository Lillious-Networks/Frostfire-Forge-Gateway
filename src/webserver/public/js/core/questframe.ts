// NPC-facing quest popup: offer / incomplete / turn-in modes plus the gossip
// menu, rendered into the two-page #quest-frame-container book panel.
import { sendRequest } from "./socket.js";
import Cache from "./cache.js";
import {
  getQuest,
  getEntry,
  cacheQuestDef,
  objectiveText,
  makeRewardSlot,
  setLastNpcId,
  getLastNpcId,
  selfLevel,
  formatNpcText,
  escapeHtml,
  type QuestDef,
} from "./quest.js";

type FrameMode = "offer" | "incomplete" | "turnin" | "gossip" | null;

const frameState: {
  mode: FrameMode;
  npcId: number | null;
  questId: number | null;
  choiceIndex: number | null;
  canAccept: boolean;
  reason: string | undefined;
  gossip: any[];
} = { mode: null, npcId: null, questId: null, choiceIndex: null, canAccept: false, reason: undefined, gossip: [] };

function container(): HTMLElement | null {
  return document.getElementById("quest-frame-container");
}

function leftEl(): HTMLElement | null {
  return document.getElementById("quest-frame-left");
}

function rightEl(): HTMLElement | null {
  return document.getElementById("quest-frame-right");
}

function hideFrame(): void {
  const el = container();
  if (el) {
    el.style.display = "none";
    el.classList.remove("open");
  }
  const title = document.getElementById("quest-frame-title");
  if (title) title.textContent = "";
  frameState.mode = null;
  frameState.questId = null;
  frameState.choiceIndex = null;
}

function showFrame(): void {
  const el = container();
  if (!el) return;
  // The frame is a transient popup, not a floating-ui panel.
  el.style.display = "flex";
  el.classList.add("open");
}

function paintFrameTitle(text: string): void {
  const title = document.getElementById("quest-frame-title");
  if (title) title.textContent = text;
}

function objectivesHtml(quest: QuestDef): string {
  const entry = getEntry(quest.id);
  const lines = objectiveText(quest, entry);
  if (lines.length === 0) return "";
  return `<div class="quest-text ui" style="font-weight:700">Objectives:</div>` + lines.map((line) => `<div class="quest-objective ui${line.endsWith("✓") ? " done" : ""}">&bull; ${escapeHtml(line)}</div>`).join("");
}

function rewardsScrollHtml(quest: QuestDef): string {
  const guaranteed = (quest.rewards || []).filter((r) => !r.is_choice);
  const choices = (quest.rewards || []).filter((r) => r.is_choice);
  if (choices.length === 0 && guaranteed.length === 0) return "";
  let html = `<div class="quest-rewards ui"><div class="quest-rewards-title ui">Rewards</div>`;
  if (choices.length > 0) {
    html += `<div class="quest-text ui" style="font-weight:700">Choose one:</div><div class="quest-rewards-row ui" id="quest-choice-row"></div>`;
  }
  if (guaranteed.length > 0) {
    html += `<div class="quest-text ui" style="font-weight:700">You will receive:</div><div class="quest-rewards-row ui" id="quest-guaranteed-row"></div>`;
  }
  return html + `</div>`;
}

// XP and copper live in the pinned footer under the icons, never floating at
// the top of the page. Money shows real coin icons, not letter shorthands.
export function coinHtml(totalCopper: number): string {
  const total = Math.max(0, Math.floor(Number(totalCopper) || 0));
  if (total <= 0) return "";
  const gold = Math.floor(total / 10000);
  const silver = Math.floor((total % 10000) / 100);
  const copper = total % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-gold"></span>${gold}</span>`);
  if (silver > 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-silver"></span>${silver}</span>`);
  if (copper > 0 || parts.length === 0) parts.push(`<span class="quest-coin ui"><span class="currency-icon currency-icon-copper"></span>${copper}</span>`);
  return parts.join("");
}

function payoutHtml(quest: QuestDef): string {
  const coins = coinHtml(quest.copper_reward);
  const xp = quest.xp_reward > 0 ? `<span>${quest.xp_reward} XP</span>` : "";
  if (!xp && !coins) return "";
  return `<div class="quest-payout ui">${xp}${coins}</div>`;
}

function footHtml(payout: string, buttons: Array<{ id: string; label: string; disabled?: boolean; danger?: boolean }>): string {
  return `<div class="quest-foot ui">${payout}${buttonsHtml(buttons)}</div>`;
}

function mountRewardSlots(quest: QuestDef, mode: FrameMode): void {
  const guaranteed = (quest.rewards || []).filter((r) => !r.is_choice);
  const choices = (quest.rewards || []).filter((r) => r.is_choice);
  const choiceRow = document.getElementById("quest-choice-row");
  if (choiceRow) {
    choices.forEach((reward, index) => {
      const slot = makeRewardSlot(reward.item_name, reward.quantity, {
        choice: true,
        selected: frameState.choiceIndex === index,
        onClick: mode === "turnin" ? () => {
          frameState.choiceIndex = index;
          openTurnIn(frameState.npcId, quest);
        } : undefined,
      });
      choiceRow.appendChild(slot);
    });
  }
  const guaranteedRow = document.getElementById("quest-guaranteed-row");
  if (guaranteedRow) {
    for (const reward of guaranteed) {
      guaranteedRow.appendChild(makeRewardSlot(reward.item_name, reward.quantity));
    }
  }
}

function buttonsHtml(buttons: Array<{ id: string; label: string; disabled?: boolean; danger?: boolean }>): string {
  return `<div class="quest-buttons ui">` + buttons.map((b) => `<button type="button" id="${b.id}" class="ui${b.danger ? " danger" : ""}"${b.disabled ? " disabled" : ""}>${escapeHtml(b.label)}</button>`).join("") + `</div>`;
}

function closeOtherQuestPanels(): void {
  const log = document.getElementById("quest-log-container");
  if (log) {
    log.style.display = "none";
    log.classList.remove("open");
  }
}

export function openOffer(npcId: number | null, quest: QuestDef, canAccept: boolean, reason?: string): void {
  frameState.mode = "offer";
  frameState.npcId = npcId;
  frameState.questId = quest.id;
  frameState.choiceIndex = null;
  frameState.canAccept = canAccept;
  frameState.reason = reason;
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  closeOtherQuestPanels();
  paintFrameTitle(quest.name);
  const reasonNote = !canAccept && reason
    ? `<div class="quest-text ui">${escapeHtml(reason === "level_too_low" ? "You are not high enough level for this quest."
      : reason === "missing_prerequisite" ? "Complete the previous quest first."
      : reason === "log_full" ? "Your quest log is full."
      : reason === "daily_not_reset" ? "This daily quest is not available yet."
      : "You cannot accept this quest right now.")}</div>`
    : "";
  const rightBody = rewardsScrollHtml(quest);
  const payout = payoutHtml(quest);
  const buttons = [
    { id: "quest-accept-btn", label: "Accept", disabled: !canAccept },
    { id: "quest-decline-btn", label: "Decline", danger: true },
  ] as Array<{ id: string; label: string; disabled?: boolean; danger?: boolean }>;
  if (rightBody || payout) {
    // Rewards/payout exist: classic two-page spread, description left.
    right.style.display = "";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.offer_text)}</div>` + objectivesHtml(quest) + `</div>`;
    right.innerHTML = `<div class="quest-scroll ui">${rightBody}</div>` + footHtml(reasonNote + payout, buttons);
  } else {
    // No right-side content: description spans the full book width with the
    // buttons pinned under it.
    right.innerHTML = "";
    right.style.display = "none";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.offer_text)}</div>` + objectivesHtml(quest) + `</div>` + footHtml(reasonNote, buttons);
  }
  mountRewardSlots(quest, "offer");
  document.getElementById("quest-accept-btn")?.addEventListener("click", () => {
    if (npcId === null || npcId === undefined) return;
    sendRequest({ type: "QUEST_ACCEPT", data: { npcId, questId: quest.id } });
  });
  document.getElementById("quest-decline-btn")?.addEventListener("click", () => {
    sendRequest({ type: "QUEST_DECLINE", data: { npcId, questId: quest.id } });
    hideFrame();
  });
  showFrame();
}

export function openIncomplete(npcId: number | null, quest: QuestDef): void {
  frameState.mode = "incomplete";
  frameState.npcId = npcId;
  frameState.questId = quest.id;
  frameState.choiceIndex = null;
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  closeOtherQuestPanels();
  paintFrameTitle(quest.name);
  const rightBody = rewardsScrollHtml(quest);
  const payout = payoutHtml(quest);
  const buttons = [{ id: "quest-close-btn", label: "Close" }] as Array<{ id: string; label: string; disabled?: boolean; danger?: boolean }>;
  if (rightBody || payout) {
    right.style.display = "";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.progress_text)}</div>` + objectivesHtml(quest) + `</div>`;
    right.innerHTML = `<div class="quest-scroll ui">${rightBody}</div>` + footHtml(payout, buttons);
  } else {
    right.innerHTML = "";
    right.style.display = "none";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.progress_text)}</div>` + objectivesHtml(quest) + `</div>` + footHtml("", buttons);
  }
  mountRewardSlots(quest, "incomplete");
  document.getElementById("quest-close-btn")?.addEventListener("click", () => hideFrame());
  showFrame();
}

export function openTurnIn(npcId: number | null, quest: QuestDef): void {
  frameState.mode = "turnin";
  frameState.npcId = npcId;
  frameState.questId = quest.id;
  const choices = (quest.rewards || []).filter((r) => r.is_choice);
  // Keep a valid pick across re-renders (clicking a choice re-opens the frame).
  if (frameState.choiceIndex === null || frameState.choiceIndex === undefined || frameState.choiceIndex < 0 || frameState.choiceIndex >= choices.length) {
    frameState.choiceIndex = null;
  }
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  closeOtherQuestPanels();
  paintFrameTitle(quest.name);
  const needsChoice = choices.length > 0;
  const ready = !needsChoice || frameState.choiceIndex !== null;
  const rightBody = rewardsScrollHtml(quest);
  const payout = payoutHtml(quest);
  const buttons = [
    { id: "quest-complete-btn", label: "Complete", disabled: !ready },
    { id: "quest-cancel-btn", label: "Cancel", danger: true },
  ] as Array<{ id: string; label: string; disabled?: boolean; danger?: boolean }>;
  if (rightBody || payout) {
    right.style.display = "";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.completion_text)}</div>` + objectivesHtml(quest) + `</div>`;
    right.innerHTML = `<div class="quest-scroll ui">${rightBody}</div>` + footHtml(payout, buttons);
  } else {
    right.innerHTML = "";
    right.style.display = "none";
    left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(quest.completion_text)}</div>` + objectivesHtml(quest) + `</div>` + footHtml("", buttons);
  }
  mountRewardSlots(quest, "turnin");
  document.getElementById("quest-complete-btn")?.addEventListener("click", () => {
    if (npcId === null || npcId === undefined) return;
    const data: any = { npcId, questId: quest.id };
    if (frameState.choiceIndex !== null && frameState.choiceIndex !== undefined) {
      data.rewardChoiceIndex = frameState.choiceIndex;
    }
    sendRequest({ type: "QUEST_TURN_IN", data });
  });
  document.getElementById("quest-cancel-btn")?.addEventListener("click", () => hideFrame());
  showFrame();
}

export function openGossip(npcId: number, name: string | null, gossipText: string | null, quests: any[]): void {
  frameState.mode = "gossip";
  frameState.npcId = npcId;
  frameState.questId = null;
  // Locked quests are never listed: under-leveled ones stay hidden until the
  // player qualifies, and prerequisite-locked ones until the chain reaches
  // them (markers and views refresh live on level-up and turn-in).
  const level = selfLevel();
  frameState.gossip = Array.isArray(quests)
    ? quests.filter((offer: any) => Number(offer?.requiredLevel || 0) <= level && offer?.reason !== "missing_prerequisite")
    : [];
  setLastNpcId(npcId);
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  closeOtherQuestPanels();
  paintFrameTitle(name || "Stranger");
  const markerIcon = (marker: string): string => {
    if (marker === "ready") return '<img class="quest-marker-icon ui" src="/img/ui/ui-quest-complete.png" alt="?"> ';
    if (marker === "available") return '<img class="quest-marker-icon ui" src="/img/ui/ui-quest-available.png" alt="!"> ';
    if (marker === "in_progress") return '<img class="quest-marker-icon grey ui" src="/img/ui/ui-quest-complete.png" alt="?"> ';
    return '<img class="quest-marker-icon grey ui" src="/img/ui/ui-quest-available.png" alt="!"> ';
  };
  left.innerHTML = `<div class="quest-scroll ui"><div class="quest-text ui">${escapeHtml(formatNpcText(gossipText || ""))}</div>` + (
    frameState.gossip.length > 0
      ? frameState.gossip.map((offer: any) => `<div class="quest-gossip-row ui" data-quest-id="${offer.questId}">${markerIcon(offer.marker)}${escapeHtml(offer.name)}</div>`).join("")
      : ""
  ) + `</div>` + footHtml("", [{ id: "quest-gossip-close-btn", label: "Goodbye" }]);
  right.innerHTML = "";
  right.style.display = "none";
  left.querySelectorAll(".quest-gossip-row").forEach((row) => {
    row.addEventListener("click", () => {
      const questId = Number((row as HTMLElement).dataset.questId);
      if (!Number.isFinite(questId)) return;
      sendRequest({ type: "QUEST_SELECT", data: { npcId, questId } });
    });
  });
  document.getElementById("quest-gossip-close-btn")?.addEventListener("click", () => hideFrame());
  showFrame();
}

export function closeQuestFrame(): void {
  hideFrame();
}

// Walking away from the NPC closes the frame. A little beyond the server's
// interact radius so it doesn't flicker at the boundary; accept/turn-in past
// the radius are still rejected server-side with an error note.
const FRAME_CLOSE_RADIUS = 160;

export function checkFrameProximity(playerX: number, playerY: number): void {
  if (frameState.mode === null || frameState.npcId === null || frameState.npcId === undefined) return;
  const cache = Cache.getInstance();
  const npc = (cache.npcs || []).find((n: any) => Number(n.id) === Number(frameState.npcId));
  if (!npc || npc.hidden) {
    hideFrame();
    return;
  }
  const nx = Number(npc.position?.x);
  const ny = Number(npc.position?.y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  if (Math.hypot(playerX - nx, playerY - ny) > FRAME_CLOSE_RADIUS) {
    hideFrame();
  }
}

(window as any).updateQuestFrameProximity = checkFrameProximity;

// The offer served its purpose once the quest lands in the log.
export function closeOfferIfAccepted(questId: number): void {
  if (frameState.mode === "offer" && frameState.questId === Number(questId)) {
    hideFrame();
  }
}

// Re-render the open frame from cached state after a progress/entry update.
export function refreshOpenFrame(): void {
  if (frameState.mode === null || frameState.mode === "gossip") return;
  const questId = frameState.questId;
  if (questId === null || questId === undefined) return;
  const quest = getQuest(questId);
  if (!quest) {
    hideFrame();
    return;
  }
  if (frameState.mode === "offer") openOffer(frameState.npcId, quest, frameState.canAccept, frameState.reason);
  else if (frameState.mode === "incomplete") openIncomplete(frameState.npcId, quest);
  else if (frameState.mode === "turnin") openTurnIn(frameState.npcId, quest);
}

// ---- socket entry points (called with dynamic import, mirroring editors)

export function onOffer(data: any): void {
  const quest = data?.quest as QuestDef | undefined;
  if (!quest) return;
  cacheQuestDef(quest);
  setLastNpcId(data?.npcId ?? getLastNpcId());
  // Locked quests are never offered or shown, even when the server would
  // display them as unavailable: below-level or prerequisite-locked.
  if (quest.required_level > selfLevel() || data?.reason === "missing_prerequisite") {
    hideFrame();
    return;
  }
  openOffer(data?.npcId ?? null, quest, data?.canAccept === true, data?.reason);
}

export function onIncomplete(data: any): void {
  const quest = data?.quest as QuestDef | undefined;
  if (!quest) return;
  cacheQuestDef(quest);
  setLastNpcId(data?.npcId ?? getLastNpcId());
  openIncomplete(data?.npcId ?? null, quest);
}

export function onTurnInOffer(data: any): void {
  const quest = data?.quest as QuestDef | undefined;
  if (!quest) return;
  cacheQuestDef(quest);
  setLastNpcId(data?.npcId ?? getLastNpcId());
  frameState.choiceIndex = null;
  openTurnIn(data?.npcId ?? null, quest);
}

export function onGossip(data: any): void {
  const quests = data?.quests || [];
  // No quests: bubble only. The chain was already advanced when the player
  // interacted (tryInteractNpc / tap), so advancing again here would skip a
  // line — the server echo must not move the conversation.
  if (quests.length === 0) return;
  openGossip(Number(data?.npcId), data?.name ?? null, data?.gossipText ?? null, quests);
}

export function onCompleted(data: any): void {
  hideFrame();
  const nextQuestId = Number(data?.nextQuestId);
  // Chain straight into the next offer WoW-style when the server names one.
  if (Number.isFinite(nextQuestId) && nextQuestId > 0) {
    const npcId = getLastNpcId();
    if (npcId !== null && npcId !== undefined) {
      sendRequest({ type: "QUEST_SELECT", data: { npcId, questId: nextQuestId } });
    }
  }
}

export function onError(data: any): void {
  const message = String(data?.message || "That didn't work.");
  const note = document.createElement("div");
  note.className = "quest-text ui";
  note.style.color = "#a02020";
  note.textContent = message;
  const right = rightEl();
  if (right && frameState.mode !== null) {
    const target = right.querySelector(".quest-scroll") || leftEl()?.querySelector(".quest-scroll") || right;
    target.appendChild(note);
    window.setTimeout(() => note.remove(), 4000);
  }
}
