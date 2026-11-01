-- Guard: this file documents the live database and must never be executed.
-- If pasted into the SQL editor it aborts here and nothing below runs.
do $$ begin
  raise exception 'supabase-schema.sql is a documentation snapshot. Do not run it. Use a migration instead.';
end $$;

-- =============================================================================
-- MomentCast Supabase schema (public + storage policies)
-- Snapshot of the LIVE production database (project ezrrnmlotpmknetvuhdh),
-- regenerated 2026-10-31 from the system catalogs. Documentation of what is
-- deployed, not a migration: running it against production is not needed.
--
-- Secrets are redacted (see the auth.users webhook trigger at the bottom).
-- Regenerate after every migration so this file matches the database.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions (Supabase installs these in the "extensions" schema)
-- -----------------------------------------------------------------------------
-- pg_net 0.19.5, pg_stat_statements 1.11, pgcrypto 1.3, supabase_vault 0.3.1
create extension if not exists "uuid-ossp";


-- -----------------------------------------------------------------------------
-- users  (1:1 with auth.users, created by the on_auth_user_created trigger)
-- -----------------------------------------------------------------------------
create table public.users (
  id                   uuid primary key default uuid_generate_v4()
                       references auth.users (id) on delete cascade,
  email                varchar(255) not null unique,
  stripe_customer_id   varchar(255),
  credits              integer default 0,              -- server-managed (protect_user_money_columns)
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  logo_url             text,                           -- the only column the browser may update
  mailerlite_synced_at timestamptz
);

create index idx_users_email on public.users using btree (email);


-- -----------------------------------------------------------------------------
-- events
-- -----------------------------------------------------------------------------
create table public.events (
  id                          uuid primary key default uuid_generate_v4(),
  user_id                     uuid not null references public.users (id) on delete cascade,
  slug                        varchar(255) not null unique,   -- 'released_<id>' once released
  title                       varchar(255) not null,
  scheduled_date              timestamptz not null,
  live_input_id               varchar(255),
  rtmps_url                   varchar(255),
  rtmps_key                   varchar(255),
  status                      varchar(50) default 'scheduled'
                              check (status in ('scheduled', 'ready', 'live', 'ended', 'cancelled')),
  stream_state                varchar(50) default 'inactive'
                              check (stream_state in ('inactive', 'active', 'paused', 'finalized', 'disconnected')),
  stream_started_at           timestamptz,
  recordings                  jsonb default '[]'::jsonb,
  merged_video_id             varchar(255),
  -- Calculated by Postgres from viewer_minutes_consumed (never written directly).
  -- Physically the last column in the live table; shown here for readability.
  viewer_hours_consumed       numeric generated always as (round(viewer_minutes_consumed / 60, 1)) stored,
  viewer_hour_limit           integer default 15000,         -- MINUTES despite the name
  tier                        varchar(50) default 'standard'
                              check (tier in ('standard', 'premium')),
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now(),
  stream_started_manually_at  timestamptz,
  stream_credentials_revealed boolean default false,
  can_be_rescheduled          boolean default true,
  last_stream_activity        timestamptz,
  qr_code_data_url            text,
  cover_image_url             text,
  timezone                    varchar(50) default 'America/Los_Angeles',
  -- Permanent per-account test event (protect_test_event_columns guards these)
  is_test                     boolean not null default false,
  test_session_armed_at       timestamptz,
  test_session_connected_at   timestamptz,
  test_session_last_ended_at  timestamptz,
  test_sessions_today         integer not null default 0,
  test_sessions_day           date,
  -- Slug release (release_expired_slugs)
  original_slug               varchar(255),
  slug_released_at            timestamptz,
  -- Marketing demo replay: never expires, never released, no viewer limit
  is_demo                     boolean not null default false,
  -- Single source of truth for replay retention. Worker-only; extended, never shortened.
  -- NULL = nothing recorded yet, or a demo event.
  recordings_expire_at        timestamptz,
  -- Set by the flag_retention_sync trigger when recordings change; cleared by the
  -- worker's retention reconcile once Cloudflare matches recordings_expire_at.
  retention_sync_needed       boolean not null default false,
  -- Viewer usage in exact MINUTES, banked by day (worker computeViewerUsage).
  viewer_minutes_consumed       numeric not null default 0,  -- lifetime total, compared to viewer_hour_limit
  viewer_minutes_banked         numeric not null default 0,  -- settled days only
  viewer_minutes_banked_through date                         -- last banked UTC day; NULL = not started
);

