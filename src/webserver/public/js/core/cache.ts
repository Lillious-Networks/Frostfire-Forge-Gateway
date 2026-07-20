class Cache {
  private static instance: Cache;

  players: Set<any> = new Set();
  onlinePlayers: Set<string> = new Set();
  pendingPlayers: Map<string, any> = new Map();
  pendingEffects: Map<string, any[]> = new Map();
  npcs: any[] = [];
  entities: any[] = [];
  audio: any[] = [];
  animations: Map<string, any> = new Map();
  mount: string | null = null;
  targetId: string | null = null;
  projectileIcons: Map<string, HTMLImageElement> = new Map();
  projectiles: Array<{
    startX: number;
    startY: number;
    targetPlayerId: string;
    targetEntityId?: string;
    targetPos?: { x: number; y: number };
    currentX: number;
    currentY: number;
    startTime: number;
    duration: number;
    spell: string;
    isEntityTarget?: boolean;
    particles?: any[];
    particleArrays?: Record<string, any[]>;
    lastEmitTime?: Record<string, number>;
  }> = [];
  // existing fields above...
  inventory: any[] = [];
  equipment: any = {};
  inventoryConfig: any = null;
  spells: Record<string, any> = {};
  collectables: any[] = [];
  spellLockoutUntil: number = 0;

  private constructor() {}

  static getInstance(): Cache {
    if (!Cache.instance) {
      Cache.instance = new Cache();
    }
    return Cache.instance;
  }
}

export default Cache;