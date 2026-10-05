import Cache from "./cache.js";
import { cachedPlayerId } from "./socket.js";
import { clicked, PLAYER_FEET } from "./depthorder.js";

const cache = Cache.getInstance();

/**
 * The player a click at a world point lands on, or null. Where players overlap
 * it is the one drawn on top. `pickable` leaves out players the caller cannot
 * choose (corpses, say).
 */
export function playerAt(worldX: number, worldY: number, pickable: (player: any) => boolean = () => true): any | null {
  const players = Array.from(cache.players || []) as any[];
  const viewer = players.find((p) => p.id === cachedPlayerId);
  const inReach: Array<{ x: number; y: number; feet: number; own: boolean; player: any }> = [];
  for (const player of players) {
    const own = player.id === cachedPlayerId;
    // A stealthed player is drawn only for admins and for the player's own
    // client, so nobody else can click one.
    if (player.isStealth && !own && !viewer?.isAdmin) continue;
    const { x, y } = player.renderPosition ?? player.position;
    if (worldX < x - 16 || worldX > x + 32 || worldY < y - 24 || worldY > y + 48 || !pickable(player)) continue;
    inReach.push({ x, y, feet: y + PLAYER_FEET, own, player });
  }
  return clicked(inReach, worldX, worldY)?.player ?? null;
}
