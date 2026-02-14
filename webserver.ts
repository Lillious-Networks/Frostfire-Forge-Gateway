const now = performance.now();
import log from "./modules/logger";
import sendEmail from "./services/email";
import player from "./systems/player";
import verify from "./services/verification";
import { hash, randomBytes } from "./modules/hash";
import query from "./controllers/sqldatabase";
import * as settings from "./config/settings.json";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import crypto from "crypto";
import animator_html from "./public/animator.html";
import connectiontest_html from "./public/connection-test.html";
import login_html from "./public/index.html";
import register_html from "./public/register.html";
import game_html from "./public/game.html";
import forgotpassword_html from "./public/forgot-password.html";
import changepassword_html from "./public/change-password.html";
import realmselection_html from "./public/realm-selection.html";

// Load whitelisted and blacklisted IPs and functions
import { w_ips, b_ips, blacklistAdd } from "./systems/security";

// Load asset loader
import { initializeAssets } from "./modules/assetloader";
import assetCache from "./services/assetCache";

// Load security rules from security.cfg
const security = fs.existsSync(path.join(import.meta.dir, "./config/security.cfg"))
  ? fs.readFileSync(path.join(import.meta.dir, "./config/security.cfg"), "utf8").split("\n").filter(line => line.trim() !== "" && !line.startsWith("#"))
  : [];

if (security.length > 0) {
  log.success(`Loaded ${security.length} security rules`);
} else {
  log.warn("No security rules found");
}

// Assets are loaded by game servers, not the gateway

const _cert = process.env.WEBSRV_CERT_PATH || path.join(import.meta.dir, "./src/certs/webserver/cert.pem");
const _key = process.env.WEBSRV_KEY_PATH || path.join(import.meta.dir, "./src/certs/webserver/key.pem");
const _ca = process.env.WEBSRV_CA_PATH || path.join(import.meta.dir, "./src/certs/webserver/cert.ca-bundle");
const _https = process.env.WEBSRV_USESSL === "true" && fs.existsSync(_cert) && fs.existsSync(_key);

