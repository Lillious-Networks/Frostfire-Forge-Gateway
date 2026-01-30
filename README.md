<p align="center">
  <img src="./assets/gateway-logo.png" width="200">
</p>

<h1 align="center">🌐 Frostfire Forge Gateway 🌐</h1>

<p align="center">
  <strong>WebSocket Load Balancer & Session Manager</strong>
</p>

<p align="center">
A high-performance WebSocket gateway designed for load balancing, sticky sessions, and automatic failover across multiple backend servers. Built with Bun for blazing-fast WebSocket proxying.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-production-green?style=flat-square&label=Status" alt="Production Ready">
  <img src="https://img.shields.io/badge/bun-latest-orange?style=flat-square&logo=bun" alt="Bun Runtime">
  <img src="https://img.shields.io/badge/WebSocket-RFC%206455-blue?style=flat-square" alt="WebSocket Protocol">
</p>

---

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Gateway](#running-the-gateway)
- [Environment Variables](#-environment-variables)
- [Server Registration API](#-server-registration-api)
- [Docker Deployment](#-docker-deployment)
- [Load Balancing Strategy](#-load-balancing-strategy)
- [Session Management](#-session-management)
- [Health Monitoring](#-health-monitoring)
- [Monitoring & Logging](#-monitoring--logging)
  - [Dashboard](#dashboard)
  - [API Endpoints](#api-endpoints)

---

## ✨ Features

### Core Capabilities
- **WebSocket Proxying**: Transparent bidirectional message forwarding between clients and backend servers
- **Sticky Sessions**: Clients maintain persistent connections to the same backend server
- **Round-Robin Load Balancing**: Even distribution of new connections across available servers
- **Automatic Failover**: Seamless migration of sessions when backend servers go offline
- **Health Monitoring**: Continuous heartbeat monitoring with automatic dead server removal
- **Backpressure Handling**: Built-in message queuing to prevent WebSocket buffer overflow
- **HTTP Proxying**: Routes HTTP requests to backend servers for API endpoints
- **Session Persistence**: Configurable session timeout with automatic cleanup

### Advanced Features
- **Multi-Server Support**: Connect unlimited backend servers on same or different machines
- **Dynamic Server Registration**: Backend servers register/unregister at runtime
- **Migration History**: Tracks all session migrations for monitoring and debugging
- **Connection Limits**: Configurable max connections per backend server
- **Authentication**: Secure server registration with shared secret keys
- **Real-time Dashboard**: Web-based monitoring dashboard with authentication
- **System Metrics**: CPU, RAM, latency, and connection monitoring per server
- **Console Logging**: Detailed logging of all gateway operations and events

---

## 🏗️ Architecture

### System Overview

```
┌──────────┐                    ┌─────────────────┐
│          │◄───HTTP/WS────────►│                 │
│  Client  │    :8000/:9000     │    Gateway      │
│          │                    │                 │
└──────────┘                    └────────┬────────┘
                                         │
                          ┌──────────────┼──────────────┐
                          │              │              │
                          ▼              ▼              ▼
                   ┌──────────┐   ┌──────────┐   ┌──────────┐
                   │ Server 1 │   │ Server 2 │   │ Server N │
                   │ :8080    │   │ :8080    │   │ :8080    │
                   │ :3001    │   │ :3001    │   │ :3001    │
                   └──────────┘   └──────────┘   └──────────┘
```

### Request Flow

1. **Client Connection**: Client connects to gateway WebSocket endpoint with `clientId` parameter
2. **Server Assignment**: Gateway selects backend server using round-robin algorithm
3. **Session Creation**: Creates sticky session mapping `clientId` → `serverId`
4. **Proxy Connection**: Establishes WebSocket connection to assigned backend server
5. **Message Forwarding**: All subsequent messages are proxied to the same backend server
6. **Bidirectional Communication**: Backend server responses are forwarded back to client

### Session Lifecycle

```
[Client Connect] → [Session Check] → [Server Assignment] → [Proxy Create]
                        │                                          │
                        └─ Existing Session ──────────────────────┘
                                │
                                ▼
                        [Message Forwarding]
                                │
                    ┌───────────┴───────────┐
                    │                       │
                [Client DC]            [Server Fail]
                    │                       │
                    ▼                       ▼
            [Session Cleanup]      [Session Migration]
```

---

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
bun install

# Generate configuration
bun run create-config
```

### Configuration

Create a `.env.gateway` file:

```bash
WEBSRV_PORT=8000
WS_PORT=9000
WEBSRV_USESSL=false
GATEWAY_AUTH_KEY=your_secret_key_here
HEARTBEAT_INTERVAL=1000
SERVER_TIMEOUT=3000
SESSION_TIMEOUT=1800000
```

Or run the configuration generator:

```bash
bun run create-config
```

This will prompt you for:
- HTTP server port (default: 8000)
- WebSocket port (default: 9000)
- SSL enabled (default: false)
- Authentication key
- Heartbeat interval (default: 1000ms)
- Server timeout (default: 3000ms)
- Session timeout (default: 1800000ms)

### Running the Gateway

**Development:**
```bash
bun run dev
```

**Production:**
```bash
bun run server.ts
```

The gateway will start on:
- HTTP: `http://localhost:8000`
- WebSocket: `ws://localhost:9000`

---

## ⚙️ Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `WEBSRV_PORT` | HTTP server port | `8000` | No |
| `WS_PORT` | WebSocket server port | `9000` | No |
| `WEBSRV_USESSL` | Enable SSL/TLS | `false` | No |
| `GATEWAY_AUTH_KEY` | Authentication key for server registration | - | **Yes** |
| `HEARTBEAT_INTERVAL` | How often servers send heartbeats (ms) | `1000` | No |
| `SERVER_TIMEOUT` | Time before marking server as dead (ms) | `3000` | No |
| `SESSION_TIMEOUT` | Session expiration time (ms) | `1800000` | No |

> [!IMPORTANT]
> `GATEWAY_AUTH_KEY` must match the authentication key configured on backend servers

---

## 🔌 Server Registration API

Backend servers register with the gateway using HTTP POST requests.

### Registration Endpoint

**POST** `/register`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "id": "server-unique-id",
  "host": "game-server-1",
  "publicHost": "yourdomain.com",
  "port": 8080,
  "wsPort": 3001,
  "maxConnections": 1000,
  "authKey": "your_secret_key"
}
```

**Response (Success - 200):**
```json
{
  "message": "Server registered successfully",
  "serverId": "server-unique-id"
}
```

**Response (Error - 401):**
```json
{
  "error": "Invalid authentication key"
}
```

### Heartbeat Endpoint

**POST** `/heartbeat`

**Request Body:**
```json
{
  "serverId": "server-unique-id",
  "activeConnections": 42,
  "cpuUsage": 45.2,
  "ramUsage": 2048,
  "ramTotal": 8192,
  "authKey": "your_secret_key"
}
```

**Fields:**
- `serverId`: Unique server identifier
- `activeConnections`: Current number of active connections
- `cpuUsage` (optional): CPU usage percentage (0-100)
- `ramUsage` (optional): RAM usage in MB
- `ramTotal` (optional): Total available RAM in MB
- `authKey`: Gateway authentication key

Backend servers must send heartbeats at intervals <= `HEARTBEAT_INTERVAL`. Servers that miss heartbeats for longer than `SERVER_TIMEOUT` are marked as dead and removed.

### Unregister Endpoint

**POST** `/unregister`

**Request Body:**
```json
{
  "serverId": "server-unique-id",
  "authKey": "your_secret_key"
}
```

---

## 🐳 Docker Deployment

### Using Pre-built Image

```bash
docker pull ghcr.io/lillious-networks/frostfire-gateway:latest

docker run -d \
  -p 8000:8000 \
  -p 9000:9000 \
  -e GATEWAY_AUTH_KEY=your_secret_key \
  --name gateway \
  ghcr.io/lillious-networks/frostfire-gateway:latest
```

### Building Custom Image

**Dockerfile:**
```dockerfile
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production

COPY . .

ARG HTTP_PORT=8000
ARG HTTPS_PORT=443
ARG WS_PORT=9000

EXPOSE ${HTTP_PORT}
EXPOSE ${HTTPS_PORT}
EXPOSE ${WS_PORT}

CMD ["bun", "run", "server.ts"]
```

**Build:**
```bash
docker build \
  --build-arg HTTP_PORT=8000 \
  --build-arg WS_PORT=9000 \
  -t frostfire-gateway .
```

**Run:**
```bash
docker run -d \
  -p 8000:8000 \
  -p 9000:9000 \
  --env-file .env.gateway \
  --name gateway \
  frostfire-gateway
```

### Docker Compose

```yaml
version: '3.8'

services:
  gateway:
    image: frostfire-gateway
    ports:
      - "8000:8000"
      - "9000:9000"
    environment:
      - GATEWAY_AUTH_KEY=${GATEWAY_AUTH_KEY}
    env_file:
      - .env.gateway
    restart: unless-stopped
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
```

---

## 🎯 Load Balancing Strategy

### Round-Robin Algorithm

New client connections are distributed evenly across all available backend servers:

```typescript
// Example distribution for 3 servers
Client 1 → Server A
Client 2 → Server B
Client 3 → Server C
Client 4 → Server A
Client 5 → Server B
...
```

### Sticky Sessions

Once assigned, a client always connects to the same backend server:

```typescript
// Client ID: user-abc123
Connection 1 → Server A
Connection 2 → Server A  (reconnect)
Connection 3 → Server A  (reconnect)
```

The gateway maintains a session map:
```typescript
Map<clientId, { serverId, lastActivity }>
```

### Server Selection Logic

```typescript
1. Check if client has existing session
   └─ Yes → Use assigned server
   └─ No  → Continue

2. Get all healthy servers
   └─ Filter servers with activeConnections < maxConnections

3. If no healthy servers available
   └─ Return error: "NO SERVER AVAILABLE"

4. Select server using round-robin
   └─ Index = currentRoundRobinIndex % serverCount
   └─ Increment currentRoundRobinIndex

5. Create session for client
```

---

## 💾 Session Management

### Session Storage

Sessions are stored in-memory with the following structure:

```typescript
interface Session {
  serverId: string;        // Assigned backend server ID
  lastActivity: number;    // Unix timestamp in milliseconds
}

// Map: clientId → Session
const clientSessions = new Map<string, Session>();
```

### Session Timeout

Sessions are automatically cleaned up when:
- No activity for `SESSION_TIMEOUT` milliseconds (default: 30 minutes)
- Client explicitly disconnects
- Backend server goes offline (triggers migration)

### Cleanup Process

```typescript
// Runs every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [clientId, session] of clientSessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      clientSessions.delete(clientId);
      // Close proxy connection
    }
  }
}, 60000);
```

---

## 🏥 Health Monitoring

### Heartbeat System

Backend servers send periodic heartbeats to prove they're alive:

```typescript
// Server → Gateway (every 5 seconds)
POST /heartbeat
{
  "serverId": "server-abc",
  "activeConnections": 42,
  "authKey": "secret"
}
```

### Dead Server Detection

```typescript
// Runs every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (const [serverId, server] of gameServers) {
    if (now - server.lastHeartbeat > SERVER_TIMEOUT) {
      // Server is dead
      handleDeadServer(serverId);
    }
  }
}, HEARTBEAT_INTERVAL);
```

### Automatic Failover

When a server dies:

1. **Mark Server as Dead**: Remove from available servers pool
2. **Identify Affected Sessions**: Find all sessions assigned to dead server
3. **Migrate Sessions**: Reassign sessions to healthy servers using round-robin
4. **Update Session Map**: Update `clientSessions` with new server assignments
5. **Close Proxy Connections**: Clean up WebSocket connections to dead server
6. **Log Migration**: Record migration event in history

```typescript
// Example migration
Dead Server: server-A (10 sessions)
↓
Healthy Servers: [server-B, server-C]
↓
Migrations:
  - client-1 → server-B
  - client-2 → server-C
  - client-3 → server-B
  - client-4 → server-C
  ...
```

---

## 📊 Monitoring & Logging

### Dashboard

The gateway includes a **real-time monitoring dashboard** protected by authentication.

**Access the dashboard:**
```
1. Navigate to: http://gateway:8000/
2. Enter your GATEWAY_AUTH_KEY
3. View real-time server metrics
```

**Dashboard Features:**
- 📈 **Real-time Metrics**: CPU, RAM, latency, and connection counts
- 🖥️ **Server Health Status**: Visual indicators for healthy/unhealthy servers
- 📊 **Progress Bars**: Color-coded usage indicators (green → yellow → red)
- 🔄 **Auto-refresh**: Updates every 5 seconds
- 🔒 **Session Management**: 1-hour authenticated sessions with auto-logout

**Dashboard Screenshot:**
```
┌─────────────────────────────────────────────────────┐
│ Total Servers: 3  │  Healthy: 3  │  Sessions: 126  │
├─────────────────────────────────────────────────────┤
│ Server: game-server-1                    [HEALTHY]  │
│ CPU: 45% ████████░░░░░░░░░░                        │
│ RAM: 2048/8192 MB (25%) ██████░░░░░░░░░░░░░░       │
│ Connections: 42/1000 (4%)                           │
│ Latency: 5ms                                        │
└─────────────────────────────────────────────────────┘
```

### API Endpoints

**Authentication Required:**

All dashboard API endpoints require a valid session cookie obtained via `/api/login`.

#### Login

**POST** `/api/login`

Authenticate and create a session.

**Request:**
```json
{
  "authKey": "your_gateway_auth_key"
}
```

**Response (Success):**
```json
{
  "success": true,
  "sessionToken": "uuid-session-token"
}
```

Sets `dashboard_session` cookie (HttpOnly, 1 hour expiry).

#### Logout

**POST** `/api/logout`

Invalidate the current session.

**Response:**
```json
{
  "success": true
}
```

#### Stats

**GET** `/api/stats`

Get detailed server statistics and metrics.

**Response:**
```json
{
  "timestamp": 1704067200000,
  "totalServers": 3,
  "healthyServers": 3,
  "totalActiveSessions": 126,
  "totalMigrations": 5,
  "recentMigrations": [
    {
      "timestamp": 1704067100000,
      "fromServer": "server-dead",
      "toServer": "3 servers",
      "clientCount": 15
    }
  ],
  "servers": [
    {
      "id": "server-abc",
      "host": "game-1",
      "publicHost": "yourdomain.com",
      "port": 8080,
      "wsPort": 3001,
      "activeConnections": 42,
      "maxConnections": 1000,
      "lastHeartbeat": 1704067199000,
      "cpuUsage": 45.2,
      "ramUsage": 2048,
      "ramTotal": 8192,
      "latency": 5,
      "status": "healthy"
    }
  ]
}
```

### Console Logging

The gateway logs important events:

```
[Gateway] HTTP Server running on http://localhost:8000
[Gateway] WebSocket Server running on ws://localhost:9000
[Gateway] Waiting for game servers to register...

[Gateway] Server registered: server-abc (game-1:8080, ws:3001)
[Gateway] Client connected: client-xyz, finding server...
[Gateway] ✓ NEW SESSION: Created session for client client-xyz → server server-abc
[Gateway] Creating proxy connection to game server: ws://game-1:3001
[Gateway] Proxy connection established for client client-xyz

[Gateway] ⚠️ Server server-abc missed heartbeat (timeout: 15000ms)
[Gateway] ❌ Server server-abc is dead, migrating 10 sessions
[Gateway] Migrated client client-xyz: server-abc → server-def
```

---

## 🔒 Security Considerations

### Authentication

- All server registration requests require `authKey` validation
- Use strong, random authentication keys (minimum 32 characters)
- Rotate authentication keys periodically

### Network Security

- Run gateway behind a firewall
- Use SSL/TLS for production deployments
- Restrict backend server access to gateway IP only
- Implement rate limiting for HTTP endpoints

### Best Practices

```bash
# Generate secure authentication key
openssl rand -base64 32

# Example: Add to .env.gateway
GATEWAY_AUTH_KEY=AbCd1234EfGh5678IjKl9012MnOp3456
```

---

## 🛠️ Troubleshooting

### Server Registration Fails

**Problem**: Backend servers can't register with gateway

**Solutions**:
- Verify `GATEWAY_AUTH_KEY` matches on both gateway and backend
- Check network connectivity: `curl http://gateway:8000/register`
- Ensure gateway is running before starting backend servers
- Check gateway logs for authentication errors

### WebSocket Connection Fails

**Problem**: Clients can't connect to gateway WebSocket

**Solutions**:
- Verify WebSocket port is exposed: `netstat -an | grep 9000`
- Check firewall rules allow inbound connections on WS port
- Test WebSocket connection: `wscat -c ws://localhost:9000?clientId=test`
- Review gateway logs for connection errors

### Session Migration Not Working

**Problem**: Sessions don't migrate when server dies

**Solutions**:
- Verify `SERVER_TIMEOUT` > `HEARTBEAT_INTERVAL`
- Check that healthy servers exist with available capacity
- Review gateway console logs for migration events
- Ensure backend servers send heartbeats correctly

### High Memory Usage

**Problem**: Gateway memory usage grows over time

**Solutions**:
- Reduce `SESSION_TIMEOUT` to clean up inactive sessions faster
- Check for WebSocket connection leaks in backend servers
- Monitor gateway console logs for session count warnings
- Restart gateway periodically in production

---

## 📈 Performance Tuning

### Recommended Settings

**Small Deployment (< 100 concurrent users):**
```bash
HEARTBEAT_INTERVAL=2000
SERVER_TIMEOUT=6000
SESSION_TIMEOUT=3600000
```

**Medium Deployment (100-1000 concurrent users):**
```bash
HEARTBEAT_INTERVAL=1000
SERVER_TIMEOUT=3000
SESSION_TIMEOUT=1800000
```

**Large Deployment (> 1000 concurrent users):**
```bash
HEARTBEAT_INTERVAL=1000
SERVER_TIMEOUT=3000
SESSION_TIMEOUT=900000
```

### Scaling Considerations

- **Vertical Scaling**: Gateway is single-threaded; use faster CPU for higher throughput
- **Horizontal Scaling**: Deploy multiple gateway instances behind L4 load balancer
- **Backend Scaling**: Add more backend servers as load increases
- **Connection Limits**: Set `maxConnections` per backend server based on capacity testing

---

<p align="center">
  <sub>Built with ❤️ using Bun</sub>
</p>
