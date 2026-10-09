// Player subscriptions, the Gateway half: the tables and columns the feature needs, the Stripe calls,
// the webhook, and what the account page and the login pre-check ask. The engine reads the same
// columns and tables (accounts.subscribed, subscription_locks, subscription_status).
//
// Stripe is called with plain fetch. The secret key and the webhook secret are never logged and never
// leave this process, and a Stripe answer is never logged as a whole: only the status and error code.
import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { encodeForm, stripeSettings, subscriptionToAccountState, verifyStripeSignature, type StripeSettings } from "../modules/stripe";

const sqlite = (process.env.DATABASE_ENGINE || "mysql") === "sqlite";

/** True once the columns and tables exist. While false the feature is off: nobody is locked, nothing is charged. */
let ready = false;

const COLUMNS = [
  { name: "subscribed", mysql: "INT NOT NULL DEFAULT 0", sqlite: "INTEGER NOT NULL DEFAULT 0" },
  { name: "stripe_customer_id", mysql: "VARCHAR(64) DEFAULT NULL", sqlite: "TEXT DEFAULT NULL" },
  { name: "subscription_ends", mysql: "BIGINT DEFAULT NULL", sqlite: "INTEGER DEFAULT NULL" },
];

async function hasColumn(name: string): Promise<boolean> {
  if (sqlite) {
    const rows = await query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'");
    return String(rows[0]?.sql || "").includes(name);
  }
  const rows = await query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = ?",
    [name]
  );
  return Number(rows[0]?.count) > 0;
}

/**
 * Makes sure the three accounts columns and the two tables exist. Safe on every start, never throws: when
 * something cannot be added it logs one warning and leaves the feature off. The engine does the same
 * step; whichever starts first does the work.
 */
export async function ensureSubscriptionSchema(): Promise<boolean> {
  ready = false;
  try {
    for (const column of COLUMNS) {
      if (await hasColumn(column.name)) continue;
      try {
        await query(`ALTER TABLE accounts ADD COLUMN ${column.name} ${sqlite ? column.sqlite : column.mysql}`);
      } catch {
        // Another process may have added it in the same moment: only a column still missing is an error.
        if (!(await hasColumn(column.name))) throw new Error(`the accounts column ${column.name} could not be added`);
      }
    }
    await query("CREATE TABLE IF NOT EXISTS subscription_locks (name " + (sqlite ? "TEXT" : "VARCHAR(64)") + " NOT NULL PRIMARY KEY)");
    await query(
      "CREATE TABLE IF NOT EXISTS subscription_status (id " + (sqlite ? "INTEGER" : "INT") + " NOT NULL PRIMARY KEY, enabled " +
        (sqlite ? "INTEGER" : "INT") + " NOT NULL DEFAULT 0, updated_at " + (sqlite ? "INTEGER" : "BIGINT") + " NOT NULL DEFAULT 0)"
    );
    ready = true;
  } catch (error: any) {
    log.warn(`The subscription columns and tables could not be added (${error?.message || error}). Subscriptions stay off.`);
  }
  return ready;
}

/** Writes subscription_status: enabled when the schema is ready and all three Stripe settings are set, else off. */
export async function syncSubscriptionStatus(): Promise<void> {
  try {
    if (!ready) {
      // Whatever an earlier run left in the row must not lock anyone while the feature is off.
      try {
        await query("UPDATE subscription_status SET enabled = 0, updated_at = ? WHERE id = 1", [Date.now()]);
      } catch {
        // No table, nothing to turn off.
      }
      return;
    }
    const enabled = stripeSettings() ? 1 : 0;
    await query("INSERT IGNORE INTO subscription_status (id, enabled, updated_at) VALUES (1, 0, 0)");
    await query("UPDATE subscription_status SET enabled = ?, updated_at = ? WHERE id = 1", [enabled, Date.now()]);
    log.info(`Player subscriptions are ${enabled ? "on" : "off"}`);
  } catch (error: any) {
    ready = false;
    log.warn(`The subscription status could not be written (${error?.message || error}). Subscriptions stay off.`);
  }
}

