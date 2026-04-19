type Nullable<T> = T | null;
type DatabaseEngine = "mysql" | "postgres" | "sqlite";

interface GameServer {
  id: string;
  description?: string;
  host: string;
  publicHost: string;
  port: number;
  wsPort: number;
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
  particles?: Particle[];
  hidden?: boolean;
  quest: Nullable<number>;
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
  };
}