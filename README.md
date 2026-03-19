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
│                      GAME CLIENTS                           │
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
                    HTTP/HTTPS (9999/9443)
                           │
        ┌──────────────────▼────────────────────┐
        │  GATEWAY SERVER (9999/9443)           │
        │  - Game server registration           │
        │  - Heartbeat monitoring               │
        │  - Failover & session migration       │
        │  - Health monitoring dashboard        │
        │  - Server status API                  │
        └──────────────────────┬────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
            ▼                  ▼                  ▼
    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
    │  Game Srv 1  │   │  Game Srv 2  │   │  Game Srv 3  │
    │  :3000/3001  │   │  :3000/3001  │   │  :3000/3001  │
    └──────────────┘   └──────────────┘   └──────────────┘
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

## Environment Variables

Configuration is managed via environment variables in `.env.development` or `.env.production`:

```bash
# Database Configuration
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_NAME=frostfire_forge
DATABASE_USER=gateway_user
DATABASE_PASSWORD=secure_password
DATABASE_PORT=3306
SQL_SSL_MODE=DISABLED

# Gateway Server
GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
GATEWAY_USESSL=false
GATEWAY_CERT_PATH=./src/certs/gateway/cert.pem
GATEWAY_KEY_PATH=./src/certs/gateway/key.pem
GATEWAY_CA_PATH=./src/certs/gateway/cert.ca-bundle
GATEWAY_AUTH_KEY=your-uuid-key-here
GATEWAY_GAME_SERVER_SECRET=your-shared-secret

# Webserver
WEBSRV_PORT=80
WEBSRV_PORTSSL=443
WEBSRV_USESSL=false
WEBSRV_CERT_PATH=./src/certs/webserver/cert.pem
WEBSRV_KEY_PATH=./src/certs/webserver/key.pem
WEBSRV_CA_PATH=./src/certs/webserver/cert.ca-bundle

# Email
EMAIL_SERVICE=smtp.mailtrap.io
EMAIL_USER=your-email@example.com
EMAIL_PASSWORD=your-email-password

# Application Settings
LOG_LEVEL=debug
CACHE=memory
HEARTBEAT_INTERVAL=30000
SERVER_TIMEOUT=90000
SESSION_TIMEOUT=300000
GUEST_MODE_ENABLED=true
DEFAULT_MAP=overworld.json
TWO_FA_ENABLED=false
DOMAIN=http://localhost
GAME_NAME=Frostfire Forge
```

## Quick Start

### Prerequisites

- **Bun 1.0+** - Runtime (install from https://bun.sh)
- **MySQL/MariaDB** - Database for user accounts and game state
- **SMTP Server** - For email verification (optional but recommended)

### Development

**Option 1: Use prebuilt Docker image:**

```bash
docker run -d --name gateway-test -p 9999:9999 -p 80:80 ghcr.io/lillious-networks/frostfire-forge-gateway:latest
```

**Option 2: Build and run from source:**

```bash
bun development
```

Optionally edit `.env.development` to customize settings.

Access the game client at `http://localhost` and the monitoring dashboard at `http://localhost:9999/dashboard`

### Production

```bash
bun production
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

The game engine will create tables automatically on first run.

### 2. SSL/TLS Setup

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

Then update the following environment variables
```bash
WEBSRV_USESSL=true
GATEWAY_USESSL=true
```

Certificate paths are already configured in the environment variables section above.

## Docker Deployment

### Using Docker Compose

```bash
cd src/docker
docker-compose -f docker-compose.dev.yml up -d
docker-compose -f docker-compose.dev.yml logs -f gateway
docker-compose -f docker-compose.dev.yml down
```

### Build and Run Manually

```bash
docker build -f src/docker/Dockerfile.dev -t frostfire-forge-gateway:latest .

docker run -d \
  --name gateway \
  --env-file .env.development \
  -p 9999:9999 \
  -p 80:80 \
  frostfire-forge-gateway:latest
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
6. **Game server validates token** using shared secret
7. **Session maintained** via heartbeats from game server to gateway

## Monitoring Dashboard

Access the real-time dashboard at `http://localhost:9999/dashboard`

Default credentials: Value of `GATEWAY_AUTH_KEY`

**Dashboard Features:**
- Real-time server status
- CPU and RAM usage graphs
- Connection count per server
- Latency/RTT monitoring

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
- Check: `GATEWAY_AUTH_KEY`
- Check: Configuration environment variables are set correctly
- View: Check for login attempts in logs with `grep "dashboard"` logs/*

## Performance Tuning

### Database
- Increase connection pool size in `sqldatabase.ts` if many concurrent operations
- Use MySQL with InnoDB for better concurrency

### Memory
- Set `CACHE=redis` for distributed caching if memory is constrained
- Lower `SESSION_TIMEOUT` to clean up old sessions faster

### Network
- Use CDN for static assets (JS, CSS, images)
- Compress responses with gzip

## Contributing

To contribute improvements:
1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make changes and test locally
3. Commit with clear messages
4. Push and create a pull request

## License

Frostfire Forge Gateway is part of the Frostfire Forge project.