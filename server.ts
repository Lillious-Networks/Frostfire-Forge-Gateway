/**
 * Gateway/Load Balancer Server with Sticky Sessions
 *
 * This server acts as a gateway between clients and multiple game server instances.
 * - Game servers register themselves with the gateway
 * - Clients connect to the gateway
 * - Gateway distributes clients across available servers using round-robin
 * - Sticky sessions ensure clients always reconnect to the same server
 * - Implements backpressure handling for WebSocket connections
 */

// Backpressure configuration
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024; // 1GB
const packetQueue = new Map<string, (() => void)[]>();

interface GameServer {
  id: string;
  host: string;           // Internal hostname for gateway to proxy to
  publicHost: string;     // External hostname for clients to connect to
  port: number;
  wsPort: number;
  lastHeartbeat: number;
  activeConnections: number;
  maxConnections: number;
}

interface ClientSession {
  serverId: string;
  lastActivity: number;
  clientId: string;
}

interface GatewayConfig {
  port: number;
  wsPort: number;
  heartbeatInterval: number;
  serverTimeout: number;
  sessionTimeout: number;
  authKey: string;
}

// Load config from file
const configFile = await Bun.file("./config.json").json();

// Determine port based on environment variables
const useSSL = process.env.WEBSRV_USESSL === "true" || process.env.WEBSRV_USESSL === "1";
const httpPort = parseInt(process.env.WEBSRV_PORT || "") || configFile.gateway.port || 80;
const httpsPort = parseInt(process.env.WEBSRV_PORTSSL || "") || 443;
const serverPort = useSSL ? httpsPort : httpPort;

const config: GatewayConfig = {
  port: serverPort,
  wsPort: configFile.gateway.wsPort || 9000,
  heartbeatInterval: configFile.gateway.heartbeatInterval || 5000,
  serverTimeout: configFile.gateway.serverTimeout || 15000,
  sessionTimeout: configFile.gateway.sessionTimeout || 1800000,
  authKey: process.env.GATEWAY_AUTH_KEY || configFile.gateway.authKey || "change-this-secret-key"
};

// Store registered game servers
const gameServers: Map<string, GameServer> = new Map();
let roundRobinIndex = 0;

// Store client-to-gameserver WebSocket connections
const clientGameServerConnections: Map<string, any> = new Map();

// Sticky session tracking: clientId → ClientSession
const clientSessions: Map<string, ClientSession> = new Map();

// Migration statistics
let totalMigrations = 0;
const migrationHistory: Array<{
  timestamp: number;
  fromServer: string;
  toServer: string;
  clientCount: number;
}> = [];

/**
 * Get the next available server using round-robin load balancing
 */
function getNextServer(): GameServer | null {
  const availableServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (availableServers.length === 0) {
    return null;
  }

  const server = availableServers[roundRobinIndex % availableServers.length];
  roundRobinIndex = (roundRobinIndex + 1) % availableServers.length;

  return server;
}

/**
 * Get server assignment for client with sticky session support
 * If client has an existing session, return that server
 * Otherwise, assign a new server using round-robin
 */
function getServerForClient(clientId: string): GameServer | null {
  console.log(`[Gateway] Looking up session for clientId: ${clientId}`);

  // Check if client has an existing session
  const existingSession = clientSessions.get(clientId);

  if (existingSession) {
    console.log(`[Gateway] Found existing session: clientId=${clientId}, serverId=${existingSession.serverId}`);

    // Check if the assigned server is still available and healthy
    const assignedServer = gameServers.get(existingSession.serverId);

    if (assignedServer && assignedServer.activeConnections < assignedServer.maxConnections) {
      // Update last activity timestamp
      existingSession.lastActivity = Date.now();
      return assignedServer;
    } else {
      // Server is gone or full, remove session and assign new server
      console.log(`[Gateway] ✗ Previous server ${existingSession.serverId} unavailable (exists: ${!!assignedServer}, full: ${assignedServer ? assignedServer.activeConnections >= assignedServer.maxConnections : false}), reassigning client ${clientId}`);
      clientSessions.delete(clientId);
    }
  } else {
    console.log(`[Gateway] No existing session found for clientId: ${clientId}`);
  }

  // No existing session or server unavailable - assign new server
  const server = getNextServer();

  if (server) {
    // Create new session
    clientSessions.set(clientId, {
      serverId: server.id,
      lastActivity: Date.now(),
      clientId
    });
    console.log(`[Gateway] ✓ NEW SESSION: Created session for client ${clientId} → server ${server.id} (Total sessions: ${clientSessions.size})`);
  } else {
    console.log(`[Gateway] ✗ NO SERVER AVAILABLE for client ${clientId}`);
  }

  return server;
}

