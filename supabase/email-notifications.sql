-- =====================================================================
-- Jebena Express — email notifications (run AFTER schema.sql)
--
-- When a request is created or its status changes, and when an item is
-- proposed to a traveler (or that match is cancelled), the database calls
-- the "notify" Edge Function, which emails the people involved (and you,
-- for new requests). See README.md → "Email updates" for setup.
--
-- The function's address and a shared secret are read from Supabase Vault,
-- so nothing secret is stored in this file. Until both Vault entries exist,
-- the trigger does nothing.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

-- ---------- log of every email the function tried to send ----------
create table public.notifications (
  id          bigint generated always as identity primary key,
  request_id  bigint references public.requests (id) on delete cascade,
  kind        text not null,                       -- e.g. received, matched, accepted, handed_over, delivered, match_proposed, admin_new
  channel     text not null default 'email',
  recipient   text not null,
  status      text not null check (status in ('sent', 'failed', 'skipped')),
  error       text,
  created_at  timestamptz not null default now()
);

create index notifications_request_id_idx on public.notifications (request_id);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

create policy "Notifications: admin reads"
  on public.notifications for select to authenticated
  using ((select public.is_admin()));

-- ---------- trigger: new request, or status changed ----------
create function public.notify_request_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'notify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return new;  -- email not set up yet
  end if;

  -- Only the request id is sent; the function loads the row itself.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body    := jsonb_build_object('event', lower(tg_op), 'request_id', new.id)
  );
  return new;
end;
$$;

revoke all on function public.notify_request_change() from public, anon, authenticated;

create trigger requests_notify
  after insert or update of status on public.requests
  for each row execute function public.notify_request_change();

-- ---------- trigger: item proposed to a traveler, or that match cancelled ----------
create function public.notify_match_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if not (tg_op = 'INSERT' or (new.status = 'cancelled' and old.status in ('proposed', 'accepted'))) then
    return new;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'notify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';
  if v_url is null or v_secret is null then
    return new;
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body    := jsonb_build_object('event', case when tg_op = 'INSERT' then 'match_proposed' else 'match_cancelled' end, 'match_id', new.id)
  );
  return new;
end;
$$;

revoke all on function public.notify_match_change() from public, anon, authenticated;

create trigger matches_notify
  after insert or update of status on public.matches
  for each row execute function public.notify_match_change();
