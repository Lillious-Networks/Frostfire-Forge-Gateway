# Frostfire Forge Gateway

A production-grade authentication and reverse proxy gateway for Frostfire Forge game servers. Provides centralized user authentication, game server registration, automatic failover, real-time health monitoring, and realm-based server routing.

## Features

- **Dual-Server Architecture:** Separate webserver (user auth, asset serving) and gateway server (game server management)
- **Game Server Authentication & Registration:** Automatic server discovery and registration with heartbeat monitoring
- **User Authentication:** Login, registration, email verification, password reset
- **Automatic Server Failover:** Detects dead servers and migrates active client sessions automatically
- **Real-Time Monitoring Dashboard:** Server health, CPU/RAM usage, connection counts, latency metrics
- **HTTP Proxying:** Intelligent routing to game servers
- **SSL/TLS Support:** Full HTTPS support for both webserver and gateway
- **Realm Routing:** Client requests routed to appropriate game server realms
- **Asset Delivery:** Gzip-compressed tileset and map data serving
- **Docker Ready:** Development and production-ready containerization

## Architecture Overview

The gateway consists of two independent servers:

```
┌─────────────────────────────────────────────────────────────┐
│                      GAME CLIENTS                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    HTTP/HTTPS (80/443)
                           │
        ┌──────────────────▼────────────────────┐
        │    WEBSERVER (80/443)                 │
        │  - User authentication                │
        │  - Asset/map serving                  │
        │  - HTTP proxying to game servers      │
        │  - Connection token generation        │
        └──────────────────┬────────────────────┘
                           │
                    HTTP (Port 80)
                           │
        ┌──────────────────▼────────────────────┐
        │  GATEWAY SERVER (9999/9443)           │
        │  - Game server registration           │
        │  - Heartbeat monitoring               │
        │  - Failover & session migration       │
        │  - Health monitoring dashboard        │
        │  - Server status API                  │
        └──────────────────┬────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │ Game Srv 1 │   │ Game Srv 2 │   │ Game Srv N │
    │  :3000     │   │  :3000     │   │  :3000     │
    └────────────┘   └────────────┘   └────────────┘
```

### Server Responsibilities

**Webserver (port 80/443):**
- User login, registration, email verification
- Password reset functionality
- Static asset delivery (HTML, CSS, JS, images, fonts, music)
- Tileset and map chunk delivery (gzip compressed)
- HTTP request proxying to registered game servers
- Realm-based server routing

**Gateway Server (port 9999/9443):**
- Game server registration and management
- Heartbeat health monitoring
- Automatic dead server cleanup
- Session migration on server failure
- Real-time monitoring dashboard
- Server status API endpoints
- Administrative authentication

## Quick Start

### Prerequisites

