# KIDEONI MOVIES

A full streaming web application: Supabase auth + database, protected movie/reel
playback, PayIn subscription payments, real email verification, and an admin
console with per-title view analytics.

**Stack:** static HTML/CSS/JS front end (GitHub Pages-ready) · Supabase
(Postgres, Auth, Storage, Edge Functions) · PayIn for payments.

```
├── index.html, browse.html, watch.html, reels.html, pricing.html
├── login.html, signup.html, verify.html, account.html
├── admin/            → admin console (dashboard, content, analytics, plans)
├── css/               → styles.css (brand system), admin.css
├── js/                → all front-end logic (no secrets — see below)
└── supabase/
    ├── schema.sql      → run once in the Supabase SQL editor
    └── functions/      → Edge Functions (Deno) — this is where secrets live
```

## 1. Why this is secure by design

- **No secret ever ships to the browser.** `js/config.js` only contains the
  Supabase **URL** and **anon key**, which are meant to be public — every
  table they can touch is locked down by Row Level Security (RLS) policies
  in `schema.sql`. The PayIn secret key, PayIn webhook secret, and the
  Supabase **service role** key live only in Edge Function environment
  variables (`supabase secrets set ...`), never in a file that gets committed
  or served.
- **Protected playback.** Movie/reel files sit in a **private** Storage
  bucket (`videos`). The browser never learns the storage path or a public
  URL. Instead, `get-video-url` (an Edge Function) checks the user's
  subscription server-side and mints a **signed URL that expires in ~6
  minutes** — long enough to start playback, useless as a link to share or
  re-download later. The `<video>` tag also disables the native download
  button and right-click save. (No web player can make video 100%
  uncopyable — this is standard, reasonable protection, not DRM.)
- **Tamper-proof view analytics.** `content_views` has **no INSERT policy
  for regular users** — the only way a row gets written is through the
  `track-view` Edge Function using the service role key. A user opening
  devtools and POSTing to PostgREST directly cannot forge views.
- **Payments never trusted from the client.** `create-payment` starts the
  PayIn transaction server-side; the subscription is only ever marked
  `active` by `payin-webhook`, after verifying an HMAC signature with a
  secret PayIn gives you. The browser can't mark itself "paid."

## 2. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste and run the entire contents of
   `supabase/schema.sql`. This creates every table, RLS policy, the
   `profiles` auto-creation trigger, analytics views, and the `videos` /
   `images` storage buckets.
3. **Authentication → Providers → Email**: turn **Confirm email** ON. This
   is what makes `signup.html` → `verify.html` send a *real* confirmation
   email — no custom email code needed.
4. **Authentication → URL Configuration**: add your deployed site URL (e.g.
   `https://yourname.github.io/kideoni/`) to *Site URL* and *Redirect URLs*
   so the confirmation link lands back on `verify.html` correctly.
5. Promote your own account to admin once you've signed up:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```

## 3. Deploy the Edge Functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then:

```bash
supabase login
supabase link --project-ref axsjakqscudnbxjnfkrw

# Secrets — set these once, they never touch the front end
supabase secrets set \
  PAYIN_SECRET_KEY=sk_live_xxx \
  PAYIN_WEBHOOK_SECRET=whsec_xxx \
  PAYIN_API_BASE=https://api.payin.example/v1 \
  ALLOWED_ORIGINS=https://yourname.github.io

supabase functions deploy get-video-url
supabase functions deploy track-view
supabase functions deploy create-payment
supabase functions deploy payin-webhook
supabase functions deploy admin-stats
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically by Supabase for every Edge Function — you don't set
those yourself.

In your **PayIn dashboard**, set the webhook/callback URL to:
```
https://axsjakqscudnbxjnfkrw.supabase.co/functions/v1/payin-webhook
```

## 4. Front end is already configured

`js/config.js` is already pointed at your live project:

```js
window.KIDEONI_CONFIG = {
  SUPABASE_URL: "https://axsjakqscudnbxjnfkrw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ZNo0FFbls9qhqLz5Q1AqeQ_SNWNTRo6",
  FUNCTIONS_URL: "https://axsjakqscudnbxjnfkrw.supabase.co/functions/v1",
  BRAND_NAME: "KIDEONI MOVIES",
};
```

This key is a Supabase **publishable** key — it's designed to be public in
client code, the same as the legacy "anon" key. It identifies your project;
it doesn't grant access on its own. Every table it touches is still locked
down by the RLS policies in `schema.sql`. You only need to touch this file
again if you ever rotate the key or move to a different Supabase project.

## 5. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "KIDEONI MOVIES"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/kideoni.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Source: Deploy from branch → main /
(root)**. Your site will be live at
`https://YOUR-USERNAME.github.io/kideoni/`.

Update `ALLOWED_ORIGINS` in your Supabase secrets and the Supabase
**Redirect URLs** to match that exact URL once you know it.

## 6. Add content

Sign in as your admin account → **Admin → Movies & Reels** → *Add movie* /
*Add reel*. Upload a video file (goes straight into the private `videos`
bucket under your admin session) and either paste poster/backdrop image
URLs or upload images to any image host and paste the link — `images` is a
public bucket if you'd rather host them in Supabase too.

Plans are fully editable under **Admin → Plans** — price, currency,
duration, and feature bullets — no code changes needed to launch a new
tier or promo.

## 7. Brand system

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0A0A0B` | Page background |
| `--paper` | `#FFFFFF` | Primary text |
| `--orange` | `#F25A24` | CTAs, active states, brand accent |
| `--orange-hot` | `#FF7440` | Hover/links |

Defined once in `css/styles.css` as CSS variables — change them there to
re-theme the whole app.

## 8. What's intentionally out of scope here

- A production PayIn integration's exact request/response shape varies by
  provider — `create-payment`/`payin-webhook` are written against a
  representative REST + HMAC-signed-webhook pattern; adjust the field names
  once you have PayIn's real API docs in hand.
- Video transcoding/adaptive bitrate (HLS) isn't included; the player
  expects a direct MP4-compatible file per title. For large-scale video
  delivery, consider transcoding on upload and serving HLS manifests
  through the same signed-URL pattern.
