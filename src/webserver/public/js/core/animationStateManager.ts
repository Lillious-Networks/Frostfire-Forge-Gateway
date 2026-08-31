


import { updateLayeredAnimation, changeLayeredAnimation } from './layeredAnimation.js';

// How long a player's sprite may keep walking with no server position
// updates before we assume a lost stop-walking datagram and revert to idle.
const STALL_REVERT_MS = 1500;

export class AnimationStateManager {

  updateAllPlayers(players: Map<string, any>, deltaTime: number): void {
    const now = performance.now();
    players.forEach(player => {
      if (player.layeredAnimation) {
        updateLayeredAnimation(player.layeredAnimation, deltaTime);

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
