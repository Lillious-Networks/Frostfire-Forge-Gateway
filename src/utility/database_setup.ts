import query from "../controllers/sqldatabase";
import log from "../modules/logger";
const database = process.env.DATABASE_NAME || "TEMP_Mystika";

const createDatabase = async () => {
  log.info("Creating database...");
  const sql = `CREATE DATABASE IF NOT EXISTS ${database};`;
  await query(sql);
};

const useDatabase = async () => {
  const useDatabaseSql = `USE ${database};`;
  await query(useDatabaseSql);
};


const createAllowedIpsTable = async () => {
  log.info("Creating allowed_ips table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS allowed_ips (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL UNIQUE
    )
  `;
  await query(sql);
};

const createBlockedIpsTable = async () => {
  log.info("Creating blocked_ips table...");
  const sql = `
    CREATE TABLE IF NOT EXISTS blocked_ips (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL UNIQUE
    )
  `;
  await query(sql);
};

const insertLocalhost = async () => {
  log.info("Inserting localhost and ::1 as allowed IPs...");
  const checkSql = `SELECT COUNT(*) as count FROM allowed_ips WHERE ip IN ('127.0.0.1', '::1')`;
  const result = await query(checkSql) as Array<{ count: number }>;

  if (result[0]?.count === 0) {
    const sql = `INSERT INTO allowed_ips (ip) VALUES ('127.0.0.1'), ('::1')`;
    await query(sql);
  } else {
    log.debug("Localhost IPs already exist - skipping");
  }
};

const setupDatabase = async () => {
    await createDatabase();
    await useDatabase();
    await createAllowedIpsTable();
    await createBlockedIpsTable();
    await insertLocalhost();
};

try {
  log.info("Setting up database...");
  await setupDatabase();
  log.success("Database setup complete!");
  process.exit(0);
} catch (error) {
  log.error(`Error setting up database: ${error}`);
  process.exit(1);
}