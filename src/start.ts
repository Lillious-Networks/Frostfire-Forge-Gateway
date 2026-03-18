/**
 * Gateway Startup Script
 *
 * 1. Transpiles client-side TypeScript
 * 2. Starts both the Gateway webserver and Gateway server
 *
 * Run with:
 *   Production: bun run production
 *   Development: bun run development
 */

// Determine environment based on ENV_FILE or default to production
const envFile = process.env.ENV_FILE || ".env.production";
const isDev = envFile.includes("development");

console.log(`Starting Frostfire Forge Gateway (${isDev ? "Development" : "Production"})...\n`);

// Transpile client-side TypeScript
console.log("Transpiling client-side TypeScript...");
const transpileProc = Bun.spawn(["bun", `--env-file=${envFile}`, "src/utility/transpiler.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

await transpileProc.exited;

if (transpileProc.exitCode !== 0) {
  console.error("Transpilation failed");
  process.exit(1);
}
console.log("Transpilation complete!\n");

// Start both servers
console.log("Starting Gateway Webserver...");
const webserverProc = Bun.spawn(["bun", `--env-file=${envFile}`, "src/webserver/server.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("Starting Gateway Server...");
const gatewayProc = Bun.spawn(["bun", `--env-file=${envFile}`, "src/gateway/server.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("\nBoth servers started!");
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
