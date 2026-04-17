
const useSSL = process.env.GATEWAY_USESSL === "true" || process.env.GATEWAY_USESSL === "1";
const httpPort = parseInt(process.env.GATEWAY_PORT || "9999");
const httpsPort = parseInt(process.env.GATEWAY_PORTSSL || "9443");
const serverPort = useSSL ? httpsPort : httpPort;

const config: GatewayConfig = {
  port: serverPort,
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "30000"),
  serverTimeout: parseInt(process.env.SERVER_TIMEOUT || "90000"),
  sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || "300000"),
  authKey: process.env.GATEWAY_AUTH_KEY || null
};

const gameServers: Map<string, GameServer> = new Map();

const clientSessions: Map<string, ClientSession> = new Map();

let totalMigrations = 0;
const migrationHistory: Array<{
  timestamp: number;
  fromServer: string;
  toServer: string;
  clientCount: number;
}> = [];

const dashboardSessions: Map<string, number> = new Map();
const DASHBOARD_SESSION_TIMEOUT = 3600000;

function migrateSessionsFromDeadServer(deadServerId: string): number {
  const sessionsToMigrate: string[] = [];

  for (const [clientId, session] of clientSessions.entries()) {
    if (session.serverId === deadServerId) {
      sessionsToMigrate.push(clientId);
    }
  }

  if (sessionsToMigrate.length === 0) {
    return 0;
  }

  const healthyServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (healthyServers.length === 0) {
    console.warn(`[Gateway] No healthy servers available for migration from ${deadServerId}`);

    for (const clientId of sessionsToMigrate) {
      clientSessions.delete(clientId);
    }
    return 0;
  }

  console.log(`[Gateway] Migrating ${sessionsToMigrate.length} sessions from dead server ${deadServerId}`);

  let migrationIndex = 0;
  let migratedCount = 0;

  for (const clientId of sessionsToMigrate) {
    const session = clientSessions.get(clientId);
    if (!session) continue;

    const targetServer = healthyServers[migrationIndex % healthyServers.length];
    migrationIndex++;

    session.serverId = targetServer.id;
    session.lastActivity = Date.now();

    migratedCount++;
    console.log(`[Gateway] Migrated client ${clientId}: ${deadServerId} → ${targetServer.id}`);
  }

  if (migratedCount > 0) {
    healthyServers[0].id;
    migrationHistory.push({
      timestamp: Date.now(),
      fromServer: deadServerId,
      toServer: migratedCount === 1 ? healthyServers[0].id : `${healthyServers.length} servers`,
      clientCount: migratedCount
    });

    if (migrationHistory.length > 100) {
      migrationHistory.shift();
    }

    totalMigrations += migratedCount;
  }

  return migratedCount;
}

function cleanupDeadServers() {
  const now = Date.now();
  for (const [id, server] of gameServers.entries()) {
    if (now - server.lastHeartbeat > config.serverTimeout) {
      console.log(`[Gateway] Server died: ${id} (${server.host}:${server.port})`);

      const migratedCount = migrateSessionsFromDeadServer(id);

      if (migratedCount > 0) {
        console.log(`[Gateway] Successfully migrated ${migratedCount} sessions from ${id}`);
      } else {
        console.log(`[Gateway] No sessions to migrate from ${id}`);
      }

      gameServers.delete(id);
    }
  }
}

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

setInterval(cleanupDeadServers, config.heartbeatInterval);
setInterval(cleanupExpiredSessions, 60000);

