const now = performance.now();
import log from "../modules/logger";
import sendEmail, { buildEmailBody, buildLinkAction, buildCodeAction } from "../services/email";
import player from "../systems/player";
import verify, { shuffle } from "../services/verification";
import { hash, randomBytes } from "../modules/hash";
import query from "../controllers/sqldatabase";
import { generateSecret, generateTotpUri, verifyTOTP } from "../services/totp";
import { generateChallenge, encodeBase64Url, generateRegistrationOptions, verifyAttestation, generateAssertionOptions, verifyAssertion } from "../services/webauthn";
import { generateQRDataUri } from "../services/qrcode";

const settings = {
  guest_mode: {
    enabled: process.env.GUEST_MODE_ENABLED === "true" || process.env.GUEST_MODE_ENABLED === "1"
  },
  default_map: process.env.DEFAULT_MAP || "overworld.json",
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
import realmselection_html from "./public/realm-selection.html";
import manageprofile_html from "./public/manage-profile.html";
import twofachallenge_html from "./public/2fa-challenge.html";

function getClientIP(req: Request): string | undefined {
  return req.headers.get("X-Real-Client-IP") || undefined;
}

function getRequestOrigin(req: Request): { rpId: string; origin: string } {
  const host = req.headers.get("host") || new URL(process.env.DOMAIN || "http://localhost").hostname;
  const proto = req.headers.get("X-Forwarded-Proto") || (process.env.WEBSRV_USESSL === "true" ? "https" : "http");
  return { rpId: host, origin: `${proto}://${host}` };
}

function getTokenFromRequest(req: Request): string | null {
  const cookies = req.headers.get("cookie") || "";
  const tokenMatch = cookies.match(/token=([^;]+)/);
  if (tokenMatch) return tokenMatch[1];
  const authHeader = req.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1];
  return null;
}

async function getUsernameFromToken(req: Request): Promise<string | null> {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const result = await player.getUsernameByToken(token) as any[];
  if (!result || result.length === 0) return null;
  return result[0].username;
}