/**
 * Migrate sessions from a dead server to healthy servers
 */
function migrateSessionsFromDeadServer(deadServerId: string): number {
  const sessionsToMigrate: string[] = [];

  // Find all sessions pointing to the dead server
  for (const [clientId, session] of clientSessions.entries()) {
    if (session.serverId === deadServerId) {
      sessionsToMigrate.push(clientId);
    }
  }

  if (sessionsToMigrate.length === 0) {
    return 0;
  }

  // Get available healthy servers
  const healthyServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (healthyServers.length === 0) {
    console.warn(`[Gateway] No healthy servers available for migration from ${deadServerId}`);
    // Delete sessions if no healthy servers available
    for (const clientId of sessionsToMigrate) {
      clientSessions.delete(clientId);
    }
    return 0;
  }

  console.log(`[Gateway] Migrating ${sessionsToMigrate.length} sessions from dead server ${deadServerId}`);

  let migrationIndex = 0;
  let migratedCount = 0;

  // Migrate sessions to healthy servers (round-robin distribution)
  for (const clientId of sessionsToMigrate) {
    const session = clientSessions.get(clientId);
    if (!session) continue;

    // Select next healthy server in round-robin fashion
    const targetServer = healthyServers[migrationIndex % healthyServers.length];
    migrationIndex++;

    // Update session to point to new server
    session.serverId = targetServer.id;
    session.lastActivity = Date.now(); // Reset activity to prevent immediate expiration

    migratedCount++;
    console.log(`[Gateway] Migrated client ${clientId}: ${deadServerId} → ${targetServer.id}`);
  }

  // Record migration in history
  if (migratedCount > 0) {
    healthyServers[0].id;
    migrationHistory.push({
      timestamp: Date.now(),
      fromServer: deadServerId,
      toServer: migratedCount === 1 ? healthyServers[0].id : `${healthyServers.length} servers`,
      clientCount: migratedCount
    });

    // Keep only last 100 migrations in history
    if (migrationHistory.length > 100) {
      migrationHistory.shift();
    }

    totalMigrations += migratedCount;
  }

  return migratedCount;
}

/**
 * Remove dead servers that haven't sent heartbeat and migrate their sessions
 */
function cleanupDeadServers() {
  const now = Date.now();
  for (const [id, server] of gameServers.entries()) {
    if (now - server.lastHeartbeat > config.serverTimeout) {
      console.log(`[Gateway] Server died: ${id} (${server.host}:${server.port})`);

      // Migrate sessions before removing server
      const migratedCount = migrateSessionsFromDeadServer(id);

      if (migratedCount > 0) {
        console.log(`[Gateway] Successfully migrated ${migratedCount} sessions from ${id}`);
      } else {
        console.log(`[Gateway] No sessions to migrate from ${id}`);
      }

      // Remove the dead server
      gameServers.delete(id);
    }
  }
}

/**
 * Remove expired client sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let removedCount = 0;

  for (const [clientId, session] of clientSessions.entries()) {
    if (now - session.lastActivity > config.sessionTimeout) {
      clientSessions.delete(clientId);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    console.log(`[Gateway] Cleaned up ${removedCount} expired sessions`);
  }
}

// Start cleanup intervals
setInterval(cleanupDeadServers, config.heartbeatInterval);
setInterval(cleanupExpiredSessions, 60000); // Clean up sessions every minute

/**
 * Handle WebSocket backpressure
 * Queues actions if buffer is full, executes when buffer has space
 */
