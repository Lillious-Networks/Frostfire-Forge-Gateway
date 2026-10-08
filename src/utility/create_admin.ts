import { transaction } from "../controllers/sqldatabase";
import player from "../systems/player";
import { hash, randomBytes } from "../modules/hash";
import log from "../modules/logger";

// Same rules the registration form applies.
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,15}$/;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,100}$/;
const ADMIN_PERMISSIONS = "admin.*,server.*,permission.*";

const createAdmin = async (username: string, email: string) => {
  // Nobody knows this password: the account is entered through the link printed below.
  const password_hash = await hash(randomBytes(32));

  const registered = (await player.register(username, password_hash, email, { ip: null, headers: {} }, false)) as any;
  if (!registered || registered.error) {
    throw new Error(registered?.error || "Failed to register");
  }

  // Verified and without the e-mail login code, so the admin can log in before any mail server is configured.
  const code = randomBytes(8);
  try {
    await transaction([
      {
        sql: "UPDATE accounts SET role = 1, email_verified = 1, require_email_2fa = 0, reset_password_code = ? WHERE username = ?",
        values: [code, username],
        mustChange: true,
      },
      { sql: "DELETE FROM permissions WHERE username = ?", values: [username] },
      { sql: "INSERT INTO permissions (username, permissions) VALUES (?, ?)", values: [username, ADMIN_PERMISSIONS] },
    ]);
  } catch (error) {
    throw new Error(`Account '${username}' was created but could not be made an admin: ${error}`);
  }

  return `${process.env.DOMAIN}/manage-profile?email=${encodeURIComponent(email)}&code=${code}`;
};

const [usernameArg, emailArg] = process.argv.slice(2);

if (!usernameArg || !emailArg) {
  log.error("Usage: bun create-admin <username> <email>");
  process.exit(1);
}

const username = usernameArg.toLowerCase();
const email = emailArg.toLowerCase();

if (!USERNAME_PATTERN.test(username)) {
  log.error("Invalid username: use 3 to 15 letters, numbers or underscores");
  process.exit(1);
}

if (!EMAIL_PATTERN.test(email)) {
  log.error("Invalid email format");
  process.exit(1);
}

if (!process.env.DOMAIN) {
  log.error("DOMAIN is not set, so no set-password link can be built");
  process.exit(1);
}

try {
  log.info(`Creating admin account '${username}'...`);
  const link = await createAdmin(username, email);
  log.success(`Admin account '${username}' created`);
  // Straight to the terminal: the logger also writes to the log files, and this link sets the password.
  process.stdout.write(`\nSet the password with this one-time link:\n${link}\n\n`);
  process.exit(0);
} catch (error) {
  log.error(`Error creating admin account: ${error}`);
  process.exit(1);
}