/** The start-time step: schema, then status. */
export async function startSubscriptions(): Promise<void> {
  await ensureSubscriptionSchema();
  await syncSubscriptionStatus();
}

// ---------------------------------------------------------------- stripe

class StripeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function stripeCall(settings: StripeSettings, method: "GET" | "POST", path: string, params?: Record<string, string | number>): Promise<any> {
  const form = params ? encodeForm(params) : "";
  const get = method === "GET";
  const where = path.split("?")[0];
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com${path}${get && form ? `?${form}` : ""}`, {
      method,
      headers: get
        ? { Authorization: `Bearer ${settings.secretKey}` }
        : { Authorization: `Bearer ${settings.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: get ? undefined : form,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new StripeError(0, `Stripe ${method} ${where} could not be reached`);
  }
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // An answer that is not JSON is judged by its status alone.
  }
  if (!response.ok) {
    throw new StripeError(response.status, `Stripe ${method} ${where} answered ${response.status} ${body?.error?.type ?? ""} ${body?.error?.code ?? ""}`.trim());
  }
  return body;
}

/** A subscription by id, or null when Stripe does not know it. */
async function fetchSubscription(settings: StripeSettings, id: string): Promise<any | null> {
  if (!/^sub_[A-Za-z0-9]+$/.test(id)) return null;
  try {
    return await stripeCall(settings, "GET", `/v1/subscriptions/${id}`);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return null;
    throw error;
  }
}

// --------------------------------------------------------------- accounts

type AccountRow = {
  id: number;
  role: number;
  guest_mode: number;
  subscribed: number;
  subscription_ends: number | string | null;
  stripe_customer_id: string | null;
};

async function loadAccount(username: string): Promise<AccountRow | null> {
  const rows = await query<AccountRow>(
    "SELECT id, role, guest_mode, subscribed, subscription_ends, stripe_customer_id FROM accounts WHERE username = ?",
    [username.toLowerCase()]
  );
  return rows[0] || null;
}

function isGuest(username: string, row: AccountRow): boolean {
  return Number(row.guest_mode) === 1 || username.toLowerCase().startsWith("guest_");
}

async function applyToAccount(accountId: string | number, subscribed: boolean, endsMs: number | null, customerId: string | null): Promise<void> {
  await query(
    "UPDATE accounts SET subscribed = ?, subscription_ends = COALESCE(?, subscription_ends), stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?",
    [subscribed ? 1 : 0, endsMs, customerId, Number(accountId)]
  );
}

