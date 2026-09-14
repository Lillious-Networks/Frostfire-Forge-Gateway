import {sendRequest, cachedPlayerId} from "./socket.js";
import { isSelfDead } from "./death.js";
import Cache from "./cache.js";
const cache = Cache.getInstance();
import encryptRsa from "./crypto.js";
import { chatInput } from "./ui.js";
const isCryptoSupported = typeof window?.crypto?.subtle === "object" && Object.keys(window.crypto.subtle).length !== 0;

// Monotonic send counter: the bubble-clear timer below must only clear the
// message from its own send, not a newer one typed since.
let chatSendSeq = 0;

async function handleChatMessage(message: string) {
  // Corpses cannot talk. Ghost /s is filtered server-side (admins exempt).
  if (isSelfDead()) return;
  const mySeq = ++chatSendSeq;
  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    const encryptedMessage = await encryptRsa(chatDecryptionKey, message || " ");
    sendRequest({
      type: "CHAT",
      data: { message: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sendRequest({
      type: "CHAT",
      data: { message: message || " ", mode: null }
    });
  }

  setTimeout(() => {
    // Match by send order, not content: the server may echo back altered
    // text (e.g. ghost spirit-tongue), which would never equal `message`
    // and leave the bubble up forever.
    if (chatSendSeq !== mySeq) return;
    const currentPlayer = Array.from(cache.players).find(player => player.id === cachedPlayerId);
    if (currentPlayer?.chat) {
      sendRequest({ type: "CHAT", data: null });
    }
  }, 7000 + message.length * 35);
}

async function handleCommand(message: string) {
  // Corpses may use chat channels (/p /w /g); the server filters the rest.
  // Ghost party/whisper/guild flows to the server, which filters only /s.
  const command = message.substring(1);
  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    const encryptedMessage = await encryptRsa(chatDecryptionKey, command || " ");
    sendRequest({
      type: "COMMAND",
      data: { command: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sendRequest({
      type: "COMMAND",
      data: { command: command || " ", }
    });
  }
}

function getLines(ctx: any, text: string, maxWidth: number) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + " " + word).width;
    if (width < maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

export { handleChatMessage, handleCommand, chatInput, getLines };