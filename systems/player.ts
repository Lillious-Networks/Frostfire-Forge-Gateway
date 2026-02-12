import query from "../controllers/sqldatabase";
import { verify, randomBytes } from "../modules/hash";
import * as settings from "../config/settings.json";
const defaultMap = (settings as any).default_map?.replace(".json", "") || "main";
import log from "../modules/logger";

const player = {
  clear: async () => {
    // Clear all session_ids, set online to 0, and clear all tokens
    await query(
      "UPDATE accounts SET session_id = NULL, online = 0, token = NULL, verified = 0, verification_code = NULL, party_id = NULL"
    );
    // Truncate the parties table
    if (process.env.DATABASE_ENGINE === "sqlite") {
      await query("DELETE FROM parties");
    } else {
      await query("TRUNCATE TABLE parties");
    }

    // Clear stats of guest accounts
    await query("DELETE FROM stats WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear client configs of guest accounts
    await query("DELETE FROM clientconfig WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear quest logs of guest accounts
    await query("DELETE FROM quest_log WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear currency of guest accounts
    await query("DELETE FROM currency WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear collectables of guest accounts
    await query("DELETE FROM collectables WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear equipment of guest accounts
    await query("DELETE FROM equipment WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear learned spells of guest accounts
    await query("DELETE FROM learned_spells WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear all guest accounts
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

    // Check if the user exists by username
    const usernameExists = (await player.findByUsername(username)) as string[];
    if (usernameExists && usernameExists.length != 0)
      return { error: "Username already exists" };

    // Check if the user exists by email
    const emailExists = (await player.findByEmail(email)) as string[];
    if (emailExists && emailExists.length != 0)
      return { error: "Email already exists" };

    const response = await query(
      "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position, guest_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        email,
        username,
        null, // token will be set during login
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

    // Create stats
    await query(
      "INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, stat_critical_damage, stat_critical_chance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [username, 100, 100, 100, 100, 0, 100, 1, 10, 10]
    );
    // Create client config
    await query(
      "INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES (?, ?, ?, ?, ?)",
      [username, 60, 50, 50, 0]
    );
    // Create quest log
    await query("INSERT INTO quest_log (username) VALUES (?)", [username]);
    // Create currency
    await query(
      "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)",
      [username, 0, 0, 0]
    );

    // Create equipment
    await query(
      "INSERT INTO equipment (username) VALUES (?)",
      [username]
    );

    // Insert default mount
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
    // Check if there is a verification code
    const response = (await query(
      "SELECT verified FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any[];
    // If a verification code exists, prevent the user from logging in until they verify their account
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
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?",
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
    // Store the token value in the database
    const response = await query(
      "UPDATE accounts SET token = ? WHERE username = ?",
      [token, username]
    );
    if (!response) return;
    // Return the hashed token for client use
    return token;
  },
  login: async (username: string, password: string) => {
    if (!username || !password) return;
    username = username.toLowerCase();
    // Validate credentials
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

    // Verify password
    const isValid = await verify(password, response[0].password_hash);
    if (!isValid) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    // Use existing token and check validity or generate new one
    const token = response[0].token || (await player.setToken(username));

    log.debug(`User ${username} logged in`);
    // Update last_login
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
};

export default player;