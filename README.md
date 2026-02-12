# Frostfire Forge Gateway

Authentication and load balancing gateway for Frostfire Forge game servers.

## Features

- WebSocket game server authentication and registration
- HTTP webserver for user authentication (login, registration, password reset)
- Load balancing with sticky sessions
- Real-time server health monitoring dashboard
- Automatic server failover and session migration
- SSL/TLS support for production deployments

## Quick Start

### Development

```bash
bun install
bun run start-dev
```

### Production

```bash
bun install
bun run start
```

## Environment Variables

Create `.env.development` or `.env.production`:

```bash
DATABASE_ENGINE=mysql
DATABASE_HOST="your_database_host"
DATABASE_NAME="your_database_name"
DATABASE_USER="your_database_user"
DATABASE_PASSWORD="your_database_password"
DATABASE_PORT=3306
SQL_SSL_MODE=DISABLED
SESSION_KEY="your-session-key-uuid-here"
EMAIL_SERVICE="your_email_service"
EMAIL_USER="your_email_user"
EMAIL_PASSWORD="your_email_password"
EMAIL_TEST="your_test_email"
WEBSRV_PORT=80
WEBSRV_PORTSSL=443
WEBSRV_USESSL=false
WEBSRV_CERT_PATH=./certs/cert.pem
WEBSRV_KEY_PATH=./certs/key.pem
DOMAIN="http://localhost"
GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
GATEWAY_USESSL=false
GATEWAY_AUTH_KEY="your-gateway-auth-key-uuid-here"
HEARTBEAT_INTERVAL=30000
SERVER_TIMEOUT=90000
SESSION_TIMEOUT=1800000
GATEWAY_ENABLED=true
GATEWAY_URL=http://localhost:9999
VERSION="1.0.0"
GAME_NAME="Your Game Name"
LOG_LEVEL=info
CACHE="memory"
```

## Docker Deployment

### Development

```bash
docker-compose -f docker-compose.dev.yml up -d
```

### Production

```bash
docker-compose -f docker-compose.prod.yml up -d
```

## Server Registration

Game servers register with the gateway using HTTP POST:

**POST** `http://gateway:9999/register`

```json
{
  "id": "server-unique-id",
  "host": "game-server-host",
  "publicHost": "public-hostname",
  "port": 3000,
  "wsPort": 3000,
  "maxConnections": 500,
  "authKey": "your-gateway-auth-key"
}
```

Game servers must send heartbeats to maintain registration:

**POST** `http://localhost:9999/heartbeat`

```json
{
  "id": "server-unique-id",
  "activeConnections": 42,
  "cpuUsage": 45.2,
  "ramUsage": 2048,
  "authKey": "your-gateway-auth-key",
  "rtt": 10
}
```

## Monitoring Dashboard

Access the real-time dashboard at `http://localhost:9999/dashboard`

Features:
- Server health status
- CPU and RAM usage graphs
- Connection counts
- Latency monitoring
- Migration history

## Architecture

```
┌──────────┐                    ┌─────────────────┐
│          │◄───HTTP/WS────────►│                 │
│  Client  │    :80/:443         │    Gateway      │
│          │                    │                 │
└──────────┘                    └────────┬────────┘
                                         │
                          ┌──────────────┼──────────────┐
                          │              │              │
                          ▼              ▼              ▼
                   ┌──────────┐   ┌──────────┐   ┌──────────┐
                   │ Server 1 │   │ Server 2 │   │ Server N │
                   │ :3000    │   │ :3000    │   │ :3000    │
                   └──────────┘   └──────────┘   └──────────┘
```