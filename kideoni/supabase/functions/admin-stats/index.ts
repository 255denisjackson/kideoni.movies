// supabase/functions/admin-stats/index.ts
//
// Returns dashboard aggregates for the admin analytics screen. Requires the
// caller's profile.role = 'admin' (checked server-side against the DB, not
// trusted from the client). Uses the service role key to read across all
// users' data — this key never leaves this function.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonResponse({ error: "Sign in required" }, 401, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return jsonResponse({ error: "Forbidden" }, 403, origin);

    const [{ count: totalUsers }, { count: activeSubs }, { data: revenueRows }, movieStats, reelStats, recentViews] =
      await Promise.all([
        admin.from("profiles").select("*", { count: "exact", head: true }),
        admin.from("subscriptions").select("*", { count: "exact", head: true }).eq("status", "active"),
        admin.from("payments").select("amount, currency, created_at").eq("status", "success"),
        admin.from("v_movie_analytics").select("*").order("total_views", { ascending: false }).limit(10),
        admin.from("v_reel_analytics").select("*").order("total_views", { ascending: false }).limit(10),
        admin
          .from("content_views")
          .select("content_type, content_id, started_at")
          .order("started_at", { ascending: false })
          .limit(20),
      ]);

    const totalRevenue = (revenueRows ?? []).reduce((sum, r: any) => sum + Number(r.amount), 0);
    const revenueLast30d = (revenueRows ?? [])
      .filter((r: any) => new Date(r.created_at) > new Date(Date.now() - 30 * 86400000))
      .reduce((sum, r: any) => sum + Number(r.amount), 0);

    return jsonResponse(
      {
        total_users: totalUsers ?? 0,
        active_subscriptions: activeSubs ?? 0,
        total_revenue: totalRevenue,
        revenue_last_30d: revenueLast30d,
        top_movies: movieStats.data ?? [],
        top_reels: reelStats.data ?? [],
        recent_views: recentViews.data ?? [],
      },
      200,
      origin
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: "Unexpected error" }, 500, origin);
  }
});
