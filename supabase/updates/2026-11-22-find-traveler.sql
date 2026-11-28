-- =====================================================================
-- EthioCarry — update of 22 Nov 2026 (2): "Find a traveler"
--
-- Run this ONCE, after 2026-11-22-cities.sql, on a database that was set up
-- with an older schema.sql (SQL Editor → New query → paste → Run). It is
-- safe to run again. Fresh projects don't need it.
--
-- What it adds
--   * carry_types on trips (and a default on the traveler's profile): the
--     item types a traveler is willing to carry
--   * find_travelers(): the search behind "Find a traveler" (first names,
--     ratings, flight dates and free space only, never contact details)
--   * request_trip(): the sender picks a trip for their own item; the
--     traveler then accepts or declines
--
-- Trips posted before this update have no carry types yet, so they don't
-- show up in the search until the traveler edits the trip and ticks what
-- they'll carry. Admin matching still works for them.
-- =====================================================================

alter table public.profiles add column if not exists carry_types public.item_type[];
alter table public.requests add column if not exists carry_types public.item_type[]
  check (cardinality(carry_types) > 0);

grant update (full_name, carry_types) on public.profiles to authenticated;
grant insert (carry_types) on public.requests to authenticated;

-- New requests: rate limit, no dates in the past, and a pickup code for items.
create or replace function public.prepare_new_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.requests r
      where r.user_id = new.user_id and r.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limit: too many requests, try again later' using errcode = 'P0001';
  end if;
  if new.role = 'traveler' and new.flight_date < current_date then
    raise exception 'date_in_past' using errcode = 'P0001';
  end if;
  if new.role = 'sender' and (new.ready_date < current_date or new.needed_by < current_date) then
    raise exception 'date_in_past' using errcode = 'P0001';
  end if;
  if new.photo_path is not null and new.photo_path not like new.user_id::text || '/%' then
    raise exception 'photo_not_yours' using errcode = 'P0001';
  end if;
  -- Trips say what they'll carry; items don't.
  if new.role = 'traveler' and new.carry_types is null then
    raise exception 'carry_types_required' using errcode = 'P0001';
  end if;
  if new.role = 'sender' then new.carry_types := null; end if;
  new.pickup_code := case when new.role = 'sender'
    then lpad((abs(hashtextextended(gen_random_uuid()::text, 0)) % 1000000)::text, 6, '0') end;
  return new;
end;
$$;

-- Shared checks for pairing an item with a trip (used by create_match and request_trip).
create or replace function public.make_match(p_sender_request bigint, p_traveler_request bigint, p_confirm boolean)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s        public.requests;
  tr       public.requests;
  s_email  text;
  t_email  text;
  v_id     bigint;
begin
  select * into s  from public.requests where id = p_sender_request   for update;
  select * into tr from public.requests where id = p_traveler_request for update;
  if s.id is null or tr.id is null then raise exception 'match_not_found'; end if;
  if s.role <> 'sender' or tr.role <> 'traveler' then raise exception 'match_wrong_roles'; end if;
  if s.direction <> tr.direction then raise exception 'match_wrong_direction'; end if;
  if public.home_country(s.home_city) <> public.home_country(tr.home_city) then raise exception 'match_wrong_country'; end if;
  if s.status not in ('new', 'waiting') or tr.status not in ('new', 'waiting', 'matched') then raise exception 'match_closed'; end if;
  if exists (select 1 from public.matches m where m.sender_request_id = s.id and m.status in ('proposed', 'accepted')) then
    raise exception 'match_sender_taken';
  end if;

  -- Dates: the item must be ready at least one day before the flight,
  -- and the flight must arrive in time if a "needed by" date is set.
  if tr.flight_date < current_date then raise exception 'match_trip_past'; end if;
  if s.ready_date > tr.flight_date - 1 or (s.needed_by is not null and s.needed_by < tr.flight_date) then
    raise exception 'match_dates';
  end if;
  -- Weight: must fit in the space left on the trip.
  if public.trip_used_kg(tr.id) + s.weight_kg > tr.space_kg then raise exception 'match_no_space'; end if;

  -- Never match someone with themselves.
  if s.user_id = tr.user_id then raise exception 'match_same_account'; end if;
  select lower(u.email) into s_email from auth.users u where u.id = s.user_id;
  select lower(u.email) into t_email from auth.users u where u.id = tr.user_id;
  if lower(s.contact_email) = lower(tr.contact_email)
     or lower(s.contact_email) = coalesce(t_email, '')
     or lower(tr.contact_email) = coalesce(s_email, '')
     or regexp_replace(s.contact_phone, '[^0-9]', '', 'g') = regexp_replace(tr.contact_phone, '[^0-9]', '', 'g') then
    raise exception 'match_same_email';
  end if;
  -- Look-alike names, different cities (at either end) or an item type the
  -- traveler didn't list need an explicit confirmation.
  if not coalesce(p_confirm, false) and (
       public.norm_name(s.contact_name) = public.norm_name(tr.contact_name)
       or lower(btrim(s.city)) <> lower(btrim(tr.city))
       or s.home_city <> tr.home_city
       or (tr.carry_types is not null and not (s.item_type = any (tr.carry_types)))) then
    raise exception 'match_needs_confirm';
  end if;

  insert into public.matches (sender_request_id, traveler_request_id, created_by)
  values (s.id, tr.id, auth.uid())
  returning id into v_id;

  update public.requests set status = 'matched' where id in (s.id, tr.id) and status <> 'matched';
  return v_id;
end;
$$;

-- Admin: pair an item with a trip.
create or replace function public.create_match(p_sender_request bigint, p_traveler_request bigint, p_confirm boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'match_not_admin' using errcode = '42501'; end if;
  return public.make_match(p_sender_request, p_traveler_request, p_confirm);
end;
$$;

-- "Find a traveler": the person who needs something carried picks a trip for
-- their own item. The traveler then accepts or declines, as with admin matches.
create or replace function public.request_trip(p_item bigint, p_trip bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s  public.requests;
  tr public.requests;
begin
  select * into s  from public.requests where id = p_item;
  select * into tr from public.requests where id = p_trip;
  if s.id is null or s.user_id is distinct from auth.uid() or s.role <> 'sender' then
    raise exception 'not_your_request' using errcode = '42501';
  end if;
  if tr.id is null or tr.role <> 'traveler' then raise exception 'match_not_found'; end if;
  if tr.carry_types is null or not (s.item_type = any (tr.carry_types)) then raise exception 'trip_wont_carry'; end if;
  return public.make_match(s.id, tr.id, true);   -- they chose this traveler knowingly: no extra confirmation
end;
$$;

-- "Find a traveler" search. Anyone may search; results show only a first name,
-- rating, flight date, route and free space (never contact details).
create or replace function public.find_travelers(p_home text, p_dir public.request_dir, p_item public.item_type,
                                      p_needed_by date default null, p_city text default null, p_weight numeric default null)
returns table (trip_id bigint, first_name text, rating jsonb, flight_date date, city text, home_city text,
               space_left numeric, carry_types public.item_type[], same_home boolean, same_city boolean)
language sql stable security definer set search_path = '' as $$
  select t.id, split_part(btrim(t.contact_name), ' ', 1), public.user_rating(t.user_id), t.flight_date, t.city, t.home_city,
         t.space_kg - public.trip_used_kg(t.id), t.carry_types,
         t.home_city = p_home, lower(btrim(t.city)) = lower(btrim(coalesce(p_city, '')))
    from public.requests t
   where t.role = 'traveler' and t.status in ('new', 'waiting', 'matched')
     and t.direction = p_dir
     and public.home_country(t.home_city) = public.home_country(p_home)
     and t.flight_date >= current_date + 1                       -- the item reaches them at least a day before
     and (p_needed_by is null or t.flight_date <= p_needed_by)
     and p_item = any (t.carry_types)
     and t.space_kg - public.trip_used_kg(t.id) >= greatest(coalesce(p_weight, 0), 0.1)
     and (auth.uid() is null or t.user_id <> auth.uid())       -- not your own trips
   order by t.home_city = p_home desc, lower(btrim(t.city)) = lower(btrim(coalesce(p_city, ''))) desc, t.flight_date
   limit 50;
$$;

-- ---------- customer self-service ----------
-- Edit your own request while it's still waiting for a match.
create or replace function public.update_my_request(p_id bigint, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.requests;
begin
  select * into r from public.requests where id = p_id and user_id = auth.uid() for update;
  if r.id is null then raise exception 'not_your_request' using errcode = '42501'; end if;
  if r.status not in ('new', 'waiting')
     or exists (select 1 from public.matches m where (m.sender_request_id = r.id or m.traveler_request_id = r.id) and m.status in ('proposed', 'accepted')) then
    raise exception 'request_locked';
  end if;
  if p ? 'photo_path' and nullif(p ->> 'photo_path', '') is not null and (p ->> 'photo_path') not like auth.uid()::text || '/%' then
    raise exception 'photo_not_yours';
  end if;
  if (p ? 'flight_date' and (p ->> 'flight_date')::date < current_date)
     or (p ? 'ready_date' and (p ->> 'ready_date')::date < current_date)
     or (nullif(p ->> 'needed_by', '') is not null and (p ->> 'needed_by')::date < current_date) then
    raise exception 'date_in_past';
  end if;
  update public.requests set
    details        = coalesce(p ->> 'details', details),
    city           = coalesce(p ->> 'city', city),
    home_city      = coalesce(p ->> 'home_city', home_city),
    contact_phone  = coalesce(p ->> 'contact_phone', contact_phone),
    flight_date    = case when role = 'traveler' and p ? 'flight_date' then (p ->> 'flight_date')::date else flight_date end,
    space_kg       = case when role = 'traveler' and p ? 'space_kg' then (p ->> 'space_kg')::numeric else space_kg end,
    carry_types    = case when role = 'traveler' and p ? 'carry_types'
                          then (select array_agg(x::public.item_type) from jsonb_array_elements_text(p -> 'carry_types') x)
                          else carry_types end,
    item_type      = case when role = 'sender' and p ? 'item_type' then (p ->> 'item_type')::public.item_type else item_type end,
    weight_kg      = case when role = 'sender' and p ? 'weight_kg' then (p ->> 'weight_kg')::numeric else weight_kg end,
    ready_date     = case when role = 'sender' and p ? 'ready_date' then (p ->> 'ready_date')::date else ready_date end,
    needed_by      = case when role = 'sender' and p ? 'needed_by' then nullif(p ->> 'needed_by', '')::date else needed_by end,
    photo_path     = case when role = 'sender' and p ? 'photo_path' then nullif(p ->> 'photo_path', '') else photo_path end,
    handover_name  = case when role = 'sender' then coalesce(p ->> 'handover_name', handover_name) else handover_name end,
    handover_phone = case when role = 'sender' then coalesce(p ->> 'handover_phone', handover_phone) else handover_phone end,
    pickup_name    = case when role = 'sender' then coalesce(p ->> 'pickup_name', pickup_name) else pickup_name end,
    pickup_phone   = case when role = 'sender' then coalesce(p ->> 'pickup_phone', pickup_phone) else pickup_phone end
  where id = r.id;
end;
$$;

revoke all on function public.make_match(bigint, bigint, boolean) from public, anon, authenticated;
revoke all on function public.request_trip(bigint, bigint) from public, anon;
grant execute on function public.request_trip(bigint, bigint) to authenticated;
revoke all on function public.find_travelers(text, public.request_dir, public.item_type, date, text, numeric) from public;
grant execute on function public.find_travelers(text, public.request_dir, public.item_type, date, text, numeric) to anon, authenticated;
