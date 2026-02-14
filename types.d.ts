interface GameServer {
  id: string;
  host: string;           // Internal hostname for gateway to proxy to
  publicHost: string;     // External hostname for clients to connect to
  port: number;           // HTTP port
  wsPort: number;         // WebSocket port
  useSSL: boolean;        // Whether WebSocket uses SSL (wss://)
  lastHeartbeat: number;
  activeConnections: number;
  maxConnections: number;
  cpuUsage?: number;      // CPU usage percentage (0-100)
  ramUsage?: number;      // RAM usage in MB (RSS - process memory)
  latency?: number;       // Latency to server in ms
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
  authKey: string;
}

// Define tileset data
declare interface TilesetData {
  name: string;
  data: Buffer;
}