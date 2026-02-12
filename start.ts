/**
 * Gateway Startup Script
 *
 * 1. Generates config.json if it doesn't exist
 * 2. Transpiles client-side TypeScript
 * 3. Starts both the Gateway webserver and Gateway server
 *
 * Run with:
 *   Production: bun start
 *   Development: bun start-dev
 */

import { existsSync } from "fs";

// Determine environment based on command line args or default to production
const envFile = process.env.ENV_FILE || ".env.production";
const isDev = envFile.includes("development");

console.log(`🚀 Starting Frostfire Forge Gateway (${isDev ? "Development" : "Production"})...\n`);

// Check if both config files exist, if not generate them
const configJsonExists = existsSync("./config.json");
const settingsJsonExists = existsSync("./config/settings.json");

if (!configJsonExists || !settingsJsonExists) {
  if (!configJsonExists) {
    console.log("⚙️  config.json not found");
  }
  if (!settingsJsonExists) {
    console.log("⚙️  config/settings.json not found");
  }
  console.log("⚙️  Generating configuration files...");

  const configProc = Bun.spawn(["bun", `--env-file=${envFile}`, "./utility/create-config.ts"], {
    stdout: "inherit",
    stderr: "inherit"
  });

  await configProc.exited;

  if (configProc.exitCode !== 0) {
    console.error("❌ Failed to generate configuration files");
    process.exit(1);
  }
  console.log("✅ Configuration files generated!\n");
} else {
  console.log("✅ Configuration files found\n");
}

// Transpile client-side TypeScript
console.log("📦 Transpiling client-side TypeScript...");
const transpileProc = Bun.spawn(["bun", `--env-file=${envFile}`, "./utility/transpiler.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

await transpileProc.exited;

if (transpileProc.exitCode !== 0) {
  console.error("❌ Transpilation failed");
  process.exit(1);
}
console.log("✅ Transpilation complete!\n");

// Start both servers
console.log(`Starting Gateway Webserver...`);
const webserverProc = Bun.spawn(["bun", `--env-file=${envFile}`, "webserver.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log(`Starting Gateway Server...`);
const gatewayProc = Bun.spawn(["bun", `--env-file=${envFile}`, "gateway-server.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("\n✅ Both servers started!");
console.log("\nPress Ctrl+C to stop all servers\n");

// Handle shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down servers...");
  webserverProc.kill();
  gatewayProc.kill();
  process.exit(0);
});

// Wait for both to exit
await Promise.all([webserverProc.exited, gatewayProc.exited]);
