import query from "../controllers/sqldatabase";
import { verify, randomBytes } from "../modules/hash";
const defaultMap = (process.env.DEFAULT_MAP || "overworld.json").replace(".json", "");
import log from "../modules/logger";

const player = {
  clear: async () => {

    await query(
      "UPDATE accounts SET session_id = NULL, online = 0, token = NULL, verified = 0, verification_code = NULL, party_id = NULL, twofa_pending = 0"
    );

    if (process.env.DATABASE_ENGINE === "sqlite") {
      await query("DELETE FROM parties");
    } else {
      await query("TRUNCATE TABLE parties");
    }

    await query("DELETE FROM stats WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM clientconfig WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM quest_log WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM currency WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM collectables WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM equipment WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM learned_spells WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");

    await query("DELETE FROM accounts WHERE guest_mode = 1");
  },
  register: async (
    username: string,
    password_hash: string,
    email: string,
    req: any,
    guest: boolean
  ) => {
    if (!username || !password_hash || !email)
      return { error: "Missing fields" };
    username = username.toLowerCase();
    email = email.toLowerCase();

    if (!guest && username.startsWith("guest_"))
      return { error: "Username cannot start with 'guest_'" };

    const usernameExists = (await player.findByUsername(username)) as string[];
    if (usernameExists && usernameExists.length != 0)
      return { error: "Username already exists" };

    const emailExists = (await player.findByEmail(email)) as string[];
    if (emailExists && emailExists.length != 0)
      return { error: "Email already exists" };

    const response = await query(
      "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position, guest_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        email,
        username,
        null,
        password_hash,
        req.ip,
        req.headers["cf-ipcountry"],
        defaultMap,
        "0,0",
        guest ? 1 : 0,
      ]
    ).catch((err) => {
      log.error(err);
      return { error: "An unexpected error occurred" };
    });
    if (!response) return { error: "An unexpected error occurred" };

    await query(
      "INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [username, 100, 100, 100, 100, 0, 100, 1, 10, 10]
    );

    await query(
      "INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES (?, ?, ?, ?, ?)",
      [username, 60, 50, 50, 0]
    );

    await query("INSERT INTO quest_log (username) VALUES (?)", [username]);

    await query(
      "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)",
      [username, 0, 0, 0]
    );

    await query(
      "INSERT INTO equipment (username) VALUES (?)",
      [username]
    );

    await query("INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)", ["mount", "horse", username]);
    return username;
  },
  findByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT username FROM accounts WHERE username = ?",
      [username]
    );
    return response || [];
  },
  verify: async (session_id: string) => {

    const response = (await query(
      "SELECT verified FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any[];

    if (response[0]?.verified) return true;
    return false;
  },
  findByEmail: async (email: string) => {
    if (!email) return;
    const response = await query("SELECT email FROM accounts WHERE email = ?", [
      email,
    ]);
    return response;
  },
  isBanned: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT banned FROM accounts WHERE username = ?",
      [username]
    );
    return response;
  },
  getSessionId: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT session_id FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  logout: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ?, twofa_pending = 0 WHERE session_id = ?",
      [0, 0, session_id]
    );
    return response;
  },
  clearSessionId: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?",
      [0, session_id]
    );
    return response;
  },
  setToken: async (username: string) => {
    const token = randomBytes(32);
    if (!username || !token) return;

    const response = await query(
      "UPDATE accounts SET token = ? WHERE username = ?",
      [token, username]
    );
    if (!response) return;

    return token;
  },
  login: async (username: string, password: string) => {
    if (!username || !password) return;
    username = username.toLowerCase();

    const response = (await query(
      "SELECT username, banned, token, password_hash FROM accounts WHERE username = ?",
      [username]
    )) as {
      username: string;
      banned: number;
      token: string;
      password_hash: string;
    }[];
    if (response.length === 0 || response[0].banned === 1) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    const isValid = await verify(password, response[0].password_hash);
    if (!isValid) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    const token = response[0].token || (await player.setToken(username));

    log.debug(`User ${username} logged in`);

    await query(
      "UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?",
      [username]
    );
    return token;
  },
  getUsernameBySession: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "SELECT username, id FROM accounts WHERE session_id = ?",
      [session_id]
    );
    return response;
  },
  getSessionIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.session_id;
  },
  getPartyIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT party_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.party_id;
  },
  getUsernameByToken: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT username FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  getEmail: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT email FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.email;
  },
  getProfile: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT username, email, totp_enabled, webauthn_enabled, webauthn_credentials, last_login, require_webauthn, require_totp, require_email_2fa FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return null;
    return response[0];
  },
  updateEmail: async (username: string, email: string) => {
    if (!username || !email) return;
    username = username.toLowerCase();
    email = email.toLowerCase();
    const response = await query(
      "UPDATE accounts SET email = ? WHERE username = ?",
      [email, username]
    );
    return response;
  },
  changePassword: async (username: string, newPasswordHash: string) => {
    if (!username || !newPasswordHash) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET password_hash = ? WHERE username = ?",
      [newPasswordHash, username]
    );
    return response;
  },
  getTOTPSecret: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT totp_secret, totp_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return null;
    return response[0];
  },
  setTOTPSecret: async (username: string, secret: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_secret = ?, totp_enabled = 0 WHERE username = ?",
      [secret, username]
    );
    return response;
  },
  enableTOTP: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_enabled = 1 WHERE username = ?",
      [username]
    );
    return response;
  },
  disableTOTP: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET totp_secret = NULL, totp_enabled = 0 WHERE username = ?",
      [username]
    );
    return response;
  },
  getWebAuthnCredentials: async (username: string) => {
    if (!username) return [];
    username = username.toLowerCase();
    const response = (await query(
      "SELECT webauthn_credentials, webauthn_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return [];
    const row = response[0];
    if (!row.webauthn_credentials) return [];
    try {
      const decoded = Buffer.from(row.webauthn_credentials, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      return parsed;
    } catch {
      return [];
    }
  },
  addWebAuthnCredential: async (username: string, credential: { id: string; publicKey: string; name: string; createdAt: string }) => {
    if (!username) return;
    username = username.toLowerCase();
    const existing = await player.getWebAuthnCredentials(username);
    existing.push(credential);
    const json = JSON.stringify(existing);
    const encoded = Buffer.from(json).toString("base64");
    const response = await query(
      "UPDATE accounts SET webauthn_credentials = ?, webauthn_enabled = 1 WHERE username = ?",
      [encoded, username]
    );
    if (!response) {
      log.error(`Failed to store WebAuthn credential for ${username}`);
    }
    return response;
  },
  removeWebAuthnCredential: async (username: string, credentialId: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const existing = await player.getWebAuthnCredentials(username);
    const filtered = existing.filter((c: any) => c.id !== credentialId);
    const json = filtered.length > 0 ? JSON.stringify(filtered) : null;
    const encoded = json ? Buffer.from(json).toString("base64") : null;
    const enabled = filtered.length > 0 ? 1 : 0;
    const response = await query(
      "UPDATE accounts SET webauthn_credentials = ?, webauthn_enabled = ? WHERE username = ?",
      [encoded, enabled, username]
    );
    return response;
  },
  hasTwoFactorEnabled: async (username: string) => {
    if (!username) return false;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT totp_enabled, webauthn_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return false;
    return response[0].totp_enabled === 1 || response[0].webauthn_enabled === 1;
  },
  setTwoFactorPending: async (username: string, pending: boolean) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET twofa_pending = ? WHERE username = ?",
      [pending ? 1 : 0, username]
    );
    return response;
  },
  isTwoFactorPending: async (username: string) => {
    if (!username) return false;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT twofa_pending FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return false;
    return response[0].twofa_pending === 1;
  },
  getTwoFactorRequirements: async (username: string) => {
    if (!username) return { requireWebAuthn: false, requireTotp: false, requireEmail2FA: false };
    username = username.toLowerCase();
    const response = (await query(
      "SELECT require_webauthn, require_totp, require_email_2fa, totp_enabled, webauthn_enabled FROM accounts WHERE username = ?",
      [username]
    )) as any[];
    if (!response || response.length === 0) return { requireWebAuthn: false, requireTotp: false, requireEmail2FA: false };
    return {
      requireWebAuthn: response[0].require_webauthn === 1,
      requireTotp: response[0].require_totp === 1,
      requireEmail2FA: response[0].require_email_2fa === 1,
    };
  },
  setTwoFactorRequirement: async (username: string, method: string, value: boolean) => {
    if (!username) return;
    username = username.toLowerCase();
    const col = method === 'webauthn' ? 'require_webauthn' : method === 'totp' ? 'require_totp' : 'require_email_2fa';
    const response = await query(
      `UPDATE accounts SET ${col} = ? WHERE username = ?`,
      [value ? 1 : 0, username]
    );
    return response;
  },
};

export default player;