function handleBackpressure(ws: any, action: () => void, retryCount = 0) {
  if (retryCount > 20) {
    console.warn("[Gateway] Max retries reached. Action skipped to avoid infinite loop.");
    return;
  }

  if (ws.readyState !== 1) { // 1 = WebSocket.OPEN
    console.warn("[Gateway] WebSocket is not open. Action cannot proceed.");
    return;
  }

  const clientId = ws.clientId;
  if (!clientId) {
    console.warn("[Gateway] No clientId found for WebSocket. Action cannot proceed.");
    return;
  }

  const queue = packetQueue.get(clientId);
  if (!queue) {
    console.warn("[Gateway] No packet queue found for WebSocket. Action cannot proceed.");
    return;
  }

  if (ws.bufferedAmount > MAX_BUFFER_SIZE) {
    const retryInterval = Math.min(50 + retryCount * 50, 500);
    console.log(`[Gateway] Backpressure detected for ${clientId}. Retrying in ${retryInterval}ms (Attempt ${retryCount + 1})`);

    queue.push(action);
    setTimeout(() => handleBackpressure(ws, action, retryCount + 1), retryInterval);
  } else {
    action();

    // Process queued actions while buffer has space
    while (queue.length > 0 && ws.bufferedAmount <= MAX_BUFFER_SIZE) {
      const nextAction = queue.shift();
      if (nextAction) {
        nextAction();
      }
    }
  }
}

/**
 * HTTP Server for game server registration
 */
