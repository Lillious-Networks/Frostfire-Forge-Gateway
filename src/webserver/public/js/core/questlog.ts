// Quest log book panel (#quest-log-container): zone-grouped list on the left,
// selected quest details on the right. Opened with L.
import { sendRequest } from "./socket.js";
import {
  getQuest,
  getEntry,
  getActiveQuests,
  getSelectedQuestId,
  setSelectedQuestId,
  isTracked,
  toggleTracked,
  objectiveText,
  makeRewardSlot,
} from "./quest.js";

function container(): HTMLElement | null {
  return document.getElementById("quest-log-container");
}

function leftEl(): HTMLElement | null {
  return document.getElementById("quest-log-left");
}

function rightEl(): HTMLElement | null {
  return document.getElementById("quest-log-right");
}

let logView: "list" | "details" = "list";

export function isQuestLogOpen(): boolean {
  return container()?.style.display === "block";
}

export function openQuestLog(questId?: number | null): void {
  const el = container();
  if (!el) return;
  el.style.display = "block";
  el.classList.add("open");
  if (questId !== undefined && questId !== null) {
    setSelectedQuestId(questId);
    logView = "details";
  } else {
    logView = "list";
  }
  renderCurrentView();
}

// Re-render when open (called after log/entry/progress packets).
export function refreshOpenLog(): void {
  if (isQuestLogOpen()) renderCurrentView();
}

function renderCurrentView(): void {
  if (logView === "details") renderDetailsView();
  else renderQuestLog();
}

export function closeQuestLog(): void {
  const el = container();
  if (!el) return;
  el.style.display = "none";
  el.classList.remove("open");
}

export function toggleQuestLog(): boolean {
  if (isQuestLogOpen()) {
    closeQuestLog();
    return false;
  }
  openQuestLog();
  return true;
}

function renderQuestLog(): void {
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  const entries = getActiveQuests().slice().sort((a, b) => a.quest_id - b.quest_id);
  left.innerHTML = "";
  right.innerHTML = "";
  // List view always takes the full book width.
  left.style.flex = "1 1 100%";
  left.style.textAlign = "";
  left.style.paddingTop = "";
  left.style.display = "";
  right.style.display = "none";
  if (entries.length === 0) {
    // Centered empty state.
    left.style.textAlign = "center";
    left.style.paddingTop = "72px";
    left.innerHTML = `<div class="quest-text ui">There are no accepted quests.</div>`;
  }
  // Group by zone, preserving quest order.
  const zones = new Map<string, typeof entries>();
  for (const entry of entries) {
    const quest = getQuest(entry.quest_id);
    const zone = quest?.zone || "General";
    const list = zones.get(zone) || [];
    list.push(entry);
    zones.set(zone, list);
  }

  for (const [zone, list] of zones) {
    const zoneEl = document.createElement("div");
    zoneEl.className = "quest-log-zone ui";
    zoneEl.textContent = zone;
    left.appendChild(zoneEl);
    for (const entry of list) {
      const quest = getQuest(entry.quest_id);
      if (!quest) continue;
      const row = document.createElement("div");
      row.className = "quest-log-row ui";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = quest.name;
      row.appendChild(nameSpan);
      if (entry.state === "ready") {
        const tag = document.createElement("span");
        tag.className = "complete-tag";
        tag.textContent = " (Complete)";
        row.appendChild(tag);
      }
      if (!isTracked(entry.quest_id)) {
        row.style.opacity = "0.75";
      }
      row.addEventListener("click", () => {
        setSelectedQuestId(entry.quest_id);
        logView = "details";
        renderDetailsView();
      });
      row.addEventListener("dblclick", () => {
        setSelectedQuestId(entry.quest_id);
        toggleTracked(entry.quest_id);
        renderQuestLog();
      });
      left.appendChild(row);
    }
  }
}

function renderDetailsView(): void {
  const left = leftEl();
  const right = rightEl();
  if (!left || !right) return;
  const selected = getSelectedQuestId();
  const quest = selected === null || selected === undefined ? undefined : getQuest(selected);
  if (!quest) {
    // Details target gone (e.g. just abandoned): fall back to the list.
    logView = "list";
    renderQuestLog();
    return;
  }
  left.style.display = "none";
  right.style.display = "";
  right.style.flex = "1 1 100%";
  renderQuestDetails(right, selected);
}

