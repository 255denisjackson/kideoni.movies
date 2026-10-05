// supabase/functions/get-video-url/index.ts
//
// Mints a short-lived SIGNED URL for a movie or reel stored in the private
// "videos" storage bucket. This is the ONLY way the front end ever gets a
// playable video URL — the raw storage path is never exposed, and the
// SUPABASE_SERVICE_ROLE_KEY used to sign it lives only in this function's
// environment (set via `supabase secrets set`), never in client code.
//
// Entitlement rules enforced server-side:
//   - reels are always free
//   - movies flagged is_free are free
//   - anything else requires the caller's profile.subscription_status
//     to be 'active' and not expired
//
// Deploy:  supabase functions deploy get-video-url --no-verify-jwt=false

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SIGNED_URL_TTL_SECONDS = 60 * 6; // 6 minutes — long enough to start playback

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  try {
    const { content_type, content_id } = await req.json();
    if (!content_type || !content_id || !["movie", "reel"].includes(content_type)) {
      return jsonResponse({ error: "content_type and content_id are required" }, 400, origin);
    }

    // Client passes the user's own access token; we verify it, we don't trust claims.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. Look up the content row (service role bypasses RLS safely, server-side only)
    const table = content_type === "movie" ? "movies" : "reels";
    const { data: content, error: contentErr } = await admin
      .from(table)
      .select("id, storage_path, is_published" + (content_type === "movie" ? ", is_free" : ""))
      .eq("id", content_id)
      .single();

    if (contentErr || !content || !content.is_published) {
      return jsonResponse({ error: "Content not found" }, 404, origin);
    }

    // 2. Entitlement check
    const isFree = content_type === "reel" || (content as any).is_free === true;

    if (!isFree) {
      if (!user) return jsonResponse({ error: "Sign in required" }, 401, origin);

      const { data: profile } = await admin
        .from("profiles")
        .select("subscription_status, subscription_expires_at")
        .eq("id", user.id)
        .single();

      const active =
        profile?.subscription_status === "active" &&
        (!profile.subscription_expires_at || new Date(profile.subscription_expires_at) > new Date());

      if (!active) {
        return jsonResponse({ error: "An active subscription is required to watch this title." }, 403, origin);
      }
    }

    // 3. Mint the signed URL (private bucket, short TTL — cannot be reused indefinitely
    //    or handed out as a permanent download link)
    const { data: signed, error: signErr } = await admin.storage
      .from("videos")
      .createSignedUrl(content.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed) {
      return jsonResponse({ error: "Could not prepare video" }, 500, origin);
    }

    return jsonResponse(
      { url: signed.signedUrl, expires_in: SIGNED_URL_TTL_SECONDS },
      200,
      origin
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: "Unexpected error" }, 500, origin);
  }
});
