type Nullable<T> = T | null;
type DatabaseEngine = "mysql" | "postgres" | "sqlite";

interface GameServer {
  id: string;
  description?: string;
  host: string;
  publicHost: string;
  port: number;
  wtPort?: number;
  wtEnabled?: boolean;
  useSSL: boolean;
  lastHeartbeat: number;
  activeConnections: number;
  maxConnections: number;
  cpuUsage?: number;
  ramUsage?: number;
  latency?: number;
  whitelisted?: boolean;
}

interface ClientSession {
  serverId: string;
  lastActivity: number;
  clientId: string;
}

interface GatewayConfig {
  port: number;
  heartbeatInterval: number;
  serverTimeout: number;
  sessionTimeout: number;
  authKey: Nullable<string>;
}

declare interface TilesetData {
  name: string;
  data: Buffer;
}

declare interface NPC {
  id: string;
  name?: string;
  position: { x: number; y: number };
  dialog: string;
  gossip?: string | null;
  /** Whether it sells things: a vendor can be talked to, though it has nothing to say. */
  vendor?: boolean;
  /** Whether it keeps an inn the player can make their home: a reason to talk to it too. */
  innkeeper?: boolean;
  particles?: Particle[];
  hidden?: boolean;
  quest_giver?: boolean;
  direction?: string;
  sprite_type?: 'none' | 'static' | 'animated';
  spriteLayers?: {
    body: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    head: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    helmet: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    shoulderguards: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    neck: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    hands: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    chest: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    feet: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    legs: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    weapon: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
  } | null;
  layeredAnimation?: LayeredAnimation | null;
  staticImage?: HTMLImageElement | null;
  show: (context: CanvasRenderingContext2D) => void;
  updateParticle: (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => void;
  dialogue: (context: CanvasRenderingContext2D) => void;
}

declare interface Entity {
  id: string;
  name?: string;
  position: { x: number; y: number };
  direction?: string;
  particles?: Particle[];
  particleArrays?: { [key: string]: Particle[] };
  lastEmitTime?: number;
  health: number;
  max_health: number;
  level: number;
  aggro_type: 'friendly' | 'neutral' | 'aggressive';
  sprite_type?: 'none' | 'static' | 'animated';
  spriteLayers?: {
    body: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    head: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    helmet: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    shoulderguards: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    neck: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    hands: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    chest: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    feet: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    legs: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
    weapon: { name: string; templateUrl: string | null; imageUrl: string | null } | null;
  } | null;
  damageNumbers: Array<{
    value: number;
    x: number;
    y: number;
    startTime: number;
    isHealing: boolean;
    isCrit: boolean;
    isMiss?: boolean;
  }>;
  layeredAnimation?: LayeredAnimation | null;
  staticImage?: HTMLImageElement | null;
  target: Nullable<string>;
  combatState: 'idle' | 'aggro' | 'combat' | 'dead';
  show: (context: CanvasRenderingContext2D) => void;
  updateParticle: (particle: Particle, entity: any, context: CanvasRenderingContext2D, deltaTime: number) => void;
  takeDamage: (amount: number) => void;
  updatePosition: (x: number, y: number) => void;
}

declare interface LayeredAnimation {
  layers: {
    mount: Nullable<AnimationLayer>;
    body: AnimationLayer;
    head: AnimationLayer;
    armor_helmet: Nullable<AnimationLayer>;
    armor_shoulderguards: Nullable<AnimationLayer>;
    armor_neck: Nullable<AnimationLayer>;
    armor_hands: Nullable<AnimationLayer>;
    armor_chest: Nullable<AnimationLayer>;
    armor_feet: Nullable<AnimationLayer>;
    armor_legs: Nullable<AnimationLayer>;
    armor_weapon: Nullable<AnimationLayer>;
  };
  currentAnimationName: string;
  _animAppliedAt?: number;
  syncFrames: boolean;
}

declare interface ConfigData {
  [key: string]: number | string | boolean;
}

declare interface Particle {
  name: string | null;
  size: number;
  color: string | null;
  velocity: {
      x: number;
      y: number;
  };
  lifetime: number;
  scale: number;
  opacity: number;
  visible: boolean;
  gravity: {
      x: number;
      y: number;
  };
  localposition: {
    x: number | 0;
    y: number | 0;
  } | null;
  interval: number;
  amount: number;
  staggertime: number;
  currentLife: number | null;
  initialVelocity: {
    x: number;
    y: number;
  } | null;
  spread: {
    x: number;
    y: number;
  };
  weather: WeatherData | 'none';
  affected_by_weather?: boolean;
  zIndex?: number;
  /** Brightness of the glow (0 = none). */
  glow_intensity?: number;
  /** How far the glow reaches past the particle, px (0 = twice the particle's radius). */
  glow_radius?: number;
  /** One steady light at the particle's position instead of an emitted stream. */
  static_light?: boolean;
  /** How much light the whole particle (core and glow) gives off, day and night: 1 = as drawn, 0 = none, above 1 brighter. */
  brightness?: number;
  /** The sprite (asset server, assets/sprites) emitted in place of the round dot, `size` px wide; none = the dot. */
  image?: string | null;
}

declare interface AnimationFrame {
  imageElement: HTMLImageElement;
  width: number;
  height: number;
  delay: number;
  offset?: {
    x: number;
    y: number;
  };
}

declare interface SpriteSheetTemplate {
  name: string;
  imageSource: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: {
    [animationName: string]: SpriteSheetAnimation;
  };
}

declare interface AnimationLayer {
  type: 'mount' | 'body' | 'head' | 'armor_helmet' | 'armor_shoulderguards' | 'armor_neck' | 'armor_hands' | 'armor_chest' | 'armor_feet' | 'armor_legs' | 'armor_weapon';
  spriteSheet: Nullable<SpriteSheetTemplate>;
  frames: AnimationFrame[];
  currentFrame: number;
  lastFrameTime: number;
  zIndex: number;
  visible: boolean;
}

declare interface SpriteSheetCache {
  [spriteSheetName: string]: {
    imageElement: HTMLImageElement;
    template: SpriteSheetTemplate;
    extractedFrames: {
      [frameIndex: number]: HTMLImageElement;
    };
    extractedFramesMap: Map<number, HTMLImageElement>;
  };
}

/** One player as the game server holds them; the player editor is sent a fresh one after every change. */
declare interface PlayerEditorSnapshot {
  username: string;
  userid: number;
  online: boolean;
  /** The connection id while online: what the other admin commands take as an id. */
  sessionId: Nullable<string>;
  isAdmin: boolean;
  isGuest: boolean;
  banned: boolean;
  /** 0 alive, 1 a corpse awaiting release, 2 a ghost. */
  dead: number;
  location: { map: string; x: number; y: number; direction: string };
  /** What the stats table holds, before equipment. */
  stats: Record<string, number>;
  /** Totals with equipment and effects applied, known only while the player is online. */
  totals: Nullable<Record<string, number>>;
  currency: { copper: number; silver: number; gold: number };
  inventory: Array<{
    name: string;
    quantity: number;
    equipped: boolean;
    quality: Nullable<string>;
    type: Nullable<string>;
    icon: Nullable<string>;
    equipment_slot: Nullable<string>;
    level_requirement: Nullable<number>;
    /** False when the item's definition has been deleted: the row can only be removed. */
    known: boolean;
  }>;
  inventorySlots: number;
  equipment: Record<string, Nullable<string>>;
  bags: Record<string, Nullable<string>>;
  collectables: Array<{ type: string; item: string; icon: Nullable<string>; known: boolean }>;
  spells: string[];
  friends: string[];
  guild: Nullable<{ id: number; name: string; leader: string; members: string[] }>;
  party: Nullable<{ id: number; leader: string; members: string[] }>;
  quests: {
    active: Array<{
      id: number;
      name: string;
      state: string;
      objectives: Array<{ id: number; label: string; count: number; required: number }>;
    }>;
    completed: Array<{ id: number; name: string }>;
  };
  permissions: string[];
}

/** What the player editor offers in its pickers, and the limits the server validates against. */
declare interface PlayerEditorOptions {
  /** The admin using the editor: their own permissions and admin status are not theirs to change. */
  editor: string;
  slots: string[];
  directions: string[];
  collectableTypes: string[];
  /** Map sizes are in pixels, the unit positions are stored in. */
  maps: Array<{ name: string; width: number; height: number }>;
  mounts: Array<{ name: string; icon: Nullable<string> }>;
  spells: Array<{ name: string; icon: Nullable<string> }>;
  quests: Array<{ id: number; name: string; level: number }>;
  guilds: Array<{ id: number; name: string; leader: string; members: number }>;
  permissionTypes: string[];
  limits: { level: number; value: number; currency: { copper: number; silver: number; gold: number } };
}

/** One online player as the control panel lists them. */
declare interface ControlPanelPlayer {
  /** The connection id: what the admin commands take as an id. */
  id: string;
  username: string;
  level: number;
  map: string;
  isAdmin: boolean;
  isStealth: boolean;
  isGuest: boolean;
  /** 0 alive, 1 a corpse awaiting release, 2 a ghost. */
  dead: number;
  /** Seconds since they logged in, or null where that is not known. */
  onlineFor: Nullable<number>;
}

/**
 * One reading of the control panel's history: seconds since the epoch, players
 * online, event loop delay in ms, memory in MB, creatures awake. A figure that
 * was not known is null.
 */
declare type ControlPanelReading = Array<Nullable<number>>;

/** One thing an admin did through the control panel. */
declare interface ControlPanelActivity {
  /** Counts up from 1: the panel asks for what came after the last one it holds. */
  seq: number;
  /** When, in milliseconds since the epoch. */
  at: number;
  /** The admin, as stored. */
  by: string;
  action: string;
  /** The player it was done to, as stored. */
  target: Nullable<string>;
  /** The values that went with it: the item, the map, the message. */
  details: Record<string, string | number | boolean>;
  /** What the command answered. */
  said: string;
}

/** What the control panel shows, as the server sends it every time the panel asks. */
/** What a weather reads, as the control panel shows it: degrees Fahrenheit, percent, miles an hour, where the wind blows to on screen, and how much falls (0 to 100). */
declare interface WeatherConditions {
  temperature: number;
  humidity: number;
  wind_speed: number;
  wind_direction: string;
  precipitation: number;
}

declare interface ControlPanelData {
  /** The admin looking at the panel. */
  viewer: { id: string; username: string; map: string; isNoclip: boolean; isStealth: boolean };
  players: ControlPanelPlayer[];
  status: {
    /** Seconds since the server process started. */
    uptime: number;
    online: number;
    /** The most players online at once since the server started, and when (ms since the epoch). */
    peak: { online: number; at: number };
    memoryMb: number;
    eventLoopLagMs: Nullable<number>;
    restartScheduled: boolean;
    whitelist: { enabled: boolean; size: number };
    creatures: Nullable<Record<string, any>>;
  };
  /** The viewer's map with its weather, and every world. `showing` is the weather a "random" world has settled on. */
  world: {
    map: string; weather: string; showing: string;
    /** The readings of the weather the viewer's map has now. Null under a clear sky, or when there is nothing to read. */
    conditions: WeatherConditions | null;
    worlds: Array<{ name: string; weather: string; showing: string; conditions: WeatherConditions | null; players: number }>;
  };
  /** For a viewer who handles reports: how many are open. */
  reports?: { open: number };
  /** Sent when asked in full: which controls the viewer's permissions allow, by action. */
  can?: Record<string, boolean>;
  /** Sent when asked in full: what the map and weather controls pick from. */
  options?: { maps: string[]; weathers: string[] };
  /**
   * Player subscriptions. `enabled`: the locks bite (the Gateway has Stripe set up). `locks`: the ids a player
   * without a subscription may not use. `options`: every id with its label, in the order to show them.
   * Absent from an engine that does not have subscriptions.
   */
  subscription?: { enabled: boolean; locks: string[]; options: Array<{ id: string; label: string }> };
  /** Sent when asked in full: how many accounts there are, guests aside, and how many are banned. Null if that could not be read. */
  accounts?: Nullable<{ registered: number; banned: number }>;
  /**
   * The readings the charts are drawn from: every 15 seconds for the last hour,
   * every minute for the last 24. All of them when asked in full; on a refresh,
   * the ones newer than the panel says it holds.
   */
  history?: { recent: ControlPanelReading[]; day: ControlPanelReading[] };
  /** What admins did through the panel, oldest first: sent as the history is. */
  activity?: ControlPanelActivity[];
}

/** One row of a loot table, as the control panel lists it. */
declare interface ControlPanelLootRow {
  id: number;
  item_name: string;
  min_quantity: number;
  max_quantity: number;
  drop_chance: number;
  quality: string;
}