create index idx_events_recordings_expire_at  on public.events using btree (recordings_expire_at)
  where recordings_expire_at is not null;
create index idx_events_retention_sync_needed on public.events using btree (updated_at)
  where retention_sync_needed;

create unique index events_one_test_per_user  on public.events using btree (user_id) where is_test;
create index events_test_armed_idx            on public.events using btree (test_session_armed_at)
  where (is_test and test_session_armed_at is not null);
create index idx_events_last_stream_activity  on public.events using btree (last_stream_activity);
create index idx_events_refund_lookup         on public.events using btree (status, stream_credentials_revealed, scheduled_date)
  where ((status)::text = 'scheduled' and stream_credentials_revealed = false);
create index idx_events_scheduled_date        on public.events using btree (scheduled_date);
create index idx_events_slug                  on public.events using btree (slug);
create index idx_events_user_date             on public.events using btree (user_id, scheduled_date desc);
create index idx_events_user_id               on public.events using btree (user_id);
create index idx_events_user_status_date      on public.events using btree (user_id, status, scheduled_date);


-- -----------------------------------------------------------------------------
-- credit_transactions  (kept after account deletion for tax records)
-- -----------------------------------------------------------------------------
create table public.credit_transactions (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references public.users (id) on delete set null,
  amount            integer not null,
  type              varchar(50) not null
                    check (type in ('purchase', 'event_created', 'event_cancelled',
                                    'refund', 'event_topup', 'test_deduction')),
  stripe_payment_id varchar(255),
  event_id          uuid references public.events (id) on delete set null,
  created_at        timestamptz default now(),
  stripe_session_id text                                   -- Stripe webhook idempotency key
);

create index idx_credit_transactions_stripe_session on public.credit_transactions using btree (stripe_session_id)
  where stripe_session_id is not null;
create index idx_credit_transactions_user_id        on public.credit_transactions using btree (user_id);


-- -----------------------------------------------------------------------------
-- Functions
-- EXECUTE is granted only to postgres and service_role (revoked from PUBLIC),
-- so none of these are callable with the anon key.
-- -----------------------------------------------------------------------------
create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email, credits)
  values (new.id, new.email, 0)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Browser roles can never change credits or the Stripe customer id.
create or replace function public.protect_user_money_columns()
returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.credits is distinct from old.credits
       or new.stripe_customer_id is distinct from old.stripe_customer_id then
      raise exception 'credits and stripe_customer_id are managed by the server';
    end if;
  end if;
  return new;
end;
$$;

-- Browser roles can never create or alter test-event state.
create or replace function public.protect_test_event_columns()
returns trigger language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.is_test
         or new.test_session_armed_at is not null
         or new.test_session_connected_at is not null
         or new.test_session_last_ended_at is not null
         or new.test_sessions_today <> 0
         or new.test_sessions_day is not null then
        raise exception 'test event columns are managed by the server';
      end if;
    elsif new.is_test is distinct from old.is_test
       or new.test_session_armed_at is distinct from old.test_session_armed_at
       or new.test_session_connected_at is distinct from old.test_session_connected_at
       or new.test_session_last_ended_at is distinct from old.test_session_last_ended_at
       or new.test_sessions_today is distinct from old.test_sessions_today
       or new.test_sessions_day is distinct from old.test_sessions_day then
      raise exception 'test event columns are managed by the server';
    end if;
  end if;
  return new;
end;
$$;

-- Any change to an event's recordings list flags it for the worker's retention reconcile.
-- Test and demo events keep their own retention rules and are never flagged.
create or replace function public.flag_retention_sync()
returns trigger language plpgsql as $$
begin
  if not new.is_test and not new.is_demo
     and coalesce(jsonb_array_length(new.recordings), 0) > 0
     and (tg_op = 'INSERT' or new.recordings is distinct from old.recordings) then
    new.retention_sync_needed := true;
  end if;
  return new;
end;
$$;

-- Daily cron (worker, 03:00 UTC) with cooldown_days = SLUG_COOLDOWN_DAYS.
create or replace function public.release_expired_slugs(cooldown_days integer)
returns integer language plpgsql as $$
declare
  released_count integer;
