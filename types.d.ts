type Nullable<T> = T | null;
interface GameServer {
  id: string;
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
  position: { x: number; y: number };
  dialog: string;
  particles?: Particle[];
  hidden?: boolean;
  quest: Nullable<number>;
  show: (context: CanvasRenderingContext2D) => void;
  updateParticle: (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => void;
  dialogue: (context: CanvasRenderingContext2D) => void;
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