/** The site's own address, with scheme, as the rest of the Gateway builds it from DOMAIN. */
function siteUrl(): string {
  let domain = (process.env.DOMAIN || "").trim().replace(/\/+$/, "");
  if (!domain) return "";
  if (!/^https?:\/\//i.test(domain)) domain = `${process.env.HTTP_USE_SSL === "true" ? "https" : "http"}://${domain}`;
  return domain;
}

// An account whose paid period ended this long ago and still says subscribed has missed a webhook.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_STALE_AFTER_MS = 5 * 60 * 1000;
const staleTried = new Map<number, number>();

/** Asks Stripe what the customer has now and sets the account from it. Returns the new state, or null when Stripe could not be asked. */
async function refreshFromStripe(row: AccountRow): Promise<{ subscribed: boolean; ends: number | null } | null> {
  const settings = stripeSettings();
  if (!settings || !row.stripe_customer_id) return null;
  const tried = staleTried.get(row.id) || 0;
  if (Date.now() - tried < RETRY_STALE_AFTER_MS) return null;
  staleTried.set(row.id, Date.now());
  try {
    const list = await stripeCall(settings, "GET", "/v1/subscriptions", { customer: row.stripe_customer_id, status: "all", limit: 10 });
    const found: any[] = Array.isArray(list?.data) ? list.data : [];
    const states = found.map(subscriptionToAccountState);
    const best = states.find((state) => state.subscribed) || states[0];
    const subscribed = !!best?.subscribed;
    const ends = best?.endsMs ?? null;
    await applyToAccount(row.id, subscribed, ends, null);
    return { subscribed, ends: ends ?? (row.subscription_ends === null ? null : Number(row.subscription_ends)) };
  } catch (error: any) {
    log.warn(`Could not refresh a subscription from Stripe: ${error?.message || "unknown error"}`);
    return null;
  }
}

async function loginIsLocked(): Promise<boolean> {
  const status = await query<{ enabled: number }>("SELECT enabled FROM subscription_status WHERE id = 1");
  if (Number(status[0]?.enabled) !== 1) return false;
  const lock = await query<{ name: string }>("SELECT name FROM subscription_locks WHERE name = 'login'");
  return lock.length > 0;
}

export type SubscriptionInfo = {
  enabled: boolean;
  subscribed: boolean;
  /** End of the paid period, milliseconds. */
  ends: number | null;
  /** True when this account would be refused at login: not subscribed, not an admin, and the Log In lock is on. */
  loginLocked: boolean;
  guest: boolean;
};

const OFF: SubscriptionInfo = { enabled: false, subscribed: false, ends: null, loginLocked: false, guest: false };

/**
 * What the account page and the login pre-check need. An admin is role 1 (the same column the engine reads
 * for isAdmin); a guest counts as not subscribed, as in the engine. Corrects a stale flag on the way.
 */
export async function getSubscriptionInfo(username: string): Promise<SubscriptionInfo> {
  if (!ready || !stripeSettings()) return OFF;
  try {
    const row = await loadAccount(username);
    if (!row) return OFF;
    const guest = isGuest(username, row);
    let subscribed = Number(row.subscribed) === 1;
    let ends = row.subscription_ends === null || row.subscription_ends === undefined ? null : Number(row.subscription_ends);
    if (subscribed && !guest && ends !== null && ends < Date.now() - STALE_AFTER_MS) {
      const fixed = await refreshFromStripe(row);
      if (fixed) {
        subscribed = fixed.subscribed;
        ends = fixed.ends;
      }
    }
    const loginLocked = Number(row.role) !== 1 && (guest || !subscribed) && (await loginIsLocked());
    return { enabled: true, subscribed, ends, loginLocked, guest };
  } catch (error: any) {
    log.warn(`Could not read a subscription: ${error?.message || "unknown error"}`);
    return OFF;
  }
}

// ----------------------------------------------------------------- routes

export type Reply = { status: number; body: Record<string, unknown> };

const NEEDS_ACCOUNT: Reply = { status: 403, body: { message: "Create an account to subscribe." } };
const UNAVAILABLE: Reply = { status: 400, body: { message: "Subscriptions are not available." } };

/** Starts a Stripe Checkout for the account. */
export async function createCheckout(username: string): Promise<Reply> {
  const settings = stripeSettings();
  if (!ready || !settings) return UNAVAILABLE;
  const base = siteUrl();
  if (!base) return UNAVAILABLE;
  try {
    const row = await loadAccount(username);
    if (!row) return { status: 404, body: { message: "Account not found." } };
    if (isGuest(username, row)) return NEEDS_ACCOUNT;
    if (Number(row.subscribed) === 1) return { status: 400, body: { message: "You are already subscribed." } };

    const params: Record<string, string | number> = {
      mode: "subscription",
      "line_items[0][price]": settings.priceId,
      "line_items[0][quantity]": 1,
      client_reference_id: String(row.id),
      "subscription_data[metadata][account_id]": String(row.id),
      success_url: `${base}/manage-profile?subscription=success`,
      cancel_url: `${base}/manage-profile?subscription=cancel`,
    };
    if (row.stripe_customer_id) params.customer = row.stripe_customer_id;
    const session = await stripeCall(settings, "POST", "/v1/checkout/sessions", params);
    if (typeof session?.url !== "string" || !session.url.startsWith("https://")) throw new StripeError(502, "Stripe POST /v1/checkout/sessions gave no address");
    return { status: 200, body: { url: session.url } };
  } catch (error: any) {
    log.warn(`Could not start a checkout: ${error?.message || "unknown error"}`);
    return { status: 502, body: { message: "Could not reach the payment page." } };
  }
}

/** Opens the Stripe billing portal for the account's customer. */
export async function createPortal(username: string): Promise<Reply> {
  const settings = stripeSettings();
  if (!ready || !settings) return UNAVAILABLE;
  const base = siteUrl();
  if (!base) return UNAVAILABLE;
  try {
    const row = await loadAccount(username);
    if (!row) return { status: 404, body: { message: "Account not found." } };
    if (isGuest(username, row)) return NEEDS_ACCOUNT;
    if (!row.stripe_customer_id) return { status: 400, body: { message: "There is no subscription to manage." } };

    const session = await stripeCall(settings, "POST", "/v1/billing_portal/sessions", {
      customer: row.stripe_customer_id,
      return_url: `${base}/manage-profile`,
    });
    if (typeof session?.url !== "string" || !session.url.startsWith("https://")) throw new StripeError(502, "Stripe POST /v1/billing_portal/sessions gave no address");
    return { status: 200, body: { url: session.url } };
  } catch (error: any) {
    log.warn(`Could not open the billing portal: ${error?.message || "unknown error"}`);
    return { status: 502, body: { message: "Could not reach the billing page." } };
  }
}

// ---------------------------------------------------------------- webhook

const WEBHOOK_MAX_BODY = 1024 * 1024;
const OK: Reply = { status: 200, body: { received: true } };

function idOf(value: any): string {
  return typeof value === "string" ? value : typeof value?.id === "string" ? value.id : "";
}

/**
 * The webhook. `raw` is the exact request body (read once, as text): the signature covers those bytes.
 * Every subscription event re-reads the subscription from Stripe and sets the account from it, so the
 * order of events and repeats do not matter. Unknown event types answer 200.
 */
export async function processStripeWebhook(raw: string, signature: string | null): Promise<Reply> {
  const settings = stripeSettings();
  if (!ready || !settings) return { status: 404, body: { message: "Not found" } };
  if (raw.length > WEBHOOK_MAX_BODY) return { status: 413, body: { message: "Too large" } };

  const checked = verifyStripeSignature(raw, signature, settings.webhookSecret);
  if (!checked.ok) {
    log.warn(`A Stripe webhook was refused (${checked.reason})`);
    return { status: 400, body: { message: "Invalid signature" } };
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { message: "Invalid body" } };
  }
  const type = typeof event?.type === "string" ? event.type : "";
  const object = event?.data?.object;

  try {
    if (type === "checkout.session.completed") {
      if (object?.mode !== "subscription") return OK;
      const subscription = await fetchSubscription(settings, idOf(object.subscription));
      if (!subscription) return OK;
      const state = subscriptionToAccountState(subscription);
      const reference = String(object.client_reference_id ?? "");
      const accountId = /^\d{1,12}$/.test(reference) ? reference : state.accountId;
      if (!accountId) {
        log.warn("A completed checkout carried no account");
        return OK;
      }
      await applyToAccount(accountId, state.subscribed, state.endsMs, idOf(object.customer) || state.customerId);
      return OK;
    }

    if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const subscription = (await fetchSubscription(settings, idOf(object))) || object;
      const state = subscriptionToAccountState(subscription);
      let accountId = state.accountId;
      if (!accountId && state.customerId) {
        const rows = await query<{ id: number }>("SELECT id FROM accounts WHERE stripe_customer_id = ?", [state.customerId]);
        if (rows[0]) accountId = String(rows[0].id);
      }
      if (!accountId) {
        log.warn("A subscription event matched no account");
        return OK;
      }
      await applyToAccount(accountId, state.subscribed, state.endsMs, state.customerId);
      return OK;
    }
  } catch (error: any) {
    // Stripe sends the event again when it is answered with an error.
    log.error(`A Stripe webhook could not be handled: ${error?.message || "unknown error"}`);
    return { status: 500, body: { message: "Try again" } };
  }

  return OK;
}
