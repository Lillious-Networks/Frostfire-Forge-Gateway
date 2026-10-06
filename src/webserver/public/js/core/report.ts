// The window a player reports another from: a reason picked from a few, and
// room to say what happened. The server files it, attaches what the reported
// player said that reached this one, and tells the admins who handle reports.
// The reported player is never told.
import { sendRequest } from "./socket.js";

/** The reasons a report can give: what the server calls each, and what it is called here. */
const CATEGORIES: Array<[string, string]> = [
  ["harassment", "Harassment"],
  ["spam", "Spam"],
  ["cheating", "Cheating"],
  ["name", "Offensive name"],
  ["other", "Other"],
];
/** The most the server keeps of what was typed. */
const DETAILS_MAX = 500;

export function openReportDialog(username: string) {
  document.getElementById("report-popup")?.remove();
  const name = username.charAt(0).toUpperCase() + username.slice(1);
  let category = "";

  const popup = document.createElement("div");
  popup.id = "report-popup";
  popup.className = "popup ui";

  const title = document.createElement("h2");
  title.innerText = `Report ${name}`;

  const reasons = document.createElement("div");
  reasons.className = "report-reasons";
  reasons.setAttribute("role", "radiogroup");
  reasons.setAttribute("aria-label", "Reason for the report");

  const details = document.createElement("textarea");
  details.id = "report-details";
  details.maxLength = DETAILS_MAX;
  details.placeholder = "What happened? (optional)";
  details.spellcheck = false;

  const send = document.createElement("button");
  send.id = "report-send";
  send.type = "button";
  send.innerText = "Send";
  send.disabled = true;

  const cancel = document.createElement("button");
  cancel.id = "report-cancel";
  cancel.type = "button";
  cancel.innerText = "Cancel";

  for (const [key, label] of CATEGORIES) {
    const reason = document.createElement("button");
    reason.type = "button";
    reason.className = "report-reason";
    reason.setAttribute("role", "radio");
    reason.setAttribute("aria-checked", "false");
    reason.innerText = label;
    reason.addEventListener("click", () => {
      category = key;
      for (const other of reasons.children) other.setAttribute("aria-checked", String(other === reason));
      send.disabled = false;
    });
    reasons.appendChild(reason);
  }

  const buttons = document.createElement("div");
  buttons.className = "button-container";
  buttons.append(send, cancel);
  popup.append(title, reasons, details, buttons);

  const close = () => {
    popup.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  // Escape closes it wherever the focus is. Seen first, so the game's own Escape (the pause menu) is not opened under it.
  const onKey = (event: KeyboardEvent) => {
    if (event.code !== "Escape") return;
    event.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);

  cancel.addEventListener("click", close);
  send.addEventListener("click", () => {
    if (!category) return;
    sendRequest({
      type: "REPORT_PLAYER",
      data: { username, category, details: details.value.trim() },
    });
    close();
  });

  document.body.appendChild(popup);
}
