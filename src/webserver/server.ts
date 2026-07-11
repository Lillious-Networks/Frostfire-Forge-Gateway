const now = performance.now();
import log from "../modules/logger";
import sendEmail from "../services/email";
import player from "../systems/player";
import verify from "../services/verification";
import { hash, randomBytes } from "../modules/hash";
import query from "../controllers/sqldatabase";

const settings = {
  guest_mode: {
    enabled: process.env.GUEST_MODE_ENABLED === "true" || process.env.GUEST_MODE_ENABLED === "1"
  },
  default_map: process.env.DEFAULT_MAP || "overworld.json",
  "2fa": {
    enabled: process.env.TWO_FA_ENABLED === "true" || process.env.TWO_FA_ENABLED === "1"
  }
};
import crypto from "crypto";
import animator_html from "./public/animator.html";
import login_html from "./public/index.html";
import register_html from "./public/register.html";
import game_html from "./public/game.html";
import map_editor_html from "./public/map-editor.html";
import particleeditor_html from "./public/particleeditor.html";
import npceditor_html from "./public/npceditor.html";
import forgotpassword_html from "./public/forgot-password.html";
import changepassword_html from "./public/change-password.html";
import realmselection_html from "./public/realm-selection.html";

function getClientIP(req: Request): string | undefined {
  return req.headers.get("X-Real-Client-IP") || undefined;
}

const routes = {
  "/status": (req: Request) => new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }),
  "/": login_html,
  "/registration": register_html,
  "/game": game_html,
  "/map-editor": map_editor_html,
  "/particle-editor": particleeditor_html,
  "/npc-editor": npceditor_html,
  "/animator": animator_html,
  "/login": (req: Request, server: any) => login(req, server),
  "/verify": (req: Request) => authenticate(req),
  "/register": (req: Request, server: any) => register(req, server),
  "/guest-login": async (req: Request) => createGuestAccount(req),
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
      try {

        const gatewayPort = process.env.GATEWAY_PORT || "9999";
        const gatewayUrl = `http://localhost:${gatewayPort}`;

        const response = await fetch(`${gatewayUrl}/status`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        });

        if (!response.ok) {
          throw new Error(`Gateway returned status ${response.status}`);
        }

        const data = await response.json();

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
        const token = crypto.randomBytes(32).toString("hex");
        const timestamp = Date.now();
        const expiresAt = timestamp + (60 * 1000);

        const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
        if (!sharedSecret) {
          return new Response(JSON.stringify({
            message: "Failed to generate connection token"
          }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
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
  "/realm-selection": realmselection_html,
} as Record<string, any>;

const serverPort = parseInt(process.env.WEBSRV_INTERNAL_PORT || "") || 8080;

Bun.serve({
    hostname: "127.0.0.1",
    port: serverPort,
    development: false,
    reusePort: false,
    routes: {
      "/status": routes["/status"],
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
      "/map-editor": routes["/map-editor"],
      "/particle-editor": routes["/particle-editor"],
      "/npc-editor": routes["/npc-editor"],
      "/animator": routes["/animator"],
      "/login": routes["/login"],
      "/verify": routes["/verify"],
      "/api/gateway/servers": routes["/api/gateway/servers"],
      "/api/gateway/connection-token": routes["/api/gateway/connection-token"],
    },
  async fetch(req: Request) {
    const url = tryParseURL(req.url);
    if (!url) {
      return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
    }

    const route = routes[url.pathname as keyof typeof routes];

    if (route) {
      return route[req.method as keyof typeof route]?.(req);
    }

    return Response.redirect("/", 301);
  },
});

async function authenticate(req: Request) {
  const ip = getClientIP(req);
  const url = tryParseURL(req.url);
  if (!url) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
  }

  const username = url.searchParams.get("username")?.toLowerCase();
  const code = url.searchParams.get("code");
  const cookies = req.headers.get("cookie") || "";
  const tokenMatch = cookies.match(/token=([^;]+)/);
  const token = tokenMatch ? tokenMatch[1] : null;

  if (!code || !username || !token) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  const result = await query("SELECT * FROM accounts WHERE token = ? AND username = ? AND verification_code = ? AND ip_address = ? LIMIT 1", [token, username, code, ip]) as any;
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);
  await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);

  return Response.redirect(`${process.env.DOMAIN}/game`, 301);
}

