// Shared CORS headers for all Edge Functions.
// Lock ALLOWED_ORIGIN down to your real GitHub Pages / custom domain in
// production (comma-separated list supported below).
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((o) => o.trim());

export function corsHeaders(origin: string | null) {
  const allowOrigin =
    ALLOWED_ORIGINS.includes("*")
      ? "*"
      : origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

export function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}