- **Bun 1.0+** - Runtime (install from https://bun.sh)
- **MySQL/MariaDB** - Database for user accounts and game state
- **SMTP Server** - For email verification (optional but recommended)

### Development

```bash
bun install
bun run development
```

This will:
1. Transpile client-side TypeScript
2. Start the webserver on port 80
3. Start the gateway server on port 9999

Access the game client at `http://localhost` and the monitoring dashboard at `http://localhost:9999/dashboard`

### Production

```bash
bun install
bun run production
```

Uses `.env.production` environment variables instead of `.env.development`.

## Setup Instructions

### 1. Database Setup

Create a MySQL database and user for the gateway:

```sql
CREATE DATABASE frostfire_gateway;
CREATE USER 'gateway_user'@'localhost' IDENTIFIED BY 'secure_password';
GRANT ALL PRIVILEGES ON frostfire_gateway.* TO 'gateway_user'@'localhost';
FLUSH PRIVILEGES;
```

The gateway will create tables automatically on first run.

### 2. Environment Configuration

Create `.env.development` or `.env.production`:

```bash
# Database Configuration
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_NAME=frostfire_gateway
DATABASE_USER=gateway_user
DATABASE_PASSWORD=your_secure_password
DATABASE_PORT=3306
SQL_SSL_MODE=DISABLED

# Gateway Server Configuration
GATEWAY_PORT=9999
GATEWAY_AUTH_KEY=your-uuid-key-here
GATEWAY_GAME_SERVER_SECRET=your-shared-secret
```

### 3. SSL/TLS Setup (Production Only)

Place your certificates in the following directories:

```
src/certs/
├── webserver/
│   ├── cert.pem           # Server certificate
│   ├── key.pem            # Private key
│   └── cert.ca-bundle     # Full CA chain (optional)
└── gateway/
    ├── cert.pem           # Server certificate
    ├── key.pem            # Private key
    └── cert.ca-bundle     # Full CA chain (optional)
```

Set environment variables:
```bash
WEBSRV_USESSL=true
WEBSRV_CERT_PATH=./src/certs/webserver/cert.pem
WEBSRV_KEY_PATH=./src/certs/webserver/key.pem
WEBSRV_CA_PATH=./src/certs/webserver/cert.ca-bundle
GATEWAY_USESSL=true
GATEWAY_CERT_PATH=./src/certs/gateway/cert.pem
GATEWAY_KEY_PATH=./src/certs/gateway/key.pem
GATEWAY_CA_PATH=./src/certs/gateway/cert.ca-bundle
```

### 4. Configuration

All configuration is managed via environment variables. See `.env.example` for available options:
- `GUEST_MODE_ENABLED` - Enable guest account mode (default: true)
- `DEFAULT_MAP` - Default map to load (default: overworld.json)
- `TWO_FA_ENABLED` - Enable two-factor authentication (default: false)
- `HEARTBEAT_INTERVAL` - Gateway heartbeat interval in ms (default: 30000)
- `SERVER_TIMEOUT` - Server timeout in ms (default: 90000)
- `SESSION_TIMEOUT` - Session timeout in ms (default: 300000)

Set `GATEWAY_AUTH_KEY` to a secure random value in your `.env` file before starting the gateway.

## Docker Deployment

### Development

```bash
docker-compose -f src/docker/docker-compose.dev.yml up -d
```

### Production

```bash
docker-compose -f src/docker/docker-compose.prod.yml up -d
```

The Docker setup includes:
- Multi-stage builds for optimized images
- Health checks on the gateway endpoint
- Volume mounts for logs and certificates
- Network isolation between services

## Game Server Integration

### Step 1: Register Server on Startup

When your game server starts, register it with the gateway:

```bash
POST /register HTTP/1.1
Host: gateway:9999
Content-Type: application/json

{
  "id": "game-server-001",
  "host": "192.168.1.100",                    # Internal IP
  "publicHost": "game1.example.com",          # Public hostname/IP for clients
  "port": 3000,                               # Primary connection port
  "wsPort": 3000,                             # WebSocket port (for game server use)
  "useSSL": false,                            # Whether game server uses SSL/TLS
  "maxConnections": 500,                      # Maximum concurrent players
  "authKey": "your-gateway-auth-key"          # Must match GATEWAY_AUTH_KEY
}
```

**Response:**
```json
{
  "success": true,
  "serverId": "game-server-001",
  "message": "Server registered successfully"
}
```

### Step 2: Send Heartbeats Every 30 Seconds

Continuously report server health:

```bash
POST /heartbeat HTTP/1.1
Host: gateway:9999
Content-Type: application/json

{
  "id": "game-server-001",
  "activeConnections": 42,                    # Current player count
  "cpuUsage": 45.2,                           # CPU usage percentage
  "ramUsage": 2048,                           # RAM usage in MB
  "rtt": 12,                                  # Round-trip latency in ms
  "authKey": "your-gateway-auth-key"
}
```

**Stop sending heartbeats and the server will be marked dead after 90 seconds.**

### Step 3: Handle Unregistration

On graceful shutdown, unregister from the gateway:

```bash
POST /unregister HTTP/1.1
Host: gateway:9999
Content-Type: application/json

{
  "id": "game-server-001",
  "authKey": "your-gateway-auth-key"
}
```

### Step 4: Validate Client Connection Tokens

When clients connect to your game server, they send a connection token. Validate it:

```typescript
// Token is sent in HTTP header (or initial message for other protocols)
const token = request.headers['x-connection-token'];

// Verify against the shared secret
const signature = hmacSHA256(token, GATEWAY_GAME_SERVER_SECRET);
const isValid = signature === request.headers['x-connection-signature'];
```

## Client Connection Flow

1. **Client connects to webserver** (port 80/443)
2. **Client logs in** via `POST /login`
3. **Client fetches available servers** via `GET /api/gateway/servers`
   - Returns list of healthy game servers sorted by load
4. **Client requests connection token** via `GET /api/gateway/connection-token`
   - Returns signed token valid for one connection
5. **Client connects directly to selected game server**
   - Includes token in connection headers or initial message
   - Note: Game server may use HTTP, WebSocket, or other protocol
6. **Game server validates token** using shared secret
7. **Session maintained** via heartbeats from game server to gateway

## Monitoring Dashboard

Access the real-time dashboard at `http://localhost:9999/dashboard`

Default credentials: Check logs for dashboard password (generated on first run)

**Dashboard Features:**
- Real-time server status (online/offline/degraded)
- CPU and RAM usage graphs
- Connection count per server
- Latency/RTT monitoring
- Migration history (last 100 failover events)
- Total migration count
- Server logs viewer

**Endpoints:**
- `GET /status` - Public server status (no auth required)
- `GET /debug/sessions` - View active client sessions (debug only)
- `GET /api/stats` - Dashboard statistics (requires auth)

## API Reference

### Webserver APIs (Port 80/443)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Login page |
| `/login` | POST | User authentication |
| `/register` | POST | New account registration |
| `/verify` | POST | Email verification |
| `/game` | GET | Game client HTML |
| `/api/gateway/servers` | GET | List available game servers |
| `/api/gateway/connection-token` | GET | Get signed connection token |
| `/tileset?name=NAME` | GET | Download gzip-compressed tileset |
| `/map-chunk?map=X&x=X&y=Y` | GET | Get map chunk data |

### Gateway Server APIs (Port 9999)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/register` | POST | Game server registration |
| `/heartbeat` | POST | Server health update |
| `/unregister` | POST | Server shutdown notification |
| `/status` | GET | Public server status |
| `/dashboard` | GET | Monitoring dashboard |
| `/api/stats` | GET | Dashboard statistics |
| `/debug/sessions` | GET | Active sessions (debug) |

## Security Considerations

### Authentication

- **Game Servers:** Authenticated via `GATEWAY_AUTH_KEY` (UUID format)
  - All requests from game servers must include `authKey` in JSON body
  - Key is shared and must be kept secure

- **Dashboard Access:** Session-based with HttpOnly cookies
  - Credentials generated on first run, stored in logs
  - Consider implementing LDAP/OAuth for production

- **Client Tokens:** HMAC-SHA256 signed with `GATEWAY_GAME_SERVER_SECRET`
  - One-time use tokens bound to specific game server
  - Prevents token replay across servers

### SSL/TLS

For production deployments:
1. Obtain valid SSL certificates from a trusted CA
2. Place in `certs/webserver/` and `certs/gateway/`
3. Set `WEBSRV_USESSL=true` and `GATEWAY_USESSL=true`
4. Use strong ciphers and TLS 1.2+

### Network Security

- Run gateway server (`9999`) only on internal network, not public
- Expose webserver port (`80/443`) to clients
- Use firewall rules to restrict game server port access
- Enable IP whitelist/blacklist via database security rules

### Secrets Management

- Regenerate `GATEWAY_AUTH_KEY` and `GATEWAY_GAME_SERVER_SECRET` for each deployment
- Never commit `.env` files or certificate keys to version control
- Use CI/CD secrets for environment variables
- Rotate secrets quarterly

## Troubleshooting

### Servers Not Registering

**Issue:** Game servers fail to register
- Check: Is `GATEWAY_AUTH_KEY` correctly set in both gateway and game server?
- Check: Can game servers reach gateway URL (`GATEWAY_URL`)?
- Check: Are game server requests including correct `authKey`?
- View logs: `cat logs/$(date +%Y-%m-%d).log`

### Clients Can't Connect

**Issue:** Clients receive "No available servers" error
- Check: Are game servers sending heartbeats? Use `GET /status` endpoint
- Check: Can clients reach webserver port (`WEBSRV_PORT`)?

### Session Migration Not Working

**Issue:** Clients disconnect when server goes down
- Check: Is `SERVER_TIMEOUT` set correctly (default 90s)?
- Check: Are you sending heartbeats every `HEARTBEAT_INTERVAL` seconds?
- View: Check migration history in dashboard

### Database Connection Errors

**Issue:** "Cannot connect to database" in logs
- Check: Database credentials in `.env` file
- Check: Database host/port accessibility (`mysql -u user -p -h host`)
- Check: Database exists (`SHOW DATABASES;`)
- For Docker: Verify service names in `docker-compose.yml`

### Email Verification Not Working

**Issue:** Users not receiving verification emails
- Check: `EMAIL_SERVICE`, `EMAIL_USER`, `EMAIL_PASSWORD` are correct
- View: Check logs for SMTP errors
- SMTP Ports: Usually 587 (TLS) or 465 (SSL)

### High Memory Usage

**Issue:** Gateway consuming excess memory
- Check: Number of active sessions (`GET /debug/sessions`)
- Tune: Adjust `SESSION_TIMEOUT` to lower value
- Consider: Switch to Redis caching if `CACHE=memory` is enabled

### Dashboard Auth Failing

**Issue:** Cannot log into monitoring dashboard
- Check: Credentials printed in logs on first run
- Check: Configuration environment variables are set correctly
- View: Check for login attempts in logs with `grep "dashboard"` logs/*

## Development

### Project Structure

```
├── src/
│   ├── start.ts             # Startup orchestrator
│   ├── webserver/
│   │   ├── server.ts        # Webserver (port 80)
│   │   ├── config/
│   │   │   └── security.cfg # Security rules (optional)
│   │   └── public/          # Client assets (HTML, CSS, JS, images, tilesets, maps)
│   ├── gateway/
│   │   └── server.ts        # Gateway server (port 9999)
│   ├── controllers/
│   │   ├── sqldatabase.ts   # Database interface
│   │   ├── sqldatabase.worker.ts # Worker thread for DB
│   │   └── utils.ts         # Utilities
│   ├── modules/
│   │   ├── logger.ts        # Logging
│   │   ├── hash.ts          # Password hashing
│   │   └── assetloader.ts   # Asset loading
│   ├── services/
│   │   ├── email.ts         # Email service
│   │   ├── verification.ts  # Email verification
│   │   ├── ip.ts            # IP management
│   │   └── assetCache.ts    # Asset caching
│   ├── systems/
│   │   ├── player.ts        # Player management
│   │   └── security.ts      # Security rules
│   ├── utility/
│   │   ├── create-config.ts # Config generation (unused)
│   │   └── transpiler.ts    # TS compilation
│   ├── docker/
│   │   ├── Dockerfile.dev   # Development Dockerfile
│   │   ├── Dockerfile.prod  # Production Dockerfile
│   │   ├── docker-compose.dev.yml # Development compose file
│   │   └── docker-compose.prod.yml # Production compose file
│   ├── certs/               # SSL certificates
│   └── logs/                # Application logs
├── package.json             # NPM configuration
├── .env.development         # Development environment variables
└── .env.production          # Production environment variables
```

### Running Tests

Currently, manual integration testing is recommended. To test the gateway:

```bash
# Terminal 1: Run gateway
bun run development

# Terminal 2: Register a test server
curl -X POST http://localhost:9999/register \
  -H "Content-Type: application/json" \
  -d '{"id":"test-1","host":"localhost","publicHost":"localhost","port":3000,"wsPort":3000,"maxConnections":100,"authKey":"GATEWAY_AUTH_KEY"}'

# Terminal 3: Send heartbeat
curl -X POST http://localhost:9999/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"id":"test-1","activeConnections":5,"cpuUsage":10,"ramUsage":512,"authKey":"GATEWAY_AUTH_KEY","rtt":5}'

# View dashboard
open http://localhost:9999/dashboard
```

### Logs

Application logs are written to `logs/YYYY-MM-DD.log`:

```bash
# View today's logs
tail -f logs/$(date +%Y-%m-%d).log

# Search for errors
grep ERROR logs/*.log
```

Set `LOG_LEVEL=debug` for detailed troubleshooting.

## Performance Tuning

### Database
- Increase connection pool size in `sqldatabase.ts` if many concurrent operations
- Use MySQL with InnoDB for better concurrency
- Add indexes to frequently queried columns

### Memory
- Set `CACHE=redis` for distributed caching if memory is constrained
- Lower `SESSION_TIMEOUT` to clean up old sessions faster
- Monitor with `GET /debug/sessions`

### Network
- Ensure low latency between webserver and gateway (same network if possible)
- Use CDN for static assets (JS, CSS, images)
- Compress responses with gzip (default for tilesets)

## Contributing

To contribute improvements:
1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes and test locally
3. Commit with clear messages
4. Push and create a pull request

## License

Frostfire Forge Gateway is part of the Frostfire Forge project.