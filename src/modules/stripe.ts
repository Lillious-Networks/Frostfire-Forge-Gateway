// The parts of the Stripe subscription feature that can be checked without a database, a network or a
// server: reading the three settings, checking a webhook signature, turning a Stripe subscription
// object into the state kept on an account, and form-encoding a request body. Nothing runs when this
// file is imported. The routes and the calls to Stripe are in systems/subscription.ts.
import crypto from "crypto";

export type StripeSettings = { secretKey: string; webhookSecret: string; priceId: string };

/** The three settings, or null when any of them is missing. Read each time, so a change of env shows without a restart. */
export function stripeSettings(env: Record<string, string | undefined> = process.env): StripeSettings | null {
  const secretKey = (env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || "").trim();
  const priceId = (env.STRIPE_PRICE_ID || "").trim();
  if (!secretKey || !webhookSecret || !priceId) return null;
  return { secretKey, webhookSecret, priceId };
}

/** A webhook older (or further ahead) than this, in seconds, is refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * Checks a `Stripe-Signature` header against the exact raw request body: `t=<seconds>` and one or more
 * `v1=<hex>`, where v1 is the HMAC-SHA256 of `${t}.${raw}` with the webhook secret. The compare takes the
 * same time wherever the strings differ.
 */
export function verifyStripeSignature(raw: string, header: string | null | undefined, secret: string, nowMs: number = Date.now()): SignatureResult {
  if (!header || !secret) return { ok: false, reason: "missing" };

  let timestamp = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return { ok: false, reason: "malformed" };

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  let matched = false;
  for (const candidate of candidates) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) continue;
    if (crypto.timingSafeEqual(expected, Buffer.from(candidate, "hex"))) matched = true;
  }
  if (!matched) return { ok: false, reason: "mismatch" };

  // Only a correctly signed time is worth judging.
  if (Math.abs(nowMs - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_SECONDS * 1000) return { ok: false, reason: "stale" };
  return { ok: true };
}

/** The statuses that count as subscribed: a payment that failed keeps access while Stripe retries it. */
export const SUBSCRIBED_STATUSES = ["active", "trialing", "past_due"];

export type AccountSubscription = {
  /** The account id carried in the subscription's metadata, when the checkout set it. */
  accountId: string | null;
  customerId: string | null;
  subscribed: boolean;
  /** End of the paid period, milliseconds, or null when Stripe gave none. */
  endsMs: number | null;
};

/** Turns a Stripe subscription object into what the account keeps. */
export function subscriptionToAccountState(subscription: any): AccountSubscription {
  const status = typeof subscription?.status === "string" ? subscription.status : "";
  // Newer Stripe API versions keep the period on the items, older ones on the subscription.
  const periodEnd = Number(subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end);
  const customer = subscription?.customer;
  const customerId = typeof customer === "string" ? customer : typeof customer?.id === "string" ? customer.id : null;
  const metadataId = subscription?.metadata?.account_id;
  return {
    accountId: metadataId !== undefined && metadataId !== null && /^\d{1,12}$/.test(String(metadataId)) ? String(metadataId) : null,
    customerId,
    subscribed: SUBSCRIBED_STATUSES.includes(status),
    endsMs: Number.isFinite(periodEnd) && periodEnd > 0 ? Math.round(periodEnd * 1000) : null,
  };
}

/** The form-encoded body Stripe takes: keys such as `line_items[0][price]` are written as they are, the encoding is done here. */
export function encodeForm(params: Record<string, string | number>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) form.append(key, String(value));
  return form.toString();
}