async function requireAuth(req: Request): Promise<{ username: string } | Response> {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }
  const isPending = await player.isTwoFactorPending(username);
  if (isPending) {
    const codeCheck = await query("SELECT verification_code FROM accounts WHERE username = ?", [username]) as any[];
    if (codeCheck.length > 0 && codeCheck[0].verification_code) {
      return new Response(JSON.stringify({ redirect: "/", message: "Complete email verification first" }), { status: 403 });
    }
    return new Response(JSON.stringify({ redirect: "/2fa-challenge", message: "2FA required" }), { status: 403 });
  }
  return { username };
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
        const username = await getUsernameFromToken(req);
        if (username) {
          const isPending = await player.isTwoFactorPending(username);
          if (isPending) {
            return new Response(JSON.stringify({
              message: "2FA required"
            }), {
              status: 403,
              headers: { "Content-Type": "application/json" }
            });
          }
        }

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
  "/manage-profile": manageprofile_html,
  "/2fa-challenge": twofachallenge_html,
  "/api/profile": {
    GET: async (req: Request) => handleGetProfile(req),
  },
  "/api/profile/change-email": {
    POST: async (req: Request) => handleChangeEmail(req),
  },
  "/api/profile/change-password": {
    POST: async (req: Request) => handleChangePassword(req),
  },
  "/api/profile/setup-totp": {
    POST: async (req: Request) => handleSetupTOTP(req),
  },
  "/api/profile/verify-totp": {
    POST: async (req: Request) => handleVerifyTOTP(req),
  },
  "/api/profile/disable-totp": {
    POST: async (req: Request) => handleDisableTOTP(req),
  },
  "/api/profile/register-webauthn": {
    POST: async (req: Request) => handleRegisterWebAuthn(req),
  },
  "/api/profile/verify-webauthn-registration": {
    POST: async (req: Request) => handleVerifyWebAuthnRegistration(req),
  },
  "/api/profile/remove-webauthn": {
    POST: async (req: Request) => handleRemoveWebAuthn(req),
  },
  "/api/profile/reveal-email": {
    POST: async (req: Request) => handleRevealEmail(req),
  },
  "/api/profile/generate-password": {
    GET: async () => handleGeneratePassword(),
  },
  "/api/profile/2fa-requirements": {
    POST: async (req: Request) => handleSet2FARequirement(req),
  },
  "/api/profile/auth-webauthn": {
    POST: async (req: Request) => handleProfileWebAuthnAuth(req),
  },
  "/api/2fa/status": {
    GET: async (req: Request) => handle2FAStatus(req),
  },
  "/api/2fa/verify-totp": {
    POST: async (req: Request) => handleVerifyTOTPLogin(req),
  },
  "/api/2fa/auth-webauthn": {
    POST: async (req: Request) => handleAuthWebAuthn(req),
  },
  "/api/2fa/verify-webauthn": {
    POST: async (req: Request) => handleVerifyWebAuthnLogin(req),
  },
  "/api/2fa/send-email": {
    POST: async (req: Request) => handleSend2FAEmail(req),
  },
  "/api/2fa/verify-email": {
    POST: async (req: Request) => handleVerify2FAEmail(req),
  },
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
      "/manage-profile": routes["/manage-profile"],
      "/2fa-challenge": routes["/2fa-challenge"],
      "/api/profile": routes["/api/profile"],
      "/api/profile/change-email": routes["/api/profile/change-email"],
      "/api/profile/change-password": routes["/api/profile/change-password"],
      "/api/profile/setup-totp": routes["/api/profile/setup-totp"],
      "/api/profile/verify-totp": routes["/api/profile/verify-totp"],
      "/api/profile/disable-totp": routes["/api/profile/disable-totp"],
      "/api/profile/register-webauthn": routes["/api/profile/register-webauthn"],
      "/api/profile/verify-webauthn-registration": routes["/api/profile/verify-webauthn-registration"],
      "/api/profile/remove-webauthn": routes["/api/profile/remove-webauthn"],
      "/api/profile/reveal-email": routes["/api/profile/reveal-email"],
      "/api/profile/generate-password": routes["/api/profile/generate-password"],
      "/api/profile/2fa-requirements": routes["/api/profile/2fa-requirements"],
      "/api/profile/auth-webauthn": routes["/api/profile/auth-webauthn"],
      "/api/2fa/status": routes["/api/2fa/status"],
      "/api/2fa/verify-totp": routes["/api/2fa/verify-totp"],
      "/api/2fa/auth-webauthn": routes["/api/2fa/auth-webauthn"],
      "/api/2fa/verify-webauthn": routes["/api/2fa/verify-webauthn"],
      "/api/2fa/send-email": routes["/api/2fa/send-email"],
      "/api/2fa/verify-email": routes["/api/2fa/verify-email"],
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

  const result = await query("SELECT * FROM accounts WHERE token = ? AND username = ? AND verification_code = ? LIMIT 1", [token, username, code]) as any;
  if (result.length === 0) {
    return new Response(JSON.stringify({ message: "Invalid request" }), { status: 403 });
  }

  const isAccountVerification = result[0].email_verified === 0;

  await query("UPDATE accounts SET email_verified = 1 WHERE token = ?", [token]);
  await query("UPDATE accounts SET verification_code = NULL WHERE token = ?", [token]);

  if (isAccountVerification) {
    await query("UPDATE accounts SET token = NULL WHERE username = ?", [username]);
    await player.setTwoFactorPending(username, false);
    return new Response(JSON.stringify({ emailVerified: true }), { status: 200 });
  }

  await player.setTwoFactorPending(username, false);

  const has2FA = await getRequiredLoginMethod(username);

  if (has2FA) {
    await player.setTwoFactorPending(username, true);

    return new Response(JSON.stringify({ requires2FA: true }), { status: 200 });
  }

  return new Response(JSON.stringify({ verified: true }), { status: 200 });
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

    await query("UPDATE accounts SET require_email_2fa = 1 WHERE username = ?", [username]);

    const result = await verify(token, email.toLowerCase(), username.toLowerCase(), 'account') as any;
    if (result instanceof Error) {
      return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
    }
    return new Response(JSON.stringify({ message: "Verification email sent" }), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
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

    const account = await query("SELECT email_verified FROM accounts WHERE username = ? LIMIT 1", [username]) as any[];
    const isVerified = account[0]?.email_verified === 1;

    if (!isVerified) {
      const result = await verify(token, useremail.toLowerCase(), username.toLowerCase(), 'account') as any;
      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      await player.setTwoFactorPending(username, true);
      return new Response(JSON.stringify({ message: "Account not verified. Check your email.", code: "unverified" }), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }

    if (await isEmail2FARequired(username)) {
      const result = await verify(token, useremail.toLowerCase(), username.toLowerCase(), 'login') as any;
      if (result instanceof Error) {
        return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
      }
      await player.setTwoFactorPending(username, true);
      return new Response(JSON.stringify({ message: "Verification email sent" }), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/;` } });
    }

    const has2FA = await getRequiredLoginMethod(username);

    if (has2FA) {
      await player.setTwoFactorPending(username, true);
      return new Response(JSON.stringify({ message: "2FA required", requires2FA: true }), { status: 200, headers: { "Set-Cookie": `token=${token}; Path=/; SameSite=Lax` } });
    }

    return new Response(JSON.stringify({ message: "Logged in successfully"}), { status: 301, headers: { "Set-Cookie": `token=${token}; Path=/; SameSite=Lax` } });
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

  const result = await query("SELECT email, username FROM accounts WHERE email = ? LIMIT 1", [email]) as any;

  if (result.length === 0) {
    return new Response(JSON.stringify({ message: responseMessage }), { status: 200 });
  }

  const code = randomBytes(8);

  const has2FA = await player.hasTwoFactorEnabled(result[0].username);
  const twofaParam = has2FA ? "&require2fa=1" : "";

  const gameName = process.env.GAME_NAME || "Frostfire Forge";
  const subject = "Reset your password";
  const url = `${process.env.DOMAIN}/manage-profile?email=${email}&code=${code}${twofaParam}`;
  const message = buildEmailBody(
    "Reset Your Password",
    "Click the button below to reset your password. This link will expire after use.",
    buildLinkAction(url, "Reset Password")
  );
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

  const codeResult = await query("SELECT reset_password_code, username, totp_secret, totp_enabled FROM accounts WHERE email = ? AND reset_password_code = ? LIMIT 1", [body.email.toLowerCase(), body.code]) as any;
  if (codeResult.length === 0) {
    log.warn(`Invalid reset password code for email: ${body.email.toLowerCase()}`);
    return new Response(JSON.stringify({ message: "Invalid reset password code" }), { status: 403 });
  }

  if (codeResult[0].totp_enabled === 1) {
    if (!body.totp) {
      return new Response(JSON.stringify({ message: "Authenticator code is required" }), { status: 400 });
    }
    if (!verifyTOTP(codeResult[0].totp_secret, body.totp)) {
      return new Response(JSON.stringify({ message: "Invalid authenticator code" }), { status: 400 });
    }
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

async function handleGetProfile(req: Request) {
  const auth = await requireAuth(req);
  if (!('username' in auth)) return auth;
  const username = auth.username;

  const profile = await player.getProfile(username) as any;
  if (!profile) {
    return new Response(JSON.stringify({ message: "Profile not found" }), { status: 404 });
  }

  let webauthnCredentials = [];
  if (profile.webauthn_credentials) {
    try {
      const decoded = Buffer.from(profile.webauthn_credentials, "base64").toString("utf-8");
      webauthnCredentials = JSON.parse(decoded);
    } catch {
      // ignore parse errors
    }
  }

  return new Response(JSON.stringify({
    username: profile.username,
    email_masked: maskEmail(profile.email),
    totp_enabled: profile.totp_enabled === 1,
    webauthn_enabled: profile.webauthn_enabled === 1,
    webauthn_credentials: webauthnCredentials,
    last_login: profile.last_login,
    require_webauthn: profile.require_webauthn === 1,
    require_totp: profile.require_totp === 1,
    require_email_2fa: profile.require_email_2fa === 1,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleChangeEmail(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { email, password } = body;

  if (password) {
    const pwdCheck = await player.login(username, password);
    if (!pwdCheck) {
      return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
    }
  }

  if (!email || !validateEmail(email)) {
    return new Response(JSON.stringify({ message: "Invalid email format" }), { status: 400 });
  }

  const currentEmail = await player.getEmail(username);
  if (email.toLowerCase() === currentEmail.toLowerCase()) {
    return new Response(JSON.stringify({ message: "New email is the same as your current email" }), { status: 400 });
  }

  const emailExists = await player.findByEmail(email.toLowerCase());
  if (emailExists && (emailExists as any[]).length > 0) {
    return new Response(JSON.stringify({ message: "Email already in use" }), { status: 400 });
  }

  const hasTOTP = await player.hasTwoFactorEnabled(username);
  if (hasTOTP) {
    if (body.totp) {
      const totpData = await player.getTOTPSecret(username) as any;
      if (!totpData || !totpData.totp_secret || !verifyTOTP(totpData.totp_secret, body.totp)) {
        return new Response(JSON.stringify({ message: "Invalid authenticator code" }), { status: 400 });
      }
    } else if (!body.oldEmailCode && !body.emailCode) {
      return new Response(JSON.stringify({ message: "Authenticator code is required" }), { status: 400 });
    }
  }

  const gameName = process.env.GAME_NAME || "Frostfire Forge";

  if (body.oldEmailCode) {
    const result = await query(
      "SELECT verification_code FROM accounts WHERE username = ?",
      [username]
    ) as any[];
    if (!result.length || result[0].verification_code !== body.oldEmailCode) {
      return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
    }

    const newCode = randomBytes(6).substring(0, 6).toUpperCase();
    await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [newCode, username]);

    const newSubject = "Verify your new email";
    const newMessage = buildEmailBody(
      "Confirm Your New Email",
      `Enter the code below to confirm <strong>${maskEmail(email)}</strong> as your new email address for ${gameName}.`,
      buildCodeAction(newCode)
    );
    await sendEmail(email, newSubject, gameName, newMessage);

    return new Response(JSON.stringify({
      requiresNewCode: true,
      message: "Verification code sent to your new email",
      newEmailMasked: maskEmail(email),
    }), { status: 200 });
  }

  if (body.emailCode) {
    const result = await query(
      "SELECT verification_code, pending_email FROM accounts WHERE username = ?",
      [username]
    ) as any[];
    if (!result.length || result[0].verification_code !== body.emailCode || result[0].pending_email !== email.toLowerCase()) {
      return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
    }
    await query("UPDATE accounts SET email = pending_email, email_verified = 1, verification_code = NULL, pending_email = NULL WHERE username = ?", [username]);
    return new Response(JSON.stringify({ message: "Email updated successfully", email_masked: maskEmail(email) }), { status: 200 });
  }

  const code = randomBytes(6).substring(0, 6).toUpperCase();
  await query("UPDATE accounts SET verification_code = ?, pending_email = ? WHERE username = ?", [code, email.toLowerCase(), username]);

  const oldSubject = "Verify email change";
  const oldMessage = buildEmailBody(
    "Verify Your Current Email",
    `A request was made to change your ${gameName} account email to <strong>${email}</strong>. Enter the code below to begin the change.`,
    buildCodeAction(code)
  );
  await sendEmail(currentEmail, oldSubject, gameName, oldMessage);

  return new Response(JSON.stringify({
    requiresOldCode: true,
    message: "Verification code sent to your current email",
    oldEmailMasked: maskEmail(currentEmail),
  }), { status: 200 });
}

async function handleChangePassword(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return new Response(JSON.stringify({ message: "All fields are required" }), { status: 400 });
  }

  if (!validatePasswordComplexity(newPassword)) {
    return new Response(JSON.stringify({ message: "Password must be between 8 and 20 characters long, contain at least one uppercase letter, one lowercase letter, one number, and one special character." }), { status: 400 });
  }

  const token = await player.login(username, currentPassword);
  if (!token) {
    return new Response(JSON.stringify({ message: "Current password is incorrect" }), { status: 400 });
  }

  const hasTOTP = await player.hasTwoFactorEnabled(username);

  if (hasTOTP) {
    if (!body.totp) {
      return new Response(JSON.stringify({ message: "Authenticator code is required" }), { status: 400 });
    }
    const totpData = await player.getTOTPSecret(username) as any;
    if (!totpData || !totpData.totp_secret || !verifyTOTP(totpData.totp_secret, body.totp)) {
      return new Response(JSON.stringify({ message: "Invalid authenticator code" }), { status: 400 });
    }
  } else if (await isEmail2FARequired(username)) {
    if (body.emailCode) {
      const result = await query(
        "SELECT verification_code FROM accounts WHERE username = ?",
        [username]
      ) as any[];
      if (!result.length || result[0].verification_code !== body.emailCode) {
        return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
      }
      await query("UPDATE accounts SET verification_code = NULL WHERE username = ?", [username]);
    } else {
      const useremail = await player.getEmail(username);
      const code = shuffle(token, 6);
      await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [code, username]);

      const gameName = process.env.GAME_NAME || "Frostfire Forge";
      const subject = "Verify password change";
        const message = buildEmailBody(
          "Confirm Password Change",
          "Enter the code below to confirm your password change.",
          buildCodeAction(code)
        );
        const emailResponse = await sendEmail(useremail, subject, gameName, message);
        if (emailResponse !== "Email sent successfully") {
          return new Response(JSON.stringify({ message: "Failed to send verification email" }), { status: 500 });
        }

        return new Response(JSON.stringify({ requiresEmail: true, message: "Verification email sent" }), { status: 200 });
      }
    }
  const newPasswordHash = await hash(newPassword);
  await player.changePassword(username, newPasswordHash);

  return new Response(JSON.stringify({ message: "Password updated successfully" }), { status: 200 });
}

async function handleSetupTOTP(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { password } = body;

  if (!password) {
    return new Response(JSON.stringify({ message: "Password is required" }), { status: 400 });
  }

  const pwdCheck = await player.login(username, password);
  if (!pwdCheck) {
    return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
  }

  const totpData = await player.getTOTPSecret(username) as any;
  if (totpData && totpData.totp_enabled === 1) {
    return new Response(JSON.stringify({ message: "TOTP already enabled" }), { status: 400 });
  }

  const secret = generateSecret();
  await player.setTOTPSecret(username, secret);

  const issuer = process.env.GAME_NAME || "Frostfire Forge";
  const uri = generateTotpUri(secret, username, issuer);
  const qrUrl = await generateQRDataUri(uri);

  return new Response(JSON.stringify({ qrUrl, uri }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleVerifyTOTP(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { code } = body;

  if (!code || typeof code !== "string" || code.length !== 6) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  const totpData = await player.getTOTPSecret(username) as any;
  if (!totpData || !totpData.totp_secret) {
    return new Response(JSON.stringify({ message: "TOTP not set up" }), { status: 400 });
  }

  if (!verifyTOTP(totpData.totp_secret, code)) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  await player.enableTOTP(username);
  return new Response(JSON.stringify({ message: "Authenticator app enabled successfully" }), { status: 200 });
}

async function handleDisableTOTP(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { password } = body;

  if (!password) {
    return new Response(JSON.stringify({ message: "Password is required" }), { status: 400 });
  }

  const pwdCheck = await player.login(username, password);
  if (!pwdCheck) {
    return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
  }

  if (body.emailCode) {
    const result = await query(
      "SELECT verification_code FROM accounts WHERE username = ?",
      [username]
    ) as any[];
    if (!result.length || result[0].verification_code !== body.emailCode) {
      return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
    }
    await query("UPDATE accounts SET verification_code = NULL WHERE username = ?", [username]);
  } else {
    const useremail = await player.getEmail(username);
    const code = randomBytes(6).substring(0, 6).toUpperCase();
    await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [code, username]);

    const gameName = process.env.GAME_NAME || "Frostfire Forge";
    const subject = "Verify TOTP removal";
    const message = buildEmailBody(
      "Confirm Authenticator Removal",
      "Enter the code below to confirm removal of your authenticator app.",
      buildCodeAction(code)
    );
    await sendEmail(useremail, subject, gameName, message);

    return new Response(JSON.stringify({ requiresEmail: true, message: "Verification email sent" }), { status: 200 });
  }

  await player.disableTOTP(username);
  await player.setTwoFactorRequirement(username, 'totp', false);
  return new Response(JSON.stringify({ message: "Authenticator app disabled" }), { status: 200 });
}

async function handleRegisterWebAuthn(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { password } = body;

  if (!password) {
    return new Response(JSON.stringify({ message: "Password is required" }), { status: 400 });
  }

  const pwdCheck = await player.login(username, password);
  if (!pwdCheck) {
    return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
  }

  const { rpId } = getRequestOrigin(req);
  const rpName = process.env.GAME_NAME || "Frostfire Forge";
  const userId = username;

  const existingCredentials = await player.getWebAuthnCredentials(username) as any[];

  const challenge = generateChallenge();
  // Store challenge for verification - use a temporary key
  const tempChallenges = (globalThis as any).__webauthnRegisterChallenges || {};
  tempChallenges[username] = challenge;
  (globalThis as any).__webauthnRegisterChallenges = tempChallenges;

  const options = generateRegistrationOptions(challenge, rpName, rpId, userId, username, username, existingCredentials);

  return new Response(JSON.stringify(options), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleVerifyWebAuthnRegistration(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { keyName, credentialId, clientDataJSON, attestationObject } = body;

  if (!credentialId || !clientDataJSON || !attestationObject) {
    return new Response(JSON.stringify({ message: "Missing credential data" }), { status: 400 });
  }

  const tempChallenges = (globalThis as any).__webauthnRegisterChallenges || {};
  const challenge = tempChallenges[username];
  if (!challenge) {
    return new Response(JSON.stringify({ message: "Registration session expired" }), { status: 400 });
  }
  delete tempChallenges[username];
  (globalThis as any).__webauthnRegisterChallenges = tempChallenges;

  const { rpId, origin } = getRequestOrigin(req);

  try {
    const result = verifyAttestation(clientDataJSON, attestationObject, encodeBase64Url(challenge), rpId, origin);

    if (result.credentialId !== credentialId) {
      return new Response(JSON.stringify({ message: "Credential ID mismatch" }), { status: 400 });
    }

    await player.addWebAuthnCredential(username, {
      id: result.credentialId,
      publicKey: result.publicKey,
      name: keyName || "Security Key",
      createdAt: new Date().toISOString(),
    });

    const credentials = await player.getWebAuthnCredentials(username);
    return new Response(JSON.stringify({ message: "Security key registered", credentials }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ message: err.message || "WebAuthn registration failed" }), { status: 400 });
  }
}

async function handleRemoveWebAuthn(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { credentialId, password } = body;

  if (!credentialId) {
    return new Response(JSON.stringify({ message: "Credential ID required" }), { status: 400 });
  }

  if (!password) {
    return new Response(JSON.stringify({ message: "Password is required" }), { status: 400 });
  }

  const pwdCheck = await player.login(username, password);
  if (!pwdCheck) {
    return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
  }

  const totpData = await player.getTOTPSecret(username) as any;
  const hasTOTP = totpData?.totp_enabled === 1;

  if (hasTOTP) {
    if (!body.totp) {
      return new Response(JSON.stringify({ message: "Authenticator code is required" }), { status: 400 });
    }
    if (!totpData.totp_secret || !verifyTOTP(totpData.totp_secret, body.totp)) {
      return new Response(JSON.stringify({ message: "Invalid authenticator code" }), { status: 400 });
    }
  } else if (body.emailCode) {
    const result = await query(
      "SELECT verification_code FROM accounts WHERE username = ?",
      [username]
    ) as any[];
    if (!result.length || result[0].verification_code !== body.emailCode) {
      return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
    }
    await query("UPDATE accounts SET verification_code = NULL WHERE username = ?", [username]);
  } else {
      const useremail = await player.getEmail(username);
      const code = randomBytes(6).substring(0, 6).toUpperCase();
      await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [code, username]);

      const gameName = process.env.GAME_NAME || "Frostfire Forge";
      const subject = "Verify key removal";
      const message = buildEmailBody(
        "Confirm Security Key Removal",
        "Enter the code below to confirm removal of your security key.",
        buildCodeAction(code)
      );
      await sendEmail(useremail, subject, gameName, message);

      return new Response(JSON.stringify({ requiresEmail: true, message: "Verification email sent" }), { status: 200 });
    }

  await player.removeWebAuthnCredential(username, credentialId);
  const credentials = await player.getWebAuthnCredentials(username);
  if ((credentials as any[]).length === 0) {
    await player.setTwoFactorRequirement(username, 'webauthn', false);
  }
  const reqs = await player.getTwoFactorRequirements(username);
  return new Response(JSON.stringify({ message: "Security key removed", credentials, ...reqs }), { status: 200 });
}

async function handle2FAStatus(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA required" }), { status: 400 });
  }

  const reqs = await player.getTwoFactorRequirements(username);
  const totpData = await player.getTOTPSecret(username) as any;
  const webauthnCreds = await player.getWebAuthnCredentials(username) as any[];
  const hasTotp = totpData?.totp_enabled === 1;
  const hasWebAuthn = webauthnCreds.length > 0;

  const methods: string[] = [];
  if (reqs.requireWebAuthn && hasWebAuthn) methods.push("webauthn");
  if (reqs.requireTotp && hasTotp) methods.push("totp");

  return new Response(JSON.stringify({
    methods,
    hasTotp,
    hasWebAuthn,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleVerifyTOTPLogin(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA challenge pending" }), { status: 400 });
  }

  const body = await req.json();
  const { code } = body;

  if (!code || typeof code !== "string" || code.length !== 6) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  const totpData = await player.getTOTPSecret(username) as any;
  if (!totpData || !totpData.totp_secret || totpData.totp_enabled !== 1) {
    return new Response(JSON.stringify({ message: "TOTP not enabled" }), { status: 400 });
  }

  if (!verifyTOTP(totpData.totp_secret, code)) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  await player.setTwoFactorPending(username, false);

  return new Response(JSON.stringify({ message: "2FA verified" }), { status: 200 });
}

async function handleAuthWebAuthn(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA challenge pending" }), { status: 400 });
  }

  const credentials = await player.getWebAuthnCredentials(username) as any[];
  if (credentials.length === 0) {
    return new Response(JSON.stringify({ message: "No WebAuthn credentials registered" }), { status: 400 });
  }

  const { rpId } = getRequestOrigin(req);
  const challenge = generateChallenge();

  const tempChallenges = (globalThis as any).__webauthnChallenges || {};
  tempChallenges[username] = challenge;
  (globalThis as any).__webauthnChallenges = tempChallenges;

  const options = generateAssertionOptions(challenge, rpId, credentials);

  return new Response(JSON.stringify(options), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleSend2FAEmail(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA challenge pending" }), { status: 400 });
  }

  const useremail = await player.getEmail(username);
  const code = randomBytes(6).substring(0, 6).toUpperCase();
  await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [code, username]);

  const gameName = process.env.GAME_NAME || "Frostfire Forge";
  const subject = "Login verification";
  const message = buildEmailBody(
    "Verify Your Login",
    "Enter the code below to complete sign-in.",
    buildCodeAction(code)
  );
  await sendEmail(useremail, subject, gameName, message);

  return new Response(JSON.stringify({ message: "Verification email sent" }), { status: 200 });
}

async function handleVerify2FAEmail(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA challenge pending" }), { status: 400 });
  }

  const body = await req.json();
  const { code } = body;
  if (!code || code.length !== 6) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  const result = await query(
    "SELECT verification_code FROM accounts WHERE username = ?",
    [username]
  ) as any[];
  if (!result.length || result[0].verification_code !== code) {
    return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
  }

  await query("UPDATE accounts SET verification_code = NULL WHERE username = ?", [username]);
  await player.setTwoFactorPending(username, false);

  return new Response(JSON.stringify({ message: "2FA verified" }), { status: 200 });
}

async function verifyWebAuthnAssertion(username: string, credentialId: string, clientDataJSON: string, authenticatorData: string, signature: string, req: Request): Promise<{ error?: string }> {
  if (!credentialId || !clientDataJSON || !authenticatorData || !signature) {
    return { error: "Missing assertion data" };
  }

  const challenge = (globalThis as any).__webauthnChallenges?.[username];
  if (!challenge) {
    return { error: "Authentication session expired" };
  }
  delete (globalThis as any).__webauthnChallenges[username];

  const credentials = await player.getWebAuthnCredentials(username) as any[];
  const cred = credentials.find((c: any) => c.id === credentialId);
  if (!cred) {
    return { error: "Unknown credential" };
  }

  const { rpId, origin } = getRequestOrigin(req);
  log.debug(`WebAuthn verify - rpId: ${rpId}, origin: ${origin}, challenge: ${challenge.substring(0, 16)}...`);

  try {
    verifyAssertion(clientDataJSON, authenticatorData, signature, encodeBase64Url(challenge), credentialId, cred.publicKey, origin, rpId);
    return {};
  } catch (err: any) {
    log.error(`WebAuthn assertion failed: ${err.message}`);
    return { error: err.message || "Verification failed" };
  }
}

async function handleVerifyWebAuthnLogin(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const isPending = await player.isTwoFactorPending(username);
  if (!isPending) {
    return new Response(JSON.stringify({ message: "No 2FA challenge pending" }), { status: 400 });
  }

  const body = await req.json();
  const { credentialId, clientDataJSON, authenticatorData, signature } = body;

  const result = await verifyWebAuthnAssertion(username, credentialId, clientDataJSON, authenticatorData, signature, req);
  if (result.error) {
    return new Response(JSON.stringify({ message: result.error }), { status: 400 });
  }

  await player.setTwoFactorPending(username, false);

  return new Response(JSON.stringify({ message: "2FA verified" }), { status: 200 });
}

async function getRequiredLoginMethod(username: string): Promise<boolean> {
  const reqs = await player.getTwoFactorRequirements(username);

  if (reqs.requireWebAuthn) {
    const creds = await player.getWebAuthnCredentials(username) as any[];
    if (creds.length > 0) return true;
  }

  if (reqs.requireTotp) {
    const totpData = await player.getTOTPSecret(username) as any;
    if (totpData && totpData.totp_enabled === 1) return true;
  }

  return false;
}

async function isEmail2FARequired(username: string): Promise<boolean> {
  const reqs = await player.getTwoFactorRequirements(username);
  return reqs.requireEmail2FA;
}

function maskEmail(email: string): string {
  return "********";
}

async function handleRevealEmail(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { password } = body;
  if (!password) {
    return new Response(JSON.stringify({ message: "Password is required" }), { status: 400 });
  }

  const token = await player.login(username, password);
  if (!token) {
    return new Response(JSON.stringify({ message: "Incorrect password" }), { status: 400 });
  }

  const email = await player.getEmail(username);
  return new Response(JSON.stringify({ email }), { status: 200 });
}

async function handleProfileWebAuthnAuth(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const credentials = await player.getWebAuthnCredentials(username) as any[];
  if (credentials.length === 0) {
    return new Response(JSON.stringify({ message: "No WebAuthn credentials registered" }), { status: 400 });
  }

  const { rpId } = getRequestOrigin(req);
  const challenge = generateChallenge();

  const tempChallenges = (globalThis as any).__webauthnChallenges || {};  
  tempChallenges[username] = challenge;
  (globalThis as any).__webauthnChallenges = tempChallenges;

  const options = generateAssertionOptions(challenge, rpId, credentials);
  return new Response(JSON.stringify(options), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handleSet2FARequirement(req: Request) {
  const username = await getUsernameFromToken(req);
  if (!username) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }

  const body = await req.json();
  const { method } = body;
  const value = body.value === true || body.value === 'true';

  if (!method || !['webauthn', 'totp', 'email'].includes(method)) {
    return new Response(JSON.stringify({ message: "Invalid method" }), { status: 400 });
  }

  // Enabling requires no additional verification
  if (value) {
    if (method === 'webauthn') {
      const creds = await player.getWebAuthnCredentials(username) as any[];
      if (creds.length === 0) {
        return new Response(JSON.stringify({ message: "No security keys registered" }), { status: 400 });
      }
    }
    if (method === 'totp') {
      const totpData = await player.getTOTPSecret(username) as any;
      if (!totpData || totpData.totp_enabled !== 1) {
        return new Response(JSON.stringify({ message: "Authenticator app not set up" }), { status: 400 });
      }
    }
    if (method === 'email') {
      // email 2FA is always available
    }

    await player.setTwoFactorRequirement(username, method, true);
    const updated = await player.getTwoFactorRequirements(username);
    return new Response(JSON.stringify(updated), { status: 200 });
  }

  // Disabling requires that method's verification
  if (method === 'webauthn') {
    if (!body.webauthnResponse) {
      return new Response(JSON.stringify({ requiresWebAuthn: true, message: "Authenticate with security key to disable" }), { status: 200 });
    }

    const { credentialId, clientDataJSON, authenticatorData, signature } = body.webauthnResponse;
    const result = await verifyWebAuthnAssertion(username, credentialId, clientDataJSON, authenticatorData, signature, req);
    if (result.error) {
      return new Response(JSON.stringify({ message: result.error }), { status: 400 });
    }
  }

  if (method === 'totp') {
    if (!body.totp) {
      return new Response(JSON.stringify({ message: "Authenticator code is required" }), { status: 400 });
    }
    const totpData = await player.getTOTPSecret(username) as any;
    if (!totpData || !totpData.totp_secret || !verifyTOTP(totpData.totp_secret, body.totp)) {
      return new Response(JSON.stringify({ message: "Invalid authenticator code" }), { status: 400 });
    }
  }

  if (method === 'email') {
    if (!body.emailCode) {
      const useremail = await player.getEmail(username);
      const code = randomBytes(6).substring(0, 6).toUpperCase();
      await query("UPDATE accounts SET verification_code = ? WHERE username = ?", [code, username]);

      const gameName = process.env.GAME_NAME || "Frostfire Forge";
      const message = buildEmailBody(
        "Confirm 2FA Change",
        "Enter the code below to confirm disabling email verification.",
        buildCodeAction(code)
      );
      await sendEmail(useremail, "Verify 2FA change", gameName, message);

      return new Response(JSON.stringify({ requiresEmail: true, message: "Verification email sent" }), { status: 200 });
    }

    const result = await query(
      "SELECT verification_code FROM accounts WHERE username = ?",
      [username]
    ) as any[];
    if (!result.length || result[0].verification_code !== body.emailCode) {
      return new Response(JSON.stringify({ message: "Invalid verification code" }), { status: 400 });
    }
    await query("UPDATE accounts SET verification_code = NULL WHERE username = ?", [username]);
  }

  await player.setTwoFactorRequirement(username, method, false);
  const updated = await player.getTwoFactorRequirements(username);
  return new Response(JSON.stringify(updated), { status: 200 });
}

function handleGeneratePassword() {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const special = "!@#$%^&*(),.?\":{}|<>";
  const all = uppercase + lowercase + numbers + special;

  const bytes = crypto.randomBytes(16);
  const arr: string[] = [];
  arr.push(uppercase[bytes[0] % uppercase.length]);
  arr.push(lowercase[bytes[1] % lowercase.length]);
  arr.push(numbers[bytes[2] % numbers.length]);
  arr.push(special[bytes[3] % special.length]);

  for (let i = 4; i < 16; i++) {
    arr.push(all[bytes[i] % all.length]);
  }

  for (let i = arr.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return new Response(JSON.stringify({ password: arr.join("") }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}