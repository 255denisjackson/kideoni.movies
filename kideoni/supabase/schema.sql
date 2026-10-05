-- ============================================================================
-- KIDEONI MOVIES — Supabase Database Schema
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query)
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- ============================================================================

-- Extensions --------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. PROFILES  (mirrors auth.users, adds app-specific fields)
-- ============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user','admin')),
  plan_id uuid references public.plans(id),
  subscription_status text not null default 'inactive'
    check (subscription_status in ('inactive','active','expired','canceled')),
  subscription_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- NOTE: plans table is created below; add the FK after plans exists.

-- ============================================================================
-- 2. PLANS  (subscription tiers — fully editable by admins, no code changes)
-- ============================================================================
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  price numeric(10,2) not null default 0,
  currency text not null default 'TZS',
  duration_days int not null default 30,
  features jsonb not null default '[]'::jsonb,
  max_quality text default '1080p',
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add constraint profiles_plan_id_fkey foreign key (plan_id)
  references public.plans(id) on delete set null;

-- ============================================================================
-- 3. MOVIES
-- ============================================================================
create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  synopsis text,
  poster_url text,
  backdrop_url text,
  trailer_url text,
  -- storage_path points at a PRIVATE bucket object; never expose a public
  -- URL for this. Playback only happens via a short-lived signed URL minted
  -- by the get-video-url Edge Function after entitlement checks.
  storage_path text,
  duration_seconds int,
  release_year int,
  genres text[] default '{}',
  cast_list text[] default '{}',
  rating text,
  is_free boolean not null default false,
  is_published boolean not null default false,
  is_featured boolean not null default false,
  view_count bigint not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_movies_published on public.movies(is_published);
create index if not exists idx_movies_genres on public.movies using gin(genres);

-- ============================================================================
-- 4. REELS  (short-form, always free)
-- ============================================================================
create table if not exists public.reels (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  caption text,
  storage_path text not null,       -- private bucket; served via signed URL
  thumbnail_url text,
  related_movie_id uuid references public.movies(id) on delete set null,
  duration_seconds int,
  is_published boolean not null default true,
  view_count bigint not null default 0,
  like_count bigint not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_reels_published on public.reels(is_published);

-- ============================================================================
-- 5. SUBSCRIPTIONS  (a purchased plan period)
-- ============================================================================
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  status text not null default 'pending'
    check (status in ('pending','active','expired','canceled','failed')),
  amount numeric(10,2) not null,
  currency text not null default 'TZS',
  payin_reference text unique,      -- our own reference sent to PayIn
  started_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_subs_user on public.subscriptions(user_id);

-- ============================================================================
-- 6. PAYMENTS  (raw transaction ledger, one row per PayIn callback)
-- ============================================================================
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.subscriptions(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  payin_transaction_id text unique,
  amount numeric(10,2) not null,
  currency text not null default 'TZS',
  status text not null check (status in ('pending','success','failed','refunded')),
  method text,                       -- e.g. mobile_money, card
  raw_payload jsonb,                 -- full PayIn callback, for audit
  created_at timestamptz not null default now()
);
create index if not exists idx_payments_user on public.payments(user_id);

-- ============================================================================
-- 7. CONTENT VIEWS  (secure, per-user view tracking — analytics core)
-- One row per "watch session". Inserted only by the track-view Edge
-- Function (service role), never directly by the client, so users cannot
-- forge or inflate view counts.
-- ============================================================================
create table if not exists public.content_views (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('movie','reel')),
  content_id uuid not null,
  user_id uuid references public.profiles(id) on delete set null,
  session_id text not null,          -- random id generated client-side per playback
  watch_seconds int not null default 0,
  percent_complete numeric(5,2) not null default 0,
  completed boolean not null default false,
  device text,
  country text,
  referrer text,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now()
);
create index if not exists idx_views_content on public.content_views(content_type, content_id);
create index if not exists idx_views_user on public.content_views(user_id);
create index if not exists idx_views_started on public.content_views(started_at);

-- One logical "view" per session_id (heartbeats update the same row)
create unique index if not exists uq_views_session on public.content_views(content_type, content_id, session_id);

-- ============================================================================
-- 8. HELPER: is_admin()
-- ============================================================================
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ============================================================================
-- 9. HELPER: has_active_subscription()
-- ============================================================================
create or replace function public.has_active_subscription()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and subscription_status = 'active'
      and (subscription_expires_at is null or subscription_expires_at > now())
  );
$$;

