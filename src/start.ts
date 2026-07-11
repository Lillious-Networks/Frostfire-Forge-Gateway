const isDev = process.env.NODE_ENV === "development";

console.log(`Starting Frostfire Forge Gateway (${isDev ? "Development" : "Production"})...\n`);

console.log("Transpiling client-side TypeScript...");
const transpileProc = Bun.spawn(["bun", "src/utility/transpiler.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

await transpileProc.exited;

if (transpileProc.exitCode !== 0) {
  console.error("Transpilation failed");
  process.exit(1);
}
console.log("Transpilation complete!\n");

console.log("Starting Gateway Webserver...");
const webserverProc = Bun.spawn(["bun", "src/webserver/server.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("Starting Gateway Reverse Proxy...");
const proxyProc = Bun.spawn(["bun", "src/webserver/proxy.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("Starting Gateway Server...");
const gatewayProc = Bun.spawn(["bun", "src/gateway/server.ts"], {
  stdout: "inherit",
  stderr: "inherit"
});

console.log("\nBoth servers started!");
console.log("\nPress Ctrl+C to stop all servers\n");

process.on("SIGINT", () => {
  console.log("\nShutting down servers...");
  webserverProc.kill();
  proxyProc.kill();
  gatewayProc.kill();
  process.exit(0);
});

await Promise.all([webserverProc.exited, proxyProc.exited, gatewayProc.exited]);
