// js/supabaseClient.js
// Loaded after the Supabase UMD script and config.js.
const { createClient } = supabase;

window.sb = createClient(
  window.KIDEONI_CONFIG.SUPABASE_URL,
  window.KIDEONI_CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

// Small helper: call one of our Edge Functions with the user's current
// access token attached, so the function can verify who's asking.
window.callFunction = async function callFunction(name, body = {}) {
  const { data: sessionData } = await window.sb.auth.getSession();
  const token = sessionData?.session?.access_token || window.KIDEONI_CONFIG.SUPABASE_ANON_KEY;

  const res = await fetch(`${window.KIDEONI_CONFIG.FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: window.KIDEONI_CONFIG.SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${name} failed`);
  return data;
};