const routes = {
  "/connection-test": connectiontest_html,
  "/": login_html,
  "/registration": register_html,
  "/game": game_html,
  "/animator": animator_html,
  "/login": (req: Request, server: any) => login(req, server),
  "/verify": (req: Request, server: any) => authenticate(req, server),
  "/register": (req: Request, server: any) => register(req, server),
  "/guest-login": async (req: Request, server: any) => createGuestAccount(req, server),
  "/forgot-password": forgotpassword_html,
  "/change-password": changepassword_html,
  "/reset-password": async (req: Request, server: any) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    return await resetPassword(req, server);
  },
  "/update-password": async (req: Request, server: any) => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    return await updatePassword(req, server);
  },
  "/api/gateway/servers": {
    GET: async () => {
      // Check if gateway is enabled
      const gatewayEnabled = (settings as any).gateway?.enabled;
      const gatewayUrl = process.env.GATEWAY_URL || (settings as any).gateway?.url;

      if (!gatewayEnabled || !gatewayUrl) {
        return new Response(JSON.stringify({
          message: "Gateway not configured",
          servers: []
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        // Fetch server list from gateway (use public /status endpoint)
        // If gatewayUrl is localhost/127.0.0.1, use HTTP to avoid certificate issues
        let fetchUrl = gatewayUrl;
        if (fetchUrl.includes('127.0.0.1') || fetchUrl.includes('localhost')) {
          // Use HTTP for local requests
          fetchUrl = fetchUrl.replace('https://', 'http://').replace(':9998', ':9999');
        }

        const response = await fetch(`${fetchUrl}/status`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        });

        if (!response.ok) {
          throw new Error(`Gateway returned status ${response.status}`);
        }

        const data = await response.json();

        // Return all servers (realm selection will show all, user can see which are degraded)
        return new Response(JSON.stringify({
          servers: data.servers || []
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        log.error(`Failed to fetch gateway servers: ${error.message}`);
        return new Response(JSON.stringify({
          message: "Failed to fetch servers",
          servers: []
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  },
  "/api/gateway/connection-token": {
    GET: async (req: Request) => {
      try {
        // Generate a unique connection token
        const token = crypto.randomBytes(32).toString("hex");
        const timestamp = Date.now();
        const expiresAt = timestamp + (60 * 1000); // Token expires in 60 seconds

        // Sign the token with shared secret
        const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET || "default-secret-change-me";
        const signature = crypto
          .createHmac("sha256", sharedSecret)
          .update(`${token}:${timestamp}:${expiresAt}`)
          .digest("hex");

        return new Response(JSON.stringify({
          token,
          timestamp,
          expiresAt,
          signature
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        log.error(`Failed to generate connection token: ${error.message}`);
        return new Response(JSON.stringify({
          message: "Failed to generate connection token"
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  },
  "/tileset": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const name = url.searchParams.get("name");

      if (!name) {
        return new Response(JSON.stringify({ error: "Missing tileset name" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const tilesetPath = path.join(import.meta.dir, "public", "tilesets", name);

        if (!fs.existsSync(tilesetPath)) {
          return new Response(JSON.stringify({ error: "Tileset not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }

        const tilesetData = fs.readFileSync(tilesetPath);
        const compressedData = zlib.gzipSync(tilesetData);
        const base64Data = compressedData.toString("base64");

        return new Response(JSON.stringify({
          name: name,
          data: base64Data
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        log.error(`Error serving tileset: ${error.message}`);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  },
  "/map-chunk": {
    GET: async (req: Request) => {
      const url = new URL(req.url);
      const mapName = url.searchParams.get("map");
      const chunkX = parseInt(url.searchParams.get("x") || "0");
      const chunkY = parseInt(url.searchParams.get("y") || "0");
      const chunkSize = parseInt(url.searchParams.get("size") || "25");

      if (!mapName) {
        return new Response(JSON.stringify({ error: "Missing map name" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        // Get map from cache
        const maps = await assetCache.get("maps") as any[];
        const mapFile = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
        const map = maps?.find((m: any) => m.name === mapFile);

        if (!map) {
          return new Response(JSON.stringify({ error: "Map not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Extract chunk from map data
        const mapData = map.data;
        const startX = chunkX * chunkSize;
        const startY = chunkY * chunkSize;

        const chunk = {
          chunkX,
          chunkY,
          width: chunkSize,
          height: chunkSize,
          layers: [] as any[]
        };

        // Extract chunk data from each layer
        mapData.layers.forEach((layer: any, index: number) => {
          if (layer.type === "tilelayer" && layer.data) {
            const chunkLayerData: number[] = [];

            for (let y = 0; y < chunkSize; y++) {
              for (let x = 0; x < chunkSize; x++) {
                const mapX = startX + x;
                const mapY = startY + y;
                const mapIndex = mapY * mapData.width + mapX;

                if (mapIndex < layer.data.length) {
                  chunkLayerData.push(layer.data[mapIndex]);
                } else {
                  chunkLayerData.push(0);
                }
              }
            }

            // Get zIndex from layer properties or use layer index as fallback
            let zIndex = layer.zIndex;
            if (zIndex === undefined) {
              zIndex = index;
            }

            chunk.layers.push({
              name: layer.name,
              zIndex: zIndex,
              data: chunkLayerData,
              width: chunkSize,
              height: chunkSize
            });
          }
        });

        return new Response(JSON.stringify(chunk), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        log.error(`Error serving map chunk: ${error.message}`);
        return new Response(JSON.stringify({ error: "Failed to fetch map chunk" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  },
  "/realm-selection": realmselection_html,
} as Record<string, any>;

const serverPort = _https ? (parseInt(process.env.WEBSRV_PORTSSL || "") || 443) : (parseInt(process.env.WEBSRV_PORT || "") || 80);

Bun.serve({
    hostname: "0.0.0.0",
    port: serverPort,
    reusePort: false,
    routes: {
      "/swaggerui": routes["/swaggerui"],
      "/connection-test": routes["/connection-test"],
      "/": routes["/"],
      "/registration": routes["/registration"],
      "/register": routes["/register"],
      "/guest-login": routes["/guest-login"],
      "/forgot-password": routes["/forgot-password"],
      "/change-password": routes["/change-password"],
      "/reset-password": routes["/reset-password"],
      "/update-password": routes["/update-password"],
      "/realm-selection": routes["/realm-selection"],
      "/game": routes["/game"],
      "/animator": routes["/animator"],
      "/login": routes["/login"],
      "/verify": routes["/verify"],
      "/api/gateway/servers": routes["/api/gateway/servers"],
      "/api/gateway/connection-token": routes["/api/gateway/connection-token"],
      "/tileset": routes["/tileset"],
      "/map-chunk": routes["/map-chunk"],
    },
  async fetch(req: Request, server: any) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const address = server.requestIP(req);
    if (!address) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }
    const ip = address.address;
    log.debug(`Received request: ${req.method} ${req.url} from ${ip}`);
    // Block potentially dangerous HTTP methods
    if (req.method === "CONNECT" || req.method === "TRACE" || req.method === "TRACK" || req.method === "OPTIONS") {
      return new Response("Forbidden", { status: 403 });
    }
    // Check if the ip is blacklisted
    if (b_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    // Check if the ip is whitelisted
    if (!w_ips.includes(ip)) {
      const path = url.pathname.split("/")[1];
      if (security.includes(path)) {
        // Ban the IP
        await blacklistAdd(ip);
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
      }
    }

    // Restrict direct ip access to the webserver (only in production)
    if (process.env.DOMAIN && process.env.DOMAIN !== "http://localhost" && process.env.DOMAIN?.replace(/https?:\/\//, "") !== url.host) {
      log.debug(`Domain mismatch: expected "${process.env.DOMAIN?.replace(/https?:\/\//, "")}", got "${url.host}"`);
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const route = routes[url.pathname as keyof typeof routes];

    // If route exists, handle it
    if (route) {
      return route[req.method as keyof typeof route]?.(req);
    }

    // Assets (map-chunk, tileset, music) should be requested via WebSocket from game server
    // Unknown routes redirect to homepage
    return Response.redirect("/", 301);
  },
  ...(_https ? {
      tls: {
        cert: fs.existsSync(_ca)
          ? fs.readFileSync(_cert) + "\n" + fs.readFileSync(_ca)
          : fs.readFileSync(_cert),
        key: fs.readFileSync(_key),
      }
    }
  : {}),
});
// If HTTPS is enabled, also start an HTTP server that redirects to HTTPS
if (_https) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: process.env.WEBSRV_PORT || 80,
    fetch(req: Request) {
      const url = tryParseURL(req.url);
      if (!url) {
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
      }
      // Always redirect to https with same host/path/query
      // If the port is 443, don't include it in the redirect
      const port = process.env.WEBSRV_PORTSSL === "443" ? "" : `:${process.env.WEBSRV_PORTSSL || 443}`;
      return Response.redirect(`https://${url.hostname}${port}${url.pathname}${url.search}`, 301);
    }
  });
}

async function authenticate(req: Request, server: any) {
  // Check if ip banned
  const ip = server.requestIP(req)?.address;
  if (b_ips.includes(ip) && !w_ips.includes(ip)) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }
  const url = tryParseURL(req.url);
  if (!url) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");
  const code = url.searchParams.get("code");

  if (!token || !code || !email) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  const result = await query("SELECT * FROM accounts WHERE token = ? AND email = ? AND verification_code = ? LIMIT 1", [token, email.toLowerCase(), code]) as any;
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);
  await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);

  // Send to /game
  return Response.redirect(`${process.env.DOMAIN}/game`, 301);
}

async function createGuestAccount(req: Request, server: any) {
  try {
    if (!settings.guest_mode?.enabled) {
      return new Response(JSON.stringify({ message: "Guest mode is disabled" }), { status: 403 });
    }
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }

    const guest_username = `guest_${randomBytes(12)}`;
    const domain = process.env.DOMAIN?.replace(/^https?:\/\//, "");
    const guest_email = `${guest_username}@${domain}`;
    const guest_password = `guest_${randomBytes(12)}`;
    const guest_password_hash = await hash(guest_password);

    const user = await player.register(guest_username.toLowerCase(), guest_password_hash, guest_email, req, true) as any;
    if (!user) {
      return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
    }

    if (user.error) {
      return new Response(JSON.stringify({ message: user.error }), { status: 400 });
    }

    const token = await player.login(guest_username.toLowerCase(), guest_password);
    if (!token) {
      log.debug(`Failed to login guest user after registration: ${guest_username} (${ip})`);
      return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
    }

    log.debug(`Guest account created: ${guest_username} (${ip})`);

    return new Response(JSON.stringify({ message: "Logged in successfully", token: token }), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/;` } });

  } catch (error) {
    log.error(`Failed to create guest account: ${error}`);
    return new Response(JSON.stringify({ message: "Failed to create guest account" }), { status: 500 });
  }
}

async function register(req: Request, server: any) {
  try {
    // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    const body = await req.json();
    const { username, email, password, password2 } = body;
    if (!username || !password || !email || !password2) {
      return new Response(JSON.stringify({ message: "All fields are required" }), { status: 400 });
    }

    if (password !== password2) {
      return new Response(JSON.stringify({ message: "Passwords do not match" }), { status: 400 });
    }

    if (!validateUsername(username)) {
      return new Response(JSON.stringify({ message: "Invalid username" }), { status: 400 });
    }

    if (validatePasswordComplexity(password) === false) {
      return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character." }), { status: 400 });
    }

    if (!validateEmail(email)) {
      return new Response(JSON.stringify({ message: "Invalid email format" }), { status: 400 });
    }

    const password_hash = await hash(password);

    const user = await player.register(username.toLowerCase(), password_hash, email.toLowerCase(), req, false) as any;
    if (!user) {
      return new Response(JSON.stringify({ message: "Failed to register" }), { status: 400 });
    }

    if (user.error) {
      return new Response(JSON.stringify({ message: user.error }), { status: 400 });
    }

    const token = await player.login(username.toLowerCase(), password);
    if (!token) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (settings['2fa'].enabled) {
      const result = await verify(token, email.toLowerCase(), username.toLowerCase()) as any;

      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      return new Response(JSON.stringify({ message: "Verification email sent" }), { status: 200 });
    } else {
      return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }
  } catch (error) {
    return new Response(JSON.stringify({ message: "Failed to register", error: error instanceof Error ? error.message : "Unknown error" }), { status: 500 });
  }
}

async function login(req: Request, server: any) {
  try {
    // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
    const body = await req.json();
    const { username, password } = body;
    if (!username || !password) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (!validateUsername(username)) {
      return new Response(JSON.stringify({ message: "Invalid username" }), { status: 400 });
    }

    if (password.length < 8 || password.length > 20) {
      return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long" }), { status: 400 });
    }

    const token = await player.login(username.toLowerCase(), password);
    if (!token) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    const useremail = await player.getEmail(username.toLowerCase()) as string;
    if (!useremail) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (!settings["2fa"].enabled) {
      // Update the account to verified
      await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);

      // Remove any verification code that may exist
      await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);
      // 2FA is not enabled, so we can just return the token
      return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/; SameSite=Lax` } });
    } else {
      // 2FA is enabled, so we need to send a verification email
      const result = await verify(token, useremail.toLowerCase(), username.toLowerCase()) as any;
      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      // Return a 200
      return new Response(JSON.stringify({ message: "Verification email sent"}), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }
  } catch (error) {
    log.error(`Failed to authenticate: ${error}`);
    return new Response(JSON.stringify({ message: "Failed to authenticate" }), { status: 500 });
  }
}

async function resetPassword(req: Request, server: any) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  const responseMessage = `If the email you provided is registered, you will receive an email with instructions to reset your password.`;
      // Check if ip banned
    const ip = server.requestIP(req)?.address;
    if (b_ips.includes(ip) && !w_ips.includes(ip)) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
    }
  const body = await req.json();

  if (!body.email) {
    return new Response(JSON.stringify({ message: "Email is required" }), { status: 400 });
  }

  const email = body.email.toLowerCase();

  if (!validateEmail(email)) {
    return new Response(JSON.stringify({ message: "Invalid email" }), { status: 400 });
  }

  // Check if the email exists in the database
  const result = await query("SELECT email FROM accounts WHERE email = ? LIMIT 1", [email]) as any;
  // Don't tip off the user if the email does not exist
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
  }

  // Generate a random code to use for password reset verification
  const code = randomBytes(8);

  // Send the email with the reset link
  const gameName = process.env.GAME_NAME || process.env.DOMAIN || "Game";
  const subject = `${gameName} - Reset your password`;
  const url = `${process.env.DOMAIN}/change-password?email=${email}&code=${code}`;
  const message = `<p style="font-size: 20px;"><a href="${url}">Reset password</a></p><br><p style="font-size:12px;">If you did not request this, please ignore this email.</p>`;
  const emailResponse = await sendEmail(email, subject, gameName, message);
  if (emailResponse !== "Email sent successfully") {
    log.error(`Failed to send reset password email: ${emailResponse}`);
    // We can return a 500 error here because the email doesn't exist in general or the email service failed
    return new Response(JSON.stringify({ message: "Failed to send reset password email" }), { status: 500 });
  }

  await query("UPDATE accounts SET reset_password_code = ? WHERE email = ?", [code, email]);

  return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
}

async function updatePassword(req: Request, server: any) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }
  // Check if ip banned
  const ip = server.requestIP(req)?.address;
  if (b_ips.includes(ip) && !w_ips.includes(ip)) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }
  const body = await req.json();

  if (!body.email || !body.password || !body.password2 || !body.code) {
    return new Response(JSON.stringify({ message: "All fields are required" }), { status: 400 });
  }

  if (!validateEmail(body.email)) {
    return new Response(JSON.stringify({ message: "Invalid email" }), { status: 400 });
  }

  if (body.password !== body.password2) {
    return new Response(JSON.stringify({ message: "Passwords do not match" }), { status: 400 });
  }

  if (!validatePasswordComplexity(body.password)) {
    return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character." }), { status: 400 });
  }

  // Check if the account exists
  const account = await query("SELECT * FROM accounts WHERE email = ? LIMIT 1", [body.email.toLowerCase()]) as any;
  if (account.length === 0) {
    log.warn(`Attempt to update password for non-existent email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  // Check if the reset password code matches
  const codeResult = await query("SELECT reset_password_code FROM accounts WHERE email = ? AND reset_password_code = ? LIMIT 1", [body.email.toLowerCase(), body.code]) as any;
  if (codeResult.length === 0) {
    log.warn(`Invalid reset password code for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Invalid reset password code" }), { status: 403 });
  }

  // Update the password
  const hashedPassword = await hash(body.password);
  const updateResult = await query("UPDATE accounts SET password_hash = ?, reset_password_code = NULL, verified = 0, verification_code = NULL WHERE email = ?", [hashedPassword, body.email.toLowerCase()]);
  if (!updateResult) {
    log.error(`Failed to update password for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  log.debug(`Password updated successfully for email: ${body.email.toLowerCase()}`);

  if (account.session_id) {
    // If the user is logged in, we need to logout the user
    player.logout(account.session_id);
  }

  return new Response(JSON.stringify({ message: "Password updated successfully" }), { status: 200 });
}

function validatePasswordComplexity(password: string): boolean {
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialCharacter = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const isValidLength = password.length >= 8 && password.length <= 20;
  return hasUpperCase && hasLowerCase && hasNumbers && hasSpecialCharacter && isValidLength;
}

function validateUsername(username: string): boolean {
  const regex = /^[a-zA-Z0-9_]{3,15}$/; // Alphanumeric and underscores, 3-15 characters
  return regex.test(username);
}

function validateEmail(email: string): boolean {
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,100}$/;
  return regex.test(email);
}

function tryParseURL(url: string) : URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Initialize assets (tilesets and maps)
await initializeAssets();

const readyTimeMs = performance.now() - now;
log.success(`Webserver started on port ${serverPort} (${_https ? "HTTPS" : "HTTP"}) - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);