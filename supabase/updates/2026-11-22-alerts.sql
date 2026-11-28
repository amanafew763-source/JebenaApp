-- =====================================================================
-- EthioCarry — update of 22 Nov 2026 (3): traveler alerts
--
-- Run this ONCE, after 2026-11-22-find-traveler.sql (SQL Editor → New
-- query → paste → Run). Safe to run again. Fresh projects don't need it.
--
-- Adds "Email me when a traveler matches": logged-in people save a search;
-- when a fitting trip is posted, the email function tells them (at most
-- once a day per alert). They see and delete their alerts under My account.
-- =====================================================================

-- ---------- traveler alerts ("Email me when a traveler matches") ----------
create table if not exists public.search_alerts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  direction    public.request_dir not null,
  home_city    text not null check (public.home_country(home_city) is not null),
  city         text check (char_length(btrim(city)) <= 80),
  item_type    public.item_type not null,
  weight_kg    numeric(5, 1) check (weight_kg > 0 and weight_kg <= 100),
  needed_by    date,
  lang         text not null default 'en' check (lang in ('en', 'de')),
  notified_at  timestamptz,          -- last email about a matching trip (at most one a day)
  created_at   timestamptz not null default now()
);
create index if not exists search_alerts_user_idx on public.search_alerts (user_id);

-- At most 10 alerts per person, and none for dates already past.
create or replace function public.prepare_search_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.search_alerts a where a.user_id = new.user_id) >= 10 then
    raise exception 'alert_limit' using errcode = 'P0001';
  end if;
  if new.needed_by is not null and new.needed_by < current_date then
    raise exception 'date_in_past' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists search_alerts_prepare on public.search_alerts;
create trigger search_alerts_prepare before insert on public.search_alerts
  for each row execute function public.prepare_search_alert();

-- Called by the email function when a trip is posted: returns the alerts it
-- matches (and their owners' email) and marks them notified. Service role only.
create or replace function public.claim_alerts_for_trip(p_trip bigint)
returns table (alert_id bigint, email text, lang text, direction public.request_dir, home_city text, city text,
               item_type public.item_type, weight_kg numeric, needed_by date)
language plpgsql security definer set search_path = '' as $$
declare
  t public.requests;
begin
  select * into t from public.requests where id = p_trip and role = 'traveler' and status in ('new', 'waiting', 'matched');
  if t.id is null or t.carry_types is null or t.flight_date < current_date + 1 then return; end if;
  return query
    with hit as (
      update public.search_alerts a set notified_at = now()
       where a.direction = t.direction
         and public.home_country(a.home_city) = public.home_country(t.home_city)
         and a.item_type = any (t.carry_types)
         and (a.needed_by is null or (a.needed_by >= current_date and t.flight_date <= a.needed_by))
         and coalesce(a.weight_kg, 0.1) <= t.space_kg - public.trip_used_kg(t.id)
         and a.user_id <> t.user_id
         and (a.notified_at is null or a.notified_at < now() - interval '1 day')
      returning a.*)
    select h.id, u.email::text, h.lang, h.direction, h.home_city, h.city, h.item_type, h.weight_kg, h.needed_by
      from hit h join auth.users u on u.id = h.user_id;
end;
$$;

alter table public.search_alerts enable row level security;
drop policy if exists "Alerts: read own or admin" on public.search_alerts;
create policy "Alerts: read own or admin" on public.search_alerts for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists "Alerts: create own" on public.search_alerts;
create policy "Alerts: create own" on public.search_alerts for insert to authenticated
  with check (user_id = (select auth.uid()) and notified_at is null);
drop policy if exists "Alerts: delete own" on public.search_alerts;
create policy "Alerts: delete own" on public.search_alerts for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.search_alerts from anon, authenticated;
grant select, delete on public.search_alerts to authenticated;
grant insert (direction, home_city, city, item_type, weight_kg, needed_by, lang) on public.search_alerts to authenticated;

revoke all on function public.prepare_search_alert() from public, anon, authenticated;
revoke all on function public.claim_alerts_for_trip(bigint) from public, anon, authenticated;
grant execute on function public.claim_alerts_for_trip(bigint) to service_role;   -- the email function only
