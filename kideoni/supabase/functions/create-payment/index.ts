// supabase/functions/create-payment/index.ts
//
// Starts a subscription purchase: creates a 'pending' subscription +
// payment row, then asks PayIn to open a checkout/collection request.
// The PAYIN_SECRET_KEY never touches the browser — it's read from this
// function's environment only (`supabase secrets set PAYIN_SECRET_KEY=...`).
//
// Client flow:
//   1. User picks a plan on pricing.html and enters their phone/email.
//   2. Front end calls this function with { plan_id, phone }.
//   3. This function creates records, calls PayIn's API, and returns
//      whatever the client needs to complete payment (checkout_url or
//      a "check your phone" prompt for mobile money push).
//   4. PayIn later calls payin-webhook with the final status.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYIN_SECRET_KEY = Deno.env.get("PAYIN_SECRET_KEY")!;
const PAYIN_API_BASE = Deno.env.get("PAYIN_API_BASE") ?? "https://api.payin.example/v1";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  try {
    const { plan_id, phone } = await req.json();
    if (!plan_id) return jsonResponse({ error: "plan_id is required" }, 400, origin);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonResponse({ error: "Sign in required" }, 401, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: plan, error: planErr } = await admin
      .from("plans")
      .select("*")
      .eq("id", plan_id)
      .eq("is_active", true)
      .single();
    if (planErr || !plan) return jsonResponse({ error: "Plan not found" }, 404, origin);

    const reference = `KID-${user.id.slice(0, 8)}-${Date.now()}`;

    const { data: subscription, error: subErr } = await admin
      .from("subscriptions")
      .insert({
        user_id: user.id,
        plan_id: plan.id,
        status: "pending",
        amount: plan.price,
        currency: plan.currency,
        payin_reference: reference,
      })
      .select()
      .single();
    if (subErr) throw subErr;

    await admin.from("payments").insert({
      subscription_id: subscription.id,
      user_id: user.id,
      amount: plan.price,
      currency: plan.currency,
      status: "pending",
      method: "payin",
    });

    // Free plan: activate immediately, skip PayIn entirely
    if (Number(plan.price) === 0) {
      await activateSubscription(admin, subscription.id);
      return jsonResponse({ free: true, activated: true }, 200, origin);
    }

    // --- Call PayIn to start collection -------------------------------------
    const payinRes = await fetch(`${PAYIN_API_BASE}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PAYIN_SECRET_KEY}`,
      },
      body: JSON.stringify({
        amount: plan.price,
        currency: plan.currency,
        reference,
        phone: phone ?? null,
        description: `KIDEONI MOVIES — ${plan.name}`,
        callback_url: `${SUPABASE_URL}/functions/v1/payin-webhook`,
        metadata: { user_id: user.id, subscription_id: subscription.id, plan_id: plan.id },
      }),
    });

    const payinData = await payinRes.json();
    if (!payinRes.ok) {
      await admin.from("subscriptions").update({ status: "failed" }).eq("id", subscription.id);
      return jsonResponse({ error: payinData?.message ?? "Payment provider error" }, 502, origin);
    }

    await admin
      .from("payments")
      .update({ payin_transaction_id: payinData.transaction_id ?? payinData.id ?? null })
      .eq("subscription_id", subscription.id);

    return jsonResponse(
      {
        reference,
        subscription_id: subscription.id,
        checkout_url: payinData.checkout_url ?? null,
        instructions: payinData.instructions ?? "Approve the payment prompt on your phone to continue.",
      },
      200,
      origin
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: "Unexpected error" }, 500, origin);
  }
});

async function activateSubscription(admin: ReturnType<typeof createClient>, subscriptionId: string) {
  const { data: sub } = await admin.from("subscriptions").select("*, plans:plan_id(duration_days)").eq("id", subscriptionId).single();
  if (!sub) return;
  const expires = new Date();
  expires.setDate(expires.getDate() + ((sub as any).plans?.duration_days ?? 30));

  await admin
    .from("subscriptions")
    .update({ status: "active", started_at: new Date().toISOString(), expires_at: expires.toISOString() })
    .eq("id", subscriptionId);

  await admin
    .from("profiles")
    .update({ plan_id: sub.plan_id, subscription_status: "active", subscription_expires_at: expires.toISOString() })
    .eq("id", sub.user_id);
}
