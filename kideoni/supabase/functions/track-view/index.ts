// supabase/functions/track-view/index.ts
//
// Records/updates a single watch session in content_views, and bumps the
// denormalized view_count on the movie/reel the first time a session is
// seen. Writes ONLY happen here (service role) — content_views has no
// client-facing insert policy — so a user cannot open devtools and POST
// fake views directly against PostgREST.
//
// Called by the player: once on playback start, then on a heartbeat every
// ~15s, and once on pause/unload with final progress.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  try {
    const body = await req.json();
    const {
      content_type,
      content_id,
      session_id,
      watch_seconds = 0,
      percent_complete = 0,
      completed = false,
      device = null,
    } = body;

    if (!content_type || !content_id || !session_id || !["movie", "reel"].includes(content_type)) {
      return jsonResponse({ error: "Missing/invalid fields" }, 400, origin);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Was this session already recorded? (decides whether to bump view_count)
    const { data: existing } = await admin
      .from("content_views")
      .select("id")
      .eq("content_type", content_type)
      .eq("content_id", content_id)
      .eq("session_id", session_id)
      .maybeSingle();

    const clampedPercent = Math.max(0, Math.min(100, Number(percent_complete) || 0));

    const { error: upsertErr } = await admin.from("content_views").upsert(
      {
        content_type,
        content_id,
        session_id,
        user_id: user?.id ?? null,
        watch_seconds: Math.max(0, Math.floor(Number(watch_seconds) || 0)),
        percent_complete: clampedPercent,
        completed: Boolean(completed) || clampedPercent >= 90,
        device,
        last_heartbeat_at: new Date().toISOString(),
      },
      { onConflict: "content_type,content_id,session_id" }
    );

    if (upsertErr) {
      console.error(upsertErr);
      return jsonResponse({ error: "Could not record view" }, 500, origin);
    }

    // First time we see this session → count it as a new view
    if (!existing) {
      const table = content_type === "movie" ? "movies" : "reels";
      await admin.rpc("increment_view_count", { p_table: table, p_id: content_id }).catch(async () => {
        // Fallback if the RPC helper below isn't installed yet
        const { data: row } = await admin.from(table).select("view_count").eq("id", content_id).single();
        await admin
          .from(table)
          .update({ view_count: (row?.view_count ?? 0) + 1 })
          .eq("id", content_id);
      });
    }

    return jsonResponse({ ok: true, new_view: !existing }, 200, origin);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: "Unexpected error" }, 500, origin);
  }
});
