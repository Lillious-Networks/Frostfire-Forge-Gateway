/**
 * Gateway Configuration Generator
 *
 * Generates secure configuration files for the Gateway:
 * - config.json: Gateway server configuration (port 9999)
 * - config/settings.json: Application settings for logger and services
 *
 * Run with: bun run create-config
 */

import { existsSync, mkdirSync } from "fs";

const configPath = "./config.json";
const settingsPath = "./config/settings.json";

// Generate a secure random auth key (UUID format)
function generateAuthKey(): string {
  const bytes = crypto.randomUUID() + "-" + crypto.randomUUID();
  return bytes;
}

// Use environment variable if available, otherwise generate a new key
const authKey = process.env.GATEWAY_AUTH_KEY || generateAuthKey();

// Gateway server configuration (port 9999 - game server registration)
const gatewayPort = parseInt(process.env.GATEWAY_PORT || "") || 9999;
const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || "") || 30000; // 30 seconds
const serverTimeout = parseInt(process.env.SERVER_TIMEOUT || "") || 90000; // 90 seconds
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT || "") || 300000; // 5 minutes

// Create config directory if it doesn't exist
if (!existsSync("./config")) {
  mkdirSync("./config", { recursive: true });
  console.log("✅ Created config directory");
}

if (existsSync(configPath)) {
  console.log("⚠️  config.json already exists - overwriting...");
}

if (existsSync(settingsPath)) {
  console.log("⚠️  config/settings.json already exists - overwriting...");
}

// Gateway server configuration (config.json)
const config = {
  gateway: {
    port: gatewayPort,
    heartbeatInterval: heartbeatInterval,
    serverTimeout: serverTimeout,
    sessionTimeout: sessionTimeout,
    authKey: authKey,
    enabled: true,
    url: `http://127.0.0.1:${gatewayPort}` // URL where Gateway server is accessible
  },
  loadBalancing: {
    strategy: "least-connections", // Changed from round-robin-sticky to least-connections
    maxConnectionsPerServer: 1000
  },
  sessions: {
    enabled: true,
    timeout: sessionTimeout,
    cleanupInterval: 60000 // Clean up expired sessions every minute
  },
  logging: {
    enabled: true,
    level: "debug" // Changed to debug for better troubleshooting
  }
};

// Application settings (config/settings.json)
// Used by logger, webserver, and other services
const settings = {
  logging: {
    level: process.env.LOG_LEVEL || "debug"
  },
  gateway: {
    enabled: process.env.GATEWAY_ENABLED === "true" || true,
    url: process.env.GATEWAY_URL || `http://localhost:${gatewayPort}`
  },
  "2fa": {
    enabled: false
  },
  guest_mode: {
    enabled: true
  },
  default_map: "overworld.json",
};

// Write config files
await Bun.write(configPath, JSON.stringify(config, null, 2));
await Bun.write(settingsPath, JSON.stringify(settings, null, 2));

console.log("✅ Gateway configuration created successfully!\n");
console.log("📁 Files created:");
console.log("   - config.json (Gateway server config)");
console.log("   - config/settings.json (Application settings)\n");
console.log("🔧 Gateway Server Configuration:");
console.log(`   Port: ${gatewayPort}`);
console.log(`   Heartbeat Interval: ${heartbeatInterval}ms`);
console.log(`   Server Timeout: ${serverTimeout}ms`);
console.log(`   Session Timeout: ${sessionTimeout}ms`);
console.log(`   Logging Level: ${settings.logging.level}\n`);

// Only show auth key if not running in CI environment
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (!isCI && !process.env.GATEWAY_AUTH_KEY) {
  // Only show the key if it was randomly generated (not from environment)
  console.log("🔑 Generated Auth Key: " + authKey);
  console.log("\n⚠️  IMPORTANT: Add this auth key to your game server .env file:");
  console.log(`\n  .env.production:\n`);
  console.log(`  GATEWAY_AUTH_KEY="${authKey}"`);
  console.log(`  GATEWAY_URL="http://your-gateway-ip:${gatewayPort}"`);
  console.log(`  GATEWAY_ENABLED=true`);
  console.log("\n🔒 Keep this key secret - it authenticates game servers with the Gateway!\n");
} else if (process.env.GATEWAY_AUTH_KEY) {
  console.log("🔑 Auth Key: [Using environment variable]");
  console.log("✅ Config generated with environment-provided credentials\n");
} else {
  console.log("🔑 Auth Key: [Hidden in CI environment]\n");
}
