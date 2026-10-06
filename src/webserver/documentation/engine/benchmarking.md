---
title: Benchmarking
description: The load test tools that ship with the engine: the concurrent client benchmark, the daily activity simulation and the connection hold test, with every flag and how to read the results.
order: 190
---

The engine ships with tools that connect real WebTransport clients to a running server and measure how it holds up. This page lists the three ways to run them, every flag, and what the numbers in the output mean.

## The tools at a glance

| Command | What it does | File |
|---------|--------------|------|
| `bun benchmark <clients>` | Logs in guest players that walk around and send packets for a fixed time | `src/utility/benchmark-cli.ts` |
| `bun benchmark <peak> --simulation` | The same clients, following a daily curve of logins and logouts | `src/utility/benchmark-cli.ts` |
| `bun benchmark:connections` | Opens raw connections and holds them, with no login | `src/utility/benchmark-connections.ts` |

A fourth script, `bun creature-loadtest`, measures the creature system and is described [at the end](#/engine/benchmarking/creature-load-test).

## Before you start

The benchmark clients take the same route as real players, so the full stack must be running: the gateway, the asset server and the game server.

| Requirement | Why |
|-------------|-----|
| `GATEWAY_GAME_SERVER_SECRET` in the environment file | The tools sign their own connection tokens with it, and send it to the gateway to create guest accounts in bulk |
| A reachable gateway | Guest accounts are created through the gateway's `/guest-bulk` route |
| A TLS certificate on the game server | WebTransport always uses TLS. The tools pin the certificate file at `TLS_CERT_PATH` by its hash, so a local self-signed certificate works when the tool runs with the same environment file as the server. Without that file the certificate must be trusted by the system. |
| `http://localhost` in `CORS_ALLOWED_ORIGINS` | The tools connect with the origin `http://localhost`. When the game server's origin list is not empty, it must contain that origin. |

Each script loads an environment file:

| Script | Environment file |
|--------|------------------|
| `bun benchmark`, `bun benchmark:development` | `.env.development` |
| `bun benchmark:production` | `.env.production` |
| `bun benchmark:connections` | none |
| `bun benchmark:connections:development` | `.env.development` |
| `bun benchmark:connections:production` | `.env.production` |

:::warning Benchmarks create real load and real guest accounts
Run them against a development or staging server. Guest accounts and their data are deleted the next time the game server starts.
:::

For large runs, these server side settings matter:

| Setting | Where | Effect |
|---------|-------|--------|
| `webtransport.maxSessions` | `src/config/settings.json` | The session limit. Must be above your client count. |
| `packetRatelimit` | `src/config/settings.json` | The per connection packet limit still applies to benchmark clients |
| `BENCHMARK_PROFILE=1` | Game server environment | Prints server side profiling lines every 5 seconds |

## Concurrent client load test

```bash title="500 players, 20 logins per second, for 2 minutes"
bun benchmark 500 --rate 20 --duration 120
```

Every client:

1. Gets a guest account, connects, and logs in exactly like the game client.
2. Walks in random directions, stops, idles and walks again.
3. Now and then sends other packets: target the closest player, inspect, a chat message, mount.

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `<player count>` (first argument) | `50` | Number of concurrent clients |
| `--clients <number>` | `50` | The same as the positional count, minimum 1 |
| `--duration <seconds>` | `60` | How long the test runs once clients are in, minimum 10 |
| `--rate <per second>` | about 3 per second | How fast clients connect. Higher means a faster ramp up. |
| `--host <url>` | `http://` or `https://` plus `PUBLIC_HOST` or `SERVER_HOST`, or the gateway's host when the gateway is enabled | Web address of the gateway, used to create guest accounts (`/guest-bulk`) |
| `--wt <url>` | `https://localhost:<game port>` | WebTransport address of the game server |
| `--gateway` | off (`GATEWAY_ENABLED=true` turns it on) | Ask the gateway for the realm list and spread clients over the realms |
| `--gateway-url <url>` | `GATEWAY_URL` or `http://localhost:9999` | Gateway address. Also turns `--gateway` on. |
| `--realm <id>` | automatic | Only benchmark this realm |
| `--processes <N>` (or `--procs`) | `1` | Split the clients over N child processes, at most 32, and print one combined summary |
| `--shard <M/N>` | `1/1` | Run as part M of N. Used internally by `--processes`, or by hand to drive one server from several machines. |
| `--simulation` | off | Switch to the [daily activity simulation](#/engine/benchmarking/daily-activity-simulation) |
| `--help` | | Print the built in help |

```bash title="More examples"
# 100 players with the defaults
bun benchmark 100

# Through the gateway, clients spread over all realms
bun benchmark:development 200 --gateway

# One realm, five minutes, production environment file
bun benchmark:production 500 --realm server-1 --duration 300

# 4000 players split over 4 processes
bun benchmark 4000 --rate 50 --processes 4
```

:::tip One process has a ceiling
A single Bun process can drive a few thousand WebTransport clients before its own event loop becomes the bottleneck. If latency looks bad at high counts, try `--processes` first, to make sure you are measuring the server and not the benchmark tool.
:::

### Reading the results

```text title="Example output"
------------------------------------------------------------
  Benchmark Complete
------------------------------------------------------------

  Test Duration: 120.4s
  All 500 clients remained connected

  Latency Statistics:
    One-way Average: 14ms
    One-way Minimum: 0ms
    One-way Maximum: 96ms
    One-way p95: 31ms | p99: 52ms
    Samples:     412,880
    Jitter (mean |Δone-way|): 6ms
    Movement datagram loss: 12/412892 (0.00%)
```

| Line | Meaning |
|------|---------|
| Test Duration | Wall clock time of the whole run |
| All N clients remained connected | Every client that logged in was still connected at the end |
| Started with X/Y clients | Only X of the requested Y managed to log in. Look at the game server and gateway logs. |
| X/Y clients connected at end | Some clients were disconnected during the run |
| One-way Average, Minimum, Maximum | Time from the server sending a movement datagram to the client receiving it |
| p95, p99 | 95% and 99% of datagrams arrived at least this fast. These show stutter better than the average. |
| Samples | Number of movement datagrams measured |
| Jitter | Average change in delivery time between two consecutive datagrams for the same client. Low is smooth. |
| Movement datagram loss | Datagrams that never arrived, from gaps in their sequence numbers |

The tool colours the average yellow above 100 ms and red above 200 ms, and the maximum yellow above 200 ms and red above 500 ms.

How the latency is measured: every movement datagram carries the server's send time and a sequence number (see [Networking](#/engine/networking/batch-of-positions-header-0x01)). The client side compares that time with its own clock.

:::note The numbers are relative
The tool estimates the difference between the two clocks from the fastest datagram it has seen, and treats that one as instant. Reported times therefore show how much slower delivery gets under load, not the absolute network delay. The first 10 seconds after the test starts are left out as warm up.
:::

Rules of thumb:

| Observation | What it suggests |
|-------------|------------------|
| Average and p99 both low and stable | The server has headroom at this player count |
| Average fine, p99 high | Occasional stalls. Watch `[profile:gameloop]` for a high `max` or `overlaps`. |
| Loss above a few percent | The UDP send path or the network is saturated. The server lowers its movement flush rate under load. |
| Clients fail to log in | Check `webtransport.maxSessions`, the database pool sizes and the gateway |
| Clients drop during the run | Look for rate limit or stream queue warnings in the game server log |

## Daily activity simulation

```bash title="Peak of 2000 players"
bun benchmark 2000 --simulation
```

A fixed number of clients that all log in and stay is not how a real server is used. The simulation plays a compressed day instead: a quiet early morning, a ramp towards lunch, a peak, and an evening decline. Players log in and out the whole time, sessions end, and behaviour is mixed (standing idle, wandering, returning to hubs, the occasional chat or inspect).

| Flag | Default | Meaning |
|------|---------|---------|
| `<player count>` | `50` | The peak number of concurrent players |
| `--duration <seconds>` | `300` | Length of the simulated day |
| `--rate <per second>` | `25` | Maximum logins per second |

The other target flags (`--host`, `--wt`, `--gateway`, `--gateway-url`, `--realm`) work as in the normal benchmark.

```bash title="A longer day"
bun benchmark 2000 --simulation --duration 600
```

:::note The duration can be stretched
The login rate is fixed, so a large peak needs time to build. If the requested duration is too short to reach the peak at the given rate, the tool lengthens it and shows `(stretched to N/sec)` in the header. Raise `--rate` to keep the duration.
:::

The summary adds simulation totals to the latency statistics:

| Line | Meaning |
|------|---------|
| Peak Target | The peak you asked for |
| Max Concurrent | The highest number of clients actually connected at once. Compare it with the target. |
| Total Login Attempts | Logins started over the whole run |
| Successful Logins | Logins that completed |
| Logouts/Disconnects | Sessions that ended, on purpose or not |

A gap between Peak Target and Max Concurrent, or between attempts and successful logins, means the server (or the gateway, or the database) could not keep up with the login rate.

## Connection hold test

```bash title="Hold 1000 connections for the default 60 seconds"
bun benchmark:connections:development --connections 1000
```

This tool answers a narrower question: how many WebTransport sessions can the server accept and keep open? It connects straight to the game server and skips the gateway. Each connection completes the transport handshake with a token the tool signs itself, sends one `BENCHMARK` packet, and then just stays open. No guest accounts, no login, no movement.

| Flag | Default | Meaning |
|------|---------|---------|
| `--connections <number>` | `100` | Connections to open, minimum 1 |
| `--duration <seconds>` | `60` | How long to hold them, minimum 10 |
| `--wt <url>` | `https://<PUBLIC_HOST or SERVER_HOST>:<game port>` | WebTransport address |
| `--server-secret <key>` | `GATEWAY_GAME_SERVER_SECRET` | Shared secret used to sign the tokens |
| `--help` | | Print the built in help |

:::warning Use the flag, not a bare number
This tool has no positional argument. `bun benchmark:connections 1000` ignores the `1000` and opens the default 100 connections. Write `--connections 1000`.
:::

:::note
Plain `bun benchmark:connections` loads no environment file and exits when `GATEWAY_GAME_SERVER_SECRET` is not set. Use `benchmark:connections:development` or `benchmark:connections:production`.
:::

```bash title="More examples"
# 10,000 connections for 5 minutes
bun benchmark:connections:production --connections 10000 --duration 300

# Against another address
bun benchmark:connections:development --connections 2000 --wt https://127.0.0.1:3000
```

Connections are opened in batches of 10 with a 100 ms pause between batches, about 100 per second. The tool waits up to 60 seconds for all of them to open or fail.

### Reading the results

```text title="Example output"
----------------------------------------------------------------------
  Connection Test Complete
----------------------------------------------------------------------

  Total Duration: 60s

  Connection Statistics:
    Total Attempted: 1000
    Opened:         1000
    Failed:         0
    Active at End:  1000 (All connections held)
```

| Line | Meaning |
|------|---------|
| Total Attempted | The number you asked for |
| Opened | Sessions that completed the handshake and were accepted |
| Failed | Sessions that could not be opened |
| Active at End | Sessions still open after the hold time. A lower number shows how many the server dropped. |

While it runs, a progress bar shows connections opening and then the hold time, with the live count of active connections.

If connections fail, check these first:

| Check | Why |
|-------|-----|
| `webtransport.maxSessions` | Sessions beyond the limit are refused |
| `CORS_ALLOWED_ORIGINS` on the game server | When it is set, it must contain `http://localhost`, the origin the tools send |
| Open file and socket limits of the operating system | Each session uses resources on both ends |
| `GATEWAY_GAME_SERVER_SECRET` | It must be the same value the game server uses |

## Watching the server during a run

Start the game server with profiling on, then run a benchmark from another terminal:

```env title=".env.development"
BENCHMARK_PROFILE=1
```

```text title="Server log"
[profile:gameloop] 150 ticks/5s, 0 overlaps, 310ms total, 9ms max, 480 movers, rss=910MB
[profile:inbound] MOVEXY=9120/184ms TARGETCLOSEST=310/41ms CHAT=96/12ms
```

| Line | Shows |
|------|-------|
| `[profile:gameloop]` | Ticks in the last 5 seconds, overlapping ticks, time spent, slowest tick, players moving, memory. See [Game loop](#/engine/game-loop/profiling-the-loop). |
| `[profile:inbound]` | Per packet type: how many arrived and the total time spent handling them, sorted by time |

## Creature load test

`bun creature-loadtest` does not connect any clients. It fills a map with creature spawns and then samples the game server's `/creature-stats` route, so you can check that the 100 ms creature tick keeps up. Run a player benchmark alongside it for combined load.

```bash title="Creature load test"
bun creature-loadtest seed --count 2000 --map main
bun creature-loadtest watch --seconds 120
bun creature-loadtest clean
```

| Command | What it does |
|---------|--------------|
| `seed` | Inserts spawns. They are marked with a fixed name prefix so `clean` removes exactly these. |
| `watch` (default) | Samples the server's tick timings for a while |
| `clean` | Removes the seeded spawns |

| Flag | Default | Meaning |
|------|---------|---------|
| `--count <n>` | `2000` | Spawns to seed |
| `--map <name>` | | Map to seed |
| `--movement <idle, wander or patrol>` | `wander` | Movement type of the seeded spawns |
| `--wander <n>` | `8` | Wander setting of the seeded spawns |
| `--seconds <n>` | `60` | How long `watch` samples |
| `--interval <n>` | `5` | Seconds between samples |
| `--url <url>` | `https://127.0.0.1:<WEBSRV_INTERNAL_PORT>/creature-stats` | Stats address |

`bun creature-loadtest` uses `.env.development`, and `bun creature-loadtest:production` uses `.env.production`.
