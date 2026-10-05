// js/config.js
//
// PUBLIC configuration only. The Supabase "anon" key below is designed to
// be public — it identifies your project, it does not grant access; every
// table it touches is protected by the Row Level Security policies in
// supabase/schema.sql. Nothing secret (service role key, PayIn secret key,
// webhook secret) ever belongs in this file or anywhere in /js or /css.
window.KIDEONI_CONFIG = {
  SUPABASE_URL: "https://axsjakqscudnbxjnfkrw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ZNo0FFbls9qhqLz5Q1AqeQ_SNWNTRo6",

  // Base URL for your deployed Edge Functions (same project ref as above)
  FUNCTIONS_URL: "https://axsjakqscudnbxjnfkrw.supabase.co/functions/v1",

  BRAND_NAME: "KIDEONI MOVIES",
};
