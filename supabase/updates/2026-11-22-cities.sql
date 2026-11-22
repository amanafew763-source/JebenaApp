-- =====================================================================
-- Jebena Express — update of 22 Nov 2026: Ethiopian cities
--
-- Run this ONCE on a database that was set up with an older schema.sql
-- (SQL Editor → New query → paste → Run). Fresh projects don't need it:
-- schema.sql already includes these changes. Existing requests keep
-- working and are set to Addis Ababa.
--
-- What it changes
--   * requests.home_city: the city in Ethiopia (Addis Ababa, Dire Dawa,
--     the regional capitals, Adigrat, Arba Minch, Jimma and Shire)
--   * matching: a different city needs the admin's second click
--   * editing and status pages include the city
-- =====================================================================

create or replace function public.home_country(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p in ('Addis Ababa', 'Adigrat', 'Arba Minch', 'Asosa', 'Bahir Dar', 'Bonga', 'Dire Dawa', 'Gambela', 'Harar',
               'Hawassa', 'Hosaena', 'Jijiga', 'Jimma', 'Mekelle', 'Semera', 'Shire', 'Wolaita Sodo') then 'ET'
  end;
$$;

grant execute on function public.home_country(text) to anon, authenticated;

alter table public.requests
  add column if not exists home_city text not null default 'Addis Ababa'
  check (public.home_country(home_city) is not null);

grant insert (home_city) on public.requests to authenticated;

create or replace function public.create_match(p_sender_request bigint, p_traveler_request bigint, p_confirm boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  s        public.requests;
  tr       public.requests;
  s_email  text;
  t_email  text;
  v_id     bigint;
begin
  if not public.is_admin() then raise exception 'match_not_admin' using errcode = '42501'; end if;

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
  -- Look-alike names or different cities (at either end) need an explicit confirmation.
  if not coalesce(p_confirm, false) and (
       public.norm_name(s.contact_name) = public.norm_name(tr.contact_name)
       or lower(btrim(s.city)) <> lower(btrim(tr.city))
       or s.home_city <> tr.home_city) then
    raise exception 'match_needs_confirm';
  end if;

  insert into public.matches (sender_request_id, traveler_request_id, created_by)
  values (s.id, tr.id, auth.uid())
  returning id into v_id;

  update public.requests set status = 'matched' where id in (s.id, tr.id) and status <> 'matched';
  return v_id;
end;
$$;

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

create or replace function public.request_details(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r        public.requests;
  v_admin  boolean := public.is_admin();
  v_out    jsonb;
begin
  select * into r from public.requests where id = p_id;
  if r.id is null or (r.user_id <> auth.uid() and not v_admin) then
    raise exception 'not_your_request' using errcode = '42501';
  end if;

  v_out := jsonb_build_object(
    'request', to_jsonb(r) - 'user_id' - case when r.user_id = auth.uid() then 'nothing' else 'pickup_code' end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'at', e.created_at) order by e.created_at)
                          from public.request_events e where e.request_id = r.id), '[]'::jsonb));

  if r.role = 'sender' then
    v_out := v_out || jsonb_build_object('match', (
      select jsonb_build_object(
               'id', m.id, 'status', m.status, 'flight_date', t.flight_date, 'trip_home_city', t.home_city,
               'traveler_first_name', split_part(btrim(t.contact_name), ' ', 1),
               'traveler_rating', public.user_rating(t.user_id),
               'rated', exists (select 1 from public.ratings x where x.match_id = m.id and x.rater_id = auth.uid()))
             || case when m.status in ('accepted', 'completed') then jsonb_build_object(
                  'traveler_name', t.contact_name, 'traveler_phone', t.contact_phone, 'traveler_email', t.contact_email)
                else '{}'::jsonb end
        from public.matches m join public.requests t on t.id = m.traveler_request_id
       where m.sender_request_id = r.id and m.status in ('proposed', 'accepted', 'completed')
       order by m.created_at desc limit 1));
  else
    v_out := v_out || jsonb_build_object(
      'used_kg', public.trip_used_kg(r.id),
      'items', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'match_id', m.id, 'match_status', m.status, 'item_status', s.status,
                   'handed_over', m.handed_over_at is not null, 'code_attempts', m.code_attempts,
                   'item_type', s.item_type, 'details', s.details, 'weight_kg', s.weight_kg,
                   'ready_date', s.ready_date, 'needed_by', s.needed_by, 'photo_path', s.photo_path,
                   'city', s.city, 'home_city', s.home_city, 'direction', s.direction,
                   'requester_first_name', split_part(btrim(s.contact_name), ' ', 1),
                   'requester_rating', public.user_rating(s.user_id),
                   'rated', exists (select 1 from public.ratings x where x.match_id = m.id and x.rater_id = auth.uid()))
                 || case when m.status in ('accepted', 'completed') then jsonb_build_object(
                      'requester_name', s.contact_name, 'requester_phone', s.contact_phone, 'requester_email', s.contact_email,
                      'handover_name', s.handover_name, 'handover_phone', s.handover_phone,
                      'pickup_name', s.pickup_name, 'pickup_phone', s.pickup_phone)
                    else '{}'::jsonb end
                 order by m.created_at)
          from public.matches m join public.requests s on s.id = m.sender_request_id
         where m.traveler_request_id = r.id and m.status in ('proposed', 'accepted', 'completed')), '[]'::jsonb));
  end if;
  return v_out;
end;
$$;
