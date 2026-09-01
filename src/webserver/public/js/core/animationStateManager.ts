


import { updateLayeredAnimation, changeLayeredAnimation } from './layeredAnimation.js';

// How long a REMOTE player's sprite may keep walking with no server position
// updates before we assume a lost stop-walking datagram and revert to idle.
const STALL_REVERT_MS = 1500;

export class AnimationStateManager {

  // `localPlayerId` is excluded from the stall-revert fallback: the local
  // player's walk state is driven by the keyboard, not by server echoes. After
  // idling >1.5s the local `lastServerUpdate` is stale, so on the first step the
  // fallback would instantly revert the walk animation to idle before the
  // server's MOVEXY echo round-trips.
  updateAllPlayers(players: Map<string, any>, deltaTime: number, localPlayerId?: string | null): void {
    const now = performance.now();
    players.forEach(player => {
      if (player.layeredAnimation) {
        updateLayeredAnimation(player.layeredAnimation, deltaTime);

        if (player.id === localPlayerId) return;

        // Datagram-loss fallback: movement animations arrive as unreliable
        // datagrams, so a lost "stop walking" packet can leave a sprite
        // walking indefinitely. The server only sends MOVEXY while the player
        // is actually moving - a stale lastServerUpdate means they stopped.
        const animName = player.layeredAnimation.currentAnimationName || "";
        if (
          animName.includes("walk") &&
          typeof player.lastServerUpdate === "number" &&
          player.lastServerUpdate > 0 &&
          now - player.lastServerUpdate > STALL_REVERT_MS
        ) {
          changeLayeredAnimation(player.layeredAnimation, animName.replace(/walk/, "idle"));
        }
      }
    });
  }

}

export const animationManager = new AnimationStateManager();