-- ============================================================================
-- 10. TRIGGER: auto-create profile row on signup
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 10b. RPC: atomic view-count increment (used by track-view Edge Function)
-- ============================================================================
create or replace function public.increment_view_count(p_table text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_table = 'movies' then
    update public.movies set view_count = view_count + 1 where id = p_id;
  elsif p_table = 'reels' then
    update public.reels set view_count = view_count + 1 where id = p_id;
  end if;
end;
$$;

-- ============================================================================
-- 11. ROW LEVEL SECURITY
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.plans enable row level security;
alter table public.movies enable row level security;
alter table public.reels enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
alter table public.content_views enable row level security;

-- profiles: users see/update their own row; admins see all
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_admin_update_any" on public.profiles
  for update using (public.is_admin());

-- plans: publicly readable when active; only admins write
create policy "plans_public_read" on public.plans
  for select using (is_active = true or public.is_admin());
create policy "plans_admin_write" on public.plans
  for insert with check (public.is_admin());
create policy "plans_admin_update" on public.plans
  for update using (public.is_admin());
create policy "plans_admin_delete" on public.plans
  for delete using (public.is_admin());

-- movies: published rows are public metadata (NOT the video file — storage
-- is locked down separately); admins see/edit everything
create policy "movies_public_read" on public.movies
  for select using (is_published = true or public.is_admin());
create policy "movies_admin_write" on public.movies
  for insert with check (public.is_admin());
create policy "movies_admin_update" on public.movies
  for update using (public.is_admin());
create policy "movies_admin_delete" on public.movies
  for delete using (public.is_admin());

-- reels: same pattern
create policy "reels_public_read" on public.reels
  for select using (is_published = true or public.is_admin());
create policy "reels_admin_write" on public.reels
  for insert with check (public.is_admin());
create policy "reels_admin_update" on public.reels
  for update using (public.is_admin());
create policy "reels_admin_delete" on public.reels
  for delete using (public.is_admin());

-- subscriptions: users see their own; admins see all; writes only via
-- service role (Edge Functions), never directly from the browser
create policy "subs_select_own_or_admin" on public.subscriptions
  for select using (auth.uid() = user_id or public.is_admin());

-- payments: users see their own; admins see all; no client writes
create policy "payments_select_own_or_admin" on public.payments
  for select using (auth.uid() = user_id or public.is_admin());

-- content_views: users can see only their own view history; admins see all.
-- INSERT/UPDATE are intentionally NOT granted to authenticated/anon —
-- all writes happen through the track-view Edge Function using the
-- service role key, so view counts cannot be forged from devtools.
create policy "views_select_own_or_admin" on public.content_views
  for select using (auth.uid() = user_id or public.is_admin());

-- ============================================================================
-- 12. SEED DEFAULT PLANS
-- ============================================================================
insert into public.plans (name, slug, description, price, currency, duration_days, features, sort_order)
values
  ('Free', 'free', 'Reels and a rotating selection of free movies.', 0, 'TZS', 3650,
   '["Unlimited reels","Free movie selection","SD quality","Ads supported"]', 0),
  ('Basic', 'basic', 'Full movie library on one device.', 4900, 'TZS', 30,
   '["Full movie library","HD quality","1 device","No ads"]', 1),
  ('Premium', 'premium', 'Everything, in HD, on up to 4 devices.', 9900, 'TZS', 30,
   '["Full movie library","Full HD quality","4 devices","No ads","Early access"]', 2),
  ('Premium Yearly', 'premium-yearly', 'Premium billed once a year — save two months.', 99000, 'TZS', 365,
   '["Everything in Premium","2 months free","Priority support"]', 3)
on conflict (slug) do nothing;

-- ============================================================================
-- 13. ANALYTICS VIEWS  (read via admin Edge Function / RLS-protected selects)
-- ============================================================================
create or replace view public.v_movie_analytics as
select
  m.id as movie_id,
  m.title,
  count(cv.id) as total_views,
  count(distinct cv.user_id) as unique_viewers,
  coalesce(avg(cv.percent_complete),0) as avg_percent_complete,
  count(*) filter (where cv.completed) as completions,
  count(*) filter (where cv.started_at > now() - interval '7 days') as views_last_7d,
  count(*) filter (where cv.started_at > now() - interval '30 days') as views_last_30d
from public.movies m
left join public.content_views cv on cv.content_type = 'movie' and cv.content_id = m.id
group by m.id, m.title;

create or replace view public.v_reel_analytics as
select
  r.id as reel_id,
  r.title,
  count(cv.id) as total_views,
  count(distinct cv.user_id) as unique_viewers,
  coalesce(avg(cv.percent_complete),0) as avg_percent_complete,
  count(*) filter (where cv.completed) as completions,
  count(*) filter (where cv.started_at > now() - interval '7 days') as views_last_7d
from public.reels r
left join public.content_views cv on cv.content_type = 'reel' and cv.content_id = r.id
group by r.id, r.title;

alter view public.v_movie_analytics owner to postgres;
alter view public.v_reel_analytics owner to postgres;

-- Analytics views inherit RLS from underlying tables' policies only when
-- security_invoker is set; enforce that so a normal user querying the view
-- still only sees what content_views RLS allows.
alter view public.v_movie_analytics set (security_invoker = true);
alter view public.v_reel_analytics set (security_invoker = true);

-- ============================================================================
-- 14. STORAGE BUCKETS
-- Run once — create a PRIVATE bucket for videos and a PUBLIC one for images.
-- (Can also be done from Dashboard → Storage → New bucket.)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('videos', 'videos', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;

-- Only admins (via service role in Edge Functions) can write to videos.
-- No public/anon read policy is created for 'videos' — access is only ever
-- through short-lived signed URLs minted server-side.
create policy "images_public_read" on storage.objects
  for select using (bucket_id = 'images');
create policy "images_admin_write" on storage.objects
  for insert with check (bucket_id = 'images' and public.is_admin());
create policy "images_admin_update" on storage.objects
  for update using (bucket_id = 'images' and public.is_admin());

-- 'videos' bucket is PRIVATE with no public/anon read policy — playback
-- only ever happens through the get-video-url Edge Function's short-lived
-- signed URLs. Admins may upload/manage files directly from the Content
-- Management screen using their own authenticated (admin) session.
create policy "videos_admin_all" on storage.objects
  for all using (bucket_id = 'videos' and public.is_admin())
  with check (bucket_id = 'videos' and public.is_admin());
