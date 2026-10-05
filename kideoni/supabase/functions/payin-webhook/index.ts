// supabase/functions/payin-webhook/index.ts
//
// Receives asynchronous payment status callbacks from PayIn. This is the
// ONLY place a subscription is ever marked 'active' from a real payment —
// the browser can never do this directly (no client-side table writes are
// permitted by RLS). The request signature is verified with
// PAYIN_WEBHOOK_SECRET (server-side only) before anything is trusted.
//
// Configure this URL in the PayIn dashboard as your webhook/callback URL:
//   https://<project-ref>.supabase.co/functions/v1/payin-webhook

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYIN_WEBHOOK_SECRET = Deno.env.get("PAYIN_WEBHOOK_SECRET")!;

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYIN_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computed = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish compare
  if (computed.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const rawBody = await req.text();
  const signature = req.headers.get("x-payin-signature");

  const valid = await verifySignature(rawBody, signature);
  if (!valid) {
    console.warn("Rejected PayIn webhook: bad signature");
    return jsonResponse({ error: "Invalid signature" }, 401, origin);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, origin);
  }

  const { reference, transaction_id, status, metadata } = payload;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: subscription } = await admin
    .from("subscriptions")
    .select("*, plans:plan_id(duration_days)")
    .eq("payin_reference", reference ?? metadata?.reference ?? "")
    .maybeSingle();

  if (!subscription) {
    console.warn("Webhook for unknown reference:", reference);
    return jsonResponse({ received: true }, 200, origin); // ack anyway, nothing to do
  }

  await admin
    .from("payments")
    .update({
      status: status === "success" ? "success" : status === "failed" ? "failed" : "pending",
      payin_transaction_id: transaction_id ?? null,
      raw_payload: payload,
    })
    .eq("subscription_id", subscription.id);

  if (status === "success") {
    const durationDays = (subscription as any).plans?.duration_days ?? 30;
    const expires = new Date();
    expires.setDate(expires.getDate() + durationDays);

    await admin
      .from("subscriptions")
      .update({ status: "active", started_at: new Date().toISOString(), expires_at: expires.toISOString() })
      .eq("id", subscription.id);

    await admin
      .from("profiles")
      .update({
        plan_id: subscription.plan_id,
        subscription_status: "active",
        subscription_expires_at: expires.toISOString(),
      })
      .eq("id", subscription.user_id);
  } else if (status === "failed") {
    await admin.from("subscriptions").update({ status: "failed" }).eq("id", subscription.id);
  }

  return jsonResponse({ received: true }, 200, origin);
});
