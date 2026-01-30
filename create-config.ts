/**
 * Gateway Configuration Generator
 *
 * Generates a secure config.json file for the gateway with a random auth key
 * Run with: bun create-config
 */

import { existsSync } from "fs";

const configPath = "./config.json";

// Generate a secure random auth key
function generateAuthKey(): string {
  const bytes = crypto.randomUUID() + "-" + crypto.randomUUID();
  return bytes;
}

// Use environment variable if available, otherwise generate a new key
const authKey = process.env.GATEWAY_AUTH_KEY || generateAuthKey();

// Get ports from environment variables or use defaults
const port = parseInt(process.env.WEBSRV_PORT || "") || 8080;
const wsPort = parseInt(process.env.WS_PORT || "") || 9000;
const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || "") || 1000;
const serverTimeout = parseInt(process.env.SERVER_TIMEOUT || "") || 3000;
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT || "") || 1800000;

if (existsSync(configPath)) {
  console.log("⚠️  config.json already exists - overwriting...");
}

const config = {
  gateway: {
    port: port,
    wsPort: wsPort,
    heartbeatInterval: heartbeatInterval,
    serverTimeout: serverTimeout,
    sessionTimeout: sessionTimeout,
    authKey: authKey
  },
  loadBalancing: {
    strategy: "round-robin-sticky",
    maxConnectionsPerServer: 1000
  },
  sessions: {
    enabled: true,
    timeout: 1800000,
    cleanupInterval: 60000
  },
  logging: {
    enabled: true,
    level: "info"
  }
};

// Write config file
await Bun.write(configPath, JSON.stringify(config, null, 2));

console.log("✅ Gateway configuration created successfully!\n");
console.log("📁 File: config.json");

// Only show auth key if not running in CI environment
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (!isCI && !process.env.GATEWAY_AUTH_KEY) {
  // Only show the key if it was randomly generated (not from environment)
  console.log("🔑 Auth Key: " + authKey);
  console.log("\n⚠️  IMPORTANT: Copy this auth key to your game server settings:");
  console.log(`\n  src/config/settings.json:\n`);
  console.log(`  "gateway": {`);
  console.log(`    "enabled": true,`);
  console.log(`    "url": "http://your-gateway-url:${port}",`);
  console.log(`    "heartbeatInterval": ${heartbeatInterval},`);
  console.log(`    "authKey": "${authKey}"`);
  console.log(`  }`);
  console.log("\n🔒 Keep this key secret!\n");
} else {
  console.log("🔑 Auth Key: [Using environment variable - hidden for security]");
  console.log("✅ Config generated with environment-provided credentials\n");
}
