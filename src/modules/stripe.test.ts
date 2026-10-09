import { expect, test } from "bun:test";
import crypto from "crypto";
import { subscriptionToAccountState, verifyStripeSignature } from "./stripe";

const SECRET = "whsec_test_secret";
const BODY = '{"id":"evt_1","type":"customer.subscription.updated"}';
const NOW = 1_800_000_000_000;

function sign(raw: string, seconds: number, secret = SECRET): string {
  const v1 = crypto.createHmac("sha256", secret).update(`${seconds}.${raw}`).digest("hex");
  return `t=${seconds},v1=${v1}`;
}

test("a correctly signed, recent body passes", () => {
  const header = sign(BODY, NOW / 1000 - 30);
  expect(verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true });
});

test("a changed body or a wrong secret is refused", () => {
  const header = sign(BODY, NOW / 1000);
  expect(verifyStripeSignature(BODY + " ", header, SECRET, NOW)).toEqual({ ok: false, reason: "mismatch" });
  expect(verifyStripeSignature(BODY, sign(BODY, NOW / 1000, "whsec_other"), SECRET, NOW)).toEqual({ ok: false, reason: "mismatch" });
  expect(verifyStripeSignature(BODY, "garbage", SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
  expect(verifyStripeSignature(BODY, null, SECRET, NOW)).toEqual({ ok: false, reason: "missing" });
});

test("a signature older than 5 minutes is refused, one just inside passes", () => {
  expect(verifyStripeSignature(BODY, sign(BODY, NOW / 1000 - 301), SECRET, NOW)).toEqual({ ok: false, reason: "stale" });
  expect(verifyStripeSignature(BODY, sign(BODY, NOW / 1000 - 299), SECRET, NOW)).toEqual({ ok: true });
});

test("an active subscription maps to subscribed, with the period end in milliseconds", () => {
  const state = subscriptionToAccountState({ status: "active", customer: "cus_1", current_period_end: 1_800_000_500, metadata: { account_id: "42" } });
  expect(state).toEqual({ accountId: "42", customerId: "cus_1", subscribed: true, endsMs: 1_800_000_500_000 });
});

test("a canceled subscription maps to not subscribed and keeps its end", () => {
  const state = subscriptionToAccountState({ status: "canceled", customer: { id: "cus_2" }, items: { data: [{ current_period_end: 1_700_000_000 }] }, metadata: {} });
  expect(state).toEqual({ accountId: null, customerId: "cus_2", subscribed: false, endsMs: 1_700_000_000_000 });
});

test("past_due and trialing still count as subscribed, incomplete does not", () => {
  expect(subscriptionToAccountState({ status: "past_due", customer: "c" }).subscribed).toBe(true);
  expect(subscriptionToAccountState({ status: "trialing", customer: "c" }).subscribed).toBe(true);
  expect(subscriptionToAccountState({ status: "incomplete", customer: "c" }).subscribed).toBe(false);
});