begin
  if cooldown_days < 1 then
    raise exception 'cooldown_days must be at least 1';
  end if;

  update public.events
  set original_slug = slug,
      slug = 'released_' || id::text,
      slug_released_at = now()
  where is_test = false
    and is_demo = false  -- demo events keep their slug permanently
    and slug_released_at is null
    -- Countdown starts when the replay expires, so a link never dies while its replay is
    -- watchable. Events that never recorded count from the event date instead.
    and coalesce(recordings_expire_at, stream_started_manually_at, scheduled_date)
        < now() - make_interval(days => cooldown_days);

  get diagnostics released_count = row_count;
  return released_count;
end;
$$;

-- Hourly MailerLite retry cron (worker).
create or replace function public.get_unsynced_mailerlite_users(max_rows integer default 12)
returns table (id uuid, email text, full_name text, email_confirmed_at timestamptz, marketing_opt_in_at text)
language sql security definer set search_path to '' as $$
  select u.id,
         a.email::text,
         coalesce(a.raw_user_meta_data->>'full_name', a.raw_user_meta_data->>'name', ''),
         a.email_confirmed_at,
         a.raw_user_meta_data->>'marketing_opt_in_at'
    from public.users u
    join auth.users a on a.id = u.id
   where a.email_confirmed_at is not null
     and u.mailerlite_synced_at is null
     and a.email_confirmed_at > now() - interval '7 days'
     and a.raw_user_meta_data->>'marketing_opt_in' = 'true'
     and a.raw_user_meta_data->>'marketing_opt_in_at' is not null
   order by a.email_confirmed_at asc
   limit max_rows;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;


-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger update_users_updated_at      before update on public.users
  for each row execute function public.update_updated_at_column();
create trigger protect_user_money_columns   before update on public.users
  for each row execute function public.protect_user_money_columns();

create trigger update_events_updated_at     before update on public.events
  for each row execute function public.update_updated_at_column();
create trigger flag_retention_sync          before insert or update on public.events
  for each row execute function public.flag_retention_sync();
create trigger protect_test_event_columns   before insert or update on public.events
  for each row execute function public.protect_test_event_columns();

create trigger on_auth_user_created         after insert on auth.users
  for each row execute function public.handle_new_user();

-- Supabase Database Webhook (MailerLite signup sync). Managed in the dashboard
-- under Database > Webhooks. The real secret lives there and in the worker's
-- secrets, never in this file.
-- create trigger momentcast_mailerlite_confirmed after insert or update on auth.users
--   for each row execute function supabase_functions.http_request(
--     'https://momentcast-api-production.aaron-alvarez.workers.dev/api/webhooks/supabase-auth',
--     'POST',
--     '{"Content-type":"application/json","x-webhook-secret":"<REDACTED>"}',
--     '{}', '5000');


-- -----------------------------------------------------------------------------
-- Row Level Security
-- The browser is read-only on events and credit_transactions and may update
-- only users.logo_url. Every other write goes through the worker (service_role,
-- which bypasses RLS).
-- -----------------------------------------------------------------------------
alter table public.users               enable row level security;
alter table public.events              enable row level security;
alter table public.credit_transactions enable row level security;

create policy users_select_own on public.users
  for select using (auth.uid() = id);
create policy users_update_own on public.users
  for update using (auth.uid() = id);

create policy events_select_own on public.events
  for select using (auth.uid() = user_id);

create policy credit_transactions_select_own on public.credit_transactions
  for select using (auth.uid() = user_id);

-- Table privileges for browser roles
revoke all on public.events, public.credit_transactions from anon, authenticated;
grant  select on public.events, public.credit_transactions to anon, authenticated;

revoke all on public.users from anon, authenticated;
grant  select on public.users to anon, authenticated;
grant  update (logo_url) on public.users to authenticated;


-- -----------------------------------------------------------------------------
-- Storage (both buckets public-read by URL; writes scoped to the user's folder)
-- -----------------------------------------------------------------------------
-- logos:  public, 100 KB limit, image/jpeg, image/png, image/webp, image/svg, image/svg+xml
-- covers: public, 5 MB limit,   image/jpeg, image/png, image/webp

create policy "Users upload own logo 1peuqw_0" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users update/delete own logo 1peuqw_0" on storage.objects
  for update to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users update/delete own logo 1peuqw_1" on storage.objects
  for select to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users update/delete own logo 1peuqw_2" on storage.objects
  for delete to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "covers insert own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers select own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers update own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