async function createGuestAccount(req: Request) {
  try {
    if (!settings.guest_mode?.enabled) {
      return new Response(JSON.stringify({ message: "Guest mode is disabled" }), { status: 403 });
    }
    const ip = getClientIP(req);

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
    const ip = getClientIP(req);
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

    await query("UPDATE accounts SET ip_address = ? WHERE username = ?", [ip, username]);

    const useremail = await player.getEmail(username.toLowerCase()) as string;
    if (!useremail) {
      return new Response(JSON.stringify({ message: "Invalid credentials" }), { status: 400 });
    }

    if (!settings["2fa"].enabled) {

      await query("UPDATE accounts SET verified = 1 WHERE token = ?", [token]);

      await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);

      return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/; SameSite=Lax` } });
    }
    else {
      const result = await verify(token, useremail.toLowerCase(), username.toLowerCase()) as any;
      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }

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

  const body = await req.json();

  if (!body.email) {
    return new Response(JSON.stringify({ message: "Email is required" }), { status: 400 });
  }

  const email = body.email.toLowerCase();

  if (!validateEmail(email)) {
    return new Response(JSON.stringify({ message: "Invalid email" }), { status: 400 });
  }

  const result = await query("SELECT email FROM accounts WHERE email = ? LIMIT 1", [email]) as any;

  if (result.length === 0) {
    return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
  }

  const code = randomBytes(8);

  const gameName = process.env.GAME_NAME || process.env.DOMAIN || "Game";
  const subject = `${gameName} - Reset your password`;
  const url = `${process.env.DOMAIN}/change-password?email=${email}&code=${code}`;
  const message = `<p style="font-size: 20px;"><a href="${url}">Reset password</a></p><br><p style="font-size:12px;">If you did not request this, please ignore this email.</p>`;
  const emailResponse = await sendEmail(email, subject, gameName, message);
  if (emailResponse !== "Email sent successfully") {
    log.error(`Failed to send reset password email: ${emailResponse}`);

    return new Response(JSON.stringify({ message: "Failed to send reset password email" }), { status: 500 });
  }

  await query("UPDATE accounts SET reset_password_code = ? WHERE email = ?", [code, email]);

  return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
}

async function updatePassword(req: Request, server: any) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 });
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

  const account = await query("SELECT * FROM accounts WHERE email = ? LIMIT 1", [body.email.toLowerCase()]) as any;
  if (account.length === 0) {
    log.warn(`Attempt to update password for non-existent email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  const codeResult = await query("SELECT reset_password_code FROM accounts WHERE email = ? AND reset_password_code = ? LIMIT 1", [body.email.toLowerCase(), body.code]) as any;
  if (codeResult.length === 0) {
    log.warn(`Invalid reset password code for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Invalid reset password code" }), { status: 403 });
  }

  const hashedPassword = await hash(body.password);
  const updateResult = await query("UPDATE accounts SET password_hash = ?, reset_password_code = NULL, verified = 0, verification_code = NULL WHERE email = ?", [hashedPassword, body.email.toLowerCase()]);
  if (!updateResult) {
    log.error(`Failed to update password for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Failed to update password" }), { status: 500 });
  }

  log.debug(`Password updated successfully for email: ${body.email.toLowerCase()}`);

  if (account.session_id) {

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

const readyTimeMs = performance.now() - now;
log.success(`Webserver started on internal port ${serverPort} (HTTP, 127.0.0.1) - Ready in ${(readyTimeMs / 1000).toFixed(3)}s (${readyTimeMs.toFixed(0)}ms)`);