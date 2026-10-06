---
title: Monitoring Dashboard
description: Where the gateway dashboard is, how to log in, and what each part of it shows.
order: 60
---

The gateway server includes a live dashboard for the game servers registered with it. This page covers how to reach it, how its login works, what every panel means, and how to record and replay a session.

## Where it is

The dashboard is served by the gateway server, not by the website.

:::tabs
```text title="Development"
http://localhost:9999/
```
```text title="Production"
https://play.example.com:9443/
```
:::

The port is `GATEWAY_PORT` (9999) without TLS and `GATEWAY_PORTSSL` (9443) with TLS. See [Configuration](#/gateway/configuration/gateway-server).

:::tip Shortcut from the website
Opening `/gateway` on the website (for example `https://play.example.com/gateway`) redirects to the dashboard on the right port for the current setup.
:::

## Logging in

The dashboard has no password of its own. It opens for an account that is logged in on the website and meets both of these:

- it is an admin (`accounts.role` is `1`, the flag the `/admin` command toggles), and
- it holds the `server.gateway` permission or the `server.*` wildcard.

Guest accounts, banned accounts and accounts that still owe a two-factor step are refused. See [Permissions](#/engine/permissions) for how to grant a permission.

1. Open the root of the gateway port, or `/gateway` on the website.
2. If you are already logged in on the website with a qualifying account, the dashboard opens straight away.
3. If you are not logged in, press "Log In". You are sent to the normal website login (password, email verification and two-factor all apply) and brought back afterwards.
4. If you are logged in with an account that does not qualify, the page says so and offers "Use a different account".

Opening `/dashboard` without a valid session redirects back to the login page.

| Detail | Value |
| --- | --- |
| Who is asking | `GET /api/session` answers `signed-out`, `forbidden` or `allowed`, read from the website's `token` cookie |
| Login route | `POST /api/login` with no body. It opens a session for the qualifying account behind the `token` cookie |
| Session cookie | `dashboard_session`, `HttpOnly`, `SameSite=Strict`, one hour |
| Session lifetime | One hour of inactivity. Every data refresh extends it. |
| Re-check | About once a minute the session confirms the account is still logged in on the website, still an admin and still holds the permission. If not, the session ends. |
| Logout | The "Logout" button calls `POST /api/logout` and clears the cookie. It ends the dashboard session only; the website login stays. |

:::note The gateway key no longer opens the dashboard
`GATEWAY_AUTH_KEY` is only for game servers that register with the gateway. Knowing it does not give access to the dashboard.
:::

:::note Sessions live in memory
Dashboard sessions are kept in the gateway server process. Restarting the gateway logs every admin out.
:::

## What it shows

The page asks `GET /api/stats` once per second and redraws everything from the answer.

### Overview bar

| Item | Meaning |
| --- | --- |
| Servers | Number of registered game servers |
| Connections | Sum of the player counts of all servers |
| Healthy | Servers with CPU and connection load both at or under 60% |
| Degraded | Servers with CPU or connection load above 60% |
| Alert | Servers with CPU or connection load above 80% |

Connection load is the player count as a percentage of the server's `maxConnections`.

### Graphs

Three line graphs, one line per server, each showing the last 60 samples (about one minute).

| Graph | Unit | Source |
| --- | --- | --- |
| CPU Usage | Percent, fixed scale of 0 to 100 | `cpuUsage` from the heartbeat |
| RAM Usage | Megabytes, scale grows with the data | `ramUsage` from the heartbeat (heap and external memory of the game server process) |
| Latency | Milliseconds, scale grows with the data | Half the round trip time of the game server's heartbeat request |

The number beside each title is the latest value. The server filter in the header ("All Servers" or one server id) limits the graphs to a single server.

:::note Graphs move at heartbeat speed
The page polls every second, but the numbers only change when a game server sends a heartbeat. With the engine's default interval of 5 seconds the lines advance in steps.
:::

### Connected servers

One card per game server:

| Part | Meaning |
| --- | --- |
| Name | The server id (the realm name) |
| Host | The server's `publicHost` |
| Badge | `HEALTHY`, `DEGRADED` or `ALERT`, by the thresholds above |
| CPU Usage | Percent, with a bar that turns to warning above 60% and danger above 80% |
| Memory | Megabytes, with a bar scaled to 8192 MB |
| Connections | `active/max`, with the same warning and danger colours |
| Latency | Milliseconds |

With no game server registered the section reads "No servers registered yet".

## Recording and replay

The header has "Record" and "Import" buttons for capturing a load test and looking at it later.

- "Record" starts storing one snapshot per refresh: for every server its CPU, memory, latency, connection count and status. A timer shows how long the recording has run.
- "Stop" ends the recording and downloads it as `gateway-stats-<timestamp>.json`.
- "Import" opens such a file in a replay overlay with the same three graphs, a timeline you can drag, skip buttons for 10 frames back and forward, pause, and playback speeds of 1x, 2x, 4x and 10x.

Recordings stay in the browser. Nothing is stored on the gateway.

:::tip Record a benchmark run
Start a recording, run a load test from the engine (see [Benchmarking](#/engine/benchmarking)), then stop. The JSON file is a compact record of how each realm behaved under that load.
:::

## The stats API

`GET /api/stats` needs the `dashboard_session` cookie and answers `401` without it.

```json title="GET /api/stats"
{
  "timestamp": 1760000000000,
  "totalServers": 1,
  "healthyServers": 1,
  "totalActiveSessions": 0,
  "totalMigrations": 0,
  "recentMigrations": [],
  "servers": [
    {
      "id": "realm-one",
      "description": "The first realm",
      "host": "localhost",
      "publicHost": "localhost",
      "port": 3000,
      "activeConnections": 42,
      "maxConnections": 2000,
      "lastHeartbeat": 1759999998000,
      "cpuUsage": 12,
      "ramUsage": 310.5,
      "latency": 2,
      "status": "healthy"
    }
  ]
}
```

`status` in this response is `healthy` while heartbeats arrive within `SERVER_TIMEOUT` and `unhealthy` otherwise. The Healthy, Degraded and Alert badges on the page are computed in the browser from CPU and connection load and are independent of it.

`totalActiveSessions`, `totalMigrations` and `recentMigrations` describe the gateway's HTTP proxy sessions. See [Failover](#/gateway/game-servers/failover). The page itself does not display them.

For a public health check that needs no login, use `GET /status` on the same port. See [Game Servers](#/gateway/game-servers/gateway-server-http-api).
