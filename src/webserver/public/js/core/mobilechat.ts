// Chat on a touch screen (USER REQUEST 2026-10-07: "a chat bar to mobile that can be hidden and shown, as well as
// chat history").
//
// The chat a mouse has is a frame at the bottom left of the screen, where a phone held sideways has its joystick, so
// on a touch screen that frame is not shown (game.css). This puts the chat's own list of messages and its own field
// into a panel made for a phone instead, so everything the chat does (channels, whispers, commands, the messages
// sent before) is the same code on both. Three states:
//  - hidden: a button under the player's frame, with a count of what has not been read, and what was just said
//    shown beside it for a few seconds;
//  - open (the button): the messages and the field, between the player's frame and the joystick;
//  - typing (the field has the keyboard): the field alone across the top of the screen, because the keyboard
//    covers the bottom half of a phone held sideways. The messages are back when the keyboard is put away.
import { chatInput, chatMessages } from "./ui.js";
import { keyHandlers } from "./input.js";

const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)");

/** How long a message shows beside the button while the chat is hidden (the fade is game.css's, of the same length). */
const PEEK_MS = 6000;
/** How many of them at once. */
const PEEK_LINES = 3;

const button = document.getElementById("mobile-chat-btn") as HTMLButtonElement | null;
const unreadLabel = document.getElementById("mobile-chat-unread") as HTMLElement | null;
const panel = document.getElementById("mobile-chat") as HTMLElement | null;
const bar = document.getElementById("mobile-chat-bar") as HTMLElement | null;
/** The bar the field sits on, as it does with a mouse. */
const field = document.getElementById("mobile-chat-field") as HTMLElement | null;
const sendButton = document.getElementById("mobile-chat-send") as HTMLButtonElement | null;
const doneButton = document.getElementById("mobile-chat-done") as HTMLButtonElement | null;
const peek = document.getElementById("mobile-chat-peek") as HTMLElement | null;

// Where the list and the field live with a mouse: they go back there if the screen stops being a touch screen.
const messagesHome = chatMessages?.parentElement ?? null;
const inputHome = chatInput?.parentElement ?? null;

let unread = 0;

const isOpen = () => !!panel?.classList.contains("open");
const toBottom = () => { if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight; };

function showUnread(): void {
  if (unreadLabel) unreadLabel.textContent = unread <= 0 ? "" : unread > 9 ? "9+" : String(unread);
}

function openChat(): void {
  if (!panel) return;
  panel.classList.add("open");
  button?.classList.add("open");
  // All of it is read now, and what was shown beside the button is in the list.
  unread = 0;
  showUnread();
  peek?.replaceChildren();
  toBottom();
}

function closeChat(): void {
  if (!panel) return;
  if (document.activeElement === chatInput) chatInput.blur();
  panel.classList.remove("open", "typing");
  button?.classList.remove("open");
}

/** A message came in while the chat is hidden: it is counted, and shown beside the button for a while. */
function peekAt(message: HTMLElement): void {
  unread++;
  showUnread();
  if (!peek) return;
  const shown = message.cloneNode(true) as HTMLElement;
  shown.removeAttribute("id");
  peek.appendChild(shown);
  while (peek.children.length > PEEK_LINES) peek.firstElementChild?.remove();
  setTimeout(() => shown.remove(), PEEK_MS);
}

/** Puts the list and the field in the phone's panel on a touch screen, and back in the frame without one. */
function place(): void {
  if (!panel || !bar || !field || !chatMessages || !chatInput) return;
  if (TOUCH.matches) {
    panel.insertBefore(chatMessages, bar);
    field.appendChild(chatInput);
    toBottom();
  } else {
    closeChat();
    messagesHome?.appendChild(chatMessages);
    inputHome?.appendChild(chatInput);
    unread = 0;
    showUnread();
    peek?.replaceChildren();
  }
}

if (panel && bar && field && button && chatMessages && chatInput) {
  place();
  TOUCH.addEventListener("change", place);

  button.addEventListener("click", () => { if (isOpen()) closeChat(); else openChat(); });

  // The field has the keyboard: typing. It can be given it while the chat is hidden too (a whisper started from a
  // player's menu), which opens the chat. Without it again, the chat is as it was opened: the messages and the field.
  const startTyping = () => {
    if (!TOUCH.matches || panel.classList.contains("typing")) return;
    if (!isOpen()) openChat();
    panel.classList.add("typing");
    toBottom();
  };
  chatInput.addEventListener("focus", startTyping);
  // (a tap on a field that already has the keyboard gives it no second "focus": seen when the page itself had lost it)
  chatInput.addEventListener("click", () => { if (document.activeElement === chatInput) startTyping(); });
  chatInput.addEventListener("blur", () => {
    panel.classList.remove("typing");
    if (TOUCH.matches) toBottom();
  });

  // Send does what Enter does (input.ts), which on a touch screen leaves the keyboard up for the next message. A
  // press on the button is kept from taking the keyboard off the field first.
  sendButton?.addEventListener("mousedown", (event) => event.preventDefault());
  sendButton?.addEventListener("click", () => {
    chatInput.focus();
    keyHandlers.Enter();
  });
  // The X puts the keyboard away. (An empty message sent does too, as with a keyboard of keys.)
  doneButton?.addEventListener("click", () => chatInput.blur());

  // Every message is put in the list by the game (socket.ts), wherever the list is: the ones that come while the
  // chat is hidden are seen here.
  new MutationObserver((changes) => {
    if (!TOUCH.matches) return;
    for (const change of changes) {
      for (const added of Array.from(change.addedNodes)) {
        if (added instanceof HTMLElement && !isOpen()) peekAt(added);
      }
    }
  }).observe(chatMessages, { childList: true });
}

export { openChat as openMobileChat, closeChat as closeMobileChat };