const serverConfig: any = {
  port: config.port,
  hostname: "0.0.0.0",
  async fetch(req: any) {
    const url = new URL(req.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (url.pathname === "/register" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, host, publicHost, port, wsPort, useSSL, maxConnections, authKey, description, whitelisted } = body;

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

        const existingServer = gameServers.get(id);
        const isReRegistration = !!existingServer;

        const server: GameServer = {
          id,
          description,
          host,
          publicHost: publicHost || host,
          port,
          wsPort,
          useSSL: useSSL === true,
          lastHeartbeat: Date.now(),
          activeConnections: existingServer?.activeConnections || 0,
          maxConnections: maxConnections || 1000,
          whitelisted: whitelisted === true
        };

        gameServers.set(id, server);

        if (isReRegistration) {
          console.log(`[Gateway] Server re-registered: ${id} (${host}:${port}, ${useSSL ? 'wss' : 'ws'}:${wsPort})`);
        } else {
          console.log(`[Gateway] Server registered: ${id} (${host}:${port}, ${useSSL ? 'wss' : 'ws'}:${wsPort})`);
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

    if (url.pathname === "/heartbeat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, activeConnections, cpuUsage, ramUsage, authKey, rtt } = body;

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

          if (cpuUsage !== undefined) server.cpuUsage = cpuUsage;
          if (ramUsage !== undefined) server.ramUsage = ramUsage;

          if (rtt !== undefined) {
            server.latency = Math.round(rtt / 2);
          }

          return new Response(JSON.stringify({
            success: true,
            timestamp: Date.now()
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

    if (url.pathname === "/unregister" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, authKey } = body;

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


    if (url.pathname === "/api/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const { authKey } = body;

        if (authKey === config.authKey) {

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

      dashboardSessions.set(sessionToken, Date.now() + DASHBOARD_SESSION_TIMEOUT);

      const servers = Array.from(gameServers.values()).map(s => ({
        id: s.id,
        description: s.description || '',
        host: s.host,
        publicHost: s.publicHost,
        port: s.port,
        activeConnections: s.activeConnections,
        maxConnections: s.maxConnections,
        lastHeartbeat: s.lastHeartbeat,
        cpuUsage: s.cpuUsage || 0,
        ramUsage: s.ramUsage || 0,
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

    if (url.pathname === "/dashboard" && req.method === "GET") {
      const cookies = req.headers.get('cookie') || '';
      const sessionMatch = cookies.match(/dashboard_session=([^;]+)/);

      if (!sessionMatch) {

        return Response.redirect("/", 302);
      }

      const sessionToken = sessionMatch[1];
      const sessionExpiry = dashboardSessions.get(sessionToken);

      if (!sessionExpiry || Date.now() > sessionExpiry) {
        dashboardSessions.delete(sessionToken);
        return Response.redirect("/", 302);
      }

      const dashboardHTML = await Bun.file(new URL("../webserver/public/dashboard.html", import.meta.url)).text();
      return new Response(dashboardHTML, {
        headers: { "Content-Type": "text/html" }
      });
    }

    if (url.pathname === "/" && req.method === "GET") {
      const loginHTML = await Bun.file(new URL("../webserver/public/login.html", import.meta.url)).text();
      return new Response(loginHTML, {
        headers: { "Content-Type": "text/html" }
      });
    }

    // Static file serving for CSS, JS, and other assets
    if (url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/") || url.pathname.startsWith("/images/")) {
      try {
        const filePath = new URL(`../webserver/public${url.pathname}`, import.meta.url);
        const file = await Bun.file(filePath).bytes();

        let contentType = "application/octet-stream";
        if (url.pathname.endsWith(".css")) contentType = "text/css";
        else if (url.pathname.endsWith(".js")) contentType = "application/javascript";
        else if (url.pathname.endsWith(".png")) contentType = "image/png";
        else if (url.pathname.endsWith(".jpg") || url.pathname.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (url.pathname.endsWith(".gif")) contentType = "image/gif";
        else if (url.pathname.endsWith(".svg")) contentType = "image/svg+xml";
        else if (url.pathname.endsWith(".woff")) contentType = "font/woff";
        else if (url.pathname.endsWith(".woff2")) contentType = "font/woff2";
        else if (url.pathname.endsWith(".ttf")) contentType = "font/ttf";

        return new Response(file, {
          status: 200,
          headers: { "Content-Type": contentType }
        });
      } catch (error) {
        return new Response("Not found", { status: 404 });
      }
    }

    if (url.pathname === "/status" && req.method === "GET") {
      const servers = Array.from(gameServers.values()).map(s => {
        const isHealthy = (Date.now() - s.lastHeartbeat) < config.serverTimeout;
        const isFull = s.activeConnections >= s.maxConnections;

        return {
          id: s.id,
          description: s.description || '',
          publicHost: s.publicHost,
          port: s.port,
          wsPort: s.wsPort,
          useSSL: s.useSSL,
          activeConnections: s.activeConnections,
          maxConnections: s.maxConnections,
          latency: s.latency || 0,
          whitelisted: s.whitelisted || false,
          status: !isHealthy ? 'offline' : (isFull ? 'full' : 'online')
        };
      });

      return new Response(JSON.stringify({
        totalServers: gameServers.size,
        servers
      }), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

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
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    const gatewayRoutes = ['/register', '/heartbeat', '/unregister', '/status', '/debug', '/api', '/dashboard'];
    const webRoutes = ['/','/login','/logout'];
    const isGatewayRoute = gatewayRoutes.some(route => url.pathname.startsWith(route)) || url.pathname === '/';
    const isWebRoute = webRoutes.some(route => url.pathname === route);

    if (!isGatewayRoute && !isWebRoute) {
      const availableServers = Array.from(gameServers.values());
      if (availableServers.length === 0) {
        return new Response("No game servers available", { status: 503 });
      }

      const cookies = req.headers.get('cookie') || '';
      const httpSessionMatch = cookies.match(/gateway_http_session=([^;]+)/);
      let targetServer: GameServer | null = null;
      let httpSessionId: string | null = null;
      let isNewSession = false;

      if (httpSessionMatch) {
        httpSessionId = httpSessionMatch[1] as string;

        const session = clientSessions.get(httpSessionId);
        if (session) {
          targetServer = gameServers.get(session.serverId) || null;
        }
      }

      if (!targetServer) {
        targetServer = availableServers[Math.floor(Math.random() * availableServers.length)];

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

        const proxyResponse = await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body
        });

        const responseHeaders = new Headers(proxyResponse.headers);

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

if (useSSL) {
  const certPath = process.env.GATEWAY_CERT_PATH || "./src/certs/gateway/cert.pem";
  const keyPath = process.env.GATEWAY_KEY_PATH || "./src/certs/gateway/key.pem";
  const caPath = process.env.GATEWAY_CA_PATH || "./src/certs/gateway/cert.ca-bundle";

  try {

    const cert = await Bun.file(certPath).text();
    const ca = await Bun.file(caPath).text();
    const fullChain = cert + "\n" + ca;

    serverConfig.tls = {
      cert: fullChain,
      key: Bun.file(keyPath),
    };
    console.log(`[Gateway] SSL enabled with cert: ${certPath} and CA bundle: ${caPath}`);
  } catch (error) {
    console.error(`[Gateway] Failed to load SSL certificates. Falling back to HTTP.`);
    console.error(`[Gateway] Make sure ${certPath}, ${keyPath}, and ${caPath} exist.`);
    console.error(`[Gateway] Error: ${error}`);
  }
}

Bun.serve(serverConfig);

const protocol = useSSL ? 'https' : 'http';
console.log(`[Gateway] Gateway Server running on ${protocol}://localhost:${config.port}`);
console.log(`[Gateway] Waiting for game servers to register...`);

if (useSSL) {
  const httpPort = parseInt(process.env.GATEWAY_PORT || "9999");
  Bun.serve({
    hostname: "0.0.0.0",
    port: httpPort,
    fetch(req: Request) {
      const url = new URL(req.url);

      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

      if (isLocalhost && url.pathname === '/status' && req.method === 'GET') {

        const servers = Array.from(gameServers.values()).map(s => {
          const isHealthy = (Date.now() - s.lastHeartbeat) < config.serverTimeout;
          const isFull = s.activeConnections >= s.maxConnections;

          return {
            id: s.id,
            description: s.description || '',
            publicHost: s.publicHost,
            port: s.port,
            wsPort: s.wsPort,
            useSSL: s.useSSL,
            activeConnections: s.activeConnections,
            maxConnections: s.maxConnections,
            status: !isHealthy ? 'unhealthy' : isFull ? 'full' : 'available'
          };
        });

        return new Response(JSON.stringify({
          totalServers: gameServers.size,
          servers
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      const sslPort = config.port === 443 ? "" : `:${config.port}`;
      const httpsUrl = `https://${url.hostname}${sslPort}${url.pathname}${url.search}`;
      console.log(`[Gateway] Redirecting HTTP request to: ${httpsUrl}`);
      return Response.redirect(httpsUrl, 301);
    }
  });
  console.log(`[Gateway] HTTP redirect server running on http://localhost:${httpPort}`);
}

export {}