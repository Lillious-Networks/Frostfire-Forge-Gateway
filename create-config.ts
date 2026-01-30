/**
 * Gateway Configuration Generator
 *
 * Generates a secure config.json file for the gateway with a random auth key
 * Run with: bun create-config
 */

import { existsSync } from "fs";

const configPath = "./config.json";

// Check if config already exists
if (existsSync(configPath)) {
  console.log("\n⚠️  config.json already exists!");
  console.log("Do you want to overwrite it? This will generate a new auth key.");
  console.log("Press Ctrl+C to cancel, or press Enter to continue...\n");

  // Wait for user input
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => {
      resolve();
    });
  });
}

// Generate a secure random auth key
function generateAuthKey(): string {
  const bytes = crypto.randomUUID() + "-" + crypto.randomUUID();
  return bytes;
}

const authKey = generateAuthKey();

const config = {
  gateway: {
    port: 8080,
    wsPort: 9000,
    heartbeatInterval: 5000,
    serverTimeout: 15000,
    sessionTimeout: 1800000,
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
console.log("🔑 Auth Key: " + authKey);
console.log("\n⚠️  IMPORTANT: Copy this auth key to your game server settings:");
console.log(`\n  src/config/settings.json:\n`);
console.log(`  "gateway": {`);
console.log(`    "enabled": true,`);
console.log(`    "url": "http://your-gateway-url:8080",`);
console.log(`    "heartbeatInterval": 5000,`);
console.log(`    "authKey": "${authKey}"`);
console.log(`  }`);
console.log("\n🔒 Keep this key secret!\n");
