<p align="center">
  <img src="../../blob/main/logo.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge Gateway 🔥🧊</h1>

<p align="center">
  <strong>Centralized Authentication & Reverse Proxy for Frostfire Forge MMO Platform</strong>
</p>

<p align="center">
A production-grade authentication and reverse proxy gateway for Frostfire Forge game servers. Provides centralized user authentication, game server registration, automatic failover, real-time health monitoring, and realm-based server routing.
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge-Gateway/release.yml?branch=main&label=Docker&style=flat-square" alt="Docker">
  <img src="https://img.shields.io/badge/status-Alpha-yellow?style=flat-square&label=Status" alt="Work in Progress">
  <img src="https://img.shields.io/github/license/Lillious-Networks/Frostfire-Forge-Gateway?style=flat-square&label=License" alt="License">
  <img src="https://img.shields.io/github/stars/Lillious-Networks/Frostfire-Forge-Gateway?style=flat-square&label=Stars" alt="GitHub Stars">
</p>

---

> [!NOTE]
> **Project Status**: This project is currently a **work in progress**
>
> **Core Development Team**: [Lillious](https://github.com/Lillious), [Deph0](https://github.com/Deph0)
>
> **Community**: [Join our Discord](https://discord.gg/4spUbuXBvZ)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Requirements](#-requirements)
- [Architecture](#-architecture)
  - [Dual-Server Design](#dual-server-design)
  - [Server Responsibilities](#server-responsibilities)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
  - [Docker Deployment](#docker-deployment)
- [Environment Variables](#-environment-variables)
- [Setup Instructions](#-setup-instructions)
- [Monitoring Dashboard](#-monitoring-dashboard)
- [Security](#-security)

---

## 📖 Overview

The Frostfire Forge Gateway is a critical infrastructure component of the Frostfire Forge MMO platform. It acts as the central hub for:

- **User Authentication** - Login, registration, email verification, and password reset
- **Game Server Management** - Registration, health monitoring, and automatic failover
- **Client Routing** - Realm based server selection and connection token generation
- **Asset Serving** - Fast delivery of compressed game data and static assets
- **Monitoring & Administration** - Real-time dashboard and health status APIs

The gateway works in conjunction with the [Frostfire Forge Game Engine](https://github.com/Lillious-Networks/Frostfire-Forge) and [Frostfire Forge Assets](https://github.com/Lillious-Networks/Frostfire-Forge-Assets) to provide a complete MMO platform.

---

## ✨ Features

- **Game Server Authentication & Registration:** Automatic server discovery and registration with heartbeat monitoring
- **User Authentication:** Login, registration, email verification, password reset
- **Automatic Server Failover:** Detects dead servers and migrates active client sessions automatically
- **Real-Time Monitoring Dashboard:** Server health, CPU/RAM usage, connection counts, latency metrics
- **HTTP Proxying:** Intelligent routing to game servers
- **SSL/TLS Support:** Full HTTPS support for both webserver and gateway
- **Realm Routing:** Client requests routed to appropriate game server realms
- **Asset Delivery:** Gzip-compressed asset data serving
- **Docker Ready:** Development and production-ready containerization

---

## 🔧 Requirements

> [!IMPORTANT]
> **Required Software**:
> - [Bun](https://bun.sh/) - JavaScript runtime & package manager
> - [MySQL](https://www.mysql.com/downloads/) - Database for users and game state
> - [Frostfire Forge Game Engine](https://github.com/Lillious-Networks/Frostfire-Forge) - Game servers that register with gateway
> - [Frostfire Forge Assets](https://github.com/Lillious-Networks/Frostfire-Forge-Assets) - Asset server for game data
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment
> - SMTP Server (Optional) - For email verification (recommended for production)

---

## 🏗️ Architecture

### Dual-Server Design

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

---

## ⚙️ Environment Variables

```bash
# Database Configuration
DATABASE_ENGINE=mysql
DATABASE_HOST=localhost
DATABASE_NAME=frostfire_forge
DATABASE_USER=root
DATABASE_PASSWORD=your_password
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

# CORS Configuration (Security)
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost,http://127.0.0.1,http://127.0.0.1:8000

# Asset Server Configuration
ASSET_SERVER_URL="http://127.0.0.1:8000"
ASSET_SERVER_AUTH_KEY=your-asset-server-key

# Email (Optional but recommended)
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

---

## 🚀 Quick Start

### Development Setup

**Option 1: Use prebuilt Docker image:**
```bash
docker run -d --name frostfire-gateway-dev -p 80:80 -p 9999:9999 ghcr.io/lillious-networks/frostfire-forge-gateway-dev:latest
```

**Option 2: Build and run from source:**
```bash
bun development
```

**Optional: Update `.env.development` before running**

Access the game client at `http://localhost` and the monitoring dashboard at `http://localhost:9999/dashboard`

---

### Production Setup

**Update the `.env.production` file**

Configure your production environment variables including SSL certificates if needed.

**Start the production server:**
```bash
bun production
```

---

## 🐳 Docker Deployment

### Using Docker Compose

```bash
# Start development environment
docker compose -f src/docker/docker-compose.dev.yml up -d

# View logs
docker compose -f src/docker/docker-compose.dev.yml logs -f

# Stop
docker compose -f src/docker/docker-compose.dev.yml down
```

### NPM Commands

```bash
# Development
npm run docker:dev              # Start dev container
npm run docker:dev:logs         # View logs
npm run docker:dev:rebuild      # Rebuild and restart
npm run docker:dev:down         # Stop dev container

# Production
npm run docker:prod             # Start prod container
npm run docker:prod:logs        # View logs
npm run docker:prod:rebuild     # Rebuild and restart
npm run docker:prod:down        # Stop prod container
```

---

## 📋 Setup Instructions

### Database Setup

Create a MySQL database and user for the gateway:

```sql
CREATE DATABASE frostfire_forge;
CREATE USER 'gateway_user'@'localhost' IDENTIFIED BY 'secure_password';
GRANT ALL PRIVILEGES ON frostfire_forge.* TO 'gateway_user'@'localhost';
FLUSH PRIVILEGES;
```

The gateway will create tables automatically on first run.

### SSL/TLS Setup

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

Then update the following environment variables:
```bash
WEBSRV_USESSL=true
GATEWAY_USESSL=true
```

---

## 📊 Monitoring Dashboard

Access the real-time dashboard at `http://localhost:9999/dashboard`

**Default credentials:** Value of `GATEWAY_AUTH_KEY`

**Dashboard Features:**
- Real-time server status
- CPU and RAM usage graphs
- Connection count per server
- Latency/RTT monitoring

---

## 🔐 Security

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

---

<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