function renderQuestDetails(right: HTMLElement, selected: number | null): void {
  right.innerHTML = "";
  if (selected === null || selected === undefined) return;
  const quest = getQuest(selected);
  if (!quest) return;
  const entry = getEntry(selected);
  const back = document.createElement("button");
  back.type = "button";
  back.className = "ui quest-back-btn";
  back.textContent = "‹ Quests";
  back.addEventListener("click", () => {
    logView = "list";
    renderQuestLog();
  });
  right.appendChild(back);
  const scroll = document.createElement("div");
  scroll.className = "quest-scroll ui";
  const title = document.createElement("div");
  title.className = "quest-title ui";
  title.textContent = quest.name;
  scroll.appendChild(title);
  const desc = document.createElement("div");
  desc.className = "quest-text ui";
  desc.textContent = quest.description;
  scroll.appendChild(desc);
  const objHeader = document.createElement("div");
  objHeader.className = "quest-text ui";
  objHeader.style.fontWeight = "700";
  objHeader.textContent = "Objectives:";
  scroll.appendChild(objHeader);
  for (const line of objectiveText(quest, entry)) {
    const row = document.createElement("div");
    row.className = "quest-objective ui" + (line.endsWith("✓") ? " done" : "");
    row.textContent = `• ${line}`;
    scroll.appendChild(row);
  }
  const guaranteed = (quest.rewards || []).filter((r) => !r.is_choice);
  const choices = (quest.rewards || []).filter((r) => r.is_choice);
  if (choices.length > 0 || guaranteed.length > 0) {
    const box = document.createElement("div");
    box.className = "quest-rewards ui";
    const rewardsHeader = document.createElement("div");
    rewardsHeader.className = "quest-rewards-title ui";
    rewardsHeader.textContent = "Rewards";
    box.appendChild(rewardsHeader);
    const row = document.createElement("div");
    row.className = "quest-rewards-row ui";
    for (const reward of [...choices, ...guaranteed]) {
      row.appendChild(makeRewardSlot(reward.item_name, reward.quantity));
    }
    box.appendChild(row);
    scroll.appendChild(box);
  }
  right.appendChild(scroll);
  // Payout and actions pin to the bottom of the page.
  const foot = document.createElement("div");
  foot.className = "quest-foot ui";
  {
    const total = Math.max(0, Math.floor(Number(quest.copper_reward) || 0));
    const coins: Array<{ cls: string; amount: number }> = [];
    if (total > 0) {
      const gold = Math.floor(total / 10000);
      const silver = Math.floor((total % 10000) / 100);
      const copper = total % 100;
      if (gold > 0) coins.push({ cls: "gold", amount: gold });
      if (silver > 0) coins.push({ cls: "silver", amount: silver });
      if (copper > 0 || coins.length === 0) coins.push({ cls: "copper", amount: copper });
    }
    if (quest.xp_reward > 0 || coins.length > 0) {
      const payout = document.createElement("div");
      payout.className = "quest-payout ui";
      if (quest.xp_reward > 0) {
        const xp = document.createElement("span");
        xp.textContent = `${quest.xp_reward} XP`;
        payout.appendChild(xp);
      }
      for (const coin of coins) {
        const wrap = document.createElement("span");
        wrap.className = "quest-coin ui";
        const icon = document.createElement("span");
        icon.className = `currency-icon currency-icon-${coin.cls}`;
        wrap.appendChild(icon);
        wrap.appendChild(document.createTextNode(String(coin.amount)));
        payout.appendChild(wrap);
      }
      foot.appendChild(payout);
    }
  }
  const buttons = document.createElement("div");
  buttons.className = "quest-buttons ui";
  const trackBtn = document.createElement("button");
  trackBtn.type = "button";
  trackBtn.className = "ui";
  trackBtn.textContent = isTracked(selected) ? "Untrack" : "Track";
  trackBtn.addEventListener("click", () => {
    toggleTracked(selected);
    renderDetailsView();
  });
  buttons.appendChild(trackBtn);
  const abandonBtn = document.createElement("button");
  abandonBtn.type = "button";
  abandonBtn.className = "ui danger";
  abandonBtn.textContent = "Abandon";
  abandonBtn.addEventListener("click", () => {
    if (abandonBtn.dataset.confirm === "1") {
      sendRequest({ type: "QUEST_ABANDON", data: { questId: selected } });
      delete abandonBtn.dataset.confirm;
      abandonBtn.textContent = "Abandon";
      // Back to the main list immediately; the server echo re-renders it.
      logView = "list";
      renderQuestLog();
      return;
    }
    abandonBtn.dataset.confirm = "1";
    abandonBtn.textContent = "Really abandon?";
    window.setTimeout(() => {
      if (abandonBtn.isConnected) {
        delete abandonBtn.dataset.confirm;
        abandonBtn.textContent = "Abandon";
      }
    }, 4000);
  });
  buttons.appendChild(abandonBtn);
  foot.appendChild(buttons);
  right.appendChild(foot);
}