const serverConfig: any = {
  port: config.port,
  hostname: "0.0.0.0",
  async fetch(req: any) {
    const url = new URL(req.url);

    // Server registration endpoint
    if (url.pathname === "/register" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, host, publicHost, port, wsPort, maxConnections, authKey } = body;

        // Validate authentication key
        if (authKey !== config.authKey) {
          console.warn(`[Gateway] Registration attempt with invalid auth key from ${host}`);
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!id || !host || !port || !wsPort) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Check if server already exists (re-registration)
        const existingServer = gameServers.get(id);
        const isReRegistration = !!existingServer;

        const server: GameServer = {
          id,
          host,
          publicHost: publicHost || host,  // Use publicHost if provided, fallback to host
          port,
          wsPort,
          lastHeartbeat: Date.now(),
          activeConnections: existingServer?.activeConnections || 0, // Preserve connection count
          maxConnections: maxConnections || 1000
        };

        gameServers.set(id, server);

        if (isReRegistration) {
          console.log(`[Gateway] Server re-registered: ${id} (${host}:${port}, ws:${wsPort})`);
        } else {
          console.log(`[Gateway] Server registered: ${id} (${host}:${port}, ws:${wsPort})`);
        }

        return new Response(JSON.stringify({ success: true, serverId: id }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Server heartbeat endpoint
    if (url.pathname === "/heartbeat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, activeConnections, authKey } = body;

        // Validate authentication key
        if (authKey !== config.authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        const server = gameServers.get(id);
        if (server) {
          server.lastHeartbeat = Date.now();
          server.activeConnections = activeConnections || 0;

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Server unregister endpoint
    if (url.pathname === "/unregister" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, authKey } = body;

        // Validate authentication key
        if (authKey !== config.authKey) {
          return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (gameServers.delete(id)) {
          console.log(`[Gateway] Server unregistered: ${id}`);
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Status endpoint
    if (url.pathname === "/status" && req.method === "GET") {
      const servers = Array.from(gameServers.values()).map(s => ({
        id: s.id,
        host: s.host,
        publicHost: s.publicHost,
        port: s.port,
        wsPort: s.wsPort,
        activeConnections: s.activeConnections,
        maxConnections: s.maxConnections,
        lastHeartbeat: s.lastHeartbeat
      }));

      return new Response(JSON.stringify({
        totalServers: gameServers.size,
        totalActiveSessions: clientSessions.size,
        totalMigrations: totalMigrations,
        recentMigrations: migrationHistory.slice(-10), // Last 10 migrations
        servers
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Debug endpoint to view sessions
    if (url.pathname === "/debug/sessions" && req.method === "GET") {
      const sessions = Array.from(clientSessions.entries()).map(([clientId, session]) => ({
        clientId,
        serverId: session.serverId,
        lastActivity: new Date(session.lastActivity).toISOString(),
        age: Math.floor((Date.now() - session.lastActivity) / 1000) + 's'
      }));

      return new Response(JSON.stringify({
        totalSessions: clientSessions.size,
        sessions: sessions
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Proxy ALL HTTP requests to game servers except gateway-specific routes
    // Gateway-specific routes that should NOT be proxied
    const gatewayRoutes = ['/register', '/heartbeat', '/unregister', '/status', '/debug'];
    const isGatewayRoute = gatewayRoutes.some(route => url.pathname.startsWith(route));

    if (!isGatewayRoute) {
      const availableServers = Array.from(gameServers.values());
      if (availableServers.length === 0) {
        return new Response("No game servers available", { status: 503 });
      }

      // Use sticky HTTP sessions based on cookie
      const cookies = req.headers.get('cookie') || '';
      const httpSessionMatch = cookies.match(/gateway_http_session=([^;]+)/);
      let targetServer: GameServer | null = null;
      let httpSessionId: string | null = null;
      let isNewSession = false;

      if (httpSessionMatch) {
        httpSessionId = httpSessionMatch[1] as string;
        // Try to get the server for this HTTP session
        const session = clientSessions.get(httpSessionId);
        if (session) {
          targetServer = gameServers.get(session.serverId) || null;
        }
      }

      // If no sticky session, pick a random server and create session
      if (!targetServer) {
        targetServer = availableServers[Math.floor(Math.random() * availableServers.length)];

        // Create a session ID for HTTP requests
        httpSessionId = `http-${crypto.randomUUID()}`;
        clientSessions.set(httpSessionId, {
          serverId: targetServer.id,
          lastActivity: Date.now(),
          clientId: httpSessionId
        });

        isNewSession = true;
      }

      const targetUrl = `http://${targetServer.host}:${targetServer.port}${url.pathname}${url.search}`;

      try {
        // Proxy the request to the game server
        const proxyResponse = await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body
        });

        // Clone response headers and add sticky session cookie
        const responseHeaders = new Headers(proxyResponse.headers);

        // Set sticky session cookie if this is a new session
        if (isNewSession && httpSessionId) {
          responseHeaders.set('Set-Cookie', `gateway_http_session=${httpSessionId}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly`);
        }

        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: responseHeaders
        });
      } catch (error) {
        return new Response("Failed to fetch resource", { status: 502 });
      }
    }

    return new Response("Gateway Load Balancer", { status: 200 });
  }
};

// Add SSL/TLS configuration if enabled
if (useSSL) {
  const certPath = process.env.WEBSRV_CERT_PATH || "./cert.pem";
  const keyPath = process.env.WEBSRV_KEY_PATH || "./key.pem";

  try {
    serverConfig.tls = {
      cert: Bun.file(certPath),
      key: Bun.file(keyPath),
    };
    console.log(`[Gateway] SSL enabled with cert: ${certPath}`);
  } catch (error) {
    console.error(`[Gateway] Failed to load SSL certificates. Falling back to HTTP.`);
    console.error(`[Gateway] Make sure ${certPath} and ${keyPath} exist.`);
  }
}

Bun.serve(serverConfig);

/**
 * Extract client ID from URL query parameters or generate one
 */
function getClientId(url: URL): string {
  const clientId = url.searchParams.get("clientId");
  if (clientId) {
    return clientId;
  }

  // Generate a unique client ID if not provided
  return `client-${crypto.randomUUID()}`;
}

/**
 * WebSocket Server for client connections with sticky session support
 */
const wsServerConfig: any = {
  port: config.wsPort,
  hostname: "0.0.0.0",
  websocket: {
    message(ws: any, message: string | Buffer) {
      const clientId = ws.clientId;
      if (!clientId) return;

      // Get the session to find which game server this client is assigned to
      const session = clientSessions.get(clientId);
      if (!session) {
        console.warn(`[Gateway] No session found for client ${clientId}`);
        return;
      }

      // Get the game server
      const server = gameServers.get(session.serverId);
      if (!server) {
        console.warn(`[Gateway] Game server ${session.serverId} not found for client ${clientId}`);
        return;
      }

      // Get or create WebSocket connection to game server
      let gameServerWs = clientGameServerConnections.get(clientId);

      // Only create new connection if none exists or existing one is closed
      if (!gameServerWs || gameServerWs.readyState === WebSocket.CLOSED || gameServerWs.readyState === WebSocket.CLOSING) {
        // Create new WebSocket connection to game server
        const gameServerUrl = `ws://${server.host}:${server.wsPort}`;
        console.log(`[Gateway] Creating proxy connection to game server: ${gameServerUrl}`);

        // Create WebSocket with explicit User-Agent header required by game server
        gameServerWs = new WebSocket(gameServerUrl, {
          headers: {
            "User-Agent": "Frostfire-Forge-Gateway/1.0"
          }
        });

        // Queue to store messages while connection is establishing
        const messageQueue: (string | Buffer)[] = [message];

        gameServerWs.onopen = () => {
          console.log(`[Gateway] Proxy connection established for client ${clientId}`);
          // Forward all queued messages
          while (messageQueue.length > 0) {
            const queuedMessage = messageQueue.shift();
            if (gameServerWs && gameServerWs.readyState === 1 && queuedMessage) {
              gameServerWs.send(queuedMessage);
            }
          }
        };

        gameServerWs.onmessage = (event: MessageEvent) => {
          // Forward messages from game server back to client
          if (ws.readyState === 1) {
            handleBackpressure(ws, () => {
              ws.send(event.data);
            });
          }
        };

        gameServerWs.onclose = () => {
          console.log(`[Gateway] Game server connection closed for client ${clientId}`);
          clientGameServerConnections.delete(clientId);
        };

        gameServerWs.onerror = (error: any) => {
          console.error(`[Gateway] Game server connection error for client ${clientId}:`, error);
          clientGameServerConnections.delete(clientId);
        };

        clientGameServerConnections.set(clientId, gameServerWs);

        // Store message queue on the WebSocket for access by subsequent messages
        (gameServerWs as any).messageQueue = messageQueue;
      } else if (gameServerWs.readyState === WebSocket.CONNECTING) {
        // Connection is still establishing, queue the message
        const messageQueue = (gameServerWs as any).messageQueue;
        if (messageQueue) {
          messageQueue.push(message);
        }
      } else if (gameServerWs.readyState === WebSocket.OPEN) {
        // Connection is open, forward the message immediately
        gameServerWs.send(message);
      }
    },
    open(ws: any) {
      // Extract clientId from the WebSocket data passed during upgrade
      const clientId = ws.data?.clientId || `client-${crypto.randomUUID()}`;

      // Store clientId on ws for later use
      ws.clientId = clientId;

      console.log(`[Gateway] Client connected: ${clientId}, finding server...`);

      // Initialize packet queue for backpressure handling
      packetQueue.set(clientId, []);

      // Use sticky session logic
      const server = getServerForClient(clientId);
      if (!server) {
        handleBackpressure(ws, () => {
          ws.send(JSON.stringify({
            type: "error",
            message: "No available servers"
          }));
        });
        // Close after a short delay to allow message to be sent
        setTimeout(() => ws.close(), 100);
        return;
      }

      // Send server assignment to client with backpressure handling
      // Note: Clients should connect to the gateway's ports, not the game server's internal ports
      handleBackpressure(ws, () => {
        ws.send(JSON.stringify({
          type: "server_assignment",
          clientId: clientId,
          server: {
            host: server.publicHost,  // External hostname for clients
            port: config.port,        // Gateway's HTTP port (external)
            wsPort: config.wsPort     // Gateway's WebSocket port (external)
          }
        }));
      });

      console.log(`[Gateway] Client ${clientId} assigned to server: ${server.id} (${server.host}:${server.wsPort})`);

      // Client should now disconnect from gateway and connect to assigned server
      // In a more sophisticated implementation, the gateway could proxy the connection
    },
    close(ws: any) {
      const clientId = ws.clientId;
      if (clientId) {
        // Clean up packet queue
        packetQueue.delete(clientId);

        // Close game server connection if it exists
        const gameServerWs = clientGameServerConnections.get(clientId);
        if (gameServerWs) {
          gameServerWs.close();
          clientGameServerConnections.delete(clientId);
        }

        console.log(`[Gateway] Client disconnected: ${clientId}`);
      } else {
        console.log("[Gateway] Client disconnected");
      }
    },
  },
  fetch(req: any, server: any) {
    // Extract client ID from URL query params
    const url = new URL(req.url);
    const clientId = getClientId(url);

    // Store client ID in URL for later retrieval
    const wsUrl = new URL(req.url);
    wsUrl.searchParams.set('clientId', clientId);

    // Upgrade to WebSocket with clientId in data
    if (server.upgrade(req, { data: { clientId } as any })) {
      return;
    }
    return new Response("Gateway WebSocket Server", { status: 200 });
  }
};

// Add SSL/TLS configuration to WebSocket server if enabled
if (useSSL && serverConfig.tls) {
  wsServerConfig.tls = serverConfig.tls;
}

Bun.serve(wsServerConfig);

const protocol = useSSL ? 'https' : 'http';
const wsProtocol = useSSL ? 'wss' : 'ws';
console.log(`[Gateway] HTTP Server running on ${protocol}://localhost:${config.port}`);
console.log(`[Gateway] WebSocket Server running on ${wsProtocol}://localhost:${config.wsPort}`);
console.log(`[Gateway] Waiting for game servers to register...`);
