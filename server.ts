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
  cpuUsage?: number;      // CPU usage percentage (0-100)
  ramUsage?: number;      // RAM usage in MB
  ramTotal?: number;      // Total RAM in MB
  latency?: number;       // Latency to server in ms
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

// Note: Gateway does NOT proxy WebSocket connections
// Clients connect directly to game servers after receiving assignment

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

// Dashboard authentication sessions: sessionToken → expiryTime
const dashboardSessions: Map<string, number> = new Map();
const DASHBOARD_SESSION_TIMEOUT = 3600000; // 1 hour

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
  roundRobinIndex++;

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
      const requestReceived = Date.now();
      try {
        const body = await req.json();
        const { id, activeConnections, cpuUsage, ramUsage, ramTotal, authKey, timestamp, rtt } = body;

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

          // Update metrics if provided
          if (cpuUsage !== undefined) server.cpuUsage = cpuUsage;
          if (ramUsage !== undefined) server.ramUsage = ramUsage;
          if (ramTotal !== undefined) server.ramTotal = ramTotal;

          // Use RTT provided by client (more accurate, clock-independent)
          if (rtt !== undefined) {
            server.latency = Math.round(rtt / 2); // Half of round-trip time
          }

          return new Response(JSON.stringify({
            success: true,
            timestamp: Date.now() // Send back timestamp for RTT calculation
          }), {
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

    // Dashboard login endpoint
    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const { authKey } = body;

        if (authKey === config.authKey) {
          // Generate session token
          const sessionToken = crypto.randomUUID();
          dashboardSessions.set(sessionToken, Date.now() + DASHBOARD_SESSION_TIMEOUT);

          return new Response(JSON.stringify({ success: true, sessionToken }), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `dashboard_session=${sessionToken}; HttpOnly; Path=/; Max-Age=3600; SameSite=Strict`
            }
          });
        }

        return new Response(JSON.stringify({ error: "Invalid authentication key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Dashboard logout endpoint
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const cookies = req.headers.get('cookie') || '';
      const sessionMatch = cookies.match(/dashboard_session=([^;]+)/);
      if (sessionMatch) {
        dashboardSessions.delete(sessionMatch[1]);
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "dashboard_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict"
        }
      });
    }

    // Dashboard stats endpoint (requires authentication)
    if (url.pathname === "/api/stats" && req.method === "GET") {
      const cookies = req.headers.get('cookie') || '';
      const sessionMatch = cookies.match(/dashboard_session=([^;]+)/);

      if (!sessionMatch) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      const sessionToken = sessionMatch[1];
      const sessionExpiry = dashboardSessions.get(sessionToken);

      if (!sessionExpiry || Date.now() > sessionExpiry) {
        dashboardSessions.delete(sessionToken);
        return new Response(JSON.stringify({ error: "Session expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Extend session
      dashboardSessions.set(sessionToken, Date.now() + DASHBOARD_SESSION_TIMEOUT);

      const servers = Array.from(gameServers.values()).map(s => ({
        id: s.id,
        host: s.host,
        publicHost: s.publicHost,
        port: s.port,
        wsPort: s.wsPort,
        activeConnections: s.activeConnections,
        maxConnections: s.maxConnections,
        lastHeartbeat: s.lastHeartbeat,
        cpuUsage: s.cpuUsage || 0,
        ramUsage: s.ramUsage || 0,
        ramTotal: s.ramTotal || 0,
        latency: s.latency || 0,
        status: (Date.now() - s.lastHeartbeat) < config.serverTimeout ? 'healthy' : 'unhealthy'
      }));

      return new Response(JSON.stringify({
        timestamp: Date.now(),
        totalServers: gameServers.size,
        healthyServers: servers.filter(s => s.status === 'healthy').length,
        totalActiveSessions: clientSessions.size,
        totalMigrations: totalMigrations,
        recentMigrations: migrationHistory.slice(-10),
        servers
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Dashboard page (requires authentication)
    if (url.pathname === "/dashboard" && req.method === "GET") {
      const cookies = req.headers.get('cookie') || '';
      const sessionMatch = cookies.match(/dashboard_session=([^;]+)/);

      if (!sessionMatch) {
        // Redirect to login
        return Response.redirect("/", 302);
      }

      const sessionToken = sessionMatch[1];
      const sessionExpiry = dashboardSessions.get(sessionToken);

      if (!sessionExpiry || Date.now() > sessionExpiry) {
        dashboardSessions.delete(sessionToken);
        return Response.redirect("/", 302);
      }

      // Serve dashboard HTML
      const dashboardHTML = await Bun.file("./public/dashboard.html").text();
      return new Response(dashboardHTML, {
        headers: { "Content-Type": "text/html" }
      });
    }

    // Login page
    if (url.pathname === "/" && req.method === "GET") {
      const loginHTML = await Bun.file("./public/login.html").text();
      return new Response(loginHTML, {
        headers: { "Content-Type": "text/html" }
      });
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
    const gatewayRoutes = ['/register', '/heartbeat', '/unregister', '/status', '/debug', '/api', '/dashboard'];
    const isGatewayRoute = gatewayRoutes.some(route => url.pathname.startsWith(route)) || url.pathname === '/';

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
      // Gateway does not handle messages - clients connect directly to game servers
      // This should not be called in normal operation
      console.warn(`[Gateway] Unexpected message received from client ${ws.clientId} - clients should connect directly to game servers`);
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
      // Clients should disconnect from gateway and connect directly to assigned server
      handleBackpressure(ws, () => {
        ws.send(JSON.stringify({
          type: "server_assignment",
          clientId: clientId,
          server: {
            host: server.publicHost,  // External hostname for clients
            port: server.port,        // Game server's HTTP port
            wsPort: server.wsPort     // Game server's WebSocket port
          }
        }));
      });

      console.log(`[Gateway] Client ${clientId} assigned to server: ${server.id} (${server.publicHost}:${server.wsPort})`);

      // Client should now disconnect from gateway and connect to assigned server directly
      // Gateway does NOT proxy connections - clients connect directly to game servers
    },
    close(ws: any) {
      const clientId = ws.clientId;
      if (clientId) {
        // Clean up packet queue
        packetQueue.delete(clientId);

        console.log(`[Gateway] Client disconnected from gateway: ${clientId}`);
      } else {
        console.log("[Gateway] Client disconnected from gateway");
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
